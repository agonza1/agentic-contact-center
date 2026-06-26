import test from "node:test";
import assert from "node:assert/strict";

import { LocalRealtimeShimPrototype } from "../src/core/localRealtimeShimPrototype";

test("local realtime shim prototype completes one mocked local voice turn with QA evidence", () => {
  const shim = new LocalRealtimeShimPrototype();
  const envelope = shim.createSession({ relaySessionId: "local-rt-proof" });
  const audioBase64 = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]).toString("base64");

  shim.appendAudio({ sessionId: envelope.sessionId, audioBase64, timestamp: 42 });
  const evidence = shim.finalizeTurn({
    sessionId: envelope.sessionId,
    transcriptText: "Can I get a retention credit?",
  });

  assert.equal(evidence.state, "speaking");
  assert.deepEqual(evidence.localSttMessages.slice(0, 3), [
    {
      type: "start",
      version: "local-stt.v1",
      audio: {
        sample_rate: 16000,
        channels: 1,
        format: "pcm_s16le",
        frame_ms: 20,
        bytes_per_frame: 640,
      },
      interim_results: true,
    },
    { type: "audio", byteLength: 8 },
    { type: "finalize" },
  ]);
  assert.deepEqual(
    evidence.diagnostics.map((event) => event.type),
    [
      "ready",
      "input.audio.delta",
      "transcript.delta",
      "transcript.done",
      "output.text.done",
      "output.audio.started",
      "output.audio.done",
    ],
  );
  assert.deepEqual(
    evidence.timeline.map((event) => [event.sequence, event.source, event.type]),
    [
      [1, "diagnostic", "ready"],
      [2, "local-stt", "start"],
      [3, "local-stt", "audio"],
      [4, "diagnostic", "input.audio.delta"],
      [5, "local-stt", "finalize"],
      [6, "diagnostic", "transcript.delta"],
      [7, "diagnostic", "transcript.done"],
      [8, "diagnostic", "output.text.done"],
      [9, "diagnostic", "output.audio.started"],
      [10, "relay", "audio"],
      [11, "diagnostic", "output.audio.done"],
    ],
  );
  assert.deepEqual(evidence.timeline.find((event) => event.type === "audio"), {
    sequence: 3,
    source: "local-stt",
    type: "audio",
    byteLength: 8,
  });
  assert.equal(evidence.timeline.find((event) => event.type === "transcript.done")?.final, true);
  assert.deepEqual(evidence.relayEvents, [
    {
      relaySessionId: "local-rt-proof",
      sessionId: "local-rt-proof",
      type: "audio",
      audioBase64,
    },
  ]);
  assert.deepEqual(evidence.mockedPieces, ["local LLM response text", "Kokoro PCM output audio"]);
  assert.match(evidence.limitations.join("\n"), /not a live sidecar connection/);
});

test("local realtime shim prototype models barge-in clear and idempotent close", () => {
  const shim = new LocalRealtimeShimPrototype();
  const envelope = shim.createSession({ relaySessionId: "local-rt-barge" });
  const audioBase64 = Buffer.from([5, 0, 6, 0]).toString("base64");

  shim.appendAudio({ sessionId: envelope.sessionId, audioBase64 });
  const cancelled = shim.cancelOutput({ sessionId: envelope.sessionId, reason: "barge-in" });

  assert.equal(cancelled.state, "listening");
  assert.deepEqual(cancelled.relayEvents, [
    {
      relaySessionId: "local-rt-barge",
      sessionId: "local-rt-barge",
      type: "clear",
      reason: "barge-in",
    },
  ]);
  assert.equal(cancelled.diagnostics.at(-1)?.type, "turn.cancelled");
  assert.deepEqual(cancelled.timeline.at(-2), {
    sequence: 5,
    source: "relay",
    type: "clear",
    reason: "barge-in",
  });
  assert.deepEqual(cancelled.timeline.at(-1), {
    sequence: 6,
    source: "diagnostic",
    type: "turn.cancelled",
    reason: "barge-in",
  });

  const closed = shim.closeSession({ sessionId: envelope.sessionId, reason: "complete" });
  const closedAgain = shim.closeSession({ sessionId: envelope.sessionId, reason: "client" });

  assert.equal(closed.state, "closed");
  assert.equal(closed.relayEvents.filter((event) => event.type === "close").length, 1);
  assert.deepEqual(closedAgain.relayEvents, closed.relayEvents);
  assert.throws(() => shim.appendAudio({ sessionId: envelope.sessionId, audioBase64 }), /closed/);
});
