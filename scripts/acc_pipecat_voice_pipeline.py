#!/usr/bin/env python3
"""Shared Pipecat STT -> ACC -> TTS pipeline processors.

Transport adapters, such as browser SmallWebRTC or future SIP/fixture adapters,
should create their own transport and call build_acc_voice_pipeline() with the
transport input/output processors.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import importlib.metadata
import json
import os
import time
import urllib.request
import wave
from dataclasses import dataclass, field
from datetime import UTC, datetime
from io import BytesIO
from typing import Any
from uuid import uuid4

import audioop
import websockets
from pipecat.audio.turn.base_turn_analyzer import EndOfTurnState
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.frames.frames import BotStartedSpeakingFrame, BotStoppedSpeakingFrame, InputAudioRawFrame, InterruptionFrame, OutputAudioRawFrame, TextFrame, TranscriptionFrame, TTSAudioRawFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_start import MinWordsUserTurnStartStrategy

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


def http_request(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> tuple[bytes, str, int]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.headers.get("content-type", "application/octet-stream"), response.status


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


def pcm16_to_wav_base64(pcm: bytes, sample_rate: int, channels: int = 1) -> str:
    buffer = BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(SAMPLE_WIDTH_BYTES)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def decode_kokoro_audio(raw: bytes, content_type: str) -> tuple[bytes, int, str]:
    lowered = content_type.lower()
    if "json" in lowered:
        payload = json.loads(raw.decode("utf-8"))
        encoded = payload.get("audio_base64") or payload.get("audioContent") or payload.get("audio") or payload.get("data")
        if isinstance(encoded, dict):
            encoded = encoded.get("base64") or encoded.get("audio_base64")
        if not isinstance(encoded, str):
            raise RuntimeError("Kokoro JSON response did not include base64 audio")
        audio = base64.b64decode(encoded)
        sample_rate = int(payload.get("sample_rate") or payload.get("sampleRate") or 24000)
        response_format = str(payload.get("format") or payload.get("response_format") or "wav")
        if response_format == "wav" or audio.startswith(b"RIFF"):
            return wav_to_pcm(audio)
        return audio, sample_rate, response_format
    if raw.startswith(b"RIFF"):
        return wav_to_pcm(raw)
    return raw, int(os.environ.get("KOKORO_OUTPUT_SAMPLE_RATE", "24000")), "pcm_s16le"


def wav_to_pcm(raw: bytes) -> tuple[bytes, int, str]:
    with wave.open(BytesIO(raw), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        pcm = wav_file.readframes(wav_file.getnframes())
    if sample_width != SAMPLE_WIDTH_BYTES:
        pcm = audioop.lin2lin(pcm, sample_width, SAMPLE_WIDTH_BYTES)
    if channels > 1:
        pcm = audioop.tomono(pcm, SAMPLE_WIDTH_BYTES, 1.0 / channels, 1.0 / channels)
    return pcm, sample_rate, "wav"


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
    def __init__(self, *, acc_url: str, call_id: str, readiness: BridgeReadiness):
        self.acc_url = acc_url.rstrip("/")
        self.call_id = call_id
        self.readiness = readiness
        self.turn_count = 0
        self.output_generation = 0
        self.output_active_until = 0.0
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

    def record_stage(self, stage: str, *, ok: bool = True, **detail: Any) -> dict[str, Any]:
        event = {
            "stage": stage,
            "ok": ok,
            "callId": self.call_id,
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
        return event

    def mark_output_active(self, *, audio_bytes: int, sample_rate: int, channels: int = 1) -> dict[str, Any]:
        duration_s = audio_bytes / max(sample_rate * SAMPLE_WIDTH_BYTES * channels, 1)
        self.output_active_until = max(self.output_active_until, time.monotonic() + duration_s + 0.5)
        return {
            "audioBytes": audio_bytes,
            "sampleRate": sample_rate,
            "channels": channels,
            "estimatedDurationMs": round(duration_s * 1000),
            "activeUntilMonotonicMs": round(self.output_active_until * 1000),
        }

    def cancel_output(self, reason: str = "barge-in") -> dict[str, Any]:
        if time.monotonic() > self.output_active_until:
            self.last_barge_in_evidence = {
                "reason": reason,
                "skipped": True,
                "skipReason": "no_active_output_audio",
                "outputGeneration": self.output_generation,
                "timestamp": datetime.now(UTC).isoformat(timespec="milliseconds"),
            }
            print(json.dumps({"type": "browser_webrtc_output_cancel_skipped", **self.last_barge_in_evidence}), flush=True)
            return self.last_barge_in_evidence
        self.output_generation += 1
        self.last_barge_in_evidence = {
            "reason": reason,
            "skipped": False,
            "pipecatInterruptionFrame": "pending",
            "outputGeneration": self.output_generation,
            "timestamp": datetime.now(UTC).isoformat(timespec="milliseconds"),
        }
        print(json.dumps({"type": "browser_webrtc_output_cancelled", **self.last_barge_in_evidence}), flush=True)
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

    async def synthesize(self, frame: TextFrame) -> tuple[bytes, int, dict[str, Any]]:
        started = time.perf_counter()
        payload = {
            "model": DEFAULT_KOKORO_MODEL,
            "voice": DEFAULT_KOKORO_VOICE,
            "input": frame.text,
            "response_format": "wav",
        }
        raw, content_type, _status = await asyncio.to_thread(
            http_request,
            "POST",
            join_url(DEFAULT_KOKORO_BASE_URL, DEFAULT_KOKORO_SPEECH_PATH),
            payload,
            30,
        )
        pcm, sample_rate, response_format = decode_kokoro_audio(raw, content_type)
        output_frame = TTSAudioRawFrame(audio=pcm, sample_rate=sample_rate, num_channels=1, context_id=str(uuid4()))
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        meta = {
            "engine": "kokoro",
            "voice": DEFAULT_KOKORO_VOICE,
            "model": DEFAULT_KOKORO_MODEL,
            "elapsedMs": elapsed_ms,
            "audioBytes": len(output_frame.audio),
            "sampleRate": output_frame.sample_rate,
            "format": response_format,
            "audioSha256AvailableInBrowserProof": False,
        }
        return output_frame.audio, output_frame.sample_rate, meta


class PipecatTurnControls:
    """Use Pipecat's turn primitives while keeping the external rtc-asr boundary."""

    def __init__(self, session: AccVoicePipelineSession, interrupt_output: Any):
        self.session = session
        self.interrupt_output = interrupt_output
        self.min_words = int(os.environ.get("ACC_WEBRTC_BARGE_IN_MIN_WORDS", "2"))
        self.start_strategy = MinWordsUserTurnStartStrategy(min_words=self.min_words, use_interim=False)
        self.start_strategy.add_event_handler("on_user_turn_started", self._on_user_turn_started)
        self.smart_turn = LocalSmartTurnAnalyzerV3(sample_rate=INPUT_SAMPLE_RATE)
        self.bot_speaking = False

    async def bot_started(self) -> None:
        if self.bot_speaking:
            return
        self.bot_speaking = True
        await self.start_strategy.process_frame(BotStartedSpeakingFrame())

    async def sync_bot_state(self) -> None:
        if self.bot_speaking and time.monotonic() > self.session.output_active_until:
            self.bot_speaking = False
            await self.start_strategy.process_frame(BotStoppedSpeakingFrame())

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
        self.session.last_barge_in_evidence = {
            **self.session.last_barge_in_evidence,
            "pipecatInterruptionFrame": "broadcast",
        }

    async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM or not isinstance(frame, InputAudioRawFrame):
            await self.push_frame(frame, direction)
            return
        pcm = frame.audio
        if not pcm:
            return
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
            if not self.in_speech:
                self.turn_started_at = now
                self.session.record_stage("audio.speech_started", rms=rms, silenceThresholdRms=self.silence_rms)
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
        try:
            call = await asyncio.to_thread(
                json_http,
                "POST",
                f"{self.session.acc_url}/api/calls/{self.session.call_id}/caller-turn",
                {"text": frame.text, "conversationMode": "free_caller"},
            )
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
        agent_text = latest_agent_text(call)
        self.session.turn_count += 1
        self.session.record_stage(
            "acc.caller_turn_completed",
            turn=self.session.turn_count,
            callerTranscript=frame.text,
            agentText=agent_text,
            agentTextAvailable=bool(agent_text),
            flowState=call.get("flowState") if isinstance(call, dict) else None,
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
        }
        if agent_text:
            await self.push_frame(TextFrame(agent_text), FrameDirection.DOWNSTREAM)
        else:
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
        try:
            pcm, sample_rate, tts_meta = await self.session.synthesize(frame)
        except Exception as exc:
            self.session.last_evidence = {
                **self.session.last_evidence,
                "ok": False,
                "error": "tts_synthesis_failed",
                "detail": str(exc),
            }
            self.session.record_stage("tts.failed", ok=False, error="tts_synthesis_failed", detail=str(exc), agentText=frame.text)
            return
        output_cancelled = turn_output_generation != self.session.output_generation
        if output_cancelled:
            tts_meta = {**tts_meta, "cancelled": True, "cancelReason": "barge-in", "audioBytesEnqueued": 0}
            self.session.record_stage("tts.cancelled", ok=False, error="output_cancelled", tts=tts_meta)
        else:
            output_window = self.session.mark_output_active(audio_bytes=len(pcm), sample_rate=sample_rate)
            if self.session.turn_controls:
                await self.session.turn_controls.bot_started()
            tts_meta = {**tts_meta, "outputWindow": output_window}
            self.session.record_stage("tts.audio_ready", tts=tts_meta)
        self.session.last_evidence = {
            **self.session.last_evidence,
            "ok": not output_cancelled,
            "tts": tts_meta,
            "outputCancelled": output_cancelled,
        }
        print(json.dumps({"type": "browser_webrtc_turn", **self.session.last_evidence}), flush=True)
        if not output_cancelled:
            await self.push_frame(OutputAudioRawFrame(audio=pcm, sample_rate=sample_rate, num_channels=1), FrameDirection.DOWNSTREAM)


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
