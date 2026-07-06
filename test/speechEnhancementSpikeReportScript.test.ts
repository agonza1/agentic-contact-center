import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const markdownOutputPath = path.join(tempDir, "speech-enhancement-spike.md");

  try {
    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--latest-out",
      latestOutputPath,
      "--markdown-out",
      markdownOutputPath,
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      outputPath: string;
      latestOutputPath: string;
      markdownOutputPath: string;
    };
    assert.equal(summary.ok, true);
    assert.equal(summary.outputPath, outputPath);
    assert.equal(summary.latestOutputPath, latestOutputPath);
    assert.equal(summary.markdownOutputPath, markdownOutputPath);

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      schemaVersion: number;
      artifactType: string;
      report: {
        issue: string;
        proposedConfig: { featureFlag: string };
        replayCoverage: { liveDemoGate: string };
        captureReplayContract: { fixtureManifestPath: string; requiredFields: string[] };
      };
      handoff: {
        issueUrl: string;
        reviewRoute: string;
        validationCommand: string;
        strictValidationCommand: string;
        nextEvidenceOwner: string;
      };
      reviewGate: {
        issueCloseReady: boolean;
        checks: Record<string, boolean>;
        failureReasons: Record<string, string>;
        blockers: string[];
        nextEvidence: string[];
        realCaptureReplayIds: string[];
        passingRealCaptureReplayIds: string[];
        blockedRealCaptureReplayIds: string[];
        realCaptureReplayEvidence: Array<{
          captureId: string;
          recordedAt: string | null;
          audioSourceUri: string | null;
          audioSha256: string | null;
          sourceManifestUri: string | null;
          sourceManifestSha256: string | null;
          noiseProfile: string | null;
          runtimeHost: string | null;
        }>;
      };
    };
    const latestArtifact = JSON.parse(await readFile(latestOutputPath, "utf8"));
    const markdown = await readFile(markdownOutputPath, "utf8");

    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.artifactType, "speech_enhancement_spike_report");
    assert.equal(artifact.report.issue, "agonza1/agentic-contact-center#97");
    assert.equal(artifact.handoff.issueUrl, "https://github.com/agonza1/agentic-contact-center/issues/97");
    assert.equal(artifact.handoff.reviewRoute, "/api/realtime-shim/speech-enhancement-spike");
    assert.equal(artifact.handoff.validationCommand, "npm run proof:speech-enhancement -- --require-close-ready");
    assert.equal(
      artifact.handoff.strictValidationCommand,
      "npm run proof:speech-enhancement -- --require-close-ready --strict-capture-artifacts --capture-replay artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.equal(artifact.handoff.nextEvidenceOwner, "agentic_contact_center");
    assert.equal(artifact.report.proposedConfig.featureFlag, "RTC_ASR_SPEECH_ENHANCEMENT");
    assert.equal(artifact.report.replayCoverage.liveDemoGate, "blocked_until_real_capture");
    assert.equal(
      artifact.report.captureReplayContract.fixtureManifestPath,
      "artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("audio_source_uri"));
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("source_manifest_uri"));
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("runtime_host"));
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("enhanced_rtc_asr.cpu_percent_p95"));
    assert.equal(artifact.reviewGate.issueCloseReady, false);
    assert.equal(artifact.reviewGate.checks.realNoisyCaptureReplay, false);
    assert.equal(artifact.reviewGate.checks.cpuRuntimeCost, false);
    assert.match(artifact.reviewGate.failureReasons.realNoisyCaptureReplay, /real noisy local SIP capture/);
    assert.ok(artifact.reviewGate.blockers.some((blocker) => blocker.includes("real noisy local SIP capture")));
    assert.ok(artifact.reviewGate.nextEvidence.includes("real_noisy_local_sip_capture_baseline_vs_enhanced_replay"));
    assert.deepEqual(artifact.reviewGate.realCaptureReplayIds, []);
    assert.deepEqual(artifact.reviewGate.passingRealCaptureReplayIds, []);
    assert.deepEqual(artifact.reviewGate.blockedRealCaptureReplayIds, []);
    assert.deepEqual(artifact.reviewGate.realCaptureReplayEvidence, []);
    assert.deepEqual(latestArtifact.report, artifact.report);
    assert.match(markdown, /# Speech Enhancement Spike Report/);
    assert.match(markdown, /Decision: go_for_feature_flagged_spike at 12\.5 ms/);
    assert.match(markdown, /Review gate: blocked/);
    assert.match(markdown, /Real noisy capture replays: 0/);
    assert.match(markdown, /Run: npm run proof:speech-enhancement -- --require-close-ready/);
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
      markdownOutputPath: string | null;
    };
    assert.equal(summary.ok, false);
    assert.equal(summary.issueCloseReady, false);
    assert.equal(summary.outputPath, outputPath);
    assert.equal(summary.latestOutputPath, null);
    assert.equal(summary.markdownOutputPath, null);
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
    assert.match(result.stderr, /Invalid capture replay manifest: .*recorded_at/);
    assert.match(result.stderr, /Invalid capture replay manifest: .*source_manifest_uri\.artifacts_relative_path_required/);
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
          source_manifest_uri: "artifacts/local-sip/proof-manifest-004.json",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with malformed WER metric",
          latency_setting_ms: 12.5,
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
    assert.match(result.stderr, /Invalid capture replay manifest: .*baseline_rtc_asr\.word_error_rate_estimate/);
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
          source_manifest_uri: "artifacts/local-sip/proof-manifest-005.json",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with malformed CPU metric",
          latency_setting_ms: 12.5,
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
    assert.match(result.stderr, /Invalid capture replay manifest: .*enhanced_rtc_asr\.cpu_percent_p95/);
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
          source_manifest_uri: "artifacts/local-sip/proof-manifest-003.json",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with improved transcript but too much added latency",
          latency_setting_ms: 12.5,
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
        realCaptureReplayIds: string[];
        passingRealCaptureReplayIds: string[];
        blockedRealCaptureReplayIds: string[];
        realCaptureReplayEvidence: Array<{
          captureId: string;
          recordedAt: string | null;
          audioSourceUri: string | null;
          audioSha256: string | null;
          sourceManifestUri: string | null;
          sourceManifestSha256: string | null;
          noiseProfile: string | null;
          runtimeHost: string | null;
        }>;
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
    assert.deepEqual(artifact.reviewGate.realCaptureReplayIds, ["real-noisy-local-sip-003"]);
    assert.deepEqual(artifact.reviewGate.passingRealCaptureReplayIds, []);
    assert.deepEqual(artifact.reviewGate.blockedRealCaptureReplayIds, ["real-noisy-local-sip-003"]);
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
          source_manifest_uri: "artifacts/local-sip/proof-manifest-007.json",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with improved transcript but high CPU p95",
          latency_setting_ms: 12.5,
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
          audio_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          source_manifest_uri: "artifacts/local-sip/proof-manifest-001.json",
          source_manifest_sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with cafe noise",
          latency_setting_ms: 12.5,
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
        acceptanceReadiness: { noisyReplay: string; cpuRuntimeCost: string };
        replayCoverage: { realNoisyCaptureReplayCount: number; liveDemoGate: string; missingEvidence: string[] };
        replayMetrics: Array<{
          captureId: string;
          captureEvidence?: {
            recordedAt: string;
            audioSourceUri: string;
            audioSha256?: string;
            sourceManifestUri?: string;
            sourceManifestSha256?: string;
            noiseProfile: string;
            runtimeHost: string;
          };
        }>;
        replayDecisions: Array<{ captureId: string; enableForLiveDemo: boolean }>;
      };
      reviewGate: {
        issueCloseReady: boolean;
        checks: Record<string, boolean>;
        failureReasons: Record<string, string>;
        blockers: string[];
        nextEvidence: string[];
        realCaptureReplayIds: string[];
        passingRealCaptureReplayIds: string[];
        blockedRealCaptureReplayIds: string[];
        realCaptureReplayEvidence: Array<{
          captureId: string;
          recordedAt: string | null;
          audioSourceUri: string | null;
          audioSha256: string | null;
          sourceManifestUri: string | null;
          sourceManifestSha256: string | null;
          noiseProfile: string | null;
          runtimeHost: string | null;
        }>;
      };
    };

    assert.equal(artifact.reviewGate.issueCloseReady, true);
    assert.deepEqual(Object.values(artifact.reviewGate.checks), [true, true, true, true, true, true, true]);
    assert.deepEqual(artifact.reviewGate.failureReasons, {});
    assert.equal(artifact.report.acceptanceReadiness.noisyReplay, "real_capture_ready");
    assert.equal(artifact.report.acceptanceReadiness.cpuRuntimeCost, "covered");
    assert.deepEqual(artifact.reviewGate.blockers, []);
    assert.deepEqual(artifact.reviewGate.nextEvidence, []);
    assert.equal(artifact.report.replayCoverage.realNoisyCaptureReplayCount, 1);
    assert.equal(artifact.report.replayCoverage.liveDemoGate, "eligible");
    assert.deepEqual(artifact.report.replayCoverage.missingEvidence, []);
    assert.equal(artifact.report.replayMetrics.at(-1)?.captureId, "real-noisy-local-sip-001");
    assert.deepEqual(artifact.report.replayMetrics.at(-1)?.captureEvidence, {
      recordedAt: "2026-07-05T06:40:00.000Z",
      audioSourceUri: "artifacts/local-sip/real-noisy-local-sip-001.wav",
      audioSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      sourceManifestUri: "artifacts/local-sip/proof-manifest-001.json",
      sourceManifestSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      noiseProfile: "cafe_noise",
      runtimeHost: "local-rtc-asr-host",
    });
    assert.equal(artifact.report.replayDecisions.at(-1)?.captureId, "real-noisy-local-sip-001");
    assert.equal(artifact.report.replayDecisions.at(-1)?.enableForLiveDemo, true);
    assert.deepEqual(artifact.reviewGate.realCaptureReplayIds, ["real-noisy-local-sip-001"]);
    assert.deepEqual(artifact.reviewGate.passingRealCaptureReplayIds, ["real-noisy-local-sip-001"]);
    assert.deepEqual(artifact.reviewGate.blockedRealCaptureReplayIds, []);
    assert.deepEqual(artifact.reviewGate.realCaptureReplayEvidence, [
      {
        captureId: "real-noisy-local-sip-001",
        recordedAt: "2026-07-05T06:40:00.000Z",
        audioSourceUri: "artifacts/local-sip/real-noisy-local-sip-001.wav",
        audioSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sourceManifestUri: "artifacts/local-sip/proof-manifest-001.json",
        sourceManifestSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        noiseProfile: "cafe_noise",
        runtimeHost: "local-rtc-asr-host",
      },
    ]);
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
          source_manifest_uri: "artifacts/local-sip/proof-manifest-006.json",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller improves from unstable endpointing and high barge-in risk",
          latency_setting_ms: 12.5,
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


test("speech enhancement spike report accepts multiple real capture replay manifests", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-multiple-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const firstCaptureReplayPath = path.join(tempDir, "real-capture-replay-1.json");
  const secondCaptureReplayPath = path.join(tempDir, "real-capture-replay-2.json");

  const buildCaptureReplay = (captureId: string, recordedAt: string) => ({
    capture_id: captureId,
    recorded_at: recordedAt,
    audio_source_uri: `artifacts/local-sip/${captureId}.wav`,
    source_manifest_uri: `artifacts/local-sip/${captureId}-manifest.json`,
    noise_profile: "cafe_noise",
    scenario: "local SIP caller with repeatable noisy capture evidence",
    latency_setting_ms: 12.5,
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
  });

  try {
    await writeFile(firstCaptureReplayPath, JSON.stringify(buildCaptureReplay("real-noisy-local-sip-101", "2026-07-05T12:00:00.000Z"), null, 2), "utf8");
    await writeFile(secondCaptureReplayPath, JSON.stringify(buildCaptureReplay("real-noisy-local-sip-102", "2026-07-05T12:05:00.000Z"), null, 2), "utf8");

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      firstCaptureReplayPath,
      "--capture-replay",
      secondCaptureReplayPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as { ok: boolean; issueCloseReady: boolean };
    assert.equal(summary.ok, true);
    assert.equal(summary.issueCloseReady, true);

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: { replayCoverage: { realNoisyCaptureReplayCount: number; baselineEnhancedPairs: number } };
      reviewGate: { realCaptureReplayIds: string[]; passingRealCaptureReplayIds: string[] };
    };
    assert.equal(artifact.report.replayCoverage.realNoisyCaptureReplayCount, 2);
    assert.equal(artifact.report.replayCoverage.baselineEnhancedPairs, 3);
    assert.deepEqual(artifact.reviewGate.realCaptureReplayIds, ["real-noisy-local-sip-101", "real-noisy-local-sip-102"]);
    assert.deepEqual(artifact.reviewGate.passingRealCaptureReplayIds, ["real-noisy-local-sip-101", "real-noisy-local-sip-102"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report blocks mixed passing and failing real capture replays", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-mixed-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const passingCaptureReplayPath = path.join(tempDir, "real-capture-replay-pass.json");
  const failingCaptureReplayPath = path.join(tempDir, "real-capture-replay-fail.json");

  const buildCaptureReplay = (captureId: string, addedTurnLatencyMsP95: number) => ({
    capture_id: captureId,
    recorded_at: "2026-07-05T12:10:00.000Z",
    audio_source_uri: `artifacts/local-sip/${captureId}.wav`,
    source_manifest_uri: `artifacts/local-sip/${captureId}-manifest.json`,
    noise_profile: "cafe_noise",
    scenario: "local SIP caller with mixed noisy capture evidence",
    latency_setting_ms: 12.5,
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
      added_turn_latency_ms_p95: addedTurnLatencyMsP95,
      cpu_percent_p95: 42,
      cpu_cost_estimate: "medium",
    },
  });

  try {
    await writeFile(
      passingCaptureReplayPath,
      JSON.stringify(buildCaptureReplay("real-noisy-local-sip-201", 18), null, 2),
      "utf8",
    );
    await writeFile(
      failingCaptureReplayPath,
      JSON.stringify(buildCaptureReplay("real-noisy-local-sip-202", 31), null, 2),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      failingCaptureReplayPath,
      "--capture-replay",
      passingCaptureReplayPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 1);
    const summary = JSON.parse(result.stdout) as { ok: boolean; issueCloseReady: boolean; blockers: string[] };
    assert.equal(summary.ok, false);
    assert.equal(summary.issueCloseReady, false);
    assert.ok(summary.blockers.some((blocker) => blocker.includes("real-noisy-local-sip-202")));

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: { replayCoverage: { liveDemoGate: string; missingEvidence: string[] } };
      reviewGate: {
        issueCloseReady: boolean;
        checks: Record<string, boolean>;
        nextEvidence: string[];
        passingRealCaptureReplayIds: string[];
        blockedRealCaptureReplayIds: string[];
      };
    };
    assert.equal(artifact.reviewGate.issueCloseReady, false);
    assert.equal(artifact.report.replayCoverage.liveDemoGate, "blocked_until_real_capture");
    assert.deepEqual(artifact.report.replayCoverage.missingEvidence, [
      "measured_12_5_ms_added_turn_latency_under_25_ms_p95",
    ]);
    assert.equal(artifact.reviewGate.checks.addedLatencyP95, false);
    assert.deepEqual(artifact.reviewGate.nextEvidence, ["measured_12_5_ms_added_turn_latency_under_25_ms_p95"]);
    assert.deepEqual(artifact.reviewGate.passingRealCaptureReplayIds, ["real-noisy-local-sip-201"]);
    assert.deepEqual(artifact.reviewGate.blockedRealCaptureReplayIds, ["real-noisy-local-sip-202"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report strict mode verifies capture artifact files and hashes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-strict-artifacts-"));
  const artifactDir = path.join(process.cwd(), "artifacts", `strict-capture-${path.basename(tempDir)}`);
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");
  const audioUri = `artifacts/${path.basename(artifactDir)}/real-noisy-local-sip-201.wav`;
  const sourceManifestUri = `artifacts/${path.basename(artifactDir)}/proof-manifest-201.json`;
  const audioContents = "fake wav evidence for strict hash validation\n";
  const sourceManifestContents = "{\"proof\":\"strict replay source\"}\n";
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(process.cwd(), audioUri), audioContents, "utf8");
    await writeFile(path.join(process.cwd(), sourceManifestUri), sourceManifestContents, "utf8");
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-201",
          recorded_at: "2026-07-06T13:10:00.000Z",
          audio_source_uri: audioUri,
          audio_sha256: sha256(audioContents),
          source_manifest_uri: sourceManifestUri,
          source_manifest_sha256: sha256(sourceManifestContents),
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with strict artifact evidence",
          latency_setting_ms: 12.5,
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
      "--strict-capture-artifacts",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as { ok: boolean; issueCloseReady: boolean };
    assert.equal(summary.ok, true);
    assert.equal(summary.issueCloseReady, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report strict mode rejects missing capture artifact files", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-strict-missing-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-202",
          recorded_at: "2026-07-06T13:15:00.000Z",
          audio_source_uri: "artifacts/strict-missing/real-noisy-local-sip-202.wav",
          audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source_manifest_uri: "artifacts/strict-missing/proof-manifest-202.json",
          source_manifest_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with missing strict artifact evidence",
          latency_setting_ms: 12.5,
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
      "--strict-capture-artifacts",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Missing capture replay artifact for audio_source_uri/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

