import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

const voiceAudioFixtures = JSON.parse(readFileSync("test/fixtures/voice-session-audio-fixtures.json", "utf8")) as {
  fixtures: Record<string, { mimeType: string; sampleRateHz: number; audioData: string }>;
};

function requestJson(port: number, method: string, route: string, body?: unknown): Promise<{ statusCode: number; payload: any }> {
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        headers: rawBody ? { "content-type": "application/json", "content-length": Buffer.byteLength(rawBody) } : undefined,
      },
      (response) => {
        let collected = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { collected += chunk; });
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, payload: collected ? JSON.parse(collected) : null }));
      },
    );
    req.on("error", reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}


function encodeClientWebSocketFrame(payload: Buffer, opcode: number, fin: boolean): Buffer {
  const mask = randomBytes(4);
  const length = payload.byteLength;
  const first = (fin ? 0x80 : 0) | opcode;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([first, 0x80 | length]);
  } else if (length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = first;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = first;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.byteLength; index += 1) {
    masked[index] = masked[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function writeFragmentedWebSocketAudio(port: number, sessionId: string, chunks: Buffer[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let handshake = "";
    let upgraded = false;
    socket.setTimeout(2000);
    socket.on("error", reject);
    socket.on("timeout", () => reject(new Error("websocket timeout")));
    socket.on("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET /api/voice/sessions/${encodeURIComponent(sessionId)}/media/input HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n" +
          "\r\n",
      );
    });
    socket.on("data", (data) => {
      if (upgraded) return;
      handshake += data.toString("latin1");
      if (!handshake.includes("\r\n\r\n")) return;
      if (!handshake.startsWith("HTTP/1.1 101")) {
        reject(new Error(`websocket upgrade failed: ${handshake.split("\r\n")[0]}`));
        socket.destroy();
        return;
      }
      upgraded = true;
      chunks.forEach((chunk, index) => {
        socket.write(encodeClientWebSocketFrame(chunk, index === 0 ? 0x2 : 0x0, index === chunks.length - 1));
      });
      setTimeout(() => {
        socket.end(encodeClientWebSocketFrame(Buffer.alloc(0), 0x8, true));
        resolve();
      }, 50);
    });
  });
}

function requestRaw(port: number, method: string, route: string, body: Buffer, headers: Record<string, string> = {}): Promise<{ statusCode: number; payload: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        headers: { ...headers, "content-length": body.byteLength },
      },
      (response) => {
        let collected = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { collected += chunk; });
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, payload: collected ? JSON.parse(collected) : null }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

test("voice sessions expose persistent CAE realtime-audio lifecycle and proof", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const created = await requestJson(address.port, "POST", "/api/voice/sessions", {
      sessionId: "cae-session-1",
      target: "conversation-agent-evals",
      metadata: { suiteRunId: "suite-123", fixtureId: "caller-billing-1" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.payload.ok, true);
    assert.equal(created.payload.session.id, "cae-session-1");
    assert.equal(created.payload.session.status, "open");
    assert.equal(created.payload.session.mode, "realtime_audio");
    assert.equal(created.payload.contract.transcriptShortcutAllowed, false);
    assert.equal(created.payload.endpoints.mediaInput, "/api/voice/sessions/cae-session-1/media/input");
    assert.equal(created.payload.endpoints.mediaOutput, "/api/voice/sessions/cae-session-1/media/output");
    const snapshot = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-1");
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.payload.route, "/api/voice/sessions/:id");
    assert.equal(snapshot.payload.session.id, "cae-session-1");
    assert.equal(snapshot.payload.session.endpoints.snapshot, "/api/voice/sessions/cae-session-1");
    assert.equal(snapshot.payload.session.endpoints.proof, "/api/voice/sessions/cae-session-1/proof");


    const playFixture = voiceAudioFixtures.fixtures["caller-billing-short"];
    const play = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-1/play", {
      callerActId: "act-1",
      assetName: "caller-billing-short",
      audioData: playFixture.audioData,
      mimeType: playFixture.mimeType,
      sampleRateHz: playFixture.sampleRateHz,
    });
    assert.equal(play.statusCode, 202);
    assert.equal(play.payload.session.playback.requestedTurns, 1);
    assert.equal(play.payload.injectedAudio.assetName, "caller-billing-short");
    assert.equal(play.payload.injectedAudio.path, "voice_session_media_input");
    assert.equal(play.payload.session.playback.lastAudioAssetName, "caller-billing-short");
    assert.equal(play.payload.session.media.inputChunks, 1);
    assert.equal(play.payload.session.events.at(-2).type, "play.requested");
    assert.equal(play.payload.session.events.at(-2).detail.expectedTranscriptAccepted, false);
    assert.equal(play.payload.session.events.at(-2).detail.injectedToMediaInput, true);
    assert.equal(play.payload.session.events.at(-1).type, "media.input.received");
    assert.equal(play.payload.session.events.at(-1).detail.source, "play");

    const media = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-1/media/input", Buffer.from([9, 8, 7, 6, 5]), {
      "content-type": "audio/l16",
      "x-sample-rate-hz": "16000",
    });
    assert.equal(media.statusCode, 202);
    assert.equal(media.payload.session.media.inputChunks, 2);
    assert.equal(media.payload.session.media.inputBytes, Buffer.from(playFixture.audioData, "base64").byteLength + 5);
    assert.equal(media.payload.session.media.inputSampleRateHz, 16000);

    const output = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-1/media/output", Buffer.from([10, 11, 12, 13, 14, 15]), {
      "content-type": "audio/wav",
      "x-sample-rate-hz": "24000",
      "x-output-stream-id": "tts-turn-1",
    });
    assert.equal(output.statusCode, 202);
    assert.equal(output.payload.session.output.status, "streaming");
    assert.equal(output.payload.session.output.chunks, 1);
    assert.equal(output.payload.session.output.bytes, 6);
    assert.equal(output.payload.session.output.totalChunks, 1);
    assert.equal(output.payload.session.output.totalBytes, 6);

    const control = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-1/control", { action: "barge_in", reason: "tester interruption" });
    assert.equal(control.statusCode, 200);
    assert.equal(control.payload.session.controls.lastAction, "barge_in");
    assert.equal(control.payload.session.output.status, "cancelled");
    assert.equal(control.payload.session.output.cancellationReason, "tester interruption");

    const lateOutput = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-1/media/output", Buffer.from([16, 17, 18]), {
      "content-type": "audio/wav",
      "x-output-stream-id": "tts-turn-1",
    });
    assert.equal(lateOutput.statusCode, 202);
    assert.equal(lateOutput.payload.session.output.status, "cancelled");
    assert.equal(lateOutput.payload.session.output.chunks, 1);
    assert.equal(lateOutput.payload.session.output.bytes, 6);

    const events = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-1/events?afterSequence=1");
    assert.equal(events.statusCode, 200);
    assert.deepEqual(events.payload.events.map((event: any) => event.type), [
      "play.requested",
      "media.input.received",
      "media.input.received",
      "output.stream.started",
      "output.audio.chunk",
      "control.received",
      "output.stream.cancelled",
      "output.audio.chunk.ignored",
    ]);

    const laterControl = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-1/control", { action: "mark", reason: "post barge-in note" });
    assert.equal(laterControl.statusCode, 200);
    assert.equal(laterControl.payload.session.controls.lastAction, "mark");

    const followUpOutput = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-1/media/output", Buffer.from([21, 22]), {
      "content-type": "audio/wav",
      "x-output-stream-id": "tts-turn-2",
      "x-output-final": "true",
    });
    assert.equal(followUpOutput.statusCode, 202);
    assert.equal(followUpOutput.payload.session.output.status, "completed");
    assert.equal(followUpOutput.payload.session.output.chunks, 1);
    assert.equal(followUpOutput.payload.session.output.bytes, 2);
    assert.equal(followUpOutput.payload.session.output.totalChunks, 2);
    assert.equal(followUpOutput.payload.session.output.totalBytes, 8);

    const proof = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-1/proof");
    assert.equal(proof.statusCode, 200);
    assert.equal(proof.payload.mediaPipeline.persistent, true);
    assert.equal(proof.payload.mediaPipeline.fullDuplex, true);
    assert.equal(proof.payload.mediaPipeline.transcriptShortcutAllowed, false);
    assert.equal(proof.payload.evidence.hasAudioInput, true);
    assert.equal(proof.payload.evidence.hasOutputAudio, true);
    assert.equal(proof.payload.evidence.outputStatus, "completed");
    assert.equal(proof.payload.evidence.outputChunks, 1);
    assert.equal(proof.payload.evidence.outputBytes, 2);
    assert.equal(proof.payload.evidence.totalOutputChunks, 2);
    assert.equal(proof.payload.evidence.totalOutputBytes, 8);
    assert.equal(proof.payload.evidence.outputCancelledByBargeIn, true);
    assert.equal(proof.payload.evidence.hasRtcAsrFinalTranscript, false);
    assert.deepEqual(proof.payload.review.blockers, ["rtc_asr_final_transcript_missing"]);

    const closed = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-1/close");
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.payload.session.status, "closed");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("voice session proof exposes session-wide correlation timeline and metrics", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      sipCallId: "correlation-proof-call",
      timestamp: "2026-01-01T00:00:00.000Z",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    const callId = started.payload.call.session.callId;

    const oldTranscript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      sipCallId: "correlation-proof-call",
      timestamp: "2026-01-01T00:00:01.000Z",
      text: "old transcript before the correlated voice session",
    });
    assert.equal(oldTranscript.statusCode, 200);

    const created = await requestJson(address.port, "POST", "/api/voice/sessions", {
      sessionId: "cae-session-correlation",
      callId,
      metadata: {
        correlationId: "qa-correlation-001",
        mixedRecordingPath: "artifacts/qa-correlation-001-mixed.wav",
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.payload.session.correlationId, "qa-correlation-001");
    assert.equal(created.payload.session.events[0].correlationId, "qa-correlation-001");
    assert.equal(created.payload.session.events[0].detail.correlationId, "qa-correlation-001");

    const concurrent = await requestJson(address.port, "POST", "/api/voice/sessions", {
      sessionId: "cae-session-correlation-other",
      metadata: { correlationId: "qa-correlation-002" },
    });
    assert.equal(concurrent.statusCode, 201);
    assert.equal(concurrent.payload.session.correlationId, "qa-correlation-002");

    const input = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-correlation/media/input", Buffer.from([1, 2, 3, 4]), {
      "content-type": "audio/l16",
      "x-sample-rate-hz": "16000",
    });
    assert.equal(input.statusCode, 202);

    const transcript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      sipCallId: "correlation-proof-call",
      text: "new transcript for the correlated voice session",
      voiceSessionId: "cae-session-correlation",
      rtcAsrEvidencePath: "artifacts/qa-correlation-001-rtc-asr.json",
    });
    assert.equal(transcript.statusCode, 200);

    const capture = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.capture",
      sipCallId: "correlation-proof-call",
      voiceSessionId: "cae-session-correlation",
      audioWavPath: "artifacts/qa-correlation-001-capture.wav",
    });
    assert.equal(capture.statusCode, 200);

    const playback = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.playback",
      sipCallId: "correlation-proof-call",
      voiceSessionId: "cae-session-correlation",
      outboundRtpReady: true,
      rtpSocketSendReady: true,
      packetCount: 4,
      sentPacketCount: 4,
      remoteHost: "127.0.0.1",
      remotePort: 4000,
      evidencePath: "artifacts/qa-correlation-001-playback-manifest.json",
      callerPlaybackConfirmed: true,
      callerPlaybackEvidencePath: "artifacts/qa-correlation-001-playback.json",
    });
    assert.equal(playback.statusCode, 200);

    const otherSessionCapture = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.capture",
      sipCallId: "correlation-proof-call",
      voiceSessionId: "cae-session-correlation-other",
      audioWavPath: "artifacts/qa-correlation-002-capture.wav",
    });
    assert.equal(otherSessionCapture.statusCode, 200);

    const turn = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "I need to change my appointment.",
      conversationMode: "free_caller",
    });
    assert.equal(turn.statusCode, 200);

    const output = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-correlation/media/output", Buffer.from([10, 11, 12, 13]), {
      "content-type": "audio/l16",
      "x-sample-rate-hz": "24000",
      "x-output-stream-id": "tts-correlation-1",
    });
    assert.equal(output.statusCode, 202);

    const cancel = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-correlation/control", {
      action: "barge_in",
      reason: "qa interruption",
    });
    assert.equal(cancel.statusCode, 200);

    const followUpOutput = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-correlation/media/output", Buffer.from([21, 22, 23]), {
      "content-type": "audio/l16",
      "x-sample-rate-hz": "24000",
      "x-output-stream-id": "tts-correlation-2",
      "x-output-final": "true",
    });
    assert.equal(followUpOutput.statusCode, 202);

    const proof = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-correlation/proof");
    assert.equal(proof.statusCode, 200);
    assert.equal(proof.payload.correlation.schemaVersion, 1);
    assert.equal(proof.payload.correlation.correlationId, "qa-correlation-001");
    assert.equal(proof.payload.correlation.redaction.transcriptTextIncluded, false);
    assert.equal(proof.payload.correlation.redaction.audioContentIncluded, false);
    assert.equal(proof.payload.correlation.artifactPaths.recordings[0], "artifacts/qa-correlation-001-mixed.wav");
    assert.deepEqual(proof.payload.correlation.missingArtifactPaths, []);
    assert.equal(proof.payload.correlation.coverage["media.ingress"], true);
    assert.equal(proof.payload.correlation.coverage["stt.final"], true);
    assert.equal(proof.payload.correlation.coverage["acc.agent_processing"], true);
    assert.equal(proof.payload.correlation.coverage["tts.playback_chunk"], true);
    assert.equal(proof.payload.correlation.coverage["barge_in.cancelled"], true);
    assert.equal(proof.payload.correlation.coverage["tts.playback_completed"], true);
    assert.equal(typeof proof.payload.correlation.metrics.endToEndResponseLatencyMs, "number");
    assert.equal(typeof proof.payload.correlation.metrics.interruptionLatencyMs, "number");
    assert.equal(typeof proof.payload.correlation.metrics.sttFinalLatencyMs, "number");
    assert.equal(typeof proof.payload.correlation.metrics.agentResponseLatencyMs, "number");
    assert.ok(proof.payload.correlation.clock.warnings.some((warning: string) => warning === "call_event_before_voice_session:rtc_asr_transcript"));
    assert.equal(proof.payload.correlation.timeline.every((event: any) => event.correlationId === "qa-correlation-001"), true);
    assert.equal(proof.payload.correlation.timeline.some((event: any) => event.type === "rtc_asr_transcript" && event.phase === "stt.final"), true);
    assert.equal(proof.payload.correlation.timeline.some((event: any) => event.type === "rtc_asr_transcript" && event.artifactPath === "artifacts/qa-correlation-001-rtc-asr.json"), true);
    assert.equal(proof.payload.correlation.timeline.some((event: any) => event.type === "media_capture_attached" && event.artifactPath === "artifacts/qa-correlation-001-capture.wav"), true);
    assert.equal(proof.payload.correlation.timeline.some((event: any) => event.type === "pipecat_rtp_playback_attached" && event.artifactPath === "artifacts/qa-correlation-001-playback.json"), true);
    assert.equal(proof.payload.correlation.timeline.some((event: any) => event.artifactPath === "artifacts/qa-correlation-002-capture.wav"), false);
    assert.equal(proof.payload.correlation.timeline.filter((event: any) => event.type === "media_capture_attached").length, 2);
    assert.equal(proof.payload.correlation.timeline.some((event: any) => event.type === "agent_response_ready" && event.phase === "acc.agent_response_ready"), true);
    assert.equal(proof.payload.correlation.timeline.some((event: any) => event.phase === "media.ingress" && event.bytes === 4), true);
    assert.equal(proof.payload.correlation.timeline.some((event: any) => event.phase === "tts.playback_completed" && event.streamId === "tts-correlation-2"), true);

    const otherProof = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-correlation-other/proof");
    assert.equal(otherProof.statusCode, 200);
    assert.equal(otherProof.payload.correlation.correlationId, "qa-correlation-002");
    assert.deepEqual(otherProof.payload.correlation.missingArtifactPaths, ["recording_paths_not_attached"]);
    assert.equal(otherProof.payload.correlation.timeline.every((event: any) => event.correlationId === "qa-correlation-002"), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("voice sessions reject expected transcript shortcuts in realtime-audio mode", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const createShortcut = await requestJson(address.port, "POST", "/api/voice/sessions", {
      expectedTranscript: "I need billing help.",
    });
    assert.equal(createShortcut.statusCode, 400);
    assert.equal(createShortcut.payload.error, "voice_session_transcript_shortcut_rejected");

    const created = await requestJson(address.port, "POST", "/api/voice/sessions", { sessionId: "cae-session-shortcut" });
    assert.equal(created.statusCode, 201);

    const playShortcut = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-shortcut/play", {
      audioData: voiceAudioFixtures.fixtures["caller-billing-short"].audioData,
      transcript: "Do not inject this as caller text.",
    });
    assert.equal(playShortcut.statusCode, 400);
    assert.equal(playShortcut.payload.error, "voice_session_transcript_shortcut_rejected");

    const proof = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-shortcut/proof");
    assert.equal(proof.payload.evidence.transcriptTurns, 0);
    assert.equal(proof.payload.evidence.hasOutputAudio, false);
    assert.equal(proof.payload.mediaPipeline.realtimeAudioMode, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("voice session play validates and injects fixture audio acts", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const created = await requestJson(address.port, "POST", "/api/voice/sessions", { sessionId: "cae-session-play-fixtures" });
    assert.equal(created.statusCode, 201);

    const unsupported = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-play-fixtures/play", {
      audioData: voiceAudioFixtures.fixtures["caller-billing-short"].audioData,
      mimeType: "text/plain",
    });
    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.payload.error, "voice_session_play_audio_format_unsupported");

    const invalidAudio = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-play-fixtures/play", {
      audioData: "not base64",
      mimeType: "audio/l16",
    });
    assert.equal(invalidAudio.statusCode, 400);
    assert.equal(invalidAudio.payload.error, "voice_session_play_audio_invalid");

    const activeOutput = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-play-fixtures/media/output", Buffer.from([1, 2, 3, 4]), {
      "content-type": "audio/l16",
      "x-output-stream-id": "active-tts",
    });
    assert.equal(activeOutput.statusCode, 202);
    assert.equal(activeOutput.payload.session.output.status, "streaming");

    const firstFixture = voiceAudioFixtures.fixtures["caller-billing-short"];
    const firstPlay = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-play-fixtures/play", {
      assetName: "caller-billing-short",
      audioData: firstFixture.audioData,
      mimeType: firstFixture.mimeType,
      sampleRateHz: firstFixture.sampleRateHz,
    });
    assert.equal(firstPlay.statusCode, 202);
    assert.equal(firstPlay.payload.session.output.status, "cancelled");
    assert.equal(firstPlay.payload.session.output.bargeInCancellationObserved, true);
    assert.equal(firstPlay.payload.session.media.inputChunks, 1);
    assert.equal(firstPlay.payload.session.media.inputBytes, Buffer.from(firstFixture.audioData, "base64").byteLength);
    assert.equal(firstPlay.payload.session.events.some((event: any) => event.type === "output.stream.cancelled" && event.detail.reason === "fixture_audio_play"), true);

    const silenceFixture = voiceAudioFixtures.fixtures["caller-silence-short"];
    const silencePlay = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-play-fixtures/play", {
      assetName: "caller-silence-short",
      audioData: silenceFixture.audioData,
      mimeType: silenceFixture.mimeType,
      sampleRateHz: silenceFixture.sampleRateHz,
    });
    assert.equal(silencePlay.statusCode, 202);
    assert.equal(silencePlay.payload.injectedAudio.silentAudio, true);
    assert.equal(silencePlay.payload.session.media.inputChunks, 2);
    assert.equal(silencePlay.payload.session.playback.requestedTurns, 2);
    assert.equal(silencePlay.payload.session.events.at(-1).detail.assetName, "caller-silence-short");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("voice sessions complete output streams without barge-in cancellation", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const created = await requestJson(address.port, "POST", "/api/voice/sessions", { sessionId: "cae-session-output-complete" });
    assert.equal(created.statusCode, 201);

    const output = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-output-complete/media/output", Buffer.from([1, 2, 3]), {
      "content-type": "audio/l16",
      "x-output-stream-id": "tts-turn-complete",
      "x-output-final": "true",
    });
    assert.equal(output.statusCode, 202);
    assert.equal(output.payload.session.output.status, "completed");
    assert.equal(output.payload.session.output.completedAt !== null, true);

    const lateOutput = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-output-complete/media/output", Buffer.from([4, 5]), {
      "content-type": "audio/l16",
      "x-output-stream-id": "tts-turn-complete",
    });
    assert.equal(lateOutput.statusCode, 202);
    assert.equal(lateOutput.payload.session.output.status, "completed");
    assert.equal(lateOutput.payload.session.output.chunks, 1);
    assert.equal(lateOutput.payload.session.output.bytes, 3);

    const events = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-output-complete/events");
    assert.deepEqual(events.payload.events.map((event: any) => event.type), [
      "session.created",
      "output.stream.started",
      "output.audio.chunk",
      "output.stream.completed",
      "output.audio.chunk.ignored",
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("voice sessions flush active output streams for evaluator handoff", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const created = await requestJson(address.port, "POST", "/api/voice/sessions", { sessionId: "cae-session-output-flush" });
    assert.equal(created.statusCode, 201);

    const output = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-output-flush/media/output", Buffer.from([1, 2, 3, 4]), {
      "content-type": "audio/l16",
      "x-output-stream-id": "tts-turn-flush",
    });
    assert.equal(output.statusCode, 202);
    assert.equal(output.payload.session.output.status, "streaming");

    const flushed = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-output-flush/control", {
      action: "flush",
      reason: "tts drain complete",
    });
    assert.equal(flushed.statusCode, 200);
    assert.equal(flushed.payload.session.output.status, "completed");
    assert.equal(flushed.payload.session.output.completedAt !== null, true);
    assert.equal(flushed.payload.session.output.chunks, 1);
    assert.equal(flushed.payload.session.output.bytes, 4);

    const lateOutput = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-output-flush/media/output", Buffer.from([5, 6]), {
      "content-type": "audio/l16",
      "x-output-stream-id": "tts-turn-flush",
    });
    assert.equal(lateOutput.statusCode, 202);
    assert.equal(lateOutput.payload.session.output.status, "completed");
    assert.equal(lateOutput.payload.session.output.chunks, 1);

    const events = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-output-flush/events");
    assert.deepEqual(events.payload.events.map((event: any) => event.type), [
      "session.created",
      "output.stream.started",
      "output.audio.chunk",
      "control.received",
      "output.stream.completed",
      "output.audio.chunk.ignored",
    ]);
    assert.equal(events.payload.events[4].detail.reason, "tts drain complete");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("voice sessions reject duplicate IDs, invalid sample rates, and post-close writes", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const created = await requestJson(address.port, "POST", "/api/voice/sessions", { sessionId: "cae-session-guards" });
    assert.equal(created.statusCode, 201);

    const duplicate = await requestJson(address.port, "POST", "/api/voice/sessions", { sessionId: "cae-session-guards" });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.payload.error, "voice_session_already_exists");

    const invalidSampleRate = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-guards/media/input", Buffer.from([1]), {
      "x-sample-rate-hz": "abc",
    });
    assert.equal(invalidSampleRate.statusCode, 400);
    assert.equal(invalidSampleRate.payload.error, "voice_session_sample_rate_invalid");

    const closedByControl = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-guards/control", { action: "close" });
    assert.equal(closedByControl.statusCode, 200);
    assert.equal(closedByControl.payload.session.status, "closed");

    const postClosePlay = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-guards/play", {
      audioData: Buffer.from([1]).toString("base64"),
    });
    assert.equal(postClosePlay.statusCode, 409);
    assert.equal(postClosePlay.payload.error, "voice_session_closed");

    const postCloseMedia = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-guards/media/output", Buffer.from([2]));
    assert.equal(postCloseMedia.statusCode, 409);
    assert.equal(postCloseMedia.payload.error, "voice_session_closed");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("voice session proof scopes rtc-asr transcripts to evidence captured after session creation", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      sipCallId: "scope-proof-call",
      timestamp: "2026-01-01T00:00:00.000Z",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    const callId = started.payload.call.session.callId;

    const oldTranscript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      sipCallId: "scope-proof-call",
      timestamp: "2026-01-01T00:00:01.000Z",
      text: "old transcript from before this voice session",
    });
    assert.equal(oldTranscript.statusCode, 200);

    const created = await requestJson(address.port, "POST", "/api/voice/sessions", { sessionId: "cae-session-scoped-asr", callId });
    assert.equal(created.statusCode, 201);

    await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-scoped-asr/media/input", Buffer.from([1, 2, 3]), { "x-sample-rate-hz": "16000" });
    await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-scoped-asr/media/output", Buffer.from([4, 5, 6]), { "x-output-final": "true" });

    const proofBefore = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-scoped-asr/proof");
    assert.equal(proofBefore.statusCode, 200);
    assert.equal(proofBefore.payload.evidence.hasRtcAsrFinalTranscript, false);
    assert.equal(proofBefore.payload.evidence.rtcAsrTranscriptEvents, 0);
    assert.deepEqual(proofBefore.payload.review.blockers, ["rtc_asr_final_transcript_missing"]);

    const newTranscript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      sipCallId: "scope-proof-call",
      timestamp: "2999-01-01T00:00:01.000Z",
      text: "new transcript for this voice session",
    });
    assert.equal(newTranscript.statusCode, 200);

    const proofAfter = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-scoped-asr/proof");
    assert.equal(proofAfter.payload.evidence.hasRtcAsrFinalTranscript, true);
    assert.equal(proofAfter.payload.evidence.rtcAsrTranscriptEvents, 1);
    assert.equal(proofAfter.payload.review.ready, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("voice session WebSocket media input reassembles fragmented binary messages", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const created = await requestJson(address.port, "POST", "/api/voice/sessions", { sessionId: "cae-session-ws-fragmented" });
    assert.equal(created.statusCode, 201);

    await writeFragmentedWebSocketAudio(address.port, "cae-session-ws-fragmented", [Buffer.from([1, 2]), Buffer.from([3, 4, 5])]);

    const proof = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-ws-fragmented/proof");
    assert.equal(proof.statusCode, 200);
    assert.equal(proof.payload.session.media.inputChunks, 1);
    assert.equal(proof.payload.session.media.inputBytes, 5);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
