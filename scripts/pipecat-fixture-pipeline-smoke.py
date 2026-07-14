#!/usr/bin/env python3
"""Fixture/tester adapter smoke contract for the shared ACC Pipecat Pipeline.

This is the CI-friendly entry point for issue #222's fixture adapter lane. The
default contract check is intentionally sidecar-free: it proves this adapter is
wired to the same `build_acc_voice_pipeline()` boundary as browser WebRTC before
live rtc-asr/Kokoro execution is enabled.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import subprocess
import sys
import wave
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4


REPO_ROOT = Path(__file__).resolve().parents[1]
PIPELINE_SCRIPT = REPO_ROOT / "scripts" / "acc_pipecat_voice_pipeline.py"
LOCAL_RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"


def current_git_head() -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None

    return result.stdout.strip() or None


def build_contract_payload() -> dict[str, object]:
    pipeline_source = PIPELINE_SCRIPT.read_text(encoding="utf-8")
    required_contract_checks = {
        "contract_constant": "ACC_VOICE_PIPELINE_CONTRACT",
        "pipeline_builder": "def build_acc_voice_pipeline",
        "rtc_asr_processor": "RtcAsrTurnProcessor(session)",
        "acc_turn_processor": "AccCallerTurnProcessor(session)",
        "kokoro_tts_processor": "KokoroTtsProcessor(session)",
        "transport_input_boundary": "transport_input",
        "transport_output_boundary": "transport_output",
    }
    contract_checks = {
        name: {"token": token, "present": token in pipeline_source}
        for name, token in required_contract_checks.items()
    }
    missing = [check["token"] for check in contract_checks.values() if not check["present"]]
    return {
        "ok": not missing,
        "adapter": "fixture_audio_injection",
        "mode": "contract_only",
        "generatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "repoHead": current_git_head(),
        "callId": f"fixture-{uuid4().hex[:12]}",
        "entryPoint": "scripts/pipecat-fixture-pipeline-smoke.py",
        "targetPipelineBuilder": "scripts/acc_pipecat_voice_pipeline.py:build_acc_voice_pipeline",
        "targetPipelineSha256": hashlib.sha256(pipeline_source.encode("utf-8")).hexdigest(),
        "targetContract": "fixture PCM/WAV -> InputAudioRawFrame -> rtc-asr -> ACC caller-turn -> Kokoro -> captured OutputAudioRawFrame proof",
        "sidecarsRequired": False,
        "normalOperationSidecars": ["ACC", "rtc-asr", "Kokoro"],
        "fixtureInput": {
            "frameType": "InputAudioRawFrame",
            "audioFormat": "pcm_s16le",
            "sampleRateHz": 16000,
            "channels": 1,
        },
        "capturedOutput": {
            "frameType": "OutputAudioRawFrame|TTSAudioRawFrame",
            "audioFormat": "pcm_s16le",
            "sampleRateHz": 24000,
            "channels": 1,
        },
        "pipelineStages": [
            "transport.input",
            "RtcAsrTurnProcessor",
            "AccCallerTurnProcessor",
            "KokoroTtsProcessor",
            "transport.output",
        ],
        "contractChecks": contract_checks,
        "missingContractTokens": missing,
        "nextAction": "Run --input-wav with ACC, rtc-asr, and Kokoro sidecars to capture live fixture OutputAudioRawFrame proof.",
    }


def write_payload(payload: dict[str, object], output_path: str | None) -> None:
    rendered = json.dumps(payload, indent=2) + "\n"
    if output_path:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered, encoding="utf-8")
    print(rendered, end="")



def add_local_runtime_path() -> None:
    if LOCAL_RUNTIME_PATH.exists():
        sys.path.insert(0, str(LOCAL_RUNTIME_PATH))


def read_fixture_wav(path: Path) -> tuple[bytes, int, int]:
    with wave.open(str(path), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        pcm = wav_file.readframes(wav_file.getnframes())
    if channels != 1 or sample_width != 2:
        raise ValueError("fixture WAV must be mono PCM16")
    return pcm, sample_rate, channels


async def run_live_fixture(args: argparse.Namespace) -> dict[str, object]:
    add_local_runtime_path()
    from pipecat.frames.frames import InputAudioRawFrame, OutputAudioRawFrame, StartFrame, TTSAudioRawFrame
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

    from acc_pipecat_voice_pipeline import (
        INPUT_SAMPLE_RATE,
        AccVoicePipelineSession,
        build_acc_voice_pipeline,
        check_readiness,
        json_http,
        latest_agent_text,
        resample_pcm16_mono,
    )

    class FixtureInput(FrameProcessor):
        def __init__(self) -> None:
            super().__init__(name="fixture-audio-input")

        async def process_frame(self, frame: object, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            await self.push_frame(frame, direction)

    class FixtureOutput(FrameProcessor):
        def __init__(self) -> None:
            super().__init__(name="fixture-audio-output")
            self.frames: list[dict[str, object]] = []
            self.audio = bytearray()

        async def process_frame(self, frame: object, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if direction == FrameDirection.DOWNSTREAM and isinstance(frame, (OutputAudioRawFrame, TTSAudioRawFrame)):
                audio = bytes(frame.audio)
                self.audio.extend(audio)
                self.frames.append({
                    "frameType": type(frame).__name__,
                    "audioBytes": len(audio),
                    "sampleRate": getattr(frame, "sample_rate", None),
                    "channels": getattr(frame, "num_channels", None),
                })
            await self.push_frame(frame, direction)

    fixture_path = Path(args.input_wav)
    pcm, sample_rate, channels = read_fixture_wav(fixture_path)
    normalized_pcm = resample_pcm16_mono(pcm, sample_rate, INPUT_SAMPLE_RATE)
    silence_ms = max(int(args.trailing_silence_ms), 0)
    trailing_silence = b"\x00\x00" * (INPUT_SAMPLE_RATE * silence_ms // 1000)
    readiness = check_readiness(acc_url=args.acc_url)
    started_call = None
    call_id = args.call_id
    if not call_id:
        started_call = await asyncio.to_thread(
            json_http,
            "POST",
            f"{args.acc_url.rstrip('/')}/api/demo/start",
            {"openclawSessionLabel": "pipecat-fixture-pipeline-smoke"},
        )
        session_payload = started_call.get("session") if isinstance(started_call, dict) else None
        call_id = session_payload.get("callId") if isinstance(session_payload, dict) else None
        if not isinstance(call_id, str) or not call_id:
            raise RuntimeError("ACC demo start did not return session.callId")
    session = AccVoicePipelineSession(acc_url=args.acc_url, call_id=call_id, readiness=readiness)
    fixture_input = FixtureInput()
    fixture_output = FixtureOutput()
    pipeline = build_acc_voice_pipeline(transport_input=fixture_input, transport_output=fixture_output, session=session)
    input_frame = InputAudioRawFrame(audio=normalized_pcm + trailing_silence, sample_rate=INPUT_SAMPLE_RATE, num_channels=channels)
    for processor in getattr(pipeline, "processors", []):
        setattr(processor, "_enable_direct_mode", True)
        if type(processor).__name__ == "RtcAsrTurnProcessor":
            processor.min_turn_ms = 0
            processor.silence_ms = 0
    session.record_stage(
        "fixture.pipeline_constructed",
        pipeline=type(pipeline).__name__,
        source="fixture-audio-input",
        sink="fixture-audio-output",
        callCreated=started_call is not None,
    )
    await pipeline.queue_frame(StartFrame(audio_in_sample_rate=INPUT_SAMPLE_RATE, audio_out_sample_rate=24000), FrameDirection.DOWNSTREAM)
    await asyncio.wait_for(pipeline.queue_frame(input_frame, FrameDirection.DOWNSTREAM), timeout=float(args.timeout_sec))
    deadline = asyncio.get_running_loop().time() + float(args.timeout_sec)
    while not fixture_output.frames and not session.last_error and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    output_sha = hashlib.sha256(bytes(fixture_output.audio)).hexdigest() if fixture_output.audio else None
    return {
        "ok": bool(fixture_output.frames) and not session.last_error,
        "adapter": "fixture_audio_injection",
        "mode": "live_in_process",
        "generatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "repoHead": current_git_head(),
        "entryPoint": "scripts/pipecat-fixture-pipeline-smoke.py",
        "targetPipelineBuilder": "scripts/acc_pipecat_voice_pipeline.py:build_acc_voice_pipeline",
        "callId": call_id,
        "callCreated": started_call is not None,
        "readiness": {
            "ok": readiness.ok,
            "status": readiness.status,
            "blockers": readiness.blockers,
            "rtcAsr": readiness.rtc_asr.__dict__,
            "kokoro": readiness.kokoro.__dict__,
            "acc": readiness.acc.__dict__,
        },
        "fixtureInput": {
            "path": str(fixture_path),
            "sourceSampleRateHz": sample_rate,
            "sourceBytes": len(pcm),
            "normalizedSampleRateHz": INPUT_SAMPLE_RATE,
            "normalizedBytes": len(normalized_pcm),
            "trailingSilenceMs": silence_ms,
        },
        "capturedOutput": {
            "frameCount": len(fixture_output.frames),
            "audioBytes": len(fixture_output.audio),
            "audioSha256": output_sha,
            "frames": fixture_output.frames,
        },
        "pipelineStages": ["transport.input", "RtcAsrTurnProcessor", "AccCallerTurnProcessor", "KokoroTtsProcessor", "transport.output"],
        "stageEvents": session.stage_events,
        "lastEvidence": session.last_evidence,
        "lastError": session.last_error,
        "blockers": [] if fixture_output.frames and not session.last_error else readiness.blockers + ([session.last_error] if session.last_error else ["fixture pipeline produced no output audio"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check the fixture adapter contract for the shared ACC Pipecat Pipeline.")
    parser.add_argument("--contract-only", action="store_true", help="Run the sidecar-free adapter contract check.")
    parser.add_argument("--input-wav", help="Run the live in-process fixture path with a mono PCM16 WAV input.")
    parser.add_argument("--acc-url", default=os.environ.get("ACC_URL", "http://127.0.0.1:8026"), help="ACC base URL for live fixture mode.")
    parser.add_argument("--call-id", help="Existing ACC call id to use for live fixture mode; defaults to starting an ACC demo call.")
    parser.add_argument("--timeout-sec", type=float, default=20.0, help="Maximum time to wait for captured output audio in live fixture mode.")
    parser.add_argument("--trailing-silence-ms", type=int, default=1500, help="Silence appended after fixture audio to trigger turn finalization.")
    parser.add_argument("--out", help="Optional JSON artifact path.")
    args = parser.parse_args()

    if args.contract_only:
        payload = build_contract_payload()
        write_payload(payload, args.out)
        return 0 if payload["ok"] else 1

    if args.input_wav:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                payload = asyncio.run(run_live_fixture(args))
        except Exception as exc:
            payload = {
                "ok": False,
                "adapter": "fixture_audio_injection",
                "mode": "live_in_process",
                "error": "fixture_pipeline_live_mode_failed",
                "detail": str(exc),
                "generatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
                "repoHead": current_git_head(),
            }
        write_payload(payload, args.out)
        return 0 if payload.get("ok") else 2

    print(
        json.dumps(
            {
                "ok": False,
                "error": "fixture_pipeline_input_required",
                "detail": "Run with --contract-only for the sidecar-free check, or pass --input-wav for the live in-process fixture path.",
            },
            indent=2,
        ),
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    os.chdir(REPO_ROOT)
    raise SystemExit(main())
