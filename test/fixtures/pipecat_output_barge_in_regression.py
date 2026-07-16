#!/usr/bin/env python3
"""Deterministic transport-output streaming and barge-in regression proof."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"
sys.path.insert(0, str(RUNTIME_PATH))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from pipecat.frames.frames import TextFrame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection

from acc_pipecat_voice_pipeline import AccVoicePipelineSession, KokoroTtsProcessor


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


def build_session(call_id: str) -> AccVoicePipelineSession:
    return AccVoicePipelineSession(
        acc_url="http://127.0.0.1:8026",
        call_id=call_id,
        readiness=SimpleNamespace(stt_model="fixture", stt_backend="fixture"),
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
    normal_session = build_session("output-normal")
    if not live_kokoro:
        install_fake_synthesizer(normal_session, chunks=6)
    normal_processor = CapturingTtsProcessor(normal_session)
    await normal_processor.process_frame(
        TextFrame("This normal response proves that Kokoro audio reaches the transport in playable chunks."),
        FrameDirection.DOWNSTREAM,
    )
    normal_audio = [frame for frame in normal_processor.frames if isinstance(frame, TTSAudioRawFrame)]

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
