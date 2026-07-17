#!/usr/bin/env python3
"""Deterministic transport-output streaming and barge-in regression proof."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"
sys.path.insert(0, str(RUNTIME_PATH))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from pipecat.frames.frames import TextFrame, TranscriptionFrame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection

import acc_pipecat_voice_pipeline as pipeline
from acc_pipecat_flow_manager import AccPipecatFlowManagerAdapter
from acc_pipecat_voice_pipeline import AccCallerTurnProcessor, AccVoicePipelineSession, KokoroTtsProcessor


SAMPLE_RATE = 24_000
CHUNK_MS = 20
CHUNK_BYTES = SAMPLE_RATE * 2 * CHUNK_MS // 1000


class CapturingTtsProcessor(KokoroTtsProcessor):
    def __init__(
        self,
        session: AccVoicePipelineSession,
        *,
        pause_after_first_chunk: bool = False,
        block_first_audio: bool = False,
    ):
        super().__init__(session)
        self.frames: list[Any] = []
        self.pause_after_first_chunk = pause_after_first_chunk
        self.block_first_audio = block_first_audio
        self.first_chunk = asyncio.Event()

    async def push_frame(self, frame: Any, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        self.frames.append(frame)
        if (self.pause_after_first_chunk or self.block_first_audio) and isinstance(frame, TTSAudioRawFrame):
            self.first_chunk.set()
        if self.block_first_audio and isinstance(frame, TTSAudioRawFrame):
            await asyncio.sleep(60)


class CapturingCallerTurnProcessor(AccCallerTurnProcessor):
    def __init__(self, session: AccVoicePipelineSession):
        super().__init__(session)
        self.frames: list[Any] = []

    async def push_frame(self, frame: Any, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        self.frames.append(frame)


class FakeFlowManager:
    def __init__(self, **_kwargs: Any):
        self.current_node: str | None = None

    async def initialize(self, initial_node: dict[str, Any]) -> None:
        self.current_node = initial_node["name"]

    async def set_node_from_config(self, node: dict[str, Any]) -> None:
        self.current_node = node["name"]


class FailingFlowManager(FakeFlowManager):
    async def set_node_from_config(self, node: dict[str, Any]) -> None:
        raise RuntimeError(f"fixture set_node_from_config failure for {node['name']}")


class FailingGreetFlowManager(FakeFlowManager):
    async def set_node_from_config(self, node: dict[str, Any]) -> None:
        if node["name"] == "greet":
            raise RuntimeError("fixture greet activation failure")
        self.current_node = node["name"]


class SlowActivatingFlowManager(FakeFlowManager):
    def __init__(self, **kwargs: Any):
        super().__init__(**kwargs)
        self.activation_started = asyncio.Event()

    async def set_node_from_config(self, node: dict[str, Any]) -> None:
        self.current_node = node["name"]
        if node["name"] != "call_started":
            self.activation_started.set()
            await asyncio.sleep(60)


class FakeTurnControls:
    def __init__(self) -> None:
        self.bot_speaking = False
        self.started = 0
        self.stopped = 0

    async def bot_started(self) -> None:
        self.bot_speaking = True
        self.started += 1

    async def bot_stopped(self) -> None:
        self.bot_speaking = False
        self.stopped += 1


def build_session(call_id: str, *, manager_factory: type[FakeFlowManager] = FakeFlowManager) -> AccVoicePipelineSession:
    flow_manager = AccPipecatFlowManagerAdapter(
        acc_url="http://127.0.0.1:8026",
        call_id=call_id,
        request_json=lambda method, url, payload: pipeline.json_http(method, url, payload),
        manager_factory=manager_factory,
        version_provider=lambda _package: "1.4.0",
    )
    return AccVoicePipelineSession(
        acc_url="http://127.0.0.1:8026",
        call_id=call_id,
        readiness=SimpleNamespace(stt_model="fixture", stt_backend="fixture"),
        flow_manager_adapter=flow_manager,
    )


def install_fake_synthesizer(session: AccVoicePipelineSession, *, chunks: int) -> None:
    pcm_chunk = b"\x20\x00" * (CHUNK_BYTES // 2)

    async def stream_synthesize(_frame: TextFrame, *, chunk_bytes: int):
        assert chunk_bytes == CHUNK_BYTES
        for index in range(chunks):
            yield pcm_chunk, SAMPLE_RATE, {
                "engine": "kokoro-fixture",
                "sampleRate": SAMPLE_RATE,
                "format": "pcm_s16le",
                "providerStream": True,
                "firstAudioMs": 1,
                "elapsedMs": index + 1,
            }

    session.stream_synthesize = stream_synthesize  # type: ignore[method-assign]


async def run_regression(*, live_kokoro: bool = False) -> dict[str, Any]:
    os.environ["ACC_TTS_OUTPUT_CHUNK_YIELD_MS"] = "5"
    delivery_commit_calls: list[dict[str, Any]] = []
    original_json_http = pipeline.json_http

    def fake_delivery_commit_http(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
        if method == "POST" and url.endswith("/caller-turn/commit"):
            delivery_commit_calls.append(payload or {})
            return {
                "flowState": "diagnose",
                "transcript": [
                    {"speaker": "caller", "text": (payload or {}).get("text", ""), "timestamp": "fixture"},
                    {"speaker": "agent", "text": "Delivered response after acknowledgement.", "timestamp": "fixture"},
                ],
            }
        return original_json_http(method, url, payload, timeout)

    normal_session = build_session("output-normal")
    if not live_kokoro:
        install_fake_synthesizer(normal_session, chunks=6)
    await normal_session.flow_manager_adapter.initialize()
    normal_session.flow_manager_adapter.stage_transition("diagnose", reason="caller_turn_preview")
    normal_session.set_pending_caller_turn_commit(
        payload={"text": "Normal caller turn", "conversationMode": "free_caller"},
        expected_agent_text="Delivered response after acknowledgement.",
        output_generation=normal_session.output_generation,
    )
    normal_processor = CapturingTtsProcessor(normal_session)
    pipeline.json_http = fake_delivery_commit_http
    try:
        await normal_processor.process_frame(
            TextFrame("Delivered response after acknowledgement."),
            FrameDirection.DOWNSTREAM,
        )
    finally:
        pipeline.json_http = original_json_http
    normal_audio = [frame for frame in normal_processor.frames if isinstance(frame, TTSAudioRawFrame)]

    slow_commit_started = threading.Event()
    release_slow_commit = threading.Event()
    slow_commit_calls: list[dict[str, Any]] = []

    def fake_slow_delivery_http(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
        if method == "POST" and url.endswith("/caller-turn/commit"):
            slow_commit_started.set()
            release_slow_commit.wait(1)
            slow_commit_calls.append(payload or {})
            return {
                "flowState": "greet",
                "transcript": [
                    {"speaker": "caller", "text": (payload or {}).get("text", ""), "timestamp": "fixture"},
                    {"speaker": "agent", "text": "First audio was delivered before this slow commit.", "timestamp": "fixture"},
                ],
            }
        return original_json_http(method, url, payload, timeout)

    slow_commit_session = build_session("slow-commit-barge-in-after-audio")
    install_fake_synthesizer(slow_commit_session, chunks=4)
    await slow_commit_session.flow_manager_adapter.initialize()
    slow_commit_session.flow_manager_adapter.stage_transition("greet", reason="caller_turn_preview")
    slow_commit_session.set_pending_caller_turn_commit(
        payload={"text": "Cancel after the response starts", "conversationMode": "free_caller"},
        expected_agent_text="First audio was delivered before this slow commit.",
        output_generation=slow_commit_session.output_generation,
    )
    slow_commit_processor = CapturingTtsProcessor(slow_commit_session)
    pipeline.json_http = fake_slow_delivery_http
    try:
        slow_commit_task = asyncio.create_task(
            slow_commit_processor.process_frame(
                TextFrame("First audio was delivered before this slow commit."),
                FrameDirection.DOWNSTREAM,
            )
        )
        assert await asyncio.to_thread(slow_commit_started.wait, 1)
        slow_commit_audio_before_cancel = len(
            [frame for frame in slow_commit_processor.frames if isinstance(frame, TTSAudioRawFrame)]
        )
        slow_commit_cancellation = slow_commit_session.cancel_output("fixture_barge_in_during_slow_commit")
        release_slow_commit.set()
        slow_commit_result = await asyncio.gather(slow_commit_task, return_exceptions=True)
    finally:
        release_slow_commit.set()
        pipeline.json_http = original_json_http
    slow_commit_stages = slow_commit_session.stage_events

    followup_commit_started = threading.Event()
    release_followup_commit = threading.Event()
    followup_commit_calls: list[dict[str, Any]] = []
    followup_preview_calls: list[dict[str, Any]] = []
    followup_fallback_calls: list[dict[str, Any]] = []

    def fake_followup_during_commit_http(
        method: str,
        url: str,
        payload: dict[str, Any] | None = None,
        timeout: float = 30,
    ) -> dict[str, Any]:
        if method == "POST" and url.endswith("/caller-turn/commit"):
            followup_commit_started.set()
            release_followup_commit.wait(1)
            followup_commit_calls.append(payload or {})
            return {
                "flowState": "greet",
                "transcript": [
                    {"speaker": "caller", "text": (payload or {}).get("text", ""), "timestamp": "fixture"},
                    {"speaker": "agent", "text": "The prior delivered turn is committed.", "timestamp": "fixture"},
                ],
            }
        if method == "POST" and url.endswith("/caller-turn"):
            followup_preview_calls.append(payload or {})
            return {
                "flowState": "diagnose",
                "callerTurnCommit": {"mode": "delivery_ack", "status": "pending", "timestamp": "fixture"},
                "transcript": [
                    {"speaker": "caller", "text": (payload or {}).get("text", ""), "timestamp": "fixture"},
                    {"speaker": "agent", "text": "The follow-up turn staged normally.", "timestamp": "fixture"},
                ],
            }
        if method == "POST" and url.endswith("/fallback"):
            followup_fallback_calls.append(payload or {})
            return {"flowState": "wrap", "transcript": []}
        return original_json_http(method, url, payload, timeout)

    followup_session = build_session("followup-during-slow-delivery-commit")
    install_fake_synthesizer(followup_session, chunks=3)
    await followup_session.flow_manager_adapter.initialize()
    followup_session.flow_manager_adapter.stage_transition("greet", reason="caller_turn_preview")
    followup_session.set_pending_caller_turn_commit(
        payload={"text": "Prior caller turn", "conversationMode": "free_caller"},
        expected_agent_text="The prior delivered turn is committed.",
        output_generation=followup_session.output_generation,
    )
    followup_processor = CapturingTtsProcessor(followup_session)
    followup_preview_started = asyncio.Event()

    async def preview_followup_turn() -> dict[str, Any]:
        followup_preview_started.set()
        return await followup_session.flow_manager_adapter.preview_caller_turn(
            text="Legitimate follow-up caller turn",
            conversation_mode="free_caller",
        )

    pipeline.json_http = fake_followup_during_commit_http
    try:
        followup_delivery_task = asyncio.create_task(
            followup_processor.process_frame(
                TextFrame("The prior delivered turn is committed."),
                FrameDirection.DOWNSTREAM,
            )
        )
        assert await asyncio.to_thread(followup_commit_started.wait, 1)
        followup_barge_in = followup_session.cancel_output("fixture_followup_during_slow_delivery_commit")
        followup_preview_task = asyncio.create_task(preview_followup_turn())
        await asyncio.wait_for(followup_preview_started.wait(), timeout=1)
        await asyncio.sleep(0)
        followup_waited_for_prior_ack = not followup_preview_task.done() and not followup_preview_calls
        release_followup_commit.set()
        followup_delivery_result = await asyncio.gather(followup_delivery_task, return_exceptions=True)
        followup_preview_result = await asyncio.wait_for(followup_preview_task, timeout=1)
    finally:
        release_followup_commit.set()
        pipeline.json_http = original_json_http

    fail_closed_started = threading.Event()
    release_fail_closed = threading.Event()
    fail_closed_fallback_calls: list[dict[str, Any]] = []
    fail_closed_preview_calls: list[dict[str, Any]] = []

    def fake_queued_fail_closed_http(
        method: str,
        url: str,
        payload: dict[str, Any] | None = None,
        timeout: float = 30,
    ) -> dict[str, Any]:
        if method == "POST" and url.endswith("/fallback"):
            fail_closed_started.set()
            release_fail_closed.wait(1)
            fail_closed_fallback_calls.append(payload or {})
            return {
                "flowState": "wrap",
                "transcript": [{"speaker": "agent", "text": "Human handoff started.", "timestamp": "fixture"}],
            }
        if method == "POST" and url.endswith("/caller-turn"):
            fail_closed_preview_calls.append(payload or {})
            return {
                "flowState": "diagnose",
                "callerTurnCommit": {"mode": "delivery_ack", "status": "pending", "timestamp": "fixture"},
                "transcript": [],
            }
        return original_json_http(method, url, payload, timeout)

    fail_closed_session = build_session(
        "queued-preview-during-flowmanager-fail-closed",
        manager_factory=FailingGreetFlowManager,
    )
    await fail_closed_session.flow_manager_adapter.initialize()
    fail_closed_session.flow_manager_adapter.stage_transition("greet", reason="caller_turn_preview")
    pipeline.json_http = fake_queued_fail_closed_http
    try:
        fail_closed_prepare_task = asyncio.create_task(
            fail_closed_session.flow_manager_adapter.prepare_pending_transition()
        )
        assert await asyncio.to_thread(fail_closed_started.wait, 1)
        fail_closed_preview_task = asyncio.create_task(
            fail_closed_session.flow_manager_adapter.preview_caller_turn(
                text="Queue this caller turn behind fail-closed",
                conversation_mode="free_caller",
            )
        )
        await asyncio.sleep(0)
        fail_closed_preview_waited = not fail_closed_preview_task.done() and not fail_closed_preview_calls
        fail_closed_prepare_task.cancel()
        await asyncio.sleep(0)
        fail_closed_cancellation_waited_for_cleanup = not fail_closed_prepare_task.done()
        release_fail_closed.set()
        fail_closed_prepare_result = await asyncio.wait_for(
            asyncio.gather(fail_closed_prepare_task, return_exceptions=True),
            timeout=1,
        )
        fail_closed_preview_result = await asyncio.wait_for(fail_closed_preview_task, timeout=1)
    finally:
        release_fail_closed.set()
        pipeline.json_http = original_json_http

    failing_cancel_commit_started = threading.Event()
    release_failing_cancel_commit = threading.Event()
    failing_cancel_commit_calls: list[dict[str, Any]] = []

    def fake_failing_cancel_delivery_http(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
        if method == "POST" and url.endswith("/caller-turn/commit"):
            failing_cancel_commit_started.set()
            release_failing_cancel_commit.wait(1)
            failing_cancel_commit_calls.append(payload or {})
            raise RuntimeError("fixture delivery commit failed after cancellation")
        return original_json_http(method, url, payload, timeout)

    failing_cancel_session = build_session("failed-commit-after-barge-in")
    install_fake_synthesizer(failing_cancel_session, chunks=3)
    await failing_cancel_session.flow_manager_adapter.initialize()
    failing_cancel_session.flow_manager_adapter.stage_transition("greet", reason="caller_turn_preview")
    failing_cancel_session.set_pending_caller_turn_commit(
        payload={"text": "Cancel while commit fails", "conversationMode": "free_caller"},
        expected_agent_text="The first chunk was delivered but commit fails.",
        output_generation=failing_cancel_session.output_generation,
    )
    failing_cancel_processor = CapturingTtsProcessor(failing_cancel_session)
    pipeline.json_http = fake_failing_cancel_delivery_http
    try:
        failing_cancel_task = asyncio.create_task(
            failing_cancel_processor.process_frame(
                TextFrame("The first chunk was delivered but commit fails."),
                FrameDirection.DOWNSTREAM,
            )
        )
        assert await asyncio.to_thread(failing_cancel_commit_started.wait, 1)
        failing_cancel_barge_in = failing_cancel_session.cancel_output("fixture_barge_in_during_failed_commit")
        release_failing_cancel_commit.set()
        failing_cancel_result = await asyncio.gather(failing_cancel_task, return_exceptions=True)
    finally:
        release_failing_cancel_commit.set()
        pipeline.json_http = original_json_http
    failing_cancel_stages = failing_cancel_session.stage_events

    repeated_cancel_commit_started = threading.Event()
    release_repeated_cancel_commit = threading.Event()
    repeated_cancel_commit_calls: list[dict[str, Any]] = []

    def fake_repeated_cancel_delivery_http(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
        if method == "POST" and url.endswith("/caller-turn/commit"):
            repeated_cancel_commit_started.set()
            release_repeated_cancel_commit.wait(1)
            repeated_cancel_commit_calls.append(payload or {})
            return {
                "flowState": "greet",
                "transcript": [
                    {"speaker": "caller", "text": (payload or {}).get("text", ""), "timestamp": "fixture"},
                    {"speaker": "agent", "text": "Repeated cancellation still cleans up.", "timestamp": "fixture"},
                ],
            }
        return original_json_http(method, url, payload, timeout)

    repeated_cancel_session = build_session("repeated-cancel-during-delivery-commit")
    install_fake_synthesizer(repeated_cancel_session, chunks=3)
    await repeated_cancel_session.flow_manager_adapter.initialize()
    repeated_cancel_session.flow_manager_adapter.stage_transition("greet", reason="caller_turn_preview")
    repeated_cancel_session.set_pending_caller_turn_commit(
        payload={"text": "Cancel twice while commit finishes", "conversationMode": "free_caller"},
        expected_agent_text="Repeated cancellation still cleans up.",
        output_generation=repeated_cancel_session.output_generation,
    )
    repeated_cancel_processor = CapturingTtsProcessor(repeated_cancel_session)
    pipeline.json_http = fake_repeated_cancel_delivery_http
    try:
        repeated_cancel_task = asyncio.create_task(
            repeated_cancel_processor.process_frame(
                TextFrame("Repeated cancellation still cleans up."),
                FrameDirection.DOWNSTREAM,
            )
        )
        assert await asyncio.to_thread(repeated_cancel_commit_started.wait, 1)
        repeated_cancel_barge_in = repeated_cancel_session.cancel_output("fixture_barge_in_during_repeated_cancel_commit")
        repeated_cancel_task.cancel()
        release_repeated_cancel_commit.set()
        repeated_cancel_result = await asyncio.gather(repeated_cancel_task, return_exceptions=True)
    finally:
        release_repeated_cancel_commit.set()
        pipeline.json_http = original_json_http
    repeated_cancel_stages = repeated_cancel_session.stage_events

    stale_commit_started = threading.Event()
    release_stale_commit = threading.Event()
    stale_commit_calls: list[dict[str, Any]] = []

    def fake_stale_delivery_http(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
        if method == "POST" and url.endswith("/caller-turn/commit"):
            stale_commit_started.set()
            release_stale_commit.wait(1)
            stale_commit_calls.append(payload or {})
            return {
                "flowState": "greet",
                "transcript": [
                    {"speaker": "caller", "text": (payload or {}).get("text", ""), "timestamp": "fixture"},
                    {"speaker": "agent", "text": "Old commit finishes late.", "timestamp": "fixture"},
                ],
            }
        return original_json_http(method, url, payload, timeout)

    stale_session = build_session("stale-delivery-commit-newer-turn")
    install_fake_synthesizer(stale_session, chunks=3)
    await stale_session.flow_manager_adapter.initialize()
    stale_session.flow_manager_adapter.stage_transition("greet", reason="caller_turn_preview")
    stale_session.set_pending_caller_turn_commit(
        payload={"text": "Old caller turn", "conversationMode": "free_caller"},
        expected_agent_text="Old commit finishes late.",
        output_generation=stale_session.output_generation,
    )
    stale_processor = CapturingTtsProcessor(stale_session)
    pipeline.json_http = fake_stale_delivery_http
    try:
        stale_task = asyncio.create_task(
            stale_processor.process_frame(
                TextFrame("Old commit finishes late."),
                FrameDirection.DOWNSTREAM,
            )
        )
        assert await asyncio.to_thread(stale_commit_started.wait, 1)
        stale_barge_in = stale_session.cancel_output("fixture_barge_in_before_newer_turn")
        stale_session.set_pending_caller_turn_commit(
            payload={"text": "Newer caller turn", "conversationMode": "free_caller"},
            expected_agent_text="Newer answer must remain pending.",
            output_generation=stale_session.output_generation,
        )
        release_stale_commit.set()
        stale_result = await asyncio.gather(stale_task, return_exceptions=True)
    finally:
        release_stale_commit.set()
        pipeline.json_http = original_json_http
    stale_stages = stale_session.stage_events

    failed_delivery_requests: list[str] = []

    def fake_failed_delivery_http(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
        if method == "POST" and url.endswith("/caller-turn/commit"):
            failed_delivery_requests.append("commit")
            return {
                "flowState": "greet",
                "transcript": [
                    {"speaker": "caller", "text": (payload or {}).get("text", ""), "timestamp": "fixture"},
                    {"speaker": "agent", "text": "Original preview must not reach the caller.", "timestamp": "fixture"},
                ],
            }
        if method == "POST" and url.endswith("/fallback"):
            failed_delivery_requests.append("fallback")
            return {
                "flowState": "wrap",
                "transcript": [{"speaker": "agent", "text": "Human handoff started.", "timestamp": "fixture"}],
            }
        return original_json_http(method, url, payload, timeout)

    failed_delivery_session = build_session(
        "flowmanager-activation-failed-after-acc-commit",
        manager_factory=FailingFlowManager,
    )
    failed_turn_controls = FakeTurnControls()
    failed_delivery_session.turn_controls = failed_turn_controls  # type: ignore[assignment]
    install_fake_synthesizer(failed_delivery_session, chunks=2)
    await failed_delivery_session.flow_manager_adapter.initialize()
    failed_delivery_session.flow_manager_adapter.stage_transition("greet", reason="caller_turn_preview")
    failed_delivery_session.set_pending_caller_turn_commit(
        payload={"text": "Cancel my account", "conversationMode": "free_caller"},
        expected_agent_text="Original preview must not reach the caller.",
        output_generation=failed_delivery_session.output_generation,
    )
    failed_delivery_processor = CapturingTtsProcessor(failed_delivery_session)
    pipeline.json_http = fake_failed_delivery_http
    try:
        await failed_delivery_processor.process_frame(
            TextFrame("Original preview must not reach the caller."),
            FrameDirection.DOWNSTREAM,
        )
    finally:
        pipeline.json_http = original_json_http
    failed_delivery_audio = [frame for frame in failed_delivery_processor.frames if isinstance(frame, TTSAudioRawFrame)]
    failed_delivery_started = [frame for frame in failed_delivery_processor.frames if isinstance(frame, TTSStartedFrame)]
    failed_delivery_stopped = [frame for frame in failed_delivery_processor.frames if isinstance(frame, TTSStoppedFrame)]
    failed_delivery_stages = [event["stage"] for event in failed_delivery_session.stage_events]

    fallback_failure_requests: list[str] = []

    def fake_fallback_failure_http(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
        if method == "POST" and url.endswith("/fallback"):
            fallback_failure_requests.append("fallback")
            raise RuntimeError("fixture FlowManager fallback request failed")
        if method == "POST" and url.endswith("/caller-turn"):
            fallback_failure_requests.append("caller-turn")
            return {
                "flowState": "greet",
                "transcript": [
                    {"speaker": "caller", "text": (payload or {}).get("text", ""), "timestamp": "fixture"},
                    {"speaker": "agent", "text": "ACC accepted the later caller turn.", "timestamp": "fixture"},
                ],
                "callerTurnCommit": {"snapshotVersion": 2},
            }
        return original_json_http(method, url, payload, timeout)

    fallback_failure_session = build_session(
        "flowmanager-fallback-failed-before-audio",
        manager_factory=FailingGreetFlowManager,
    )
    fallback_failure_turn_controls = FakeTurnControls()
    fallback_failure_session.turn_controls = fallback_failure_turn_controls  # type: ignore[assignment]
    install_fake_synthesizer(fallback_failure_session, chunks=2)
    await fallback_failure_session.flow_manager_adapter.initialize()
    fallback_failure_session.flow_manager_adapter.stage_transition("greet", reason="caller_turn_preview")
    fallback_failure_session.set_pending_caller_turn_commit(
        payload={"text": "Fallback must fail closed", "conversationMode": "free_caller"},
        expected_agent_text="This preview must not reach the caller.",
        output_generation=fallback_failure_session.output_generation,
    )
    fallback_failure_processor = CapturingTtsProcessor(fallback_failure_session)
    pipeline.json_http = fake_fallback_failure_http
    try:
        await fallback_failure_processor.process_frame(
            TextFrame("This preview must not reach the caller."),
            FrameDirection.DOWNSTREAM,
        )
    finally:
        pipeline.json_http = original_json_http
    fallback_failure_audio = [
        frame for frame in fallback_failure_processor.frames if isinstance(frame, TTSAudioRawFrame)
    ]
    fallback_failure_started = [
        frame for frame in fallback_failure_processor.frames if isinstance(frame, TTSStartedFrame)
    ]
    fallback_failure_stopped = [
        frame for frame in fallback_failure_processor.frames if isinstance(frame, TTSStoppedFrame)
    ]
    fallback_failure_stages = [event["stage"] for event in fallback_failure_session.stage_events]
    fallback_failure_pending_cleared = (
        fallback_failure_session.pending_caller_turn_commit is None
        and fallback_failure_session.flow_manager_adapter.pending_transition is None
    )
    terminal_cached_after_fallback_failure = fallback_failure_session.flow_manager_adapter._terminal_result is not None
    fallback_failure_evidence = dict(fallback_failure_session.flow_manager_adapter.last_evidence)
    pipeline.json_http = fake_fallback_failure_http
    try:
        fallback_failure_followup = await fallback_failure_session.flow_manager_adapter.preview_caller_turn(
            text="Try ACC again after fallback failure",
            conversation_mode="free_caller",
        )
    finally:
        pipeline.json_http = original_json_http

    slow_activation_session = build_session(
        "flowmanager-slow-activation-barge-in",
        manager_factory=SlowActivatingFlowManager,
    )
    install_fake_synthesizer(slow_activation_session, chunks=2)
    await slow_activation_session.flow_manager_adapter.initialize()
    slow_activation_session.flow_manager_adapter.stage_transition("greet", reason="caller_turn_preview")
    slow_activation_session.set_pending_caller_turn_commit(
        payload={"text": "Do not commit this interrupted turn", "conversationMode": "free_caller"},
        expected_agent_text="This preview must remain unheard and uncommitted.",
        output_generation=slow_activation_session.output_generation,
    )
    slow_activation_processor = CapturingTtsProcessor(slow_activation_session)
    slow_activation_manager = slow_activation_session.flow_manager_adapter.manager
    slow_activation_task = asyncio.create_task(
        slow_activation_processor.process_frame(
            TextFrame("This preview must remain unheard and uncommitted."),
            FrameDirection.DOWNSTREAM,
        )
    )
    await asyncio.wait_for(slow_activation_manager.activation_started.wait(), timeout=1)
    slow_activation_cancel_started = time.perf_counter()
    slow_activation_cancellation = slow_activation_session.cancel_output("fixture_barge_in_during_flowmanager_activation")
    slow_activation_result = await asyncio.wait_for(
        asyncio.gather(slow_activation_task, return_exceptions=True),
        timeout=2,
    )
    slow_activation_cancel_ms = round((time.perf_counter() - slow_activation_cancel_started) * 1000, 3)
    slow_activation_audio = [
        frame for frame in slow_activation_processor.frames if isinstance(frame, TTSAudioRawFrame)
    ]
    slow_activation_evidence = slow_activation_session.flow_manager_adapter.last_evidence

    prepared_rollback_session = build_session("prepared-flowmanager-transition-rolled-back-before-audio")
    install_fake_synthesizer(prepared_rollback_session, chunks=2)
    await prepared_rollback_session.flow_manager_adapter.initialize()
    prepared_rollback_session.flow_manager_adapter.stage_transition("greet", reason="caller_turn_preview")
    prepared_rollback_session.set_pending_caller_turn_commit(
        payload={"text": "Interrupt after prepare", "conversationMode": "free_caller"},
        expected_agent_text="This prepared transition must disappear from evidence.",
        output_generation=prepared_rollback_session.output_generation,
    )
    prepared_rollback_processor = CapturingTtsProcessor(prepared_rollback_session, block_first_audio=True)
    prepared_rollback_task = asyncio.create_task(
        prepared_rollback_processor.process_frame(
            TextFrame("This prepared transition must disappear from evidence."),
            FrameDirection.DOWNSTREAM,
        )
    )
    await asyncio.wait_for(prepared_rollback_processor.first_chunk.wait(), timeout=1)
    prepared_rollback_cancellation = prepared_rollback_session.cancel_output(
        "fixture_barge_in_after_flowmanager_prepare_before_audio_delivery"
    )
    prepared_rollback_result = await asyncio.wait_for(
        asyncio.gather(prepared_rollback_task, return_exceptions=True),
        timeout=2,
    )
    prepared_rollback_manager = prepared_rollback_session.flow_manager_adapter.manager
    prepared_rollback_evidence = prepared_rollback_session.flow_manager_adapter.last_evidence

    interrupted_session = build_session("output-interrupted")
    if not live_kokoro:
        install_fake_synthesizer(interrupted_session, chunks=8)
    interrupted_processor = CapturingTtsProcessor(interrupted_session, pause_after_first_chunk=True)
    interrupted_task = asyncio.create_task(
        interrupted_processor.process_frame(
            TextFrame("This longer response will be interrupted after the first playable output chunk arrives."),
            FrameDirection.DOWNSTREAM,
        )
    )
    await asyncio.wait_for(interrupted_processor.first_chunk.wait(), timeout=10 if live_kokoro else 1)
    cancellation = interrupted_session.cancel_output("fixture_speech_started_barge_in")
    flush = interrupted_session.mark_output_flushed()
    interrupted_result = await asyncio.gather(interrupted_task, return_exceptions=True)
    interrupted_audio = [frame for frame in interrupted_processor.frames if isinstance(frame, TTSAudioRawFrame)]

    resumed_processor = CapturingTtsProcessor(interrupted_session)
    if not live_kokoro:
        install_fake_synthesizer(interrupted_session, chunks=3)
    await resumed_processor.process_frame(TextFrame("Fresh response after interruption."), FrameDirection.DOWNSTREAM)
    resumed_audio = [frame for frame in resumed_processor.frames if isinstance(frame, TTSAudioRawFrame)]

    stale_pre_audio_started = asyncio.Event()

    async def blocked_pre_audio_synthesizer(_frame: TextFrame, *, chunk_bytes: int):
        assert chunk_bytes == CHUNK_BYTES
        stale_pre_audio_started.set()
        await asyncio.sleep(60)
        yield b"\x20\x00" * (CHUNK_BYTES // 2), SAMPLE_RATE, {
            "engine": "kokoro-fixture",
            "sampleRate": SAMPLE_RATE,
            "format": "pcm_s16le",
            "providerStream": True,
        }

    stale_pre_audio_session = build_session("stale-counter-pre-audio-cancel")
    stale_pre_audio_session.output_stream_chunk_count = 1
    stale_pre_audio_session.output_stream_audio_bytes = CHUNK_BYTES
    stale_pre_audio_session.set_pending_caller_turn_commit(
        payload={"text": "This later response has no audio yet", "conversationMode": "free_caller"},
        expected_agent_text="This later response should not be preserved.",
        output_generation=stale_pre_audio_session.output_generation,
    )
    stale_pre_audio_session.stream_synthesize = blocked_pre_audio_synthesizer  # type: ignore[method-assign]
    stale_pre_audio_processor = CapturingTtsProcessor(stale_pre_audio_session)
    stale_pre_audio_task = asyncio.create_task(
        stale_pre_audio_processor.process_frame(
            TextFrame("This later response should not be preserved."),
            FrameDirection.DOWNSTREAM,
        )
    )
    await asyncio.wait_for(stale_pre_audio_started.wait(), timeout=1)
    stale_pre_audio_cancellation = stale_pre_audio_session.cancel_output("fixture_pre_audio_cancel_with_stale_counter")
    stale_pre_audio_result = await asyncio.gather(stale_pre_audio_task, return_exceptions=True)

    task_session = build_session("response-task-interrupted")
    agent_task = asyncio.create_task(asyncio.sleep(60))
    tts_task = asyncio.create_task(asyncio.sleep(60))
    task_session.register_response_task("agent", agent_task)
    task_session.register_response_task("tts", tts_task)
    task_cancellation = task_session.cancel_output("fixture_cancel_active_response_tasks")
    await asyncio.gather(agent_task, tts_task, return_exceptions=True)

    cancelled_commit_calls: list[dict[str, Any]] = []
    preview_started = threading.Event()

    def fake_cancelled_caller_turn_http(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
        if method == "POST" and url.endswith("/caller-turn") and (payload or {}).get("commitMode") == "delivery_ack":
            preview_started.set()
            time.sleep(0.05)
            return {
                "flowState": "diagnose",
                "callerTurnCommit": {"mode": "delivery_ack", "status": "pending", "timestamp": "fixture"},
                "transcript": [
                    {"speaker": "caller", "text": (payload or {}).get("text", ""), "timestamp": "fixture"},
                    {"speaker": "agent", "text": "This cancelled response must never be committed.", "timestamp": "fixture"},
                ],
            }
        if method == "POST" and url.endswith("/caller-turn/commit"):
            cancelled_commit_calls.append(payload or {})
            return {"transcript": []}
        return original_json_http(method, url, payload, timeout)

    cancelled_turn_session = build_session("caller-turn-cancelled-before-delivery")
    caller_turn_processor = CapturingCallerTurnProcessor(cancelled_turn_session)
    pipeline.json_http = fake_cancelled_caller_turn_http
    try:
        caller_turn_task = asyncio.create_task(
            caller_turn_processor.process_frame(
                TranscriptionFrame(
                    "Please help with billing.",
                    user_id="browser",
                    timestamp="fixture",
                    result={"stt": {"engine": "fixture"}},
                    finalized=True,
                ),
                FrameDirection.DOWNSTREAM,
            )
        )
        await asyncio.to_thread(preview_started.wait, 1)
        cancellation_before_delivery = cancelled_turn_session.cancel_output("fixture_cancel_inflight_caller_turn")
        await caller_turn_task
    finally:
        pipeline.json_http = original_json_http

    normal_started = [frame for frame in normal_processor.frames if isinstance(frame, TTSStartedFrame)]
    normal_stopped = [frame for frame in normal_processor.frames if isinstance(frame, TTSStoppedFrame)]
    interrupted_stopped = [frame for frame in interrupted_processor.frames if isinstance(frame, TTSStoppedFrame)]
    resumed_stopped = [frame for frame in resumed_processor.frames if isinstance(frame, TTSStoppedFrame)]
    latency_ms = flush.get("transportFlushLatencyMs")
    checks = {
        "normalStreamUsesMultiplePlayableChunks": len(normal_audio) >= (2 if live_kokoro else 6) and all(0 < len(frame.audio) <= CHUNK_BYTES for frame in normal_audio),
        "normalStreamHasLifecycleFrames": len(normal_started) == 1 and len(normal_stopped) == 1,
        "interruptedStreamStopsAfterCurrentChunk": len(interrupted_audio) == 1 and len(interrupted_stopped) == 0 and isinstance(interrupted_result[0], asyncio.CancelledError),
        "bargeInFlushesTransportOutput": cancellation.get("skipped") is False and flush.get("transportOutputFlushed") is True,
        "interruptionLatencyMeasured": isinstance(latency_ms, (int, float)) and 0 <= latency_ms < 100,
        "freshResponseAfterInterruption": len(resumed_audio) >= (1 if live_kokoro else 3) and len(resumed_stopped) == 1,
        "noStalePlaybackAfterInterruption": interrupted_session.output_stream_audio_bytes == sum(len(frame.audio) for frame in resumed_audio),
        "activeAgentAndTtsTasksCancelled": sorted(task_cancellation.get("cancelledTasks", [])) == ["agent", "tts"] and agent_task.cancelled() and tts_task.cancelled(),
        "callerTurnDeliveryAckCommitsAfterFirstAudio": len(delivery_commit_calls) == 1 and len(normal_audio) >= 1,
        "successfulTurnPublishesFinalizedFlowManagerEvidence": (
            normal_session.last_evidence.get("flowManager", {}).get("commitPolicy") == "delivery_ack_committed"
            and normal_session.last_evidence.get("flowManager", {}).get("currentNode") == "diagnose"
            and normal_session.last_evidence.get("flowManager", {}).get("pendingTransition") is None
        ),
        "slowCommitStartsOnlyAfterFirstAudio": slow_commit_audio_before_cancel == 1 and slow_commit_cancellation.get("outputChunksEnqueued") == 1,
        "slowCommitBargeInPreservesDeliveredCommit": (
            len(slow_commit_calls) == 1
            and isinstance(slow_commit_result[0], asyncio.CancelledError)
            and any(
                event["stage"] == "acc.caller_turn_delivery_committed"
                and event.get("outputInterruptedAfterDelivery") is True
                for event in slow_commit_stages
            )
        ),
        "followupTurnWaitsForPriorDeliveryAck": (
            followup_waited_for_prior_ack
            and len(followup_commit_calls) == 1
            and followup_barge_in.get("outputChunksEnqueued") == 1
            and isinstance(followup_delivery_result[0], asyncio.CancelledError)
        ),
        "followupTurnStagesWithoutFallback": (
            len(followup_preview_calls) == 1
            and not followup_fallback_calls
            and followup_preview_result.get("flowManagerRuntime", {}).get("ok") is True
            and followup_preview_result.get("flowManagerRuntime", {}).get("currentNode") == "greet"
            and followup_preview_result.get("flowManagerRuntime", {}).get("pendingNode") == "diagnose"
            and followup_session.flow_manager_adapter.pending_transition is not None
            and followup_session.flow_manager_adapter.pending_transition.get("to") == "diagnose"
        ),
        "queuedPreviewWaitsForFailClosedTerminalState": (
            fail_closed_preview_waited
            and fail_closed_cancellation_waited_for_cleanup
            and isinstance(fail_closed_prepare_result[0], asyncio.CancelledError)
            and len(fail_closed_fallback_calls) == 1
            and not fail_closed_preview_calls
            and fail_closed_preview_result.get("flowManagerRuntime", {}).get("commitPolicy") == "terminal_handoff"
            and fail_closed_preview_result.get("flowState") == "wrap"
            and fail_closed_session.flow_manager_adapter.manager.current_node == "wrap"
            and fail_closed_session.flow_manager_adapter.pending_transition is None
        ),
        "failClosedWrapPreservesRuntimeFailureEvidence": (
            fail_closed_session.flow_manager_adapter.last_evidence.get("ok") is False
            and fail_closed_session.flow_manager_adapter.last_evidence.get("error")
            == "flowmanager_runtime_failed_closed"
            and fail_closed_session.flow_manager_adapter.last_evidence.get("commitPolicy") == "terminal_handoff"
            and fail_closed_session.flow_manager_adapter.last_evidence.get("currentNode") == "wrap"
            and fail_closed_session.flow_manager_adapter.last_evidence.get("lastTransition", {}).get("reason")
            == "flowmanager_runtime_failure"
        ),
        "failedCommitAfterCancellationCleansPendingDelivery": (
            len(failing_cancel_commit_calls) == 1
            and isinstance(failing_cancel_result[0], asyncio.CancelledError)
            and failing_cancel_barge_in.get("outputChunksEnqueued") == 1
            and failing_cancel_session.pending_caller_turn_commit is None
            and failing_cancel_session.flow_manager_adapter.pending_transition is None
            and any(
                event["stage"] == "acc.caller_turn_delivery_rejected"
                and event.get("error") == "delivery_ack_commit_rejected_after_cancellation"
                for event in failing_cancel_stages
            )
        ),
        "repeatedCancellationWaitsForDeliveryCommitCleanup": (
            len(repeated_cancel_commit_calls) == 1
            and isinstance(repeated_cancel_result[0], asyncio.CancelledError)
            and repeated_cancel_barge_in.get("outputChunksEnqueued") == 1
            and repeated_cancel_session.pending_caller_turn_commit is None
            and repeated_cancel_session.flow_manager_adapter.pending_transition is None
            and any(
                event["stage"] == "acc.caller_turn_delivery_committed"
                and event.get("outputInterruptedAfterDelivery") is True
                for event in repeated_cancel_stages
            )
        ),
        "staleDeliveryCommitDoesNotClearNewerPendingTurn": (
            len(stale_commit_calls) == 1
            and isinstance(stale_result[0], asyncio.CancelledError)
            and stale_barge_in.get("outputChunksEnqueued") == 1
            and stale_session.pending_caller_turn_commit is not None
            and stale_session.pending_caller_turn_commit.get("payload", {}).get("text") == "Newer caller turn"
            and any(
                event["stage"] == "acc.caller_turn_delivery_stale"
                and event.get("error") == "stale_pending_delivery_ack_after_commit"
                for event in stale_stages
            )
            and not any(event["stage"] == "acc.caller_turn_delivery_committed" for event in stale_stages)
        ),
        "flowManagerActivationFailureFailsDeliveryCommit": failed_delivery_requests == ["fallback"],
        "flowManagerActivationFailureEmitsNoPreviewAudio": len(failed_delivery_audio) == 0 and failed_delivery_session.output_stream_audio_bytes == 0,
        "flowManagerActivationFailureClosesTtsLifecycle": (
            len(failed_delivery_started) == 1
            and len(failed_delivery_stopped) == 1
            and failed_turn_controls.started == 1
            and failed_turn_controls.stopped == 1
            and failed_turn_controls.bot_speaking is False
        ),
        "flowManagerActivationFailureRecordsNoCommittedDelivery": (
            "acc.caller_turn_delivery_failed" in failed_delivery_stages
            and "acc.caller_turn_delivery_committed" not in failed_delivery_stages
            and failed_delivery_session.pending_caller_turn_commit is None
        ),
        "flowManagerActivationFailureRetainsTerminalEvidence": (
            failed_delivery_session.last_evidence.get("flowManager", {}).get("ok") is False
            and failed_delivery_session.last_evidence.get("flowManager", {}).get("commitPolicy") == "terminal_handoff"
        ),
        "flowManagerFallbackFailureClosesZeroAudioLifecycle": (
            fallback_failure_requests == ["fallback", "caller-turn"]
            and len(fallback_failure_audio) == 0
            and len(fallback_failure_started) == 1
            and len(fallback_failure_stopped) == 1
            and fallback_failure_turn_controls.started == 1
            and fallback_failure_turn_controls.stopped == 1
            and fallback_failure_turn_controls.bot_speaking is False
        ),
        "flowManagerFallbackFailureClearsPendingDelivery": (
            fallback_failure_pending_cleared
            and "tts.lifecycle_closed" in fallback_failure_stages
            and "tts.failed" in fallback_failure_stages
            and "acc.caller_turn_delivery_committed" not in fallback_failure_stages
        ),
        "flowManagerFallbackFailureDoesNotCacheSyntheticTerminal": (
            terminal_cached_after_fallback_failure is False
            and fallback_failure_followup.get("flowState") == "greet"
            and fallback_failure_followup.get("transcript", [{}])[-1].get("text")
            == "ACC accepted the later caller turn."
            and fallback_failure_followup.get("flowManagerRuntime", {}).get("commitPolicy")
            == "preview_until_output_delivery_ack"
            and fallback_failure_session.flow_manager_adapter.pending_transition is not None
            and fallback_failure_session.flow_manager_adapter.pending_transition.get("to") == "greet"
        ),
        "flowManagerFallbackFailureDoesNotPublishTerminalHandoff": (
            fallback_failure_evidence.get("ok") is False
            and fallback_failure_evidence.get("error") == "flowmanager_fallback_failed"
            and fallback_failure_evidence.get("commitPolicy") == "fallback_failed"
            and fallback_failure_evidence.get("fallbackAccepted") is False
        ),
        "slowFlowManagerActivationBargeInRollsBack": (
            isinstance(slow_activation_result[0], asyncio.CancelledError)
            and slow_activation_manager.current_node == "call_started"
            and slow_activation_session.flow_manager_adapter.pending_transition is None
            and slow_activation_evidence.get("commitPolicy") == "preview_discarded"
            and slow_activation_evidence.get("rolledBackPreparedTransition") is True
        ),
        "slowFlowManagerActivationCancellationIsPrompt": slow_activation_cancel_ms < 2_000,
        "slowFlowManagerActivationCommitsNoAudioOrAccTurn": (
            len(slow_activation_audio) == 0
            and slow_activation_session.output_stream_audio_bytes == 0
            and slow_activation_session.pending_caller_turn_commit is None
            and slow_activation_cancellation.get("outputChunksEnqueued") == 0
        ),
        "rolledBackPreparedTransitionIsRemovedFromTraceEvidence": (
            isinstance(prepared_rollback_result[0], asyncio.CancelledError)
            and prepared_rollback_cancellation.get("outputChunksEnqueued") == 0
            and prepared_rollback_manager.current_node == "call_started"
            and prepared_rollback_session.flow_manager_adapter.pending_transition is None
            and prepared_rollback_session.flow_manager_adapter.transition_trace == []
            and prepared_rollback_evidence.get("transitionCount") == 0
            and "lastTransition" not in prepared_rollback_evidence
            and prepared_rollback_evidence.get("commitPolicy") == "preview_discarded"
        ),
        "cancelledCallerTurnDoesNotCommitUnheardAgent": len(cancelled_commit_calls) == 0 and not caller_turn_processor.frames and cancellation_before_delivery.get("cancelledTasks") == ["agent"],
        "stalePriorAudioCounterDoesNotPreservePreAudioCommit": (
            isinstance(stale_pre_audio_result[0], asyncio.CancelledError)
            and stale_pre_audio_cancellation.get("outputChunksEnqueued") == 0
            and stale_pre_audio_session.pending_caller_turn_commit is None
        ),
    }
    return {
        "ok": all(checks.values()),
        "mode": "live_kokoro" if live_kokoro else "deterministic_fixture",
        "contract": "Kokoro PCM -> TTSStartedFrame -> paced TTSAudioRawFrame chunks -> TTSStoppedFrame; InterruptionFrame flush",
        "chunkMs": CHUNK_MS,
        "chunkBytes": CHUNK_BYTES,
        "normal": {
            "chunks": len(normal_audio),
            "audioBytes": sum(len(frame.audio) for frame in normal_audio),
            "flowManager": normal_session.last_evidence.get("flowManager"),
        },
        "interrupted": {
            "chunksBeforeStop": len(interrupted_audio),
            "audioBytesBeforeStop": sum(len(frame.audio) for frame in interrupted_audio),
            "transportFlushLatencyMs": latency_ms,
            "transportOutputFlushed": flush.get("transportOutputFlushed"),
            "cancelledTasks": cancellation.get("cancelledTasks"),
        },
        "resumed": {"chunks": len(resumed_audio), "audioBytes": sum(len(frame.audio) for frame in resumed_audio)},
        "activeTasks": {"cancelled": task_cancellation.get("cancelledTasks", [])},
        "callerTurnCommit": {
            "deliveryAckCommits": len(delivery_commit_calls),
            "cancelledDeliveryAckCommits": len(cancelled_commit_calls),
            "cancelledTasks": cancellation_before_delivery.get("cancelledTasks"),
        },
        "flowManagerActivationFailure": {
            "requests": failed_delivery_requests,
            "audioChunks": len(failed_delivery_audio),
            "ttsStarted": len(failed_delivery_started),
            "ttsStopped": len(failed_delivery_stopped),
            "turnControls": {
                "started": failed_turn_controls.started,
                "stopped": failed_turn_controls.stopped,
                "botSpeaking": failed_turn_controls.bot_speaking,
            },
            "stages": failed_delivery_stages,
            "evidence": failed_delivery_session.last_evidence.get("flowManager"),
        },
        "flowManagerFallbackFailure": {
            "requests": fallback_failure_requests,
            "audioChunks": len(fallback_failure_audio),
            "ttsStarted": len(fallback_failure_started),
            "ttsStopped": len(fallback_failure_stopped),
            "turnControls": {
                "started": fallback_failure_turn_controls.started,
                "stopped": fallback_failure_turn_controls.stopped,
                "botSpeaking": fallback_failure_turn_controls.bot_speaking,
            },
            "pendingCommit": fallback_failure_session.pending_caller_turn_commit is not None,
            "pendingTransition": fallback_failure_session.flow_manager_adapter.pending_transition is not None,
            "pendingClearedBeforeFollowup": fallback_failure_pending_cleared,
            "terminalCachedAfterFailure": terminal_cached_after_fallback_failure,
            "failedEvidenceError": fallback_failure_evidence.get("error"),
            "failedEvidenceCommitPolicy": fallback_failure_evidence.get("commitPolicy"),
            "failedEvidenceFallbackAccepted": fallback_failure_evidence.get("fallbackAccepted"),
            "followupFlowState": fallback_failure_followup.get("flowState"),
            "followupCommitPolicy": fallback_failure_followup.get("flowManagerRuntime", {}).get("commitPolicy"),
            "followupPendingNode": (
                fallback_failure_session.flow_manager_adapter.pending_transition or {}
            ).get("to"),
            "stages": fallback_failure_stages,
        },
        "slowCommitBargeIn": {
            "audioChunksBeforeCancel": slow_commit_audio_before_cancel,
            "commitCalls": len(slow_commit_calls),
            "cancelled": isinstance(slow_commit_result[0], asyncio.CancelledError),
            "outputChunksAtCancel": slow_commit_cancellation.get("outputChunksEnqueued"),
        },
        "followupDuringSlowCommit": {
            "waitedForPriorAck": followup_waited_for_prior_ack,
            "commitCalls": len(followup_commit_calls),
            "previewCalls": len(followup_preview_calls),
            "fallbackCalls": len(followup_fallback_calls),
            "priorDeliveryCancelled": isinstance(followup_delivery_result[0], asyncio.CancelledError),
            "pendingTransition": followup_session.flow_manager_adapter.pending_transition,
        },
        "queuedPreviewDuringFailClosed": {
            "waitedForTerminalState": fail_closed_preview_waited,
            "cancellationWaitedForCleanup": fail_closed_cancellation_waited_for_cleanup,
            "prepareCancelled": isinstance(fail_closed_prepare_result[0], asyncio.CancelledError),
            "fallbackCalls": len(fail_closed_fallback_calls),
            "previewCalls": len(fail_closed_preview_calls),
            "currentNode": fail_closed_session.flow_manager_adapter.manager.current_node,
            "pendingTransition": fail_closed_session.flow_manager_adapter.pending_transition,
            "previewFlowState": fail_closed_preview_result.get("flowState"),
            "previewCommitPolicy": fail_closed_preview_result.get("flowManagerRuntime", {}).get("commitPolicy"),
            "adapterEvidenceOk": fail_closed_session.flow_manager_adapter.last_evidence.get("ok"),
            "adapterEvidenceError": fail_closed_session.flow_manager_adapter.last_evidence.get("error"),
            "adapterEvidenceCommitPolicy": fail_closed_session.flow_manager_adapter.last_evidence.get("commitPolicy"),
            "adapterEvidenceCurrentNode": fail_closed_session.flow_manager_adapter.last_evidence.get("currentNode"),
            "adapterEvidenceTransitionReason": fail_closed_session.flow_manager_adapter.last_evidence.get(
                "lastTransition", {}
            ).get("reason"),
        },
        "failedCommitAfterCancellation": {
            "commitCalls": len(failing_cancel_commit_calls),
            "cancelled": isinstance(failing_cancel_result[0], asyncio.CancelledError),
            "pendingCommit": failing_cancel_session.pending_caller_turn_commit is not None,
            "pendingTransition": failing_cancel_session.flow_manager_adapter.pending_transition is not None,
            "outputChunksAtCancel": failing_cancel_barge_in.get("outputChunksEnqueued"),
        },
        "repeatedCancellationDuringCommit": {
            "commitCalls": len(repeated_cancel_commit_calls),
            "cancelled": isinstance(repeated_cancel_result[0], asyncio.CancelledError),
            "pendingCommit": repeated_cancel_session.pending_caller_turn_commit is not None,
            "pendingTransition": repeated_cancel_session.flow_manager_adapter.pending_transition is not None,
            "outputChunksAtCancel": repeated_cancel_barge_in.get("outputChunksEnqueued"),
        },
        "staleDeliveryCommit": {
            "commitCalls": len(stale_commit_calls),
            "cancelled": isinstance(stale_result[0], asyncio.CancelledError),
            "pendingCommit": stale_session.pending_caller_turn_commit,
            "pendingTransition": stale_session.flow_manager_adapter.pending_transition,
            "outputChunksAtCancel": stale_barge_in.get("outputChunksEnqueued"),
        },
        "stalePriorAudioPreAudioCancel": {
            "cancelled": isinstance(stale_pre_audio_result[0], asyncio.CancelledError),
            "outputChunksAtCancel": stale_pre_audio_cancellation.get("outputChunksEnqueued"),
            "pendingCommit": stale_pre_audio_session.pending_caller_turn_commit is not None,
        },
        "slowFlowManagerActivationBargeIn": {
            "audioChunks": len(slow_activation_audio),
            "cancelled": isinstance(slow_activation_result[0], asyncio.CancelledError),
            "cancelElapsedMs": slow_activation_cancel_ms,
            "currentNode": slow_activation_manager.current_node,
            "pendingTransition": slow_activation_session.flow_manager_adapter.pending_transition,
            "evidence": slow_activation_evidence,
        },
        "preparedTransitionRollback": {
            "cancelled": isinstance(prepared_rollback_result[0], asyncio.CancelledError),
            "outputChunksAtCancel": prepared_rollback_cancellation.get("outputChunksEnqueued"),
            "currentNode": prepared_rollback_manager.current_node,
            "pendingTransition": prepared_rollback_session.flow_manager_adapter.pending_transition,
            "transitionTrace": prepared_rollback_session.flow_manager_adapter.transition_trace,
            "evidence": prepared_rollback_evidence,
        },
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out")
    parser.add_argument("--live-kokoro", action="store_true")
    args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        payload = asyncio.run(run_regression(live_kokoro=args.live_kokoro))
    rendered = json.dumps(payload, indent=2) + "\n"
    if args.out:
        output_path = Path(args.out)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered, encoding="utf-8")
    print(json.dumps(payload))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
