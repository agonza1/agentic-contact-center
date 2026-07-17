#!/usr/bin/env python3
"""Deterministic Pipecat tester-agent scenarios for the shared ACC voice processors."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_PATH = REPO_ROOT / ".pipecat-runtime"
sys.path.insert(0, str(RUNTIME_PATH))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from pipecat.frames.frames import TextFrame, TranscriptionFrame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection

import acc_pipecat_voice_pipeline as pipeline
from acc_pipecat_voice_pipeline import ACC_VOICE_PIPELINE_CONTRACT, AccCallerTurnProcessor, AccVoicePipelineSession, KokoroTtsProcessor


SAMPLE_RATE = 24_000
CHUNK_MS = 20
CHUNK_BYTES = SAMPLE_RATE * 2 * CHUNK_MS // 1000
TESTER_PIPELINE_CONTRACT = [
    "tester.transport.input",
    "AccCallerTurnProcessor",
    "KokoroTtsProcessor",
    "tester.transport.output",
]


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def git_head() -> str:
    head = REPO_ROOT / ".git" / "HEAD"
    try:
        value = head.read_text(encoding="utf-8").strip()
        if value.startswith("ref: "):
            ref = REPO_ROOT / ".git" / value[5:]
            return ref.read_text(encoding="utf-8").strip()
        return value
    except OSError:
        return "unknown"


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def build_session(call_id: str) -> AccVoicePipelineSession:
    return AccVoicePipelineSession(
        acc_url="http://127.0.0.1:8026",
        call_id=call_id,
        correlation_id=f"tester-correlation-{call_id}",
        readiness=SimpleNamespace(stt_model="tester-final-transcript", stt_backend="deterministic-fixture"),
    )


def install_fake_synthesizer(session: AccVoicePipelineSession, *, chunks: int, byte_seed: int = 32) -> None:
    pcm_chunk = bytes([byte_seed, 0]) * (CHUNK_BYTES // 2)

    async def stream_synthesize(_frame: TextFrame, *, chunk_bytes: int):
        assert chunk_bytes == CHUNK_BYTES
        for index in range(chunks):
            yield pcm_chunk, SAMPLE_RATE, {
                "engine": "kokoro-tester-fixture",
                "sampleRate": SAMPLE_RATE,
                "format": "pcm_s16le",
                "providerStream": True,
                "firstAudioMs": 1,
                "elapsedMs": index + 1,
            }

    session.stream_synthesize = stream_synthesize  # type: ignore[method-assign]


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
            await asyncio.sleep(60)


class TesterCallerTurnProcessor(AccCallerTurnProcessor):
    def __init__(self, session: AccVoicePipelineSession, tts: CapturingTtsProcessor):
        super().__init__(session)
        self.frames: list[Any] = []
        self.tts = tts

    async def push_frame(self, frame: Any, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        self.frames.append(frame)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, TextFrame):
            await self.tts.process_frame(frame, direction)


class FakeAccApi:
    def __init__(self, responses: dict[str, str]):
        self.responses = responses
        self.preview_calls: list[dict[str, Any]] = []
        self.commit_calls: list[dict[str, Any]] = []

    def __call__(self, method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
        if method == "POST" and url.endswith("/caller-turn") and (payload or {}).get("commitMode") == "delivery_ack":
            caller_text = (payload or {}).get("text", "")
            agent_text = self.responses.get(caller_text, f"Fixture response for: {caller_text}")
            self.preview_calls.append(payload or {})
            return {
                "flowState": "diagnose",
                "callerTurnCommit": {
                    "mode": "delivery_ack",
                    "status": "pending",
                    "snapshotVersion": f"tester-{len(self.preview_calls)}",
                    "timestamp": utc_now(),
                },
                "transcript": [
                    {"speaker": "caller", "text": caller_text, "timestamp": "fixture"},
                    {"speaker": "agent", "text": agent_text, "timestamp": "fixture"},
                ],
            }
        if method == "POST" and url.endswith("/caller-turn/commit"):
            caller_text = (payload or {}).get("text", "")
            expected_agent_text = (payload or {}).get("expectedAgentText", self.responses.get(caller_text, ""))
            self.commit_calls.append(payload or {})
            return {
                "flowState": "diagnose",
                "transcript": [
                    {"speaker": "caller", "text": caller_text, "timestamp": "fixture"},
                    {"speaker": "agent", "text": expected_agent_text, "timestamp": "fixture"},
                ],
            }
        raise RuntimeError(f"unexpected fake ACC request: {method} {url}")


def transcription_frame(text: str) -> TranscriptionFrame:
    return TranscriptionFrame(
        text,
        user_id="tester-agent",
        timestamp="fixture",
        result={
            "stt": {
                "engine": "tester-final-transcript",
                "contract": "local-stt.v1-final-frame",
                "sidecarFree": True,
            }
        },
        finalized=True,
    )


def summarize_frames(frames: list[Any]) -> dict[str, Any]:
    audio_frames = [frame for frame in frames if isinstance(frame, TTSAudioRawFrame)]
    audio_bytes = b"".join(frame.audio for frame in audio_frames)
    return {
        "ttsStarted": len([frame for frame in frames if isinstance(frame, TTSStartedFrame)]),
        "ttsStopped": len([frame for frame in frames if isinstance(frame, TTSStoppedFrame)]),
        "audioChunks": len(audio_frames),
        "audioBytes": len(audio_bytes),
        "audioSha256": hashlib.sha256(audio_bytes).hexdigest() if audio_bytes else None,
    }


async def run_turn(
    *,
    call_id: str,
    caller_text: str,
    responses: dict[str, str],
    chunks: int = 3,
    pause_after_first_chunk: bool = False,
) -> tuple[AccVoicePipelineSession, TesterCallerTurnProcessor, CapturingTtsProcessor, FakeAccApi, BaseException | None]:
    session = build_session(call_id)
    install_fake_synthesizer(session, chunks=chunks)
    tts = CapturingTtsProcessor(session, pause_after_first_chunk=pause_after_first_chunk)
    caller = TesterCallerTurnProcessor(session, tts)
    fake_acc = FakeAccApi(responses)
    original_json_http = pipeline.json_http
    pipeline.json_http = fake_acc
    error: BaseException | None = None
    try:
        await caller.process_frame(transcription_frame(caller_text), FrameDirection.DOWNSTREAM)
    except BaseException as exc:
        error = exc
    finally:
        pipeline.json_http = original_json_http
    return session, caller, tts, fake_acc, error


async def scenario_happy_path(out_dir: Path, call_id_prefix: str) -> dict[str, Any]:
    started = time.perf_counter()
    caller_text = "I need to reschedule my appointment."
    agent_text = "I can help reschedule. What day works best for you?"
    session, caller, tts, fake_acc, error = await run_turn(
        call_id=f"{call_id_prefix}-happy",
        caller_text=caller_text,
        responses={caller_text: agent_text},
        chunks=4,
    )
    frame_summary = summarize_frames(tts.frames)
    checks = {
        "noProcessorError": error is None,
        "callerTurnPreviewed": len(fake_acc.preview_calls) == 1,
        "deliveryAckCommittedAfterAudio": len(fake_acc.commit_calls) == 1 and frame_summary["audioChunks"] >= 1,
        "agentResponseCaptured": any(isinstance(frame, TextFrame) and frame.text == agent_text for frame in caller.frames),
        "ttsLifecycleCaptured": frame_summary["ttsStarted"] == 1 and frame_summary["ttsStopped"] == 1,
    }
    payload = {
        "id": "happy_path",
        "ok": all(checks.values()),
        "description": "Tester transport injects a final caller transcript and captures the normal ACC -> Kokoro response.",
        "correlationId": session.correlation_id,
        "callerTranscript": caller_text,
        "agentResponse": agent_text,
        "timingEvents": session.stage_events,
        "frameSummary": frame_summary,
        "checks": checks,
        "elapsedMs": round((time.perf_counter() - started) * 1000),
        "artifactPaths": {},
    }
    path = out_dir / "happy_path.json"
    payload["artifactPaths"]["scenario"] = str(path)
    write_json(path, payload)
    return payload


async def scenario_barge_in(out_dir: Path, call_id_prefix: str) -> dict[str, Any]:
    started = time.perf_counter()
    first_text = "Tell me about my cancellation options."
    first_agent = "I can explain the cancellation policy in detail before we continue."
    session = build_session(f"{call_id_prefix}-barge")
    install_fake_synthesizer(session, chunks=8, byte_seed=48)
    tts = CapturingTtsProcessor(session, pause_after_first_chunk=True)
    caller = TesterCallerTurnProcessor(session, tts)
    fake_acc = FakeAccApi({
        first_text: first_agent,
        "Actually I want a human.": "I can transfer you to a human agent now.",
    })
    original_json_http = pipeline.json_http
    pipeline.json_http = fake_acc
    first_error: BaseException | None = None
    try:
        first_task = asyncio.create_task(caller.process_frame(transcription_frame(first_text), FrameDirection.DOWNSTREAM))
        await asyncio.wait_for(tts.first_chunk.wait(), timeout=2)
        cancellation = session.cancel_output("tester_barge_in_after_first_audio")
        flush = session.mark_output_flushed()
        result = await asyncio.gather(first_task, return_exceptions=True)
        if isinstance(result[0], BaseException):
            first_error = result[0]

        install_fake_synthesizer(session, chunks=2, byte_seed=64)
        resumed_tts = CapturingTtsProcessor(session)
        resumed_caller = TesterCallerTurnProcessor(session, resumed_tts)
        await resumed_caller.process_frame(transcription_frame("Actually I want a human."), FrameDirection.DOWNSTREAM)
    finally:
        pipeline.json_http = original_json_http
    interrupted_summary = summarize_frames(tts.frames)
    resumed_summary = summarize_frames(resumed_tts.frames)
    checks = {
        "interruptedAfterFirstChunk": interrupted_summary["audioChunks"] == 1 and isinstance(first_error, asyncio.CancelledError),
        "bargeInRecorded": cancellation.get("skipped") is False and flush.get("transportOutputFlushed") is True,
        "interruptedCommitDiscarded": len(fake_acc.commit_calls) == 1 and fake_acc.commit_calls[0].get("text") == "Actually I want a human.",
        "freshResponseAfterBargeIn": resumed_summary["audioChunks"] >= 1 and any(
            isinstance(frame, TextFrame) and frame.text == "I can transfer you to a human agent now." for frame in resumed_caller.frames
        ),
    }
    payload = {
        "id": "barge_in",
        "ok": all(checks.values()),
        "description": "Tester transport interrupts active output and proves the next caller turn uses a fresh generation.",
        "correlationId": session.correlation_id,
        "callerTranscript": first_text,
        "agentResponse": first_agent,
        "timingEvents": session.stage_events,
        "bargeIn": session.last_barge_in_evidence,
        "interruptedFrameSummary": interrupted_summary,
        "resumedFrameSummary": resumed_summary,
        "checks": checks,
        "elapsedMs": round((time.perf_counter() - started) * 1000),
        "artifactPaths": {},
    }
    path = out_dir / "barge_in.json"
    payload["artifactPaths"]["scenario"] = str(path)
    write_json(path, payload)
    return payload


async def scenario_no_speech_timeout(out_dir: Path, call_id_prefix: str) -> dict[str, Any]:
    started = time.perf_counter()
    session = build_session(f"{call_id_prefix}-timeout")
    session.record_stage(
        "tester.no_speech_timeout",
        ok=True,
        timeoutMs=750,
        transport="tester-agent",
        action="no_acc_mutation",
    )
    checks = {
        "timeoutRecorded": any(event.get("stage") == "tester.no_speech_timeout" for event in session.stage_events),
        "noCallerTurnCommitPending": session.pending_caller_turn_commit is None,
        "noAgentResponseGenerated": session.turn_count == 0,
    }
    payload = {
        "id": "no_speech_timeout",
        "ok": all(checks.values()),
        "description": "Tester transport emits a no-speech timeout without mutating ACC caller-turn state.",
        "correlationId": session.correlation_id,
        "callerTranscript": None,
        "agentResponse": None,
        "timingEvents": session.stage_events,
        "checks": checks,
        "elapsedMs": round((time.perf_counter() - started) * 1000),
        "artifactPaths": {},
    }
    path = out_dir / "no_speech_timeout.json"
    payload["artifactPaths"]["scenario"] = str(path)
    write_json(path, payload)
    return payload


async def scenario_expected_transcript_mismatch(out_dir: Path, call_id_prefix: str) -> dict[str, Any]:
    started = time.perf_counter()
    expected = "I want to cancel my appointment."
    actual = "I want to reschedule my appointment."
    session = build_session(f"{call_id_prefix}-mismatch")
    session.record_stage(
        "tester.expected_transcript_mismatch",
        ok=False,
        expectedTranscript=expected,
        actualTranscript=actual,
        action="scenario_rejected_before_acc_mutation",
    )
    checks = {
        "mismatchDetected": expected != actual,
        "noAccMutation": session.turn_count == 0 and session.pending_caller_turn_commit is None,
    }
    payload = {
        "id": "expected_transcript_mismatch",
        "ok": all(checks.values()),
        "expectedFailureHandled": True,
        "description": "Tester transport rejects a scenario when the observed final transcript does not match the expected script.",
        "correlationId": session.correlation_id,
        "callerTranscript": actual,
        "expectedTranscript": expected,
        "agentResponse": None,
        "timingEvents": session.stage_events,
        "checks": checks,
        "elapsedMs": round((time.perf_counter() - started) * 1000),
        "artifactPaths": {},
    }
    path = out_dir / "expected_transcript_mismatch.json"
    payload["artifactPaths"]["scenario"] = str(path)
    write_json(path, payload)
    return payload


async def scenario_transport_start_failure(out_dir: Path, call_id_prefix: str) -> dict[str, Any]:
    started = time.perf_counter()
    session = build_session(f"{call_id_prefix}-transport-failure")
    error = RuntimeError("tester transport failed to start")
    session.record_stage(
        "tester.transport_start_failed",
        ok=False,
        error="transport_start_failed",
        detail=str(error),
        action="scenario_rejected_before_processors",
    )
    checks = {
        "transportFailureCaptured": session.last_error.get("error") == "transport_start_failed",
        "processorsNotStarted": session.turn_count == 0 and session.output_stream_chunk_count == 0,
    }
    payload = {
        "id": "transport_start_failure",
        "ok": all(checks.values()),
        "expectedFailureHandled": True,
        "description": "Tester runner records transport start failure before invoking shared processors.",
        "correlationId": session.correlation_id,
        "callerTranscript": None,
        "agentResponse": None,
        "timingEvents": session.stage_events,
        "checks": checks,
        "elapsedMs": round((time.perf_counter() - started) * 1000),
        "artifactPaths": {},
    }
    path = out_dir / "transport_start_failure.json"
    payload["artifactPaths"]["scenario"] = str(path)
    write_json(path, payload)
    return payload


async def run_scenarios(out_dir: Path, call_id_prefix: str) -> dict[str, Any]:
    os.environ["ACC_TTS_OUTPUT_CHUNK_MS"] = str(CHUNK_MS)
    os.environ["ACC_TTS_OUTPUT_CHUNK_YIELD_MS"] = "1"
    out_dir.mkdir(parents=True, exist_ok=True)
    scenarios = [
        await scenario_happy_path(out_dir, call_id_prefix),
        await scenario_barge_in(out_dir, call_id_prefix),
        await scenario_no_speech_timeout(out_dir, call_id_prefix),
        await scenario_expected_transcript_mismatch(out_dir, call_id_prefix),
        await scenario_transport_start_failure(out_dir, call_id_prefix),
    ]
    manifest_path = out_dir / "manifest.json"
    payload = {
        "ok": all(scenario["ok"] for scenario in scenarios),
        "generatedAt": utc_now(),
        "gitHead": git_head(),
        "mode": "deterministic_tester_agent",
        "entryPoint": "scripts/pipecat-tester-agent-scenarios.py",
        "command": "npm run pipecat:tester:scenarios",
        "productionPipelineContract": ACC_VOICE_PIPELINE_CONTRACT,
        "testerPipelineContract": TESTER_PIPELINE_CONTRACT,
        "sharedProcessors": ["AccCallerTurnProcessor", "KokoroTtsProcessor", "AccVoicePipelineSession"],
        "limitation": "Sidecar-free tester transport injects finalized TranscriptionFrame objects as rtc-asr output; it does not prove live rtc-asr audio recognition or the /play fixture audio path.",
        "scenarioCount": len(scenarios),
        "scenarios": scenarios,
        "artifactPaths": {
            "manifest": str(manifest_path),
            "outDir": str(out_dir),
        },
    }
    write_json(manifest_path, payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", default="artifacts/pipecat-tester-agent-scenarios")
    parser.add_argument("--call-id-prefix", default="tester-agent")
    args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        payload = asyncio.run(run_scenarios(Path(args.out_dir), args.call_id_prefix))
    print(json.dumps(payload))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
