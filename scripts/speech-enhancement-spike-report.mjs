import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  buildSpeechEnhancementSpikeReport,
  evaluateSpeechEnhancementReplayMetric,
  validateSpeechEnhancementCaptureReplayManifest,
} = require("../dist/src/core/speechEnhancementSpike.js");

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

async function loadCaptureReplayMetric() {
  const captureReplayPath = resolveArgPath("--capture-replay");
  if (!captureReplayPath) {
    return undefined;
  }

  const payload = JSON.parse(await readFile(captureReplayPath, "utf8"));
  const validation = validateSpeechEnhancementCaptureReplayManifest(payload);
  if (!validation.manifestOk || !validation.metric) {
    throw new Error(`Invalid capture replay manifest: ${validation.missingFields.join(", ")}`);
  }

  return validation.metric;
}

function applyCaptureReplay(report, metric) {
  if (!metric) {
    return report;
  }

  const { issueCloseReady, failingEvidence, reasons } = evaluateSpeechEnhancementReplayMetric(metric);
  const remainingBeforeIssueClose = issueCloseReady
    ? []
    : [
        "Replay " + metric.captureId + " did not pass all enhancement close gates: " + failingEvidence.join(", ") + ".",
      ];

  return {
    ...report,
    replayMetrics: [...report.replayMetrics, metric],
    replayDecisions: [
      ...report.replayDecisions,
      {
        captureId: metric.captureId,
        latencySettingMs: metric.latencySettingMs,
        enableForLiveDemo: issueCloseReady,
        reasons,
      },
    ],
    replayCoverage: {
      syntheticNoisyReplayCount: report.replayCoverage.syntheticNoisyReplayCount,
      realNoisyCaptureReplayCount: report.replayCoverage.realNoisyCaptureReplayCount + 1,
      baselineEnhancedPairs: report.replayCoverage.baselineEnhancedPairs + 1,
      liveDemoGate: issueCloseReady ? "eligible" : "blocked_until_real_capture",
      missingEvidence: issueCloseReady ? [] : failingEvidence,
    },
    acceptanceReadiness: {
      ...report.acceptanceReadiness,
      noisyReplay: issueCloseReady ? "real_capture_ready" : report.acceptanceReadiness.noisyReplay,
      cpuRuntimeCost: issueCloseReady ? "covered" : report.acceptanceReadiness.cpuRuntimeCost,
      remainingBeforeIssueClose,
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

function buildReviewGate(report) {
  const missingEvidence = new Set(report.replayCoverage.missingEvidence);
  const hasRealCaptureReplay = report.replayCoverage.realNoisyCaptureReplayCount > 0;
  const realCaptureReplayDecisions = report.replayDecisions.filter((decision) => decision.captureId.startsWith("real-"));
  const issueCloseReady = hasRealCaptureReplay && report.acceptanceReadiness.remainingBeforeIssueClose.length === 0;
  const checks = {
    realNoisyCaptureReplay: hasRealCaptureReplay,
    baselineEnhancedPairs: hasRealCaptureReplay && report.replayCoverage.baselineEnhancedPairs > 0,
    wordErrorImproved: hasRealCaptureReplay && !missingEvidence.has("enhanced_noisy_replay_wer_improvement"),
    endpointingNoRegression: hasRealCaptureReplay && !missingEvidence.has("enhanced_endpointing_no_regression"),
    bargeInNoRegression: hasRealCaptureReplay && !missingEvidence.has("enhanced_barge_in_no_regression"),
    addedLatencyP95: hasRealCaptureReplay && !missingEvidence.has("measured_12_5_ms_added_turn_latency_under_25_ms_p95"),
    cpuRuntimeCost: hasRealCaptureReplay && !missingEvidence.has("measured_cpu_cost_on_selected_rtc_asr_host_under_80_percent_p95"),
  };
  const failureReasons = Object.fromEntries(
    Object.entries({
      realNoisyCaptureReplay: "Attach one real noisy local SIP capture replay before closing Issue #97.",
      baselineEnhancedPairs: "Attach paired baseline and enhanced rtc-asr replay metrics for the real capture.",
      wordErrorImproved: "Enhanced noisy replay WER estimate must improve over baseline.",
      endpointingNoRegression: "Enhanced endpointing must remain stable or no worse than baseline.",
      bargeInNoRegression: "Enhanced barge-in risk must remain low or no worse than baseline.",
      addedLatencyP95: "Measured 12.5 ms profile added turn latency must stay at or below 25 ms p95.",
      cpuRuntimeCost: "Measured enhanced CPU p95 must stay at or below 80% on the selected rtc-asr host.",
    }).filter(([check]) => !checks[check]),
  );

  return {
    issueCloseReady,
    checks,
    failureReasons,
    blockers: report.acceptanceReadiness.remainingBeforeIssueClose,
    nextEvidence: report.replayCoverage.missingEvidence,
    realCaptureReplayIds: realCaptureReplayDecisions.map((decision) => decision.captureId),
    passingRealCaptureReplayIds: realCaptureReplayDecisions
      .filter((decision) => decision.enableForLiveDemo)
      .map((decision) => decision.captureId),
    blockedRealCaptureReplayIds: realCaptureReplayDecisions
      .filter((decision) => !decision.enableForLiveDemo)
      .map((decision) => decision.captureId),
  };
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
    reviewGate: buildReviewGate(report),
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
