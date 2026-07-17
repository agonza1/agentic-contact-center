#!/usr/bin/env python3
"""Shared Pipecat STT -> ACC -> TTS pipeline processors.

Transport adapters, such as browser SmallWebRTC or future SIP/fixture adapters,
should create their own transport and call build_acc_voice_pipeline() with the
transport input/output processors.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.metadata
import json
import os
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

import audioop
import websockets
from pipecat.audio.turn.base_turn_analyzer import EndOfTurnState
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.frames.frames import BotStartedSpeakingFrame, BotStoppedSpeakingFrame, InputAudioRawFrame, InterruptionFrame, TextFrame, TranscriptionFrame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_start import MinWordsUserTurnStartStrategy

from acc_pipecat_flow_manager import AccPipecatFlowManagerAdapter
from acc_track_recorder import SeparateTrackRecorder

DEFAULT_ACC_URL = os.environ.get("ACC_URL", "http://127.0.0.1:8026")
DEFAULT_RTC_ASR_BASE_URL = os.environ.get("RTC_ASR_BASE_URL", "http://127.0.0.1:8080")
DEFAULT_RTC_ASR_WS_URL = os.environ.get("RTC_ASR_WS_URL", "ws://127.0.0.1:8080/v1/stt/stream")
DEFAULT_RTC_ASR_HEALTH_PATH = os.environ.get("RTC_ASR_HEALTH_PATH", "/health")
DEFAULT_RTC_ASR_MODEL = os.environ.get("RTC_ASR_MODEL", "mlx-community/parakeet-tdt_ctc-110m")
DEFAULT_RTC_ASR_BACKEND = os.environ.get("RTC_ASR_BACKEND", "parakeet-mlx")
DEFAULT_KOKORO_BASE_URL = os.environ.get("KOKORO_BASE_URL", "http://127.0.0.1:8880")
DEFAULT_KOKORO_HEALTH_PATH = os.environ.get("KOKORO_HEALTH_PATH", "/health")
DEFAULT_KOKORO_SPEECH_PATH = os.environ.get("KOKORO_SPEECH_PATH") or os.environ.get("KOKORO_TTS_PATH", "/v1/audio/speech")
DEFAULT_KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
DEFAULT_KOKORO_MODEL = os.environ.get("KOKORO_MODEL", "kokoro")
INPUT_SAMPLE_RATE = 16000
WEBRTC_SAMPLE_RATE = 48000
WEBRTC_FRAME_MS = 20
WEBRTC_SAMPLES_PER_FRAME = WEBRTC_SAMPLE_RATE * WEBRTC_FRAME_MS // 1000
SAMPLE_WIDTH_BYTES = 2


class CallerTurnDeliveryCommitError(RuntimeError):
    """Raised when ACC and FlowManager cannot complete the output commit boundary."""


@dataclass
class ProbeResult:
    id: str
    ok: bool
    url: str
    detail: str
    status: str = "offline"
    metadata: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    response_ms: int | None = None


@dataclass
class BridgeReadiness:
    ok: bool
    status: str
    detail: str
    blockers: list[str]
    rtc_asr: ProbeResult
    kokoro: ProbeResult
    acc: ProbeResult
    stt_model: str
    stt_backend: str
    pipecat_version: str
    aiortc_version: str


def join_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def json_http(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def open_http_stream(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> Any:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method=method, headers={"content-type": "application/json"})
    return urllib.request.urlopen(request, timeout=timeout)


def probe_json(url: str, service_id: str, timeout: float = 1.5) -> ProbeResult:
    started = time.perf_counter()
    try:
        payload = json_http("GET", url, timeout=timeout)
        response_ms = round((time.perf_counter() - started) * 1000)
        explicit_ok = bool(payload.get("ok", True)) if isinstance(payload, dict) else True
        explicit_ready = payload.get("ready") is not False if isinstance(payload, dict) else True
        ready = explicit_ok and explicit_ready and str(payload.get("status", "ready")).lower() not in {"offline", "error", "failed", "degraded"}
        return ProbeResult(
            id=service_id,
            ok=ready,
            status="ready" if ready else "degraded",
            url=url,
            detail=f"{service_id} responded" if ready else f"{service_id} responded but is not ready",
            metadata=payload if isinstance(payload, dict) else {},
            response_ms=response_ms,
            error=None if ready else "not_ready",
        )
    except Exception as exc:
        return ProbeResult(
            id=service_id,
            ok=False,
            status="offline",
            url=url,
            detail=f"{service_id} is unreachable at {url}",
            error=str(exc),
            response_ms=round((time.perf_counter() - started) * 1000),
        )


def pick_model_metadata(health: dict[str, Any], models_payload: dict[str, Any] | None) -> tuple[str, str]:
    env_model = os.environ.get("RTC_ASR_MODEL") or DEFAULT_RTC_ASR_MODEL
    backend = str(health.get("backend") or health.get("runtime") or health.get("device") or DEFAULT_RTC_ASR_BACKEND)
    health_model = health.get("model") or health.get("active_model") or health.get("default_model")
    if env_model:
        return str(env_model), backend
    if health_model:
        return str(health_model), backend
    if isinstance(models_payload, dict):
        raw_models = models_payload.get("models") or models_payload.get("data") or []
        if isinstance(raw_models, list) and raw_models:
            first = raw_models[0]
            if isinstance(first, dict):
                return str(first.get("id") or first.get("name") or "unknown"), str(first.get("backend") or backend)
    return "unknown", backend


def check_readiness(acc_url: str = DEFAULT_ACC_URL, skip_acc: bool = False) -> BridgeReadiness:
    rtc_probe = probe_json(join_url(DEFAULT_RTC_ASR_BASE_URL, DEFAULT_RTC_ASR_HEALTH_PATH), "rtc-asr")
    kokoro_probe = probe_json(join_url(DEFAULT_KOKORO_BASE_URL, DEFAULT_KOKORO_HEALTH_PATH), "kokoro")
    acc_probe = ProbeResult(
        id="acc",
        ok=True,
        status="skipped",
        url=join_url(acc_url, "/health"),
        detail="ACC probe skipped by caller to avoid recursive /health checks",
    ) if skip_acc else probe_json(join_url(acc_url, "/health"), "acc")
    models_payload = None
    if rtc_probe.ok:
        with contextlib.suppress(Exception):
            models_payload = json_http("GET", join_url(DEFAULT_RTC_ASR_BASE_URL, "/v1/models"), timeout=1.5)
    stt_model, stt_backend = pick_model_metadata(rtc_probe.metadata, models_payload)
    blockers = [probe.detail for probe in (rtc_probe, kokoro_probe, acc_probe) if not probe.ok]
    ok = rtc_probe.ok and kokoro_probe.ok and acc_probe.ok and stt_model != "unknown" and stt_backend != "unknown"
    if stt_model == "unknown" or stt_backend == "unknown":
        blockers.append("rtc-asr health or /v1/models did not expose model/backend metadata")
    status = "ready" if ok else "degraded" if any(probe.ok for probe in (rtc_probe, kokoro_probe, acc_probe)) else "offline"
    return BridgeReadiness(
        ok=ok,
        status=status,
        detail="ready" if ok else "; ".join(blockers),
        blockers=blockers,
        rtc_asr=rtc_probe,
        kokoro=kokoro_probe,
        acc=acc_probe,
        stt_model=stt_model,
        stt_backend=stt_backend,
        pipecat_version=importlib.metadata.version("pipecat-ai"),
        aiortc_version=importlib.metadata.version("aiortc"),
    )


def ready_payload(readiness: BridgeReadiness, host: str, port: int) -> dict[str, Any]:
    return {
        "ok": readiness.ok,
        "status": readiness.status,
        "checkedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "detail": readiness.detail,
        "blockers": readiness.blockers,
        "route": f"http://{host}:{port}/api/webrtc/offer",
        "runtimeModeLabels": {
            "browserTransport": "webrtc",
            "browserCapture": "browser_microphone_live_when_connected",
            "pipecat": "pipecat_webrtc_bridge",
            "rtcAsr": "rtc_asr_live_when_sidecar_ready",
            "tts": "kokoro_live_when_sidecar_ready",
            "browserPlayback": "remote_audio_track",
        },
        "normalOperation": {
            "transport": "webrtc",
            "mediaRecorderRequired": False,
            "ffmpegRequired": False,
            "audioConversion": "PyAV/audioop PCM resampling inside the WebRTC bridge",
        },
        "pipecat": {
            "runtimeMode": "pipecat_browser_webrtc_bridge",
            "runtimeEngine": "pipecat-ai",
            "pipecatVersion": readiness.pipecat_version,
            "aiortcVersion": readiness.aiortc_version,
            "mediaFlow": "WebRTC audio track -> InputAudioRawFrame -> rtc-asr transcript -> TextFrame -> Kokoro -> TTSAudioRawFrame -> WebRTC audio track",
        },
        "stt": {
            "engine": "rtc-asr",
            "contract": "local-stt.v1",
            "wsUrl": DEFAULT_RTC_ASR_WS_URL,
            "model": readiness.stt_model,
            "backend": readiness.stt_backend,
            "sidecar": readiness.rtc_asr.__dict__,
        },
        "tts": {
            "engine": "kokoro",
            "baseUrl": DEFAULT_KOKORO_BASE_URL,
            "speechUrl": join_url(DEFAULT_KOKORO_BASE_URL, DEFAULT_KOKORO_SPEECH_PATH),
            "voice": DEFAULT_KOKORO_VOICE,
            "model": DEFAULT_KOKORO_MODEL,
            "sidecar": readiness.kokoro.__dict__,
        },
        "acc": readiness.acc.__dict__,
        "nextAction": "start ACC, rtc-asr, and Kokoro locally, then open /operator/console and click Connect Voice",
    }


def latest_agent_text(call: dict[str, Any]) -> str:
    transcript = call.get("transcript") if isinstance(call, dict) else None
    if not isinstance(transcript, list):
        return ""
    for turn in reversed(transcript):
        if isinstance(turn, dict) and turn.get("speaker") == "agent" and isinstance(turn.get("text"), str):
            return turn["text"]
    return ""


def transcript_text_from_event(event: dict[str, Any]) -> str:
    candidates = [event.get("transcript"), event.get("text"), event.get("delta")]
    result = event.get("result")
    if isinstance(result, dict):
        candidates.extend([result.get("text"), result.get("transcript")])
    transcript = event.get("transcript")
    if isinstance(transcript, dict):
        candidates.append(transcript.get("text"))
    alternatives = event.get("alternatives")
    if isinstance(alternatives, list) and alternatives and isinstance(alternatives[0], dict):
        candidates.append(alternatives[0].get("transcript"))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return ""


def is_final_stt_event(event: dict[str, Any]) -> bool:
    return bool(
        event.get("final") is True
        or event.get("is_final") is True
        or event.get("speech_final") is True
        or event.get("status") in {"final", "completed"}
        or event.get("type") in {"transcript.final", "final", "conversation.item.input_audio_transcription.completed"}
    )


def resample_pcm16_mono(pcm: bytes, from_rate: int, to_rate: int) -> bytes:
    if from_rate == to_rate:
        return pcm
    converted, _state = audioop.ratecv(pcm, SAMPLE_WIDTH_BYTES, 1, from_rate, to_rate, None)
    return converted


def normalize_browser_answer_sdp(sdp: str) -> str:
    """Keep aiortc answer SDP semantically identical but Chrome-parseable.

    aiortc 1.14 can emit a=setup after ICE candidates. Chrome rejects that
    answer shape even though the DTLS role itself is valid, so move setup next
    to the fingerprint block within each media section.
    """
    normalized = sdp.replace("\r\n", "\n").strip().split("\n")
    session_lines: list[str] = []
    media_sections: list[list[str]] = []
    current: list[str] | None = None
    for line in normalized:
        if line.startswith("m="):
            current = [line]
            media_sections.append(current)
        elif current is None:
            session_lines.append(line)
        else:
            current.append(line)

    output = list(session_lines)
    for section in media_sections:
        setup_lines = [line for line in section if line.startswith("a=setup:")]
        reordered = [line for line in section if not line.startswith("a=setup:")]
        if setup_lines:
            insert_at = -1
            for index, line in enumerate(reordered):
                if line.startswith("a=fingerprint:"):
                    insert_at = index
            if insert_at >= 0:
                reordered[insert_at + 1:insert_at + 1] = setup_lines
            else:
                reordered.extend(setup_lines)
        output.extend(reordered)
    return "\r\n".join(output) + "\r\n"


class AccVoicePipelineSession:
    def __init__(
        self,
        *,
        acc_url: str,
        call_id: str,
        readiness: BridgeReadiness,
        evidence_callback: Callable[[dict[str, Any]], None] | None = None,
        track_recording_dir: str | Path | None = None,
        correlation_id: str | None = None,
        flow_manager_adapter: AccPipecatFlowManagerAdapter | None = None,
    ):
        self.acc_url = acc_url.rstrip("/")
        self.call_id = call_id
        self.correlation_id = correlation_id or f"acc-pipecat-{call_id}"
        self.readiness = readiness
        self.turn_count = 0
        self.output_generation = 0
        self.output_active_until = 0.0
        self.output_stream_active = False
        self.output_stream_id: str | None = None
        self.output_stream_started_monotonic = 0.0
        self.output_stream_chunk_count = 0
        self.output_stream_audio_bytes = 0
        self.output_flush_count = 0
        self.active_agent_task: asyncio.Task[Any] | None = None
        self.active_tts_task: asyncio.Task[Any] | None = None
        self.last_barge_in_evidence: dict[str, Any] = {}
        self.last_evidence: dict[str, Any] = {}
        self.last_audio_evidence: dict[str, Any] = {}
        self.last_stt_evidence: dict[str, Any] = {}
        self.last_acc_evidence: dict[str, Any] = {}
        self.last_tts_evidence: dict[str, Any] = {}
        self.last_error: dict[str, Any] = {}
        self.stage_events: list[dict[str, Any]] = []
        self.rtc_asr_ws: Any | None = None
        self.rtc_asr_connection_id = 0
        self.rtc_asr_started = False
        self.rtc_asr_closing = False
        self.rtc_asr_utterance_id = 0
        self.rtc_asr_lock = asyncio.Lock()
        self.rtc_asr_current_audio_bytes = 0
        self.rtc_asr_session_audio_bytes = 0
        self.rtc_asr_session_event_count = 0
        self.rtc_asr_interim_events: list[dict[str, Any]] = []
        self.turn_controls: PipecatTurnControls | None = None
        self.evidence_callback = evidence_callback
        self.pending_caller_turn_commit: dict[str, Any] | None = None
        recording_dir = track_recording_dir or os.environ.get("ACC_TRACK_RECORDINGS_DIR")
        self.track_recorder = SeparateTrackRecorder(artifact_dir=recording_dir, call_id=call_id) if recording_dir else None
        self.last_track_recording_manifest: dict[str, Any] | None = None
        self.flow_manager_adapter = flow_manager_adapter

    def evidence_snapshot(self) -> dict[str, Any]:
        return {
            "callId": self.call_id,
            "correlationId": self.correlation_id,
            "turnCount": self.turn_count,
            "lastEvidence": self.last_evidence,
            "lastAudioEvidence": self.last_audio_evidence,
            "lastSttEvidence": self.last_stt_evidence,
            "lastAccEvidence": self.last_acc_evidence,
            "lastTtsEvidence": self.last_tts_evidence,
            "lastError": self.last_error,
            "stageEvents": self.stage_events,
            "rtcAsr": {
                "connectionId": self.rtc_asr_connection_id,
                "persistentSession": True,
                "sessionAudioBytes": self.rtc_asr_session_audio_bytes,
                "sessionEventCount": self.rtc_asr_session_event_count,
            },
            "output": {
                "generation": self.output_generation,
                "streamActive": self.output_stream_active,
                "streamId": self.output_stream_id,
                "chunkCount": self.output_stream_chunk_count,
                "audioBytesEnqueued": self.output_stream_audio_bytes,
                "flushCount": self.output_flush_count,
                "playbackPending": time.monotonic() <= self.output_active_until,
            },
            "bargeIn": self.last_barge_in_evidence,
            "pendingCallerTurnCommit": bool(self.pending_caller_turn_commit),
            "trackRecordings": self.last_track_recording_manifest,
            "flowManager": self.flow_manager_adapter.last_evidence if self.flow_manager_adapter else {},
        }

    def get_flow_manager_adapter(self) -> AccPipecatFlowManagerAdapter:
        if self.flow_manager_adapter is None:
            self.flow_manager_adapter = AccPipecatFlowManagerAdapter(
                acc_url=self.acc_url,
                call_id=self.call_id,
                request_json=lambda method, url, payload: json_http(method, url, payload),
            )
        return self.flow_manager_adapter

    def record_stage(self, stage: str, *, ok: bool = True, **detail: Any) -> dict[str, Any]:
        event = {
            "stage": stage,
            "ok": ok,
            "callId": self.call_id,
            "correlationId": self.correlation_id,
            "timestamp": datetime.now(UTC).isoformat(timespec="milliseconds"),
            **detail,
        }
        self.stage_events.append(event)
        self.stage_events = self.stage_events[-40:]
        if stage.startswith("audio."):
            self.last_audio_evidence = event
        elif stage.startswith("stt."):
            self.last_stt_evidence = event
        elif stage.startswith("acc."):
            self.last_acc_evidence = event
        elif stage.startswith("tts."):
            self.last_tts_evidence = event
        if not ok:
            self.last_error = event
        print(json.dumps({"type": "browser_webrtc_stage", **event}), flush=True)
        if self.evidence_callback:
            self.evidence_callback(self.evidence_snapshot())
        return event

    def record_caller_track(self, pcm: bytes, *, sample_rate: int, event_id: str | None = None) -> None:
        if self.track_recorder:
            self.track_recorder.record_caller_audio(pcm, sample_rate_hz=sample_rate, event_id=event_id)

    def record_agent_track(self, pcm: bytes, *, sample_rate: int, event_id: str | None = None) -> None:
        if self.track_recorder:
            self.track_recorder.record_agent_audio(pcm, sample_rate_hz=sample_rate, event_id=event_id)

    def write_track_recording_manifest(self, reason: str) -> dict[str, Any] | None:
        if not self.track_recorder:
            return None
        self.last_track_recording_manifest = self.track_recorder.write_manifest(reason=reason, stage_events=self.stage_events)
        if self.evidence_callback:
            self.evidence_callback(self.evidence_snapshot())
        return self.last_track_recording_manifest

    def has_active_response(self) -> bool:
        return bool(
            self.output_stream_active
            or time.monotonic() <= self.output_active_until
            or (self.active_agent_task and not self.active_agent_task.done())
            or (self.active_tts_task and not self.active_tts_task.done())
        )

    def register_response_task(self, kind: str, task: asyncio.Task[Any]) -> None:
        if kind == "agent":
            self.active_agent_task = task
        elif kind == "tts":
            self.active_tts_task = task
        else:
            raise ValueError(f"unknown response task kind: {kind}")

    def clear_response_task(self, kind: str, task: asyncio.Task[Any]) -> None:
        if kind == "agent" and self.active_agent_task is task:
            self.active_agent_task = None
        elif kind == "tts" and self.active_tts_task is task:
            self.active_tts_task = None

    def begin_output_stream(self, *, stream_id: str) -> None:
        self.output_stream_active = True
        self.output_stream_id = stream_id
        self.output_stream_started_monotonic = time.monotonic()
        self.output_stream_chunk_count = 0
        self.output_stream_audio_bytes = 0

    def extend_output_window(self, *, audio_bytes: int, sample_rate: int, channels: int = 1) -> dict[str, Any]:
        duration_s = audio_bytes / max(sample_rate * SAMPLE_WIDTH_BYTES * channels, 1)
        now = time.monotonic()
        if self.output_active_until < now:
            self.output_active_until = now + 0.5
        self.output_active_until += duration_s
        return {
            "audioBytes": audio_bytes,
            "sampleRate": sample_rate,
            "channels": channels,
            "estimatedChunkDurationMs": round(duration_s * 1000),
            "activeUntilMonotonicMs": round(self.output_active_until * 1000),
        }

    def record_output_chunk(self, audio_bytes: int) -> None:
        self.output_stream_chunk_count += 1
        self.output_stream_audio_bytes += audio_bytes

    def finish_output_stream(self) -> None:
        self.output_stream_active = False

    def set_pending_caller_turn_commit(self, *, payload: dict[str, Any], expected_agent_text: str, output_generation: int) -> None:
        self.pending_caller_turn_commit = {
            "url": f"{self.acc_url}/api/calls/{self.call_id}/caller-turn/commit",
            "payload": payload,
            "expectedAgentText": expected_agent_text,
            "outputGeneration": output_generation,
            "createdAt": datetime.now(UTC).isoformat(timespec="milliseconds"),
        }
        self.record_stage(
            "acc.caller_turn_commit_pending",
            callerTranscript=payload.get("text"),
            agentText=expected_agent_text,
            outputGeneration=output_generation,
        )

    def discard_pending_caller_turn_commit(self, reason: str) -> None:
        pending = self.pending_caller_turn_commit
        if self.flow_manager_adapter is not None:
            self.flow_manager_adapter.discard_pending_transition(reason)
            self.last_evidence = {**self.last_evidence, "flowManager": self.flow_manager_adapter.last_evidence}
        if not pending:
            return
        self.pending_caller_turn_commit = None
        payload = pending.get("payload") if isinstance(pending, dict) else {}
        self.record_stage(
            "acc.caller_turn_commit_discarded",
            ok=False,
            error=reason,
            callerTranscript=payload.get("text") if isinstance(payload, dict) else None,
            outputGeneration=self.output_generation,
        )

    async def commit_pending_caller_turn_delivery(
        self,
        *,
        expected_agent_text: str,
        output_generation: int,
        output_interrupted_after_delivery: bool = False,
    ) -> dict[str, Any] | None:
        pending = self.pending_caller_turn_commit
        if not pending:
            return None
        if (
            not output_interrupted_after_delivery
            and (pending.get("outputGeneration") != output_generation or self.output_generation != output_generation)
        ):
            self.discard_pending_caller_turn_commit("stale_output_generation_before_delivery_ack")
            return None
        payload = pending.get("payload")
        url = pending.get("url")
        if not isinstance(payload, dict) or not isinstance(url, str):
            self.discard_pending_caller_turn_commit("invalid_pending_delivery_ack")
            return None
        commit_task = asyncio.create_task(asyncio.to_thread(json_http, "POST", url, payload))
        cancelled_after_delivery = output_interrupted_after_delivery
        try:
            call = await asyncio.shield(commit_task)
        except asyncio.CancelledError:
            # The first PCM frame is already downstream at this boundary. Finish
            # the in-flight commit so ACC evidence reflects the delivered turn,
            # then preserve the caller's cancellation for the TTS task.
            call = await commit_task
            cancelled_after_delivery = True
        except Exception as exc:
            self.discard_pending_caller_turn_commit("delivery_ack_commit_rejected")
            if self.flow_manager_adapter is not None:
                await self.flow_manager_adapter.rollback_pending_transition("delivery_ack_commit_rejected")
            self.record_stage(
                "acc.caller_turn_delivery_rejected",
                ok=False,
                error="delivery_ack_commit_rejected",
                detail=str(exc),
                callerTranscript=payload.get("text"),
                expectedAgentText=expected_agent_text,
                outputGeneration=self.output_generation,
            )
            raise
        self.pending_caller_turn_commit = None
        if self.flow_manager_adapter is not None and self.flow_manager_adapter.pending_transition is not None:
            self.flow_manager_adapter.finalize_pending_transition()
        flow_manager_evidence = self.flow_manager_adapter.last_evidence if self.flow_manager_adapter is not None else None
        committed_agent_text = latest_agent_text(call)
        matches_expected = committed_agent_text == expected_agent_text
        self.record_stage(
            "acc.caller_turn_delivery_committed",
            ok=matches_expected,
            error=None if matches_expected else "committed_agent_text_mismatch",
            callerTranscript=payload.get("text"),
            agentText=committed_agent_text,
            expectedAgentText=expected_agent_text,
            outputGeneration=self.output_generation,
            outputInterruptedAfterDelivery=cancelled_after_delivery,
            flowManager=flow_manager_evidence,
        )
        if cancelled_after_delivery:
            raise asyncio.CancelledError
        return call

    async def prepare_pending_caller_turn_delivery(self, *, expected_agent_text: str, output_generation: int) -> None:
        pending = self.pending_caller_turn_commit
        if not pending:
            return
        if pending.get("outputGeneration") != output_generation or self.output_generation != output_generation:
            self.discard_pending_caller_turn_commit("stale_output_generation_before_delivery_ack")
            return
        payload = pending.get("payload")
        if not isinstance(payload, dict):
            self.discard_pending_caller_turn_commit("invalid_pending_delivery_ack")
            return
        if self.flow_manager_adapter is not None and self.flow_manager_adapter.pending_transition is not None:
            flow_manager_evidence = await self.flow_manager_adapter.prepare_pending_transition()
            self.last_evidence = {**self.last_evidence, "flowManager": flow_manager_evidence}
            if flow_manager_evidence.get("ok") is not True:
                self.pending_caller_turn_commit = None
                self.record_stage(
                    "acc.caller_turn_delivery_failed",
                    ok=False,
                    error="flowmanager_delivery_ack_failed_closed",
                    detail=flow_manager_evidence.get("detail"),
                    callerTranscript=payload.get("text"),
                    expectedAgentText=expected_agent_text,
                    outputGeneration=self.output_generation,
                    accCommitSucceeded=False,
                    deliveryCommitted=False,
                    flowManager=flow_manager_evidence,
                )
                raise CallerTurnDeliveryCommitError("flowmanager_delivery_ack_failed_closed")
            if (
                flow_manager_evidence.get("commitPolicy") != "transition_prepared_until_audio_delivery_ack"
                or output_generation != self.output_generation
            ):
                self.discard_pending_caller_turn_commit("flowmanager_transition_cancelled_before_audio")
                await self.flow_manager_adapter.rollback_pending_transition(
                    "flowmanager_transition_cancelled_before_audio"
                )
                raise asyncio.CancelledError

    async def rollback_pending_caller_turn_delivery(self, reason: str) -> None:
        if self.flow_manager_adapter is None:
            return
        flow_manager_evidence = await self.flow_manager_adapter.rollback_pending_transition(reason)
        self.last_evidence = {**self.last_evidence, "flowManager": flow_manager_evidence}

    def cancel_output(self, reason: str = "barge-in") -> dict[str, Any]:
        if not self.has_active_response():
            self.last_barge_in_evidence = {
                "reason": reason,
                "skipped": True,
                "skipReason": "no_active_output_audio",
                "outputGeneration": self.output_generation,
                "timestamp": datetime.now(UTC).isoformat(timespec="milliseconds"),
            }
            print(json.dumps({"type": "browser_webrtc_output_cancel_skipped", **self.last_barge_in_evidence}), flush=True)
            return self.last_barge_in_evidence
        requested_at = time.monotonic()
        self.output_generation += 1
        if self.output_stream_chunk_count == 0:
            self.discard_pending_caller_turn_commit("barge_in_cancelled_before_delivery")
        elif self.pending_caller_turn_commit:
            self.record_stage(
                "acc.caller_turn_commit_preserved",
                callerTranscript=self.pending_caller_turn_commit.get("payload", {}).get("text"),
                reason="barge_in_after_first_audio_delivery",
                outputGeneration=self.output_generation,
            )
        cancelled_tasks: list[str] = []
        current_task = asyncio.current_task()
        for kind, task in (("agent", self.active_agent_task), ("tts", self.active_tts_task)):
            if task and task is not current_task and not task.done():
                task.cancel()
                cancelled_tasks.append(kind)
        self.last_barge_in_evidence = {
            "reason": reason,
            "skipped": False,
            "pipecatInterruptionFrame": "pending",
            "outputGeneration": self.output_generation,
            "outputStreamId": self.output_stream_id,
            "outputChunksEnqueued": self.output_stream_chunk_count,
            "outputAudioBytesEnqueued": self.output_stream_audio_bytes,
            "cancelledTasks": cancelled_tasks,
            "stopRequestedMonotonicMs": round(requested_at * 1000, 3),
            "timestamp": datetime.now(UTC).isoformat(timespec="milliseconds"),
        }
        print(json.dumps({"type": "browser_webrtc_output_cancelled", **self.last_barge_in_evidence}), flush=True)
        return self.last_barge_in_evidence

    def mark_output_flushed(self) -> dict[str, Any]:
        flushed_at = time.monotonic()
        requested_at_ms = self.last_barge_in_evidence.get("stopRequestedMonotonicMs")
        latency_ms = None
        if isinstance(requested_at_ms, (int, float)):
            latency_ms = round(flushed_at * 1000 - requested_at_ms, 3)
        self.output_stream_active = False
        self.output_active_until = flushed_at
        self.output_flush_count += 1
        self.last_barge_in_evidence = {
            **self.last_barge_in_evidence,
            "pipecatInterruptionFrame": "broadcast",
            "transportOutputFlushed": True,
            "transportFlushLatencyMs": latency_ms,
            "flushedAtMonotonicMs": round(flushed_at * 1000, 3),
        }
        self.record_stage(
            "output.transport_flushed",
            streamId=self.output_stream_id,
            outputGeneration=self.output_generation,
            transportFlushLatencyMs=latency_ms,
            outputChunksEnqueued=self.output_stream_chunk_count,
            outputAudioBytesEnqueued=self.output_stream_audio_bytes,
        )
        return self.last_barge_in_evidence

    async def transcribe(self, frame: InputAudioRawFrame) -> tuple[str, dict[str, Any], TranscriptionFrame]:
        started = time.perf_counter()
        final_text = ""
        events: list[dict[str, Any]] = []
        async with self.rtc_asr_lock:
            await self.ensure_rtc_asr_stream()
            if self.rtc_asr_current_audio_bytes == 0 and frame.audio:
                await self.send_rtc_asr_audio_locked(frame.audio)
            ws = self.rtc_asr_ws
            if ws is None:
                raise RuntimeError("rtc-asr websocket was not available after start")
            await ws.send(json.dumps({"type": "finalize"}))
            try:
                deadline = time.monotonic() + float(os.environ.get("RTC_ASR_FINAL_TIMEOUT_SEC", "12"))
                while time.monotonic() < deadline:
                    event = await self.recv_rtc_asr_event_locked(timeout=max(0.1, deadline - time.monotonic()))
                    if event is None:
                        continue
                    events.append(event)
                    candidate = transcript_text_from_event(event)
                    if candidate:
                        final_text = candidate
                    if is_final_stt_event(event):
                        break
            finally:
                # local-stt.v1 finalize ends the current utterance, not the socket.
                # The next audio turn must send a new start event on this connection.
                self.rtc_asr_started = False
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        audio_bytes = self.rtc_asr_current_audio_bytes or len(frame.audio)
        meta = {
            "engine": "rtc-asr",
            "contract": "local-stt.v1",
            "model": self.readiness.stt_model,
            "backend": self.readiness.stt_backend,
            "connectionId": self.rtc_asr_connection_id,
            "persistentSession": True,
            "elapsedMs": elapsed_ms,
            "audioBytes": audio_bytes,
            "sessionAudioBytes": self.rtc_asr_session_audio_bytes,
            "sessionEventCount": self.rtc_asr_session_event_count,
            "interimEventCount": len([event for event in events if not is_final_stt_event(event) and transcript_text_from_event(event)]),
            "eventCount": len(events),
        }
        self.rtc_asr_current_audio_bytes = 0
        result_frame = TranscriptionFrame(final_text.strip(), user_id="browser", timestamp=str(time.time()), result={"events": events}, finalized=True)
        return result_frame.text.strip(), meta, result_frame

    async def ensure_rtc_asr_stream(self) -> None:
        if self.rtc_asr_closing:
            raise RuntimeError("rtc-asr session is closing")
        if self.rtc_asr_ws is not None and (getattr(self.rtc_asr_ws, "closed", False) or getattr(self.rtc_asr_ws, "close_code", None) is not None):
            self.rtc_asr_ws = None
            self.rtc_asr_started = False
        if self.rtc_asr_ws is not None and self.rtc_asr_started:
            return
        if self.rtc_asr_ws is None:
            ws = await websockets.connect(DEFAULT_RTC_ASR_WS_URL, max_size=20 * 1024 * 1024)
            if self.rtc_asr_closing:
                with contextlib.suppress(Exception):
                    await ws.close()
                raise RuntimeError("rtc-asr session is closing")
            self.rtc_asr_connection_id += 1
            self.rtc_asr_ws = ws
            self.record_stage(
                "stt.session_started",
                connectionId=self.rtc_asr_connection_id,
                persistentSession=True,
                wsUrl=DEFAULT_RTC_ASR_WS_URL,
            )
        ws = self.rtc_asr_ws
        if ws is None or self.rtc_asr_closing:
            raise RuntimeError("rtc-asr session is closing")
        await ws.send(
            json.dumps(
                {
                    "type": "start",
                    "version": "local-stt.v1",
                    "audio": {
                        "sample_rate": INPUT_SAMPLE_RATE,
                        "channels": 1,
                        "format": "pcm_s16le",
                        "frame_ms": 20,
                        "bytes_per_frame": 640,
                    },
                    "interim_results": True,
                    "model": self.readiness.stt_model if self.readiness.stt_model != "unknown" else None,
                }
            )
        )
        if self.rtc_asr_closing:
            raise RuntimeError("rtc-asr session is closing")
        self.rtc_asr_utterance_id += 1
        self.rtc_asr_started = True
        self.record_stage(
            "stt.utterance_started",
            connectionId=self.rtc_asr_connection_id,
            utteranceId=self.rtc_asr_utterance_id,
            persistentSession=True,
        )

    async def recv_rtc_asr_event_locked(self, *, timeout: float) -> dict[str, Any] | None:
        ws = self.rtc_asr_ws
        if ws is None:
            return None
        try:
            message = await asyncio.wait_for(ws.recv(), timeout=timeout)
        except asyncio.TimeoutError:
            return None
        if not isinstance(message, str):
            return None
        event = json.loads(message)
        if not isinstance(event, dict):
            return None
        self.rtc_asr_session_event_count += 1
        transcript = transcript_text_from_event(event)
        if transcript and not is_final_stt_event(event):
            interim = self.record_stage(
                "stt.transcript_interim",
                transcript=transcript,
                connectionId=self.rtc_asr_connection_id,
                persistentSession=True,
            )
            self.rtc_asr_interim_events.append(interim)
            self.rtc_asr_interim_events = self.rtc_asr_interim_events[-20:]
        return event

    async def send_rtc_asr_audio_locked(self, pcm: bytes) -> None:
        await self.ensure_rtc_asr_stream()
        ws = self.rtc_asr_ws
        if ws is None:
            raise RuntimeError("rtc-asr websocket was not available after start")
        for offset in range(0, len(pcm), 640):
            chunk = pcm[offset : offset + 640]
            await ws.send(chunk)
            self.rtc_asr_current_audio_bytes += len(chunk)
            self.rtc_asr_session_audio_bytes += len(chunk)
            await self.recv_rtc_asr_event_locked(timeout=0.001)

    async def stream_rtc_asr_audio(self, pcm: bytes) -> None:
        async with self.rtc_asr_lock:
            await self.send_rtc_asr_audio_locked(pcm)

    async def close_rtc_asr_stream(self, reason: str = "session_closed") -> None:
        # Detach and close without waiting for rtc_asr_lock. A final transcript
        # receive may hold that lock for RTC_ASR_FINAL_TIMEOUT_SEC; closing the
        # socket interrupts the receive so peer disconnect stays prompt.
        self.rtc_asr_closing = True
        ws = self.rtc_asr_ws
        self.rtc_asr_ws = None
        self.rtc_asr_started = False
        if ws is None:
            return
        close_timeout = float(os.environ.get("RTC_ASR_CLOSE_TIMEOUT_SEC", "0.5"))
        with contextlib.suppress(Exception):
            await asyncio.wait_for(ws.send(json.dumps({"type": "close", "reason": reason})), timeout=close_timeout)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(ws.close(), timeout=close_timeout)
        self.record_stage("stt.session_closed", connectionId=self.rtc_asr_connection_id, reason=reason, persistentSession=True)

    async def stream_synthesize(self, frame: TextFrame, *, chunk_bytes: int) -> Any:
        """Yield raw Kokoro PCM chunks as the HTTP streaming response produces them."""
        started = time.perf_counter()
        payload = {
            "model": DEFAULT_KOKORO_MODEL,
            "voice": DEFAULT_KOKORO_VOICE,
            "input": frame.text,
            "response_format": "pcm",
            "stream": True,
        }
        response = await asyncio.to_thread(
            open_http_stream,
            "POST",
            join_url(DEFAULT_KOKORO_BASE_URL, DEFAULT_KOKORO_SPEECH_PATH),
            payload,
            30,
        )
        sample_rate = int(os.environ.get("KOKORO_OUTPUT_SAMPLE_RATE", "24000"))
        read_size = max(chunk_bytes - (chunk_bytes % SAMPLE_WIDTH_BYTES), SAMPLE_WIDTH_BYTES)
        pending = b""
        first_audio_ms: int | None = None
        try:
            while True:
                raw = await asyncio.to_thread(response.read, read_size)
                if not raw:
                    break
                pending += raw
                aligned_bytes = len(pending) - (len(pending) % SAMPLE_WIDTH_BYTES)
                if aligned_bytes <= 0:
                    continue
                chunk = pending[:aligned_bytes]
                pending = pending[aligned_bytes:]
                elapsed_ms = round((time.perf_counter() - started) * 1000)
                if first_audio_ms is None:
                    first_audio_ms = elapsed_ms
                yield chunk, sample_rate, {
                    "engine": "kokoro",
                    "voice": DEFAULT_KOKORO_VOICE,
                    "model": DEFAULT_KOKORO_MODEL,
                    "format": "pcm_s16le",
                    "providerStream": True,
                    "firstAudioMs": first_audio_ms,
                    "elapsedMs": elapsed_ms,
                }
        finally:
            with contextlib.suppress(Exception):
                await asyncio.to_thread(response.close)


class PipecatTurnControls:
    """Use Pipecat's turn primitives while keeping the external rtc-asr boundary."""

    def __init__(self, session: AccVoicePipelineSession, interrupt_output: Any):
        self.session = session
        self.interrupt_output = interrupt_output
        self.min_words = int(os.environ.get("ACC_WEBRTC_BARGE_IN_MIN_WORDS", "2"))
        self.start_strategy = MinWordsUserTurnStartStrategy(min_words=self.min_words, use_interim=False)
        self.start_strategy.add_event_handler("on_user_turn_started", self._on_user_turn_started)
        self.smart_turn = LocalSmartTurnAnalyzerV3(sample_rate=INPUT_SAMPLE_RATE)
        # BaseTurnAnalyzer retains the constructor value as its preferred rate
        # but does not make it effective until set_sample_rate() is called.
        # We use the analyzer directly rather than through a transport VAD, so
        # initialize it here to avoid division by zero while appending silence.
        self.smart_turn.set_sample_rate(INPUT_SAMPLE_RATE)
        self.bot_speaking = False

    async def bot_started(self) -> None:
        if self.bot_speaking:
            return
        self.bot_speaking = True
        await self.start_strategy.process_frame(BotStartedSpeakingFrame())

    async def bot_stopped(self) -> None:
        if not self.bot_speaking:
            return
        self.bot_speaking = False
        await self.start_strategy.process_frame(BotStoppedSpeakingFrame())

    async def sync_bot_state(self) -> None:
        if self.bot_speaking and time.monotonic() > self.session.output_active_until:
            await self.bot_stopped()

    def observe_audio(self, pcm: bytes, is_speech: bool) -> None:
        self.smart_turn.append_audio(pcm, is_speech)

    async def is_turn_complete(self) -> bool:
        state, metrics = await self.smart_turn.analyze_end_of_turn()
        self.session.record_stage(
            "turn.smart_turn_decision",
            complete=state == EndOfTurnState.COMPLETE,
            strategy="LocalSmartTurnAnalyzerV3",
            probability=getattr(metrics, "probability", None),
        )
        return state == EndOfTurnState.COMPLETE

    async def observe_transcription(self, frame: TranscriptionFrame) -> None:
        await self.sync_bot_state()
        await self.start_strategy.process_frame(frame)

    async def _on_user_turn_started(self, _strategy: Any, _params: Any) -> None:
        cancellation = self.session.cancel_output("min_words_barge_in")
        self.session.record_stage(
            "turn.min_words_start",
            strategy="MinWordsUserTurnStartStrategy",
            minWords=self.min_words,
            skipped=cancellation.get("skipped"),
        )
        if not cancellation.get("skipped"):
            await self.interrupt_output()


class RtcAsrTurnProcessor(FrameProcessor):
    def __init__(self, session: AccVoicePipelineSession):
        super().__init__(name="rtc-asr-turn-processor")
        self.session = session
        self.speech_chunks: list[bytes] = []
        self.in_speech = False
        self.last_voice_at = time.monotonic()
        self.turn_started_at = time.monotonic()
        self.silence_rms = int(os.environ.get("ACC_WEBRTC_SILENCE_RMS", "260"))
        self.silence_ms = int(os.environ.get("ACC_WEBRTC_SILENCE_MS", "1200"))
        self.min_turn_ms = int(os.environ.get("ACC_WEBRTC_MIN_TURN_MS", "600"))
        self.max_turn_ms = int(os.environ.get("ACC_WEBRTC_MAX_TURN_MS", "9000"))
        self.last_audio_report_at = 0.0
        self.silence_finalize_task: asyncio.Task[None] | None = None
        self.finalize_lock = asyncio.Lock()
        self.turn_controls = PipecatTurnControls(session, self.interrupt_output)
        self.session.turn_controls = self.turn_controls

    def collected_speech_ms(self) -> int:
        return round(sum(len(chunk) for chunk in self.speech_chunks) / (INPUT_SAMPLE_RATE * SAMPLE_WIDTH_BYTES) * 1000)

    def cancel_silence_finalize_task(self) -> None:
        current_task = asyncio.current_task()
        if self.silence_finalize_task and self.silence_finalize_task is not current_task:
            self.silence_finalize_task.cancel()
        if self.silence_finalize_task is not current_task:
            self.silence_finalize_task = None

    def arm_silence_finalize_task(self, delay_ms: int | None = None) -> None:
        self.cancel_silence_finalize_task()
        self.silence_finalize_task = asyncio.create_task(self.finalize_after_silence(delay_ms))

    async def finalize_after_silence(self, delay_ms: int | None = None) -> None:
        try:
            await asyncio.sleep(max(delay_ms if delay_ms is not None else self.silence_ms, 1) / 1000)
            await self.finalize_turn("silence_timer")
        except asyncio.CancelledError:
            return

    async def finalize_turn(self, reason: str) -> None:
        async with self.finalize_lock:
            if not self.in_speech or not self.speech_chunks:
                return
            now = time.monotonic()
            collected_ms = self.collected_speech_ms()
            silence_elapsed_ms = round((now - self.last_voice_at) * 1000)
            max_elapsed_ms = round((now - self.turn_started_at) * 1000)
            if reason == "silence_timer" and (collected_ms < self.min_turn_ms or silence_elapsed_ms < self.silence_ms):
                if self.in_speech:
                    self.arm_silence_finalize_task()
                return
            should_check_smart_turn = reason == "silence_timer" and max_elapsed_ms < self.max_turn_ms
        if should_check_smart_turn and not await self.turn_controls.is_turn_complete():
            if self.in_speech:
                self.arm_silence_finalize_task(delay_ms=200)
            return
        async with self.finalize_lock:
            if not self.in_speech or not self.speech_chunks:
                return
            pcm_turn = b"".join(self.speech_chunks)
            self.speech_chunks = []
            self.in_speech = False
            self.turn_started_at = now
            self.last_voice_at = now
            self.cancel_silence_finalize_task()
        self.session.record_stage(
            "stt.finalize_started",
            audioBytes=len(pcm_turn),
            collectedMs=collected_ms,
            silenceElapsedMs=silence_elapsed_ms,
            maxElapsedMs=max_elapsed_ms,
            reason=reason,
        )
        try:
            transcript, stt_meta, transcription_frame = await self.session.transcribe(InputAudioRawFrame(audio=pcm_turn, sample_rate=INPUT_SAMPLE_RATE, num_channels=1))
        except Exception as exc:
            self.session.last_evidence = {
                "ok": False,
                "error": "stt_transcription_failed",
                "detail": str(exc),
                "audio": self.session.last_audio_evidence,
                "callId": self.session.call_id,
            }
            self.session.record_stage("stt.failed", ok=False, error="stt_transcription_failed", detail=str(exc), audioBytes=len(pcm_turn))
            return
        if not transcript.strip():
            self.session.last_evidence = {
                "ok": False,
                "error": "empty_transcript",
                "audio": self.session.last_audio_evidence,
                "stt": stt_meta,
                "callId": self.session.call_id,
            }
            self.session.record_stage("stt.empty_transcript", ok=False, error="empty_transcript", stt=stt_meta)
            return
        self.session.record_stage("stt.transcript_final", transcript=transcript, stt=stt_meta)
        transcription_frame.result = {**(transcription_frame.result or {}), "stt": stt_meta}
        await self.turn_controls.observe_transcription(transcription_frame)
        await self.push_frame(transcription_frame, FrameDirection.DOWNSTREAM)

    async def interrupt_output(self) -> None:
        await self.broadcast_frame(InterruptionFrame)
        self.session.mark_output_flushed()

    async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM or not isinstance(frame, InputAudioRawFrame):
            await self.push_frame(frame, direction)
            return
        pcm = frame.audio
        if not pcm:
            return
        self.session.record_caller_track(
            pcm,
            sample_rate=getattr(frame, "sample_rate", INPUT_SAMPLE_RATE),
            event_id=f"caller-frame-{len(self.session.stage_events) + 1}",
        )
        rms = audioop.rms(pcm, SAMPLE_WIDTH_BYTES)
        now = time.monotonic()
        frame_ms = round(len(pcm) / (INPUT_SAMPLE_RATE * SAMPLE_WIDTH_BYTES) * 1000)
        if now - self.last_audio_report_at >= 1.0:
            self.last_audio_report_at = now
            self.session.record_stage(
                "audio.frame",
                rms=rms,
                frameBytes=len(pcm),
                frameMs=frame_ms,
                sampleRate=getattr(frame, "sample_rate", INPUT_SAMPLE_RATE),
                silenceThresholdRms=self.silence_rms,
                inSpeech=self.in_speech,
                collectedMs=self.collected_speech_ms(),
            )
        if rms > self.silence_rms:
            speech_started = not self.in_speech
            if speech_started:
                self.turn_started_at = now
                self.session.record_stage("audio.speech_started", rms=rms, silenceThresholdRms=self.silence_rms)
                cancellation = self.session.cancel_output("speech_started_barge_in")
                if not cancellation.get("skipped"):
                    await self.interrupt_output()
            self.in_speech = True
            self.last_voice_at = now
        self.turn_controls.observe_audio(pcm, rms > self.silence_rms)
        if self.in_speech:
            self.speech_chunks.append(pcm)
            try:
                await self.session.stream_rtc_asr_audio(pcm)
            except Exception as exc:
                self.session.record_stage("stt.stream_failed", ok=False, error="stt_stream_failed", detail=str(exc), audioBytes=len(pcm))
                return
            self.arm_silence_finalize_task()
        collected_ms = self.collected_speech_ms()
        silence_elapsed_ms = round((now - self.last_voice_at) * 1000)
        max_elapsed_ms = round((now - self.turn_started_at) * 1000)
        should_finalize = self.in_speech and collected_ms >= self.min_turn_ms and (silence_elapsed_ms >= self.silence_ms or max_elapsed_ms >= self.max_turn_ms)
        if not should_finalize:
            return
        # Live WebRTC silence frames can reach this path before the timer fires.
        # Keep the reason aligned with the timer so Smart Turn always gates completion.
        await self.finalize_turn("silence_timer")


class AccCallerTurnProcessor(FrameProcessor):
    def __init__(self, session: AccVoicePipelineSession):
        super().__init__(name="acc-caller-turn-processor")
        self.session = session

    async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM or not isinstance(frame, TranscriptionFrame):
            await self.push_frame(frame, direction)
            return
        deterministic_agent_text = os.environ.get("ACC_PIPECAT_AGENT_TEXT_OVERRIDE", "").strip()
        if deterministic_agent_text:
            self.session.turn_count += 1
            self.session.record_stage(
                "acc.caller_turn_overridden",
                turn=self.session.turn_count,
                callerTranscript=frame.text,
                agentText=deterministic_agent_text,
                reason="ACC_PIPECAT_AGENT_TEXT_OVERRIDE",
            )
            self.session.last_evidence = {
                "ok": True,
                "turn": self.session.turn_count,
                "callerTranscript": frame.text,
                "agentText": deterministic_agent_text,
                "audio": self.session.last_audio_evidence,
                "stt": (frame.result or {}).get("stt", {}),
                "acc": self.session.last_acc_evidence,
                "tts": {"engine": "kokoro", "skipped": False, "audioBytes": 0},
                "bargeIn": self.session.last_barge_in_evidence,
                "outputCancelled": False,
                "pipecatFrames": {
                    "input": "InputAudioRawFrame",
                    "transcription": "TranscriptionFrame",
                    "agentText": "TextFrame",
                    "output": "TTSAudioRawFrame",
                },
                "callId": self.session.call_id,
            }
            await self.push_frame(TextFrame(deterministic_agent_text), FrameDirection.DOWNSTREAM)
            return
        turn_output_generation = self.session.output_generation
        conversation_mode = os.environ.get("ACC_PIPECAT_CONVERSATION_MODE", "free_caller").strip() or "free_caller"
        if conversation_mode not in {"free_caller", "scripted"}:
            conversation_mode = "free_caller"
        flow_manager = self.session.get_flow_manager_adapter()
        agent_task = asyncio.create_task(flow_manager.preview_caller_turn(
            text=frame.text,
            conversation_mode=conversation_mode,
        ))
        self.session.register_response_task("agent", agent_task)
        try:
            call = await agent_task
        except asyncio.CancelledError:
            if turn_output_generation != self.session.output_generation:
                self.session.record_stage(
                    "acc.cancelled",
                    ok=False,
                    error="barge_in_cancelled_agent_task",
                    callerTranscript=frame.text,
                    outputGeneration=self.session.output_generation,
                )
                return
            raise
        except Exception as exc:
            self.session.last_evidence = {
                "ok": False,
                "error": "acc_caller_turn_failed",
                "detail": str(exc),
                "callerTranscript": frame.text,
                "callId": self.session.call_id,
            }
            self.session.record_stage("acc.failed", ok=False, error="acc_caller_turn_failed", detail=str(exc), callerTranscript=frame.text)
            return
        finally:
            self.session.clear_response_task("agent", agent_task)
        if turn_output_generation != self.session.output_generation:
            self.session.record_stage(
                "acc.cancelled",
                ok=False,
                error="stale_agent_result_after_barge_in",
                callerTranscript=frame.text,
                outputGeneration=self.session.output_generation,
            )
            return
        agent_text = latest_agent_text(call)
        flow_manager_evidence = call.get("flowManagerRuntime") if isinstance(call, dict) else None
        flow_manager_commit_policy = (
            flow_manager_evidence.get("commitPolicy")
            if isinstance(flow_manager_evidence, dict)
            else None
        )
        self.session.turn_count += 1
        self.session.record_stage(
            "acc.caller_turn_completed",
            turn=self.session.turn_count,
            callerTranscript=frame.text,
            agentText=agent_text,
            agentTextAvailable=bool(agent_text),
            flowState=call.get("flowState") if isinstance(call, dict) else None,
            flowManager=flow_manager_evidence,
        )
        self.session.last_evidence = {
            "ok": bool(agent_text),
            "turn": self.session.turn_count,
            "callerTranscript": frame.text,
            "agentText": agent_text,
            "audio": self.session.last_audio_evidence,
            "stt": (frame.result or {}).get("stt", {}),
            "acc": self.session.last_acc_evidence,
            "tts": {"engine": "kokoro", "skipped": not bool(agent_text), "audioBytes": 0},
            "bargeIn": self.session.last_barge_in_evidence,
            "outputCancelled": False,
            "pipecatFrames": {
                "input": "InputAudioRawFrame",
                "transcription": "TranscriptionFrame",
                "agentText": "TextFrame" if agent_text else None,
                "output": "TTSAudioRawFrame" if agent_text else None,
            },
            "callId": self.session.call_id,
            "flowManager": flow_manager_evidence,
        }
        if agent_text and flow_manager_commit_policy == "preview_until_output_delivery_ack":
            commit_payload = {
                "text": frame.text,
                "conversationMode": conversation_mode,
                "expectedAgentText": agent_text,
            }
            commit_metadata = call.get("callerTurnCommit") if isinstance(call, dict) else None
            if isinstance(commit_metadata, dict) and isinstance(commit_metadata.get("snapshotVersion"), str):
                commit_payload["expectedSnapshotVersion"] = commit_metadata["snapshotVersion"]
            if isinstance(commit_metadata, dict) and isinstance(commit_metadata.get("timestamp"), str):
                commit_payload["timestamp"] = commit_metadata["timestamp"]
            self.session.set_pending_caller_turn_commit(
                payload=commit_payload,
                expected_agent_text=agent_text,
                output_generation=turn_output_generation,
            )
            await self.push_frame(TextFrame(agent_text), FrameDirection.DOWNSTREAM)
        elif agent_text and flow_manager_commit_policy == "terminal_handoff":
            self.session.discard_pending_caller_turn_commit("flowmanager_terminal_handoff_already_committed")
            self.session.record_stage(
                "acc.flowmanager_fail_closed_handoff",
                ok=False,
                error="flowmanager_runtime_failed_closed",
                callerTranscript=frame.text,
                agentText=agent_text,
                flowManager=flow_manager_evidence,
            )
            await self.push_frame(TextFrame(agent_text), FrameDirection.DOWNSTREAM)
        else:
            self.session.discard_pending_caller_turn_commit("agent_text_empty")
            self.session.record_stage("tts.skipped", ok=False, error="agent_text_empty", turn=self.session.turn_count)


class KokoroTtsProcessor(FrameProcessor):
    def __init__(self, session: AccVoicePipelineSession):
        super().__init__(name="kokoro-tts-processor")
        self.session = session

    async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM or not isinstance(frame, TextFrame):
            await self.push_frame(frame, direction)
            return
        turn_output_generation = self.session.output_generation
        tts_task = asyncio.current_task()
        if tts_task is None:
            raise RuntimeError("Kokoro TTS processor requires an active asyncio task")
        self.session.register_response_task("tts", tts_task)
        context_id = str(uuid4())
        sample_rate = int(os.environ.get("KOKORO_OUTPUT_SAMPLE_RATE", "24000"))
        chunk_ms = max(int(os.environ.get("ACC_TTS_OUTPUT_CHUNK_MS", "20")), 10)
        chunk_bytes = max(sample_rate * SAMPLE_WIDTH_BYTES * chunk_ms // 1000, SAMPLE_WIDTH_BYTES)
        output_cancelled = False
        stream_started = False
        tts_meta: dict[str, Any] = {
            "engine": "kokoro",
            "voice": DEFAULT_KOKORO_VOICE,
            "model": DEFAULT_KOKORO_MODEL,
            "format": "pcm_s16le",
            "providerStream": True,
            "streamId": context_id,
            "chunkMs": chunk_ms,
            "chunkBytes": chunk_bytes,
        }

        async def close_zero_audio_lifecycle(reason: str) -> None:
            if not stream_started or self.session.output_stream_chunk_count > 0:
                return
            with contextlib.suppress(Exception):
                await self.push_frame(TTSStoppedFrame(context_id=context_id), FrameDirection.DOWNSTREAM)
            if self.session.turn_controls:
                with contextlib.suppress(Exception):
                    await self.session.turn_controls.bot_stopped()
            self.session.record_stage(
                "tts.lifecycle_closed",
                ok=False,
                error=reason,
                streamId=context_id,
                audioBytesEnqueued=0,
                outputGeneration=self.session.output_generation,
            )

        try:
            async for audio_chunk, sample_rate, chunk_meta in self.session.stream_synthesize(frame, chunk_bytes=chunk_bytes):
                if turn_output_generation != self.session.output_generation:
                    output_cancelled = True
                    break
                if not stream_started:
                    stream_started = True
                    self.session.begin_output_stream(stream_id=context_id)
                    if self.session.turn_controls:
                        await self.session.turn_controls.bot_started()
                    tts_meta = {**tts_meta, **chunk_meta}
                    self.session.record_stage("tts.stream_started", tts=tts_meta)
                    await self.push_frame(TTSStartedFrame(context_id=context_id), FrameDirection.DOWNSTREAM)
                if self.session.pending_caller_turn_commit:
                    # Prepare a reversible FlowManager transition before caller
                    # audio. It becomes final only after the first PCM frame is
                    # observable downstream and ACC accepts the delivery ack.
                    await self.session.prepare_pending_caller_turn_delivery(
                        expected_agent_text=frame.text,
                        output_generation=turn_output_generation,
                    )
                output_window = self.session.extend_output_window(audio_bytes=len(audio_chunk), sample_rate=sample_rate)
                audio_frame = TTSAudioRawFrame(audio=audio_chunk,
                    sample_rate=sample_rate,
                    num_channels=1,
                    context_id=context_id,
                )
                await self.push_frame(audio_frame, FrameDirection.DOWNSTREAM)
                self.session.record_agent_track(
                    audio_chunk,
                    sample_rate=sample_rate,
                    event_id=f"agent-frame-{self.session.output_stream_chunk_count + 1}",
                )
                self.session.record_stage(
                    "tts.audio_chunk",
                    streamId=context_id,
                    chunkIndex=self.session.output_stream_chunk_count + 1,
                    audioBytes=len(audio_chunk),
                    sampleRate=sample_rate,
                    outputGeneration=turn_output_generation,
                )
                self.session.record_output_chunk(len(audio_chunk))
                if self.session.pending_caller_turn_commit:
                    await self.session.commit_pending_caller_turn_delivery(
                        expected_agent_text=frame.text,
                        output_generation=turn_output_generation,
                    )
                tts_meta = {**tts_meta, **chunk_meta, "outputWindow": output_window}
                chunk_yield_ms = max(float(os.environ.get("ACC_TTS_OUTPUT_CHUNK_YIELD_MS", "0")), 0.0)
                await asyncio.sleep(chunk_yield_ms / 1000)
            if output_cancelled:
                self.session.record_stage(
                    "tts.stream_cancelled",
                    ok=False,
                    error="output_cancelled",
                    streamId=context_id,
                    chunkCount=self.session.output_stream_chunk_count,
                    audioBytesEnqueued=self.session.output_stream_audio_bytes,
                    outputGeneration=self.session.output_generation,
                )
                return
            if not stream_started:
                raise RuntimeError("Kokoro streaming response produced no PCM audio")
            await self.push_frame(TTSStoppedFrame(context_id=context_id), FrameDirection.DOWNSTREAM)
            self.session.record_stage(
                "tts.stream_completed",
                streamId=context_id,
                chunkCount=self.session.output_stream_chunk_count,
                audioBytesEnqueued=self.session.output_stream_audio_bytes,
                outputGeneration=self.session.output_generation,
            )
            self.session.last_evidence = {
                **self.session.last_evidence,
                "ok": True,
                "tts": {
                    **tts_meta,
                    "audioBytesEnqueued": self.session.output_stream_audio_bytes,
                    "chunksEnqueued": self.session.output_stream_chunk_count,
                    "streamCompleted": True,
                },
                "outputCancelled": False,
            }
            track_recordings = self.session.write_track_recording_manifest("tts.stream_completed")
            if track_recordings:
                self.session.last_evidence = {**self.session.last_evidence, "trackRecordings": track_recordings}
            print(json.dumps({"type": "browser_webrtc_turn", **self.session.last_evidence}), flush=True)
        except asyncio.CancelledError:
            await self.session.rollback_pending_caller_turn_delivery("pipecat_interruption_before_delivery_ack")
            await close_zero_audio_lifecycle("pipecat_interruption_before_audio")
            self.session.record_stage(
                "tts.stream_cancelled",
                ok=False,
                error="pipecat_interruption",
                streamId=context_id,
                chunkCount=self.session.output_stream_chunk_count,
                audioBytesEnqueued=self.session.output_stream_audio_bytes,
                outputGeneration=self.session.output_generation,
            )
            raise
        except CallerTurnDeliveryCommitError as exc:
            await close_zero_audio_lifecycle("flowmanager_delivery_ack_failed_closed")
            self.session.last_evidence = {
                **self.session.last_evidence,
                "ok": False,
                "error": "flowmanager_delivery_ack_failed_closed",
                "detail": str(exc),
                "outputCancelled": True,
            }
            self.session.record_stage(
                "tts.output_aborted",
                ok=False,
                error="flowmanager_delivery_ack_failed_closed",
                detail=str(exc),
                agentText=frame.text,
            )
        except Exception as exc:
            self.session.last_evidence = {
                **self.session.last_evidence,
                "ok": False,
                "error": "tts_synthesis_failed",
                "detail": str(exc),
            }
            self.session.record_stage("tts.failed", ok=False, error="tts_synthesis_failed", detail=str(exc), agentText=frame.text)
        finally:
            self.session.clear_response_task("tts", tts_task)
            self.session.finish_output_stream()


ACC_VOICE_PIPELINE_CONTRACT = [
    "transport.input",
    "RtcAsrTurnProcessor",
    "AccCallerTurnProcessor",
    "KokoroTtsProcessor",
    "transport.output",
]


def build_acc_voice_pipeline(*, transport_input: Any, transport_output: Any, session: AccVoicePipelineSession) -> Pipeline:
    return Pipeline([
        transport_input,
        RtcAsrTurnProcessor(session),
        AccCallerTurnProcessor(session),
        KokoroTtsProcessor(session),
        transport_output,
    ])
