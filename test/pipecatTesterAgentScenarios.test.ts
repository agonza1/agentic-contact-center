import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("Pipecat tester-agent scenario runner uses shared ACC voice processors", () => {
  const runner = readFileSync("scripts/pipecat-tester-agent-scenarios.py", "utf8");
  assert.match(runner, /AccCallerTurnProcessor/);
  assert.match(runner, /KokoroTtsProcessor/);
  assert.match(runner, /AccVoicePipelineSession/);
  assert.match(runner, /TESTER_PIPELINE_CONTRACT/);
  assert.match(runner, /limitation/);
});

test("Pipecat tester-agent scenario runner emits deterministic evidence artifacts", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "acc-pipecat-tester-"));
  const stdout = execFileSync("python3", [
    "scripts/pipecat-tester-agent-scenarios.py",
    "--out-dir",
    outDir,
    "--call-id-prefix",
    "qa-tester",
  ], { encoding: "utf8" });
  const summary = JSON.parse(stdout) as {
    ok: boolean;
    mode: string;
    command: string;
    sharedProcessors: string[];
    productionPipelineContract: string[];
    testerPipelineContract: string[];
    limitation: string;
    artifactPaths: { manifest: string; outDir: string };
    scenarios: Array<{
      id: string;
      ok: boolean;
      correlationId: string;
      callerTranscript?: string | null;
      expectedTranscript?: string;
      agentResponse?: string | null;
      timingEvents: Array<{ stage: string; ok?: boolean }>;
      artifactPaths: { scenario: string };
      frameSummary?: { audioChunks: number; audioBytes: number; ttsStarted: number; ttsStopped: number };
      interruptedFrameSummary?: { audioChunks: number; audioBytes: number };
      resumedFrameSummary?: { audioChunks: number; audioBytes: number };
      checks: Record<string, boolean>;
    }>;
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.mode, "deterministic_tester_agent");
  assert.equal(summary.command, "npm run pipecat:tester:scenarios");
  assert.deepEqual(summary.sharedProcessors, [
    "AccCallerTurnProcessor",
    "KokoroTtsProcessor",
    "AccVoicePipelineSession",
  ]);
  assert.deepEqual(summary.testerPipelineContract, [
    "tester.transport.input",
    "AccCallerTurnProcessor",
    "KokoroTtsProcessor",
    "tester.transport.output",
  ]);
  assert.deepEqual(summary.productionPipelineContract, [
    "transport.input",
    "RtcAsrTurnProcessor",
    "AccCallerTurnProcessor",
    "KokoroTtsProcessor",
    "transport.output",
  ]);
  assert.match(summary.limitation, /does not prove live rtc-asr/);
  assert.equal(summary.artifactPaths.outDir, outDir);
  assert.ok(existsSync(summary.artifactPaths.manifest));

  const scenarios = new Map(summary.scenarios.map((scenario) => [scenario.id, scenario]));
  for (const id of [
    "happy_path",
    "barge_in",
    "no_speech_timeout",
    "expected_transcript_mismatch",
    "transport_start_failure",
  ]) {
    const scenario = scenarios.get(id);
      assert.ok(scenario, `${id} scenario exists`);
      assert.equal(scenario.ok, true, `${id} passed`);
      assert.match(scenario.correlationId, /^tester-correlation-qa-tester-/);
      assert.ok(existsSync(scenario.artifactPaths.scenario), `${id} artifact exists`);
      assert.equal(scenario.timingEvents.every((event: any) => typeof event.correlationId === "string"), true);
    }

  const happy = scenarios.get("happy_path")!;
  assert.equal(happy.callerTranscript, "I need to reschedule my appointment.");
  assert.equal(happy.agentResponse, "I can help reschedule. What day works best for you?");
  assert.equal(happy.frameSummary?.ttsStarted, 1);
  assert.equal(happy.frameSummary?.ttsStopped, 1);
  assert.ok((happy.frameSummary?.audioChunks ?? 0) >= 1);
  assert.ok(happy.timingEvents.some((event) => event.stage === "acc.caller_turn_delivery_committed"));

  const barge = scenarios.get("barge_in")!;
  assert.equal(barge.interruptedFrameSummary?.audioChunks, 1);
  assert.ok((barge.resumedFrameSummary?.audioChunks ?? 0) >= 1);
  assert.ok(barge.timingEvents.some((event) => event.stage === "output.transport_flushed"));

  const timeout = scenarios.get("no_speech_timeout")!;
  assert.equal(timeout.callerTranscript, null);
  assert.equal(timeout.agentResponse, null);
  assert.ok(timeout.timingEvents.some((event) => event.stage === "tester.no_speech_timeout"));

  const mismatch = scenarios.get("expected_transcript_mismatch")!;
  assert.equal(mismatch.expectedTranscript, "I want to cancel my appointment.");
  assert.equal(mismatch.callerTranscript, "I want to reschedule my appointment.");
  assert.equal(mismatch.checks.noAccMutation, true);

  const failure = scenarios.get("transport_start_failure")!;
  assert.ok(failure.timingEvents.some((event) => event.stage === "tester.transport_start_failed"));

  const manifest = JSON.parse(readFileSync(summary.artifactPaths.manifest, "utf8"));
  assert.equal(manifest.ok, true);
  assert.equal(manifest.scenarioCount, 5);
});
