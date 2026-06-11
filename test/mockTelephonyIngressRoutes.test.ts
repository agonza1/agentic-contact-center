import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

async function withServer<T>(run: (port: number) => Promise<T>): Promise<T> {
  const config = loadPocConfig();
  const server = buildHttpServer(config);

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    return await run(address.port);
  } finally {
    server.close();
  }
}

async function requestJson(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ statusCode: number; payload: unknown }> {
  const rawBody = body ? JSON.stringify(body) : undefined;

  const responseBody = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: rawBody
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(rawBody),
            }
          : undefined,
      },
      (response) => {
        let collected = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          collected += chunk;
        });
        response.on("end", () => {
          resolve({ statusCode: response.statusCode ?? 0, body: collected });
        });
      },
    );

    req.on("error", reject);
    if (rawBody) {
      req.write(rawBody);
    }
    req.end();
  });

  return {
    statusCode: responseBody.statusCode,
    payload: JSON.parse(responseBody.body),
  };
}

test("mocked telephony ingress bootstraps and returns seeded scenario metadata", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const startedPayload = started.payload as {
      session: { callId: string };
      scenario: { mode: string; policyProfile: string };
      events: Array<{ type: string }>;
    };

    assert.equal(started.statusCode, 201);
    assert.equal(startedPayload.session.callId, "demo-call-0001");
    assert.equal(startedPayload.scenario.mode, "mocked_telephony");
    assert.equal(startedPayload.scenario.policyProfile, "retention_safe_mode");
    assert.equal(startedPayload.events[0].type, "call_bootstrapped");

    const fetched = await requestJson(port, "GET", `/api/calls/${startedPayload.session.callId}`);
    assert.equal(fetched.statusCode, 200);
    assert.deepEqual(fetched.payload, started.payload);
  });
});

test("caller turns append to transcript in order", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;

    const firstTurn = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });
    assert.equal(firstTurn.statusCode, 200);

    const secondTurn = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });
    const secondPayload = secondTurn.payload as {
      flowState: string;
      transcript: Array<{ text: string }>;
      events: Array<{ type: string }>;
    };
    assert.equal(secondTurn.statusCode, 200);
    assert.equal(secondPayload.flowState, "diagnose");
    assert.deepEqual(secondPayload.transcript.map((turn) => turn.text), [
      "I want to cancel my policy today.",
      "The renewal increase is too high.",
    ]);

    const fetched = await requestJson(port, "GET", `/api/calls/${callId}`);
    const fetchedPayload = fetched.payload as {
      transcript: Array<unknown>;
      events: Array<{ type: string }>;
    };
    assert.equal(fetchedPayload.transcript.length, 2);
    assert.equal(fetchedPayload.events.at(-1)?.type, "caller_turn_appended");
  });
});

test("unknown calls and invalid caller turns are rejected", async () => {
  await withServer(async (port) => {
    const missing = await requestJson(port, "GET", "/api/calls/does-not-exist");
    assert.equal(missing.statusCode, 404);

    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;
    const invalid = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "   ",
    });
    const invalidPayload = invalid.payload as { error: string };
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalidPayload.error, "caller_turn_text_required");
  });
});
