#!/usr/bin/env python3
"""Generate deterministic caller/agent/mixed recording proof artifacts."""

from __future__ import annotations

import argparse
import json
import math
import struct
import subprocess
from pathlib import Path

from acc_track_recorder import SeparateTrackRecorder


REPO_ROOT = Path(__file__).resolve().parents[1]


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


def tone_pcm(*, hz: float, duration_ms: int, sample_rate_hz: int, amplitude: float = 0.28) -> bytes:
    frames = round(sample_rate_hz * duration_ms / 1000)
    samples = []
    for index in range(frames):
        value = round(math.sin(2 * math.pi * hz * index / sample_rate_hz) * 32767 * amplitude)
        samples.append(struct.pack("<h", value))
    return b"".join(samples)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate local ACC separate track recording proof artifacts.")
    parser.add_argument("--out-dir", default="artifacts/pipecat-track-recording-proof", help="Directory for WAV and manifest artifacts.")
    parser.add_argument("--call-id", default="fixture-track-recording-proof", help="Stable call id for artifact filenames.")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    sample_rate = 16000
    recorder = SeparateTrackRecorder(artifact_dir=out_dir, call_id=args.call_id, sample_rate_hz=sample_rate)
    caller_pcm = tone_pcm(hz=440, duration_ms=720, sample_rate_hz=sample_rate)
    agent_pcm = tone_pcm(hz=660, duration_ms=520, sample_rate_hz=24000)
    recorder.record_caller_audio(caller_pcm, sample_rate_hz=sample_rate, event_id="stt.finalize_started", started_at_ms=0)
    recorder.record_agent_audio(agent_pcm, sample_rate_hz=24000, event_id="tts.stream_started", started_at_ms=320)
    manifest = recorder.write_manifest(
        reason="deterministic_track_recording_proof",
        stage_events=[
            {"stage": "audio.speech_started", "timestampMs": 0, "track": "caller"},
            {"stage": "stt.transcript_final", "timestampMs": 720, "track": "caller"},
            {"stage": "tts.stream_started", "timestampMs": 320, "track": "agent"},
            {"stage": "tts.stream_completed", "timestampMs": 840, "track": "agent"},
        ],
    )
    summary = {
        "ok": manifest["review"]["ready"],
        "repoHead": current_git_head(),
        "manifest": manifest["manifestPath"],
        "tracks": manifest["tracks"],
        "segments": manifest["segments"],
        "limitations": manifest["limitations"],
    }
    print(json.dumps(summary, indent=2))
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
