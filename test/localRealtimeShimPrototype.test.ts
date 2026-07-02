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
  assert.deepEqual(evidence.browserRelayCompatibility, {
    openClawSurface: "RealtimeTalkSession gateway-relay",
    uiRewriteRequired: false,
    requiredRpcs: [
      "talk.session.create",
      "talk.session.appendAudio",
      "talk.session.finalizeTurn",
      "talk.session.getEvidence",
      "talk.session.cancelOutput",
      "talk.session.cancelInput",
      "talk.session.recordError",
      "talk.session.submitToolResult",
      "talk.session.close",
    ],
    inputAudio: "pcm16 base64 chunks at 24kHz",
    outputAudio: "pcm16 base64 relay audio at 24kHz",
    status: "ready_for_browser_flow",
  });
  assert.deepEqual(evidence.audioInput, {
    relayEncoding: "pcm16",
    relaySampleRateHz: 24000,
    localSttSampleRateHz: 16000,
    chunks: 1,
    bytesReceived: 8,
    lastTimestamp: 42,
  });
  assert.deepEqual(evidence.browserTurnLifecycle, {
    existingOpenClawFlow: "RealtimeTalkSession gateway-relay",
    uiRewriteRequired: false,
    readyForExistingOpenClawFlow: true,
    steps: [
      {
        step: "create",
        passed: true,
        evidence: "Session envelope is ready for the Gateway relay.",
      },
      {
        step: "append_audio",
        passed: true,
        evidence: "1 PCM16 input chunk(s) accepted from the browser relay.",
      },
      {
        step: "finalize_turn",
        passed: true,
        evidence: "Local STT v1 finalize produced a transcript.done diagnostic.",
      },
      {
        step: "output_audio",
        passed: true,
        evidence: "1 output audio relay event(s) emitted.",
      },
      {
        step: "cancel",
        passed: false,
        evidence: "Cancel path has not been exercised for this session.",
      },
      {
        step: "close",
        passed: false,
        evidence: "Session has not been closed.",
      },
    ],
  });
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
  assert.deepEqual(evidence.latencySummary, {
    measuredMarks: 3,
    maxElapsedMs: 135,
    slowestMark: "output_first_audio",
    allWithinBudget: true,
  });
  assert.deepEqual(evidence.latencyBudget, {
    profile: "fast_local_turn",
    targetFirstAudioMs: 500,
    targetSessionCloseMs: 1000,
    modelGuidance: "small_fast_local_models",
    status: "within_budget",
  });
  assert.deepEqual(evidence.pipelineStages.map((stage) => [stage.stage, stage.status, stage.mocked]), [
    ["gateway_relay", "active", false],
    ["local_stt", "active", true],
    ["local_llm", "mocked", true],
    ["kokoro_tts", "mocked", true],
  ]);
  assert.match(evidence.pipelineStages[0].evidence, /1 relay event\(s\) recorded/);
  assert.deepEqual(evidence.qaEvidenceSummary, {
    timelineEvents: 13,
    eventTranscriptLines: 13,
    logLines: 13,
    relayEvents: 1,
    diagnostics: 9,
    latencyMarks: 3,
    pipelineStages: 4,
    lastEvent: "13. diagnostic:output.audio.done",
    reviewReady: true,
  });
  assert.deepEqual(evidence.turnSummary, {
    inputAudioChunks: 1,
    inputAudioBytes: 8,
    finalTranscript: "Can I get a retention credit?",
    outputAudioChunks: 1,
    outputCancelled: false,
    inputCancelled: false,
    errorCount: 0,
    closed: false,
  });
  assert.deepEqual(evidence.eventTranscript.slice(0, 4), [
    "1. diagnostic:ready",
    "2. local-stt:start",
    "3. local-stt:audio (8b)",
    "4. diagnostic:input.audio.delta (8b)",
  ]);
  assert.equal(evidence.eventTranscript.at(-1), "13. diagnostic:output.audio.done");
  assert.deepEqual(evidence.logs.slice(0, 4), [
    "local-realtime-shim seq=1 source=diagnostic event=ready",
    "local-realtime-shim seq=2 source=local-stt event=start",
    "local-realtime-shim seq=3 source=local-stt event=audio bytes=8",
    "local-realtime-shim seq=4 source=diagnostic event=input.audio.delta bytes=8",
  ]);
  assert.deepEqual(evidence.relayEvents, [
    {
      relaySessionId: "local-rt-proof",
      sessionId: "local-rt-proof",
      type: "audio",
      audioBase64,
    },
  ]);
  assert.deepEqual(evidence.qaChecklist, {
    oneTurnEvidence: true,
    interruptionEvidence: false,
    inputCancelEvidence: false,
    boundedErrorEvidence: false,
    eventTranscriptEvidence: true,
    logEvidence: true,
    mockedPiecesNamed: true,
  });
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
  assert.equal(cancelled.qaChecklist.interruptionEvidence, true);
  assert.deepEqual(cancelled.turnSummary, {
    inputAudioChunks: 1,
    inputAudioBytes: 4,
    outputAudioChunks: 0,
    outputCancelled: true,
    inputCancelled: false,
    errorCount: 0,
    closed: false,
  });
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
  assert.deepEqual(resumed.audioInput, {
    relayEncoding: "pcm16",
    relaySampleRateHz: 24000,
    localSttSampleRateHz: 16000,
    chunks: 2,
    bytesReceived: 8,
  });
  assert.equal(resumed.relayEvents.filter((event) => event.type === "audio").length, 1);
  assert.equal(resumed.diagnostics.at(-2)?.type, "output.audio.delta");
  assert.deepEqual(resumed.turnSummary, {
    inputAudioChunks: 2,
    inputAudioBytes: 8,
    finalTranscript: "I am still here",
    outputAudioChunks: 1,
    outputCancelled: true,
    inputCancelled: false,
    errorCount: 0,
    closed: false,
  });

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
  assert.deepEqual(closed.latencySummary, {
    measuredMarks: 4,
    maxElapsedMs: 150,
    slowestMark: "session_closed",
    allWithinBudget: true,
  });
  assert.deepEqual(closedAgain.latencyMarks, closed.latencyMarks);
  assert.deepEqual(closedAgain.relayEvents, closed.relayEvents);
  assert.throws(() => shim.appendAudio({ sessionId: envelope.sessionId, audioBase64 }), /closed/);
});

test("local realtime shim prototype cancels input without final transcript dispatch", () => {
  const shim = new LocalRealtimeShimPrototype();
  const envelope = shim.createSession({ relaySessionId: "local-rt-input-cancel" });
  const audioBase64 = Buffer.from([9, 0, 10, 0]).toString("base64");

  shim.appendAudio({ sessionId: envelope.sessionId, audioBase64 });
  const cancelled = shim.cancelInput({ sessionId: envelope.sessionId });

  assert.equal(cancelled.state, "idle");
  assert.deepEqual(cancelled.audioInput, {
    relayEncoding: "pcm16",
    relaySampleRateHz: 24000,
    localSttSampleRateHz: 16000,
    chunks: 0,
    bytesReceived: 0,
  });
  assert.deepEqual(cancelled.localSttMessages.map((message) => message.type), ["start", "audio", "cancel"]);
  assert.equal(cancelled.diagnostics.some((event) => event.type === "transcript.done"), false);
  assert.equal(cancelled.diagnostics.some((event) => event.type === "output.text.done"), false);
  assert.equal(cancelled.qaChecklist.inputCancelEvidence, true);
  assert.deepEqual(cancelled.turnSummary, {
    inputAudioChunks: 0,
    inputAudioBytes: 0,
    outputAudioChunks: 0,
    outputCancelled: false,
    inputCancelled: true,
    errorCount: 0,
    closed: false,
  });
  assert.deepEqual(cancelled.diagnostics.at(-1), {
    type: "input.cancelled",
    sessionId: "local-rt-input-cancel",
    relaySessionId: "local-rt-input-cancel",
    reason: "client",
  });
  assert.deepEqual(cancelled.timeline.slice(-2), [
    { sequence: 5, source: "local-stt", type: "cancel" },
    { sequence: 6, source: "diagnostic", type: "input.cancelled", reason: "client" },
  ]);

  const resumed = shim.appendAudio({ sessionId: envelope.sessionId, audioBase64, timestamp: 27 });

  assert.deepEqual(resumed.audioInput, {
    relayEncoding: "pcm16",
    relaySampleRateHz: 24000,
    localSttSampleRateHz: 16000,
    chunks: 1,
    bytesReceived: 4,
    lastTimestamp: 27,
  });
  assert.deepEqual(resumed.localSttMessages.map((message) => message.type), ["start", "audio", "cancel", "start", "audio"]);
  assert.deepEqual(resumed.timeline.slice(-3), [
    { sequence: 7, source: "local-stt", type: "start" },
    { sequence: 8, source: "local-stt", type: "audio", byteLength: 4 },
    { sequence: 9, source: "diagnostic", type: "input.audio.delta", byteLength: 4 },
  ]);
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
  assert.equal(fatal.qaChecklist.boundedErrorEvidence, true);
  assert.deepEqual(fatal.turnSummary, {
    inputAudioChunks: 1,
    inputAudioBytes: 4,
    outputAudioChunks: 0,
    outputCancelled: false,
    inputCancelled: false,
    errorCount: 2,
    closed: true,
  });
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

test("local realtime shim prototype records malformed gateway audio without starting STT", () => {
  const shim = new LocalRealtimeShimPrototype();
  const envelope = shim.createSession({ relaySessionId: "local-rt-invalid-audio" });

  const result = shim.appendAudioWithErrorEvidence({
    sessionId: envelope.sessionId,
    audioBase64: "AQI",
    timestamp: 42,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_audio_frame");
  assert.equal(result.evidence.state, "idle");
  assert.deepEqual(result.evidence.audioInput, {
    relayEncoding: "pcm16",
    relaySampleRateHz: 24000,
    localSttSampleRateHz: 16000,
    chunks: 0,
    bytesReceived: 0,
  });
  assert.deepEqual(result.evidence.localSttMessages, []);
  assert.deepEqual(result.evidence.latencySummary, {
    measuredMarks: 0,
    maxElapsedMs: 0,
    allWithinBudget: true,
  });
  assert.deepEqual(result.evidence.relayEvents.at(-1), {
    relaySessionId: "local-rt-invalid-audio",
    sessionId: "local-rt-invalid-audio",
    type: "error",
    code: "invalid_audio_frame",
    message: "audioBase64 must be valid base64",
    retryable: true,
  });
  assert.deepEqual(result.evidence.diagnostics.at(-1), {
    type: "session.error",
    sessionId: "local-rt-invalid-audio",
    relaySessionId: "local-rt-invalid-audio",
    code: "invalid_audio_frame",
    message: "audioBase64 must be valid base64",
    retryable: true,
  });
  assert.deepEqual(result.evidence.timeline.slice(-2), [
    {
      sequence: 2,
      source: "relay",
      type: "error",
      code: "invalid_audio_frame",
      message: "audioBase64 must be valid base64",
      retryable: true,
    },
    {
      sequence: 3,
      source: "diagnostic",
      type: "session.error",
      code: "invalid_audio_frame",
      message: "audioBase64 must be valid base64",
      retryable: true,
    },
  ]);
  assert.deepEqual(result.evidence.eventTranscript.slice(-2), [
    "2. relay:error (code=invalid_audio_frame, retryable=true)",
    "3. diagnostic:session.error (code=invalid_audio_frame, retryable=true)",
  ]);
});
