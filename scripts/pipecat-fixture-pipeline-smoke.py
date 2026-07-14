#!/usr/bin/env python3
"""Fixture/tester adapter smoke contract for the shared ACC Pipecat Pipeline.

This is the CI-friendly entry point for issue #222's fixture adapter lane. The
default contract check is intentionally sidecar-free: it proves this adapter is
wired to the same `build_acc_voice_pipeline()` boundary as browser WebRTC before
live rtc-asr/Kokoro execution is enabled.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4


REPO_ROOT = Path(__file__).resolve().parents[1]
PIPELINE_SCRIPT = REPO_ROOT / "scripts" / "acc_pipecat_voice_pipeline.py"


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
