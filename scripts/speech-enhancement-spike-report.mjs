import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  buildSpeechEnhancementReviewGate,
  buildSpeechEnhancementReviewHandoff,
  buildSpeechEnhancementSpikeReport,
  validateSpeechEnhancementCaptureReplayManifest,
} = require("../dist/src/core/speechEnhancementSpike.js");

const valueFlags = new Set(["--capture-replay", "--capture-replay-dir", "--out", "--latest-out", "--markdown-out"]);
const booleanFlags = new Set(["--strict-capture-artifacts", "--require-close-ready"]);

function validateCliArgs(argv) {
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueFlags.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      continue;
    }

    if (booleanFlags.has(arg)) {
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    throw new Error(`Unexpected positional argument: ${arg}`);
  }
}

function resolveArgPath(flag) {
  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) {
    return path.resolve(process.cwd(), process.argv[flagIndex + 1]);
  }

  return undefined;
}

function resolveArgPaths(flag) {
  const paths = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) {
      paths.push(path.resolve(process.cwd(), process.argv[index + 1]));
    }
  }

  return paths;
}

function hasArg(flag) {
  return process.argv.includes(flag);
}

async function loadCaptureReplayMetrics() {
  const captureReplayPaths = await resolveCaptureReplayPaths();
  const strictCaptureArtifacts = hasArg("--strict-capture-artifacts");
  const metrics = [];
  const seenCaptureIds = new Map();

  for (const captureReplayPath of captureReplayPaths) {
    const payload = JSON.parse(await readFile(captureReplayPath, "utf8"));
    const validation = validateSpeechEnhancementCaptureReplayManifest(payload);
    if (!validation.manifestOk || !validation.metric) {
      throw new Error(`Invalid capture replay manifest: ${captureReplayPath}: ${validation.missingFields.join(", ")}`);
    }

    const previousCaptureReplayPath = seenCaptureIds.get(validation.metric.captureId);
    if (previousCaptureReplayPath) {
      throw new Error(
        `Duplicate capture replay id: ${validation.metric.captureId}: ${previousCaptureReplayPath} and ${captureReplayPath}`,
      );
    }
    seenCaptureIds.set(validation.metric.captureId, captureReplayPath);

    if (strictCaptureArtifacts) {
      await assertCaptureArtifact(payload.audio_source_uri, payload.audio_sha256, captureReplayPath, "audio_source_uri");
      await assertCaptureArtifact(
        payload.source_manifest_uri,
        payload.source_manifest_sha256,
        captureReplayPath,
        "source_manifest_uri",
      );
    }

    metrics.push(validation.metric);
  }

  return metrics;
}

async function resolveCaptureReplayPaths() {
  const explicitPaths = resolveArgPaths("--capture-replay");
  const directoryPaths = resolveArgPaths("--capture-replay-dir");
  const directoryManifestPaths = [];

  for (const directoryPath of directoryPaths) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    directoryManifestPaths.push(
      ...entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => path.join(directoryPath, entry.name))
        .sort(),
    );
  }

  return [...explicitPaths, ...directoryManifestPaths];
}

async function assertCaptureArtifact(artifactUri, expectedSha256, captureReplayPath, field) {
  const artifactPath = path.resolve(process.cwd(), artifactUri);
  let contents;

  try {
    contents = await readFile(artifactPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Missing capture replay artifact for ${field}: ${captureReplayPath}: ${artifactUri}`);
    }

    throw error;
  }

  if (!expectedSha256) {
    throw new Error(`Missing sha256 for strict capture replay artifact: ${captureReplayPath}: ${field}`);
  }

  const actualSha256 = createHash("sha256").update(contents).digest("hex");
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(
      `Capture replay artifact hash mismatch for ${field}: ${captureReplayPath}: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
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
  const closeGate = report.closeGateProfile;
  const blockers = reviewGate.blockers.length > 0 ? reviewGate.blockers : ["None. Issue #97 close gate is ready."];
  const nextEvidence = reviewGate.nextEvidence.length > 0 ? reviewGate.nextEvidence : ["None."];
  const reviewChecks = Object.entries(reviewGate.checks).map(([check, passed]) => {
    const status = passed ? "x" : " ";
    return "- [" + status + "] " + check;
  });
  const failureReasons = Object.entries(reviewGate.failureReasons).map(([check, reason]) => "- " + check + ": " + reason);
  const replayEvidence = reviewGate.realCaptureReplayEvidence.map((evidence) => {
    const source = evidence.audioSourceUri ?? "missing audio source";
    const sourceManifest = evidence.sourceManifestUri ?? "missing source manifest";
    const runtimeHost = evidence.runtimeHost ?? "missing runtime host";

    return `- ${evidence.captureId}: ${evidence.status}; wer_delta=${evidence.wordErrorRateDelta}; latency_headroom_ms=${evidence.addedLatencyBudgetHeadroomMs}; cpu_headroom_percent=${evidence.cpuP95BudgetHeadroomPercent}; audio=${source}; source_manifest=${sourceManifest}; runtime_host=${runtimeHost}`;
  });
  const replayDecisions = report.replayDecisions.map((decision) => {
    const enabled = decision.enableForLiveDemo ? "enabled" : "blocked";
    const diagnostics = decision.diagnostics;

    return `- ${decision.captureId}: ${enabled}; latency_setting_ms=${decision.latencySettingMs}; wer_delta=${diagnostics.wordErrorRateDelta}; latency_headroom_ms=${diagnostics.addedLatencyBudgetHeadroomMs}; cpu_headroom_percent=${diagnostics.cpuP95BudgetHeadroomPercent}; reasons=${decision.reasons.join(", ")}`;
  });

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
    `- Strict artifact hashes: ${report.captureReplayContract.strictArtifactFields.join(", ")}`,
    `- Passing real replay ids: ${reviewGate.passingRealCaptureReplayIds.join(", ") || "None"}`,
    `- Blocked real replay ids: ${reviewGate.blockedRealCaptureReplayIds.join(", ") || "None"}`,
    "",
    "## Close Gate Profile",
    "",
    `- Required capture id prefix: ${closeGate.requiredCaptureIdPrefix}`,
    `- Required latency setting: ${closeGate.requiredLatencySettingMs} ms`,
    `- Max added turn latency p95: ${closeGate.maxAddedTurnLatencyMsP95} ms`,
    `- Max CPU p95: ${closeGate.maxCpuPercentP95}%`,
    `- Allowed CPU cost estimates: ${closeGate.allowedCpuCostEstimates.join(", ")}`,
    "",
    "## Real Capture Replay Evidence",
    "",
    ...(replayEvidence.length > 0 ? replayEvidence : ["- None attached."]),
    "",
    "## Replay Decisions",
    "",
    ...replayDecisions,
    "",
    "## Review Checks",
    "",
    ...reviewChecks,
    "",
    "## Failure Reasons",
    "",
    ...(failureReasons.length > 0 ? failureReasons : ["- None."]),
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
    `Strict artifact check: ${artifact.handoff.strictValidationCommand}`,
    "",
  ].join("\n");
}

async function main() {
  validateCliArgs(process.argv);

  const outputPath = resolveOutputPath();
  const latestOutputPath = resolveLatestOutputPath();
  const markdownOutputPath = resolveMarkdownOutputPath(outputPath);
  const requireCloseReady = hasArg("--require-close-ready");
  const captureReplayMetrics = await loadCaptureReplayMetrics();
  const report = buildSpeechEnhancementSpikeReport({ captureReplayMetrics });

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
    handoff: buildSpeechEnhancementReviewHandoff(),
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
    checks: artifact.reviewGate.checks,
    failureReasons: artifact.reviewGate.failureReasons,
    blockers: artifact.reviewGate.blockers,
    nextEvidence: artifact.reviewGate.nextEvidence,
    realCaptureReplayIds: artifact.reviewGate.realCaptureReplayIds,
    passingRealCaptureReplayIds: artifact.reviewGate.passingRealCaptureReplayIds,
    blockedRealCaptureReplayIds: artifact.reviewGate.blockedRealCaptureReplayIds,
    realCaptureReplayEvidence: artifact.reviewGate.realCaptureReplayEvidence,
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
