import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  buildSpeechEnhancementReviewGate,
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

function resolveMarkdownOutputPath(outputPath) {
  const explicitMarkdownPath = resolveArgPath("--markdown-out");
  if (explicitMarkdownPath) {
    return explicitMarkdownPath;
  }

  if (hasArg("--out")) {
    return undefined;
  }

  return outputPath.replace(/\.json$/u, ".md");
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeText(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, payload, "utf8");
}

function buildMarkdownReport(artifact) {
  const { report, reviewGate } = artifact;
  const recommended = report.decision.recommendedLatencyMs;
  const blockers = reviewGate.blockers.length > 0 ? reviewGate.blockers : ["None. Issue #97 close gate is ready."];
  const nextEvidence = reviewGate.nextEvidence.length > 0 ? reviewGate.nextEvidence : ["None."];

  return [
    "# Speech Enhancement Spike Report",
    "",
    `Generated: ${artifact.generatedAt}`,
    `Issue: ${artifact.handoff.issueUrl}`,
    `Decision: ${report.decision.status} at ${recommended} ms`,
    `Review gate: ${reviewGate.issueCloseReady ? "close-ready" : "blocked"}`,
    "",
    "## Recommendation",
    "",
    report.decision.rationale,
    "",
    "## Evidence Coverage",
    "",
    `- Synthetic noisy replays: ${report.replayCoverage.syntheticNoisyReplayCount}`,
    `- Real noisy capture replays: ${report.replayCoverage.realNoisyCaptureReplayCount}`,
    `- Baseline/enhanced pairs: ${report.replayCoverage.baselineEnhancedPairs}`,
    `- Live demo gate: ${report.replayCoverage.liveDemoGate}`,
    "",
    "## Blockers",
    "",
    ...blockers.map((blocker) => `- ${blocker}`),
    "",
    "## Next Evidence",
    "",
    ...nextEvidence.map((evidence) => `- ${evidence}`),
    "",
    "## Validation",
    "",
    `Run: ${artifact.handoff.validationCommand}`,
    "",
  ].join("\n");
}

async function main() {
  const outputPath = resolveOutputPath();
  const latestOutputPath = resolveLatestOutputPath();
  const markdownOutputPath = resolveMarkdownOutputPath(outputPath);
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
    reviewGate: buildSpeechEnhancementReviewGate(report),
  };

  await writeJson(outputPath, artifact);
  if (latestOutputPath) {
    await writeJson(latestOutputPath, artifact);
  }
  if (markdownOutputPath) {
    await writeText(markdownOutputPath, buildMarkdownReport(artifact));
  }

  const summary = {
    ok: !requireCloseReady || artifact.reviewGate.issueCloseReady,
    outputPath,
    latestOutputPath: latestOutputPath ?? null,
    markdownOutputPath: markdownOutputPath ?? null,
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
