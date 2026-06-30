import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("live SIP proof bundle carries integrity and honest review blockers", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-live-sip-bundle-"));
  const audioPath = path.join(tempDir, "caller-capture.wav");
  const sipLogPath = path.join(tempDir, "sip.log.json");
  const manifestPath = path.join(tempDir, "local-sip-live-proof-manifest.json");
  const outDir = path.join(tempDir, "bundle");

  try {
    await writeFile(audioPath, Buffer.from("RIFFtestWAVE", "ascii"));
    await writeFile(sipLogPath, `${JSON.stringify([{ startLine: "INVITE sip:8600@127.0.0.1 SIP/2.0" }])}\n`, "utf8");
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-06-30T10:00:00.000Z",
        workboardCard: "872af947-ef57-47bd-a4f3-3750f54e1948",
        callId: "call-live-sip-1",
        sipCallId: "sip-proof-1",
        runtimeModeLabels: {
          telephony: "local_sip",
          media: "generated_media",
          rtcAsr: "rtc_asr_blocked",
          credentialsMode: "mocked",
        },
        localSip: {
          bind: "sip:127.0.0.1:5066",
          rtpPort: 40000,
          acceptedInvite: true,
          rtpPacketCount: 4,
          remoteRtp: { address: "127.0.0.1", port: 40002 },
        },
        artifacts: { audioWav: audioPath, sipLog: sipLogPath },
        artifactIntegrity: [],
        reviewReady: false,
        blockers: [
          "Self-test generated RTP audio; rerun with a real local SIP softphone call before review.",
          "RTC_ASR_WS_URL was not set, so rtc-asr live transcription was not attempted.",
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", manifestPath, "--out-dir", outDir],
      { cwd: repoRoot },
    );

    const summary = JSON.parse(stdout) as { manifest: string; reviewReady: boolean; reviewGatePassed: boolean; validationStatus: string; blockers: string[] };
    assert.equal(summary.reviewReady, false);
    assert.equal(summary.reviewGatePassed, false);
    assert.equal(summary.validationStatus, "blocked_before_review");
    assert.match(summary.manifest, /proof-bundle-manifest\.json$/);
    assert.equal(summary.blockers.length, 2);

    const bundleManifest = JSON.parse(await readFile(path.join(outDir, "proof-bundle-manifest.json"), "utf8")) as {
      reviewReady: boolean;
      labels: string[];
      artifactIntegrity: Array<{ artifactId: string; kind: string; sha256: string; sizeBytes: number; readiness: string }>;
      reviewGate: { passed: boolean; requiredLabels: string[]; missingLabels: string[]; checks: Record<string, boolean> };
      validationSummary: { status: string; checks: Record<string, boolean>; blockers: string[]; nextActions: string[] };
    };
    assert.equal(bundleManifest.reviewReady, false);
    assert.ok(bundleManifest.labels.includes("generated_media"));
    assert.ok(bundleManifest.labels.includes("rtc_asr_blocked"));
    assert.equal(bundleManifest.artifactIntegrity.length, 6);
    assert.ok(bundleManifest.artifactIntegrity.every((artifact) => artifact.sha256.match(/^[a-f0-9]{64}$/)));
    assert.ok(bundleManifest.artifactIntegrity.every((artifact) => artifact.sizeBytes > 0));
    assert.ok(bundleManifest.artifactIntegrity.every((artifact) => artifact.readiness === "ready"));
    assert.ok(bundleManifest.artifactIntegrity.some((artifact) => artifact.artifactId === "conversation-agent-evals-assert-request" && artifact.kind === "assert_request"));
    assert.equal(bundleManifest.reviewGate.passed, false);
    assert.deepEqual(bundleManifest.reviewGate.requiredLabels, ["local_sip", "live_capture", "rtc_asr_live"]);
    assert.deepEqual(bundleManifest.reviewGate.missingLabels, ["live_capture", "rtc_asr_live"]);
    assert.equal(bundleManifest.validationSummary.status, "blocked_before_review");
    assert.equal(bundleManifest.validationSummary.checks.acceptedInvite, true);
    assert.equal(bundleManifest.validationSummary.checks.capturedRtp, true);
    assert.equal(bundleManifest.validationSummary.checks.artifactsPresent, true);
    assert.equal(bundleManifest.validationSummary.checks.liveCapture, false);
    assert.equal(bundleManifest.validationSummary.checks.rtcAsrLive, false);
    assert.equal(bundleManifest.validationSummary.blockers.length, 2);
    assert.deepEqual(bundleManifest.validationSummary.nextActions, [
      "Place a real local SIP/FreeSWITCH softphone call and rerun the live proof without --self-test.",
      "Start rtc-asr, set RTC_ASR_WS_URL, and rerun the live proof to capture a websocket-backed transcript.",
    ]);

    const assertRequest = JSON.parse(await readFile(path.join(outDir, "conversation-agent-evals-assert-request.json"), "utf8")) as {
      platform_metadata: { notes: string; labels: string[] };
    };
    assert.match(assertRequest.platform_metadata.notes, /Not review-ready/);
    assert.ok(assertRequest.platform_metadata.labels.includes("mocked_telephony"));

    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", manifestPath, "--out-dir", path.join(tempDir, "bundle-require-ready"), "--require-review-ready"],
        { cwd: repoRoot, encoding: "utf8" },
      ),
      (error: any) => {
        assert.equal(error.code, 2);
        assert.equal(JSON.parse(error.stdout).reviewGatePassed, false);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
