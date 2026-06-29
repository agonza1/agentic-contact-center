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
      evidence: {
        state: string;
        envelope: { provider: string; transport: string; relaySessionId: string; sessionId: string };
        audioInput: { relayEncoding: string; relaySampleRateHz: number; localSttSampleRateHz: number; chunks: number; bytesReceived: number; lastTimestamp?: number };
        localSttMessages: Array<{ type: string; version?: string; byteLength?: number }>;
        relayEvents: Array<{ type: string; audioBase64?: string }>;
        diagnostics: Array<{ type: string; relaySessionId: string; sessionId: string }>;
        latencyMarks: Array<{ name: string; elapsedMs: number; budgetMs: number; withinBudget: boolean }>;
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
      };
      inputCancelEvidence: {
        state: string;
        localSttMessages: Array<{ type: string }>;
        diagnostics: Array<{ type: string; reason?: string; relaySessionId: string; sessionId: string }>;
        timeline: Array<{ source: string; type: string; reason?: string }>;
      };
      errorEvidence: {
        state: string;
        envelope: { relaySessionId: string; sessionId: string };
        relayEvents: Array<{ type: string; code?: string; message?: string; retryable?: boolean; reason?: string }>;
        diagnostics: Array<{ type: string; code?: string; message?: string; retryable?: boolean; relaySessionId: string; sessionId: string; reason?: string }>;
        timeline: Array<{ source: string; type: string; code?: string; reason?: string }>;
      };
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/realtime-shim/proof");
    assert.equal(payload.issue, "agonza1/agentic-contact-center#85");
    assert.equal(payload.rpcBoundary, "gateway-relay");
    assert.equal(payload.localSttContract, "local-stt.v1");
    assert.equal(payload.evidence.state, "speaking");
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
  } finally {
    server.close();
  }
});
