import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("FreeSWITCH bridge manifest is bundle-compatible and blocks missing rtc-asr evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-bridge-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");

  try {
    await writeFile(audioPath, Buffer.concat([Buffer.alloc(44), Buffer.alloc(320 * 4, 1)]));
    await writeFile(logPath, `${JSON.stringify({ events: [{ headers: { "Event-Name": "CHANNEL_ANSWER" } }] })}\n`, "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-1",
        accCallId: "demo-call-0001",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        telephonyMode: "local_sip"
      });
      console.log(JSON.stringify(manifest));
    `;

    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const manifest = JSON.parse(stdout) as {
      reviewReady: boolean;
      runtimeModeLabels: { telephony: string; media: string; rtcAsr: string; credentialsMode: string };
      localSip: { acceptedInvite: boolean; rtpPacketCount: number; destination: string };
      artifacts: { audioWav: string; sipLog: string; rtcAsrEvidence: string | null };
      artifactIntegrity: Array<{ artifactId: string; readiness: string; sha256: string; sizeBytes: number }>;
      blockers: string[];
      reviewGate: { missingLabels: string[]; nextActions: string[] };
    };

    assert.equal(manifest.reviewReady, false);
    assert.deepEqual(manifest.runtimeModeLabels, {
      telephony: "local_sip",
      media: "live_capture",
      rtcAsr: "rtc_asr_live",
      credentialsMode: "mocked",
    });
    assert.equal(manifest.localSip.acceptedInvite, true);
    assert.equal(manifest.localSip.destination, "8600");
    assert.equal(manifest.localSip.rtpPacketCount, 4);
    assert.equal(manifest.artifacts.audioWav, audioPath);
    assert.equal(manifest.artifacts.sipLog, logPath);
    assert.equal(manifest.artifacts.rtcAsrEvidence, null);
    assert.equal(manifest.artifactIntegrity.length, 2);
    assert.ok(manifest.artifactIntegrity.every((artifact) => artifact.readiness === "ready"));
    assert.ok(manifest.artifactIntegrity.every((artifact) => artifact.sha256.match(/^[a-f0-9]{64}$/)));
    assert.ok(manifest.artifactIntegrity.every((artifact) => artifact.sizeBytes > 0));
    assert.deepEqual(manifest.reviewGate.missingLabels, []);
    assert.ok(manifest.blockers.some((blocker) => blocker.includes("no transcript/evidence path")));
    assert.deepEqual(manifest.reviewGate.nextActions, [
      "Attach rtc-asr transcript evidence with --rtc-asr-evidence before marking the FreeSWITCH proof review-ready.",
    ]);

    const bundleDir = path.join(tempDir, "bundle");
    const manifestPath = path.join(tempDir, "freeswitch-live-proof-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const bundle = await execFileAsync(
      process.execPath,
      ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", manifestPath, "--out-dir", bundleDir],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const bundleSummary = JSON.parse(bundle.stdout) as { reviewGatePassed: boolean; validationStatus: string };
    assert.equal(bundleSummary.reviewGatePassed, false);
    assert.equal(bundleSummary.validationStatus, "blocked_before_review");

    const bundleManifest = JSON.parse(await readFile(path.join(bundleDir, "proof-bundle-manifest.json"), "utf8")) as {
      artifacts: { audioCapture: string; sipLogs: string; rtcAsrEvidence: string | null };
      validationSummary: { blockers: string[] };
    };
    assert.equal(bundleManifest.artifacts.audioCapture, path.relative(repoRoot, audioPath).replaceAll(path.sep, "/"));
    assert.equal(bundleManifest.artifacts.sipLogs, path.relative(repoRoot, logPath).replaceAll(path.sep, "/"));
    assert.equal(bundleManifest.artifacts.rtcAsrEvidence, null);
    assert.ok(bundleManifest.validationSummary.blockers.some((blocker) => blocker.includes("no transcript/evidence path")));

    const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ transcript: "hello from local sip", final: true })}\n`, "utf8");
    const readyScript = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-2",
        accCallId: "demo-call-0002",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
        telephonyMode: "local_sip"
      });
      console.log(JSON.stringify(manifest));
    `;
    const readyResult = await execFileAsync(process.execPath, ["--input-type=module", "--eval", readyScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const readyManifest = JSON.parse(readyResult.stdout) as typeof manifest;
    assert.equal(readyManifest.reviewReady, true);
    assert.equal(readyManifest.artifacts.rtcAsrEvidence, rtcAsrEvidencePath);
    assert.ok(readyManifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "ready"));

    const readyBundleDir = path.join(tempDir, "ready-bundle");
    const readyManifestPath = path.join(tempDir, "freeswitch-ready-live-proof-manifest.json");
    await writeFile(readyManifestPath, `${JSON.stringify(readyManifest, null, 2)}\n`, "utf8");
    const readyBundle = await execFileAsync(
      process.execPath,
      ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", readyManifestPath, "--out-dir", readyBundleDir],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const readyBundleSummary = JSON.parse(readyBundle.stdout) as { reviewGatePassed: boolean; validationStatus: string };
    assert.equal(readyBundleSummary.reviewGatePassed, true);
    assert.equal(readyBundleSummary.validationStatus, "ready_for_review");
    const readyBundleManifest = JSON.parse(await readFile(path.join(readyBundleDir, "proof-bundle-manifest.json"), "utf8")) as {
      artifacts: { rtcAsrEvidence: string | null };
      artifactIntegrity: Array<{ artifactId: string; readiness: string }>;
    };
    assert.equal(readyBundleManifest.artifacts.rtcAsrEvidence, path.relative(repoRoot, rtcAsrEvidencePath).replaceAll(path.sep, "/"));
    assert.ok(readyBundleManifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "ready"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
