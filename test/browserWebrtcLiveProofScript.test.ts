import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("browser WebRTC live proof gate writes an honest blocked manifest without evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-browser-webrtc-blocked-"));

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/browser-webrtc-live-proof.mjs", "--require-review-ready", "--out-dir", tempDir],
        { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
      ),
      (error: any) => {
        assert.equal(error.code, 2);
        const summary = JSON.parse(error.stdout.slice(error.stdout.indexOf("{")).trim()) as { reviewReady: boolean; blockers: string[] };
        assert.equal(summary.reviewReady, false);
        assert.ok(summary.blockers.some((blocker) => blocker.includes("evidence file is not attached")));
        assert.ok(summary.blockers.some((blocker) => blocker.includes("rtcAsrFinalTranscript")));
        return true;
      },
    );

    const manifest = JSON.parse(await readFile(path.join(tempDir, "browser-webrtc-live-proof-manifest.json"), "utf8")) as {
      reviewReady: boolean;
      runtimeModeLabels: { browserTransport: string; pipecat: string; rtcAsr: string; tts: string; browserPlayback: string };
      checks: Record<string, boolean>;
      setup: { commands: string[]; evidenceTemplateCommand: string; pipecatWebrtcBridgeUrl: string; rtcAsrWsUrl: string; kokoroBaseUrl: string };
      reviewGate: { missingProof: string[]; nextActions: string[] };
    };
    assert.equal(manifest.reviewReady, false);
    assert.deepEqual(manifest.runtimeModeLabels, {
      browserTransport: "webrtc",
      pipecat: "pipecat_webrtc_unproven",
      rtcAsr: "rtc_asr_unproven",
      tts: "kokoro_unproven",
      browserPlayback: "remote_audio_unproven",
    });
    assert.deepEqual(manifest.checks, {
      pipecatWebrtcBridge: false,
      rtcAsrFinalTranscript: false,
      kokoroAudio: false,
      browserRemoteAudio: false,
    });
    assert.deepEqual(manifest.reviewGate.missingProof, [
      "pipecatWebrtcBridge",
      "rtcAsrFinalTranscript",
      "kokoroAudio",
      "browserRemoteAudio",
    ]);
    assert.equal(manifest.setup.pipecatWebrtcBridgeUrl, "http://127.0.0.1:8766");
    assert.equal(manifest.setup.rtcAsrWsUrl, "ws://127.0.0.1:8080/v1/stt/stream");
    assert.ok(manifest.setup.commands.some((command) => command.includes("browser-webrtc:check")));
    assert.ok(manifest.setup.commands.some((command) => command.includes("browser-webrtc:live-proof")));
    assert.match(manifest.setup.evidenceTemplateCommand, /--write-template/);
    assert.ok(manifest.reviewGate.nextActions.some((action) => action.includes("evidence template")));
    assert.ok(manifest.reviewGate.nextActions.some((action) => action.includes("browser-webrtc:live-proof")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser WebRTC live proof gate accepts captured media-turn evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-browser-webrtc-ready-"));
  const evidencePath = path.join(tempDir, "browser-webrtc-evidence.json");

  try {
    await writeFile(
      evidencePath,
      JSON.stringify({
        events: [
          { type: "pipecat.webrtc.offer_answer", transport: "webrtc", bridge: "pipecat", sessionId: "browser-webrtc-session-123" },
          { type: "rtc-asr.transcript.final", engine: "rtc-asr", transcript: "I need billing help.", final: true },
          { type: "kokoro.tts.audio", engine: "kokoro", audioBytes: 4096 },
          { type: "browser.remote.audio.played", target: "browser", track: "remote audio", playedMs: 1200 },
        ],
      }, null, 2),
      "utf8",
    );

    const result = await execFileAsync(
      process.execPath,
      ["scripts/browser-webrtc-live-proof.mjs", "--require-review-ready", "--evidence", evidencePath, "--out-dir", tempDir],
      { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
    );
    const summary = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")).trim()) as { reviewReady: boolean; blockers: string[] };
    assert.equal(summary.reviewReady, true);
    assert.deepEqual(summary.blockers, []);

    const manifest = JSON.parse(await readFile(path.join(tempDir, "browser-webrtc-live-proof-manifest.json"), "utf8")) as {
      reviewReady: boolean;
      runtimeModeLabels: { pipecat: string; rtcAsr: string; tts: string; browserPlayback: string };
      artifactIntegrity: Array<{ artifactId: string; readiness: string; sizeBytes: number }>;
      setup: { commands: string[] };
      reviewGate: { missingProof: string[] };
    };
    assert.equal(manifest.reviewReady, true);
    assert.equal(manifest.runtimeModeLabels.pipecat, "pipecat_webrtc_live");
    assert.equal(manifest.runtimeModeLabels.rtcAsr, "rtc_asr_live");
    assert.equal(manifest.runtimeModeLabels.tts, "kokoro_live");
    assert.equal(manifest.runtimeModeLabels.browserPlayback, "remote_audio_live");
    assert.deepEqual(manifest.reviewGate.missingProof, []);
    assert.ok(manifest.setup.commands.some((command) => command.includes("pipecat:voice:check")));
    assert.ok(manifest.artifactIntegrity.some((artifact) => artifact.artifactId === "browser-webrtc-live-evidence" && artifact.readiness === "ready" && artifact.sizeBytes > 0));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("browser WebRTC live proof gate writes a fill-in evidence template", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-browser-webrtc-template-"));
  const templatePath = path.join(tempDir, "proof.template.json");

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/browser-webrtc-live-proof.mjs", "--require-review-ready", "--write-template", templatePath, "--out-dir", tempDir],
        { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
      ),
      (error: any) => {
        assert.equal(error.code, 2);
        return true;
      },
    );

    const template = JSON.parse(await readFile(templatePath, "utf8")) as { events: Array<Record<string, unknown>> };
    assert.equal(template.events.length, 4);
    assert.ok(template.events.some((event) => event.type === "pipecat.webrtc.offer_answer"));
    assert.ok(template.events.some((event) => event.type === "rtc-asr.transcript.final" && event.final === true));
    assert.ok(template.events.some((event) => event.type === "kokoro.tts.audio"));
    assert.ok(template.events.some((event) => event.type === "browser.remote.audio.played"));

    const manifest = JSON.parse(await readFile(path.join(tempDir, "browser-webrtc-live-proof-manifest.json"), "utf8")) as { setup: { evidenceTemplatePath: string } };
    assert.equal(manifest.setup.evidenceTemplatePath, templatePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("browser WebRTC live proof gate rejects the unfilled template as evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-browser-webrtc-template-evidence-"));
  const templatePath = path.join(tempDir, "proof.template.json");

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/browser-webrtc-live-proof.mjs", "--require-review-ready", "--write-template", templatePath, "--out-dir", tempDir],
        { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
      ),
      (error: any) => {
        assert.equal(error.code, 2);
        return true;
      },
    );

    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/browser-webrtc-live-proof.mjs", "--require-review-ready", "--evidence", templatePath, "--out-dir", tempDir],
        { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
      ),
      (error: any) => {
        assert.equal(error.code, 2);
        const summary = JSON.parse(error.stdout.slice(error.stdout.indexOf("{")).trim()) as { reviewReady: boolean; blockers: string[] };
        assert.equal(summary.reviewReady, false);
        assert.ok(summary.blockers.some((blocker) => blocker.includes("pipecatWebrtcBridge")));
        assert.ok(summary.blockers.some((blocker) => blocker.includes("rtcAsrFinalTranscript")));
        assert.ok(summary.blockers.some((blocker) => blocker.includes("kokoroAudio")));
        assert.ok(summary.blockers.some((blocker) => blocker.includes("browserRemoteAudio")));
        return true;
      },
    );

    const manifest = JSON.parse(await readFile(path.join(tempDir, "browser-webrtc-live-proof-manifest.json"), "utf8")) as {
      reviewReady: boolean;
      checks: Record<string, boolean>;
      reviewGate: { missingProof: string[] };
    };
    assert.equal(manifest.reviewReady, false);
    assert.deepEqual(manifest.checks, {
      pipecatWebrtcBridge: false,
      rtcAsrFinalTranscript: false,
      kokoroAudio: false,
      browserRemoteAudio: false,
    });
    assert.deepEqual(manifest.reviewGate.missingProof, [
      "pipecatWebrtcBridge",
      "rtcAsrFinalTranscript",
      "kokoroAudio",
      "browserRemoteAudio",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
