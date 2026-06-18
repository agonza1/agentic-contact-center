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
      schemaVersion: number;
      proofContract: {
        requiredOutcomes: string[];
        requiredEventTypes: string[];
        queueAttentionFilter: string;
      };
      health: { ok: boolean };
      summary: {
        schemaVersion: number;
        proofContract: {
          requiredOutcomes: string[];
          requiredEventTypes: string[];
          queueAttentionFilter: string;
        };
        queueAttention: {
          attentionRequired: number;
          oldestAttentionAgeMs: number | null;
          oldestAttentionCallId: string | null;
          oldestAttentionStartedAt: string | null;
          oldestAttentionFlowState: string | null;
          oldestAttentionOpenclawSessionLabel: string | null;
          oldestAttentionReason: string | null;
          oldestAttentionSource: string | null;
          totalCalls: number;
        };
        healthOk: boolean;
        scripted: {
          agentTurns: number;
          callerTurns: number;
          eventCount: number;
          flowState: string;
          latencyMarkCount: number;
          transcriptTurns: number;
          latencyStages: string[];
        };
        fallback: {
          eventCount: number;
          mode: string | null;
          reason: string | null;
          flowState: string;
          eventTypes: string[];
        };
      };
      scripted: { outcome: string; checkpoints: { wrapped: { pipecatFlow: { script: { completed: boolean } } } } };
      fallback: { outcome: string; checkpoint: { demoFallback: { mode: string | null } } };
    };

    const latestArtifact = JSON.parse(await readFile(latestOutputPath, "utf8")) as typeof artifact;

    assert.equal(artifact.schemaVersion, 1);
    assert.deepEqual(artifact.proofContract.requiredOutcomes, ["scripted_wrap_complete", "fail_closed_handoff"]);
    assert.equal(artifact.proofContract.requiredEventTypes.includes("policy_hold_entered"), true);
    assert.equal(artifact.proofContract.requiredEventTypes.includes("demo_fallback_triggered"), true);
    assert.equal(artifact.proofContract.requiredEventTypes.includes("human_handoff_started"), true);
    assert.equal(artifact.proofContract.queueAttentionFilter, "attentionRequired=true");
    assert.equal(artifact.summary.schemaVersion, 1);
    assert.deepEqual(artifact.summary.proofContract, artifact.proofContract);
    assert.equal(artifact.health.ok, true);
    assert.equal(artifact.summary.healthOk, true);
    assert.equal(artifact.summary.queueAttention.totalCalls, 1);
    assert.equal(artifact.summary.queueAttention.attentionRequired, 1);
    assert.equal(typeof artifact.summary.queueAttention.oldestAttentionCallId, "string");
    assert.equal(typeof artifact.summary.queueAttention.oldestAttentionOpenclawSessionLabel, "string");
    assert.equal(typeof artifact.summary.queueAttention.oldestAttentionAgeMs, "number");
    assert.equal(typeof artifact.summary.queueAttention.oldestAttentionStartedAt, "string");
    assert.equal(artifact.summary.queueAttention.oldestAttentionFlowState, "wrap");
    assert.equal(artifact.summary.queueAttention.oldestAttentionReason, "pipecat tool exceeded latency budget");
    assert.equal(artifact.summary.queueAttention.oldestAttentionSource, "fallback");
    assert.equal(artifact.scripted.outcome, "scripted_wrap_complete");
    assert.equal(artifact.scripted.checkpoints.wrapped.pipecatFlow.script.completed, true);
    assert.equal(artifact.summary.scripted.flowState, "wrap");
    assert.equal(artifact.summary.scripted.transcriptTurns > 0, true);
    assert.equal(artifact.summary.scripted.agentTurns > 0, true);
    assert.equal(artifact.summary.scripted.callerTurns, 4);
    assert.equal(artifact.summary.scripted.eventCount > 0, true);
    assert.equal(artifact.summary.scripted.latencyMarkCount > 0, true);
    assert.equal(artifact.summary.scripted.latencyStages.includes("policy_hold_entered"), true);
    assert.equal(artifact.fallback.outcome, "fail_closed_handoff");
    assert.equal(artifact.fallback.checkpoint.demoFallback.mode, "tool_timeout");
    assert.equal(artifact.summary.fallback.mode, "tool_timeout");
    assert.equal(artifact.summary.fallback.reason, "pipecat tool exceeded latency budget");
    assert.equal(artifact.summary.fallback.flowState, "wrap");
    assert.equal(artifact.summary.fallback.eventCount > 0, true);
    assert.equal(artifact.summary.fallback.eventTypes.includes("human_handoff_started"), true);
    assert.deepEqual(latestArtifact, artifact);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

