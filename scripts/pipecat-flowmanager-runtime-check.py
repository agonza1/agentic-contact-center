#!/usr/bin/env python3
"""Verify the pinned Pipecat 1.4 FlowManager runtime and ACC adapter cutover."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"
if LOCAL_RUNTIME_PATH.exists():
    sys.path.insert(0, str(LOCAL_RUNTIME_PATH))

from acc_pipecat_flow_manager import AccPipecatFlowManagerAdapter


async def run_check() -> dict[str, Any]:
    nodes = iter(["greet", "diagnose"])

    def fake_acc_request(method: str, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        if method == "POST" and url.endswith("/fallback"):
            return {
                "flowState": "wrap",
                "transcript": [{"speaker": "agent", "text": "runtime check failed closed"}],
            }
        if method != "POST" or not url.endswith("/caller-turn"):
            raise RuntimeError(f"unexpected ACC runtime check request: {method} {url}")
        node = next(nodes)
        return {
            "flowState": node,
            "callerTurnCommit": {
                "mode": "delivery_ack",
                "status": "pending",
                "snapshotVersion": f"runtime-check-{node}",
            },
            "transcript": [
                {"speaker": "caller", "text": payload["text"]},
                {"speaker": "agent", "text": f"runtime check {node}"},
            ],
        }

    adapter = AccPipecatFlowManagerAdapter(
        acc_url="http://runtime-check.invalid",
        call_id="flowmanager-runtime-check",
        request_json=fake_acc_request,
    )
    first = await adapter.preview_caller_turn(text="I want to cancel", conversation_mode="free_caller")
    first_pending_node = first["flowManagerRuntime"].get("pendingNode")
    first_commit = await adapter.commit_pending_transition()
    second = await adapter.preview_caller_turn(text="My renewal increased", conversation_mode="free_caller")
    second_pending_node = second["flowManagerRuntime"].get("pendingNode")
    second_commit = await adapter.commit_pending_transition()
    checks = {
        "realFlowManagerImported": type(adapter.manager).__module__ == "pipecat_flows.manager",
        "pinnedVersionsLoaded": first["flowManagerRuntime"]["runtimeVersions"] == {
            "pipecat-ai": "1.4.0",
            "pipecat-ai-flows": "1.4.0",
        },
        "nodeTransitionsApplied": [step["to"] for step in adapter.transition_trace] == ["greet", "diagnose"],
        "deliveryAckPreserved": (
            first_pending_node == "greet"
            and second_pending_node == "diagnose"
            and first_commit["commitPolicy"] == "delivery_ack_committed"
            and second_commit["commitPolicy"] == "delivery_ack_committed"
        ),
        "llmFramesContained": adapter.frame_sink.queued_frame_types == [
            "LLMMessagesAppendFrame",
            "LLMSetToolsFrame",
            "LLMMessagesAppendFrame",
            "LLMSetToolsFrame",
            "LLMMessagesAppendFrame",
            "LLMSetToolsFrame",
        ],
    }
    return {
        "ok": all(checks.values()),
        "runtimeAdapter": type(adapter.manager).__module__ + "." + type(adapter.manager).__name__,
        "runtimeVersions": first["flowManagerRuntime"]["runtimeVersions"],
        "transitionTrace": adapter.transition_trace,
        "queuedFrameTypes": adapter.frame_sink.queued_frame_types,
        "checks": checks,
    }


def main() -> int:
    try:
        payload = asyncio.run(run_check())
    except Exception as exc:
        payload = {
            "ok": False,
            "error": "pipecat_flowmanager_runtime_check_failed",
            "detail": str(exc),
            "install": "npm run pipecat:webrtc:install",
        }
    print(json.dumps(payload, indent=2))
    return 0 if payload["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
