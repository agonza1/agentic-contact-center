#!/usr/bin/env python3
"""Regression proof for persistent deterministic Kokoro PCM caching."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / ".pipecat-runtime"))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import acc_pipecat_voice_pipeline as pipeline  # noqa: E402
from acc_pipecat_voice_pipeline import AccVoicePipelineSession  # noqa: E402
from pipecat.frames.frames import TextFrame  # noqa: E402


class FakeResponse:
    def __init__(self, audio: bytes):
        self.audio = audio
        self.offset = 0

    def read(self, size: int) -> bytes:
        chunk = self.audio[self.offset : self.offset + size]
        self.offset += len(chunk)
        return chunk

    def close(self) -> None:
        return None


async def main() -> None:
    source_audio = (b"\x01\x02" * 2_400) + (b"\x03\x04" * 960)
    provider_calls = 0

    def fake_open_http_stream(*_args: object, **_kwargs: object) -> FakeResponse:
        nonlocal provider_calls
        provider_calls += 1
        return FakeResponse(source_audio)

    async def synthesize(session: AccVoicePipelineSession) -> tuple[bytes, dict[str, object]]:
        chunks: list[bytes] = []
        last_metadata: dict[str, object] = {}
        async for chunk, _sample_rate, metadata in session.stream_synthesize(
            TextFrame("Cache this deterministic response."),
            chunk_bytes=960,
        ):
            chunks.append(chunk)
            last_metadata = metadata
        return b"".join(chunks), last_metadata

    with tempfile.TemporaryDirectory(prefix="acc-tts-cache-") as cache_dir:
        with patch.dict(os.environ, {"ACC_TTS_CACHE_DIR": cache_dir}, clear=False):
            with patch.object(pipeline, "open_http_stream", fake_open_http_stream):
                session = AccVoicePipelineSession(
                    acc_url="http://acc.invalid",
                    call_id="tts-cache-regression",
                    readiness=None,
                )
                first_audio, first_metadata = await synthesize(session)
                second_audio, second_metadata = await synthesize(session)
                cache_files = list(Path(cache_dir).glob("*.pcm"))

    result = {
        "ok": (
            first_audio == source_audio
            and second_audio == source_audio
            and first_metadata.get("cacheHit") is False
            and second_metadata.get("cacheHit") is True
            and provider_calls == 1
            and len(cache_files) == 1
        ),
        "providerCalls": provider_calls,
        "firstCacheHit": first_metadata.get("cacheHit"),
        "secondCacheHit": second_metadata.get("cacheHit"),
        "audioBytes": len(second_audio),
        "cacheFiles": len(cache_files),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    asyncio.run(main())
