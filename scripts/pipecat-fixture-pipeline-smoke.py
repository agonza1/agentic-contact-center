#!/usr/bin/env python3
"""Fixture/tester adapter smoke contract for the shared ACC Pipecat Pipeline.

This is the CI-friendly entry point for issue #222's fixture adapter lane. The
default contract check is intentionally sidecar-free: it proves this adapter is
wired to the same `build_acc_voice_pipeline()` boundary as browser WebRTC before
live rtc-asr/Kokoro execution is enabled.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4


REPO_ROOT = Path(__file__).resolve().parents[1]
PIPELINE_SCRIPT = REPO_ROOT / "scripts" / "acc_pipecat_voice_pipeline.py"


def build_contract_payload() -> dict[str, object]:
    pipeline_source = PIPELINE_SCRIPT.read_text(encoding="utf-8")
    required_tokens = [
        "ACC_VOICE_PIPELINE_CONTRACT",
        "def build_acc_voice_pipeline",
        "RtcAsrTurnProcessor(session)",
        "AccCallerTurnProcessor(session)",
        "KokoroTtsProcessor(session)",
        "transport_input",
        "transport_output",
    ]
    missing = [token for token in required_tokens if token not in pipeline_source]
    return {
        "ok": not missing,
        "adapter": "fixture_audio_injection",
        "mode": "contract_only",
        "generatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "callId": f"fixture-{uuid4().hex[:12]}",
        "entryPoint": "scripts/pipecat-fixture-pipeline-smoke.py",
        "targetPipelineBuilder": "scripts/acc_pipecat_voice_pipeline.py:build_acc_voice_pipeline",
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
        "missingContractTokens": missing,
        "nextAction": "Replace contract-only fixture transport with a live in-process frame source/sink once sidecars are available in CI.",
    }


def write_payload(payload: dict[str, object], output_path: str | None) -> None:
    rendered = json.dumps(payload, indent=2) + "\n"
    if output_path:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check the fixture adapter contract for the shared ACC Pipecat Pipeline.")
    parser.add_argument("--contract-only", action="store_true", help="Run the sidecar-free adapter contract check. This is the current supported mode.")
    parser.add_argument("--out", help="Optional JSON artifact path.")
    args = parser.parse_args()

    if not args.contract_only:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "fixture_pipeline_live_mode_not_implemented",
                    "detail": "Run with --contract-only until the in-process fixture transport is promoted to live sidecar execution.",
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2

    payload = build_contract_payload()
    write_payload(payload, args.out)
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    os.chdir(REPO_ROOT)
    raise SystemExit(main())
