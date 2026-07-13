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
import base64
import contextlib
import json
import os
import sys
import time
import urllib.request
import wave
from dataclasses import dataclass, field
from datetime import UTC, datetime
from fractions import Fraction
from io import BytesIO
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
    import importlib.metadata

    import audioop

    import av
    import websockets
    from aiohttp import web
    from av.audio.resampler import AudioResampler
    from pipecat.frames.frames import InputAudioRawFrame, OutputAudioRawFrame, TextFrame, TranscriptionFrame, TTSAudioRawFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
    from pipecat.transports.base_transport import TransportParams
    from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequest, SmallWebRTCRequestHandler
    from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
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


class BrowserTurnSession:
    def __init__(self, *, acc_url: str, call_id: str, readiness: BridgeReadiness):
        self.acc_url = acc_url.rstrip("/")
        self.call_id = call_id
        self.readiness = readiness
        self.turn_count = 0
        self.output_generation = 0
        self.last_barge_in_evidence: dict[str, Any] = {}
        self.last_evidence: dict[str, Any] = {}
        self.last_audio_evidence: dict[str, Any] = {}
        self.last_stt_evidence: dict[str, Any] = {}
        self.last_acc_evidence: dict[str, Any] = {}
        self.last_tts_evidence: dict[str, Any] = {}
        self.last_error: dict[str, Any] = {}
        self.stage_events: list[dict[str, Any]] = []

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

    def cancel_output(self, reason: str = "barge-in") -> dict[str, Any]:
        self.output_generation += 1
        self.last_barge_in_evidence = {
            "reason": reason,
            "outputGeneration": self.output_generation,
            "timestamp": datetime.now(UTC).isoformat(timespec="milliseconds"),
        }
        print(json.dumps({"type": "browser_webrtc_output_cancelled", **self.last_barge_in_evidence}), flush=True)
        return self.last_barge_in_evidence

    async def transcribe(self, frame: InputAudioRawFrame) -> tuple[str, dict[str, Any], TranscriptionFrame]:
        started = time.perf_counter()
        final_text = ""
        events: list[dict[str, Any]] = []
        async with websockets.connect(DEFAULT_RTC_ASR_WS_URL, max_size=20 * 1024 * 1024) as ws:
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
            for offset in range(0, len(frame.audio), 640):
                await ws.send(frame.audio[offset : offset + 640])
            await ws.send(json.dumps({"type": "finalize"}))
            deadline = time.monotonic() + float(os.environ.get("RTC_ASR_FINAL_TIMEOUT_SEC", "12"))
            while time.monotonic() < deadline:
                message = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic()))
                if not isinstance(message, str):
                    continue
                event = json.loads(message)
                if isinstance(event, dict):
                    events.append(event)
                    candidate = transcript_text_from_event(event)
                    if candidate:
                        final_text = candidate
                    if is_final_stt_event(event):
                        break
            with contextlib.suppress(Exception):
                await ws.send(json.dumps({"type": "close"}))
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        meta = {
            "engine": "rtc-asr",
            "contract": "local-stt.v1",
            "model": self.readiness.stt_model,
            "backend": self.readiness.stt_backend,
            "elapsedMs": elapsed_ms,
            "audioBytes": len(frame.audio),
            "eventCount": len(events),
        }
        result_frame = TranscriptionFrame(final_text.strip(), user_id="browser", timestamp=str(time.time()), result={"events": events}, finalized=True)
        return result_frame.text.strip(), meta, result_frame

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


class RtcAsrTurnProcessor(FrameProcessor):
    def __init__(self, session: BrowserTurnSession):
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
                collectedMs=round(sum(len(chunk) for chunk in self.speech_chunks) / (INPUT_SAMPLE_RATE * SAMPLE_WIDTH_BYTES) * 1000),
            )
        if rms > self.silence_rms:
            if not self.in_speech:
                self.session.cancel_output("barge-in")
                self.turn_started_at = now
                self.session.record_stage("audio.speech_started", rms=rms, silenceThresholdRms=self.silence_rms)
            self.in_speech = True
            self.last_voice_at = now
        if self.in_speech:
            self.speech_chunks.append(pcm)
        collected_ms = round(sum(len(chunk) for chunk in self.speech_chunks) / (INPUT_SAMPLE_RATE * SAMPLE_WIDTH_BYTES) * 1000)
        silence_elapsed_ms = round((now - self.last_voice_at) * 1000)
        max_elapsed_ms = round((now - self.turn_started_at) * 1000)
        should_finalize = self.in_speech and collected_ms >= self.min_turn_ms and (silence_elapsed_ms >= self.silence_ms or max_elapsed_ms >= self.max_turn_ms)
        if not should_finalize:
            return
        pcm_turn = b"".join(self.speech_chunks)
        self.speech_chunks = []
        self.in_speech = False
        self.turn_started_at = now
        self.last_voice_at = now
        self.session.record_stage(
            "stt.finalize_started",
            audioBytes=len(pcm_turn),
            collectedMs=collected_ms,
            silenceElapsedMs=silence_elapsed_ms,
            maxElapsedMs=max_elapsed_ms,
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
        await self.push_frame(transcription_frame, FrameDirection.DOWNSTREAM)


class AccCallerTurnProcessor(FrameProcessor):
    def __init__(self, session: BrowserTurnSession):
        super().__init__(name="acc-caller-turn-processor")
        self.session = session

    async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM or not isinstance(frame, TranscriptionFrame):
            await self.push_frame(frame, direction)
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
    def __init__(self, session: BrowserTurnSession):
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

    async def start_pipeline(self, *, connection: Any, session_id: str, acc_url: str, call_id: str, readiness: BridgeReadiness) -> BrowserTurnSession:
        session = BrowserTurnSession(acc_url=acc_url, call_id=call_id, readiness=readiness)
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
        pipeline = Pipeline([
            transport.input(),
            RtcAsrTurnProcessor(session),
            AccCallerTurnProcessor(session),
            KokoroTtsProcessor(session),
            transport.output(),
        ])
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
                "pipeline": ["transport.input", "RtcAsrTurnProcessor", "AccCallerTurnProcessor", "KokoroTtsProcessor", "transport.output"],
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
        evidence = turn_session.last_evidence if isinstance(turn_session, BrowserTurnSession) else {}
        runner_task = session.get("runnerTask")
        runner_done = isinstance(runner_task, asyncio.Task) and runner_task.done()
        return web.json_response(
            {
                "ok": True,
                "sessionId": session_id,
                "callId": session.get("callId"),
                "startedAt": session.get("startedAt"),
                "transport": "SmallWebRTCTransport",
                "pipeline": ["transport.input", "rtc-asr STT", "ACC caller-turn adapter", "Kokoro TTS", "transport.output"],
                "turnEvidence": evidence,
                "turnCount": turn_session.turn_count if isinstance(turn_session, BrowserTurnSession) else 0,
                "runnerDone": runner_done,
                "lastAudio": turn_session.last_audio_evidence if isinstance(turn_session, BrowserTurnSession) else {},
                "lastStt": turn_session.last_stt_evidence if isinstance(turn_session, BrowserTurnSession) else {},
                "lastAcc": turn_session.last_acc_evidence if isinstance(turn_session, BrowserTurnSession) else {},
                "lastTts": turn_session.last_tts_evidence if isinstance(turn_session, BrowserTurnSession) else {},
                "lastError": turn_session.last_error if isinstance(turn_session, BrowserTurnSession) else {},
                "stageEvents": turn_session.stage_events if isinstance(turn_session, BrowserTurnSession) else [],
                "bargeInEvidence": turn_session.last_barge_in_evidence if isinstance(turn_session, BrowserTurnSession) else {},
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
