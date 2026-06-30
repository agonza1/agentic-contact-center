import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function validWavFixture() {
  const buffer = Buffer.alloc(48);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(40, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(4, 40);
  return buffer;
}

test("live SIP proof bundle carries integrity and honest review blockers", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-live-sip-bundle-"));
  const audioPath = path.join(tempDir, "caller-capture.wav");
  const sipLogPath = path.join(tempDir, "sip.log.json");
  const manifestPath = path.join(tempDir, "local-sip-live-proof-manifest.json");
  const outDir = path.join(tempDir, "bundle");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(sipLogPath, `${JSON.stringify([{ startLine: "INVITE sip:8600@127.0.0.1 SIP/2.0" }, { startLine: "SIP/2.0 200 OK" }])}\n`, "utf8");
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
        reviewGate: {
          requiredLabels: ["local_sip", "live_capture", "rtc_asr_live"],
          missingLabels: ["live_capture", "rtc_asr_live"],
          nextActions: [
            "Place a real local SIP/FreeSWITCH softphone call and rerun the live proof without --self-test.",
            "Start rtc-asr, set RTC_ASR_WS_URL, and rerun the live proof to capture a websocket-backed transcript.",
          ],
        },
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

    const summary = JSON.parse(stdout) as { manifest: string; reviewGateReport: string; reviewGateReportJson: string; reviewReady: boolean; reviewGatePassed: boolean; validationStatus: string; blockers: string[] };
    assert.equal(summary.reviewReady, false);
    assert.equal(summary.reviewGatePassed, false);
    assert.equal(summary.validationStatus, "blocked_before_review");
    assert.match(summary.manifest, /proof-bundle-manifest\.json$/);
    assert.match(summary.reviewGateReport, /review-gate-report\.md$/);
    assert.match(summary.reviewGateReportJson, /review-gate-report\.json$/);
    assert.equal(summary.blockers.length, 2);

    const bundleManifest = JSON.parse(await readFile(path.join(outDir, "proof-bundle-manifest.json"), "utf8")) as {
      reviewReady: boolean;
      labels: string[];
      artifactIntegrity: Array<{ artifactId: string; kind: string; sha256: string; sizeBytes: number; readiness: string }>;
      reviewGate: { passed: boolean; requiredLabels: string[]; missingLabels: string[]; checks: Record<string, boolean>; failureReasons: Record<string, string> };
      validationSummary: { status: string; checks: Record<string, boolean>; blockers: string[]; nextActions: string[]; callerAudioEvidence: { ready: boolean; hasRiffWaveHeader: boolean; hasAudioPayload: boolean; declaredDataBytes: number; sizeBytes: number }; sipLogEvidence: { entryCount: number; hasInvite: boolean; hasAcceptedInviteResponse: boolean } };
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
    assert.equal(bundleManifest.validationSummary.checks.sipLogHasInvite, true);
    assert.equal(bundleManifest.validationSummary.checks.sipLogHasAcceptedInvite, true);
    assert.equal(bundleManifest.validationSummary.checks.capturedRtp, true);
    assert.equal(bundleManifest.validationSummary.checks.callerAudioWavValid, true);
    assert.equal(bundleManifest.validationSummary.checks.artifactsPresent, true);
    assert.equal(bundleManifest.validationSummary.checks.liveCapture, false);
    assert.equal(bundleManifest.validationSummary.checks.rtcAsrLive, false);
    assert.deepEqual(Object.keys(bundleManifest.reviewGate.failureReasons), ["liveCapture", "rtcAsrLive", "sourceManifestReviewReady"]);
    assert.deepEqual(bundleManifest.validationSummary.callerAudioEvidence, { ready: true, hasRiffWaveHeader: true, hasAudioPayload: true, declaredDataBytes: 4, sizeBytes: 48 });
    assert.deepEqual(bundleManifest.validationSummary.sipLogEvidence, { entryCount: 2, hasInvite: true, hasAcceptedInviteResponse: true });
    assert.match(bundleManifest.reviewGate.failureReasons.liveCapture, /real local SIP/);
    assert.match(bundleManifest.reviewGate.failureReasons.rtcAsrLive, /RTC_ASR_WS_URL/);
    assert.match(bundleManifest.reviewGate.failureReasons.sourceManifestReviewReady, /Source live proof manifest is not review-ready/);
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

    const reviewGateReportJson = JSON.parse(await readFile(path.join(outDir, "review-gate-report.json"), "utf8")) as {
      status: string;
      reviewGatePassed: boolean;
      missingLabels: string[];
      failureReasons: Record<string, string>;
      artifacts: { conversationAgentEvalsRequest: string };
      artifactIntegrity: Array<{ artifactId: string; readiness: string }>;
      sourceManifestReviewGate: { missingLabels: string[]; nextActions: string[] };
    };
    assert.equal(reviewGateReportJson.status, "blocked_before_review");
    assert.equal(reviewGateReportJson.reviewGatePassed, false);
    assert.deepEqual(reviewGateReportJson.missingLabels, ["live_capture", "rtc_asr_live"]);
    assert.match(reviewGateReportJson.failureReasons.sourceManifestReviewReady, /Source live proof manifest is not review-ready/);
    assert.match(reviewGateReportJson.artifacts.conversationAgentEvalsRequest, /conversation-agent-evals-assert-request\.json$/);
    assert.ok(reviewGateReportJson.artifactIntegrity.some((artifact) => artifact.artifactId === "conversation-agent-evals-assert-request" && artifact.readiness === "ready"));
    assert.deepEqual(reviewGateReportJson.sourceManifestReviewGate.missingLabels, ["live_capture", "rtc_asr_live"]);
    assert.deepEqual(reviewGateReportJson.sourceManifestReviewGate.nextActions, [
      "Place a real local SIP/FreeSWITCH softphone call and rerun the live proof without --self-test.",
      "Start rtc-asr, set RTC_ASR_WS_URL, and rerun the live proof to capture a websocket-backed transcript.",
    ]);

    const reviewGateReport = await readFile(path.join(outDir, "review-gate-report.md"), "utf8");
    assert.match(reviewGateReport, /Status: blocked_before_review/);
    assert.match(reviewGateReport, /Review ready: no/);
    assert.match(reviewGateReport, /Missing runtime labels: live_capture, rtc_asr_live/);
    assert.match(reviewGateReport, /- \[x\] acceptedInvite/);
    assert.match(reviewGateReport, /- \[x\] sipLogHasInvite/);
    assert.match(reviewGateReport, /- \[x\] sipLogHasAcceptedInvite/);
    assert.match(reviewGateReport, /- \[ \] liveCapture/);
    assert.match(reviewGateReport, /## Failed Check Reasons/);
    assert.match(reviewGateReport, /liveCapture: Media is not labeled live_capture/);
    assert.match(reviewGateReport, /rtcAsrLive: rtc-asr is not labeled rtc_asr_live/);
    assert.match(reviewGateReport, /sourceManifestReviewReady: Source live proof manifest is not review-ready/);
    assert.match(reviewGateReport, /## Source Manifest Review Gate/);
    assert.match(reviewGateReport, /Missing runtime labels: live_capture, rtc_asr_live/);
    assert.match(reviewGateReport, /Place a real local SIP\/FreeSWITCH softphone call/);

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


test("live SIP proof bundle blocks malformed caller WAV evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-live-sip-bad-wav-"));
  const audioPath = path.join(tempDir, "caller-capture.wav");
  const sipLogPath = path.join(tempDir, "sip.log.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");
  const manifestPath = path.join(tempDir, "local-sip-live-proof-manifest.json");
  const outDir = path.join(tempDir, "bundle");

  try {
    await writeFile(audioPath, Buffer.from("not-a-wave-file", "ascii"));
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ transcript: "I need billing help.", final: true })}\n`, "utf8");
    await writeFile(sipLogPath, `${JSON.stringify([{ startLine: "INVITE sip:8600@127.0.0.1 SIP/2.0" }, { startLine: "SIP/2.0 200 OK" }])}\n`, "utf8");
    const manifest = {
      schemaVersion: 1,
      generatedAt: "2026-06-30T10:00:00.000Z",
      workboardCard: "872af947-ef57-47bd-a4f3-3750f54e1948",
      callId: "call-live-sip-1",
      sipCallId: "sip-proof-1",
      runtimeModeLabels: {
        telephony: "local_sip",
        media: "live_capture",
        rtcAsr: "rtc_asr_live",
        credentialsMode: "mocked",
      },
      localSip: {
        bind: "sip:127.0.0.1:5066",
        rtpPort: 40000,
        acceptedInvite: true,
        rtpPacketCount: 4,
      },
      artifacts: { audioWav: audioPath, sipLog: sipLogPath, rtcAsrEvidence: rtcAsrEvidencePath },
      artifactIntegrity: [],
      reviewGate: {
        requiredLabels: ["local_sip", "live_capture", "rtc_asr_live"],
        missingLabels: [],
        nextActions: [],
      },
      reviewReady: true,
      blockers: [],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", manifestPath, "--out-dir", outDir],
      { cwd: repoRoot },
    );

    const summary = JSON.parse(stdout) as { reviewGatePassed: boolean; validationStatus: string };
    assert.equal(summary.reviewGatePassed, false);
    assert.equal(summary.validationStatus, "blocked_before_review");

    const bundleManifest = JSON.parse(await readFile(path.join(outDir, "proof-bundle-manifest.json"), "utf8")) as {
      reviewGate: { checks: Record<string, boolean>; failureReasons: Record<string, string> };
      validationSummary: { callerAudioEvidence: { ready: boolean; hasRiffWaveHeader: boolean; hasAudioPayload: boolean; declaredDataBytes: number; sizeBytes: number } };
    };
    assert.equal(bundleManifest.reviewGate.checks.callerAudioWavValid, false);
    assert.match(bundleManifest.reviewGate.failureReasons.callerAudioWavValid, /RIFF\/WAVE/);
    assert.deepEqual(bundleManifest.validationSummary.callerAudioEvidence, { ready: false, hasRiffWaveHeader: false, hasAudioPayload: false, declaredDataBytes: 0, sizeBytes: 15 });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live SIP proof bundle blocks WAV evidence with an empty data chunk", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-live-sip-empty-wav-"));
  const audioPath = path.join(tempDir, "caller-capture.wav");
  const sipLogPath = path.join(tempDir, "sip.log.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");
  const manifestPath = path.join(tempDir, "local-sip-live-proof-manifest.json");
  const outDir = path.join(tempDir, "bundle");

  try {
    const emptyDataWav = Buffer.concat([validWavFixture().subarray(0, 44), Buffer.alloc(8)]);
    emptyDataWav.writeUInt32LE(0, 40);
    await writeFile(audioPath, emptyDataWav);
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ transcript: "I need billing help.", final: true })}\n`, "utf8");
    await writeFile(sipLogPath, `${JSON.stringify([{ startLine: "INVITE sip:8600@127.0.0.1 SIP/2.0" }, { startLine: "SIP/2.0 200 OK" }])}\n`, "utf8");
    const manifest = {
      schemaVersion: 1,
      generatedAt: "2026-06-30T10:00:00.000Z",
      workboardCard: "872af947-ef57-47bd-a4f3-3750f54e1948",
      callId: "call-live-sip-1",
      sipCallId: "sip-proof-1",
      runtimeModeLabels: {
        telephony: "local_sip",
        media: "live_capture",
        rtcAsr: "rtc_asr_live",
        credentialsMode: "mocked",
      },
      localSip: {
        bind: "sip:127.0.0.1:5066",
        rtpPort: 40000,
        acceptedInvite: true,
        rtpPacketCount: 4,
      },
      artifacts: { audioWav: audioPath, sipLog: sipLogPath, rtcAsrEvidence: rtcAsrEvidencePath },
      artifactIntegrity: [],
      reviewGate: {
        requiredLabels: ["local_sip", "live_capture", "rtc_asr_live"],
        missingLabels: [],
        nextActions: [],
      },
      reviewReady: true,
      blockers: [],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", manifestPath, "--out-dir", outDir],
      { cwd: repoRoot },
    );

    const summary = JSON.parse(stdout) as { reviewGatePassed: boolean; validationStatus: string };
    assert.equal(summary.reviewGatePassed, false);
    assert.equal(summary.validationStatus, "blocked_before_review");

    const bundleManifest = JSON.parse(await readFile(path.join(outDir, "proof-bundle-manifest.json"), "utf8")) as {
      reviewGate: { checks: Record<string, boolean>; failureReasons: Record<string, string> };
      validationSummary: { callerAudioEvidence: { ready: boolean; hasRiffWaveHeader: boolean; hasAudioPayload: boolean; declaredDataBytes: number; sizeBytes: number } };
    };
    assert.equal(bundleManifest.reviewGate.checks.callerAudioWavValid, false);
    assert.match(bundleManifest.reviewGate.failureReasons.callerAudioWavValid, /captured audio payload/);
    assert.deepEqual(bundleManifest.validationSummary.callerAudioEvidence, { ready: false, hasRiffWaveHeader: true, hasAudioPayload: false, declaredDataBytes: 0, sizeBytes: 52 });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live SIP proof bundle blocks manifests whose SIP log has no INVITE", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-live-sip-empty-log-"));
  const audioPath = path.join(tempDir, "caller-capture.wav");
  const sipLogPath = path.join(tempDir, "sip.log.json");
  const manifestPath = path.join(tempDir, "local-sip-live-proof-manifest.json");
  const outDir = path.join(tempDir, "bundle");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(sipLogPath, "[]\n", "utf8");
    const manifest = {
      schemaVersion: 1,
      generatedAt: "2026-06-30T10:00:00.000Z",
      workboardCard: "872af947-ef57-47bd-a4f3-3750f54e1948",
      callId: "call-live-sip-1",
      sipCallId: "sip-proof-1",
      runtimeModeLabels: {
        telephony: "local_sip",
        media: "live_capture",
        rtcAsr: "rtc_asr_live",
        credentialsMode: "mocked",
      },
      localSip: {
        bind: "sip:127.0.0.1:5066",
        rtpPort: 40000,
        acceptedInvite: true,
        rtpPacketCount: 4,
      },
      artifacts: { audioWav: audioPath, sipLog: sipLogPath },
      artifactIntegrity: [],
      reviewGate: {
        requiredLabels: ["local_sip", "live_capture", "rtc_asr_live"],
        missingLabels: [],
        nextActions: [],
      },
      reviewReady: true,
      blockers: [],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", manifestPath, "--out-dir", outDir],
      { cwd: repoRoot },
    );

    const summary = JSON.parse(stdout) as { reviewReady: boolean; reviewGatePassed: boolean; validationStatus: string };
    assert.equal(summary.reviewReady, true);
    assert.equal(summary.reviewGatePassed, false);
    assert.equal(summary.validationStatus, "blocked_before_review");

    const bundleManifest = JSON.parse(await readFile(path.join(outDir, "proof-bundle-manifest.json"), "utf8")) as {
      reviewGate: { checks: Record<string, boolean>; failureReasons: Record<string, string> };
      validationSummary: { callerAudioEvidence: { ready: boolean; hasRiffWaveHeader: boolean; hasAudioPayload: boolean; declaredDataBytes: number; sizeBytes: number }; sipLogEvidence: { entryCount: number; hasInvite: boolean; hasAcceptedInviteResponse: boolean } };
    };
    assert.equal(bundleManifest.reviewGate.checks.acceptedInvite, true);
    assert.equal(bundleManifest.reviewGate.checks.sipLogHasInvite, false);
    assert.equal(bundleManifest.reviewGate.checks.sipLogHasAcceptedInvite, false);
    assert.match(bundleManifest.reviewGate.failureReasons.sipLogHasInvite, /SIP log does not include an INVITE/);
    assert.match(bundleManifest.reviewGate.failureReasons.sipLogHasAcceptedInvite, /accepted INVITE response/);
    assert.deepEqual(bundleManifest.validationSummary.sipLogEvidence, { entryCount: 0, hasInvite: false, hasAcceptedInviteResponse: false });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live SIP proof bundle accepts newline-delimited SIP and rtc-asr evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-live-sip-ndjson-log-"));
  const audioPath = path.join(tempDir, "caller-capture.wav");
  const sipLogPath = path.join(tempDir, "sip.log.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");
  const manifestPath = path.join(tempDir, "local-sip-live-proof-manifest.json");
  const outDir = path.join(tempDir, "bundle");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(
      rtcAsrEvidencePath,
      [
        JSON.stringify({ type: "transcript.delta", text: "I need" }),
        JSON.stringify({ type: "transcript.final", alternatives: [{ transcript: "billing help." }] }),
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      sipLogPath,
      [
        JSON.stringify({ startLine: "INVITE sip:8600@127.0.0.1 SIP/2.0" }),
        JSON.stringify({ startLine: "SIP/2.0 200 OK" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const manifest = {
      schemaVersion: 1,
      generatedAt: "2026-06-30T10:00:00.000Z",
      workboardCard: "872af947-ef57-47bd-a4f3-3750f54e1948",
      callId: "call-live-sip-1",
      sipCallId: "sip-proof-1",
      runtimeModeLabels: {
        telephony: "local_sip",
        media: "live_capture",
        rtcAsr: "rtc_asr_live",
        credentialsMode: "mocked",
      },
      localSip: {
        bind: "sip:127.0.0.1:5066",
        rtpPort: 40000,
        acceptedInvite: true,
        rtpPacketCount: 4,
      },
      artifacts: { audioWav: audioPath, sipLog: sipLogPath, rtcAsrEvidence: rtcAsrEvidencePath },
      artifactIntegrity: [],
      reviewGate: {
        requiredLabels: ["local_sip", "live_capture", "rtc_asr_live"],
        missingLabels: [],
        nextActions: [],
      },
      reviewReady: true,
      blockers: [],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", manifestPath, "--out-dir", outDir],
      { cwd: repoRoot },
    );

    const summary = JSON.parse(stdout) as { reviewGatePassed: boolean; validationStatus: string };
    assert.equal(summary.reviewGatePassed, true);
    assert.equal(summary.validationStatus, "ready_for_review");

    const bundleManifest = JSON.parse(await readFile(path.join(outDir, "proof-bundle-manifest.json"), "utf8")) as {
      validationSummary: { callerAudioEvidence: { ready: boolean; hasRiffWaveHeader: boolean; hasAudioPayload: boolean; declaredDataBytes: number; sizeBytes: number }; sipLogEvidence: { entryCount: number; hasInvite: boolean; hasAcceptedInviteResponse: boolean }; rtcAsrEvidence: { ready: boolean; transcriptChars: number; eventCount: number } };
    };
    assert.deepEqual(bundleManifest.validationSummary.callerAudioEvidence, { ready: true, hasRiffWaveHeader: true, hasAudioPayload: true, declaredDataBytes: 4, sizeBytes: 48 });
    assert.deepEqual(bundleManifest.validationSummary.sipLogEvidence, { entryCount: 2, hasInvite: true, hasAcceptedInviteResponse: true });
    assert.deepEqual(bundleManifest.validationSummary.rtcAsrEvidence, { required: true, ready: true, transcriptChars: 20, eventCount: 2 });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("live SIP proof bundle reports the specific rtc-asr evidence validation reason", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-live-sip-rtc-asr-reason-"));
  const audioPath = path.join(tempDir, "caller-capture.wav");
  const sipLogPath = path.join(tempDir, "sip.log.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");
  const manifestPath = path.join(tempDir, "local-sip-live-proof-manifest.json");
  const outDir = path.join(tempDir, "bundle");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(sipLogPath, `${JSON.stringify([{ startLine: "INVITE sip:8600@127.0.0.1 SIP/2.0" }, { startLine: "SIP/2.0 200 OK" }])}\n`, "utf8");
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ transcript: "I need billing help.", final: false })}\n`, "utf8");
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-06-30T10:00:00.000Z",
      workboardCard: "872af947-ef57-47bd-a4f3-3750f54e1948",
      callId: "call-live-sip-1",
      sipCallId: "sip-proof-1",
      runtimeModeLabels: {
        telephony: "local_sip",
        media: "live_capture",
        rtcAsr: "rtc_asr_live",
        credentialsMode: "mocked",
      },
      localSip: {
        bind: "sip:127.0.0.1:5066",
        rtpPort: 40000,
        acceptedInvite: true,
        rtpPacketCount: 4,
      },
      artifacts: { audioWav: audioPath, sipLog: sipLogPath, rtcAsrEvidence: rtcAsrEvidencePath },
      artifactIntegrity: [],
      reviewGate: {
        requiredLabels: ["local_sip", "live_capture", "rtc_asr_live"],
        missingLabels: [],
        nextActions: [],
      },
      reviewReady: true,
      blockers: [],
    }, null, 2)}\n`, "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", manifestPath, "--out-dir", outDir],
      { cwd: repoRoot },
    );

    const summary = JSON.parse(stdout) as { reviewGatePassed: boolean; validationStatus: string };
    assert.equal(summary.reviewGatePassed, false);
    assert.equal(summary.validationStatus, "blocked_before_review");

    const bundleManifest = JSON.parse(await readFile(path.join(outDir, "proof-bundle-manifest.json"), "utf8")) as {
      reviewGate: { checks: Record<string, boolean>; failureReasons: Record<string, string> };
      validationSummary: { rtcAsrEvidence: { required: boolean; ready: boolean; reason: string } };
    };
    assert.equal(bundleManifest.reviewGate.checks.rtcAsrEvidenceValid, false);
    assert.match(bundleManifest.reviewGate.failureReasons.rtcAsrEvidenceValid, /missing a final transcript marker/);
    assert.deepEqual(bundleManifest.validationSummary.rtcAsrEvidence, {
      required: true,
      ready: false,
      reason: "rtc-asr transcript evidence is missing a final transcript marker.",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live SIP proof bundle blocks source manifest artifact integrity failures", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-live-sip-source-integrity-"));
  const audioPath = path.join(tempDir, "caller-capture.wav");
  const sipLogPath = path.join(tempDir, "sip.log.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");
  const manifestPath = path.join(tempDir, "local-sip-live-proof-manifest.json");
  const outDir = path.join(tempDir, "bundle");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(sipLogPath, `${JSON.stringify([{ startLine: "INVITE sip:8600@127.0.0.1 SIP/2.0" }, { startLine: "SIP/2.0 200 OK" }])}\n`, "utf8");
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ transcript: "I need billing help.", final: true })}\n`, "utf8");
    const manifest = {
      schemaVersion: 1,
      generatedAt: "2026-06-30T10:00:00.000Z",
      workboardCard: "872af947-ef57-47bd-a4f3-3750f54e1948",
      callId: "call-live-sip-1",
      sipCallId: "sip-proof-1",
      runtimeModeLabels: {
        telephony: "local_sip",
        media: "live_capture",
        rtcAsr: "rtc_asr_live",
        credentialsMode: "mocked",
      },
      localSip: {
        bind: "sip:127.0.0.1:5066",
        rtpPort: 40000,
        acceptedInvite: true,
        rtpPacketCount: 4,
      },
      artifacts: { audioWav: audioPath, sipLog: sipLogPath, rtcAsrEvidence: rtcAsrEvidencePath },
      artifactIntegrity: [
        { artifactId: "freeswitch-caller-capture-wav", path: audioPath, readiness: "ready" },
        { artifactId: "rtc-asr-transcript-evidence", path: rtcAsrEvidencePath, readiness: "blocked" },
      ],
      reviewGate: {
        requiredLabels: ["local_sip", "live_capture", "rtc_asr_live"],
        missingLabels: [],
        nextActions: [],
      },
      reviewReady: true,
      blockers: [],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", manifestPath, "--out-dir", outDir],
      { cwd: repoRoot },
    );

    const summary = JSON.parse(stdout) as { reviewReady: boolean; reviewGatePassed: boolean; validationStatus: string };
    assert.equal(summary.reviewReady, true);
    assert.equal(summary.reviewGatePassed, false);
    assert.equal(summary.validationStatus, "blocked_before_review");

    const bundleManifest = JSON.parse(await readFile(path.join(outDir, "proof-bundle-manifest.json"), "utf8")) as {
      reviewGate: { checks: Record<string, boolean>; failureReasons: Record<string, string> };
      validationSummary: { sourceArtifactIntegrityEvidence: { checked: number; ready: boolean; blocked: Array<{ artifactId: string; readiness: string; path: string }> } };
    };
    assert.equal(bundleManifest.reviewGate.checks.sourceArtifactIntegrityReady, false);
    assert.match(bundleManifest.reviewGate.failureReasons.sourceArtifactIntegrityReady, /blocked, missing, or changed artifacts/);
    assert.deepEqual(bundleManifest.validationSummary.sourceArtifactIntegrityEvidence, {
      checked: 2,
      ready: false,
      blocked: [{ artifactId: "rtc-asr-transcript-evidence", readiness: "blocked", path: rtcAsrEvidencePath }],
      changed: [],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live SIP proof bundle blocks stale source artifact hash and size claims", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-live-sip-stale-integrity-"));
  const audioPath = path.join(tempDir, "caller-capture.wav");
  const sipLogPath = path.join(tempDir, "sip.log.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");
  const manifestPath = path.join(tempDir, "local-sip-live-proof-manifest.json");
  const outDir = path.join(tempDir, "bundle");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(sipLogPath, `${JSON.stringify([{ startLine: "INVITE sip:8600@127.0.0.1 SIP/2.0" }, { startLine: "SIP/2.0 200 OK" }])}\n`, "utf8");
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ transcript: "I need billing help.", final: true })}\n`, "utf8");
    const manifest = {
      schemaVersion: 1,
      generatedAt: "2026-06-30T10:00:00.000Z",
      workboardCard: "872af947-ef57-47bd-a4f3-3750f54e1948",
      callId: "call-live-sip-1",
      sipCallId: "sip-proof-1",
      runtimeModeLabels: {
        telephony: "local_sip",
        media: "live_capture",
        rtcAsr: "rtc_asr_live",
        credentialsMode: "mocked",
      },
      localSip: {
        bind: "sip:127.0.0.1:5066",
        rtpPort: 40000,
        acceptedInvite: true,
        rtpPacketCount: 4,
      },
      artifacts: { audioWav: audioPath, sipLog: sipLogPath, rtcAsrEvidence: rtcAsrEvidencePath },
      artifactIntegrity: [
        { artifactId: "freeswitch-caller-capture-wav", path: audioPath, readiness: "ready", sha256: "0".repeat(64), sizeBytes: 9999 },
      ],
      reviewGate: {
        requiredLabels: ["local_sip", "live_capture", "rtc_asr_live"],
        missingLabels: [],
        nextActions: [],
      },
      reviewReady: true,
      blockers: [],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", manifestPath, "--out-dir", outDir],
      { cwd: repoRoot },
    );

    const summary = JSON.parse(stdout) as { reviewReady: boolean; reviewGatePassed: boolean; validationStatus: string };
    assert.equal(summary.reviewReady, true);
    assert.equal(summary.reviewGatePassed, false);
    assert.equal(summary.validationStatus, "blocked_before_review");

    const bundleManifest = JSON.parse(await readFile(path.join(outDir, "proof-bundle-manifest.json"), "utf8")) as {
      reviewGate: { checks: Record<string, boolean>; failureReasons: Record<string, string> };
      validationSummary: { sourceArtifactIntegrityEvidence: { checked: number; ready: boolean; blocked: unknown[]; changed: Array<{ artifactId: string; path: string; exists: boolean; expectedSha256: string; currentSha256: string; sha256Matches: boolean; expectedSizeBytes: number; currentSizeBytes: number; sizeMatches: boolean }> } };
    };
    assert.equal(bundleManifest.reviewGate.checks.sourceArtifactIntegrityReady, false);
    assert.match(bundleManifest.reviewGate.failureReasons.sourceArtifactIntegrityReady, /changed artifacts/);
    assert.deepEqual(bundleManifest.validationSummary.sourceArtifactIntegrityEvidence.blocked, []);
    assert.equal(bundleManifest.validationSummary.sourceArtifactIntegrityEvidence.checked, 1);
    assert.equal(bundleManifest.validationSummary.sourceArtifactIntegrityEvidence.ready, false);
    assert.equal(bundleManifest.validationSummary.sourceArtifactIntegrityEvidence.changed.length, 1);
    assert.deepEqual(bundleManifest.validationSummary.sourceArtifactIntegrityEvidence.changed[0], {
      artifactId: "freeswitch-caller-capture-wav",
      path: audioPath,
      exists: true,
      expectedSha256: "0".repeat(64),
      currentSha256: bundleManifest.validationSummary.sourceArtifactIntegrityEvidence.changed[0].currentSha256,
      sha256Matches: false,
      expectedSizeBytes: 9999,
      currentSizeBytes: 48,
      sizeMatches: false,
    });
    assert.match(bundleManifest.validationSummary.sourceArtifactIntegrityEvidence.changed[0].currentSha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
