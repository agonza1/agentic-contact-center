import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function validWavFixture(packetCount = 4) {
  const payloadBytes = packetCount * 320;
  const buffer = Buffer.alloc(44 + payloadBytes, 1);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + payloadBytes, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(payloadBytes, 40);
  return buffer;
}


test("FreeSWITCH ESL frames keep content-length event bodies attached", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const script = `
    const { nextEslFrame } = await import(${JSON.stringify(moduleUrl)});
    const body = ["Event-Name: CHANNEL_ANSWER", "Unique-ID: fs-call-123", "Caller-Destination-Number: 8600", ""].join("\\n");
    const raw = ["Content-Type: text/event-plain", "Content-Length: " + Buffer.byteLength(body), "", body + "Content-Type: command/reply", "Reply-Text: +OK", "", ""].join("\\n");
    const first = nextEslFrame(raw);
    const second = nextEslFrame(first.rest);
    console.log(JSON.stringify({ first, second }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const parsed = JSON.parse(stdout) as {
    first: { block: string; rest: string };
    second: { block: string; rest: string };
  };
  assert.match(parsed.first.block, /Content-Type: text\/event-plain/);
  assert.match(parsed.first.block, /Event-Name: CHANNEL_ANSWER/);
  assert.match(parsed.first.block, /Unique-ID: fs-call-123/);
  assert.match(parsed.second.block, /Content-Type: command\/reply/);
  assert.equal(parsed.second.rest, "");
});

test("FreeSWITCH ESL frame parser waits for a complete CRLF content-length body", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const script = `
    const { nextEslFrame } = await import(${JSON.stringify(moduleUrl)});
    const body = ["Event-Name: RECORD_STOP", "Unique-ID: fs-call-456", "Record-File-Path: /var/log/freeswitch/acc/fs-call-456.wav", ""].join("\\r\\n");
    const header = ["Content-Type: text/event-plain", "Content-Length: " + Buffer.byteLength(body), "", ""].join("\\r\\n");
    const partial = nextEslFrame(header + body.slice(0, -5));
    const complete = nextEslFrame(header + body);
    console.log(JSON.stringify({ partial, complete }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const parsed = JSON.parse(stdout) as {
    partial: null;
    complete: { block: string; rest: string };
  };
  assert.equal(parsed.partial, null);
  assert.match(parsed.complete.block, /Event-Name: RECORD_STOP/);
  assert.match(parsed.complete.block, /Record-File-Path: \/var\/log\/freeswitch\/acc\/fs-call-456\.wav/);
  assert.equal(parsed.complete.rest, "");
});

test("FreeSWITCH ESL parser keeps malformed percent header values", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const script = `
    const { EslBridge } = await import(${JSON.stringify(moduleUrl)});
    const bridge = new EslBridge({});
    await bridge.handleBlock([
      "Content-Type: text/event-plain",
      "Event-Name: CHANNEL_ANSWER",
      "Caller-Caller-ID-Name: 100%+Ready",
      ""
    ].join("\\n"));
    console.log(JSON.stringify(bridge.events[0].headers));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const headers = JSON.parse(stdout) as { "Caller-Caller-ID-Name": string };
  assert.equal(headers["Caller-Caller-ID-Name"], "100%+Ready");
});

test("FreeSWITCH recording path maps host artifacts to a container-visible mount", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const script = `
    const { visibleRecordingPath } = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify(visibleRecordingPath("/workspace/repo/artifacts/freeswitch-live/media", "/var/log/freeswitch/acc", "fs-call-123")));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const paths = JSON.parse(stdout) as { hostPath: string; freeswitchPath: string };
  assert.equal(paths.hostPath, "/workspace/repo/artifacts/freeswitch-live/media/fs-call-123.wav");
  assert.equal(paths.freeswitchPath, "/var/log/freeswitch/acc/fs-call-123.wav");
});

test("FreeSWITCH bridge manifest is bundle-compatible and blocks missing rtc-asr evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-bridge-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(logPath, `${JSON.stringify({ events: [{ headers: { "Event-Name": "CHANNEL_ANSWER" } }] })}\n`, "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-1",
        accCallId: "demo-call-0001",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        freeswitchRecordingPath: "/var/log/freeswitch/acc/media/fs-proof-1.wav",
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
      localSip: { acceptedInvite: boolean; rtpPacketCount: number; destination: string; hostRecordingPath: string; freeswitchRecordingPath: string };
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
    assert.equal(manifest.localSip.hostRecordingPath, audioPath);
    assert.equal(manifest.localSip.freeswitchRecordingPath, "/var/log/freeswitch/acc/media/fs-proof-1.wav");
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
      reviewGate: { failureReasons: Record<string, string> };
      validationSummary: { blockers: string[]; nextActions: string[] };
    };
    assert.equal(bundleManifest.artifacts.audioCapture, path.relative(repoRoot, audioPath).replaceAll(path.sep, "/"));
    assert.equal(bundleManifest.artifacts.sipLogs, path.relative(repoRoot, logPath).replaceAll(path.sep, "/"));
    assert.equal(bundleManifest.artifacts.rtcAsrEvidence, null);
    assert.ok(bundleManifest.validationSummary.blockers.some((blocker) => blocker.includes("no transcript/evidence path")));
    assert.match(bundleManifest.reviewGate.failureReasons.sourceManifestReviewReady, /Source live proof manifest is not review-ready/);
    assert.deepEqual(bundleManifest.validationSummary.nextActions, [
      "Attach rtc-asr transcript evidence with --rtc-asr-evidence before marking the FreeSWITCH proof review-ready.",
    ]);

    const invalidRtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence-empty.json");
    await writeFile(invalidRtcAsrEvidencePath, `${JSON.stringify({ transcript: "   ", final: true })}\n`, "utf8");
    const invalidEvidenceScript = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-invalid-evidence",
        accCallId: "demo-call-invalid-evidence",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(invalidRtcAsrEvidencePath)},
        telephonyMode: "local_sip"
      });
      console.log(JSON.stringify(manifest));
    `;
    const invalidEvidenceResult = await execFileAsync(process.execPath, ["--input-type=module", "--eval", invalidEvidenceScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const invalidEvidenceManifest = JSON.parse(invalidEvidenceResult.stdout) as typeof manifest;
    assert.equal(invalidEvidenceManifest.reviewReady, false);
    assert.ok(invalidEvidenceManifest.blockers.some((blocker) => blocker.includes("non-empty transcript")));
    assert.ok(invalidEvidenceManifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "blocked"));

    const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ transcript: { text: "hello from local sip", final: true } })}\n`, "utf8");
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
    const readyBundleSummary = JSON.parse(readyBundle.stdout) as { reviewGateReportJson: string; reviewGatePassed: boolean; validationStatus: string };
    assert.equal(readyBundleSummary.reviewGatePassed, true);
    assert.equal(readyBundleSummary.validationStatus, "ready_for_review");
    const readyBundleManifest = JSON.parse(await readFile(path.join(readyBundleDir, "proof-bundle-manifest.json"), "utf8")) as {
      artifacts: { rtcAsrEvidence: string | null };
      artifactIntegrity: Array<{ artifactId: string; readiness: string }>;
    };
    assert.equal(readyBundleManifest.artifacts.rtcAsrEvidence, path.relative(repoRoot, rtcAsrEvidencePath).replaceAll(path.sep, "/"));
    assert.ok(readyBundleManifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "ready"));
    assert.match(readyBundleSummary.reviewGateReportJson, /review-gate-report\.json$/);
    const readyReviewGateReport = JSON.parse(await readFile(path.join(readyBundleDir, "review-gate-report.json"), "utf8")) as {
      status: string;
      reviewGatePassed: boolean;
      missingLabels: string[];
      failureReasons: Record<string, string>;
      nextActions: string[];
    };
    assert.equal(readyReviewGateReport.status, "ready_for_review");
    assert.equal(readyReviewGateReport.reviewGatePassed, true);
    assert.deepEqual(readyReviewGateReport.missingLabels, []);
    assert.deepEqual(readyReviewGateReport.failureReasons, {});
    assert.deepEqual(readyReviewGateReport.nextActions, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("FreeSWITCH bridge forwards attached rtc-asr evidence to ACC", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-forward-rtc-asr-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");
  const manifestPath = path.join(tempDir, "freeswitch-live-proof-manifest.json");
  const receivedEvents: any[] = [];

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const http = require("node:http") as typeof import("node:http");
    const instance = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        receivedEvents.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, call: { session: { callId: "acc-call-123" } } }));
      });
    });
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ type: "response.audio_transcript.done", transcript: "I need billing help." })}\n`, "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { EslBridge } = await import(${JSON.stringify(moduleUrl)});
      const bridge = new EslBridge({
        accBaseUrl: ${JSON.stringify(`http://127.0.0.1:${(server.address() as any).port}`)},
        logPath: ${JSON.stringify(logPath)},
        manifestPath: ${JSON.stringify(manifestPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
        telephonyMode: "local_sip"
      });
      bridge.events = [{ at: "2026-06-30T10:00:00.000Z", headers: { "Event-Name": "CHANNEL_ANSWER" } }];
      bridge.callMap.set("fs-call-forward", {
        wavPath: ${JSON.stringify(audioPath)},
        freeswitchPath: ${JSON.stringify(audioPath)},
        startedAt: Date.now(),
        destination: "8600",
        accCallId: "acc-call-123"
      });
      await bridge.onRecordStop("fs-call-forward");
    `;
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    assert.equal(receivedEvents.some((event) => event.eventType === "media.capture"), true);
    const transcriptEvent = receivedEvents.find((event) => event.eventType === "media.transcript");
    assert.equal(transcriptEvent?.text, "I need billing help.");
    assert.equal(transcriptEvent?.rtcAsrEvidencePath, rtcAsrEvidencePath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { reviewReady: boolean };
    assert.equal(manifest.reviewReady, true);
  } finally {
    server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("FreeSWITCH bridge manifest accepts nested OpenAI realtime transcript evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-openai-realtime-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(logPath, `${JSON.stringify({ events: [{ headers: { "Event-Name": "CHANNEL_ANSWER" } }] })}\n`, "utf8");
    await writeFile(
      rtcAsrEvidencePath,
      `${JSON.stringify({
        type: "response.audio_transcript.done",
        delta: "hello from",
        response: {
          output: [
            { content: [{ type: "output_text", delta: "local sip" }] },
          ],
        },
      })}\n`,
      "utf8",
    );

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-openai-realtime",
        accCallId: "demo-call-openai-realtime",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
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
      artifactIntegrity: Array<{ artifactId: string; readiness: string }>;
      blockers: string[];
    };
    assert.equal(manifest.reviewReady, true);
    assert.deepEqual(manifest.blockers, []);
    assert.ok(manifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "ready"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("FreeSWITCH bridge manifest accepts wrapped channel ASR evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-channel-asr-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(logPath, JSON.stringify({ events: [{ headers: { "Event-Name": "CHANNEL_ANSWER" } }] }) + "\n", "utf8");
    await writeFile(rtcAsrEvidencePath, JSON.stringify({
      type: "Results",
      is_final: "true",
      results: { channels: [{ alternatives: [{ transcript: "hello from local sip" }] }] },
    }) + "\n", "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-channel-asr",
        accCallId: "demo-call-channel-asr",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
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
      artifactIntegrity: Array<{ artifactId: string; readiness: string }>;
      blockers: string[];
    };
    assert.equal(manifest.reviewReady, true);
    assert.deepEqual(manifest.blockers, []);
    assert.ok(manifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "ready"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
