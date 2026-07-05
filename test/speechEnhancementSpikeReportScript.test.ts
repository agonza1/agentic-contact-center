import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runNode(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}

test("speech enhancement spike report script writes review-gated artifact", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const latestOutputPath = path.join(tempDir, "speech-enhancement-spike-latest.json");

  try {
    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--latest-out",
      latestOutputPath,
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as { ok: boolean; outputPath: string; latestOutputPath: string };
    assert.equal(summary.ok, true);
    assert.equal(summary.outputPath, outputPath);
    assert.equal(summary.latestOutputPath, latestOutputPath);

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      schemaVersion: number;
      artifactType: string;
      report: {
        issue: string;
        proposedConfig: { featureFlag: string };
        replayCoverage: { liveDemoGate: string };
        captureReplayContract: { fixtureManifestPath: string; requiredFields: string[] };
      };
      handoff: { issueUrl: string; reviewRoute: string; validationCommand: string; nextEvidenceOwner: string };
      reviewGate: {
        issueCloseReady: boolean;
        checks: Record<string, boolean>;
        failureReasons: Record<string, string>;
        blockers: string[];
        nextEvidence: string[];
      };
    };
    const latestArtifact = JSON.parse(await readFile(latestOutputPath, "utf8"));

    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.artifactType, "speech_enhancement_spike_report");
    assert.equal(artifact.report.issue, "agonza1/agentic-contact-center#97");
    assert.equal(artifact.handoff.issueUrl, "https://github.com/agonza1/agentic-contact-center/issues/97");
    assert.equal(artifact.handoff.reviewRoute, "/api/realtime-shim/speech-enhancement-spike");
    assert.equal(artifact.handoff.validationCommand, "npm run proof:speech-enhancement -- --require-close-ready");
    assert.equal(artifact.handoff.nextEvidenceOwner, "agentic_contact_center");
    assert.equal(artifact.report.proposedConfig.featureFlag, "RTC_ASR_SPEECH_ENHANCEMENT");
    assert.equal(artifact.report.replayCoverage.liveDemoGate, "blocked_until_real_capture");
    assert.equal(
      artifact.report.captureReplayContract.fixtureManifestPath,
      "artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("audio_source_uri"));
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("runtime_host"));
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("enhanced_rtc_asr.cpu_percent_p95"));
    assert.equal(artifact.reviewGate.issueCloseReady, false);
    assert.equal(artifact.reviewGate.checks.realNoisyCaptureReplay, false);
    assert.equal(artifact.reviewGate.checks.cpuRuntimeCost, false);
    assert.match(artifact.reviewGate.failureReasons.realNoisyCaptureReplay, /real noisy local SIP capture/);
    assert.ok(artifact.reviewGate.blockers.some((blocker) => blocker.includes("real noisy local SIP capture")));
    assert.ok(artifact.reviewGate.nextEvidence.includes("real_noisy_local_sip_capture_baseline_vs_enhanced_replay"));
    assert.deepEqual(latestArtifact.report, artifact.report);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report script can enforce issue-close readiness", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-strict-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");

  try {
    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 1);
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      issueCloseReady: boolean;
      blockers: string[];
      outputPath: string;
      latestOutputPath: string | null;
    };
    assert.equal(summary.ok, false);
    assert.equal(summary.issueCloseReady, false);
    assert.equal(summary.outputPath, outputPath);
    assert.equal(summary.latestOutputPath, null);
    assert.ok(summary.blockers.some((blocker) => blocker.includes("real noisy local SIP capture")));

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as { reviewGate: { issueCloseReady: boolean } };
    assert.equal(artifact.reviewGate.issueCloseReady, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report rejects incomplete real capture replay evidence", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-invalid-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-002",
          scenario: "local SIP caller missing source metadata",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Missing capture replay field: recorded_at/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report rejects non-numeric real capture replay metrics", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-invalid-metrics-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-004",
          recorded_at: "2026-07-05T07:55:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-004.wav",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with malformed WER metric",
          enhancement_latency_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: "0.18",
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /baseline_rtc_asr\.word_error_rate_estimate must be a number between 0 and 1/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report rejects malformed CPU p95 evidence", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-invalid-cpu-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-005",
          recorded_at: "2026-07-05T08:30:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-005.wav",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with malformed CPU metric",
          enhancement_latency_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 130,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /enhanced_rtc_asr\.cpu_percent_p95 must be a number between 0 and 100/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report keeps over-budget real capture replay evidence review-blocked", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-overbudget-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-003",
          recorded_at: "2026-07-05T06:45:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-003.wav",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with improved transcript but too much added latency",
          enhancement_latency_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 31,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 1);
    const summary = JSON.parse(result.stdout) as { ok: boolean; issueCloseReady: boolean; blockers: string[] };
    assert.equal(summary.ok, false);
    assert.equal(summary.issueCloseReady, false);
    assert.ok(summary.blockers.some((blocker) => blocker.includes("measured_12_5_ms_added_turn_latency_under_25_ms_p95")));

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: { replayDecisions: Array<{ captureId: string; enableForLiveDemo: boolean; reasons: string[] }> };
      reviewGate: {
        issueCloseReady: boolean;
        checks: Record<string, boolean>;
        failureReasons: Record<string, string>;
        nextEvidence: string[];
      };
    };
    const decision = artifact.report.replayDecisions.at(-1);
    assert.equal(artifact.reviewGate.issueCloseReady, false);
    assert.equal(artifact.reviewGate.checks.addedLatencyP95, false);
    assert.match(artifact.reviewGate.failureReasons.addedLatencyP95, /added turn latency/);
    assert.equal(decision?.captureId, "real-noisy-local-sip-003");
    assert.equal(decision?.enableForLiveDemo, false);
    assert.ok(decision?.reasons.includes("latency_over_budget"));
    assert.deepEqual(artifact.reviewGate.nextEvidence, ["measured_12_5_ms_added_turn_latency_under_25_ms_p95"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report keeps high measured CPU p95 review-blocked", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-highcpu-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-007",
          recorded_at: "2026-07-05T10:05:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-007.wav",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with improved transcript but high CPU p95",
          enhancement_latency_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 88,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 1);
    const summary = JSON.parse(result.stdout) as { ok: boolean; issueCloseReady: boolean; blockers: string[] };
    assert.equal(summary.ok, false);
    assert.equal(summary.issueCloseReady, false);
    assert.ok(
      summary.blockers.some((blocker) =>
        blocker.includes("measured_cpu_cost_on_selected_rtc_asr_host_under_80_percent_p95"),
      ),
    );

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: { replayDecisions: Array<{ captureId: string; enableForLiveDemo: boolean; reasons: string[] }> };
      reviewGate: { issueCloseReady: boolean; nextEvidence: string[] };
    };
    const decision = artifact.report.replayDecisions.at(-1);
    assert.equal(artifact.reviewGate.issueCloseReady, false);
    assert.equal(decision?.captureId, "real-noisy-local-sip-007");
    assert.equal(decision?.enableForLiveDemo, false);
    assert.ok(decision?.reasons.includes("cpu_cost_high"));
    assert.deepEqual(artifact.reviewGate.nextEvidence, ["measured_cpu_cost_on_selected_rtc_asr_host_under_80_percent_p95"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report accepts passing real capture replay evidence", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-real-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-001",
          recorded_at: "2026-07-05T06:40:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-001.wav",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with cafe noise",
          enhancement_latency_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as { ok: boolean; issueCloseReady: boolean; blockers: string[] };
    assert.equal(summary.ok, true);
    assert.equal(summary.issueCloseReady, true);
    assert.deepEqual(summary.blockers, []);

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: {
        acceptanceReadiness: { noisyReplay: string };
        replayCoverage: { realNoisyCaptureReplayCount: number; liveDemoGate: string; missingEvidence: string[] };
        replayDecisions: Array<{ captureId: string; enableForLiveDemo: boolean }>;
      };
      reviewGate: {
        issueCloseReady: boolean;
        checks: Record<string, boolean>;
        failureReasons: Record<string, string>;
        blockers: string[];
        nextEvidence: string[];
      };
    };

    assert.equal(artifact.reviewGate.issueCloseReady, true);
    assert.deepEqual(Object.values(artifact.reviewGate.checks), [true, true, true, true, true, true, true]);
    assert.deepEqual(artifact.reviewGate.failureReasons, {});
    assert.equal(artifact.report.acceptanceReadiness.noisyReplay, "real_capture_ready");
    assert.deepEqual(artifact.reviewGate.blockers, []);
    assert.deepEqual(artifact.reviewGate.nextEvidence, []);
    assert.equal(artifact.report.replayCoverage.realNoisyCaptureReplayCount, 1);
    assert.equal(artifact.report.replayCoverage.liveDemoGate, "eligible");
    assert.deepEqual(artifact.report.replayCoverage.missingEvidence, []);
    assert.equal(artifact.report.replayDecisions.at(-1)?.captureId, "real-noisy-local-sip-001");
    assert.equal(artifact.report.replayDecisions.at(-1)?.enableForLiveDemo, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report accepts no-worse endpointing and barge-in improvements", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-noworse-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-006",
          recorded_at: "2026-07-05T09:35:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-006.wav",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller improves from unstable endpointing and high barge-in risk",
          enhancement_latency_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "unstable",
            barge_in_risk: "high",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: { replayDecisions: Array<{ captureId: string; enableForLiveDemo: boolean; reasons: string[] }> };
      reviewGate: { issueCloseReady: boolean; nextEvidence: string[] };
    };
    const decision = artifact.report.replayDecisions.at(-1);

    assert.equal(artifact.reviewGate.issueCloseReady, true);
    assert.deepEqual(artifact.reviewGate.nextEvidence, []);
    assert.equal(decision?.captureId, "real-noisy-local-sip-006");
    assert.equal(decision?.enableForLiveDemo, true);
    assert.ok(decision?.reasons.includes("endpointing_stable"));
    assert.ok(decision?.reasons.includes("barge_in_risk_low"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
