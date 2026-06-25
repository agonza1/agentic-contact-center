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
        operatorNoteTrail: string;
        fallbackSourceTrail: string;
        runtimeFailureSourceTrail: string;
        runtimeFailureQueueFilter: string;
        runtimeFailureCallListFilter: string;
        runtimeFailureOperatorConsoleFilter: string;
        runtimeFailureTranscriptFilter: string;
        runtimeFailureFallbackModeTranscriptTrail: string;
        runtimeFailureProofBundle: string;
        runtimeFailureArtifactManifest: string;
      };
      health: {
        ok: boolean;
        pipecatFlow: {
          ready: boolean;
          prototypeMode: string;
          transport: string;
          runtimeEngine: string;
          credentialsMode: string;
          runtimeCheck: { command: string; installCommand: string; liveTelephonyRequired: boolean };
          activeTool: string | null;
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
          operatorNoteTrail: string;
          fallbackSourceTrail: string;
          runtimeFailureSourceTrail: string;
          runtimeFailureQueueFilter: string;
          runtimeFailureCallListFilter: string;
          runtimeFailureOperatorConsoleFilter: string;
          runtimeFailureTranscriptFilter: string;
          runtimeFailureFallbackModeTranscriptTrail: string;
          runtimeFailureProofBundle: string;
          runtimeFailureArtifactManifest: string;
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
        operatorNoteTrail: {
          route: string;
          returnedEvents: number;
          filteredType: string | null;
          latestDisposition: string | null;
          eventTypes: string[];
        };
        fallbackSourceTrail: {
          route: string;
          returnedEvents: number;
          filteredSource: string | null;
          eventTypes: string[];
        };
        runtimeFailureSourceTrail: {
          route: string;
          returnedEvents: number;
          filteredSource: string | null;
          eventTypes: string[];
        };
        runtimeFailureQueue: {
          route: string;
          totalCalls: number;
          attentionRequired: number;
          oldestAttentionCallId: string | null;
          oldestAttentionFlowState: string | null;
          oldestAttentionReason: string | null;
          oldestAttentionSource: string | null;
        };
        runtimeFailureCallList: {
          route: string;
          returnedCalls: number;
          filteredCalls: number;
          firstCallId: string;
          firstFallbackMode: string | null;
          firstFlowState: string;
        };
        runtimeFailureOperatorConsole: {
          route: string;
          returnedCalls: number;
          filteredCalls: number;
          firstCallId: string;
          firstFallbackMode: string | null;
          firstFallbackSource: string | null;
          firstFallbackSourceTrail: string | null;
        };
        runtimeFailureTranscript: {
          route: string;
          returnedTurns: number;
          filteredSpeaker: string | null;
          finalSpeaker: string;
          finalTextIncludesRuntimeFailure: boolean;
        };
        runtimeFailureProofBundle: {
          route: string;
          fallbackMode: string | null;
          fallbackSource: string | null;
          handoffStarted: boolean;
          fallbackSourceTrail: string | null;
          fallbackModeOperatorConsole: string | null;
          fallbackModeTranscriptTrail: string | null;
          overBudgetLatencyTrail: string | null;
          operatorConsole: string;
          summaryEventCount: number;
          summaryOverBudgetLatencyMarkCount: number;
        };
        runtimeFailureArtifactManifest: {
          route: string;
          runtimeFlow: string;
          runtimeEngine: string;
          fallbackMode: string | null;
          fallbackSource: string | null;
          eventTypes: string[];
          operatorNoteCount: number;
          latestOperatorNoteAt: string | null;
          latestDisposition: string | null;
          handoffStartedAt: string | null;
          fallbackSourceTrail: string | null;
          operatorConsole: string;
          fallbackModeOperatorConsole: string | null;
          fallbackModeTranscriptTrail: string | null;
          overBudgetLatencyTrail: string | null;
          openclawSessionLabel: string;
        };
        healthOk: boolean;
        gitRevision: string | null;
        pipecatRuntime: {
          ready: boolean;
          prototypeMode: string;
          transport: string;
          runtimeEngine: string;
          credentialsMode: string;
          runtimeCheck: { command: string; installCommand: string; liveTelephonyRequired: boolean };
          activeTool: string | null;
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
        runtimeFailure: {
          eventCount: number;
          eventTypes: string[];
          mode: string | null;
          reason: string | null;
          flowState: string;
        };
      };
      scripted: {
        outcome: string;
        checkpoints: { wrapped: { session: { callId: string }; pipecatFlow: { script: { completed: boolean } } } };
      };
      fallback: { outcome: string; callId: string; checkpoint: { demoFallback: { mode: string | null } } };
      runtimeFailure: { outcome: string; callId: string; checkpoint: { demoFallback: { mode: string | null } } };
    };

    const latestArtifact = JSON.parse(await readFile(latestOutputPath, "utf8")) as typeof artifact;

    assert.equal(artifact.schemaVersion, 1);
    assert.deepEqual(artifact.proofContract.requiredOutcomes, [
      "scripted_wrap_complete",
      "fail_closed_handoff",
      "runtime_failure_fail_closed_handoff",
    ]);
    assert.equal(artifact.proofContract.requiredEventTypes.includes("policy_hold_entered"), true);
    assert.equal(artifact.proofContract.requiredEventTypes.includes("demo_fallback_triggered"), true);
    assert.equal(artifact.proofContract.requiredEventTypes.includes("human_handoff_started"), true);
    assert.equal(artifact.proofContract.queueAttentionFilter, "attentionRequired=true&attentionReason=pipecat%20tool%20exceeded%20latency%20budget");
    assert.equal(artifact.proofContract.callAttentionSort, "attentionRequired=true&sort=attentionStartedAt&limit=1");
    assert.equal(artifact.proofContract.operatorNoteTrail, "events?type=operator_note_recorded");
    assert.equal(artifact.proofContract.fallbackSourceTrail, "events?source=tool_timeout_fail_closed");
    assert.equal(artifact.proofContract.runtimeFailureSourceTrail, "events?source=pipecat_runtime_failure_fail_closed");
    assert.equal(artifact.proofContract.runtimeFailureQueueFilter, "attentionRequired=true&fallbackMode=runtime_failure");
    assert.equal(artifact.proofContract.runtimeFailureCallListFilter, "fallbackMode=runtime_failure&limit=5");
    assert.equal(artifact.proofContract.runtimeFailureOperatorConsoleFilter, "fallbackMode=runtime_failure&limit=1");
    assert.equal(artifact.proofContract.runtimeFailureTranscriptFilter, "speaker=agent&text=runtime%20reported%20a%20failure");
    assert.equal(
      artifact.proofContract.runtimeFailureFallbackModeTranscriptTrail,
      "calls/{runtimeFailureCallId}/transcript?speaker=agent&text=runtime%20reported%20a%20failure",
    );
    assert.equal(artifact.proofContract.runtimeFailureProofBundle, "calls/{runtimeFailureCallId}/proof");
    assert.equal(artifact.proofContract.runtimeFailureArtifactManifest, "calls/{runtimeFailureCallId}/artifacts");
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
    assert.equal(artifact.summary.pipecatRuntime.runtimeCheck.command, "npm run pipecat:check");
    assert.equal(artifact.summary.pipecatRuntime.runtimeCheck.liveTelephonyRequired, false);
    assert.equal(artifact.summary.pipecatRuntime.activeTool, "get_current_slide");
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
    assert.equal(artifact.summary.operatorNoteTrail.route, "calls/" + artifact.scripted.checkpoints.wrapped.session.callId + "/events?type=operator_note_recorded");
    assert.equal(artifact.summary.operatorNoteTrail.returnedEvents, 1);
    assert.equal(artifact.summary.operatorNoteTrail.filteredType, "operator_note_recorded");
    assert.equal(artifact.summary.operatorNoteTrail.latestDisposition, "qa_verified");
    assert.deepEqual(artifact.summary.operatorNoteTrail.eventTypes, ["operator_note_recorded"]);
    assert.equal(artifact.summary.fallbackSourceTrail.route, "calls/" + artifact.fallback.callId + "/events?source=tool_timeout_fail_closed");
    assert.equal(artifact.summary.fallbackSourceTrail.returnedEvents, 1);
    assert.equal(artifact.summary.fallbackSourceTrail.filteredSource, "tool_timeout_fail_closed");
    assert.deepEqual(artifact.summary.fallbackSourceTrail.eventTypes, ["human_handoff_started"]);
    assert.equal(
      artifact.summary.runtimeFailureSourceTrail.route,
      "calls/" + artifact.runtimeFailure.callId + "/events?source=pipecat_runtime_failure_fail_closed",
    );
    assert.equal(artifact.summary.runtimeFailureSourceTrail.returnedEvents, 1);
    assert.equal(artifact.summary.runtimeFailureSourceTrail.filteredSource, "pipecat_runtime_failure_fail_closed");
    assert.deepEqual(artifact.summary.runtimeFailureSourceTrail.eventTypes, ["human_handoff_started"]);
    assert.equal(artifact.summary.runtimeFailureQueue.route, artifact.proofContract.runtimeFailureQueueFilter);
    assert.equal(artifact.summary.runtimeFailureQueue.totalCalls, 1);
    assert.equal(artifact.summary.runtimeFailureQueue.attentionRequired, 1);
    assert.equal(artifact.summary.runtimeFailureQueue.oldestAttentionCallId, artifact.runtimeFailure.callId);
    assert.equal(artifact.summary.runtimeFailureQueue.oldestAttentionFlowState, "wrap");
    assert.equal(artifact.summary.runtimeFailureQueue.oldestAttentionReason, "pipecat local runtime import failed");
    assert.equal(artifact.summary.runtimeFailureQueue.oldestAttentionSource, "fallback");
    assert.equal(artifact.summary.runtimeFailureCallList.route, artifact.proofContract.runtimeFailureCallListFilter);
    assert.equal(artifact.summary.runtimeFailureCallList.returnedCalls, 1);
    assert.equal(artifact.summary.runtimeFailureCallList.filteredCalls, 1);
    assert.equal(artifact.summary.runtimeFailureCallList.firstCallId, artifact.runtimeFailure.callId);
    assert.equal(artifact.summary.runtimeFailureCallList.firstFallbackMode, "runtime_failure");
    assert.equal(artifact.summary.runtimeFailureCallList.firstFlowState, "wrap");
    assert.equal(artifact.summary.runtimeFailureOperatorConsole.route, artifact.proofContract.runtimeFailureOperatorConsoleFilter);
    assert.equal(artifact.summary.runtimeFailureOperatorConsole.returnedCalls, 1);
    assert.equal(artifact.summary.runtimeFailureOperatorConsole.filteredCalls, 1);
    assert.equal(artifact.summary.runtimeFailureOperatorConsole.firstCallId, artifact.runtimeFailure.callId);
    assert.equal(artifact.summary.runtimeFailureOperatorConsole.firstFallbackMode, "runtime_failure");
    assert.equal(artifact.summary.runtimeFailureOperatorConsole.firstFallbackSource, "pipecat_runtime_failure_fail_closed");
    assert.equal(
      artifact.summary.runtimeFailureOperatorConsole.firstFallbackSourceTrail,
      "/api/calls/" + artifact.runtimeFailure.callId + "/events?source=pipecat_runtime_failure_fail_closed",
    );
    assert.equal(artifact.summary.runtimeFailureTranscript.route, "calls/" + artifact.runtimeFailure.callId + "/transcript?speaker=agent&text=runtime%20reported%20a%20failure");
    assert.equal(artifact.summary.runtimeFailureTranscript.returnedTurns, 1);
    assert.equal(artifact.summary.runtimeFailureTranscript.filteredSpeaker, "agent");
    assert.equal(artifact.summary.runtimeFailureTranscript.finalSpeaker, "agent");
    assert.equal(artifact.summary.runtimeFailureTranscript.finalTextIncludesRuntimeFailure, true);
    assert.equal(artifact.summary.runtimeFailureProofBundle.route, "calls/" + artifact.runtimeFailure.callId + "/proof");
    assert.equal(artifact.summary.runtimeFailureProofBundle.fallbackMode, "runtime_failure");
    assert.equal(artifact.summary.runtimeFailureProofBundle.fallbackSource, "pipecat_runtime_failure_fail_closed");
    assert.equal(artifact.summary.runtimeFailureProofBundle.operatorConsole, "/api/operator/console?callId=" + artifact.runtimeFailure.callId);
    assert.equal(artifact.summary.runtimeFailureProofBundle.fallbackModeOperatorConsole, "/api/operator/console?fallbackMode=runtime_failure&limit=1");
    assert.equal(
      artifact.summary.runtimeFailureProofBundle.fallbackModeTranscriptTrail,
      "/api/calls/" + artifact.runtimeFailure.callId + "/transcript?speaker=agent&text=runtime%20reported%20a%20failure",
    );
    assert.equal(artifact.summary.runtimeFailureProofBundle.handoffStarted, true);
    assert.equal(
      artifact.summary.runtimeFailureProofBundle.fallbackSourceTrail,
      "/api/calls/" + artifact.runtimeFailure.callId + "/events?source=pipecat_runtime_failure_fail_closed",
    );
    assert.equal(artifact.summary.runtimeFailureProofBundle.overBudgetLatencyTrail, null);
    assert.equal(artifact.summary.runtimeFailureProofBundle.summaryEventCount > 0, true);
    assert.equal(artifact.summary.runtimeFailureProofBundle.summaryOverBudgetLatencyMarkCount, 0);
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.route, "calls/" + artifact.runtimeFailure.callId + "/artifacts");
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.runtimeFlow, "pipecat_local_runtime");
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.runtimeEngine, "pipecat-ai");
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.fallbackMode, "runtime_failure");
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.fallbackSource, "pipecat_runtime_failure_fail_closed");
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.eventTypes.includes("human_handoff_started"), true);
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.operatorNoteCount, 0);
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.latestOperatorNoteAt, null);
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.latestDisposition, null);
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.handoffStartedAt, "2026-06-11T20:47:02.000Z");
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.fallbackSourceTrail, "/api/calls/" + artifact.runtimeFailure.callId + "/events?source=pipecat_runtime_failure_fail_closed");
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.operatorConsole, "/api/operator/console?callId=" + artifact.runtimeFailure.callId);
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.fallbackModeOperatorConsole, "/api/operator/console?fallbackMode=runtime_failure&limit=1");
    assert.equal(
      artifact.summary.runtimeFailureArtifactManifest.fallbackModeTranscriptTrail,
      "/api/calls/" + artifact.runtimeFailure.callId + "/transcript?speaker=agent&text=runtime%20reported%20a%20failure",
    );
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.overBudgetLatencyTrail, null);
    assert.equal(artifact.summary.runtimeFailureArtifactManifest.openclawSessionLabel, "cluecon-demo/runtime-failure-proof");
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
    assert.equal(artifact.runtimeFailure.outcome, "runtime_failure_fail_closed_handoff");
    assert.equal(artifact.runtimeFailure.checkpoint.demoFallback.mode, "runtime_failure");
    assert.equal(artifact.summary.runtimeFailure.mode, "runtime_failure");
    assert.equal(artifact.summary.runtimeFailure.reason, "pipecat local runtime import failed");
    assert.equal(artifact.summary.runtimeFailure.flowState, "wrap");
    assert.equal(artifact.summary.runtimeFailure.eventTypes.includes("human_handoff_started"), true);
    assert.deepEqual(latestArtifact, artifact);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

