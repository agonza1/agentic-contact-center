#!/usr/bin/env python3
"""Regression proof for persistent deterministic Kokoro PCM caching."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / ".pipecat-runtime"))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import acc_pipecat_voice_pipeline as pipeline  # noqa: E402
from acc_pipecat_voice_pipeline import AccVoicePipelineSession  # noqa: E402
from pipecat.frames.frames import TextFrame  # noqa: E402


class FakeResponse:
    def __init__(self, audio: bytes, *, read_delay: float = 0):
        self.audio = audio
        self.offset = 0
        self.read_delay = read_delay

    def read(self, size: int) -> bytes:
        chunk = self.audio[self.offset : self.offset + size]
        self.offset += len(chunk)
        if chunk and self.read_delay:
            time.sleep(self.read_delay)
        return chunk

    def close(self) -> None:
        return None


async def main() -> None:
    source_audio = (b"\x01\x02" * 2_400) + (b"\x03\x04" * 960)
    provider_calls = 0
    streaming_miss_text = "Cache miss streams while filling deterministic cache."
    streaming_miss_read_delay = 0.05

    def fake_open_http_stream(*args: object, **_kwargs: object) -> FakeResponse:
        nonlocal provider_calls
        provider_calls += 1
        payload = args[2] if len(args) > 2 and isinstance(args[2], dict) else {}
        read_delay = streaming_miss_read_delay if payload.get("input") == streaming_miss_text else 0
        return FakeResponse(source_audio, read_delay=read_delay)

    async def synthesize(
        session: AccVoicePipelineSession,
        *,
        text: str = "Cache this deterministic response.",
        chunk_delay: float = 0,
    ) -> tuple[bytes, dict[str, object], float | None]:
        chunks: list[bytes] = []
        last_metadata: dict[str, object] = {}
        first_chunk_at: float | None = None
        async for chunk, _sample_rate, metadata in session.stream_synthesize(
            TextFrame(text),
            chunk_bytes=960,
        ):
            if first_chunk_at is None:
                first_chunk_at = asyncio.get_running_loop().time()
            chunks.append(chunk)
            last_metadata = metadata
            if chunk_delay:
                await asyncio.sleep(chunk_delay)
        return b"".join(chunks), last_metadata, first_chunk_at

    with tempfile.TemporaryDirectory(prefix="acc-tts-cache-") as cache_dir:
        with patch.dict(os.environ, {"ACC_TTS_CACHE_DIR": cache_dir}, clear=False):
            with patch.object(pipeline, "open_http_stream", fake_open_http_stream):
                session = AccVoicePipelineSession(
                    acc_url="http://acc.invalid",
                    call_id="tts-cache-regression",
                    readiness=None,
                )
                first_audio, first_metadata, _first_chunk_at = await synthesize(session)
                second_audio, second_metadata, _second_chunk_at = await synthesize(session)
                concurrent_started_at = asyncio.get_running_loop().time()
                concurrent_a = AccVoicePipelineSession(
                    acc_url="http://acc.invalid",
                    call_id="tts-cache-concurrent-a",
                    readiness=None,
                )
                concurrent_b = AccVoicePipelineSession(
                    acc_url="http://acc.invalid",
                    call_id="tts-cache-concurrent-b",
                    readiness=None,
                )
                (concurrent_audio_a, concurrent_metadata_a, concurrent_first_a), (
                    concurrent_audio_b,
                    concurrent_metadata_b,
                    concurrent_first_b,
                ) = await asyncio.gather(
                    synthesize(concurrent_a, chunk_delay=0.01),
                    synthesize(concurrent_b, chunk_delay=0.01),
                )
                cached_lock_count = len(pipeline.TTS_CACHE_LOCKS)
                openai_session = AccVoicePipelineSession(
                    acc_url="http://acc.invalid",
                    call_id="tts-cache-openai",
                    readiness=None,
                    conversation_mode="openai_llm",
                )
                openai_audio_a, openai_metadata_a, _ = await synthesize(
                    openai_session,
                    text="A unique generated response number one.",
                )
                openai_audio_b, openai_metadata_b, _ = await synthesize(
                    openai_session,
                    text="A different generated response number two.",
                )
                await openai_session.prewarm_conversation_tts_cache()
                streaming_miss_started_at = asyncio.get_running_loop().time()
                streaming_miss_audio, streaming_miss_metadata, streaming_miss_first_chunk_at = await synthesize(
                    session,
                    text=streaming_miss_text,
                )
                miss_lock_text = "Cache miss lock remains during fill."
                miss_lock_path = pipeline.tts_cache_path(miss_lock_text, 24000)
                if miss_lock_path is None:
                    raise AssertionError("expected deterministic miss TTS cache path")
                miss_lock_session = AccVoicePipelineSession(
                    acc_url="http://acc.invalid",
                    call_id="tts-cache-miss-lock-probe",
                    readiness=None,
                )
                miss_lock_generator = miss_lock_session.stream_synthesize(
                    TextFrame(miss_lock_text),
                    chunk_bytes=960,
                )
                await miss_lock_generator.__anext__()
                miss_lock = pipeline.TTS_CACHE_LOCKS[miss_lock_path]
                miss_lock_held_during_fill = True
                try:
                    await asyncio.wait_for(miss_lock.acquire(), timeout=0.05)
                    miss_lock_held_during_fill = False
                    miss_lock.release()
                except asyncio.TimeoutError:
                    pass
                finally:
                    await miss_lock_generator.aclose()
                lock_probe_text = "Cache lock ownership probe."
                lock_probe_path = pipeline.tts_cache_path(lock_probe_text, 24000)
                if lock_probe_path is None:
                    raise AssertionError("expected deterministic TTS cache path")
                lock_probe_path.write_bytes(source_audio)
                lock_probe_session = AccVoicePipelineSession(
                    acc_url="http://acc.invalid",
                    call_id="tts-cache-lock-probe",
                    readiness=None,
                )
                lock_probe_generator = lock_probe_session.stream_synthesize(
                    TextFrame(lock_probe_text),
                    chunk_bytes=960,
                )
                await lock_probe_generator.__anext__()
                lock_probe_lock = pipeline.TTS_CACHE_LOCKS[lock_probe_path]
                await lock_probe_lock.acquire()
                await lock_probe_generator.aclose()
                lock_still_owned_by_probe = lock_probe_lock.locked()
                lock_probe_lock.release()
                cache_files = list(Path(cache_dir).glob("*.pcm"))

    concurrent_first_delta = abs((concurrent_first_a or 0) - (concurrent_first_b or 0))
    concurrent_first_wait = max((concurrent_first_a or 0) - concurrent_started_at, (concurrent_first_b or 0) - concurrent_started_at)
    streaming_miss_first_wait = (streaming_miss_first_chunk_at or 0) - streaming_miss_started_at

    result = {
        "ok": (
            first_audio == source_audio
            and second_audio == source_audio
            and concurrent_audio_a == source_audio
            and concurrent_audio_b == source_audio
            and first_metadata.get("cacheHit") is False
            and second_metadata.get("cacheHit") is True
            and concurrent_metadata_a.get("cacheHit") is True
            and concurrent_metadata_b.get("cacheHit") is True
            and openai_audio_a == source_audio
            and openai_audio_b == source_audio
            and streaming_miss_audio == source_audio
            and openai_metadata_a.get("cacheHit") is False
            and openai_metadata_b.get("cacheHit") is False
            and streaming_miss_metadata.get("cacheHit") is False
            and provider_calls == 5
            and len(cache_files) == 3
            and len(pipeline.TTS_CACHE_LOCKS) == cached_lock_count + 3
            and concurrent_first_delta < 0.05
            and concurrent_first_wait < 0.05
            and streaming_miss_first_wait < streaming_miss_read_delay * 3
            and miss_lock_held_during_fill
            and lock_still_owned_by_probe
        ),
        "providerCalls": provider_calls,
        "firstCacheHit": first_metadata.get("cacheHit"),
        "secondCacheHit": second_metadata.get("cacheHit"),
        "concurrentFirstDeltaMs": round(concurrent_first_delta * 1000),
        "concurrentFirstWaitMs": round(concurrent_first_wait * 1000),
        "streamingMissFirstWaitMs": round(streaming_miss_first_wait * 1000),
        "openAiCacheHits": [openai_metadata_a.get("cacheHit"), openai_metadata_b.get("cacheHit")],
        "audioBytes": len(second_audio),
        "cacheFiles": len(cache_files),
        "cacheLocks": len(pipeline.TTS_CACHE_LOCKS),
        "missLockHeldDuringFill": miss_lock_held_during_fill,
        "lockStillOwnedByProbe": lock_still_owned_by_probe,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    asyncio.run(main())
