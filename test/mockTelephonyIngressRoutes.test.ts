import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

interface SnapshotPayload {
  flowState: string;
  transcript: Array<{ speaker: string; text: string }>;
  demoFallback: {
    armed: boolean;
    reason: string | null;
    mode: string | null;
    armedAt: string | null;
    disarmedAt: string | null;
  };
  operatorSteer: {
    pending: boolean;
    lastAction: string | null;
    lastReason: string | null;
    requestedAt: string | null;
    respondedAt: string | null;
    source: string | null;
  };
  pipecatFlow: {
    activeTool: string | null;
    script: { matchedCallerTurns: number; completed: boolean };
  };
  events: Array<{ type: string; detail: Record<string, string | number | boolean | null> }>;
  latencyMarks: Array<{ stage: string; budgetMs: number | null }>;
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

async function requestRaw(
  port: number,
  method: string,
  path: string,
  rawBody?: string,
): Promise<{ statusCode: number; payload: unknown }> {
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

async function requestJson(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ statusCode: number; payload: unknown }> {
  return requestRaw(port, method, path, body ? JSON.stringify(body) : undefined);
}

test("mocked telephony ingress bootstraps and returns seeded scenario metadata", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "heartbeat-session-42",
      openclawSessionLabel: "cluecon-demo/live-call",
    });
    const startedPayload = started.payload as {
      session: {
        callId: string;
        openclawSession: { sessionId: string; label: string; status: string; eventTrailVersion: number };
      };
      scenario: { mode: string; policyProfile: string; fallbackMode: string };
      demoFallback: { armed: boolean; reason: string | null; mode: string | null; armedAt: string | null; disarmedAt: string | null };
      operatorSteer: {
        pending: boolean;
        lastAction: string | null;
        lastReason: string | null;
        requestedAt: string | null;
        respondedAt: string | null;
        source: string | null;
      };
      pipecatFlow: { ready: boolean; toolCoverage: string[] };
      events: Array<{ type: string }>;
      latencyMarks: Array<{ stage: string; budgetMs: number | null }>;
    };

    assert.equal(started.statusCode, 201);
    assert.equal(startedPayload.session.callId, "demo-call-0001");
    assert.equal(startedPayload.session.openclawSession.sessionId, "heartbeat-session-42");
    assert.equal(startedPayload.session.openclawSession.label, "cluecon-demo/live-call");
    assert.equal(startedPayload.session.openclawSession.status, "attached_mock");
    assert.equal(startedPayload.session.openclawSession.eventTrailVersion, 1);
    assert.equal(startedPayload.scenario.mode, "mocked_telephony");
    assert.equal(startedPayload.scenario.policyProfile, "retention_safe_mode");
    assert.equal(startedPayload.scenario.fallbackMode, "tool_timeout");
    assert.equal(startedPayload.pipecatFlow.ready, true);
    assert.equal(startedPayload.pipecatFlow.toolCoverage.includes("ask_operator"), true);
    assert.deepEqual(startedPayload.events.map((event) => event.type).slice(0, 2), [
      "call_bootstrapped",
      "openclaw_session_attached",
    ]);
    assert.deepEqual(startedPayload.demoFallback, {
      armed: false,
      reason: null,
      mode: null,
      armedAt: null,
      disarmedAt: null,
      source: null,
    });
    assert.deepEqual(startedPayload.operatorSteer, {
      pending: false,
      lastAction: null,
      lastReason: null,
      requestedAt: null,
      respondedAt: null,
      source: null,
    });
    assert.deepEqual(
      startedPayload.latencyMarks.map((mark) => ({ stage: mark.stage, budgetMs: mark.budgetMs })),
      [
        {
          stage: "call_bootstrapped",
          budgetMs: null,
        },
      ],
    );

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
    const firstPayload = firstTurn.payload as SnapshotPayload;
    assert.equal(firstTurn.statusCode, 200);
    assert.equal(firstPayload.flowState, "diagnose");
    assert.deepEqual(firstPayload.transcript.map((turn) => turn.speaker), ["caller", "agent"]);

    const secondTurn = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });
    const secondPayload = secondTurn.payload as SnapshotPayload;
    assert.equal(secondTurn.statusCode, 200);
    assert.equal(secondPayload.flowState, "policy_hold");
    assert.equal(secondPayload.events.some((event) => event.type === "policy_hold_entered"), true);
    assert.equal(secondPayload.latencyMarks.some((mark) => mark.stage === "policy_hold_entered" && mark.budgetMs === 1500), true);

    const lastAgentTurn = [...secondPayload.transcript].reverse().find((turn) => turn.speaker === "agent");
    assert.ok(lastAgentTurn);
    assert.equal(lastAgentTurn.text.toLowerCase().includes("credit"), false);
  });
});

test("the scripted flow pauses for operator steer and resumes with an approved safe response", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;

    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });

    const pending = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Okay, what safe options can you review for me?",
      timestamp: "2026-06-10T14:00:10.000Z",
    });
    const pendingPayload = pending.payload as SnapshotPayload;
    assert.equal(pending.statusCode, 200);
    assert.equal(pendingPayload.flowState, "operator_steer");
    assert.equal(pendingPayload.events.some((event) => event.type === "operator_steer_requested"), true);
    assert.deepEqual(pendingPayload.operatorSteer, {
      pending: true,
      lastAction: "approve_offer",
      lastReason: "safe_offer_review_requested",
      requestedAt: "2026-06-10T14:00:10.000Z",
      respondedAt: null,
      source: "mock_http_route",
    });

    const steered = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "approve_offer",
      timestamp: "2026-06-10T14:00:11.000Z",
    });
    const steeredPayload = steered.payload as SnapshotPayload;
    assert.equal(steered.statusCode, 200);
    assert.equal(steeredPayload.flowState, "steered_response");
    assert.equal(steeredPayload.events.some((event) => event.type === "operator_steer_applied"), true);
    assert.equal(steeredPayload.transcript.some((turn) => turn.speaker === "operator"), true);
    assert.deepEqual(steeredPayload.operatorSteer, {
      pending: false,
      lastAction: "approve_offer",
      lastReason: null,
      requestedAt: "2026-06-10T14:00:10.000Z",
      respondedAt: "2026-06-10T14:00:11.000Z",
      source: "mock_http_route",
    });

    const safeAgentTurn = [...steeredPayload.transcript].reverse().find((turn) => turn.speaker === "agent");
    assert.ok(safeAgentTurn);
    assert.equal(safeAgentTurn.text.includes("will not promise any billing credit"), true);

    const wrapped = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Thanks, please note that follow-up and close the call.",
      timestamp: "2026-06-10T14:00:15.000Z",
    });
    const wrappedPayload = wrapped.payload as SnapshotPayload;
    assert.equal(wrapped.statusCode, 200);
    assert.equal(wrappedPayload.flowState, "wrap");
    assert.equal(wrappedPayload.pipecatFlow.script.matchedCallerTurns, 4);
    assert.equal(wrappedPayload.pipecatFlow.script.completed, true);
  });
});

test("an escalation steer triggers the human handoff path", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;

    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });

    const steered = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "escalate_to_human",
      timestamp: "2026-06-10T14:00:06.000Z",
    });
    const steeredPayload = steered.payload as SnapshotPayload;
    assert.equal(steered.statusCode, 200);
    assert.equal(steeredPayload.flowState, "wrap");
    assert.equal(steeredPayload.events.some((event) => event.type === "human_handoff_started"), true);
    const steerHandoff = steeredPayload.events.find((event) => event.type === "human_handoff_started");
    assert.ok(steerHandoff);
    assert.equal(steerHandoff.detail.source, "operator_steer");

    const lastAgentTurn = [...steeredPayload.transcript].reverse().find((turn) => turn.speaker === "agent");
    assert.ok(lastAgentTurn);
    assert.equal(lastAgentTurn.text.toLowerCase().includes("licensed retention specialist"), true);
  });
});


test("operators can arm and disarm demo fallback with visible rationale", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;

    const missingReason = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "arm_fallback",
    });
    const missingReasonPayload = missingReason.payload as { error: string };
    assert.equal(missingReason.statusCode, 400);
    assert.equal(missingReasonPayload.error, "operator_fallback_reason_required");

    const armed = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "arm_fallback",
      reason: "audio degraded during live demo",
      timestamp: "2026-06-10T14:00:01.000Z",
    });
    const armedPayload = armed.payload as SnapshotPayload;
    assert.equal(armed.statusCode, 200);
    assert.equal(armedPayload.demoFallback.armed, true);
    assert.equal(armedPayload.demoFallback.reason, "audio degraded during live demo");
    assert.equal(armedPayload.demoFallback.mode, null);
    assert.equal(armedPayload.events.some((event) => event.type === "demo_fallback_armed"), true);
    assert.equal(armedPayload.pipecatFlow.activeTool, "pause_presentation");

    const disarmed = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "disarm_fallback",
      timestamp: "2026-06-10T14:00:03.000Z",
    });
    const disarmedPayload = disarmed.payload as SnapshotPayload;
    assert.equal(disarmed.statusCode, 200);
    assert.equal(disarmedPayload.demoFallback.armed, false);
    assert.equal(disarmedPayload.demoFallback.reason, null);
    assert.equal(disarmedPayload.demoFallback.mode, null);
    assert.equal(disarmedPayload.demoFallback.disarmedAt, "2026-06-10T14:00:03.000Z");
    assert.equal(disarmedPayload.events.some((event) => event.type === "demo_fallback_disarmed"), true);
    assert.equal(disarmedPayload.pipecatFlow.activeTool, "ask_operator");
  });
});

test("malformed JSON requests fail with a client error instead of an internal error", async () => {
  await withServer(async (port) => {
    const invalid = await requestRaw(port, "POST", "/api/demo/start", '{"openclawSessionId":');
    const invalidPayload = invalid.payload as { error: string };

    assert.equal(invalid.statusCode, 400);
    assert.equal(invalidPayload.error, "invalid_json");
  });
});

test("demo start rejects non-object JSON payloads and invalid session envelope fields", async () => {
  await withServer(async (port) => {
    const scalarPayload = await requestRaw(port, "POST", "/api/demo/start", '"not-an-object"');
    const scalarError = scalarPayload.payload as { error: string };

    assert.equal(scalarPayload.statusCode, 400);
    assert.equal(scalarError.error, "json_object_required");

    const invalidSessionId = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: 42,
    });
    const invalidSessionIdPayload = invalidSessionId.payload as { error: string };

    assert.equal(invalidSessionId.statusCode, 400);
    assert.equal(invalidSessionIdPayload.error, "openclaw_session_id_invalid");

    const invalidSessionLabel = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionLabel: "   ",
    });
    const invalidSessionLabelPayload = invalidSessionLabel.payload as { error: string };

    assert.equal(invalidSessionLabel.statusCode, 400);
    assert.equal(invalidSessionLabelPayload.error, "openclaw_session_label_invalid");

    const trimmed = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "  heartbeat-session-99  ",
      openclawSessionLabel: "  cluecon-demo/validated-start  ",
    });
    const trimmedPayload = trimmed.payload as { session: { openclawSession: { sessionId: string; label: string } } };
    assert.equal(trimmedPayload.session.openclawSession.sessionId, "heartbeat-session-99");
    assert.equal(trimmedPayload.session.openclawSession.label, "cluecon-demo/validated-start");
  });
});

test("tool timeout fallback fails closed and records the fallback reason", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;

    const invalidMode = await requestJson(port, "POST", `/api/calls/${callId}/fallback`, {});
    const invalidModePayload = invalidMode.payload as { error: string };
    assert.equal(invalidMode.statusCode, 400);
    assert.equal(invalidModePayload.error, "fallback_mode_required");

    const unsupportedMode = await requestJson(port, "POST", `/api/calls/${callId}/fallback`, {
      mode: "operator_override",
    });
    const unsupportedModePayload = unsupportedMode.payload as { error: string };
    assert.equal(unsupportedMode.statusCode, 400);
    assert.equal(unsupportedModePayload.error, "fallback_mode_invalid");

    const fallback = await requestJson(port, "POST", `/api/calls/${callId}/fallback`, {
      mode: "tool_timeout",
      reason: "pipecat tool exceeded latency budget",
      timestamp: "2026-06-10T14:00:02.000Z",
    });
    const fallbackPayload = fallback.payload as SnapshotPayload;

    assert.equal(fallback.statusCode, 200);
    assert.equal(fallbackPayload.flowState, "wrap");
    assert.equal(fallbackPayload.demoFallback.armed, true);
    assert.equal(fallbackPayload.demoFallback.mode, "tool_timeout");
    assert.equal(fallbackPayload.demoFallback.reason, "pipecat tool exceeded latency budget");
    assert.equal(fallbackPayload.events.some((event) => event.type === "demo_fallback_triggered"), true);
    assert.equal(fallbackPayload.events.some((event) => event.type === "human_handoff_started"), true);
    const fallbackHandoff = fallbackPayload.events.find((event) => event.type === "human_handoff_started");
    assert.ok(fallbackHandoff);
    assert.equal(fallbackHandoff.detail.source, "tool_timeout_fail_closed");
    assert.equal(fallbackHandoff.detail.reason, "pipecat tool exceeded latency budget");

    const lastAgentTurn = [...fallbackPayload.transcript].reverse().find((turn) => turn.speaker === "agent");
    assert.ok(lastAgentTurn);
    assert.equal(lastAgentTurn.text.toLowerCase().includes("billing credit"), true);
    assert.equal(lastAgentTurn.text.toLowerCase().includes("tool timed out"), true);

    const fetched = await requestJson(port, "GET", `/api/calls/${callId}`);
    const fetchedPayload = fetched.payload as SnapshotPayload;
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetchedPayload.demoFallback.reason, "pipecat tool exceeded latency budget");
    assert.equal(fetchedPayload.demoFallback.mode, "tool_timeout");
  });
});

test("slack-style operator commands pause, redirect, and resume the scripted flow", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;

    const paused = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "pause",
      timestamp: "2026-06-10T14:00:01.000Z",
    });
    const pausedPayload = paused.payload as SnapshotPayload;
    assert.equal(paused.statusCode, 200);
    assert.equal(pausedPayload.flowState, "policy_hold");
    assert.equal(pausedPayload.events.some((event) => event.type === "operator_demo_paused"), true);
    assert.equal(pausedPayload.pipecatFlow.activeTool, "pause_presentation");

    const redirected = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "goto_slide",
      timestamp: "2026-06-10T14:00:02.000Z",
    });
    const redirectedPayload = redirected.payload as SnapshotPayload;
    assert.equal(redirected.statusCode, 200);
    assert.equal(redirectedPayload.flowState, "operator_steer");
    assert.equal(redirectedPayload.events.some((event) => event.type === "operator_slide_redirect_requested"), true);
    assert.equal(redirectedPayload.pipecatFlow.activeTool, "goto_slide");

    const reRequested = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "ask_operator",
      timestamp: "2026-06-10T14:00:02.500Z",
    });
    const reRequestedPayload = reRequested.payload as SnapshotPayload;
    assert.equal(reRequested.statusCode, 200);
    assert.equal(reRequestedPayload.flowState, "operator_steer");
    assert.equal(reRequestedPayload.events.some((event) => event.type === "operator_guidance_re_requested"), true);
    assert.equal(reRequestedPayload.pipecatFlow.activeTool, "ask_operator");

    const resumed = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "resume",
      timestamp: "2026-06-10T14:00:03.000Z",
    });
    const resumedPayload = resumed.payload as SnapshotPayload;
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumedPayload.flowState, "steered_response");
    assert.equal(resumedPayload.events.some((event) => event.type === "operator_steer_applied"), true);

    const lastAgentTurn = [...resumedPayload.transcript].reverse().find((turn) => turn.speaker === "agent");
    assert.ok(lastAgentTurn);
    assert.equal(lastAgentTurn.text.toLowerCase().includes("resume the approved script"), true);
  });
});

test("unknown calls and invalid operator steer requests are rejected", async () => {
  await withServer(async (port) => {
    const missing = await requestJson(port, "GET", "/api/calls/does-not-exist");
    assert.equal(missing.statusCode, 404);

    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;
    const invalidTurn = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "   ",
    });
    const invalidTurnPayload = invalidTurn.payload as { error: string };
    assert.equal(invalidTurn.statusCode, 400);
    assert.equal(invalidTurnPayload.error, "caller_turn_text_required");

    const invalidSteer = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {});
    const invalidSteerPayload = invalidSteer.payload as { error: string };
    assert.equal(invalidSteer.statusCode, 400);
    assert.equal(invalidSteerPayload.error, "operator_steer_action_required");

    const notPending = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "approve_offer",
    });
    const notPendingPayload = notPending.payload as { error: string };
    assert.equal(notPending.statusCode, 400);
    assert.equal(notPendingPayload.error, "operator_steer_not_pending");
  });
});


test("invalid route timestamps are rejected before mutating call state", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;

    const invalidTurn = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "not-a-timestamp",
    });
    const invalidTurnPayload = invalidTurn.payload as { error: string };
    assert.equal(invalidTurn.statusCode, 400);
    assert.equal(invalidTurnPayload.error, "caller_turn_timestamp_invalid");

    const invalidFallback = await requestJson(port, "POST", `/api/calls/${callId}/fallback`, {
      mode: "tool_timeout",
      timestamp: "not-a-timestamp",
    });
    const invalidFallbackPayload = invalidFallback.payload as { error: string };
    assert.equal(invalidFallback.statusCode, 400);
    assert.equal(invalidFallbackPayload.error, "fallback_timestamp_invalid");

    const invalidSteer = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "pause",
      timestamp: "not-a-timestamp",
    });
    const invalidSteerPayload = invalidSteer.payload as { error: string };
    assert.equal(invalidSteer.statusCode, 400);
    assert.equal(invalidSteerPayload.error, "operator_steer_timestamp_invalid");

    const fetched = await requestJson(port, "GET", `/api/calls/${callId}`);
    const fetchedPayload = fetched.payload as SnapshotPayload;
    assert.equal(fetched.statusCode, 200);
    assert.deepEqual(fetchedPayload.transcript, []);
    assert.equal(fetchedPayload.demoFallback.armed, false);
    assert.equal(fetchedPayload.operatorSteer.pending, false);
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
    const divergentPayload = divergentTurn.payload as SnapshotPayload;

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
