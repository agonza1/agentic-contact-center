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
        localSttMessages: Array<{ type: string; version?: string; byteLength?: number }>;
        relayEvents: Array<{ type: string; audioBase64?: string }>;
        diagnostics: Array<{ type: string; relaySessionId: string; sessionId: string }>;
      };
      interruptionEvidence: {
        state: string;
        envelope: { relaySessionId: string; sessionId: string };
        relayEvents: Array<{ type: string; reason?: string }>;
        diagnostics: Array<{ type: string; reason?: string; relaySessionId: string; sessionId: string }>;
        timeline: Array<{ source: string; type: string; reason?: string }>;
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
    assert.deepEqual(
      payload.evidence.localSttMessages.map((message) => message.type),
      ["start", "audio", "finalize"],
    );
    assert.equal(payload.evidence.localSttMessages[0].version, "local-stt.v1");
    assert.equal(payload.evidence.localSttMessages[1].byteLength, 8);
    assert.deepEqual(payload.evidence.relayEvents.map((event) => event.type), ["audio"]);
    assert.ok(
      payload.evidence.diagnostics.every(
        (event) => event.relaySessionId === "local-rt-http-proof" && event.sessionId === "local-rt-http-proof",
      ),
    );
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
  } finally {
    server.close();
  }
});
