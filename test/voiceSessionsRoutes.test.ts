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

    const control = await requestJson(address.port, "POST", "/api/voice/sessions/cae-session-1/control", { action: "barge_in", reason: "tester interruption" });
    assert.equal(control.statusCode, 200);
    assert.equal(control.payload.session.controls.lastAction, "barge_in");

    const events = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-1/events?afterSequence=1");
    assert.equal(events.statusCode, 200);
    assert.deepEqual(events.payload.events.map((event: any) => event.type), ["play.requested", "media.input.received", "control.received"]);

    const proof = await requestJson(address.port, "GET", "/api/voice/sessions/cae-session-1/proof");
    assert.equal(proof.statusCode, 200);
    assert.equal(proof.payload.mediaPipeline.persistent, true);
    assert.equal(proof.payload.mediaPipeline.fullDuplex, true);
    assert.equal(proof.payload.mediaPipeline.transcriptShortcutAllowed, false);
    assert.equal(proof.payload.evidence.hasAudioInput, true);
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
    assert.equal(proof.payload.mediaPipeline.realtimeAudioMode, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
