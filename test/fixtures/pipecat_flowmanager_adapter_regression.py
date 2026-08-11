#!/usr/bin/env python3
"""Deterministic regression proof for the ACC Pipecat FlowManager adapter."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import importlib.metadata
import json
import sys
import urllib.error
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
    return "1.7.0"


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

    def structured_http(_method: str, _url: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "flowState": "greet",
            "conversationControl": {
                "node": "collect_identity",
                "lastProposal": {"intent": "cancellation", "requestedOperation": "cancel_policy"},
                "lastDecision": {"status": "accepted", "targetNode": "collect_identity"},
            },
            "callerTurnCommit": {"mode": "delivery_ack", "status": "pending"},
            "transcript": [
                {"speaker": "caller", "text": payload["text"]},
                {"speaker": "agent", "text": "Please provide your full name and ZIP code."},
            ],
        }

    structured_adapter = AccPipecatFlowManagerAdapter(
        acc_url="http://acc.test",
        call_id="flowmanager-structured-routing",
        request_json=structured_http,
        manager_factory=FakeFlowManager,
        version_provider=matching_version,
    )
    structured_preview = await structured_adapter.preview_caller_turn(
        text="I want to close my policy",
        conversation_mode="openai_llm",
    )
    await structured_adapter.commit_pending_transition()

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
        if package == "pipecat-ai":
            raise importlib.metadata.PackageNotFoundError(package)
        return "1.7.0"

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

    held_requests: list[dict[str, Any]] = []

    def held_http(method: str, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        held_requests.append({"method": method, "url": url, "payload": payload})
        if url.endswith("/fallback"):
            return {
                "flowState": "wrap",
                "transcript": [{"speaker": "agent", "text": "This should not be reached for operator holds."}],
            }
        body = json.dumps(
            {
                "ok": False,
                "error": "live_sip_operator_hold_active",
                "call": {
                    "flowState": "policy_hold",
                    "transcript": [],
                    "events": [
                        {
                            "type": "rtc_asr_transcript",
                            "detail": {
                                "held": True,
                                "holdReason": "operator_policy_hold_active",
                            },
                        }
                    ],
                },
            }
        ).encode("utf-8")
        raise urllib.error.HTTPError(url, 409, "Conflict", {}, io.BytesIO(body))

    held_adapter = AccPipecatFlowManagerAdapter(
        acc_url="http://acc.test",
        call_id="flowmanager-held",
        request_json=held_http,
        manager_factory=FakeFlowManager,
        version_provider=matching_version,
    )
    held_result = await held_adapter.preview_caller_turn(text="pause race", conversation_mode="openai_llm")

    delivery_ack_pending_requests: list[dict[str, Any]] = []

    def delivery_ack_pending_http(method: str, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        delivery_ack_pending_requests.append({"method": method, "url": url, "payload": payload})
        if url.endswith("/fallback"):
            return {
                "flowState": "wrap",
                "transcript": [{"speaker": "agent", "text": "This should not be reached for delivery-ack preview reservations."}],
            }
        body = json.dumps(
            {
                "ok": False,
                "error": "caller_turn_delivery_ack_preview_pending",
                "callerTurnCommit": {
                    "mode": "delivery_ack",
                    "status": "pending",
                    "callId": "flowmanager-delivery-ack-pending",
                    "snapshotVersion": "snapshot-pending",
                },
            }
        ).encode("utf-8")
        raise urllib.error.HTTPError(url, 409, "Conflict", {}, io.BytesIO(body))

    delivery_ack_pending_adapter = AccPipecatFlowManagerAdapter(
        acc_url="http://acc.test",
        call_id="flowmanager-delivery-ack-pending",
        request_json=delivery_ack_pending_http,
        manager_factory=FakeFlowManager,
        version_provider=matching_version,
    )
    delivery_ack_pending_result = await delivery_ack_pending_adapter.preview_caller_turn(
        text="barge-in while prior preview is reserved",
        conversation_mode="openai_llm",
    )

    ended_requests: list[dict[str, Any]] = []

    def ended_http(method: str, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        ended_requests.append({"method": method, "url": url, "payload": payload})
        if url.endswith("/fallback"):
            return {
                "flowState": "wrap",
                "transcript": [{"speaker": "agent", "text": "This should not be reached after SIP termination."}],
            }
        body = json.dumps(
            {
                "ok": False,
                "error": "live_sip_call_ended",
                "call": {
                    "flowState": "wrap",
                    "transcript": [{"speaker": "agent", "text": "Call already ended."}],
                    "endedAt": "2026-07-17T00:00:01.000Z",
                },
            }
        ).encode("utf-8")
        raise urllib.error.HTTPError(url, 409, "Conflict", {}, io.BytesIO(body))

    ended_adapter = AccPipecatFlowManagerAdapter(
        acc_url="http://acc.test",
        call_id="flowmanager-ended",
        request_json=ended_http,
        manager_factory=FakeFlowManager,
        version_provider=matching_version,
    )
    ended_result = await ended_adapter.preview_caller_turn(text="after hangup", conversation_mode="openai_llm")

    recovered_requests: list[dict[str, Any]] = []
    recovered_nodes = iter(["wrap", "diagnose"])

    def recovered_http(method: str, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        recovered_requests.append({"method": method, "url": url, "payload": payload})
        if url.endswith("/fallback"):
            return {
                "flowState": "wrap",
                "transcript": [{"speaker": "agent", "text": "This should not repeat after operator release."}],
            }
        node = next(recovered_nodes)
        if node == "wrap":
            return {
                "flowState": "wrap",
                "callerTurnCommit": {"mode": "delivery_ack", "status": "pending"},
                "events": [
                    {
                        "type": "human_handoff_started",
                        "detail": {"source": "openai_llm_fail_closed"},
                    },
                    {
                        "type": "flow_state_transition",
                        "detail": {"from": "greet", "to": "wrap", "reason": "openai_llm_failed_closed"},
                    },
                ],
                "transcript": [
                    {"speaker": "caller", "text": payload["text"]},
                    {"speaker": "agent", "text": "fail closed response"},
                ],
            }
        return {
            "flowState": "diagnose",
            "callerTurnCommit": {"mode": "delivery_ack", "status": "pending"},
            "events": [
                {
                    "type": "human_handoff_started",
                    "detail": {"source": "openai_llm_fail_closed"},
                },
                {
                    "type": "flow_state_transition",
                    "detail": {"from": "greet", "to": "wrap", "reason": "openai_llm_failed_closed"},
                },
                {
                    "type": "demo_fallback_disarmed",
                    "detail": {"source": "operator_resume"},
                },
                {
                    "type": "operator_steer_applied",
                    "detail": {"action": "resume"},
                },
                {
                    "type": "flow_state_transition",
                    "detail": {"from": "wrap", "to": "steered_response", "reason": "operator_resumed"},
                },
                {
                    "type": "flow_state_transition",
                    "detail": {"from": "steered_response", "to": "diagnose", "reason": "openai_llm_conversation"},
                },
            ],
            "transcript": [
                {"speaker": "caller", "text": "first failed turn"},
                {"speaker": "agent", "text": "fail closed response"},
                {"speaker": "operator", "text": "operator steer: resume"},
                {"speaker": "caller", "text": payload["text"]},
                {"speaker": "agent", "text": "recovered response"},
            ],
        }

    recovered_adapter = AccPipecatFlowManagerAdapter(
        acc_url="http://acc.test",
        call_id="flowmanager-recovered",
        request_json=recovered_http,
        manager_factory=FakeFlowManager,
        version_provider=matching_version,
    )
    recovered_fail_closed = await recovered_adapter.preview_caller_turn(text="first failed turn", conversation_mode="openai_llm")
    await recovered_adapter.commit_pending_transition()
    recovered_preview = await recovered_adapter.preview_caller_turn(text="recovered caller turn", conversation_mode="openai_llm")
    await recovered_adapter.commit_pending_transition()

    terminal_revalidation_requests: list[dict[str, Any]] = []
    terminal_revalidation_attempts = 0

    def terminal_revalidation_http(method: str, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        nonlocal terminal_revalidation_attempts
        terminal_revalidation_requests.append({"method": method, "url": url, "payload": payload})
        if url.endswith("/fallback"):
            return {
                "flowState": "wrap",
                "transcript": [{"speaker": "agent", "text": "FlowManager failed closed; handing off."}],
            }
        terminal_revalidation_attempts += 1
        if terminal_revalidation_attempts == 1:
            raise urllib.error.URLError("transient ACC caller-turn timeout")
        return {
            "flowState": "diagnose",
            "callerTurnCommit": {"mode": "delivery_ack", "status": "pending"},
            "events": [
                {
                    "type": "human_handoff_started",
                    "detail": {"source": "flowmanager_runtime_fail_closed"},
                },
                {
                    "type": "flow_state_transition",
                    "detail": {"from": "greet", "to": "wrap", "reason": "flowmanager_runtime_failure"},
                },
                {
                    "type": "demo_fallback_disarmed",
                    "detail": {"source": "operator_resume"},
                },
                {
                    "type": "operator_steer_applied",
                    "detail": {"action": "resume"},
                },
                {
                    "type": "flow_state_transition",
                    "detail": {"from": "wrap", "to": "steered_response", "reason": "operator_resumed"},
                },
                {
                    "type": "flow_state_transition",
                    "detail": {"from": "steered_response", "to": "diagnose", "reason": "openai_llm_conversation"},
                },
            ],
            "transcript": [
                {"speaker": "caller", "text": payload["text"]},
                {"speaker": "agent", "text": "Recovered after operator release."},
            ],
        }

    terminal_revalidation_adapter = AccPipecatFlowManagerAdapter(
        acc_url="http://acc.test",
        call_id="flowmanager-terminal-revalidation",
        request_json=terminal_revalidation_http,
        manager_factory=FakeFlowManager,
        version_provider=matching_version,
    )
    terminal_cached = await terminal_revalidation_adapter.preview_caller_turn(
        text="first request times out",
        conversation_mode="openai_llm",
    )
    terminal_revalidated = await terminal_revalidation_adapter.preview_caller_turn(
        text="operator resumed this call",
        conversation_mode="openai_llm",
    )
    await terminal_revalidation_adapter.commit_pending_transition()

    terminal_release_from_hold_requests: list[dict[str, Any]] = []

    def terminal_release_from_hold_http(method: str, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        terminal_release_from_hold_requests.append({"method": method, "url": url, "payload": payload})
        return {
            "flowState": "diagnose",
            "callerTurnCommit": {"mode": "delivery_ack", "status": "pending"},
            "events": [
                {
                    "type": "operator_steer_applied",
                    "detail": {"action": "transfer"},
                },
                {
                    "type": "flow_state_transition",
                    "detail": {"from": "policy_hold", "to": "wrap", "reason": "operator_transfer"},
                },
                {
                    "type": "operator_steer_applied",
                    "detail": {"action": "resume"},
                },
                {
                    "type": "flow_state_transition",
                    "detail": {"from": "wrap", "to": "steered_response", "reason": "operator_resumed"},
                },
                {
                    "type": "flow_state_transition",
                    "detail": {"from": "steered_response", "to": "diagnose", "reason": "openai_llm_conversation"},
                },
            ],
            "transcript": [
                {"speaker": "operator", "text": "operator steer: transfer"},
                {"speaker": "operator", "text": "operator steer: resume"},
                {"speaker": "caller", "text": payload["text"]},
                {"speaker": "agent", "text": "Recovered after operator terminal release."},
            ],
        }

    terminal_release_from_hold_adapter = AccPipecatFlowManagerAdapter(
        acc_url="http://acc.test",
        call_id="flowmanager-terminal-release-from-hold",
        request_json=terminal_release_from_hold_http,
        manager_factory=FakeFlowManager,
        version_provider=matching_version,
    )
    await terminal_release_from_hold_adapter.initialize()
    await terminal_release_from_hold_adapter.activate_node("greet", reason="fixture")
    await terminal_release_from_hold_adapter.activate_node("diagnose", reason="fixture")
    await terminal_release_from_hold_adapter.activate_node("policy_hold", reason="fixture")
    terminal_release_from_hold_preview = await terminal_release_from_hold_adapter.preview_caller_turn(
        text="operator resumed after transfer",
        conversation_mode="openai_llm",
    )
    await terminal_release_from_hold_adapter.commit_pending_transition()

    checks = {
        "actualFlowManagerFactoryOwnsNodes": adapter.manager is not None and adapter.manager.current_node == "wrap",
        "normalCancellationTransitionsGuarded": [step["to"] for step in adapter.transition_trace] == ["greet", "diagnose", "diagnose", "wrap"],
        "normalTurnsRemainDeliveryAckPreviews": all(result["flowManagerRuntime"]["commitPolicy"] == "preview_until_output_delivery_ack" for result in normal_results),
        "structuredProposalUsesAuthorizedConversationGraph": (
            structured_preview["flowManagerRuntime"]["pendingNode"] == "collect_identity"
            and structured_preview["flowManagerRuntime"]["pendingAllowedFunctions"]
            == ["submit_identity", "transfer_to_human"]
            and structured_adapter.manager.current_node == "collect_identity"
            and [step["to"] for step in structured_adapter.transition_trace]
            == ["understand_request", "collect_identity"]
        ),
        "bargeInDiscardsUnheardTransition": (
            discarded_adapter.manager.current_node == "call_started"
            and discarded_result["flowManagerRuntime"]["pendingNode"] == "greet"
            and discarded_adapter.transition_trace == []
        ),
        "accProductStateRemainsExternal": all(owner in adapter.last_evidence["retainedAccOwnership"] for owner in ["product_state", "operator_controls", "proof_artifacts", "queue_state"]),
        "unsafeTransitionFailsClosed": unsafe_result["flowState"] == "wrap" and unsafe_result["flowManagerRuntime"]["commitPolicy"] == "terminal_handoff",
        "unsafePreviewNeverBecomesDeliveryAckCommit": not any(item["url"].endswith("/caller-turn/commit") for item in unsafe_requests),
        "missingRuntimeFailsClosed": missing_result["flowState"] == "wrap" and "pipecat-ai is missing" in missing_result["flowManagerRuntime"]["detail"],
        "missingRuntimeSkipsCallerTurnPreview": len(missing_requests) == 1 and missing_requests[0]["url"].endswith("/fallback"),
        "operatorHoldRemainsNonterminal": (
            held_result["flowState"] == "policy_hold"
            and held_result["flowManagerRuntime"]["commitPolicy"] == "caller_turn_held"
            and held_adapter.manager.current_node == "call_started"
            and held_adapter.pending_transition is None
            and not any(item["url"].endswith("/fallback") for item in held_requests)
        ),
        "deliveryAckPreviewPendingRemainsNonterminal": (
            delivery_ack_pending_result["flowManagerRuntime"]["commitPolicy"] == "caller_turn_held"
            and delivery_ack_pending_adapter.manager.current_node == "call_started"
            and delivery_ack_pending_adapter.pending_transition is None
            and not any(item["url"].endswith("/fallback") for item in delivery_ack_pending_requests)
        ),
        "endedCallRejectionDoesNotFailClosed": (
            ended_result["flowState"] == "wrap"
            and ended_result["flowManagerRuntime"]["commitPolicy"] == "caller_turn_terminal"
            and ended_result["flowManagerRuntime"]["terminal"] is True
            and ended_adapter.manager.current_node == "call_started"
            and ended_adapter.pending_transition is None
            and not any(item["url"].endswith("/fallback") for item in ended_requests)
        ),
        "releasedFailClosedResynchronizesFlowManager": (
            recovered_fail_closed["flowState"] == "wrap"
            and recovered_preview["flowState"] == "diagnose"
            and recovered_preview["flowManagerRuntime"]["pendingNode"] == "diagnose"
            and recovered_preview["flowManagerRuntime"]["resynchronizedFrom"] == "wrap"
            and recovered_preview["flowManagerRuntime"]["resynchronizedTo"] == "steered_response"
            and recovered_adapter.manager.current_node == "diagnose"
            and [step["to"] for step in recovered_adapter.transition_trace] == ["wrap", "steered_response", "diagnose"]
            and not any(item["url"].endswith("/fallback") for item in recovered_requests)
        ),
        "terminalHandoffCacheRevalidatedBeforeReplay": (
            terminal_cached["flowState"] == "wrap"
            and terminal_revalidated["flowState"] == "diagnose"
            and terminal_revalidated["flowManagerRuntime"]["resynchronizedFrom"] == "wrap"
            and terminal_revalidated["flowManagerRuntime"]["resynchronizedTo"] == "steered_response"
            and terminal_revalidation_adapter.manager.current_node == "diagnose"
            and terminal_revalidation_attempts == 2
            and [step["to"] for step in terminal_revalidation_adapter.transition_trace] == ["wrap", "steered_response", "diagnose"]
            and len([item for item in terminal_revalidation_requests if item["url"].endswith("/fallback")]) == 1
        ),
        "terminalOperatorReleaseResynchronizesFromHeldNode": (
            terminal_release_from_hold_preview["flowState"] == "diagnose"
            and terminal_release_from_hold_preview["flowManagerRuntime"]["resynchronizedFrom"] == "policy_hold"
            and terminal_release_from_hold_preview["flowManagerRuntime"]["resynchronizedTo"] == "steered_response"
            and terminal_release_from_hold_adapter.manager.current_node == "diagnose"
            and [step["to"] for step in terminal_release_from_hold_adapter.transition_trace]
            == ["greet", "diagnose", "policy_hold", "steered_response", "diagnose"]
            and not any(item["url"].endswith("/fallback") for item in terminal_release_from_hold_requests)
        ),
        "requiredVersionsRecorded": normal_results[0]["flowManagerRuntime"]["runtimeVersions"] == {"pipecat-ai": "1.7.0", },
    }
    return {
        "ok": all(checks.values()),
        "runtimeAdapter": "pipecat.flows.FlowManager",
        "requiredVersions": {"pipecat-ai": "1.7.0", },
        "normalTransitionTrace": adapter.transition_trace,
        "normalPreviewRequests": len(requests),
        "structuredRoutingEvidence": structured_preview["flowManagerRuntime"],
        "unsafeEvidence": unsafe_result["flowManagerRuntime"],
        "missingRuntimeEvidence": missing_result["flowManagerRuntime"],
        "heldEvidence": held_result["flowManagerRuntime"],
        "deliveryAckPendingEvidence": delivery_ack_pending_result["flowManagerRuntime"],
        "endedEvidence": ended_result["flowManagerRuntime"],
        "recoveredEvidence": recovered_preview["flowManagerRuntime"],
        "terminalRevalidatedEvidence": terminal_revalidated["flowManagerRuntime"],
        "terminalReleaseFromHeldNodeEvidence": terminal_release_from_hold_preview["flowManagerRuntime"],
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
