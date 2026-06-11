import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

interface ScriptedWrapPayload {
  flowState: string;
  transcript: Array<{ speaker: string; text: string }>;
  pipecatFlow: { script: { matchedCallerTurns: number; completed: boolean } };
  events: Array<{ type: string }>;
}

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
      pipecatFlow: { ready: boolean; toolCoverage: string[] };
      events: Array<{ type: string }>;
    };

    assert.equal(started.statusCode, 201);
    assert.equal(startedPayload.session.callId, "demo-call-0001");
    assert.equal(startedPayload.scenario.mode, "mocked_telephony");
    assert.equal(startedPayload.scenario.policyProfile, "retention_safe_mode");
    assert.equal(startedPayload.pipecatFlow.ready, true);
    assert.equal(startedPayload.pipecatFlow.toolCoverage.includes("ask_operator"), true);
    assert.equal(startedPayload.events[0].type, "call_bootstrapped");

    const fetched = await requestJson(port, "GET", `/api/calls/${startedPayload.session.callId}`);
    assert.equal(fetched.statusCode, 200);
    assert.deepEqual(fetched.payload, started.payload);
  });
});

test("the risky offer boundary parks the flow in policy hold without promising a credit", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;

    const firstTurn = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });
    const firstPayload = firstTurn.payload as {
      flowState: string;
      transcript: Array<{ speaker: string; text: string }>;
    };
    assert.equal(firstTurn.statusCode, 200);
    assert.equal(firstPayload.flowState, "diagnose");
    assert.deepEqual(firstPayload.transcript.map((turn) => turn.speaker), ["caller", "agent"]);

    const secondTurn = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });
    const secondPayload = secondTurn.payload as {
      flowState: string;
      transcript: Array<{ speaker: string; text: string }>;
      events: Array<{ type: string }>;
    };
    assert.equal(secondTurn.statusCode, 200);
    assert.equal(secondPayload.flowState, "policy_hold");
    assert.equal(secondPayload.events.some((event) => event.type === "policy_hold_entered"), true);

    const lastAgentTurn = [...secondPayload.transcript].reverse().find((turn) => turn.speaker === "agent");
    assert.ok(lastAgentTurn);
    assert.equal(lastAgentTurn.text.toLowerCase().includes("credit"), false);
  });
});

test("the seeded scripted conversation progresses to a safe deterministic wrap", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;

    const scriptedTurns = [
      ["I want to cancel my policy today.", "2026-06-10T14:00:00.000Z"],
      ["The renewal increase is too high.", "2026-06-10T14:00:05.000Z"],
      ["Okay, what safe options can you review for me?", "2026-06-10T14:00:10.000Z"],
      ["Thanks, please note that follow-up and close the call.", "2026-06-10T14:00:15.000Z"],
    ] as const;

    let latestPayload: ScriptedWrapPayload | null = null;

    for (const [text, timestamp] of scriptedTurns) {
      const response = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, { text, timestamp });
      assert.equal(response.statusCode, 200);
      latestPayload = response.payload as ScriptedWrapPayload;
    }

    assert.ok(latestPayload);
    assert.equal(latestPayload.flowState, "wrap");
    assert.equal(latestPayload.pipecatFlow.script.matchedCallerTurns, 4);
    assert.equal(latestPayload.pipecatFlow.script.completed, true);
    assert.equal(latestPayload.events.some((event) => event.type === "operator_steer_requested"), true);

    const agentTurns = latestPayload.transcript.filter((turn) => turn.speaker === "agent");
    const steeredResponse = agentTurns.find((turn) => turn.text.includes("will not promise any billing credit"));
    assert.ok(steeredResponse);
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

test("off-script caller turns pause the prototype for operator guidance", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;

    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });

    const divergentTurn = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Actually I just need to update my address.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });
    const divergentPayload = divergentTurn.payload as {
      flowState: string;
      pipecatFlow: { activeTool: string | null; script: { matchedCallerTurns: number; completed: boolean } };
      transcript: Array<{ speaker: string; text: string }>;
      events: Array<{ type: string }>;
    };

    assert.equal(divergentTurn.statusCode, 200);
    assert.equal(divergentPayload.flowState, "policy_hold");
    assert.equal(divergentPayload.pipecatFlow.activeTool, "ask_operator");
    assert.equal(divergentPayload.pipecatFlow.script.matchedCallerTurns, 1);
    assert.equal(divergentPayload.pipecatFlow.script.completed, false);
    assert.equal(divergentPayload.events.some((event) => event.type === "script_diverged"), true);

    const lastAgentTurn = [...divergentPayload.transcript].reverse().find((turn) => turn.speaker === "agent");
    assert.ok(lastAgentTurn);
    assert.equal(lastAgentTurn.text.toLowerCase().includes("requesting operator guidance"), true);
  });
});
