import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      report: { issue: string; proposedConfig: { featureFlag: string }; replayCoverage: { liveDemoGate: string } };
      reviewGate: { issueCloseReady: boolean; blockers: string[]; nextEvidence: string[] };
    };
    const latestArtifact = JSON.parse(await readFile(latestOutputPath, "utf8"));

    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.artifactType, "speech_enhancement_spike_report");
    assert.equal(artifact.report.issue, "agonza1/agentic-contact-center#97");
    assert.equal(artifact.report.proposedConfig.featureFlag, "RTC_ASR_SPEECH_ENHANCEMENT");
    assert.equal(artifact.report.replayCoverage.liveDemoGate, "blocked_until_real_capture");
    assert.equal(artifact.reviewGate.issueCloseReady, false);
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
