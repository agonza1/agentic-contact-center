#!/usr/bin/env python3
"""Protocol regression for persistent rtc-asr browser sessions."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / ".pipecat-runtime"))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from acc_pipecat_voice_pipeline import (  # noqa: E402
    INPUT_SAMPLE_RATE,
    AccVoicePipelineSession,
)
from pipecat.frames.frames import InputAudioRawFrame  # noqa: E402


class FakeRtcAsrWebSocket:
    def __init__(
        self,
        *,
        emit_finals: bool = True,
        interim_on_audio: str | None = None,
        empty_final: bool = False,
    ) -> None:
        self.emit_finals = emit_finals
        self.interim_on_audio = interim_on_audio
        self.empty_final = empty_final
        self.interim_emitted = False
        self.sent: list[bytes | dict[str, object]] = []
        self.events: asyncio.Queue[dict[str, object] | Exception] = asyncio.Queue()
        self.closed = False
        self.close_code: int | None = None
        self.start_count = 0
        self.finalize_count = 0

    async def send(self, payload: bytes | str) -> None:
        if isinstance(payload, bytes):
            self.sent.append(payload)
            if self.interim_on_audio and not self.interim_emitted:
                self.interim_emitted = True
                await self.events.put(
                    {
                        "type": "transcript.interim",
                        "final": False,
                        "transcript": self.interim_on_audio,
                    }
                )
            return
        event = json.loads(payload)
        self.sent.append(event)
        if event["type"] == "start":
            self.start_count += 1
        elif event["type"] == "finalize":
            self.finalize_count += 1
            if self.emit_finals:
                await self.events.put(
                    {
                        "type": "transcript.final",
                        "final": True,
                        "transcript": "" if self.empty_final else f"completed turn {self.finalize_count}",
                    }
                )

    async def recv(self) -> str:
        event = await self.events.get()
        if isinstance(event, Exception):
            raise event
        return json.dumps(event)

    async def close(self) -> None:
        self.closed = True
        self.close_code = 1000
        await self.events.put(ConnectionError("fake rtc-asr socket closed"))


def make_session() -> AccVoicePipelineSession:
    readiness = SimpleNamespace(stt_model="test-model", stt_backend="test-backend")
    return AccVoicePipelineSession(acc_url="http://127.0.0.1:8026", call_id="protocol-test", readiness=readiness)


async def transcribe_turn(session: AccVoicePipelineSession, pcm: bytes) -> str:
    await session.stream_rtc_asr_audio(pcm)
    transcript, _meta, _frame = await session.transcribe(
        InputAudioRawFrame(audio=b"", sample_rate=INPUT_SAMPLE_RATE, num_channels=1)
    )
    return transcript


async def verify_two_turn_lifecycle() -> None:
    websocket = FakeRtcAsrWebSocket()
    connect_count = 0

    async def connect(*_args: object, **_kwargs: object) -> FakeRtcAsrWebSocket:
        nonlocal connect_count
        connect_count += 1
        return websocket

    session = make_session()
    with patch("acc_pipecat_voice_pipeline.websockets.connect", connect):
        first = await transcribe_turn(session, b"\x01\x00" * 320)
        second = await transcribe_turn(session, b"\x02\x00" * 320)

    controls = [event["type"] for event in websocket.sent if isinstance(event, dict)]
    assert connect_count == 1, connect_count
    assert controls == ["start", "finalize", "start", "finalize"], controls
    assert websocket.start_count == 2, websocket.start_count
    assert websocket.finalize_count == 2, websocket.finalize_count
    assert [first, second] == ["completed turn 1", "completed turn 2"]


async def verify_close_interrupts_final_wait() -> None:
    websocket = FakeRtcAsrWebSocket(emit_finals=False)

    async def connect(*_args: object, **_kwargs: object) -> FakeRtcAsrWebSocket:
        return websocket

    session = make_session()
    with (
        patch("acc_pipecat_voice_pipeline.websockets.connect", connect),
        patch.dict(os.environ, {"RTC_ASR_FINAL_TIMEOUT_SEC": "12", "RTC_ASR_CLOSE_TIMEOUT_SEC": "0.05"}),
    ):
        await session.stream_rtc_asr_audio(b"\x01\x00" * 320)
        finalization = asyncio.create_task(
            session.transcribe(InputAudioRawFrame(audio=b"", sample_rate=INPUT_SAMPLE_RATE, num_channels=1))
        )
        while websocket.finalize_count == 0:
            await asyncio.sleep(0)
        await asyncio.wait_for(session.close_rtc_asr_stream("test_disconnect"), timeout=0.25)
        await asyncio.gather(finalization, return_exceptions=True)

    assert websocket.closed
    assert session.rtc_asr_ws is None


async def verify_empty_final_uses_current_interim() -> None:
    websocket = FakeRtcAsrWebSocket(interim_on_audio="hello", empty_final=True)

    async def connect(*_args: object, **_kwargs: object) -> FakeRtcAsrWebSocket:
        return websocket

    session = make_session()
    with patch("acc_pipecat_voice_pipeline.websockets.connect", connect):
        await session.stream_rtc_asr_audio(b"\x01\x00" * 320)
        transcript, meta, _frame = await session.transcribe(
            InputAudioRawFrame(audio=b"", sample_rate=INPUT_SAMPLE_RATE, num_channels=1)
        )

    assert transcript == "hello", transcript
    assert meta["finalTranscriptSource"] == "rtc_asr_interim_fallback", meta
    assert session.rtc_asr_current_interim_text == ""


async def verify_interim_without_final_is_not_promoted() -> None:
    websocket = FakeRtcAsrWebSocket(emit_finals=False, interim_on_audio="partial request")

    async def connect(*_args: object, **_kwargs: object) -> FakeRtcAsrWebSocket:
        return websocket

    session = make_session()
    with (
        patch("acc_pipecat_voice_pipeline.websockets.connect", connect),
        patch.dict(os.environ, {"RTC_ASR_FINAL_TIMEOUT_SEC": "0.05"}),
    ):
        await session.stream_rtc_asr_audio(b"\x01\x00" * 320)
        transcript, meta, _frame = await session.transcribe(
            InputAudioRawFrame(audio=b"", sample_rate=INPUT_SAMPLE_RATE, num_channels=1)
        )

    assert transcript == "", transcript
    assert meta["finalEventObserved"] is False, meta
    assert meta["finalTranscriptSource"] == "rtc_asr_final", meta
    assert session.rtc_asr_current_interim_text == ""


async def main() -> None:
    await verify_two_turn_lifecycle()
    await verify_close_interrupts_final_wait()
    await verify_empty_final_uses_current_interim()
    await verify_interim_without_final_is_not_promoted()
    print(
        json.dumps(
            {
                "ok": True,
                "twoTurnLifecycle": "one_connection_two_starts_two_finalizes_two_transcripts",
                "promptClose": True,
                "emptyFinalFallback": "current_utterance_interim",
                "stalledInterim": "not_promoted_without_final_event",
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
