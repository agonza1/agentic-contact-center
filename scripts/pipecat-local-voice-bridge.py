#!/usr/bin/env python3
"""Local Pipecat voice bridge for the browser caller demo.

This is intentionally local-only:
- Browser sends recorded microphone audio over WebSocket.
- MLX Whisper transcribes locally.
- The existing ACC HTTP API advances the call flow.
- macOS `say` synthesizes the latest agent response locally.

It imports Pipecat and reports Pipecat runtime metadata in each session event,
while the local STT/TTS engines stay explicit and auditable.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"
if LOCAL_RUNTIME_PATH.exists():
    sys.path.insert(0, str(LOCAL_RUNTIME_PATH))

try:
    import importlib.metadata

    import pipecat  # noqa: F401
    import websockets
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

DEFAULT_STT_MODEL = os.environ.get("ACC_LOCAL_STT_MODEL", "mlx-community/whisper-tiny.en-mlx")
DEFAULT_ACC_URL = os.environ.get("ACC_URL", "http://127.0.0.1:8026")


def json_http(method: str, url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


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


def run_ffmpeg(input_path: Path, output_path: Path, *extra_args: str) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(input_path), *extra_args, str(output_path)],
        check=True,
    )


def transcribe_audio(input_bytes: bytes, suffix: str) -> tuple[str, dict[str, Any]]:
    import mlx_whisper

    with tempfile.TemporaryDirectory(prefix="acc-voice-stt-") as tmp:
        tmpdir = Path(tmp)
        source = tmpdir / f"caller{suffix or '.webm'}"
        wav = tmpdir / "caller-16k.wav"
        source.write_bytes(input_bytes)
        run_ffmpeg(source, wav, "-ac", "1", "-ar", "16000")
        started = time.perf_counter()
        result = mlx_whisper.transcribe(str(wav), path_or_hf_repo=DEFAULT_STT_MODEL, verbose=False)
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        text = str(result.get("text", "")).strip()
        return text, {
            "engine": "mlx_whisper",
            "model": DEFAULT_STT_MODEL,
            "elapsedMs": elapsed_ms,
            "audioBytes": len(input_bytes),
        }


def synthesize_say(text: str) -> tuple[str, dict[str, Any]]:
    with tempfile.TemporaryDirectory(prefix="acc-voice-tts-") as tmp:
        tmpdir = Path(tmp)
        aiff = tmpdir / "agent.aiff"
        wav = tmpdir / "agent.wav"
        started = time.perf_counter()
        subprocess.run(["say", "-o", str(aiff), text], check=True)
        run_ffmpeg(aiff, wav, "-ac", "1", "-ar", "22050")
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        audio = wav.read_bytes()
        return base64.b64encode(audio).decode("ascii"), {
            "engine": "macos_say",
            "format": "wav",
            "sampleRate": 22050,
            "elapsedMs": elapsed_ms,
            "audioBytes": len(audio),
        }


async def send_json(websocket: websockets.WebSocketServerProtocol, payload: dict[str, Any]) -> None:
    await websocket.send(json.dumps(payload))


async def handle_client(websocket: websockets.WebSocketServerProtocol) -> None:
    call_id: str | None = None
    acc_url = DEFAULT_ACC_URL.rstrip("/")
    pipecat_version = importlib.metadata.version("pipecat-ai")

    await send_json(
        websocket,
        {
            "type": "ready",
            "ok": True,
            "pipecat": {
                "runtimeMode": "pipecat_local_voice_bridge",
                "runtimeEngine": "pipecat-ai",
                "pipecatVersion": pipecat_version,
            },
            "stt": {"engine": "mlx_whisper", "model": DEFAULT_STT_MODEL},
            "tts": {"engine": "macos_say"},
        },
    )

    async for message in websocket:
        if isinstance(message, str):
            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                await send_json(websocket, {"type": "error", "error": "json_invalid"})
                continue

            if payload.get("type") == "start":
                acc_url = str(payload.get("accUrl") or DEFAULT_ACC_URL).rstrip("/")
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

        try:
            transcript, stt_meta = await asyncio.to_thread(transcribe_audio, message, ".webm")
            if not transcript or is_low_information_transcript(transcript):
                await send_json(
                    websocket,
                    {
                        "type": "turn",
                        "ok": False,
                        "error": "low_information_transcript",
                        "callerTranscript": transcript,
                        "stt": stt_meta,
                    },
                )
                continue

            call = await asyncio.to_thread(
                json_http,
                "POST",
                f"{acc_url}/api/calls/{call_id}/caller-turn",
                {"text": transcript, "conversationMode": "free_caller"},
            )
            agent_text = latest_agent_text(call)
            audio_base64 = ""
            tts_meta: dict[str, Any] = {"engine": "macos_say", "skipped": True}
            if agent_text:
                audio_base64, tts_meta = await asyncio.to_thread(synthesize_say, agent_text)

            await send_json(
                websocket,
                {
                    "type": "turn",
                    "ok": True,
                    "callId": call_id,
                    "callerTranscript": transcript,
                    "agentText": agent_text,
                    "agentAudio": {
                        "contentType": "audio/wav",
                        "base64": audio_base64,
                    },
                    "call": call,
                    "evidence": {
                        "pipecatRuntime": "pipecat_local_voice_bridge",
                        "stt": stt_meta,
                        "tts": tts_meta,
                    },
                },
            )
        except subprocess.CalledProcessError as exc:
            await send_json(websocket, {"type": "error", "error": "local_audio_command_failed", "detail": str(exc)})
        except urllib.error.URLError as exc:
            await send_json(websocket, {"type": "error", "error": "acc_api_unavailable", "detail": str(exc)})
        except Exception as exc:  # pragma: no cover - defensive local bridge reporting
            await send_json(websocket, {"type": "error", "error": "voice_turn_failed", "detail": str(exc)})


async def run_server(host: str, port: int) -> None:
    async with websockets.serve(handle_client, host, port, max_size=20 * 1024 * 1024):
        print(json.dumps({"ok": True, "wsUrl": f"ws://{host}:{port}", "stt": DEFAULT_STT_MODEL}), flush=True)
        await asyncio.Future()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    asyncio.run(run_server(args.host, args.port))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
