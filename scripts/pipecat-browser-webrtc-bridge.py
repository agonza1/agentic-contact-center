#!/usr/bin/env python3
"""Browser WebRTC sidecar for the Agentic Contact Center local voice path.

Normal media path:

browser microphone -> WebRTC/Opus -> this Pipecat bridge -> rtc-asr Local STT v1
-> ACC caller-turn API -> Kokoro TTS -> WebRTC remote audio track in browser

This sidecar intentionally does not use MediaRecorder webm chunks or ffmpeg.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"
if LOCAL_RUNTIME_PATH.exists():
    sys.path.insert(0, str(LOCAL_RUNTIME_PATH))
    nltk_data_path = LOCAL_RUNTIME_PATH / "nltk_data"
    nltk_data_path.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("NLTK_DATA", str(nltk_data_path))

try:
    from aiohttp import web
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.transports.base_transport import TransportParams
    from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequest, SmallWebRTCRequestHandler
    from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
    from acc_pipecat_voice_pipeline import (
        ACC_VOICE_PIPELINE_CONTRACT,
        DEFAULT_ACC_URL,
        DEFAULT_KOKORO_MODEL,
        DEFAULT_KOKORO_VOICE,
        INPUT_SAMPLE_RATE,
        BridgeReadiness,
        AccVoicePipelineSession,
        build_acc_voice_pipeline,
        check_readiness,
        normalize_browser_answer_sdp,
        ready_payload,
    )
except Exception as exc:  # pragma: no cover - local setup guard
    print(
        json.dumps(
            {
                "ok": False,
                "error": "pipecat_webrtc_runtime_import_failed",
                "detail": str(exc),
                "install": "npm run pipecat:webrtc:install",
            },
            indent=2,
        ),
        file=sys.stderr,
    )
    raise SystemExit(2)


class BrowserWebrtcBridge:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self.request_handler = SmallWebRTCRequestHandler(host=host)
        self.sessions: dict[str, dict[str, Any]] = {}

    async def readiness(self, request: web.Request) -> web.Response:
        acc_url = request.query.get("accUrl", DEFAULT_ACC_URL)
        skip_acc = request.query.get("skipAcc", "").lower() in {"1", "true", "yes"}
        readiness = await asyncio.to_thread(check_readiness, acc_url, skip_acc)
        return web.json_response(ready_payload(readiness, self.host, self.port), status=200 if readiness.ok else 503)

    async def start_pipeline(self, *, connection: Any, session_id: str, acc_url: str, call_id: str, readiness: BridgeReadiness) -> AccVoicePipelineSession:
        session = AccVoicePipelineSession(acc_url=acc_url, call_id=call_id, readiness=readiness)
        transport = SmallWebRTCTransport(
            webrtc_connection=connection,
            params=TransportParams(
                audio_in_enabled=True,
                audio_in_sample_rate=INPUT_SAMPLE_RATE,
                audio_in_channels=1,
                audio_in_passthrough=True,
                audio_out_enabled=True,
                audio_out_sample_rate=24000,
                audio_out_channels=1,
                audio_out_auto_silence=True,
            ),
        )
        pipeline = build_acc_voice_pipeline(
            transport_input=transport.input(),
            transport_output=transport.output(),
            session=session,
        )
        task = PipelineTask(
            pipeline,
            params=PipelineParams(audio_in_sample_rate=INPUT_SAMPLE_RATE, audio_out_sample_rate=24000),
            enable_rtvi=False,
            idle_timeout_secs=None,
        )
        runner = PipelineRunner()
        runner_task = asyncio.create_task(runner.run(task, auto_end=False))
        self.sessions[session_id] = {
            "connection": connection,
            "transport": transport,
            "runner": runner,
            "runnerTask": runner_task,
            "pipelineTask": task,
            "turnSession": session,
            "callId": call_id,
            "startedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        }
        return session

    async def offer(self, request: web.Request) -> web.Response:
        payload = await request.json()
        if payload.get("type") != "offer" or not isinstance(payload.get("sdp"), str):
            return web.json_response({"ok": False, "error": "webrtc_offer_required"}, status=400)
        acc_url = str(payload.get("accUrl") or DEFAULT_ACC_URL).rstrip("/")
        call_id = str(payload.get("callId") or "").strip()
        session_id = str(payload.get("sessionId") or f"browser-webrtc-{uuid4()}")
        readiness = await asyncio.to_thread(check_readiness, acc_url)
        if not readiness.ok:
            return web.json_response({"ok": False, "error": "sidecar_unavailable", "ready": ready_payload(readiness, self.host, self.port)}, status=503)

        small_request = SmallWebRTCRequest.from_dict({
            "sdp": payload["sdp"],
            "type": payload["type"],
            "pc_id": payload.get("pcId") or payload.get("pc_id"),
            "restart_pc": payload.get("restartPc") or payload.get("restart_pc"),
            "request_data": {"sessionId": session_id, "callId": call_id},
        })

        async def on_connection(connection: Any) -> None:
            await self.start_pipeline(connection=connection, session_id=session_id, acc_url=acc_url, call_id=call_id, readiness=readiness)

        answer = await self.request_handler.handle_web_request(small_request, on_connection)
        if not answer:
            return web.json_response({"ok": False, "error": "webrtc_answer_unavailable"}, status=502)

        evidence = {
            "source": "pipecat_small_webrtc_pipeline",
            "runtimeMode": "pipecat_small_webrtc_pipeline",
            "transport": "SmallWebRTCTransport",
            "sessionId": session_id,
            "pcId": answer.get("pc_id"),
            "callId": call_id,
            "mediaRecorderRequired": False,
            "ffmpegRequired": False,
            "bridgeUrl": f"http://{self.host}:{self.port}",
            "stt": {"engine": "rtc-asr", "contract": "local-stt.v1", "model": readiness.stt_model, "backend": readiness.stt_backend},
            "tts": {"engine": "kokoro", "voice": DEFAULT_KOKORO_VOICE, "model": DEFAULT_KOKORO_MODEL},
            "pipecat": {
                "runtimeEngine": "pipecat-ai",
                "version": readiness.pipecat_version,
                "transport": "SmallWebRTCTransport",
                "pipeline": ACC_VOICE_PIPELINE_CONTRACT,
            },
        }
        print(json.dumps({"type": "pipecat.small_webrtc.offer_answer", **evidence}), flush=True)
        return web.json_response(
            {
                "ok": True,
                "type": answer.get("type"),
                "sdp": normalize_browser_answer_sdp(str(answer.get("sdp", ""))),
                "sessionId": session_id,
                "callId": call_id,
                "pcId": answer.get("pc_id"),
                "iceServers": [],
                "evidence": evidence,
            }
        )

    async def patch_offer(self, request: web.Request) -> web.Response:
        payload = await request.json()
        try:
            candidates = payload.get("candidates") or []
            patch_request = type(
                "SmallWebRTCAiohttpPatchRequest",
                (),
                {
                    "pc_id": payload.get("pcId") or payload.get("pc_id"),
                    "candidates": [
                        type(
                            "SmallWebRTCAiohttpIceCandidate",
                            (),
                            {
                                "candidate": item.get("candidate"),
                                "sdp_mid": item.get("sdpMid") or item.get("sdp_mid"),
                                "sdp_mline_index": item.get("sdpMLineIndex") if "sdpMLineIndex" in item else item.get("sdp_mline_index"),
                            },
                        )
                        for item in candidates
                    ],
                },
            )()
            await self.request_handler.handle_patch_request(patch_request)
            return web.json_response({"ok": True})
        except Exception as exc:
            return web.json_response({"ok": False, "error": "webrtc_patch_failed", "detail": str(exc)}, status=400)

    async def session_proof(self, request: web.Request) -> web.Response:
        session_id = request.match_info.get("session_id", "")
        session = self.sessions.get(session_id)
        if not session:
            return web.json_response({"ok": False, "error": "webrtc_session_not_found", "sessionId": session_id}, status=404)
        turn_session = session.get("turnSession")
        evidence = turn_session.last_evidence if isinstance(turn_session, AccVoicePipelineSession) else {}
        runner_task = session.get("runnerTask")
        runner_done = isinstance(runner_task, asyncio.Task) and runner_task.done()
        return web.json_response(
            {
                "ok": True,
                "sessionId": session_id,
                "callId": session.get("callId"),
                "startedAt": session.get("startedAt"),
                "transport": "SmallWebRTCTransport",
                "pipeline": ACC_VOICE_PIPELINE_CONTRACT,
                "turnEvidence": evidence,
                "turnCount": turn_session.turn_count if isinstance(turn_session, AccVoicePipelineSession) else 0,
                "runnerDone": runner_done,
                "lastAudio": turn_session.last_audio_evidence if isinstance(turn_session, AccVoicePipelineSession) else {},
                "lastStt": turn_session.last_stt_evidence if isinstance(turn_session, AccVoicePipelineSession) else {},
                "lastAcc": turn_session.last_acc_evidence if isinstance(turn_session, AccVoicePipelineSession) else {},
                "lastTts": turn_session.last_tts_evidence if isinstance(turn_session, AccVoicePipelineSession) else {},
                "lastError": turn_session.last_error if isinstance(turn_session, AccVoicePipelineSession) else {},
                "stageEvents": turn_session.stage_events if isinstance(turn_session, AccVoicePipelineSession) else [],
                "bargeInEvidence": turn_session.last_barge_in_evidence if isinstance(turn_session, AccVoicePipelineSession) else {},
                "reviewReady": bool(evidence.get("callerTranscript") and evidence.get("tts", {}).get("audioBytes", 0) > 0),
                "nextAction": (
                    "rtc-asr returned no final transcript; inspect lastAudio.rms/sampleRate and lower ACC_WEBRTC_SILENCE_RMS or validate rtc-asr audio if needed."
                    if evidence.get("error") == "empty_transcript"
                    else "ACC returned no agent text for the transcribed turn; inspect lastAcc.flowState and the call transcript."
                    if evidence.get("callerTranscript") and not evidence.get("agentText")
                    else "Kokoro did not enqueue playable audio; inspect lastTts and browser inbound RTP stats."
                    if evidence.get("agentText") and not evidence.get("tts", {}).get("audioBytes")
                    else "Talk into the browser microphone and wait for rtc-asr/Kokoro turn evidence."
                ),
            }
        )

    async def close_session(self, session_id: str) -> None:
        session = self.sessions.pop(session_id, {})
        runner = session.get("runner")
        if isinstance(runner, PipelineRunner):
            await runner.cancel("browser WebRTC session closed")
        task = session.get("runnerTask")
        if isinstance(task, asyncio.Task):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def close_all(self) -> None:
        await asyncio.gather(*(self.close_session(session_id) for session_id in list(self.sessions)), return_exceptions=True)
        await self.request_handler.close()

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/health", self.readiness)
        app.router.add_get("/api/webrtc/readiness", self.readiness)
        app.router.add_post("/api/webrtc/offer", self.offer)
        app.router.add_patch("/api/webrtc/offer", self.patch_offer)
        app.router.add_get("/api/webrtc/sessions/{session_id}/proof", self.session_proof)
        app.on_shutdown.append(lambda _app: self.close_all())
        return app


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("BROWSER_WEBRTC_BRIDGE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BROWSER_WEBRTC_BRIDGE_PORT", "8766")))
    parser.add_argument("--acc-url", default=DEFAULT_ACC_URL)
    parser.add_argument("--check-sidecars", action="store_true")
    args = parser.parse_args()
    if args.check_sidecars:
        readiness = check_readiness(args.acc_url)
        print(json.dumps(ready_payload(readiness, args.host, args.port), indent=2))
        return 0 if readiness.ok else 2
    bridge = BrowserWebrtcBridge(args.host, args.port)
    readiness = check_readiness(args.acc_url)
    print(json.dumps({"ok": readiness.ok, "url": f"http://{args.host}:{args.port}", "offerRoute": f"http://{args.host}:{args.port}/api/webrtc/offer", "detail": readiness.detail}), flush=True)
    web.run_app(bridge.app(), host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
