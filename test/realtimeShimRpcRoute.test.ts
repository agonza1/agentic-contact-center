import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

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
    assert.equal(finalized.payload.result.diagnostics.at(-3).type, "transcript.delta");
    assert.equal(finalized.payload.result.diagnostics.at(-2).type, "transcript.done");
    assert.equal(finalized.payload.result.diagnostics.at(-1).type, "output.audio.done");
    assert.equal(finalized.payload.result.qaChecklist.oneTurnEvidence, true);

    const cancelled = await postRpc(address.port, {
      method: "talk.session.cancelOutput",
      params: { sessionId: "local-rt-rpc", reason: "barge-in" },
    });

    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.payload.result.relayEvents.at(-1).type, "clear");
    assert.equal(cancelled.payload.result.qaChecklist.interruptionEvidence, true);

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
    assert.match(appendClosed.payload.message, /closed/);
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
    assert.deepEqual(missingMethod.payload, { ok: false, error: "realtime_shim_method_required" });

    const unsupported = await postRpc(address.port, { method: "talk.session.flush", params: {} });
    assert.equal(unsupported.statusCode, 400);
    assert.deepEqual(unsupported.payload, { ok: false, error: "realtime_shim_method_unsupported" });

    const badShape = await postRpc(address.port, {
      method: "talk.session.create",
      params: { mode: "batch", transport: "gateway-relay" },
    });
    assert.equal(badShape.statusCode, 400);
    assert.deepEqual(badShape.payload, { ok: false, error: "realtime_shim_session_shape_invalid" });
  } finally {
    server.close();
  }
});
