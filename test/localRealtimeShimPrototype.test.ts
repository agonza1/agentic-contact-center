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
      "output.text.delta",
      "output.text.done",
      "output.audio.started",
      "output.audio.delta",
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
      [8, "diagnostic", "output.text.delta"],
      [9, "diagnostic", "output.text.done"],
      [10, "diagnostic", "output.audio.started"],
      [11, "relay", "audio"],
      [12, "diagnostic", "output.audio.delta"],
      [13, "diagnostic", "output.audio.done"],
    ],
  );
  assert.deepEqual(evidence.timeline.find((event) => event.type === "audio"), {
    sequence: 3,
    source: "local-stt",
    type: "audio",
    byteLength: 8,
  });
  assert.equal(evidence.timeline.find((event) => event.type === "transcript.done")?.final, true);
  assert.equal(evidence.timeline.find((event) => event.type === "output.audio.delta")?.byteLength, 8);
  assert.deepEqual(evidence.latencyMarks, [
    { name: "audio_ingested", elapsedMs: 12, budgetMs: 50, withinBudget: true },
    { name: "transcript_final", elapsedMs: 75, budgetMs: 250, withinBudget: true },
    { name: "output_first_audio", elapsedMs: 135, budgetMs: 500, withinBudget: true },
  ]);
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
  assert.deepEqual(evidence.toolResults, []);
});

test("local realtime shim prototype accepts gateway relay tool results as not applicable evidence", () => {
  const shim = new LocalRealtimeShimPrototype();
  const envelope = shim.createSession({ relaySessionId: "local-rt-tool" });

  const evidence = shim.submitToolResult({
    sessionId: envelope.sessionId,
    toolCallId: "tool-call-1",
    result: { approved: true },
  });

  assert.deepEqual(evidence.toolResults, [
    {
      sessionId: "local-rt-tool",
      toolCallId: "tool-call-1",
      result: { approved: true },
      status: "not_applicable",
    },
  ]);
  assert.deepEqual(evidence.diagnostics.at(-1), {
    type: "tool.result.received",
    sessionId: "local-rt-tool",
    relaySessionId: "local-rt-tool",
    toolCallId: "tool-call-1",
    status: "not_applicable",
  });
  assert.deepEqual(evidence.timeline.at(-1), {
    sequence: 2,
    source: "diagnostic",
    type: "tool.result.received",
    toolCallId: "tool-call-1",
    status: "not_applicable",
  });
  assert.throws(
    () => shim.submitToolResult({ sessionId: envelope.sessionId, toolCallId: " ", result: null }),
    /toolCallId is required/,
  );
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

  shim.appendAudio({ sessionId: envelope.sessionId, audioBase64 });
  const resumed = shim.finalizeTurn({ sessionId: envelope.sessionId, transcriptText: "I am still here" });

  assert.equal(resumed.state, "speaking");
  assert.equal(resumed.relayEvents.filter((event) => event.type === "audio").length, 1);
  assert.equal(resumed.diagnostics.at(-2)?.type, "output.audio.delta");

  const closed = shim.closeSession({ sessionId: envelope.sessionId, reason: "complete" });
  const closedAgain = shim.closeSession({ sessionId: envelope.sessionId, reason: "client" });

  assert.equal(closed.state, "closed");
  assert.equal(closed.relayEvents.filter((event) => event.type === "close").length, 1);
  assert.deepEqual(closed.latencyMarks.at(-1), {
    name: "session_closed",
    elapsedMs: 150,
    budgetMs: 1000,
    withinBudget: true,
  });
  assert.deepEqual(closedAgain.latencyMarks, closed.latencyMarks);
  assert.deepEqual(closedAgain.relayEvents, closed.relayEvents);
  assert.throws(() => shim.appendAudio({ sessionId: envelope.sessionId, audioBase64 }), /closed/);
});

test("local realtime shim prototype emits bounded Local STT error evidence", () => {
  const shim = new LocalRealtimeShimPrototype();
  const envelope = shim.createSession({ relaySessionId: "local-rt-error" });
  const audioBase64 = Buffer.from([7, 0, 8, 0]).toString("base64");

  shim.appendAudio({ sessionId: envelope.sessionId, audioBase64 });
  const retryable = shim.recordLocalSttError({
    sessionId: envelope.sessionId,
    code: "stream_warning",
    message: "local stt partial frame arrived late",
    retryable: true,
  });

  assert.equal(retryable.state, "listening");
  assert.deepEqual(retryable.relayEvents.at(-1), {
    relaySessionId: "local-rt-error",
    sessionId: "local-rt-error",
    type: "error",
    code: "stream_warning",
    message: "local stt partial frame arrived late",
    retryable: true,
  });
  assert.deepEqual(retryable.diagnostics.at(-1), {
    type: "session.error",
    sessionId: "local-rt-error",
    relaySessionId: "local-rt-error",
    code: "stream_warning",
    message: "local stt partial frame arrived late",
    retryable: true,
  });

  const fatal = shim.recordLocalSttError({
    sessionId: envelope.sessionId,
    code: "stt_disconnected",
    message: "local stt websocket closed before final transcript",
  });

  assert.equal(fatal.state, "closed");
  assert.deepEqual(fatal.relayEvents.slice(-2), [
    {
      relaySessionId: "local-rt-error",
      sessionId: "local-rt-error",
      type: "error",
      code: "stt_disconnected",
      message: "local stt websocket closed before final transcript",
      retryable: false,
    },
    {
      relaySessionId: "local-rt-error",
      sessionId: "local-rt-error",
      type: "close",
      reason: "error",
    },
  ]);
  assert.deepEqual(
    fatal.timeline.slice(-5).map((event) => [event.source, event.type, event.code ?? event.reason]),
    [
      ["relay", "error", "stt_disconnected"],
      ["diagnostic", "session.error", "stt_disconnected"],
      ["local-stt", "close", undefined],
      ["relay", "close", "error"],
      ["diagnostic", "session.closed", "error"],
    ],
  );
  assert.throws(
    () => shim.recordLocalSttError({ sessionId: envelope.sessionId, code: "again", message: "closed" }),
    /closed/,
  );
});
