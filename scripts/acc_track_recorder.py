#!/usr/bin/env python3
"""Local caller/agent/mixed-track recorder for ACC voice proof artifacts."""

from __future__ import annotations

import hashlib
import json
import re
import time
import wave
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


SAMPLE_WIDTH_BYTES = 2
DEFAULT_TRACK_SAMPLE_RATE = 16000


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def safe_artifact_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip("-")
    return cleaned[:96] or "acc-call"


def resample_pcm16_mono(pcm: bytes, from_rate: int, to_rate: int) -> bytes:
    if from_rate == to_rate:
        return pcm
    source_samples = len(pcm) // SAMPLE_WIDTH_BYTES
    if source_samples <= 0:
        return b""
    target_samples = max(round(source_samples * to_rate / from_rate), 1)
    out = bytearray(target_samples * SAMPLE_WIDTH_BYTES)
    for target_index in range(target_samples):
        source_index = min(round(target_index * from_rate / to_rate), source_samples - 1)
        source_offset = source_index * SAMPLE_WIDTH_BYTES
        target_offset = target_index * SAMPLE_WIDTH_BYTES
        out[target_offset:target_offset + SAMPLE_WIDTH_BYTES] = pcm[source_offset:source_offset + SAMPLE_WIDTH_BYTES]
    return bytes(out)


def write_wav(path: Path, pcm: bytes, sample_rate_hz: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(SAMPLE_WIDTH_BYTES)
        wav_file.setframerate(sample_rate_hz)
        wav_file.writeframes(pcm)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def duration_ms(pcm: bytes, sample_rate_hz: int) -> int:
    return round(len(pcm) / max(sample_rate_hz * SAMPLE_WIDTH_BYTES, 1) * 1000)


@dataclass
class TrackSegment:
    track: str
    started_at_ms: int
    duration_ms: int
    audio_bytes: int
    source_sample_rate_hz: int
    sample_rate_hz: int
    event_id: str | None
    source: str
    recorded_at: str

    def as_json(self) -> dict[str, Any]:
        return {
            "track": self.track,
            "startedAtMs": self.started_at_ms,
            "durationMs": self.duration_ms,
            "audioBytes": self.audio_bytes,
            "sourceSampleRateHz": self.source_sample_rate_hz,
            "sampleRateHz": self.sample_rate_hz,
            "eventId": self.event_id,
            "source": self.source,
            "recordedAt": self.recorded_at,
        }


class SeparateTrackRecorder:
    """Collect PCM chunks and emit caller-only, agent-only, and mixed WAVs."""

    def __init__(self, *, artifact_dir: str | Path, call_id: str, sample_rate_hz: int = DEFAULT_TRACK_SAMPLE_RATE) -> None:
        self.artifact_dir = Path(artifact_dir)
        self.call_id = call_id
        self.artifact_id = safe_artifact_id(call_id)
        self.sample_rate_hz = sample_rate_hz
        self.started_at = now_iso()
        self.started_monotonic = time.monotonic()
        self._chunks: dict[str, list[tuple[int, bytes]]] = {"caller": [], "agent": []}
        self._segments: list[TrackSegment] = []
        self.last_manifest: dict[str, Any] | None = None

    def _elapsed_ms(self) -> int:
        return round((time.monotonic() - self.started_monotonic) * 1000)

    def record_track_audio(
        self,
        track: str,
        pcm: bytes,
        *,
        sample_rate_hz: int,
        event_id: str | None = None,
        source: str,
        started_at_ms: int | None = None,
    ) -> TrackSegment | None:
        if track not in self._chunks:
            raise ValueError(f"unknown recording track: {track}")
        if not pcm:
            return None
        aligned_pcm = pcm[: len(pcm) - (len(pcm) % SAMPLE_WIDTH_BYTES)]
        normalized = resample_pcm16_mono(aligned_pcm, sample_rate_hz, self.sample_rate_hz)
        start_ms = self._elapsed_ms() if started_at_ms is None else max(round(started_at_ms), 0)
        segment = TrackSegment(
            track=track,
            started_at_ms=start_ms,
            duration_ms=duration_ms(normalized, self.sample_rate_hz),
            audio_bytes=len(normalized),
            source_sample_rate_hz=sample_rate_hz,
            sample_rate_hz=self.sample_rate_hz,
            event_id=event_id,
            source=source,
            recorded_at=now_iso(),
        )
        self._chunks[track].append((start_ms, normalized))
        self._segments.append(segment)
        return segment

    def record_caller_audio(self, pcm: bytes, *, sample_rate_hz: int, event_id: str | None = None, started_at_ms: int | None = None) -> TrackSegment | None:
        return self.record_track_audio(
            "caller",
            pcm,
            sample_rate_hz=sample_rate_hz,
            event_id=event_id,
            source="transport.input",
            started_at_ms=started_at_ms,
        )

    def record_agent_audio(self, pcm: bytes, *, sample_rate_hz: int, event_id: str | None = None, started_at_ms: int | None = None) -> TrackSegment | None:
        return self.record_track_audio(
            "agent",
            pcm,
            sample_rate_hz=sample_rate_hz,
            event_id=event_id,
            source="transport.output",
            started_at_ms=started_at_ms,
        )

    def _linear_track(self, track: str) -> bytes:
        chunks = self._chunks[track]
        if not chunks:
            return b""
        return b"".join(pcm for _start_ms, pcm in chunks)

    def _mixed_track(self) -> bytes:
        all_chunks = [("caller", *chunk) for chunk in self._chunks["caller"]] + [("agent", *chunk) for chunk in self._chunks["agent"]]
        if not all_chunks:
            return b""
        total_samples = 0
        normalized_chunks: list[tuple[int, bytes]] = []
        for _track, start_ms, pcm in all_chunks:
            start_sample = round(start_ms * self.sample_rate_hz / 1000)
            sample_count = len(pcm) // SAMPLE_WIDTH_BYTES
            total_samples = max(total_samples, start_sample + sample_count)
            normalized_chunks.append((start_sample, pcm))
        mixed = [0] * total_samples
        for start_sample, pcm in normalized_chunks:
            for index in range(0, len(pcm), SAMPLE_WIDTH_BYTES):
                sample_index = start_sample + index // SAMPLE_WIDTH_BYTES
                value = int.from_bytes(pcm[index:index + SAMPLE_WIDTH_BYTES], "little", signed=True)
                mixed[sample_index] = max(-32768, min(32767, mixed[sample_index] + value))
        return b"".join(value.to_bytes(SAMPLE_WIDTH_BYTES, "little", signed=True) for value in mixed)

    def _timeline_bounds(self, track: str) -> tuple[int | None, int | None]:
        segments = self._segments if track == "mixed" else [segment for segment in self._segments if segment.track == track]
        if not segments:
            return None, None
        started_at_ms = min(segment.started_at_ms for segment in segments)
        ended_at_ms = max(segment.started_at_ms + segment.duration_ms for segment in segments)
        return started_at_ms, ended_at_ms

    def _track_metadata(self, track: str, path: Path, pcm: bytes) -> dict[str, Any]:
        audio_bytes = len(pcm)
        started_at_ms, ended_at_ms = self._timeline_bounds(track)
        return {
            "track": track,
            "path": str(path),
            "sampleRateHz": self.sample_rate_hz,
            "channels": 1,
            "format": "wav_pcm16_mono",
            "audioBytes": audio_bytes,
            "durationMs": duration_ms(pcm, self.sample_rate_hz),
            "timelineStartedAtMs": started_at_ms,
            "timelineEndedAtMs": ended_at_ms,
            "segmentCount": len([segment for segment in self._segments if segment.track == track]) if track != "mixed" else len(self._segments),
            "sha256": sha256_file(path),
            "sizeBytes": path.stat().st_size,
            "readiness": "ready" if audio_bytes > 0 else "blocked",
        }

    def write_manifest(self, *, reason: str, stage_events: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        caller_path = self.artifact_dir / f"{self.artifact_id}-caller.wav"
        agent_path = self.artifact_dir / f"{self.artifact_id}-agent.wav"
        mixed_path = self.artifact_dir / f"{self.artifact_id}-mixed.wav"
        manifest_path = self.artifact_dir / f"{self.artifact_id}-track-recording-manifest.json"
        caller_pcm = self._linear_track("caller")
        agent_pcm = self._linear_track("agent")
        mixed_pcm = self._mixed_track()
        write_wav(caller_path, caller_pcm, self.sample_rate_hz)
        write_wav(agent_path, agent_pcm, self.sample_rate_hz)
        write_wav(mixed_path, mixed_pcm, self.sample_rate_hz)
        tracks = {
            "caller": self._track_metadata("caller", caller_path, caller_pcm),
            "agent": self._track_metadata("agent", agent_path, agent_pcm),
            "mixed": self._track_metadata("mixed", mixed_path, mixed_pcm),
        }
        manifest = {
            "schemaVersion": "acc.track_recordings.v1",
            "generatedAt": now_iso(),
            "reason": reason,
            "callId": self.call_id,
            "recordingStartedAt": self.started_at,
            "sampleRateHz": self.sample_rate_hz,
            "tracks": tracks,
            "segments": [segment.as_json() for segment in self._segments],
            "stageEvents": stage_events or [],
            "review": {
                "localArtifactsOnly": True,
                "customerData": "none",
                "ready": all(track["readiness"] == "ready" for track in tracks.values()),
                "qaCanInspectCallerAndAgentAudio": tracks["caller"]["audioBytes"] > 0 and tracks["agent"]["audioBytes"] > 0,
            },
            "limitations": [
                "Artifacts are local proof files and must not be uploaded unless explicitly approved.",
                "Mixed-track alignment uses adapter monotonic offsets recorded with the caller and agent chunks.",
            ],
        }
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        manifest["manifestPath"] = str(manifest_path)
        self.last_manifest = manifest
        return manifest
