import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

test("GET /api/realtime-shim/proof returns deterministic gateway relay evidence", async () => {
  const server = buildHttpServer(loadPocConfig());

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/realtime-shim/proof",
          method: "GET",
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
        },
      );

      req.on("error", reject);
      req.end();
    });

    const payload = JSON.parse(responseBody) as {
      ok: boolean;
      route: string;
      issue: string;
      rpcBoundary: string;
      localSttContract: string;
      rpcCompatibility: { route: string; supportedRpcs: string[]; statefulSession: boolean; boundedErrors: boolean };
      acceptanceSummary: Record<string, boolean>;
      acceptanceDetails: Record<string, { status: string; evidence: string; routes: string[] }>;
      readyForIssue85Review: boolean;
      evidence: {
        state: string;
        envelope: { provider: string; transport: string; relaySessionId: string; sessionId: string };
        audioInput: { relayEncoding: string; relaySampleRateHz: number; localSttSampleRateHz: number; chunks: number; bytesReceived: number; lastTimestamp?: number };
        localSttMessages: Array<{ type: string; version?: string; byteLength?: number }>;
        relayEvents: Array<{ type: string; audioBase64?: string }>;
        diagnostics: Array<{ type: string; relaySessionId: string; sessionId: string }>;
        eventTranscript: string[];
        logs: string[];
        latencyMarks: Array<{ name: string; elapsedMs: number; budgetMs: number; withinBudget: boolean }>;
        latencySummary: { measuredMarks: number; maxElapsedMs: number; slowestMark?: string; allWithinBudget: boolean };
        qaChecklist: Record<string, boolean>;
        pipelineStages: Array<{ stage: string; status: string; mocked: boolean; evidence: string }>;
        qaEvidenceSummary: {
          timelineEvents: number;
          eventTranscriptLines: number;
          logLines: number;
          relayEvents: number;
          diagnostics: number;
          latencyMarks: number;
          pipelineStages: number;
          lastEvent?: string;
          reviewReady: boolean;
        };
      };
      closeEvidence: {
        state: string;
        relayEvents: Array<{ type: string; reason?: string }>;
        localSttMessages: Array<{ type: string }>;
        diagnostics: Array<{ type: string; sessionId: string; relaySessionId: string; reason?: string }>;
        latencyMarks: Array<{ name: string; elapsedMs: number; budgetMs: number; withinBudget: boolean }>;
      };
      interruptionEvidence: {
        state: string;
        envelope: { relaySessionId: string; sessionId: string };
        relayEvents: Array<{ type: string; reason?: string }>;
        diagnostics: Array<{ type: string; reason?: string; relaySessionId: string; sessionId: string }>;
        timeline: Array<{ source: string; type: string; reason?: string }>;
        eventTranscript: string[];
        qaChecklist: Record<string, boolean>;
      };
      inputCancelEvidence: {
        state: string;
        localSttMessages: Array<{ type: string }>;
        diagnostics: Array<{ type: string; reason?: string; relaySessionId: string; sessionId: string }>;
        timeline: Array<{ source: string; type: string; reason?: string }>;
        eventTranscript: string[];
        qaChecklist: Record<string, boolean>;
      };
      errorEvidence: {
        state: string;
        envelope: { relaySessionId: string; sessionId: string };
        relayEvents: Array<{ type: string; code?: string; message?: string; retryable?: boolean; reason?: string }>;
        diagnostics: Array<{ type: string; code?: string; message?: string; retryable?: boolean; relaySessionId: string; sessionId: string; reason?: string }>;
        timeline: Array<{ source: string; type: string; code?: string; reason?: string }>;
        eventTranscript: string[];
        qaChecklist: Record<string, boolean>;
      };
      invalidAudioResult: {
        ok: boolean;
        code: string;
        message: string;
        evidence: {
          state: string;
          envelope: { relaySessionId: string; sessionId: string };
          audioInput: { chunks: number; bytesReceived: number };
          localSttMessages: Array<{ type: string }>;
          relayEvents: Array<{ type: string; code?: string; message?: string; retryable?: boolean }>;
          diagnostics: Array<{ type: string; code?: string; message?: string; retryable?: boolean; relaySessionId: string; sessionId: string }>;
          qaChecklist: Record<string, boolean>;
        };
      };
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/realtime-shim/proof");
    assert.equal(payload.issue, "agonza1/agentic-contact-center#85");
    assert.equal(payload.rpcBoundary, "gateway-relay");
    assert.equal(payload.localSttContract, "local-stt.v1");
    assert.deepEqual(payload.rpcCompatibility, {
      route: "POST /api/realtime-shim/rpc",
      supportedRpcs: [
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
      statefulSession: true,
      boundedErrors: true,
    });
    assert.deepEqual(payload.acceptanceSummary, {
      oneLocalVoiceTurn: true,
      adapterContract: true,
      interruptionCancelBehavior: true,
      qaEvidence: true,
      mockedPiecesIsolated: true,
      boundedErrorEvidence: true,
    });
    assert.deepEqual(
      Object.fromEntries(Object.entries(payload.acceptanceDetails).map(([key, detail]) => [key, detail.status])),
      {
        oneLocalVoiceTurn: "passed",
        adapterContract: "passed",
        interruptionCancelBehavior: "passed",
        qaEvidence: "passed",
        mockedPiecesIsolated: "passed",
        boundedErrorEvidence: "passed",
      },
    );
    assert.match(payload.acceptanceDetails.adapterContract.evidence, /local-realtime-shim over gateway-relay with local-stt\.v1/);
    assert.deepEqual(payload.acceptanceDetails.oneLocalVoiceTurn.routes, [
      "GET /api/realtime-shim/proof",
      "POST /api/realtime-shim/rpc",
    ]);
    assert.equal(payload.readyForIssue85Review, true);
    assert.equal(payload.evidence.state, "speaking");
    assert.deepEqual(payload.evidence.qaChecklist, {
      oneTurnEvidence: true,
      interruptionEvidence: false,
      inputCancelEvidence: false,
      boundedErrorEvidence: false,
      eventTranscriptEvidence: true,
      logEvidence: true,
      mockedPiecesNamed: true,
    });
    assert.equal(payload.evidence.envelope.provider, "local-realtime-shim");
    assert.equal(payload.evidence.envelope.transport, "gateway-relay");
    assert.equal(payload.evidence.envelope.relaySessionId, "local-rt-http-proof");
    assert.deepEqual(payload.evidence.audioInput, {
      relayEncoding: "pcm16",
      relaySampleRateHz: 24000,
      localSttSampleRateHz: 16000,
      chunks: 1,
      bytesReceived: 8,
      lastTimestamp: 42,
    });
    assert.deepEqual(
      payload.evidence.localSttMessages.map((message) => message.type),
      ["start", "audio", "finalize"],
    );
    assert.equal(payload.evidence.localSttMessages[0].version, "local-stt.v1");
    assert.equal(payload.evidence.localSttMessages[1].byteLength, 8);
    assert.deepEqual(payload.evidence.relayEvents.map((event) => event.type), ["audio"]);
    assert.deepEqual(
      payload.evidence.latencyMarks.map((mark) => [mark.name, mark.withinBudget]),
      [
        ["audio_ingested", true],
        ["transcript_final", true],
        ["output_first_audio", true],
      ],
    );
    assert.deepEqual(payload.evidence.latencySummary, {
      measuredMarks: 3,
      maxElapsedMs: 135,
      slowestMark: "output_first_audio",
      allWithinBudget: true,
    });
    assert.deepEqual(payload.evidence.pipelineStages.map((stage) => [stage.stage, stage.status, stage.mocked]), [
      ["gateway_relay", "active", false],
      ["local_stt", "active", true],
      ["local_llm", "mocked", true],
      ["kokoro_tts", "mocked", true],
    ]);
    assert.deepEqual(payload.evidence.qaEvidenceSummary, {
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
    assert.deepEqual(payload.evidence.eventTranscript.slice(0, 4), [
      "1. diagnostic:ready",
      "2. local-stt:start",
      "3. local-stt:audio (8b)",
      "4. diagnostic:input.audio.delta (8b)",
    ]);
    assert.deepEqual(payload.evidence.logs.slice(0, 4), [
      "local-realtime-shim seq=1 source=diagnostic event=ready",
      "local-realtime-shim seq=2 source=local-stt event=start",
      "local-realtime-shim seq=3 source=local-stt event=audio bytes=8",
      "local-realtime-shim seq=4 source=diagnostic event=input.audio.delta bytes=8",
    ]);
    assert.ok(
      payload.evidence.diagnostics.every(
        (event) => event.relaySessionId === "local-rt-http-proof" && event.sessionId === "local-rt-http-proof",
      ),
    );
    assert.equal(payload.closeEvidence.state, "closed");
    assert.deepEqual(payload.closeEvidence.localSttMessages.map((message) => message.type), [
      "start",
      "audio",
      "finalize",
      "close",
    ]);
    assert.deepEqual(payload.closeEvidence.relayEvents.map((event) => [event.type, event.reason]), [
      ["audio", undefined],
      ["close", "complete"],
    ]);
    assert.deepEqual(payload.closeEvidence.diagnostics.at(-1), {
      type: "session.closed",
      sessionId: "local-rt-http-proof",
      relaySessionId: "local-rt-http-proof",
      reason: "complete",
    });
    assert.deepEqual(payload.closeEvidence.latencyMarks.at(-1), {
      name: "session_closed",
      elapsedMs: 150,
      budgetMs: 1000,
      withinBudget: true,
    });
    assert.equal(payload.interruptionEvidence.state, "listening");
    assert.equal(payload.interruptionEvidence.qaChecklist.interruptionEvidence, true);
    assert.equal(payload.interruptionEvidence.envelope.relaySessionId, "local-rt-http-interrupt-proof");
    assert.deepEqual(
      payload.interruptionEvidence.relayEvents.map((event) => [event.type, event.reason]),
      [
        ["audio", undefined],
        ["clear", "barge-in"],
      ],
    );
    assert.deepEqual(payload.interruptionEvidence.diagnostics.at(-1), {
      type: "turn.cancelled",
      sessionId: "local-rt-http-interrupt-proof",
      relaySessionId: "local-rt-http-interrupt-proof",
      reason: "barge-in",
    });
    assert.deepEqual(
      payload.interruptionEvidence.timeline.slice(-2).map((event) => [event.source, event.type, event.reason]),
      [
        ["relay", "clear", "barge-in"],
        ["diagnostic", "turn.cancelled", "barge-in"],
      ],
    );
    assert.equal(payload.inputCancelEvidence.state, "idle");
    assert.equal(payload.inputCancelEvidence.qaChecklist.inputCancelEvidence, true);
    assert.deepEqual(payload.inputCancelEvidence.localSttMessages.map((message) => message.type), [
      "start",
      "audio",
      "cancel",
    ]);
    assert.equal(payload.inputCancelEvidence.diagnostics.some((event) => event.type === "transcript.done"), false);
    assert.deepEqual(payload.inputCancelEvidence.diagnostics.at(-1), {
      type: "input.cancelled",
      sessionId: "local-rt-http-input-cancel-proof",
      relaySessionId: "local-rt-http-input-cancel-proof",
      reason: "client",
    });
    assert.deepEqual(
      payload.inputCancelEvidence.timeline.slice(-2).map((event) => [event.source, event.type, event.reason]),
      [
        ["local-stt", "cancel", undefined],
        ["diagnostic", "input.cancelled", "client"],
      ],
    );
    assert.equal(payload.errorEvidence.state, "closed");
    assert.equal(payload.errorEvidence.qaChecklist.boundedErrorEvidence, true);
    assert.equal(payload.errorEvidence.envelope.relaySessionId, "local-rt-http-error-proof");
    assert.deepEqual(
      payload.errorEvidence.relayEvents.map((event) => [event.type, event.code ?? event.reason, event.retryable]),
      [
        ["error", "stream_warning", true],
        ["error", "stt_disconnected", false],
        ["close", "error", undefined],
      ],
    );
    assert.deepEqual(payload.errorEvidence.diagnostics.at(-2), {
      type: "session.error",
      sessionId: "local-rt-http-error-proof",
      relaySessionId: "local-rt-http-error-proof",
      code: "stt_disconnected",
      message: "local stt websocket closed before final transcript",
      retryable: false,
    });
    assert.deepEqual(payload.errorEvidence.diagnostics.at(-1), {
      type: "session.closed",
      sessionId: "local-rt-http-error-proof",
      relaySessionId: "local-rt-http-error-proof",
      reason: "error",
    });
    assert.deepEqual(
      payload.errorEvidence.timeline.slice(-5).map((event) => [event.source, event.type, event.code ?? event.reason]),
      [
        ["relay", "error", "stt_disconnected"],
        ["diagnostic", "session.error", "stt_disconnected"],
        ["local-stt", "close", undefined],
        ["relay", "close", "error"],
        ["diagnostic", "session.closed", "error"],
      ],
    );
    assert.equal(payload.invalidAudioResult.ok, false);
    assert.equal(payload.invalidAudioResult.code, "invalid_audio_frame");
    assert.equal(payload.invalidAudioResult.evidence.state, "idle");
    assert.equal(payload.invalidAudioResult.evidence.qaChecklist.boundedErrorEvidence, true);
    assert.equal(payload.invalidAudioResult.evidence.envelope.relaySessionId, "local-rt-http-invalid-audio-proof");
    assert.deepEqual(payload.invalidAudioResult.evidence.audioInput, {
      relayEncoding: "pcm16",
      relaySampleRateHz: 24000,
      localSttSampleRateHz: 16000,
      chunks: 0,
      bytesReceived: 0,
    });
    assert.deepEqual(payload.invalidAudioResult.evidence.localSttMessages, []);
    assert.deepEqual(payload.invalidAudioResult.evidence.relayEvents.at(-1), {
      relaySessionId: "local-rt-http-invalid-audio-proof",
      sessionId: "local-rt-http-invalid-audio-proof",
      type: "error",
      code: "invalid_audio_frame",
      message: "audioBase64 must be valid base64",
      retryable: true,
    });
    assert.deepEqual(payload.invalidAudioResult.evidence.diagnostics.at(-1), {
      type: "session.error",
      sessionId: "local-rt-http-invalid-audio-proof",
      relaySessionId: "local-rt-http-invalid-audio-proof",
      code: "invalid_audio_frame",
      message: "audioBase64 must be valid base64",
      retryable: true,
    });
  } finally {
    server.close();
  }
});
