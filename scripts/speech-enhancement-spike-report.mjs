import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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
  const report = buildSpeechEnhancementSpikeReport();

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

  console.log(JSON.stringify({ ok: true, outputPath, latestOutputPath: latestOutputPath ?? null }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
