import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("local SIP self-test writes an honest blocked manifest and fails review-ready gates", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-local-sip-"));
  const portBase = 46000 + Math.floor(Math.random() * 1000) * 4;

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "scripts/local-sip-live-proof.mjs",
          "--self-test",
          "--require-live-caller",
          "--listen-seconds",
          "0",
          "--duration-ms",
          "120",
          "--sip-port",
          String(portBase),
          "--rtp-port",
          String(portBase + 1),
          "--out-dir",
          tempDir,
        ],
        { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
      ),
      (error: any) => {
        assert.equal(error.code, 2);
        const summary = JSON.parse(error.stdout.slice(error.stdout.indexOf("{")).trim()) as { reviewReady: boolean; blockers: string[] };
        assert.equal(summary.reviewReady, false);
        assert.ok(summary.blockers.some((blocker) => blocker.includes("Self-test generated RTP audio")));
        assert.ok(summary.blockers.some((blocker) => blocker.includes("RTC_ASR_WS_URL")));
        return true;
      },
    );

    const manifest = JSON.parse(await readFile(path.join(tempDir, "local-sip-live-proof-manifest.json"), "utf8")) as {
      reviewReady: boolean;
      runtimeModeLabels: { telephony: string; media: string; rtcAsr: string; credentialsMode: string };
      localSip: { acceptedInvite: boolean; rtpPacketCount: number };
      artifactIntegrity: Array<{ readiness: string; sizeBytes: number }>;
      reviewGate: { requiredLabels: string[]; missingLabels: string[]; nextActions: string[] };
    };
    assert.equal(manifest.reviewReady, false);
    assert.deepEqual(manifest.runtimeModeLabels, {
      telephony: "local_sip",
      media: "generated_media",
      rtcAsr: "rtc_asr_blocked",
      credentialsMode: "mocked",
    });
    assert.equal(manifest.localSip.acceptedInvite, true);
    assert.ok(manifest.localSip.rtpPacketCount > 0);
    assert.ok(manifest.artifactIntegrity.every((artifact) => artifact.readiness === "ready" && artifact.sizeBytes > 0));
    assert.deepEqual(manifest.reviewGate.requiredLabels, ["local_sip", "live_capture", "rtc_asr_live"]);
    assert.deepEqual(manifest.reviewGate.missingLabels, ["live_capture", "rtc_asr_live"]);
    assert.deepEqual(manifest.reviewGate.nextActions, [
      "Place a real local SIP/FreeSWITCH softphone call and rerun the live proof without --self-test.",
      "Start rtc-asr, set RTC_ASR_WS_URL, and rerun the live proof to capture a websocket-backed transcript.",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("local SIP live-caller gate exits nonzero when no caller arrives", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-local-sip-timeout-"));
  const portBase = 47000 + Math.floor(Math.random() * 1000) * 4;

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "scripts/local-sip-live-proof.mjs",
          "--require-live-caller",
          "--listen-seconds",
          "0",
          "--sip-port",
          String(portBase),
          "--rtp-port",
          String(portBase + 1),
          "--out-dir",
          tempDir,
        ],
        { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
      ),
      (error: any) => {
        assert.equal(error.code, 2);
        const summary = JSON.parse(error.stdout.slice(error.stdout.indexOf("{")).trim()) as { reviewReady: boolean; blockers: string[] };
        assert.equal(summary.reviewReady, false);
        assert.ok(summary.blockers.some((blocker) => blocker.includes("No RTP packets")));
        return true;
      },
    );

    const manifest = JSON.parse(await readFile(path.join(tempDir, "local-sip-live-proof-manifest.json"), "utf8")) as {
      reviewReady: boolean;
      runtimeModeLabels: { media: string; rtcAsr: string };
      localSip: { acceptedInvite: boolean; rtpPacketCount: number };
      reviewGate: { missingLabels: string[]; nextActions: string[] };
    };
    assert.equal(manifest.reviewReady, false);
    assert.equal(manifest.runtimeModeLabels.media, "live_capture");
    assert.equal(manifest.runtimeModeLabels.rtcAsr, "rtc_asr_blocked");
    assert.equal(manifest.localSip.acceptedInvite, false);
    assert.equal(manifest.localSip.rtpPacketCount, 0);
    assert.deepEqual(manifest.reviewGate.missingLabels, ["rtc_asr_live"]);
    assert.deepEqual(manifest.reviewGate.nextActions, [
      "Place a real local SIP/FreeSWITCH softphone call and rerun the live proof without --self-test.",
      "Start rtc-asr, set RTC_ASR_WS_URL, and rerun the live proof to capture a websocket-backed transcript.",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
