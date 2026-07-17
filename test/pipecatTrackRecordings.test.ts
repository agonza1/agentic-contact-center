import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("ACC Pipecat pipeline wires caller and agent audio into separate track recorder", () => {
  const pipeline = readFileSync("scripts/acc_pipecat_voice_pipeline.py", "utf8");
  assert.match(pipeline, /SeparateTrackRecorder/);
  assert.match(pipeline, /record_caller_track/);
  assert.match(pipeline, /record_agent_track/);
  assert.match(pipeline, /write_track_recording_manifest\("tts\.stream_completed"\)/);
  assert.match(pipeline, /trackRecordings/);
});

test("track recording proof emits caller, agent, and mixed WAV artifacts", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "acc-track-recordings-"));
  const stdout = execFileSync("python3", [
    "scripts/pipecat-track-recording-proof.py",
    "--out-dir",
    outDir,
    "--call-id",
    "qa-track-proof",
  ], { encoding: "utf8" });
  const summary = JSON.parse(stdout) as {
    ok: boolean;
    manifest: string;
    tracks: Record<string, {
      path: string;
      readiness: string;
      audioBytes: number;
      durationMs: number;
      timelineStartedAtMs: number;
      timelineEndedAtMs: number;
      sha256: string;
      segmentCount: number;
    }>;
    segments: Array<{ track: string; startedAtMs: number; durationMs: number; eventId: string }>;
  };
  assert.equal(summary.ok, true);
  assert.match(summary.manifest, /qa-track-proof-track-recording-manifest\.json$/);
  for (const track of ["caller", "agent", "mixed"]) {
    assert.equal(summary.tracks[track].readiness, "ready");
    assert.ok(summary.tracks[track].path.endsWith(`qa-track-proof-${track}.wav`));
    assert.ok(summary.tracks[track].audioBytes > 0);
    assert.match(summary.tracks[track].sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(summary.tracks.caller.segmentCount, 1);
  assert.equal(summary.tracks.agent.segmentCount, 1);
  assert.equal(summary.tracks.mixed.segmentCount, 2);
  assert.equal(summary.tracks.caller.timelineStartedAtMs, 0);
  assert.equal(summary.tracks.agent.timelineStartedAtMs, 320);
  assert.equal(summary.tracks.mixed.timelineStartedAtMs, 0);
  assert.equal(summary.tracks.mixed.timelineEndedAtMs, 840);
  assert.ok(summary.tracks.mixed.durationMs >= summary.tracks.caller.durationMs);
  assert.deepEqual(summary.segments.map((segment) => segment.eventId), [
    "stt.finalize_started",
    "tts.stream_started",
  ]);
  const manifest = JSON.parse(readFileSync(summary.manifest, "utf8"));
  assert.equal(manifest.review.localArtifactsOnly, true);
  assert.equal(manifest.review.customerData, "none");
  assert.equal(manifest.review.qaCanInspectCallerAndAgentAudio, true);
});
