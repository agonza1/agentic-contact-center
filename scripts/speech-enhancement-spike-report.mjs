import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { buildSpeechEnhancementSpikeReport } = require("../dist/src/core/speechEnhancementSpike.js");

function resolveArgPath(flag) {
  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) {
    return path.resolve(process.cwd(), process.argv[flagIndex + 1]);
  }

  return undefined;
}

function hasArg(flag) {
  return process.argv.includes(flag);
}

function normalizeCaptureReplayMetric(payload) {
  const requiredFields = [
    "capture_id",
    "recorded_at",
    "audio_source_uri",
    "noise_profile",
    "scenario",
    "baseline_rtc_asr.transcript",
    "baseline_rtc_asr.word_error_rate_estimate",
    "baseline_rtc_asr.endpointing_stability",
    "baseline_rtc_asr.barge_in_risk",
    "enhanced_rtc_asr.transcript",
    "enhanced_rtc_asr.word_error_rate_estimate",
    "enhanced_rtc_asr.endpointing_stability",
    "enhanced_rtc_asr.barge_in_risk",
    "enhanced_rtc_asr.added_turn_latency_ms_p95",
    "enhanced_rtc_asr.cpu_cost_estimate",
  ];
  for (const fieldPath of requiredFields) {
    const value = fieldPath.split(".").reduce((current, key) => current?.[key], payload);
    assert.ok(value !== undefined && value !== null && value !== "", `Missing capture replay field: ${fieldPath}`);
  }

  assert.ok(payload.capture_id.startsWith("real-"), "capture_id must start with real- for issue-close readiness");

  return {
    captureId: payload.capture_id,
    scenario: payload.scenario,
    baseline: {
      transcript: payload.baseline_rtc_asr.transcript,
      wordErrorRateEstimate: payload.baseline_rtc_asr.word_error_rate_estimate,
      endpointingStability: payload.baseline_rtc_asr.endpointing_stability,
      bargeInRisk: payload.baseline_rtc_asr.barge_in_risk,
    },
    enhanced: {
      transcript: payload.enhanced_rtc_asr.transcript,
      wordErrorRateEstimate: payload.enhanced_rtc_asr.word_error_rate_estimate,
      endpointingStability: payload.enhanced_rtc_asr.endpointing_stability,
      bargeInRisk: payload.enhanced_rtc_asr.barge_in_risk,
      addedTurnLatencyMsP95: payload.enhanced_rtc_asr.added_turn_latency_ms_p95,
    },
    latencySettingMs: payload.enhancement_latency_ms ?? 12.5,
    cpuCostEstimate: payload.enhanced_rtc_asr.cpu_cost_estimate,
  };
}

async function loadCaptureReplayMetric() {
  const captureReplayPath = resolveArgPath("--capture-replay");
  if (!captureReplayPath) {
    return undefined;
  }

  const payload = JSON.parse(await readFile(captureReplayPath, "utf8"));
  return normalizeCaptureReplayMetric(payload);
}

function applyCaptureReplay(report, metric) {
  if (!metric) {
    return report;
  }

  const wordErrorImproved = metric.enhanced.wordErrorRateEstimate < metric.baseline.wordErrorRateEstimate;
  const endpointingOk = metric.enhanced.endpointingStability === "stable" || metric.enhanced.endpointingStability === metric.baseline.endpointingStability;
  const bargeInOk = metric.enhanced.bargeInRisk === "low" || metric.enhanced.bargeInRisk === metric.baseline.bargeInRisk;
  const latencyOk = metric.latencySettingMs === 12.5 && metric.enhanced.addedTurnLatencyMsP95 <= 25;
  const cpuOk = metric.cpuCostEstimate !== "high";
  const issueCloseReady = wordErrorImproved && endpointingOk && bargeInOk && latencyOk && cpuOk;

  return {
    ...report,
    replayMetrics: [...report.replayMetrics, metric],
    replayDecisions: [
      ...report.replayDecisions,
      {
        captureId: metric.captureId,
        latencySettingMs: metric.latencySettingMs,
        enableForLiveDemo: issueCloseReady,
        reasons: [
          wordErrorImproved ? "wer_improved" : "wer_not_improved",
          endpointingOk ? "endpointing_stable" : "endpointing_not_stable",
          bargeInOk ? "barge_in_risk_low" : "barge_in_risk_not_low",
          latencyOk ? "latency_within_budget" : "latency_over_budget",
          cpuOk ? "cpu_cost_allowed" : "cpu_cost_high",
        ],
      },
    ],
    replayCoverage: {
      syntheticNoisyReplayCount: report.replayCoverage.syntheticNoisyReplayCount,
      realNoisyCaptureReplayCount: report.replayCoverage.realNoisyCaptureReplayCount + 1,
      baselineEnhancedPairs: report.replayCoverage.baselineEnhancedPairs + 1,
      liveDemoGate: issueCloseReady ? "eligible" : "blocked_until_real_capture",
      missingEvidence: issueCloseReady ? [] : report.replayCoverage.missingEvidence,
    },
    acceptanceReadiness: {
      ...report.acceptanceReadiness,
      noisyReplay: issueCloseReady ? "real_capture_required" : report.acceptanceReadiness.noisyReplay,
      remainingBeforeIssueClose: issueCloseReady ? [] : report.acceptanceReadiness.remainingBeforeIssueClose,
    },
  };
}

function resolveOutputPath() {
  const explicitOutputPath = resolveArgPath("--out");
  if (explicitOutputPath) {
    return explicitOutputPath;
  }

  const timestamp = new Date().toISOString().replace(/[:]/g, "-");
  return path.resolve(process.cwd(), "artifacts", `speech-enhancement-spike-${timestamp}.json`);
}

function resolveLatestOutputPath() {
  const explicitLatestOutputPath = resolveArgPath("--latest-out");
  if (explicitLatestOutputPath) {
    return explicitLatestOutputPath;
  }

  if (hasArg("--out")) {
    return undefined;
  }

  return path.resolve(process.cwd(), "artifacts", "speech-enhancement-spike-latest.json");
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const outputPath = resolveOutputPath();
  const latestOutputPath = resolveLatestOutputPath();
  const requireCloseReady = hasArg("--require-close-ready");
  const captureReplayMetric = await loadCaptureReplayMetric();
  const report = applyCaptureReplay(buildSpeechEnhancementSpikeReport(), captureReplayMetric);

  assert.equal(report.ok, true);
  assert.equal(report.issue, "agonza1/agentic-contact-center#97");
  assert.equal(report.route, "/api/realtime-shim/speech-enhancement-spike");
  assert.equal(report.decision.status, "go_for_feature_flagged_spike");
  assert.equal(report.proposedConfig.featureFlag, "RTC_ASR_SPEECH_ENHANCEMENT");

  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    artifactType: "speech_enhancement_spike_report",
    report,
    handoff: {
      issueUrl: "https://github.com/agonza1/agentic-contact-center/issues/97",
      reviewRoute: report.route,
      validationCommand: "npm run proof:speech-enhancement -- --require-close-ready",
      nextEvidenceOwner: "agentic_contact_center",
    },
    reviewGate: {
      issueCloseReady: report.replayCoverage.liveDemoGate === "eligible" && report.acceptanceReadiness.remainingBeforeIssueClose.length === 0,
      blockers: report.acceptanceReadiness.remainingBeforeIssueClose,
      nextEvidence: report.replayCoverage.missingEvidence,
    },
  };

  await writeJson(outputPath, artifact);
  if (latestOutputPath) {
    await writeJson(latestOutputPath, artifact);
  }

  const summary = {
    ok: !requireCloseReady || artifact.reviewGate.issueCloseReady,
    outputPath,
    latestOutputPath: latestOutputPath ?? null,
    issueCloseReady: artifact.reviewGate.issueCloseReady,
    blockers: artifact.reviewGate.blockers,
  };

  console.log(JSON.stringify(summary));

  if (requireCloseReady && !artifact.reviewGate.issueCloseReady) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
