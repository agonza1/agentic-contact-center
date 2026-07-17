#!/usr/bin/env python3
"""Pipecat Flows ownership boundary for ACC caller turns.

The adapter deliberately keeps customer/product state in ACC. It owns the
conversation-node activation and transition guard around ACC's delivery-ack
preview response, using the real ``pipecat_flows.FlowManager`` runtime.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.metadata
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Callable


FLOW_MANAGER_REQUIRED_VERSIONS = {
    "pipecat-ai": "1.4.0",
    "pipecat-ai-flows": "1.4.0",
}

FLOW_MANAGER_ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "call_started": {"call_started", "greet", "diagnose", "wrap"},
    "greet": {"greet", "diagnose", "wrap"},
    "diagnose": {"diagnose", "policy_hold", "wrap"},
    "policy_hold": {"policy_hold", "operator_steer", "wrap"},
    "operator_steer": {"operator_steer", "steered_response", "wrap"},
    "steered_response": {"steered_response", "wrap"},
    "wrap": {"wrap"},
}

FLOW_MANAGER_NODE_INTENTS = {
    "call_started": "Bootstrap the call and wait for the first caller transcript.",
    "greet": "Acknowledge the caller without offering unapproved retention terms.",
    "diagnose": "Collect the cancellation reason and classify the safe next step.",
    "policy_hold": "Fail closed before any unapproved retention offer language.",
    "operator_steer": "Wait for ACC-owned bounded operator approval or denial.",
    "steered_response": "Deliver only the bounded response approved by ACC operator controls.",
    "wrap": "Stop automated retention handling and preserve handoff or close proof.",
}


class FlowManagerRuntimeError(RuntimeError):
    """Raised when the required Flows runtime cannot safely own a turn."""


@dataclass
class FlowManagerFrameSink:
    """Sink FlowManager's LLM-control frames for ACC's deterministic response path.

    ACC does not put an LLM service in the media Pipeline. FlowManager still owns
    node state and transition validation, while this sink records the context/tool
    frames it would otherwise send to an LLM processor.
    """

    queued_frame_types: list[str] = field(default_factory=list)
    reached_downstream_filter: tuple[type[Any], ...] = field(default_factory=tuple)
    event_handlers: dict[str, list[Callable[..., Any]]] = field(default_factory=dict)

    def set_reached_downstream_filter(self, frame_types: tuple[type[Any], ...]) -> None:
        self.reached_downstream_filter = frame_types

    def event_handler(self, event_name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def register(handler: Callable[..., Any]) -> Callable[..., Any]:
            self.event_handlers.setdefault(event_name, []).append(handler)
            return handler

        return register

    async def queue_frame(self, frame: Any) -> None:
        self.queued_frame_types.append(type(frame).__name__)

    async def queue_frames(self, frames: list[Any]) -> None:
        self.queued_frame_types.extend(type(frame).__name__ for frame in frames)


def flow_manager_node_config(node: str) -> dict[str, Any]:
    if node not in FLOW_MANAGER_NODE_INTENTS:
        raise FlowManagerRuntimeError(f"unknown FlowManager node: {node}")
    return {
        "name": node,
        "task_messages": [{"role": "developer", "content": FLOW_MANAGER_NODE_INTENTS[node]}],
        "functions": [],
        "respond_immediately": False,
    }


class AccPipecatFlowManagerAdapter:
    """Authorize ACC caller-turn previews through Pipecat FlowManager nodes."""

    def __init__(
        self,
        *,
        acc_url: str,
        call_id: str,
        request_json: Callable[..., dict[str, Any]],
        manager_factory: Callable[..., Any] | None = None,
        version_provider: Callable[[str], str] = importlib.metadata.version,
    ) -> None:
        self.acc_url = acc_url.rstrip("/")
        self.call_id = call_id
        self.request_json = request_json
        self.manager_factory = manager_factory
        self.version_provider = version_provider
        self.frame_sink = FlowManagerFrameSink()
        self.manager: Any | None = None
        self.initialized = False
        self.pending_transition: dict[str, Any] | None = None
        self._transition_available = asyncio.Event()
        self._transition_available.set()
        self._preview_lock = asyncio.Lock()
        self.transition_trace: list[dict[str, Any]] = []
        self.last_evidence: dict[str, Any] = {}

    def runtime_versions(self) -> dict[str, str]:
        versions: dict[str, str] = {}
        for package, required in FLOW_MANAGER_REQUIRED_VERSIONS.items():
            try:
                versions[package] = self.version_provider(package)
            except importlib.metadata.PackageNotFoundError as exc:
                raise FlowManagerRuntimeError(
                    f"{package} is missing; install {package}=={required} from requirements-pipecat-voice.txt"
                ) from exc
        mismatches = [
            f"{package}=={actual} (required {required})"
            for package, required in FLOW_MANAGER_REQUIRED_VERSIONS.items()
            if (actual := versions[package]) != required
        ]
        if mismatches:
            raise FlowManagerRuntimeError("Pipecat Flows version mismatch: " + ", ".join(mismatches))
        return versions

    def resolve_manager_factory(self) -> Callable[..., Any]:
        if self.manager_factory is not None:
            return self.manager_factory
        try:
            module = importlib.import_module("pipecat_flows")
            factory = getattr(module, "FlowManager")
        except (ImportError, AttributeError) as exc:
            raise FlowManagerRuntimeError(
                "pipecat_flows.FlowManager is unavailable; install pipecat-ai-flows==1.4.0"
            ) from exc
        return factory

    async def initialize(self) -> None:
        if self.initialized:
            return
        versions = self.runtime_versions()
        factory = self.resolve_manager_factory()
        self.manager = factory(
            llm=object(),
            context_aggregator=None,
            worker=self.frame_sink,
        )
        await self.manager.initialize(flow_manager_node_config("call_started"))
        self.initialized = True
        self.last_evidence = {
            "ok": True,
            "runtimeAdapter": "pipecat_flows.FlowManager",
            "runtimeVersions": versions,
            "currentNode": self.manager.current_node,
            "retainedAccOwnership": ["product_state", "operator_controls", "proof_artifacts", "queue_state"],
            "queuedFrameTypes": list(self.frame_sink.queued_frame_types),
        }

    def validate_transition(self, target_node: str) -> str:
        if not self.manager or not self.initialized:
            raise FlowManagerRuntimeError("FlowManager must be initialized before activating a node")
        current_node = self.manager.current_node
        if current_node not in FLOW_MANAGER_ALLOWED_TRANSITIONS:
            raise FlowManagerRuntimeError(f"FlowManager current node is invalid: {current_node}")
        if target_node not in FLOW_MANAGER_ALLOWED_TRANSITIONS[current_node]:
            raise FlowManagerRuntimeError(f"unsafe FlowManager transition rejected: {current_node}->{target_node}")
        return current_node

    async def activate_node(self, target_node: str, *, reason: str) -> None:
        current_node = self.validate_transition(target_node)
        await self.manager.set_node_from_config(flow_manager_node_config(target_node))
        transition = {
            "from": current_node,
            "to": target_node,
            "reason": reason,
            "at": datetime.now(UTC).isoformat(timespec="milliseconds"),
        }
        self.transition_trace.append(transition)
        self.last_evidence = {
            **self.last_evidence,
            "ok": True,
            "currentNode": self.manager.current_node,
            "lastTransition": transition,
            "transitionCount": len(self.transition_trace),
            "queuedFrameTypes": list(self.frame_sink.queued_frame_types),
        }

    def stage_transition(self, target_node: str, *, reason: str) -> None:
        if self.pending_transition is not None:
            raise FlowManagerRuntimeError("FlowManager already has a pending delivery-ack transition")
        current_node = self.validate_transition(target_node)
        self.pending_transition = {
            "from": current_node,
            "to": target_node,
            "reason": reason,
            "stagedAt": datetime.now(UTC).isoformat(timespec="milliseconds"),
        }
        self._transition_available.clear()
        self.last_evidence = {
            **self.last_evidence,
            "ok": True,
            "currentNode": current_node,
            "pendingNode": target_node,
            "pendingTransition": dict(self.pending_transition),
            "transitionCount": len(self.transition_trace),
        }

    async def prepare_pending_transition(self) -> dict[str, Any]:
        pending = self.pending_transition
        if pending is None:
            raise FlowManagerRuntimeError("FlowManager has no pending delivery-ack transition")
        try:
            await self.activate_node(pending["to"], reason="caller_turn_delivery_ack")
        except asyncio.CancelledError:
            await self._restore_prepared_transition(pending, "delivery_ack_activation_cancelled")
            raise
        except Exception as exc:
            return (await self.fail_closed(exc))["flowManagerRuntime"]
        if self.pending_transition is not pending or pending.get("discardRequested"):
            await self._restore_prepared_transition(
                pending,
                pending.get("discardReason", "delivery_ack_cancelled_before_audio"),
            )
            return self.last_evidence
        pending["activated"] = True
        self.last_evidence = {
            **self.last_evidence,
            "pendingNode": pending["to"],
            "pendingTransition": dict(pending),
            "commitPolicy": "transition_prepared_until_audio_delivery_ack",
        }
        return self.last_evidence

    def finalize_pending_transition(self) -> dict[str, Any]:
        pending = self.pending_transition
        if pending is None or pending.get("activated") is not True:
            raise FlowManagerRuntimeError("FlowManager has no prepared delivery-ack transition")
        self.pending_transition = None
        self._transition_available.set()
        self.last_evidence = {
            **self.last_evidence,
            "pendingNode": None,
            "pendingTransition": None,
            "commitPolicy": "delivery_ack_committed",
        }
        return self.last_evidence

    async def commit_pending_transition(self) -> dict[str, Any]:
        """Compatibility helper for non-media contract checks.

        The media pipeline uses prepare_pending_transition() and finalizes only
        after first-audio delivery plus the ACC acknowledgement.
        """
        prepared = await self.prepare_pending_transition()
        if prepared.get("ok") is not True:
            return prepared
        if self.pending_transition is None or self.pending_transition.get("activated") is not True:
            return prepared
        return self.finalize_pending_transition()

    async def _restore_prepared_transition(self, pending: dict[str, Any], reason: str) -> None:
        previous_node = pending["from"]
        current_node = getattr(self.manager, "current_node", None)
        if self.manager and self.initialized and current_node != previous_node:
            try:
                await self.manager.set_node_from_config(flow_manager_node_config(previous_node))
            except Exception as exc:
                await self.fail_closed(
                    FlowManagerRuntimeError(f"FlowManager delivery rollback failed after {reason}: {exc}")
                )
                return
        if self.pending_transition is pending:
            self.pending_transition = None
            self._transition_available.set()
        self.last_evidence = {
            **self.last_evidence,
            "ok": True,
            "currentNode": getattr(self.manager, "current_node", previous_node),
            "pendingNode": None,
            "pendingTransition": None,
            "commitPolicy": "preview_discarded",
            "discardReason": reason,
            "rolledBackPreparedTransition": current_node != previous_node,
        }

    async def rollback_pending_transition(self, reason: str) -> dict[str, Any]:
        pending = self.pending_transition
        if pending is None:
            return self.last_evidence
        await self._restore_prepared_transition(pending, reason)
        return self.last_evidence

    def discard_pending_transition(self, reason: str) -> None:
        pending = self.pending_transition
        if pending is None:
            return
        if pending.get("activated") is True:
            pending["discardRequested"] = True
            pending["discardReason"] = reason
            self.last_evidence = {
                **self.last_evidence,
                "pendingTransition": dict(pending),
                "commitPolicy": "prepared_transition_rollback_pending",
                "discardReason": reason,
            }
            return
        self.pending_transition = None
        self._transition_available.set()
        self.last_evidence = {
            **self.last_evidence,
            "currentNode": getattr(self.manager, "current_node", None),
            "pendingNode": None,
            "pendingTransition": None,
            "commitPolicy": "preview_discarded",
            "discardReason": reason,
        }

    async def request(self, method: str, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await asyncio.to_thread(self.request_json, method, url, payload)

    async def fail_closed(self, error: Exception) -> dict[str, Any]:
        self.pending_transition = None
        self._transition_available.set()
        fallback = await self.request(
            "POST",
            f"{self.acc_url}/api/calls/{self.call_id}/fallback",
            {
                "mode": "runtime_failure",
                "reason": f"Pipecat FlowManager fail-closed: {error}",
            },
        )
        if self.manager and self.initialized:
            try:
                await self.activate_node("wrap", reason="flowmanager_runtime_failure")
            except Exception:
                pass
        evidence = {
            "ok": False,
            "runtimeAdapter": "pipecat_flows.FlowManager",
            "error": "flowmanager_runtime_failed_closed",
            "detail": str(error),
            "currentNode": getattr(self.manager, "current_node", None),
            "fallbackNode": "wrap",
            "commitPolicy": "terminal_handoff",
            "retainedAccOwnership": ["product_state", "operator_controls", "proof_artifacts", "queue_state"],
        }
        self.last_evidence = evidence
        return {**fallback, "flowManagerRuntime": evidence}

    async def preview_caller_turn(self, *, text: str, conversation_mode: str) -> dict[str, Any]:
        try:
            await self.initialize()
            async with self._preview_lock:
                # A delivered response may still be waiting for ACC's slow
                # acknowledgement. Queue the next preview behind that exact
                # transition so it is evaluated from the committed node instead
                # of colliding with the single pending slot and failing closed.
                await self._transition_available.wait()
                preview = await self.request(
                    "POST",
                    f"{self.acc_url}/api/calls/{self.call_id}/caller-turn",
                    {
                        "text": text,
                        "conversationMode": conversation_mode,
                        "commitMode": "delivery_ack",
                    },
                )
                target_node = preview.get("flowState")
                if not isinstance(target_node, str):
                    raise FlowManagerRuntimeError("ACC caller-turn preview did not return flowState")
                self.stage_transition(target_node, reason="caller_turn_preview")
                evidence = {
                    **self.last_evidence,
                    "commitPolicy": "preview_until_output_delivery_ack",
                    "callerTranscript": text,
                }
                self.last_evidence = evidence
                return {**preview, "flowManagerRuntime": evidence}
        except Exception as exc:
            return await self.fail_closed(exc)
