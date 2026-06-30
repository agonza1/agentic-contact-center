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
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
