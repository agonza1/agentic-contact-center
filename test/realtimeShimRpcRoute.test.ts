import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";
import { REALTIME_SHIM_RPCS } from "../src/core/realtimeShimContract";

async function postRpc(port: number, body: unknown): Promise<{ statusCode: number; payload: any }> {
  return new Promise((resolve, reject) => {
    const encodedBody = JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/realtime-shim/rpc",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(encodedBody),
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({ statusCode: response.statusCode ?? 0, payload: JSON.parse(responseBody) });
        });
      },
    );

    req.on("error", reject);
    req.end(encodedBody);
  });
}

test("POST /api/realtime-shim/rpc preserves session state across Gateway relay RPCs", async () => {
  const server = buildHttpServer(loadPocConfig());

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const created = await postRpc(address.port, {
      method: "talk.session.create",
      params: { mode: "realtime", transport: "gateway-relay", relaySessionId: "local-rt-rpc" },
    });

    assert.equal(created.statusCode, 200);
    assert.equal(created.payload.ok, true);
    assert.deepEqual(created.payload.result, {
      provider: "local-realtime-shim",
      transport: "gateway-relay",
      relaySessionId: "local-rt-rpc",
      sessionId: "local-rt-rpc",
      mode: "realtime",
      brain: "agent-consult",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 24000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
      model: "local-llm",
      voice: "kokoro",
      expiresAt: 0,
    });

    const audioBase64 = Buffer.from([1, 0, 2, 0]).toString("base64");
    const appended = await postRpc(address.port, {
      method: "talk.session.appendAudio",
      params: { sessionId: "local-rt-rpc", audioBase64, timestamp: 25 },
    });

    assert.equal(appended.statusCode, 200);
    assert.equal(appended.payload.ok, true);
    assert.equal(appended.payload.result.state, "listening");
    assert.deepEqual(appended.payload.result.localSttMessages.map((message: { type: string }) => message.type), [
      "start",
      "audio",
    ]);
    assert.deepEqual(appended.payload.result.audioInput, {
      relayEncoding: "pcm16",
      relaySampleRateHz: 24000,
      localSttSampleRateHz: 16000,
      chunks: 1,
      bytesReceived: 4,
      lastTimestamp: 25,
    });

    const finalized = await postRpc(address.port, {
      method: "talk.session.finalizeTurn",
      params: { sessionId: "local-rt-rpc", transcriptText: "Need a retention credit" },
    });

    assert.equal(finalized.statusCode, 200);
    assert.equal(finalized.payload.ok, true);
    assert.equal(finalized.payload.result.state, "speaking");
    assert.deepEqual(finalized.payload.result.localSttMessages.map((message: { type: string }) => message.type), [
      "start",
      "audio",
      "finalize",
    ]);
    assert.deepEqual(
      finalized.payload.result.diagnostics.map((event: { type: string }) => event.type),
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
    assert.equal(finalized.payload.result.qaChecklist.oneTurnEvidence, true);
    assert.deepEqual(finalized.payload.result.browserRelayCompatibility, {
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

    const evidenceSnapshot = await postRpc(address.port, {
      method: "talk.session.getEvidence",
      params: { sessionId: "local-rt-rpc" },
    });

    assert.equal(evidenceSnapshot.statusCode, 200);
    assert.equal(evidenceSnapshot.payload.ok, true);
    assert.equal(evidenceSnapshot.payload.result.state, "speaking");
    assert.deepEqual(evidenceSnapshot.payload.result.eventTranscript, finalized.payload.result.eventTranscript);
    assert.deepEqual(evidenceSnapshot.payload.result.latencyMarks, finalized.payload.result.latencyMarks);

    const cancelled = await postRpc(address.port, {
      method: "talk.session.cancelOutput",
      params: { sessionId: "local-rt-rpc", reason: "barge-in" },
    });

    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.payload.result.relayEvents.at(-1).type, "clear");
    assert.equal(cancelled.payload.result.qaChecklist.interruptionEvidence, true);

    const inputSession = await postRpc(address.port, {
      method: "talk.session.create",
      params: { mode: "realtime", transport: "gateway-relay", relaySessionId: "local-rt-rpc-input-cancel" },
    });

    assert.equal(inputSession.statusCode, 200);
    assert.equal(inputSession.payload.ok, true);

    const inputAudio = await postRpc(address.port, {
      method: "talk.session.appendAudio",
      params: { sessionId: "local-rt-rpc-input-cancel", audioBase64, timestamp: 50 },
    });

    assert.equal(inputAudio.statusCode, 200);
    assert.equal(inputAudio.payload.result.state, "listening");

    const inputCancelled = await postRpc(address.port, {
      method: "talk.session.cancelInput",
      params: { sessionId: "local-rt-rpc-input-cancel" },
    });

    assert.equal(inputCancelled.statusCode, 200);
    assert.equal(inputCancelled.payload.ok, true);
    assert.equal(inputCancelled.payload.result.state, "idle");
    assert.equal(inputCancelled.payload.result.localSttMessages.at(-1).type, "cancel");
    assert.equal(inputCancelled.payload.result.diagnostics.at(-1).type, "input.cancelled");
    assert.equal(inputCancelled.payload.result.qaChecklist.inputCancelEvidence, true);

    const recoverableError = await postRpc(address.port, {
      method: "talk.session.recordError",
      params: {
        sessionId: "local-rt-rpc",
        code: "stream_warning",
        message: "partial frame arrived late",
        retryable: true,
      },
    });

    assert.equal(recoverableError.statusCode, 200);
    assert.equal(recoverableError.payload.ok, true);
    assert.equal(recoverableError.payload.result.state, "listening");
    assert.equal(recoverableError.payload.result.relayEvents.at(-1).type, "error");
    assert.equal(recoverableError.payload.result.relayEvents.at(-1).code, "stream_warning");
    assert.equal(recoverableError.payload.result.qaChecklist.boundedErrorEvidence, true);

    const fatalSession = await postRpc(address.port, {
      method: "talk.session.create",
      params: { mode: "realtime", transport: "gateway-relay", relaySessionId: "local-rt-rpc-fatal-error" },
    });

    assert.equal(fatalSession.statusCode, 200);
    assert.equal(fatalSession.payload.ok, true);

    const fatalError = await postRpc(address.port, {
      method: "talk.session.recordError",
      params: {
        sessionId: "local-rt-rpc-fatal-error",
        code: "stt_disconnected",
        message: "Local STT stream disconnected",
        retryable: false,
      },
    });

    assert.equal(fatalError.statusCode, 200);
    assert.equal(fatalError.payload.ok, true);
    assert.equal(fatalError.payload.result.state, "closed");
    assert.deepEqual(
      fatalError.payload.result.relayEvents.map((event: { type: string }) => event.type),
      ["error", "close"],
    );
    assert.equal(fatalError.payload.result.relayEvents.at(-1).reason, "error");
    assert.equal(fatalError.payload.result.diagnostics.at(-1).type, "session.closed");
    assert.equal(fatalError.payload.result.qaChecklist.boundedErrorEvidence, true);

    const toolResult = await postRpc(address.port, {
      method: "talk.session.submitToolResult",
      params: { sessionId: "local-rt-rpc", toolCallId: "tool-1", result: { approved: false } },
    });

    assert.equal(toolResult.statusCode, 200);
    assert.deepEqual(toolResult.payload.result.toolResults, [
      {
        sessionId: "local-rt-rpc",
        toolCallId: "tool-1",
        result: { approved: false },
        status: "not_applicable",
      },
    ]);

    const closed = await postRpc(address.port, {
      method: "talk.session.close",
      params: { sessionId: "local-rt-rpc", reason: "complete" },
    });

    assert.equal(closed.statusCode, 200);
    assert.equal(closed.payload.result.state, "closed");
    assert.equal(closed.payload.result.relayEvents.at(-1).type, "close");

    const appendClosed = await postRpc(address.port, {
      method: "talk.session.appendAudio",
      params: { sessionId: "local-rt-rpc", audioBase64 },
    });

    assert.equal(appendClosed.statusCode, 400);
    assert.equal(appendClosed.payload.ok, false);
    assert.equal(appendClosed.payload.error, "realtime_shim_rpc_error");
    assert.equal(appendClosed.payload.method, "talk.session.appendAudio");
    assert.match(appendClosed.payload.message, /closed/);
    assert.deepEqual(appendClosed.payload.rpcCompatibility, {
      route: "POST /api/realtime-shim/rpc",
      supportedRpcs: REALTIME_SHIM_RPCS,
      statefulSession: true,
      boundedErrors: true,
    });
  } finally {
    server.close();
  }
});

test("POST /api/realtime-shim/rpc echoes request ids on success and bounded errors", async () => {
  const server = buildHttpServer(loadPocConfig());

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const created = await postRpc(address.port, {
      id: "relay-create-1",
      method: "talk.session.create",
      params: { relaySessionId: "local-rt-correlated" },
    });

    assert.equal(created.statusCode, 200);
    assert.equal(created.payload.ok, true);
    assert.equal(created.payload.requestId, "relay-create-1");
    assert.equal(created.payload.result.sessionId, "local-rt-correlated");

    const unsupported = await postRpc(address.port, {
      requestId: 42,
      method: "talk.session.flush",
      params: {},
    });

    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.payload.ok, false);
    assert.equal(unsupported.payload.requestId, 42);
    assert.equal(unsupported.payload.method, "talk.session.flush");
    assert.equal(unsupported.payload.error, "realtime_shim_method_unsupported");
  } finally {
    server.close();
  }
});

test("POST /api/realtime-shim/rpc returns bounded errors for unsupported payloads", async () => {
  const server = buildHttpServer(loadPocConfig());

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const missingMethod = await postRpc(address.port, { params: {} });
    assert.equal(missingMethod.statusCode, 400);
    assert.deepEqual(missingMethod.payload, {
      ok: false,
      error: "realtime_shim_method_required",
      rpcCompatibility: {
        route: "POST /api/realtime-shim/rpc",
        supportedRpcs: REALTIME_SHIM_RPCS,
        statefulSession: true,
        boundedErrors: true,
      },
    });

    const unsupported = await postRpc(address.port, { method: "talk.session.flush", params: {} });
    assert.equal(unsupported.statusCode, 400);
    assert.deepEqual(unsupported.payload, {
      ok: false,
      error: "realtime_shim_method_unsupported",
      method: "talk.session.flush",
      rpcCompatibility: {
        route: "POST /api/realtime-shim/rpc",
        supportedRpcs: REALTIME_SHIM_RPCS,
        statefulSession: true,
        boundedErrors: true,
      },
    });

    const badShape = await postRpc(address.port, {
      method: "talk.session.create",
      params: { mode: "batch", transport: "gateway-relay" },
    });
    assert.equal(badShape.statusCode, 400);
    assert.deepEqual(badShape.payload, {
      ok: false,
      error: "realtime_shim_session_shape_invalid",
      method: "talk.session.create",
      rpcCompatibility: {
        route: "POST /api/realtime-shim/rpc",
        supportedRpcs: REALTIME_SHIM_RPCS,
        statefulSession: true,
        boundedErrors: true,
      },
    });
  } finally {
    server.close();
  }
});
