#!/usr/bin/env python3
"""FreeSWITCH Verto agent-leg sidecar for the ACC local SIP path.

This process owns the new preferred #222 signaling boundary:

Linphone SIP 1000 -> FreeSWITCH 8600 -> Verto/WebRTC agent leg -> Pipecat

The sidecar registers a local Verto endpoint and answers incoming Verto WebRTC
offers with the shared Pipecat voice pipeline. It does not claim caller-audible
media acceptance until live proof is captured.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"
if LOCAL_RUNTIME_PATH.exists():
    sys.path.insert(0, str(LOCAL_RUNTIME_PATH))

try:
    import websockets
    from aiortc import RTCSessionDescription
    from aiohttp import web
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.transports.base_transport import TransportParams
    from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
    from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequest, SmallWebRTCRequestHandler
    from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
    from acc_pipecat_voice_pipeline import (
        ACC_VOICE_PIPELINE_CONTRACT,
        DEFAULT_ACC_URL,
        INPUT_SAMPLE_RATE,
        AccVoicePipelineSession,
        build_acc_voice_pipeline,
        check_readiness,
        normalize_browser_answer_sdp,
    )
except Exception as exc:  # pragma: no cover - local setup guard
    print(
        json.dumps(
            {
                "ok": False,
                "error": "pipecat_verto_runtime_import_failed",
                "detail": str(exc),
                "install": "npm run pipecat:webrtc:install",
            },
            indent=2,
        )
    )
    raise SystemExit(2)


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def normalize_verto_answer_sdp(sdp: str) -> str:
    """Trim browser-oriented aiortc SDP details that native FreeSWITCH Verto rejects."""
    lines = sdp.replace("\r\n", "\n").strip().split("\n")
    has_mid = any(line.startswith("a=mid:") for line in lines)
    ipv4_candidate = next(
        (
            match.group(1)
            for line in lines
            if line.startswith("a=candidate:")
            for match in [re.search(r" udp \d+ ((?:\d{1,3}\.){3}\d{1,3}) \d+ typ host", line)]
            if match
        ),
        None,
    )
    normalized: list[str] = []
    for line in lines:
        if line.startswith("a=group:BUNDLE") and not has_mid:
            continue
        if line.startswith("a=candidate:") and " typ host" in line and re.search(r" udp \d+ [0-9a-fA-F:]+ \d+ typ host", line):
            continue
        if line.startswith("a=fingerprint:sha-384") or line.startswith("a=fingerprint:sha-512"):
            continue
        if ipv4_candidate and line.startswith("c=IN IP6 "):
            normalized.append(f"c=IN IP4 {ipv4_candidate}")
            continue
        normalized.append(line)
    return "\r\n".join(normalized) + "\r\n"


async def create_verto_passive_answer(self: Any, sdp: str, type: str) -> None:
    """Create a FreeSWITCH-compatible answer with aiortc acting as DTLS server."""
    offer = RTCSessionDescription(sdp=sdp, type=type)
    await self._pc.setRemoteDescription(offer)
    for transceiver in getattr(self._pc, "_RTCPeerConnection__transceivers", []):
        transceiver.receiver.transport._set_role("server")
    sctp = getattr(self._pc, "_RTCPeerConnection__sctp", None)
    if sctp is not None:
        sctp.transport._set_role("server")
    self.force_transceivers_to_send_recv()
    local_answer = await self._pc.createAnswer()
    await self._pc.setLocalDescription(local_answer)
    self._answer = self._pc.localDescription


SmallWebRTCConnection._create_answer = create_verto_passive_answer


class VertoAgentBridge:
    def __init__(self, *, verto_url: str, login: str, password: str, acc_url: str, proof_out: str | None = None) -> None:
        self.verto_url = verto_url
        self.login = login
        self.password = password
        self.acc_url = acc_url.rstrip("/")
        self.proof_out = Path(proof_out).resolve() if proof_out else None
        self.started_at = now_iso()
        self.last_login: dict[str, Any] = {}
        self.last_event: dict[str, Any] = {}
        self.last_error: dict[str, Any] = {}
        self.last_invite: dict[str, Any] = {}
        self.last_answer: dict[str, Any] = {}
        self.invite_count = 0
        self.websocket: Any = None
        self._rpc_id = 0
        self.request_handler = SmallWebRTCRequestHandler(host="127.0.0.1")
        self.sessions: dict[str, dict[str, Any]] = {}

    def write_proof_artifact(self, event_type: str) -> None:
        if self.proof_out is None:
            return

        payload = {
            "schemaVersion": 1,
            "generatedAt": now_iso(),
            "eventType": event_type,
            "status": "registered_media_answer_ready" if self.last_login.get("ok") else "blocked",
            "reviewReady": False,
            "vertoUrl": self.verto_url,
            "login": self.login,
            "transport": "freeswitch_verto_webrtc",
            "inviteCount": self.invite_count,
            "lastLogin": self.last_login,
            "lastInvite": self.last_invite,
            "lastAnswer": self.last_answer,
            "lastError": self.last_error,
            "remainingMediaBlocker": "Verto signaling is configured and the sidecar can attempt a Pipecat-backed WebRTC answer, but caller-audible acceptance still requires a live 8600 proof showing rtc-asr final transcript and Kokoro/Pipecat playback heard by the caller.",
            "nextAction": "Place a local 8600 call with the Verto bridge running, then attach this artifact with the strict live SIP bundle once caller playback proof is captured.",
        }
        self.proof_out.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.proof_out.with_suffix(f"{self.proof_out.suffix}.tmp")
        tmp_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf8")
        tmp_path.replace(self.proof_out)

    def write_sdp_artifact(self, call_id: str, kind: str, sdp: str) -> str | None:
        if self.proof_out is None:
            return None
        safe_call_id = "".join(character if character.isalnum() or character in "._-" else "_" for character in call_id)
        path = self.proof_out.parent / f"{safe_call_id}-{kind}.sdp"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(sdp, encoding="utf8")
        return str(path)

    def next_id(self) -> str:
        self._rpc_id += 1
        return f"acc-verto-{self._rpc_id}"

    async def send_rpc(self, method: str, params: dict[str, Any]) -> str:
        if self.websocket is None:
            raise RuntimeError("verto_websocket_not_connected")
        rpc_id = self.next_id()
        await self.websocket.send(json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": rpc_id}))
        return rpc_id

    async def connect_and_register(self) -> None:
        while True:
            try:
                async with websockets.connect(self.verto_url, ping_interval=None) as ws:
                    self.websocket = ws
                    login_id = await self.send_rpc("login", {"login": self.login, "passwd": self.password})
                    async for raw in ws:
                        event = json.loads(raw) if isinstance(raw, str) else {}
                        self.last_event = {"at": now_iso(), "event": event}
                        if event.get("id") == login_id:
                            self.last_login = {
                                "at": now_iso(),
                                "ok": "error" not in event,
                                "response": event,
                            }
                            print(json.dumps({"type": "verto.login", **self.last_login}), flush=True)
                            self.write_proof_artifact("verto.login")
                        if event.get("method") == "verto.invite":
                            self.invite_count += 1
                            await self.handle_invite(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.websocket = None
                self.last_error = {"at": now_iso(), "error": str(exc)}
                print(json.dumps({"type": "verto.error", **self.last_error}), flush=True)
                self.write_proof_artifact("verto.error")
                await asyncio.sleep(2)

    async def handle_invite(self, event: dict[str, Any]) -> None:
        params = event.get("params") if isinstance(event.get("params"), dict) else {}
        call_id = params.get("callID") or params.get("callId") or str(uuid4())
        offer_sdp = params.get("sdp") if isinstance(params.get("sdp"), str) else ""
        if not offer_sdp.strip():
            proof = {
                "type": "verto.invite.blocked",
                "at": now_iso(),
                "callId": call_id,
                "mediaTarget": "pipecat_verto_webrtc_agent_leg",
                "reviewReady": False,
                "blocker": "Incoming FreeSWITCH Verto invite did not include SDP, so the Pipecat sidecar cannot create a WebRTC answer.",
            }
            self.last_invite = proof
            print(json.dumps(proof), flush=True)
            self.write_proof_artifact("verto.invite.blocked")
            return
        proof = {
            "type": "verto.invite.received",
            "at": now_iso(),
            "callId": call_id,
            "mediaTarget": "pipecat_verto_webrtc_agent_leg",
            "reviewReady": False,
            "offerSdpBytes": len(offer_sdp.encode("utf-8")),
            "offerSdpPath": self.write_sdp_artifact(call_id, "offer", offer_sdp),
            "nextAction": "Answer the Verto WebRTC dialog with the shared Pipecat pipeline and then rerun the strict live SIP bundle for caller-audible proof.",
        }
        self.last_invite = proof
        print(json.dumps(proof), flush=True)
        self.write_proof_artifact("verto.invite.received")
        await self.answer_invite(call_id=call_id, offer_sdp=offer_sdp, params=params)

    async def answer_invite(self, *, call_id: str, offer_sdp: str, params: dict[str, Any]) -> None:
        readiness = await asyncio.to_thread(check_readiness, self.acc_url)
        if not readiness.ok:
            self.last_answer = {
                "type": "verto.answer.blocked",
                "at": now_iso(),
                "callId": call_id,
                "reviewReady": False,
                "blocker": "ACC, rtc-asr, Kokoro, or Pipecat runtime readiness failed before answering Verto media.",
                "readiness": {
                    "status": readiness.status,
                    "detail": readiness.detail,
                    "blockers": readiness.blockers,
                },
            }
            print(json.dumps(self.last_answer), flush=True)
            self.write_proof_artifact("verto.answer.blocked")
            return

        session_id = f"verto-{call_id}"
        small_request = SmallWebRTCRequest.from_dict(
            {
                "sdp": offer_sdp,
                "type": "offer",
                "pc_id": call_id,
                "restart_pc": False,
                "request_data": {
                    "source": "freeswitch_verto",
                    "sessionId": session_id,
                    "callId": call_id,
                    "vertoParams": {key: value for key, value in params.items() if key != "sdp"},
                },
            }
        )

        async def on_connection(connection: Any) -> None:
            await self.start_pipeline(connection=connection, session_id=session_id, call_id=call_id, readiness=readiness)

        answer = await self.request_handler.handle_web_request(small_request, on_connection)
        if not answer or not isinstance(answer.get("sdp"), str):
            self.last_answer = {
                "type": "verto.answer.failed",
                "at": now_iso(),
                "callId": call_id,
                "reviewReady": False,
                "blocker": "Pipecat SmallWebRTCRequestHandler did not return an SDP answer for the Verto offer.",
            }
            print(json.dumps(self.last_answer), flush=True)
            self.write_proof_artifact("verto.answer.failed")
            return

        answer_sdp = normalize_verto_answer_sdp(normalize_browser_answer_sdp(str(answer["sdp"])))
        await self.send_rpc("verto.answer", {"dialogParams": {"callID": call_id}, "sdp": answer_sdp})
        answer_sdp_path = self.write_sdp_artifact(call_id, "answer", answer_sdp)
        self.last_answer = {
            "type": "verto.answer.sent",
            "at": now_iso(),
            "callId": call_id,
            "sessionId": session_id,
            "pcId": str(answer.get("pc_id") or call_id),
            "answerSdpBytes": len(answer_sdp.encode("utf-8")),
            "answerSdpPath": answer_sdp_path,
            "transport": "SmallWebRTCTransport",
            "pipeline": ACC_VOICE_PIPELINE_CONTRACT,
            "reviewReady": False,
            "nextAction": "Capture live Linphone 1000 -> 8600 proof with rtc_asr_live transcript and caller-audible Kokoro/Pipecat playback.",
        }
        print(json.dumps(self.last_answer), flush=True)
        self.write_proof_artifact("verto.answer.sent")

    async def start_pipeline(self, *, connection: Any, session_id: str, call_id: str, readiness: Any) -> None:
        session = AccVoicePipelineSession(acc_url=self.acc_url, call_id=call_id, readiness=readiness)
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
        session_record = {
            "connection": connection,
            "transport": transport,
            "runner": runner,
            "runnerTask": runner_task,
            "pipelineTask": task,
            "turnSession": session,
            "callId": call_id,
            "sessionId": session_id,
            "startedAt": now_iso(),
            "closedAt": None,
            "closeReason": None,
        }
        self.sessions[session_id] = session_record
        self.sessions[call_id] = session_record

        @connection.event_handler("closed")
        async def close_pipeline_for_peer(_connection: Any) -> None:
            asyncio.create_task(self.close_session(session_id, reason="verto_peer_closed"))

    async def close_session(self, session_id: str, *, reason: str = "verto session closed") -> None:
        session = self.sessions.get(session_id) or {}
        if session:
            session["closedAt"] = session.get("closedAt") or now_iso()
            session["closeReason"] = session.get("closeReason") or reason
        for key, value in list(self.sessions.items()):
            if value is session:
                self.sessions.pop(key, None)
        turn_session = session.get("turnSession")
        if isinstance(turn_session, AccVoicePipelineSession):
            await turn_session.close_rtc_asr_stream(reason)
        runner = session.get("runner")
        if isinstance(runner, PipelineRunner):
            await runner.cancel(reason)
        task = session.get("runnerTask")
        if isinstance(task, asyncio.Task):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    def readiness_payload(self) -> dict[str, Any]:
        logged_in = bool(self.last_login.get("ok"))
        return {
            "ok": logged_in,
            "status": "registered_media_answer_ready" if logged_in else "blocked",
            "checkedAt": now_iso(),
            "startedAt": self.started_at,
            "vertoUrl": self.verto_url,
            "login": self.login,
            "transport": "freeswitch_verto_webrtc",
            "targetPath": "SIP 1000 -> FreeSWITCH 8600 -> Verto/WebRTC acc-pipecat -> Pipecat rtc-asr/ACC/Kokoro -> same Verto leg -> SIP caller",
            "freeSwitchOwns": ["SIP/RTP", "Verto WebRTC DTLS-SRTP/Opus"],
            "pipecatOwns": ["rtc-asr STT", "ACC caller-turn", "Kokoro TTS", "turn/barge-in policy"],
            "inviteCount": self.invite_count,
            "lastLogin": self.last_login,
            "lastInvite": self.last_invite,
            "lastAnswer": self.last_answer,
            "lastError": self.last_error,
            "proofArtifactPath": str(self.proof_out) if self.proof_out else None,
            "reviewReady": False,
            "blockers": [] if logged_in else ["FreeSWITCH Verto login is not established."],
            "remainingMediaBlocker": "Verto signaling is configured and the sidecar can attempt a Pipecat-backed WebRTC answer, but caller-audible acceptance still requires a live 8600 proof showing rtc-asr final transcript and Kokoro/Pipecat playback heard by the caller.",
        }

    async def health(self, _request: web.Request) -> web.Response:
        payload = self.readiness_payload()
        return web.json_response(payload, status=200 if payload["ok"] else 503)

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/health", self.health)
        app.router.add_get("/api/verto/readiness", self.health)
        return app


async def run_server(bridge: VertoAgentBridge, host: str, port: int) -> None:
    runner = web.AppRunner(bridge.app())
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    print(json.dumps({"ok": True, "url": f"http://{host}:{port}", "vertoUrl": bridge.verto_url, "login": bridge.login}), flush=True)
    await asyncio.Event().wait()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("PIPECAT_VERTO_BRIDGE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PIPECAT_VERTO_BRIDGE_PORT", "8770")))
    parser.add_argument("--verto-url", default=os.environ.get("FREESWITCH_VERTO_URL", "ws://127.0.0.1:8081"))
    parser.add_argument("--login", default=os.environ.get("FREESWITCH_VERTO_LOGIN", "acc-pipecat@127.0.0.1"))
    parser.add_argument("--password", default=os.environ.get("FREESWITCH_VERTO_PASSWORD", "local-verto-pass"))
    parser.add_argument("--acc-url", default=os.environ.get("ACC_URL", DEFAULT_ACC_URL))
    parser.add_argument("--proof-out", default=os.environ.get("PIPECAT_VERTO_PROOF_OUT"))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    bridge = VertoAgentBridge(verto_url=args.verto_url, login=args.login, password=args.password, acc_url=args.acc_url, proof_out=args.proof_out)
    if args.check:
        async def check_once() -> int:
            started = time.monotonic()
            try:
                async with websockets.connect(args.verto_url, open_timeout=3, ping_interval=None) as ws:
                    bridge.websocket = ws
                    login_id = await bridge.send_rpc("login", {"login": args.login, "passwd": args.password})
                    while time.monotonic() - started < 5:
                        event = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                        if event.get("id") == login_id:
                            bridge.last_login = {"at": now_iso(), "ok": "error" not in event, "response": event}
                            print(json.dumps(bridge.readiness_payload(), indent=2))
                            return 0 if bridge.last_login["ok"] else 2
            except Exception as exc:
                bridge.last_error = {"at": now_iso(), "error": str(exc)}
            print(json.dumps(bridge.readiness_payload(), indent=2))
            return 2

        return asyncio.run(check_once())

    async def run() -> None:
        await asyncio.gather(bridge.connect_and_register(), run_server(bridge, args.host, args.port))

    asyncio.run(run())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
