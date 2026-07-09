import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  buildSpeechEnhancementCaptureReplayTemplate,
  buildSpeechEnhancementReviewGate,
  buildSpeechEnhancementReviewHandoff,
  buildSpeechEnhancementRuntimeReadiness,
  buildSpeechEnhancementSpikeReport,
  buildSpeechEnhancementStrictArtifactVerification,
  resolveSpeechEnhancementRuntimeConfig,
  validateSpeechEnhancementCaptureReplayManifest,
} = require("../dist/src/core/speechEnhancementSpike.js");

const valueFlags = new Set([
  "--capture-replay",
  "--capture-replay-dir",
  "--out",
  "--latest-out",
  "--markdown-out",
  "--capture-replay-template-out",
]);
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
  const sources = [];
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
    sources.push({
      captureId: validation.metric.captureId,
      path: captureReplayPath,
      strictArtifactsVerified: strictCaptureArtifacts,
    });
  }

  return { metrics, sources };
}

function buildCaptureReplaySourceDigest(sources) {
  const digestInput = sources.map((source) => ({
    captureId: source.captureId,
    path: source.path,
    strictArtifactsVerified: source.strictArtifactsVerified,
  }));

  return createHash("sha256").update(JSON.stringify(digestInput)).digest("hex");
}

async function resolveCaptureReplayPaths() {
  const explicitPaths = resolveArgPaths("--capture-replay");
  const directoryPaths = resolveArgPaths("--capture-replay-dir");
  const directoryManifestPaths = [];

  for (const directoryPath of directoryPaths) {
    const directoryStats = await stat(directoryPath).catch((error) => {
      if (error && error.code === "ENOENT") {
        throw new Error(`Missing capture replay directory: ${directoryPath}`);
      }

      throw error;
    });
    if (!directoryStats.isDirectory()) {
      throw new Error(`Capture replay directory is not a directory: ${directoryPath}`);
    }

    directoryManifestPaths.push(...await collectCaptureReplayManifestPaths(directoryPath));
  }

  return [...new Set([...explicitPaths, ...directoryManifestPaths])];
}

async function collectCaptureReplayManifestPaths(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const manifestPaths = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      manifestPaths.push(...await collectCaptureReplayManifestPaths(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".json")) {
      manifestPaths.push(entryPath);
    }
  }

  return manifestPaths.sort();
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

function resolveCaptureReplayTemplateOutputPath() {
  return resolveArgPath("--capture-replay-template-out");
}

function buildCaptureReplayTemplate() {
  return buildSpeechEnhancementCaptureReplayTemplate();
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
  const latencyProfiles = report.latencyProfiles.map((profile) => {
    const eligibility = profile.liveDemoEligible ? "live-demo-eligible" : "offline-only";

    return `- ${profile.latencyMs} ms: ${eligibility}; lookahead_frames=${profile.lookaheadFrames}; max_buffered_audio_ms=${profile.maxBufferedAudioMs}; expected_use=${profile.expectedUse}; recommendation=${profile.recommendation}`;
  });
  const replayEvidence = reviewGate.realCaptureReplayEvidence.map((evidence) => {
    const source = evidence.audioSourceUri ?? "missing audio source";
    const sourceManifest = evidence.sourceManifestUri ?? "missing source manifest";
    const runtimeHost = evidence.runtimeHost ?? "missing runtime host";

    const failingEvidence = evidence.failingEvidence.length > 0 ? evidence.failingEvidence.join(", ") : "none";
    const reasons = evidence.reasons.length > 0 ? evidence.reasons.join(", ") : "none";

    return `- ${evidence.captureId}: ${evidence.status}; wer_delta=${evidence.wordErrorRateDelta}; latency_headroom_ms=${evidence.addedLatencyBudgetHeadroomMs}; cpu_headroom_percent=${evidence.cpuP95BudgetHeadroomPercent}; failing_evidence=${failingEvidence}; reasons=${reasons}; audio=${source}; source_manifest=${sourceManifest}; runtime_host=${runtimeHost}`;
  });
  const captureReplaySources = artifact.captureReplaySources.map((source) => {
    const strictArtifacts = source.strictArtifactsVerified ? "verified" : "not_verified";

    return `- ${source.captureId}: path=${source.path}; strict_artifacts=${strictArtifacts}`;
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
    `Runtime readiness: ${artifact.runtimeReadiness.liveDemoEligible ? "live-demo-eligible" : "bypassed"}`,
    `Runtime latency: ${artifact.runtimeReadiness.latencyMs} ms`,
    `Runtime frame budget: ${artifact.runtimeReadiness.frameBudget.lookaheadFrames !== null ? artifact.runtimeReadiness.frameBudget.lookaheadFrames : "unknown"} lookahead frame(s), ${artifact.runtimeReadiness.frameBudget.maxBufferedAudioMs !== null ? artifact.runtimeReadiness.frameBudget.maxBufferedAudioMs : "unknown"} ms max buffered audio`,
    `Runtime bypass reasons: ${artifact.runtimeReadiness.bypassReasons.length > 0 ? artifact.runtimeReadiness.bypassReasons.join(", ") : "None"}`,
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
    `- Strict artifact fields: ${report.captureReplayContract.strictArtifactFields.join(", ")}`,
    `- Strict artifact verification: ${artifact.strictArtifactVerification.verified ? "verified" : "not_verified"}`,
    `- Strict artifact verification reason: ${artifact.strictArtifactVerification.reason}`,
    `- Capture replay source digest: ${artifact.captureReplaySourceDigest}`,
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
    "## Latency Profiles",
    "",
    ...latencyProfiles,
    "",
    "## Real Capture Replay Evidence",
    "",
    ...(replayEvidence.length > 0 ? replayEvidence : ["- None attached."]),
    "",
    "## Capture Replay Sources",
    "",
    ...(captureReplaySources.length > 0 ? captureReplaySources : ["- None loaded."]),
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
    "## Next Action",
    "",
    `- Owner: ${reviewGate.nextAction.owner}`,
    `- Action: ${reviewGate.nextAction.action}`,
    `- Reason: ${reviewGate.nextAction.reason}`,
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
  const captureReplayTemplateOutputPath = resolveCaptureReplayTemplateOutputPath();
  const requireCloseReady = hasArg("--require-close-ready");
  const strictCaptureArtifacts = hasArg("--strict-capture-artifacts");
  const captureReplayInputs = await loadCaptureReplayMetrics();
  const report = buildSpeechEnhancementSpikeReport({ captureReplayMetrics: captureReplayInputs.metrics });
  const runtimeConfig = resolveSpeechEnhancementRuntimeConfig({
    featureFlag: process.env.RTC_ASR_SPEECH_ENHANCEMENT,
    latencyMs: process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS,
  });

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
    runtimeConfig,
    runtimeReadiness: buildSpeechEnhancementRuntimeReadiness(runtimeConfig, report),
    captureReplaySources: captureReplayInputs.sources,
    captureReplaySourceDigest: buildCaptureReplaySourceDigest(captureReplayInputs.sources),
    strictArtifactVerification: buildSpeechEnhancementStrictArtifactVerification(
      captureReplayInputs.sources,
      strictCaptureArtifacts,
    ),
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
  if (captureReplayTemplateOutputPath) {
    await writeJson(captureReplayTemplateOutputPath, buildCaptureReplayTemplate());
  }

  const summary = {
    ok: !requireCloseReady || artifact.reviewGate.issueCloseReady,
    outputPath,
    latestOutputPath: latestOutputPath ?? null,
    markdownOutputPath: markdownOutputPath ?? null,
    captureReplayTemplateOutputPath: captureReplayTemplateOutputPath ?? null,
    issueCloseReady: artifact.reviewGate.issueCloseReady,
    runtimeLiveDemoEligible: artifact.runtimeReadiness.liveDemoEligible,
    runtimeBypassReasons: artifact.runtimeReadiness.bypassReasons,
    checks: artifact.reviewGate.checks,
    failureReasons: artifact.reviewGate.failureReasons,
    blockers: artifact.reviewGate.blockers,
    strictArtifactVerification: artifact.strictArtifactVerification,
    nextEvidence: artifact.reviewGate.nextEvidence,
    nextAction: artifact.reviewGate.nextAction,
    realCaptureReplayIds: artifact.reviewGate.realCaptureReplayIds,
    passingRealCaptureReplayIds: artifact.reviewGate.passingRealCaptureReplayIds,
    blockedRealCaptureReplayIds: artifact.reviewGate.blockedRealCaptureReplayIds,
    realCaptureReplayEvidence: artifact.reviewGate.realCaptureReplayEvidence,
    captureReplaySources: artifact.captureReplaySources,
    captureReplaySourceDigest: artifact.captureReplaySourceDigest,
    strictArtifactChecks: report.captureReplayContract.strictArtifactChecks,
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
