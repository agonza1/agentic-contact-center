#!/usr/bin/env python3
"""Local Pipecat runtime self-check for the mocked contact-center demo.

This intentionally does not open live telephony, provider transports, microphones, or
LLM/TTS/STT credentials. It verifies that the local Python runtime can import the
Pipecat package and emits the runtime metadata the TypeScript demo records in
health/proof artifacts.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.metadata
import io
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"
if LOCAL_RUNTIME_PATH.exists():
    sys.path.insert(0, str(LOCAL_RUNTIME_PATH))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if not args.self_test:
        parser.error("only --self-test is supported for the local mocked demo runtime")

    try:
        import_output = io.StringIO()
        with contextlib.redirect_stdout(import_output), contextlib.redirect_stderr(import_output):
            import pipecat  # noqa: F401
        version = importlib.metadata.version("pipecat-ai")
    except Exception as exc:  # pragma: no cover - exercised by local setup only
        print(
            json.dumps(
                {
                    "ok": False,
                    "runtimeMode": "pipecat_local_runtime",
                    "runtimeEngine": "pipecat-ai",
                    "error": "pipecat_import_failed",
                    "detail": str(exc),
                    "install": "python3 -m pip install --target .pipecat-runtime -r requirements-pipecat.txt",
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2

    print(
        json.dumps(
            {
                "ok": True,
                "runtimeMode": "pipecat_local_runtime",
                "runtimeEngine": "pipecat-ai",
                "pipecatVersion": version,
                "transport": "local_process",
                "telephony": "mocked",
                "providerCredentials": "not_used",
                "scenario": "cancellation_rescue_seeded_script",
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
