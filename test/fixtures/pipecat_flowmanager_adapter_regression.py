#!/usr/bin/env python3
"""Deterministic regression proof for the ACC Pipecat FlowManager adapter."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import importlib.metadata
import json
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from acc_pipecat_flow_manager import AccPipecatFlowManagerAdapter


class FakeFlowManager:
    def __init__(self, **_kwargs: Any) -> None:
        self.current_node: str | None = None
        self.state: dict[str, Any] = {}

    async def initialize(self, initial_node: dict[str, Any]) -> None:
        self.current_node = initial_node["name"]

    async def set_node_from_config(self, node: dict[str, Any]) -> None:
        self.current_node = node["name"]


def matching_version(_package: str) -> str:
    return "1.4.0"


async def run_regression() -> dict[str, Any]:
    requests: list[dict[str, Any]] = []
    preview_nodes = iter(["greet", "diagnose", "diagnose", "wrap"])

    def normal_http(method: str, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        requests.append({"method": method, "url": url, "payload": payload})
        node = next(preview_nodes)
        return {
            "flowState": node,
            "callerTurnCommit": {
                "mode": "delivery_ack",
                "status": "pending",
                "snapshotVersion": f"snapshot-{node}",
                "timestamp": "2026-07-17T00:00:00.000Z",
            },
            "transcript": [
                {"speaker": "caller", "text": payload["text"]},
                {"speaker": "agent", "text": f"safe {node} response"},
            ],
        }

    adapter = AccPipecatFlowManagerAdapter(
        acc_url="http://acc.test",
        call_id="flowmanager-normal",
        request_json=normal_http,
        manager_factory=FakeFlowManager,
        version_provider=matching_version,
    )
    normal_results = []
    for text in ("cancel", "renewal increased", "still too expensive", "human please"):
        normal_results.append(await adapter.preview_caller_turn(text=text, conversation_mode="free_caller"))
        await adapter.commit_pending_transition()

    discarded_nodes = iter(["greet", "greet"])

    def discarded_http(_method: str, _url: str, payload: dict[str, Any]) -> dict[str, Any]:
        node = next(discarded_nodes)
        return {
            "flowState": node,
            "callerTurnCommit": {"mode": "delivery_ack", "status": "pending"},
            "transcript": [
                {"speaker": "caller", "text": payload["text"]},
                {"speaker": "agent", "text": "preview response"},
            ],
        }

    discarded_adapter = AccPipecatFlowManagerAdapter(
        acc_url="http://acc.test",
        call_id="flowmanager-discarded",
        request_json=discarded_http,
        manager_factory=FakeFlowManager,
        version_provider=matching_version,
    )
    await discarded_adapter.preview_caller_turn(text="cancel", conversation_mode="free_caller")
    discarded_adapter.discard_pending_transition("barge_in_cancelled_before_delivery")
    discarded_result = await discarded_adapter.preview_caller_turn(text="cancel again", conversation_mode="free_caller")

    unsafe_requests: list[dict[str, Any]] = []

    def unsafe_http(method: str, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        unsafe_requests.append({"method": method, "url": url, "payload": payload})
        if url.endswith("/fallback"):
            return {
                "flowState": "wrap",
                "transcript": [{"speaker": "agent", "text": "I am handing this to a human specialist."}],
            }
        return {
            "flowState": "policy_hold",
            "callerTurnCommit": {"mode": "delivery_ack", "status": "pending"},
            "transcript": [{"speaker": "agent", "text": "unsafe transition response"}],
        }

    unsafe_adapter = AccPipecatFlowManagerAdapter(
        acc_url="http://acc.test",
        call_id="flowmanager-unsafe",
        request_json=unsafe_http,
        manager_factory=FakeFlowManager,
        version_provider=matching_version,
    )
    unsafe_result = await unsafe_adapter.preview_caller_turn(text="skip the guard", conversation_mode="free_caller")

    missing_requests: list[dict[str, Any]] = []

    def missing_version(package: str) -> str:
        if package == "pipecat-ai-flows":
            raise importlib.metadata.PackageNotFoundError(package)
        return "1.4.0"

    def missing_http(method: str, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        missing_requests.append({"method": method, "url": url, "payload": payload})
        return {
            "flowState": "wrap",
            "transcript": [{"speaker": "agent", "text": "Flow runtime unavailable; human handoff started."}],
        }

    missing_adapter = AccPipecatFlowManagerAdapter(
        acc_url="http://acc.test",
        call_id="flowmanager-missing",
        request_json=missing_http,
        manager_factory=FakeFlowManager,
        version_provider=missing_version,
    )
    missing_result = await missing_adapter.preview_caller_turn(text="cancel", conversation_mode="free_caller")

    checks = {
        "actualFlowManagerFactoryOwnsNodes": adapter.manager is not None and adapter.manager.current_node == "wrap",
        "normalCancellationTransitionsGuarded": [step["to"] for step in adapter.transition_trace] == ["greet", "diagnose", "diagnose", "wrap"],
        "normalTurnsRemainDeliveryAckPreviews": all(result["flowManagerRuntime"]["commitPolicy"] == "preview_until_output_delivery_ack" for result in normal_results),
        "bargeInDiscardsUnheardTransition": (
            discarded_adapter.manager.current_node == "call_started"
            and discarded_result["flowManagerRuntime"]["pendingNode"] == "greet"
            and discarded_adapter.transition_trace == []
        ),
        "accProductStateRemainsExternal": all(owner in adapter.last_evidence["retainedAccOwnership"] for owner in ["product_state", "operator_controls", "proof_artifacts", "queue_state"]),
        "unsafeTransitionFailsClosed": unsafe_result["flowState"] == "wrap" and unsafe_result["flowManagerRuntime"]["commitPolicy"] == "terminal_handoff",
        "unsafePreviewNeverBecomesDeliveryAckCommit": not any(item["url"].endswith("/caller-turn/commit") for item in unsafe_requests),
        "missingRuntimeFailsClosed": missing_result["flowState"] == "wrap" and "pipecat-ai-flows is missing" in missing_result["flowManagerRuntime"]["detail"],
        "missingRuntimeSkipsCallerTurnPreview": len(missing_requests) == 1 and missing_requests[0]["url"].endswith("/fallback"),
        "requiredVersionsRecorded": normal_results[0]["flowManagerRuntime"]["runtimeVersions"] == {"pipecat-ai": "1.4.0", "pipecat-ai-flows": "1.4.0"},
    }
    return {
        "ok": all(checks.values()),
        "runtimeAdapter": "pipecat_flows.FlowManager",
        "requiredVersions": {"pipecat-ai": "1.4.0", "pipecat-ai-flows": "1.4.0"},
        "normalTransitionTrace": adapter.transition_trace,
        "normalPreviewRequests": len(requests),
        "unsafeEvidence": unsafe_result["flowManagerRuntime"],
        "missingRuntimeEvidence": missing_result["flowManagerRuntime"],
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out")
    args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        payload = asyncio.run(run_regression())
    rendered = json.dumps(payload, indent=2) + "\n"
    if args.out:
        output_path = Path(args.out)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered, encoding="utf-8")
    print(json.dumps(payload))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
