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
        callAttentionSort: string;
        fallbackSourceTrail: string;
      };
      health: {
        ok: boolean;
        pipecatFlow: {
          ready: boolean;
          prototypeMode: string;
          transport: string;
          runtimeEngine: string;
          credentialsMode: string;
          toolCoverage: string[];
        };
      };
      gitRevision: string | null;
      summary: {
        schemaVersion: number;
        proofContract: {
          requiredOutcomes: string[];
          requiredEventTypes: string[];
          queueAttentionFilter: string;
          callAttentionSort: string;
          fallbackSourceTrail: string;
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
        callAttentionList: {
          route: string;
          firstCallId: string;
          firstAttentionStartedAt: string | null;
          filteredSummary: { totalCalls: number; attentionRequired: number };
        };
        fallbackSourceTrail: {
          route: string;
          returnedEvents: number;
          filteredSource: string | null;
          eventTypes: string[];
        };
        healthOk: boolean;
        gitRevision: string | null;
        pipecatRuntime: {
          ready: boolean;
          prototypeMode: string;
          transport: string;
          runtimeEngine: string;
          credentialsMode: string;
          toolCoverage: string[];
        };
        scripted: {
          agentTurns: number;
          callerTurns: number;
          eventCount: number;
          eventTypes: string[];
          flowState: string;
          latencyMarkCount: number;
          transcriptTurns: number;
          latencyStages: string[];
        };
        fallback: {
          eventCount: number;
          eventTypes: string[];
          mode: string | null;
          reason: string | null;
          flowState: string;
        };
      };
      scripted: { outcome: string; checkpoints: { wrapped: { pipecatFlow: { script: { completed: boolean } } } } };
      fallback: { outcome: string; callId: string; checkpoint: { demoFallback: { mode: string | null } } };
    };

    const latestArtifact = JSON.parse(await readFile(latestOutputPath, "utf8")) as typeof artifact;

    assert.equal(artifact.schemaVersion, 1);
    assert.deepEqual(artifact.proofContract.requiredOutcomes, ["scripted_wrap_complete", "fail_closed_handoff"]);
    assert.equal(artifact.proofContract.requiredEventTypes.includes("policy_hold_entered"), true);
    assert.equal(artifact.proofContract.requiredEventTypes.includes("demo_fallback_triggered"), true);
    assert.equal(artifact.proofContract.requiredEventTypes.includes("human_handoff_started"), true);
    assert.equal(artifact.proofContract.queueAttentionFilter, "attentionRequired=true&attentionReason=pipecat%20tool%20exceeded%20latency%20budget");
    assert.equal(artifact.proofContract.callAttentionSort, "attentionRequired=true&sort=attentionStartedAt&limit=1");
    assert.equal(artifact.proofContract.fallbackSourceTrail, "events?source=tool_timeout_fail_closed");
    assert.equal(artifact.summary.schemaVersion, 1);
    assert.deepEqual(artifact.summary.proofContract, artifact.proofContract);
    assert.equal(artifact.health.ok, true);
    assert.equal(artifact.health.pipecatFlow.prototypeMode, "pipecat_local_runtime");
    assert.equal(artifact.health.pipecatFlow.runtimeEngine, "pipecat-ai");
    assert.equal(artifact.health.pipecatFlow.credentialsMode, "mocked");
    assert.equal(artifact.summary.healthOk, true);
    assert.deepEqual(artifact.summary.pipecatRuntime, artifact.health.pipecatFlow);
    assert.equal(artifact.summary.pipecatRuntime.ready, true);
    assert.equal(artifact.summary.pipecatRuntime.prototypeMode, "pipecat_local_runtime");
    assert.equal(artifact.summary.pipecatRuntime.transport, "local_process");
    assert.equal(artifact.summary.pipecatRuntime.runtimeEngine, "pipecat-ai");
    assert.equal(artifact.summary.pipecatRuntime.credentialsMode, "mocked");
    assert.equal(artifact.summary.pipecatRuntime.toolCoverage.includes("ask_operator"), true);
    assert.match(artifact.gitRevision ?? "", /^[0-9a-f]{7,12}$/);
    assert.equal(artifact.summary.gitRevision, artifact.gitRevision);
    assert.equal(artifact.summary.queueAttention.totalCalls, 1);
    assert.equal(artifact.summary.queueAttention.attentionRequired, 1);
    assert.equal(typeof artifact.summary.queueAttention.oldestAttentionCallId, "string");
    assert.equal(typeof artifact.summary.queueAttention.oldestAttentionOpenclawSessionLabel, "string");
    assert.equal(typeof artifact.summary.queueAttention.oldestAttentionAgeMs, "number");
    assert.equal(typeof artifact.summary.queueAttention.oldestAttentionStartedAt, "string");
    assert.equal(artifact.summary.queueAttention.oldestAttentionFlowState, "wrap");
    assert.equal(artifact.summary.queueAttention.oldestAttentionReason, "pipecat tool exceeded latency budget");
    assert.equal(artifact.summary.queueAttention.oldestAttentionSource, "fallback");
    assert.equal(artifact.summary.callAttentionList.route, artifact.proofContract.callAttentionSort);
    assert.equal(artifact.summary.callAttentionList.firstCallId, artifact.summary.queueAttention.oldestAttentionCallId);
    assert.equal(artifact.summary.callAttentionList.firstAttentionStartedAt, artifact.summary.queueAttention.oldestAttentionStartedAt);
    assert.equal(artifact.summary.callAttentionList.filteredSummary.totalCalls, 1);
    assert.equal(artifact.summary.callAttentionList.filteredSummary.attentionRequired, 1);
    assert.equal(artifact.summary.fallbackSourceTrail.route, "calls/" + artifact.fallback.callId + "/events?source=tool_timeout_fail_closed");
    assert.equal(artifact.summary.fallbackSourceTrail.returnedEvents, 1);
    assert.equal(artifact.summary.fallbackSourceTrail.filteredSource, "tool_timeout_fail_closed");
    assert.deepEqual(artifact.summary.fallbackSourceTrail.eventTypes, ["human_handoff_started"]);
    assert.equal(artifact.scripted.outcome, "scripted_wrap_complete");
    assert.equal(artifact.scripted.checkpoints.wrapped.pipecatFlow.script.completed, true);
    assert.equal(artifact.summary.scripted.flowState, "wrap");
    assert.equal(artifact.summary.scripted.transcriptTurns > 0, true);
    assert.equal(artifact.summary.scripted.agentTurns > 0, true);
    assert.equal(artifact.summary.scripted.callerTurns, 4);
    assert.equal(artifact.summary.scripted.eventTypes.includes("pipecat_runtime_turn_processed"), true);
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

