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
    def __init__(self, session: AccVoicePipelineSession, *, pause_after_first_chunk: bool = False):
        super().__init__(session)
        self.frames: list[Any] = []
        self.pause_after_first_chunk = pause_after_first_chunk
        self.first_chunk = asyncio.Event()

    async def push_frame(self, frame: Any, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        self.frames.append(frame)
        if self.pause_after_first_chunk and isinstance(frame, TTSAudioRawFrame):
            self.first_chunk.set()


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
        "cancelledCallerTurnDoesNotCommitUnheardAgent": len(cancelled_commit_calls) == 0 and not caller_turn_processor.frames and cancellation_before_delivery.get("cancelledTasks") == ["agent"],
    }
    return {
        "ok": all(checks.values()),
        "mode": "live_kokoro" if live_kokoro else "deterministic_fixture",
        "contract": "Kokoro PCM -> TTSStartedFrame -> paced TTSAudioRawFrame chunks -> TTSStoppedFrame; InterruptionFrame flush",
        "chunkMs": CHUNK_MS,
        "chunkBytes": CHUNK_BYTES,
        "normal": {"chunks": len(normal_audio), "audioBytes": sum(len(frame.audio) for frame in normal_audio)},
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
        "slowCommitBargeIn": {
            "audioChunksBeforeCancel": slow_commit_audio_before_cancel,
            "commitCalls": len(slow_commit_calls),
            "cancelled": isinstance(slow_commit_result[0], asyncio.CancelledError),
            "outputChunksAtCancel": slow_commit_cancellation.get("outputChunksEnqueued"),
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
