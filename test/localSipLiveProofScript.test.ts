import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("local SIP review gate blocks rtc-asr live mode without attached evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-local-sip-rtc-asr-"));
  const portBase = 48000 + Math.floor(Math.random() * 1000) * 4;

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
          "--rtc-asr-url",
          "ws://127.0.0.1:8080/v1/stt/stream",
          "--out-dir",
          tempDir,
        ],
        { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
      ),
      (error: any) => {
        assert.equal(error.code, 2);
        const summary = JSON.parse(error.stdout.slice(error.stdout.indexOf("{")).trim()) as { reviewReady: boolean; blockers: string[] };
        assert.equal(summary.reviewReady, false);
        assert.ok(summary.blockers.some((blocker) => blocker.includes("no transcript/evidence path")));
        return true;
      },
    );

    const manifest = JSON.parse(await readFile(path.join(tempDir, "local-sip-live-proof-manifest.json"), "utf8")) as {
      reviewReady: boolean;
      runtimeModeLabels: { media: string; rtcAsr: string };
      artifacts: { rtcAsrEvidence: string | null };
      artifactIntegrity: Array<{ artifactId: string }>;
      reviewGate: { missingLabels: string[]; nextActions: string[] };
    };
    assert.equal(manifest.reviewReady, false);
    assert.equal(manifest.runtimeModeLabels.rtcAsr, "rtc_asr_live");
    assert.equal(manifest.artifacts.rtcAsrEvidence, null);
    assert.ok(!manifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence"));
    assert.deepEqual(manifest.reviewGate.missingLabels, ["live_capture"]);
    assert.ok(manifest.reviewGate.nextActions.some((action) => action.includes("--rtc-asr-evidence")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("local SIP review gate accepts OpenAI realtime transcript evidence shapes", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-local-sip-openai-evidence-"));
  const evidencePath = path.join(tempDir, "rtc-asr-evidence.jsonl");
  const portBase = 49000 + Math.floor(Math.random() * 1000) * 4;

  try {
    await writeFile(
      evidencePath,
      [
        JSON.stringify({ type: "response.audio_transcript.delta", delta: "I need" }),
        JSON.stringify({ type: "response.audio_transcript.delta", item: { content: [{ delta: "billing help." }] } }),
        JSON.stringify({ type: "response.audio_transcript.done" }),
      ].join("\n") + "\n",
      "utf8",
    );

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
          "--rtc-asr-url",
          "ws://127.0.0.1:8080/v1/stt/stream",
          "--rtc-asr-evidence",
          evidencePath,
          "--out-dir",
          tempDir,
        ],
        { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
      ),
      (error: any) => {
        assert.equal(error.code, 2);
        const summary = JSON.parse(error.stdout.slice(error.stdout.indexOf("{")).trim()) as { reviewReady: boolean; blockers: string[] };
        assert.equal(summary.reviewReady, false);
        assert.ok(!summary.blockers.some((blocker) => blocker.includes("rtc-asr transcript/evidence")));
        assert.ok(summary.blockers.some((blocker) => blocker.includes("Self-test generated RTP audio")));
        return true;
      },
    );

    const manifest = JSON.parse(await readFile(path.join(tempDir, "local-sip-live-proof-manifest.json"), "utf8")) as {
      reviewReady: boolean;
      runtimeModeLabels: { media: string; rtcAsr: string };
      artifactIntegrity: Array<{ artifactId: string; readiness: string; sizeBytes: number }>;
      reviewGate: { missingLabels: string[]; nextActions: string[] };
      blockers: string[];
    };
    assert.equal(manifest.reviewReady, false);
    assert.equal(manifest.runtimeModeLabels.rtcAsr, "rtc_asr_live");
    assert.deepEqual(manifest.reviewGate.missingLabels, ["live_capture"]);
    assert.ok(manifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "ready" && artifact.sizeBytes > 0));
    assert.ok(!manifest.reviewGate.nextActions.some((action) => action.includes("--rtc-asr-evidence")));
    assert.ok(!manifest.blockers.some((blocker) => blocker.includes("rtc-asr transcript/evidence")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("local SIP manifest carries caller playback proof evidence when attached", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-local-sip-playback-evidence-"));
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");
  const callerPlaybackEvidencePath = path.join(tempDir, "caller-playback-proof.json");
  const portBase = 50500 + Math.floor(Math.random() * 1000) * 4;

  try {
    await writeFile(rtcAsrEvidencePath, JSON.stringify({ transcript: "I need billing help.", final: true }) + "\n", "utf8");
    await writeFile(callerPlaybackEvidencePath, JSON.stringify({ liveProof: { playback: { status: "caller_playback_confirmed" } } }) + "\n", "utf8");

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
          "--rtc-asr-url",
          "ws://127.0.0.1:8080/v1/stt/stream",
          "--rtc-asr-evidence",
          rtcAsrEvidencePath,
          "--caller-playback-evidence",
          callerPlaybackEvidencePath,
          "--out-dir",
          tempDir,
        ],
        { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
      ),
      (error: any) => {
        assert.equal(error.code, 2);
        const summary = JSON.parse(error.stdout.slice(error.stdout.indexOf("{")).trim()) as { blockers: string[] };
        assert.ok(!summary.blockers.some((blocker) => blocker.includes("Caller-audible playback proof")));
        assert.ok(summary.blockers.some((blocker) => blocker.includes("Self-test generated RTP audio")));
        return true;
      },
    );

    const manifest = JSON.parse(await readFile(path.join(tempDir, "local-sip-live-proof-manifest.json"), "utf8")) as {
      artifacts: { callerPlaybackEvidence: string | null };
      artifactIntegrity: Array<{ artifactId: string; readiness: string; sizeBytes: number }>;
      reviewGate: { missingLabels: string[]; nextActions: string[] };
    };
    assert.equal(manifest.artifacts.callerPlaybackEvidence, callerPlaybackEvidencePath);
    assert.ok(manifest.artifactIntegrity.some((artifact) => artifact.artifactId === "caller-audible-playback-proof" && artifact.readiness === "ready" && artifact.sizeBytes > 0));
    assert.deepEqual(manifest.reviewGate.missingLabels, ["live_capture"]);
    assert.ok(!manifest.reviewGate.nextActions.some((action) => action.includes("caller-audible playback proof")));
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
        assert.ok(summary.blockers.some((blocker) => blocker.includes("No SIP INVITE was accepted")));
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
      `Verify the softphone or FreeSWITCH route is sending INVITE traffic to sip:8600@127.0.0.1:${portBase}.`,
      "Start rtc-asr, set RTC_ASR_WS_URL, and rerun the live proof to capture a websocket-backed transcript.",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("local SIP review gate accepts wrapped rtc-asr evidence payloads", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-local-sip-wrapped-evidence-"));
  const evidencePath = path.join(tempDir, "rtc-asr-evidence.jsonl");
  const portBase = 50000 + Math.floor(Math.random() * 1000) * 4;

  try {
    await writeFile(
      evidencePath,
      [
        JSON.stringify({ payload: { type: "response.audio_transcript.delta", delta: "I need billing" } }),
        JSON.stringify({ data: JSON.stringify({ type: "response.audio_transcript.done", transcript: " help." }) }),
      ].join("\n") + "\n",
      "utf8",
    );

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
          "--rtc-asr-url",
          "ws://127.0.0.1:8080/v1/stt/stream",
          "--rtc-asr-evidence",
          evidencePath,
          "--out-dir",
          tempDir,
        ],
        { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
      ),
      (error: any) => {
        assert.equal(error.code, 2);
        const summary = JSON.parse(error.stdout.slice(error.stdout.indexOf("{")).trim()) as { blockers: string[] };
        assert.ok(!summary.blockers.some((blocker) => blocker.includes("rtc-asr transcript/evidence")));
        return true;
      },
    );

    const manifest = JSON.parse(await readFile(path.join(tempDir, "local-sip-live-proof-manifest.json"), "utf8")) as {
      artifactIntegrity: Array<{ artifactId: string; readiness: string }>;
      reviewGate: { missingLabels: string[]; nextActions: string[] };
    };
    assert.ok(manifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "ready"));
    assert.deepEqual(manifest.reviewGate.missingLabels, ["live_capture"]);
    assert.ok(!manifest.reviewGate.nextActions.some((action) => action.includes("--rtc-asr-evidence")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
