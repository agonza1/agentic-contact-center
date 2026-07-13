import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

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

    const play = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-1/play", {
      callerActId: "act-1",
      audioData: Buffer.from([1, 2, 3, 4]).toString("base64"),
    });
    assert.equal(play.statusCode, 202);
    assert.equal(play.payload.session.playback.requestedTurns, 1);
    assert.equal(play.payload.session.events.at(-1).type, "play.requested");
    assert.equal(play.payload.session.events.at(-1).detail.expectedTranscriptAccepted, false);

    const media = await requestRaw(address.port, "POST", "/api/voice/sessions/cae-session-1/media/input", Buffer.from([9, 8, 7, 6, 5]), {
      "content-type": "audio/l16",
      "x-sample-rate-hz": "16000",
    });
    assert.equal(media.statusCode, 202);
    assert.equal(media.payload.session.media.inputChunks, 1);
    assert.equal(media.payload.session.media.inputBytes, 5);
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

    const proof = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-1/proof");
    assert.equal(proof.statusCode, 200);
    assert.equal(proof.payload.mediaPipeline.persistent, true);
    assert.equal(proof.payload.mediaPipeline.fullDuplex, true);
    assert.equal(proof.payload.mediaPipeline.transcriptShortcutAllowed, false);
    assert.equal(proof.payload.evidence.hasAudioInput, true);
    assert.equal(proof.payload.evidence.hasOutputAudio, true);
    assert.equal(proof.payload.evidence.outputStatus, "completed");
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
      audioData: Buffer.from([1, 2, 3]).toString("base64"),
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
