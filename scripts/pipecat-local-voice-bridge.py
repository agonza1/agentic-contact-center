#!/usr/bin/env python3
"""Local Pipecat voice bridge for the browser caller demo.

Browser audio stays on the existing WebSocket contract, while each media turn is
normalized into Pipecat frames and processed by Pipecat service adapters:

browser mic -> Pipecat InputAudioRawFrame -> rtc-asr STT -> ACC caller-turn -> Kokoro TTS -> browser playback
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"
LOCAL_NLTK_DATA = Path(os.environ.get("ACC_PIPECAT_NLTK_DATA", "/tmp/acc-pipecat-nltk-data"))
os.environ.setdefault("NLTK_DATA", str(LOCAL_NLTK_DATA))
LOCAL_NLTK_DATA.mkdir(parents=True, exist_ok=True)
if LOCAL_RUNTIME_PATH.exists():
    sys.path.insert(0, str(LOCAL_RUNTIME_PATH))

try:
    import importlib.metadata

    import websockets
    from pipecat.frames.frames import InputAudioRawFrame, TextFrame, TranscriptionFrame, TTSAudioRawFrame
    from pipecat.services.stt_service import STTService
    from pipecat.services.tts_service import TTSService
except Exception as exc:  # pragma: no cover - local setup guard
    print(
        json.dumps(
            {
                "ok": False,
                "error": "pipecat_voice_runtime_import_failed",
                "detail": str(exc),
                "install": "python3 -m pip install --target .pipecat-runtime -r requirements-pipecat-voice.txt",
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
OUTPUT_SAMPLE_RATE = int(os.environ.get("KOKORO_OUTPUT_SAMPLE_RATE", "24000"))


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
    ffmpeg: ProbeResult
    stt_model: str
    stt_backend: str


@dataclass
class PipecatVoiceTurnResult:
    transcript: str
    stt_meta: dict[str, Any]
    agent_text: str
    audio_base64: str
    tts_meta: dict[str, Any]
    call: dict[str, Any]


def join_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def json_http(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def http_request(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> tuple[bytes, str, int]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content_type = response.headers.get("content-type", "application/octet-stream")
        return response.read(), content_type, response.status


def probe_json(url: str, service_id: str, timeout: float = 1.5) -> ProbeResult:
    started = time.perf_counter()
    try:
        payload = json_http("GET", url, timeout=timeout)
        response_ms = round((time.perf_counter() - started) * 1000)
        explicit_ok = bool(payload.get("ok", True)) if isinstance(payload, dict) else True
        ready = explicit_ok and str(payload.get("status", "ready")).lower() not in {"offline", "error", "failed"}
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


def probe_ffmpeg() -> ProbeResult:
    started = time.perf_counter()
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        return ProbeResult(
            id="ffmpeg",
            ok=False,
            status="offline",
            url="PATH",
            detail="ffmpeg is not available on PATH",
            error="not_found",
            response_ms=round((time.perf_counter() - started) * 1000),
        )
    try:
        completed = subprocess.run(
            [ffmpeg_path, "-version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
        first_line = completed.stdout.splitlines()[0] if completed.stdout else "ffmpeg available"
        return ProbeResult(
            id="ffmpeg",
            ok=True,
            status="ready",
            url=ffmpeg_path,
            detail="ffmpeg responded",
            metadata={"version": first_line},
            response_ms=round((time.perf_counter() - started) * 1000),
        )
    except Exception as exc:
        return ProbeResult(
            id="ffmpeg",
            ok=False,
            status="degraded",
            url=ffmpeg_path,
            detail="ffmpeg is installed but did not respond to -version",
            error=str(exc),
            response_ms=round((time.perf_counter() - started) * 1000),
        )


def pick_model_metadata(health: dict[str, Any], models_payload: dict[str, Any] | None) -> tuple[str, str]:
    env_model = os.environ.get("RTC_ASR_MODEL") or DEFAULT_RTC_ASR_MODEL
    backend = str(health.get("backend") or health.get("runtime") or health.get("device") or DEFAULT_RTC_ASR_BACKEND)
    health_model = health.get("model") or health.get("active_model") or health.get("default_model")
    models = []
    if isinstance(models_payload, dict):
        raw_models = models_payload.get("models") or models_payload.get("data") or []
        if isinstance(raw_models, list):
            models = [item for item in raw_models if isinstance(item, dict)]
    if env_model:
        return str(env_model), backend
    if health_model:
        return str(health_model), backend
    if models:
        def score(item: dict[str, Any]) -> tuple[int, float, str]:
            quality = float(item.get("wer") or item.get("error_rate") or 99)
            latency = float(item.get("rtf") or item.get("latency_ms") or item.get("elapsed_ms") or 999999)
            size = float(item.get("size_mb") or item.get("model_size_mb") or 999999)
            return (0 if quality <= 0.15 else 1, latency + size / 1000, str(item.get("id") or item.get("name") or ""))
        selected = sorted(models, key=score)[0]
        selected_backend = selected.get("backend") or selected.get("runtime") or backend
        return str(selected.get("id") or selected.get("name") or "unknown"), str(selected_backend)
    return "unknown", backend


def check_readiness(acc_url: str = DEFAULT_ACC_URL) -> BridgeReadiness:
    rtc_health_url = join_url(DEFAULT_RTC_ASR_BASE_URL, DEFAULT_RTC_ASR_HEALTH_PATH)
    kokoro_health_url = join_url(DEFAULT_KOKORO_BASE_URL, DEFAULT_KOKORO_HEALTH_PATH)
    acc_health_url = join_url(acc_url, "/health")
    rtc_probe = probe_json(rtc_health_url, "rtc-asr")
    kokoro_probe = probe_json(kokoro_health_url, "kokoro")
    acc_probe = probe_json(acc_health_url, "acc")
    ffmpeg_probe = probe_ffmpeg()
    models_payload = None
    if rtc_probe.ok:
        with contextlib.suppress(Exception):
            models_payload = json_http("GET", join_url(DEFAULT_RTC_ASR_BASE_URL, "/v1/models"), timeout=1.5)
    stt_model, stt_backend = pick_model_metadata(rtc_probe.metadata, models_payload)
    if models_payload:
        rtc_probe.metadata = {**rtc_probe.metadata, "models": models_payload.get("models") or models_payload.get("data")}
    ok = rtc_probe.ok and kokoro_probe.ok and acc_probe.ok and ffmpeg_probe.ok and stt_model != "unknown" and stt_backend != "unknown"
    blockers = [probe.detail for probe in (rtc_probe, kokoro_probe, acc_probe, ffmpeg_probe) if not probe.ok]
    if stt_model == "unknown" or stt_backend == "unknown":
        blockers.append("rtc-asr health or /v1/models did not expose model/backend metadata")
    status = "ready" if ok else "degraded" if any(probe.ok for probe in (rtc_probe, kokoro_probe, acc_probe, ffmpeg_probe)) else "offline"
    return BridgeReadiness(
        ok=ok,
        status=status,
        detail="ready" if ok else "; ".join(blockers),
        blockers=blockers,
        rtc_asr=rtc_probe,
        kokoro=kokoro_probe,
        acc=acc_probe,
        ffmpeg=ffmpeg_probe,
        stt_model=stt_model,
        stt_backend=stt_backend,
    )


def latest_agent_text(call: dict[str, Any]) -> str:
    transcript = call.get("transcript") if isinstance(call, dict) else None
    if not isinstance(transcript, list):
        return ""
    for turn in reversed(transcript):
        if isinstance(turn, dict) and turn.get("speaker") == "agent" and isinstance(turn.get("text"), str):
            return turn["text"]
    return ""


def is_low_information_transcript(text: str) -> bool:
    compact = re.sub(r"[^A-Za-z0-9]+", "", text)
    words = [word for word in re.split(r"\s+", text.strip()) if re.search(r"[A-Za-z0-9]", word)]
    return len(compact) <= 2 or not words or bool(re.fullmatch(r"[\s.]+", text))


def is_incomplete_transcript(text: str) -> bool:
    normalized = text.strip()
    return normalized.endswith("...") or normalized.endswith("…")


def run_ffmpeg(input_path: Path, output_path: Path, *extra_args: str) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(input_path), *extra_args, str(output_path)],
        check=True,
    )


def browser_audio_to_pcm_frame(input_bytes: bytes, suffix: str) -> InputAudioRawFrame:
    with tempfile.TemporaryDirectory(prefix="acc-voice-input-") as tmp:
        tmpdir = Path(tmp)
        source = tmpdir / f"caller{suffix or '.webm'}"
        raw = tmpdir / "caller-16k.pcm"
        source.write_bytes(input_bytes)
        run_ffmpeg(source, raw, "-ac", "1", "-ar", str(INPUT_SAMPLE_RATE), "-f", "s16le")
        return InputAudioRawFrame(audio=raw.read_bytes(), sample_rate=INPUT_SAMPLE_RATE, num_channels=1)


def wav_base64_from_pcm(pcm: bytes, sample_rate: int, channels: int = 1) -> str:
    with tempfile.TemporaryDirectory(prefix="acc-voice-output-") as tmp:
        wav_path = Path(tmp) / "agent.wav"
        with wave.open(str(wav_path), "wb") as wav_file:
            wav_file.setnchannels(channels)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(pcm)
        return base64.b64encode(wav_path.read_bytes()).decode("ascii")


def decode_audio_response(raw: bytes, content_type: str) -> tuple[bytes, str, int]:
    lowered = content_type.lower()
    if "json" in lowered:
        payload = json.loads(raw.decode("utf-8"))
        encoded = (
            payload.get("audio_base64")
            or payload.get("audioContent")
            or payload.get("audio")
            or payload.get("data")
        )
        if isinstance(encoded, dict):
            encoded = encoded.get("base64") or encoded.get("audio_base64")
        if not isinstance(encoded, str):
            raise RuntimeError("Kokoro JSON response did not include base64 audio")
        audio = base64.b64decode(encoded)
        sample_rate = int(payload.get("sample_rate") or payload.get("sampleRate") or OUTPUT_SAMPLE_RATE)
        response_format = str(payload.get("format") or payload.get("response_format") or "wav")
        return audio, response_format, sample_rate
    if raw.startswith(b"RIFF"):
        return raw, "wav", OUTPUT_SAMPLE_RATE
    return raw, "pcm", OUTPUT_SAMPLE_RATE


class RtcAsrPipecatSTTService(STTService):
    """Pipecat STT service adapter for rtc-asr Local STT v1."""

    def __init__(self, *, ws_url: str, model: str, backend: str):
        super().__init__(audio_passthrough=False, sample_rate=INPUT_SAMPLE_RATE)
        self.rtc_asr_ws_url = ws_url
        self.model = model
        self.backend = backend
        self.last_meta: dict[str, Any] = {}

    async def run_stt(self, audio: bytes):
        started = time.perf_counter()
        final_text = ""
        events: list[dict[str, Any]] = []
        async with websockets.connect(self.rtc_asr_ws_url, max_size=20 * 1024 * 1024) as ws:
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
                        "model": self.model if self.model != "unknown" else None,
                    }
                )
            )
            for offset in range(0, len(audio), 640):
                await ws.send(audio[offset : offset + 640])
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
        self.last_meta = {
            "engine": "rtc-asr",
            "model": self.model,
            "backend": self.backend,
            "elapsedMs": elapsed_ms,
            "audioBytes": len(audio),
            "eventCount": len(events),
        }
        yield TranscriptionFrame(final_text.strip(), user_id="browser", timestamp=str(time.time()), result={"events": events}, finalized=True)

    async def transcribe_frame(self, frame: InputAudioRawFrame) -> tuple[str, dict[str, Any], TranscriptionFrame]:
        result_frame: TranscriptionFrame | None = None
        async for output in self.run_stt(frame.audio):
            if isinstance(output, TranscriptionFrame):
                result_frame = output
        if result_frame is None:
            result_frame = TranscriptionFrame("", user_id="browser", timestamp=str(time.time()), finalized=True)
        return result_frame.text.strip(), self.last_meta, result_frame


class KokoroPipecatHttpTTSService(TTSService):
    """Pipecat TTS service adapter for an already-running Kokoro HTTP sidecar."""

    def __init__(self, *, base_url: str, tts_path: str, voice: str, model: str):
        super().__init__(sample_rate=OUTPUT_SAMPLE_RATE)
        self.base_url = base_url.rstrip("/")
        self.tts_path = tts_path
        self.voice = voice
        self.model = model
        self.last_meta: dict[str, Any] = {}

    async def run_tts(self, text: str, context_id: str):
        started = time.perf_counter()
        payload = {
            "model": self.model,
            "voice": self.voice,
            "input": text,
            "response_format": "wav",
            "sample_rate": OUTPUT_SAMPLE_RATE,
        }
        raw, content_type, _status = await asyncio.to_thread(
            http_request,
            "POST",
            join_url(self.base_url, self.tts_path),
            payload,
            30,
        )
        audio, response_format, sample_rate = decode_audio_response(raw, content_type)
        if response_format == "wav" or audio.startswith(b"RIFF"):
            with tempfile.TemporaryDirectory(prefix="acc-kokoro-wav-") as tmp:
                wav_path = Path(tmp) / "agent.wav"
                pcm_path = Path(tmp) / "agent.pcm"
                wav_path.write_bytes(audio)
                run_ffmpeg(wav_path, pcm_path, "-ac", "1", "-ar", str(OUTPUT_SAMPLE_RATE), "-f", "s16le")
                pcm = pcm_path.read_bytes()
                sample_rate = OUTPUT_SAMPLE_RATE
        else:
            pcm = audio
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        self.last_meta = {
            "engine": "kokoro",
            "voice": self.voice,
            "model": self.model,
            "pipecatService": "Kokoro HTTP TTS adapter",
            "elapsedMs": elapsed_ms,
            "audioBytes": len(pcm),
            "sampleRate": sample_rate,
            "format": "wav",
        }
        yield TTSAudioRawFrame(audio=pcm, sample_rate=sample_rate, num_channels=1, context_id=context_id)

    async def synthesize_text_frame(self, frame: TextFrame) -> tuple[str, dict[str, Any]]:
        context_id = str(uuid4())
        chunks: list[bytes] = []
        sample_rate = OUTPUT_SAMPLE_RATE
        async for output in self.run_tts(frame.text, context_id):
            if isinstance(output, TTSAudioRawFrame):
                chunks.append(output.audio)
                sample_rate = output.sample_rate
        return wav_base64_from_pcm(b"".join(chunks), sample_rate), self.last_meta


def transcript_text_from_event(event: dict[str, Any]) -> str:
    candidates = [
        event.get("transcript"),
        event.get("text"),
        event.get("delta"),
        event.get("result", {}).get("text") if isinstance(event.get("result"), dict) else None,
        event.get("result", {}).get("transcript") if isinstance(event.get("result"), dict) else None,
    ]
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


class PipecatVoiceTurnPipeline:
    """Turn pipeline that keeps media handoffs in Pipecat frames and services."""

    def __init__(self, *, acc_url: str, call_id: str, stt_model: str, stt_backend: str):
        self.acc_url = acc_url.rstrip("/")
        self.call_id = call_id
        self.stt = RtcAsrPipecatSTTService(ws_url=DEFAULT_RTC_ASR_WS_URL, model=stt_model, backend=stt_backend)
        self.tts = KokoroPipecatHttpTTSService(
            base_url=DEFAULT_KOKORO_BASE_URL,
            tts_path=DEFAULT_KOKORO_SPEECH_PATH,
            voice=DEFAULT_KOKORO_VOICE,
            model=DEFAULT_KOKORO_MODEL,
        )

    async def run_turn(self, audio_bytes: bytes, suffix: str = ".webm") -> PipecatVoiceTurnResult:
        input_frame = await asyncio.to_thread(browser_audio_to_pcm_frame, audio_bytes, suffix)
        transcript, stt_meta, _transcription_frame = await self.stt.transcribe_frame(input_frame)
        if not transcript or is_low_information_transcript(transcript):
            raise ValueError(json.dumps({"error": "low_information_transcript", "callerTranscript": transcript, "stt": stt_meta}))
        if is_incomplete_transcript(transcript):
            raise ValueError(json.dumps({"error": "incomplete_transcript_retry", "callerTranscript": transcript, "stt": stt_meta}))
        call = await asyncio.to_thread(
            json_http,
            "POST",
            f"{self.acc_url}/api/calls/{self.call_id}/caller-turn",
            {"text": transcript, "conversationMode": "free_caller"},
        )
        agent_text = latest_agent_text(call)
        audio_base64 = ""
        tts_meta: dict[str, Any] = {"engine": "kokoro", "voice": DEFAULT_KOKORO_VOICE, "skipped": True}
        if agent_text:
            audio_base64, tts_meta = await self.tts.synthesize_text_frame(TextFrame(agent_text))
        return PipecatVoiceTurnResult(
            transcript=transcript,
            stt_meta=stt_meta,
            agent_text=agent_text,
            audio_base64=audio_base64,
            tts_meta=tts_meta,
            call=call,
        )


def ready_payload(readiness: BridgeReadiness) -> dict[str, Any]:
    pipecat_version = importlib.metadata.version("pipecat-ai")
    review_status = "ready_for_voice_turn" if readiness.ok else "blocked_by_local_sidecars"
    return {
        "type": "ready",
        "ok": readiness.ok,
        "status": readiness.status,
        "detail": readiness.detail,
        "blockers": readiness.blockers,
        "nextAction": "open a browser voice turn" if readiness.ok else "start rtc-asr, Kokoro, ACC, and ffmpeg locally, then rerun npm run pipecat:voice:check",
        "reviewGate": {
            "status": review_status,
            "ready": readiness.ok,
            "blockerCount": len(readiness.blockers),
            "requiredServices": {
                "rtcAsr": readiness.rtc_asr.ok,
                "kokoro": readiness.kokoro.ok,
                "acc": readiness.acc.ok,
                "ffmpeg": readiness.ffmpeg.ok,
            },
            "verificationCommand": "npm run pipecat:voice:check",
        },
        "pipecat": {
            "runtimeMode": "pipecat_local_voice_bridge",
            "runtimeEngine": "pipecat-ai",
            "pipecatVersion": pipecat_version,
            "mediaFlow": "InputAudioRawFrame -> rtc-asr STTService -> ACC TextFrame -> Kokoro TTSService -> TTSAudioRawFrame",
        },
        "stt": {
            "engine": "rtc-asr",
            "wsUrl": DEFAULT_RTC_ASR_WS_URL,
            "model": readiness.stt_model,
            "backend": readiness.stt_backend,
            "sidecar": readiness.rtc_asr.__dict__,
        },
        "tts": {
            "engine": "kokoro",
            "baseUrl": DEFAULT_KOKORO_BASE_URL,
            "voice": DEFAULT_KOKORO_VOICE,
            "model": DEFAULT_KOKORO_MODEL,
            "pipecatService": "Kokoro HTTP TTS adapter",
            "sidecar": readiness.kokoro.__dict__,
        },
        "acc": readiness.acc.__dict__,
        "localAudio": {
            "ffmpeg": readiness.ffmpeg.__dict__,
        },
    }


async def send_json(websocket: websockets.WebSocketServerProtocol, payload: dict[str, Any]) -> None:
    await websocket.send(json.dumps(payload))


async def handle_client(websocket: websockets.WebSocketServerProtocol) -> None:
    call_id: str | None = None
    acc_url = DEFAULT_ACC_URL.rstrip("/")
    readiness = await asyncio.to_thread(check_readiness, acc_url)
    await send_json(websocket, ready_payload(readiness))

    async for message in websocket:
        if isinstance(message, str):
            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                await send_json(websocket, {"type": "error", "error": "json_invalid"})
                continue

            if payload.get("type") == "start":
                acc_url = str(payload.get("accUrl") or DEFAULT_ACC_URL).rstrip("/")
                readiness = await asyncio.to_thread(check_readiness, acc_url)
                if not readiness.ok:
                    await send_json(websocket, {"type": "started", "ok": False, "error": "sidecar_unavailable", "ready": ready_payload(readiness)})
                    continue
                call_id = payload.get("callId") if isinstance(payload.get("callId"), str) else None
                if not call_id:
                    started = json_http("POST", f"{acc_url}/api/demo/start", {"openclawSessionLabel": "pipecat-local-voice"})
                    call_id = started["session"]["callId"]
                await send_json(websocket, {"type": "started", "ok": True, "callId": call_id, "accUrl": acc_url})
                continue

            if payload.get("type") == "stop":
                await send_json(websocket, {"type": "stopped", "ok": True, "callId": call_id})
                continue

            await send_json(websocket, {"type": "error", "error": "message_type_unsupported"})
            continue

        if not call_id:
            await send_json(websocket, {"type": "error", "error": "voice_call_not_started"})
            continue
        if not readiness.ok:
            await send_json(websocket, {"type": "error", "error": "sidecar_unavailable", "ready": ready_payload(readiness)})
            continue

        try:
            pipeline = PipecatVoiceTurnPipeline(
                acc_url=acc_url,
                call_id=call_id,
                stt_model=readiness.stt_model,
                stt_backend=readiness.stt_backend,
            )
            result = await pipeline.run_turn(message, ".webm")
            await send_json(
                websocket,
                {
                    "type": "turn",
                    "ok": True,
                    "callId": call_id,
                    "callerTranscript": result.transcript,
                    "agentText": result.agent_text,
                    "agentAudio": {
                        "contentType": "audio/wav",
                        "base64": result.audio_base64,
                    },
                    "call": result.call,
                    "evidence": {
                        "pipecatRuntime": "pipecat_local_voice_bridge",
                        "mediaFlow": "pipecat_frames",
                        "stt": result.stt_meta,
                        "tts": result.tts_meta,
                    },
                },
            )
        except ValueError as exc:
            with contextlib.suppress(Exception):
                detail = json.loads(str(exc))
                await send_json(websocket, {"type": "turn", "ok": False, **detail})
                continue
            await send_json(websocket, {"type": "error", "error": "voice_turn_rejected", "detail": str(exc)})
        except subprocess.CalledProcessError as exc:
            await send_json(websocket, {"type": "error", "error": "local_audio_command_failed", "detail": str(exc)})
        except urllib.error.URLError as exc:
            await send_json(websocket, {"type": "error", "error": "acc_or_kokoro_api_unavailable", "detail": str(exc)})
        except Exception as exc:  # pragma: no cover - defensive local bridge reporting
            await send_json(websocket, {"type": "error", "error": "voice_turn_failed", "detail": str(exc)})


async def run_server(host: str, port: int) -> None:
    async with websockets.serve(handle_client, host, port, max_size=20 * 1024 * 1024):
        readiness = await asyncio.to_thread(check_readiness, DEFAULT_ACC_URL)
        print(json.dumps({"ok": readiness.ok, "wsUrl": f"ws://{host}:{port}", "stt": ready_payload(readiness)["stt"], "tts": ready_payload(readiness)["tts"], "detail": readiness.detail}), flush=True)
        await asyncio.Future()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--check-sidecars", action="store_true")
    args = parser.parse_args()
    if args.check_sidecars:
        readiness = check_readiness(DEFAULT_ACC_URL)
        print(json.dumps(ready_payload(readiness), indent=2))
        return 0 if readiness.ok else 2
    asyncio.run(run_server(args.host, args.port))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
