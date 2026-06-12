import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("demo proof runner writes a reviewable artifact for scripted and fallback flows", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const scriptPath = path.join(repoRoot, "scripts", "demo-proof.mjs");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-proof-"));
  const outputPath = path.join(tempDir, "demo-proof.json");
  const latestOutputPath = path.join(tempDir, "demo-proof-latest.json");

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [scriptPath, "--out", outputPath, "--latest-out", latestOutputPath],
      {
        cwd: repoRoot,
      },
    );

    assert.match(stdout, /Saved proof artifact/);
    assert.match(stdout, /Updated latest proof artifact/);

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      health: { ok: boolean };
      summary: {
        healthOk: boolean;
        scripted: {
          flowState: string;
          transcriptTurns: number;
          latencyStages: string[];
        };
        fallback: {
          mode: string | null;
          flowState: string;
          eventTypes: string[];
        };
      };
      scripted: { outcome: string; checkpoints: { wrapped: { pipecatFlow: { script: { completed: boolean } } } } };
      fallback: { outcome: string; checkpoint: { demoFallback: { mode: string | null } } };
    };

    const latestArtifact = JSON.parse(await readFile(latestOutputPath, "utf8")) as typeof artifact;

    assert.equal(artifact.health.ok, true);
    assert.equal(artifact.summary.healthOk, true);
    assert.equal(artifact.scripted.outcome, "scripted_wrap_complete");
    assert.equal(artifact.scripted.checkpoints.wrapped.pipecatFlow.script.completed, true);
    assert.equal(artifact.summary.scripted.flowState, "wrap");
    assert.equal(artifact.summary.scripted.transcriptTurns > 0, true);
    assert.equal(artifact.summary.scripted.latencyStages.includes("policy_hold_entered"), true);
    assert.equal(artifact.fallback.outcome, "fail_closed_handoff");
    assert.equal(artifact.fallback.checkpoint.demoFallback.mode, "tool_timeout");
    assert.equal(artifact.summary.fallback.mode, "tool_timeout");
    assert.equal(artifact.summary.fallback.flowState, "wrap");
    assert.equal(artifact.summary.fallback.eventTypes.includes("human_handoff_started"), true);
    assert.deepEqual(latestArtifact, artifact);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

