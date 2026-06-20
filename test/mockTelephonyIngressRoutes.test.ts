import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

interface SnapshotPayload {
  session: { callId: string };
  flowState: string;
  attention?: {
    required: boolean;
    source: string | null;
    reason: string | null;
    startedAt: string | null;
    ageMs: number | null;
  };
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

interface QueueSummaryPayload {
  summary: {
    totalCalls: number;
    pendingOperatorSteer: number;
    fallbackArmed: number;
    attentionRequired: number;
    oldestAttentionCallId: string | null;
    oldestAttentionProviderCallId: string | null;
    oldestAttentionOpenclawSessionId: string | null;
    oldestAttentionOpenclawSessionLabel: string | null;
    oldestAttentionAgeMs: number | null;
    oldestAttentionStartedAt: string | null;
    oldestAttentionFlowState: string | null;
    oldestAttentionReason: string | null;
    oldestAttentionSource: string | null;
    byFlowState: Record<string, number>;
  };
}

interface CallListPayload extends QueueSummaryPayload {
  calls: SnapshotPayload[];
  summary: QueueSummaryPayload["summary"] & {
    filteredCalls: number;
    returnedCalls: number;
    sort: "startedAt" | "attentionStartedAt";
    order: "asc" | "desc";
    page: {
      offset: number;
      limit: number | null;
      totalFilteredCalls: number;
      hasMore: boolean;
      nextOffset: number | null;
    };
    filteredSummary: QueueSummaryPayload["summary"];
  };
}

interface EventTrailPayload {
  callId: string;
  providerCallId: string;
  openclawSession: { sessionId: string; label: string; status: string };
  events: Array<{ type: string; at: string; detail: Record<string, string | number | boolean | null> }>;
  summary: {
    totalEvents: number;
    returnedEvents: number;
    filteredType: string | null;
    filteredSource: string | null;
    filteredSince: string | null;
    order: "asc" | "desc";
    page: {
      offset: number;
      limit: number | null;
      totalFilteredEvents: number;
      hasMore: boolean;
      nextOffset: number | null;
    };
    latestEventType: string | null;
    latestEventAt: string | null;
    lastReturnedEventType: string | null;
    lastReturnedEventAt: string | null;
  };
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
      attention: { required: boolean; source: string | null; reason: string | null; startedAt: string | null; ageMs: number | null };
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
    assert.deepEqual(startedPayload.attention, {
      required: false,
      source: null,
      reason: null,
      startedAt: null,
      ageMs: null,
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
    assert.deepEqual(secondPayload.attention, {
      required: false,
      source: null,
      reason: null,
      startedAt: null,
      ageMs: null,
    });
    assert.equal(secondPayload.events.some((event) => event.type === "policy_hold_entered"), true);
    assert.equal(secondPayload.latencyMarks.some((mark) => mark.stage === "policy_hold_entered" && mark.budgetMs === 1500), true);

    const lastAgentTurn = [...secondPayload.transcript].reverse().find((turn) => turn.speaker === "agent");
    assert.ok(lastAgentTurn);
    assert.equal(lastAgentTurn.text.toLowerCase().includes("credit"), false);
  });
});

test("GET /api/queue returns queue summary without call payloads", async () => {
  await withServer(async (port) => {
    const emptyQueue = await requestJson(port, "GET", "/api/queue");
    const emptyPayload = emptyQueue.payload as QueueSummaryPayload;

    assert.equal(emptyQueue.statusCode, 200);
    assert.deepEqual(emptyPayload, {
      summary: {
        totalCalls: 0,
        pendingOperatorSteer: 0,
        fallbackArmed: 0,
        attentionRequired: 0,
        oldestAttentionCallId: null,
        oldestAttentionProviderCallId: null,
        oldestAttentionOpenclawSessionId: null,
        oldestAttentionOpenclawSessionLabel: null,
        oldestAttentionAgeMs: null,
        oldestAttentionStartedAt: null,
        oldestAttentionFlowState: null,
        oldestAttentionReason: null,
        oldestAttentionSource: null,
        byFlowState: {
          call_started: 0,
          greet: 0,
          diagnose: 0,
          policy_hold: 0,
          operator_steer: 0,
          steered_response: 0,
          wrap: 0,
        },
      },
    });

    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Okay, what safe options can you review for me?",
      timestamp: "2026-06-10T14:00:10.000Z",
    });

    const queue = await requestJson(port, "GET", "/api/queue");
    const queuePayload = queue.payload as QueueSummaryPayload;

    assert.equal(queue.statusCode, 200);
    assert.equal(queuePayload.summary.totalCalls, 1);
    assert.equal(queuePayload.summary.pendingOperatorSteer, 1);
    assert.equal(queuePayload.summary.fallbackArmed, 0);
    assert.equal(queuePayload.summary.attentionRequired, 1);
    assert.equal(queuePayload.summary.oldestAttentionCallId, callId);
    assert.equal(queuePayload.summary.oldestAttentionProviderCallId, "mock-sw-call-001-0001");
    assert.equal(queuePayload.summary.oldestAttentionOpenclawSessionId, "openclaw-call-0001");
    assert.equal(queuePayload.summary.oldestAttentionOpenclawSessionLabel, "cluecon-2026-cancellation-rescue:demo-call-0001");
    assert.equal(typeof queuePayload.summary.oldestAttentionAgeMs, "number");
    assert.equal(queuePayload.summary.oldestAttentionFlowState, "operator_steer");
    assert.equal(queuePayload.summary.oldestAttentionReason, "safe_offer_review_requested");
    assert.equal(queuePayload.summary.oldestAttentionSource, "operator_steer");
    assert.deepEqual(queuePayload.summary.byFlowState, {
      call_started: 0,
      greet: 0,
      diagnose: 0,
      policy_hold: 0,
      operator_steer: 1,
      steered_response: 0,
      wrap: 0,
    });
  });
});

test("GET /api/queue orders oldest attention by timestamp value, not string format", async () => {
  await withServer(async (port) => {
    const firstStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "mixed-ts-1",
      openclawSessionLabel: "cluecon-demo/mixed-ts-1",
    });
    const firstCallId = (firstStarted.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${firstCallId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${firstCallId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${firstCallId}/caller-turn`, {
      text: "Okay, what safe options can you review for me?",
      timestamp: "2026-06-10T14:00:10.000Z",
    });

    const secondStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "mixed-ts-2",
      openclawSessionLabel: "cluecon-demo/mixed-ts-2",
    });
    const secondCallId = (secondStarted.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${secondCallId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "Wed, 10 Jun 2026 14:00:01 GMT",
    });
    await requestJson(port, "POST", `/api/calls/${secondCallId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "Wed, 10 Jun 2026 14:00:03 GMT",
    });
    await requestJson(port, "POST", `/api/calls/${secondCallId}/caller-turn`, {
      text: "Okay, what safe options can you review for me?",
      timestamp: "Wed, 10 Jun 2026 14:00:06 GMT",
    });

    const queue = await requestJson(port, "GET", "/api/queue");
    const queuePayload = queue.payload as QueueSummaryPayload;

    assert.equal(queue.statusCode, 200);
    assert.equal(queuePayload.summary.attentionRequired, 2);
    assert.equal(queuePayload.summary.oldestAttentionCallId, secondCallId);
    assert.equal(queuePayload.summary.oldestAttentionOpenclawSessionId, "mixed-ts-2");
    assert.equal(queuePayload.summary.oldestAttentionStartedAt, "Wed, 10 Jun 2026 14:00:06 GMT");
    assert.notEqual(queuePayload.summary.oldestAttentionCallId, firstCallId);
  });
});

test("GET /api/calls lists active demo calls in start order", async () => {
  await withServer(async (port) => {
    const emptyList = await requestJson(port, "GET", "/api/calls");
    const emptyPayload = emptyList.payload as CallListPayload;

    assert.equal(emptyList.statusCode, 200);
    assert.deepEqual(emptyPayload.calls, []);
    assert.deepEqual(emptyPayload.summary, {
      totalCalls: 0,
      filteredCalls: 0,
      returnedCalls: 0,
      sort: "startedAt",
      order: "asc",
      page: {
        offset: 0,
        limit: null,
        totalFilteredCalls: 0,
        hasMore: false,
        nextOffset: null,
      },
      pendingOperatorSteer: 0,
      fallbackArmed: 0,
      attentionRequired: 0,
      oldestAttentionCallId: null,
      oldestAttentionProviderCallId: null,
      oldestAttentionOpenclawSessionId: null,
      oldestAttentionOpenclawSessionLabel: null,
      oldestAttentionAgeMs: null,
      oldestAttentionStartedAt: null,
      oldestAttentionFlowState: null,
      oldestAttentionReason: null,
      oldestAttentionSource: null,
      byFlowState: {
        call_started: 0,
        greet: 0,
        diagnose: 0,
        policy_hold: 0,
        operator_steer: 0,
        steered_response: 0,
        wrap: 0,
      },
      filteredSummary: {
        totalCalls: 0,
        pendingOperatorSteer: 0,
        fallbackArmed: 0,
        attentionRequired: 0,
        oldestAttentionCallId: null,
        oldestAttentionProviderCallId: null,
        oldestAttentionOpenclawSessionId: null,
        oldestAttentionOpenclawSessionLabel: null,
        oldestAttentionAgeMs: null,
        oldestAttentionStartedAt: null,
        oldestAttentionFlowState: null,
        oldestAttentionReason: null,
        oldestAttentionSource: null,
        byFlowState: {
          call_started: 0,
          greet: 0,
          diagnose: 0,
          policy_hold: 0,
          operator_steer: 0,
          steered_response: 0,
          wrap: 0,
        },
      },
    });

    const firstStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "hb-session-01",
      openclawSessionLabel: "cluecon-demo/first",
    });
    const firstCallId = (firstStarted.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${firstCallId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });

    const secondStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "hb-session-02",
      openclawSessionLabel: "cluecon-demo/second",
    });
    const secondCallId = (secondStarted.payload as SnapshotPayload).session.callId;

    const listed = await requestJson(port, "GET", "/api/calls");
    const listedPayload = listed.payload as CallListPayload;

    assert.equal(listed.statusCode, 200);
    assert.equal(listedPayload.calls.length, 2);
    assert.deepEqual(listedPayload.calls.map((call) => call.session.callId), [firstCallId, secondCallId]);
    assert.equal(listedPayload.calls[0]?.transcript.length, 2);
    assert.equal(listedPayload.calls[0]?.flowState, "diagnose");
    assert.deepEqual(listedPayload.calls[0]?.attention, {
      required: false,
      source: null,
      reason: null,
      startedAt: null,
      ageMs: null,
    });
    assert.equal(listedPayload.calls[1]?.transcript.length, 0);
    assert.equal(listedPayload.calls[1]?.flowState, "call_started");
    assert.deepEqual(listedPayload.calls[1]?.attention, {
      required: false,
      source: null,
      reason: null,
      startedAt: null,
      ageMs: null,
    });
    assert.deepEqual(listedPayload.summary, {
      totalCalls: 2,
      filteredCalls: 2,
      returnedCalls: 2,
      sort: "startedAt",
      order: "asc",
      page: {
        offset: 0,
        limit: null,
        totalFilteredCalls: 2,
        hasMore: false,
        nextOffset: null,
      },
      pendingOperatorSteer: 0,
      fallbackArmed: 0,
      attentionRequired: 0,
      oldestAttentionCallId: null,
      oldestAttentionProviderCallId: null,
      oldestAttentionOpenclawSessionId: null,
      oldestAttentionOpenclawSessionLabel: null,
      oldestAttentionAgeMs: null,
      oldestAttentionStartedAt: null,
      oldestAttentionFlowState: null,
      oldestAttentionReason: null,
      oldestAttentionSource: null,
      byFlowState: {
        call_started: 1,
        greet: 0,
        diagnose: 1,
        policy_hold: 0,
        operator_steer: 0,
        steered_response: 0,
        wrap: 0,
      },
      filteredSummary: {
        totalCalls: 2,
        pendingOperatorSteer: 0,
        fallbackArmed: 0,
        attentionRequired: 0,
        oldestAttentionCallId: null,
        oldestAttentionProviderCallId: null,
        oldestAttentionOpenclawSessionId: null,
        oldestAttentionOpenclawSessionLabel: null,
        oldestAttentionAgeMs: null,
        oldestAttentionStartedAt: null,
        oldestAttentionFlowState: null,
        oldestAttentionReason: null,
        oldestAttentionSource: null,
        byFlowState: {
          call_started: 1,
          greet: 0,
          diagnose: 1,
          policy_hold: 0,
          operator_steer: 0,
          steered_response: 0,
          wrap: 0,
        },
      },
    });
  });
});


test("GET /api/calls can sort operator attention before idle calls", async () => {
  await withServer(async (port) => {
    const idleStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "sort-session-idle",
      openclawSessionLabel: "cluecon-demo/sort-idle",
    });
    const idleCallId = (idleStarted.payload as SnapshotPayload).session.callId;

    const operatorStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "sort-session-operator",
      openclawSessionLabel: "cluecon-demo/sort-operator",
    });
    const operatorCallId = (operatorStarted.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${operatorCallId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:10:00.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${operatorCallId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:10:05.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${operatorCallId}/caller-turn`, {
      text: "Okay, what safe options can you review for me?",
      timestamp: "2026-06-10T14:10:10.000Z",
    });

    const fallbackStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "sort-session-fallback",
      openclawSessionLabel: "cluecon-demo/sort-fallback",
    });
    const fallbackCallId = (fallbackStarted.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${fallbackCallId}/operator-steer`, {
      action: "arm_fallback",
      reason: "manual demo safety net",
      timestamp: "2026-06-10T14:05:00.000Z",
    });

    const defaultList = await requestJson(port, "GET", "/api/calls");
    const defaultPayload = defaultList.payload as CallListPayload;

    assert.equal(defaultList.statusCode, 200);
    assert.deepEqual(defaultPayload.calls.map((call) => call.session.callId), [
      idleCallId,
      operatorCallId,
      fallbackCallId,
    ]);

    const attentionSorted = await requestJson(port, "GET", "/api/calls?sort=attentionStartedAt");
    const attentionPayload = attentionSorted.payload as CallListPayload;

    assert.equal(attentionSorted.statusCode, 200);
    assert.deepEqual(attentionPayload.calls.map((call) => call.session.callId), [
      fallbackCallId,
      operatorCallId,
      idleCallId,
    ]);
    assert.deepEqual(attentionPayload.calls.map((call) => call.attention?.startedAt), [
      "2026-06-10T14:05:00.000Z",
      "2026-06-10T14:10:10.000Z",
      null,
    ]);
    assert.equal(attentionPayload.summary.totalCalls, 3);
    assert.equal(attentionPayload.summary.filteredCalls, 3);
    assert.equal(attentionPayload.summary.filteredSummary.oldestAttentionCallId, fallbackCallId);

    const newestAttentionFirst = await requestJson(port, "GET", "/api/calls?sort=attentionStartedAt&order=desc");
    const newestAttentionPayload = newestAttentionFirst.payload as CallListPayload;

    assert.equal(newestAttentionFirst.statusCode, 200);
    assert.deepEqual(newestAttentionPayload.calls.map((call) => call.session.callId), [
      idleCallId,
      operatorCallId,
      fallbackCallId,
    ]);
    assert.equal(newestAttentionPayload.summary.sort, "attentionStartedAt");
    assert.equal(newestAttentionPayload.summary.order, "desc");

    const invalidSort = await requestJson(port, "GET", "/api/calls?sort=attentionAge");
    assert.equal(invalidSort.statusCode, 400);
    assert.deepEqual(invalidSort.payload, { ok: false, error: "call_list_sort_invalid" });

    const invalidOrder = await requestJson(port, "GET", "/api/calls?order=latest");
    assert.equal(invalidOrder.statusCode, 400);
    assert.deepEqual(invalidOrder.payload, { ok: false, error: "call_list_order_invalid" });
  });
});

test("GET /api/calls can limit active demo call payloads", async () => {
  await withServer(async (port) => {
    const firstStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "limit-session-01",
      openclawSessionLabel: "cluecon-demo/limit-first",
    });
    const firstCallId = (firstStarted.payload as SnapshotPayload).session.callId;

    const secondStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "limit-session-02",
      openclawSessionLabel: "cluecon-demo/limit-second",
    });
    const secondCallId = (secondStarted.payload as SnapshotPayload).session.callId;

    const limited = await requestJson(port, "GET", "/api/calls?limit=1");
    const limitedPayload = limited.payload as CallListPayload;

    assert.equal(limited.statusCode, 200);
    assert.deepEqual(limitedPayload.calls.map((call) => call.session.callId), [firstCallId]);
    assert.equal(limitedPayload.summary.totalCalls, 2);
    assert.equal(limitedPayload.summary.filteredCalls, 2);
    assert.equal(limitedPayload.summary.returnedCalls, 1);
    assert.deepEqual(limitedPayload.summary.page, {
      offset: 0,
      limit: 1,
      totalFilteredCalls: 2,
      hasMore: true,
      nextOffset: 1,
    });
    assert.equal(limitedPayload.summary.filteredSummary.totalCalls, 2);

    const filteredLimited = await requestJson(port, "GET", "/api/calls?callId=" + secondCallId + "&limit=1");
    const filteredLimitedPayload = filteredLimited.payload as CallListPayload;

    assert.equal(filteredLimited.statusCode, 200);
    assert.deepEqual(filteredLimitedPayload.calls.map((call) => call.session.callId), [secondCallId]);
    assert.equal(filteredLimitedPayload.summary.totalCalls, 2);
    assert.equal(filteredLimitedPayload.summary.filteredCalls, 1);
    assert.equal(filteredLimitedPayload.summary.returnedCalls, 1);
    assert.deepEqual(filteredLimitedPayload.summary.page, {
      offset: 0,
      limit: 1,
      totalFilteredCalls: 1,
      hasMore: false,
      nextOffset: null,
    });
    assert.equal(filteredLimitedPayload.summary.filteredSummary.totalCalls, 1);

    const offsetLimited = await requestJson(port, "GET", "/api/calls?offset=1&limit=1");
    const offsetLimitedPayload = offsetLimited.payload as CallListPayload;

    assert.equal(offsetLimited.statusCode, 200);
    assert.deepEqual(offsetLimitedPayload.calls.map((call) => call.session.callId), [secondCallId]);
    assert.equal(offsetLimitedPayload.summary.totalCalls, 2);
    assert.equal(offsetLimitedPayload.summary.filteredCalls, 2);
    assert.equal(offsetLimitedPayload.summary.returnedCalls, 1);
    assert.deepEqual(offsetLimitedPayload.summary.page, {
      offset: 1,
      limit: 1,
      totalFilteredCalls: 2,
      hasMore: false,
      nextOffset: null,
    });
    assert.equal(offsetLimitedPayload.summary.filteredSummary.totalCalls, 2);

    const offsetOnly = await requestJson(port, "GET", "/api/calls?offset=1");
    const offsetOnlyPayload = offsetOnly.payload as CallListPayload;

    assert.equal(offsetOnly.statusCode, 200);
    assert.deepEqual(offsetOnlyPayload.calls.map((call) => call.session.callId), [secondCallId]);
    assert.equal(offsetOnlyPayload.summary.filteredCalls, 2);
    assert.equal(offsetOnlyPayload.summary.returnedCalls, 1);
    assert.deepEqual(offsetOnlyPayload.summary.page, {
      offset: 1,
      limit: null,
      totalFilteredCalls: 2,
      hasMore: false,
      nextOffset: null,
    });

    const invalidLimit = await requestJson(port, "GET", "/api/calls?limit=0");
    assert.equal(invalidLimit.statusCode, 400);
    assert.deepEqual(invalidLimit.payload, { ok: false, error: "call_list_limit_invalid" });

    const invalidOffset = await requestJson(port, "GET", "/api/calls?offset=slow");
    assert.equal(invalidOffset.statusCode, 400);
    assert.deepEqual(invalidOffset.payload, { ok: false, error: "call_list_offset_invalid" });
  });
});

test("GET /api/calls can filter the active demo call list by flow state", async () => {
  await withServer(async (port) => {
    const firstStarted = await requestJson(port, "POST", "/api/demo/start");
    const firstCallId = (firstStarted.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${firstCallId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${firstCallId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });

    await requestJson(port, "POST", "/api/demo/start");

    const filtered = await requestJson(port, "GET", "/api/calls?flowState=policy_hold");
    const filteredPayload = filtered.payload as CallListPayload;

    assert.equal(filtered.statusCode, 200);
    assert.deepEqual(filteredPayload.calls.map((call) => call.session.callId), [firstCallId]);
    assert.deepEqual(filteredPayload.calls.map((call) => call.flowState), ["policy_hold"]);
    assert.equal(filteredPayload.summary.totalCalls, 2);
    assert.equal(filteredPayload.summary.filteredCalls, 1);
    assert.equal(filteredPayload.summary.filteredSummary.oldestAttentionAgeMs, null);
    assert.equal(filteredPayload.summary.filteredSummary.totalCalls, 1);
    assert.equal(filteredPayload.summary.filteredSummary.oldestAttentionOpenclawSessionId, null);
    assert.equal(filteredPayload.summary.byFlowState.policy_hold, 1);

    const invalidFilter = await requestJson(port, "GET", "/api/calls?flowState=paused_forever");
    assert.equal(invalidFilter.statusCode, 400);
    assert.deepEqual(invalidFilter.payload, {
      ok: false,
      error: "call_list_flow_state_invalid",
    });
  });
});

test("GET /api/calls can filter operator attention queues", async () => {
  await withServer(async (port) => {
    const pendingStarted = await requestJson(port, "POST", "/api/demo/start");
    const pendingCallId = (pendingStarted.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${pendingCallId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${pendingCallId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${pendingCallId}/caller-turn`, {
      text: "Okay, what safe options can you review for me?",
      timestamp: "2026-06-10T14:00:10.000Z",
    });

    const fallbackStarted = await requestJson(port, "POST", "/api/demo/start");
    const fallbackCallId = (fallbackStarted.payload as SnapshotPayload).session.callId;
    await requestJson(port, "POST", `/api/calls/${fallbackCallId}/operator-steer`, {
      action: "arm_fallback",
      reason: "audio degraded during live demo",
      timestamp: "2026-06-10T14:00:11.000Z",
    });

    await requestJson(port, "POST", "/api/demo/start");

    const pendingOnly = await requestJson(port, "GET", "/api/calls?pendingOperatorSteer=true");
    const pendingPayload = pendingOnly.payload as CallListPayload;
    assert.equal(pendingOnly.statusCode, 200);
    assert.deepEqual(pendingPayload.calls.map((call) => call.session.callId), [pendingCallId]);
    assert.equal(pendingPayload.calls[0]?.attention?.required, true);
    assert.equal(pendingPayload.calls[0]?.attention?.source, "operator_steer");
    assert.equal(pendingPayload.calls[0]?.attention?.reason, "safe_offer_review_requested");
    assert.equal(pendingPayload.calls[0]?.attention?.startedAt, "2026-06-10T14:00:10.000Z");
    assert.equal(typeof pendingPayload.calls[0]?.attention?.ageMs, "number");
    assert.equal(pendingPayload.summary.totalCalls, 3);
    assert.equal(pendingPayload.summary.filteredCalls, 1);
    assert.equal(pendingPayload.summary.pendingOperatorSteer, 1);
    assert.equal(pendingPayload.summary.oldestAttentionCallId, pendingCallId);
    assert.equal(pendingPayload.summary.oldestAttentionProviderCallId, "mock-sw-call-001-0001");
    assert.equal(pendingPayload.summary.oldestAttentionOpenclawSessionId, "openclaw-call-0001");
    assert.equal(pendingPayload.summary.oldestAttentionOpenclawSessionLabel, "cluecon-2026-cancellation-rescue:demo-call-0001");
    assert.equal(typeof pendingPayload.summary.oldestAttentionAgeMs, "number");
    assert.equal(typeof pendingPayload.summary.oldestAttentionStartedAt, "string");
    assert.equal(pendingPayload.summary.oldestAttentionFlowState, "operator_steer");
    assert.equal(pendingPayload.summary.oldestAttentionReason, "safe_offer_review_requested");
    assert.equal(pendingPayload.summary.oldestAttentionSource, "operator_steer");

    const fallbackOnly = await requestJson(port, "GET", "/api/calls?fallbackArmed=true");
    const fallbackPayload = fallbackOnly.payload as CallListPayload;
    assert.equal(fallbackOnly.statusCode, 200);
    assert.deepEqual(fallbackPayload.calls.map((call) => call.session.callId), [fallbackCallId]);
    assert.equal(fallbackPayload.calls[0]?.attention?.required, true);
    assert.equal(fallbackPayload.calls[0]?.attention?.source, "fallback");
    assert.equal(fallbackPayload.calls[0]?.attention?.reason, "audio degraded during live demo");
    assert.equal(fallbackPayload.calls[0]?.attention?.startedAt, "2026-06-10T14:00:11.000Z");
    assert.equal(typeof fallbackPayload.calls[0]?.attention?.ageMs, "number");
    assert.equal(fallbackPayload.summary.fallbackArmed, 1);
    assert.equal(fallbackPayload.summary.attentionRequired, 2);
    assert.equal(fallbackPayload.summary.oldestAttentionCallId, pendingCallId);
    assert.equal(fallbackPayload.summary.oldestAttentionProviderCallId, "mock-sw-call-001-0001");
    assert.equal(fallbackPayload.summary.oldestAttentionOpenclawSessionId, "openclaw-call-0001");
    assert.equal(fallbackPayload.summary.oldestAttentionOpenclawSessionLabel, "cluecon-2026-cancellation-rescue:demo-call-0001");
    assert.equal(typeof fallbackPayload.summary.oldestAttentionAgeMs, "number");
    assert.equal(fallbackPayload.summary.oldestAttentionFlowState, "operator_steer");
    assert.equal(fallbackPayload.summary.oldestAttentionReason, "safe_offer_review_requested");
    assert.equal(fallbackPayload.summary.oldestAttentionSource, "operator_steer");

    const attentionOnly = await requestJson(port, "GET", "/api/calls?attentionRequired=true");
    const attentionPayload = attentionOnly.payload as CallListPayload;
    assert.equal(attentionOnly.statusCode, 200);
    assert.deepEqual(attentionPayload.calls.map((call) => call.session.callId), [pendingCallId, fallbackCallId]);
    assert.equal(attentionPayload.calls.every((call) => call.attention?.required === true), true);
    assert.equal(attentionPayload.summary.filteredCalls, 2);
    assert.equal(attentionPayload.summary.attentionRequired, 2);
    assert.equal(attentionPayload.summary.oldestAttentionCallId, pendingCallId);
    assert.equal(attentionPayload.summary.oldestAttentionProviderCallId, "mock-sw-call-001-0001");
    assert.equal(attentionPayload.summary.oldestAttentionOpenclawSessionId, "openclaw-call-0001");
    assert.equal(attentionPayload.summary.oldestAttentionOpenclawSessionLabel, "cluecon-2026-cancellation-rescue:demo-call-0001");
    assert.equal(typeof attentionPayload.summary.oldestAttentionAgeMs, "number");
    assert.equal(attentionPayload.summary.oldestAttentionFlowState, "operator_steer");
    assert.equal(attentionPayload.summary.oldestAttentionReason, "safe_offer_review_requested");
    assert.equal(attentionPayload.summary.oldestAttentionSource, "operator_steer");

    const staleAttention = await requestJson(port, "GET", "/api/calls?minAttentionAgeMs=1");
    const stalePayload = staleAttention.payload as CallListPayload;
    assert.equal(staleAttention.statusCode, 200);
    assert.deepEqual(stalePayload.calls.map((call) => call.session.callId), [pendingCallId, fallbackCallId]);
    assert.equal(stalePayload.summary.filteredCalls, 2);

    const noStaleAttention = await requestJson(port, "GET", "/api/calls?minAttentionAgeMs=999999999999999");
    const noStalePayload = noStaleAttention.payload as CallListPayload;
    assert.equal(noStaleAttention.statusCode, 200);
    assert.deepEqual(noStalePayload.calls.map((call) => call.session.callId), []);
    assert.equal(noStalePayload.summary.filteredSummary.totalCalls, 0);

    const notAttention = await requestJson(port, "GET", "/api/calls?attentionRequired=false");
    const notAttentionPayload = notAttention.payload as CallListPayload;
    assert.equal(notAttention.statusCode, 200);
    assert.deepEqual(notAttentionPayload.calls.map((call) => call.session.callId), ["demo-call-0003"]);

    const combined = await requestJson(
      port,
      "GET",
      "/api/calls?flowState=policy_hold&pendingOperatorSteer=false&fallbackArmed=true",
    );
    const combinedPayload = combined.payload as CallListPayload;
    assert.equal(combined.statusCode, 200);
    assert.deepEqual(combinedPayload.calls.map((call) => call.session.callId), [fallbackCallId]);
    assert.deepEqual(combinedPayload.summary.byFlowState, {
      call_started: 1,
      greet: 0,
      diagnose: 0,
      policy_hold: 1,
      operator_steer: 1,
      steered_response: 0,
      wrap: 0,
    });

    const invalidPending = await requestJson(port, "GET", "/api/calls?pendingOperatorSteer=maybe");
    assert.equal(invalidPending.statusCode, 400);
    assert.deepEqual(invalidPending.payload, {
      ok: false,
      error: "call_list_pending_operator_steer_invalid",
    });

    const invalidFallback = await requestJson(port, "GET", "/api/calls?fallbackArmed=sometimes");
    assert.equal(invalidFallback.statusCode, 400);
    assert.deepEqual(invalidFallback.payload, {
      ok: false,
      error: "call_list_fallback_armed_invalid",
    });

    const invalidAttention = await requestJson(port, "GET", "/api/calls?attentionRequired=loudly");
    assert.equal(invalidAttention.statusCode, 400);
    assert.deepEqual(invalidAttention.payload, {
      ok: false,
      error: "call_list_attention_required_invalid",
    });

    const invalidMinAge = await requestJson(port, "GET", "/api/calls?minAttentionAgeMs=slow");
    assert.equal(invalidMinAge.statusCode, 400);
    assert.deepEqual(invalidMinAge.payload, {
      ok: false,
      error: "call_list_min_attention_age_ms_invalid",
    });
  });
});

test("GET /api/queue can filter operator summary slices", async () => {
  await withServer(async (port) => {
    const firstStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "hb-session-01",
      openclawSessionLabel: "cluecon-demo/first",
    });
    const firstCallId = (firstStarted.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${firstCallId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${firstCallId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${firstCallId}/caller-turn`, {
      text: "Okay, what safe options can you review for me?",
      timestamp: "2026-06-10T14:00:10.000Z",
    });

    await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "hb-session-02",
      openclawSessionLabel: "cluecon-demo/second",
    });

    const fallbackStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "hb-session-03",
      openclawSessionLabel: "cluecon-demo/third",
    });
    const fallbackCallId = (fallbackStarted.payload as SnapshotPayload).session.callId;
    await requestJson(port, "POST", `/api/calls/${fallbackCallId}/operator-steer`, {
      action: "arm_fallback",
      reason: "audio degraded during live demo",
      timestamp: "2026-06-10T14:00:11.000Z",
    });

    const pendingOnly = await requestJson(port, "GET", "/api/queue?pendingOperatorSteer=true");
    const pendingPayload = pendingOnly.payload as QueueSummaryPayload;
    assert.equal(pendingOnly.statusCode, 200);
    assert.equal(pendingPayload.summary.totalCalls, 1);
    assert.equal(pendingPayload.summary.pendingOperatorSteer, 1);
    assert.equal(pendingPayload.summary.fallbackArmed, 0);
    assert.equal(pendingPayload.summary.attentionRequired, 1);
    assert.equal(pendingPayload.summary.oldestAttentionCallId, firstCallId);

    const fallbackOnly = await requestJson(port, "GET", "/api/queue?fallbackArmed=true");
    const fallbackPayload = fallbackOnly.payload as QueueSummaryPayload;
    assert.equal(fallbackOnly.statusCode, 200);
    assert.equal(fallbackPayload.summary.totalCalls, 1);
    assert.equal(fallbackPayload.summary.pendingOperatorSteer, 0);
    assert.equal(fallbackPayload.summary.fallbackArmed, 1);
    assert.equal(fallbackPayload.summary.attentionRequired, 1);
    assert.equal(fallbackPayload.summary.oldestAttentionCallId, fallbackCallId);
    assert.equal(fallbackPayload.summary.oldestAttentionSource, "fallback");

    const attentionRequiredOnly = await requestJson(port, "GET", "/api/queue?attentionRequired=true");
    const attentionRequiredPayload = attentionRequiredOnly.payload as QueueSummaryPayload;
    assert.equal(attentionRequiredOnly.statusCode, 200);
    assert.equal(attentionRequiredPayload.summary.totalCalls, 2);
    assert.equal(attentionRequiredPayload.summary.pendingOperatorSteer, 1);
    assert.equal(attentionRequiredPayload.summary.fallbackArmed, 1);
    assert.equal(attentionRequiredPayload.summary.attentionRequired, 2);
    assert.equal(attentionRequiredPayload.summary.oldestAttentionCallId, firstCallId);
    assert.deepEqual(attentionRequiredPayload.summary.byFlowState, {
      call_started: 0,
      greet: 0,
      diagnose: 0,
      policy_hold: 1,
      operator_steer: 1,
      steered_response: 0,
      wrap: 0,
    });

    const staleAttention = await requestJson(port, "GET", "/api/queue?minAttentionAgeMs=1");
    const stalePayload = staleAttention.payload as QueueSummaryPayload;
    assert.equal(staleAttention.statusCode, 200);
    assert.equal(stalePayload.summary.totalCalls, 2);
    assert.equal(stalePayload.summary.attentionRequired, 2);

    const noStaleAttention = await requestJson(port, "GET", "/api/queue?minAttentionAgeMs=999999999999999");
    const noStalePayload = noStaleAttention.payload as QueueSummaryPayload;
    assert.equal(noStaleAttention.statusCode, 200);
    assert.equal(noStalePayload.summary.totalCalls, 0);
    assert.equal(noStalePayload.summary.attentionRequired, 0);

    const noAttentionRequired = await requestJson(port, "GET", "/api/queue?attentionRequired=false");
    const noAttentionRequiredPayload = noAttentionRequired.payload as QueueSummaryPayload;
    assert.equal(noAttentionRequired.statusCode, 200);
    assert.equal(noAttentionRequiredPayload.summary.totalCalls, 1);
    assert.equal(noAttentionRequiredPayload.summary.pendingOperatorSteer, 0);
    assert.equal(noAttentionRequiredPayload.summary.fallbackArmed, 0);
    assert.equal(noAttentionRequiredPayload.summary.attentionRequired, 0);
    assert.equal(noAttentionRequiredPayload.summary.oldestAttentionCallId, null);
    assert.deepEqual(noAttentionRequiredPayload.summary.byFlowState, {
      call_started: 1,
      greet: 0,
      diagnose: 0,
      policy_hold: 0,
      operator_steer: 0,
      steered_response: 0,
      wrap: 0,
    });

    const bySession = await requestJson(port, "GET", "/api/queue?openclawSessionRef=hb-session-03");
    const bySessionPayload = bySession.payload as QueueSummaryPayload;
    assert.equal(bySession.statusCode, 200);
    assert.equal(bySessionPayload.summary.totalCalls, 1);
    assert.equal(bySessionPayload.summary.oldestAttentionCallId, fallbackCallId);

    const byFlowState = await requestJson(port, "GET", "/api/queue?flowState=call_started");
    const byFlowStatePayload = byFlowState.payload as QueueSummaryPayload;
    assert.equal(byFlowState.statusCode, 200);
    assert.equal(byFlowStatePayload.summary.totalCalls, 1);
    assert.deepEqual(byFlowStatePayload.summary.byFlowState, {
      call_started: 1,
      greet: 0,
      diagnose: 0,
      policy_hold: 0,
      operator_steer: 0,
      steered_response: 0,
      wrap: 0,
    });

    const bySessionId = await requestJson(port, "GET", "/api/queue?openclawSessionId=hb-session-01");
    const bySessionIdPayload = bySessionId.payload as QueueSummaryPayload;
    assert.equal(bySessionId.statusCode, 200);
    assert.equal(bySessionIdPayload.summary.totalCalls, 1);
    assert.equal(bySessionIdPayload.summary.oldestAttentionCallId, firstCallId);

    const byLabel = await requestJson(port, "GET", "/api/queue?openclawSessionLabel=cluecon-demo/third");
    const byLabelPayload = byLabel.payload as QueueSummaryPayload;
    assert.equal(byLabel.statusCode, 200);
    assert.equal(byLabelPayload.summary.totalCalls, 1);
    assert.equal(byLabelPayload.summary.oldestAttentionCallId, fallbackCallId);

    const byProvider = await requestJson(port, "GET", "/api/queue?providerCallId=mock-sw-call-001-0003");
    const byProviderPayload = byProvider.payload as QueueSummaryPayload;
    assert.equal(byProvider.statusCode, 200);
    assert.equal(byProviderPayload.summary.totalCalls, 1);
    assert.equal(byProviderPayload.summary.oldestAttentionCallId, fallbackCallId);

    const invalidFlowState = await requestJson(port, "GET", "/api/queue?flowState=paused_forever");
    assert.equal(invalidFlowState.statusCode, 400);
    assert.deepEqual(invalidFlowState.payload, {
      ok: false,
      error: "queue_flow_state_invalid",
    });

    const invalidPending = await requestJson(port, "GET", "/api/queue?pendingOperatorSteer=maybe");
    assert.equal(invalidPending.statusCode, 400);
    assert.deepEqual(invalidPending.payload, {
      ok: false,
      error: "queue_pending_operator_steer_invalid",
    });

    const invalidFallback = await requestJson(port, "GET", "/api/queue?fallbackArmed=sometimes");
    assert.equal(invalidFallback.statusCode, 400);
    assert.deepEqual(invalidFallback.payload, {
      ok: false,
      error: "queue_fallback_armed_invalid",
    });

    const invalidAttention = await requestJson(port, "GET", "/api/queue?attentionRequired=loudly");
    assert.equal(invalidAttention.statusCode, 400);
    assert.deepEqual(invalidAttention.payload, {
      ok: false,
      error: "queue_attention_required_invalid",
    });

    const invalidMinAge = await requestJson(port, "GET", "/api/queue?minAttentionAgeMs=slow");
    assert.equal(invalidMinAge.statusCode, 400);
    assert.deepEqual(invalidMinAge.payload, {
      ok: false,
      error: "queue_min_attention_age_ms_invalid",
    });

    const invalidProvider = await requestJson(port, "GET", "/api/queue?providerCallId=%20%20%20");
    assert.equal(invalidProvider.statusCode, 400);
    assert.deepEqual(invalidProvider.payload, {
      ok: false,
      error: "queue_provider_call_id_invalid",
    });

    const invalidLabel = await requestJson(port, "GET", "/api/queue?openclawSessionLabel=%20%20%20");
    assert.equal(invalidLabel.statusCode, 400);
    assert.deepEqual(invalidLabel.payload, {
      ok: false,
      error: "queue_openclaw_session_label_invalid",
    });

    const invalidSessionId = await requestJson(port, "GET", "/api/queue?openclawSessionId=%20%20%20");
    assert.equal(invalidSessionId.statusCode, 400);
    assert.deepEqual(invalidSessionId.payload, {
      ok: false,
      error: "queue_openclaw_session_id_invalid",
    });

    const invalidRef = await requestJson(port, "GET", "/api/queue?openclawSessionRef=%20%20%20");
    assert.equal(invalidRef.statusCode, 400);
    assert.deepEqual(invalidRef.payload, {
      ok: false,
      error: "queue_openclaw_session_ref_invalid",
    });
  });
});



test("GET /api/calls and /api/queue can filter by attention source", async () => {
  await withServer(async (port) => {
    const operatorStarted = await requestJson(port, "POST", "/api/demo/start");
    const operatorCallId = (operatorStarted.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${operatorCallId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${operatorCallId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${operatorCallId}/caller-turn`, {
      text: "Okay, what safe options can you review for me?",
      timestamp: "2026-06-10T14:00:10.000Z",
    });

    const fallbackStarted = await requestJson(port, "POST", "/api/demo/start");
    const fallbackCallId = (fallbackStarted.payload as SnapshotPayload).session.callId;
    await requestJson(port, "POST", `/api/calls/${fallbackCallId}/operator-steer`, {
      action: "arm_fallback",
      reason: "audio degraded during live demo",
      timestamp: "2026-06-10T14:00:11.000Z",
    });

    const combinedStarted = await requestJson(port, "POST", "/api/demo/start");
    const combinedCallId = (combinedStarted.payload as SnapshotPayload).session.callId;
    await requestJson(port, "POST", `/api/calls/${combinedCallId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:12.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${combinedCallId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:13.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${combinedCallId}/caller-turn`, {
      text: "Okay, what safe options can you review for me?",
      timestamp: "2026-06-10T14:00:14.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${combinedCallId}/operator-steer`, {
      action: "arm_fallback",
      reason: "supervisor asked for dual-track demo",
      timestamp: "2026-06-10T14:00:15.000Z",
    });

    const operatorOnlyCalls = await requestJson(port, "GET", "/api/calls?attentionSource=operator_steer");
    const operatorOnlyCallsPayload = operatorOnlyCalls.payload as CallListPayload;
    assert.equal(operatorOnlyCalls.statusCode, 200);
    assert.deepEqual(operatorOnlyCallsPayload.calls.map((call) => call.session.callId), [operatorCallId]);
    assert.equal(operatorOnlyCallsPayload.summary.filteredSummary.attentionRequired, 1);
    assert.equal(operatorOnlyCallsPayload.summary.filteredSummary.oldestAttentionSource, "operator_steer");

    const fallbackOnlyCalls = await requestJson(port, "GET", "/api/calls?attentionSource=fallback");
    const fallbackOnlyCallsPayload = fallbackOnlyCalls.payload as CallListPayload;
    assert.equal(fallbackOnlyCalls.statusCode, 200);
    assert.deepEqual(fallbackOnlyCallsPayload.calls.map((call) => call.session.callId), [fallbackCallId]);
    assert.equal(fallbackOnlyCallsPayload.summary.filteredSummary.oldestAttentionSource, "fallback");

    const combinedCalls = await requestJson(port, "GET", "/api/calls?attentionSource=operator_steer%2Bfallback");
    const combinedCallsPayload = combinedCalls.payload as CallListPayload;
    assert.equal(combinedCalls.statusCode, 200);
    assert.deepEqual(combinedCallsPayload.calls.map((call) => call.session.callId), [combinedCallId]);
    assert.deepEqual(combinedCallsPayload.calls[0]?.attention, {
      required: true,
      source: "operator_steer+fallback",
      reason: "supervisor asked for dual-track demo",
      startedAt: "2026-06-10T14:00:15.000Z",
      ageMs: combinedCallsPayload.calls[0]?.attention?.ageMs,
    });
    assert.equal(typeof combinedCallsPayload.calls[0]?.attention?.ageMs, "number");
    assert.equal(combinedCallsPayload.summary.filteredSummary.totalCalls, 1);
    assert.equal(combinedCallsPayload.summary.filteredSummary.oldestAttentionSource, "operator_steer+fallback");

    const combinedQueue = await requestJson(port, "GET", "/api/queue?attentionSource=operator_steer%2Bfallback");
    const combinedQueuePayload = combinedQueue.payload as QueueSummaryPayload;
    assert.equal(combinedQueue.statusCode, 200);
    assert.equal(combinedQueuePayload.summary.totalCalls, 1);
    assert.equal(combinedQueuePayload.summary.attentionRequired, 1);
    assert.equal(combinedQueuePayload.summary.oldestAttentionCallId, combinedCallId);
    assert.equal(combinedQueuePayload.summary.oldestAttentionSource, "operator_steer+fallback");

    const reasonFilteredCalls = await requestJson(
      port,
      "GET",
      "/api/calls?attentionReason=supervisor%20asked%20for%20dual-track%20demo",
    );
    const reasonFilteredCallsPayload = reasonFilteredCalls.payload as CallListPayload;
    assert.equal(reasonFilteredCalls.statusCode, 200);
    assert.deepEqual(reasonFilteredCallsPayload.calls.map((call) => call.session.callId), [combinedCallId]);
    assert.equal(reasonFilteredCallsPayload.summary.filteredSummary.oldestAttentionReason, "supervisor asked for dual-track demo");

    const reasonFilteredQueue = await requestJson(port, "GET", "/api/queue?attentionReason=audio%20degraded%20during%20live%20demo");
    const reasonFilteredQueuePayload = reasonFilteredQueue.payload as QueueSummaryPayload;
    assert.equal(reasonFilteredQueue.statusCode, 200);
    assert.equal(reasonFilteredQueuePayload.summary.totalCalls, 1);
    assert.equal(reasonFilteredQueuePayload.summary.oldestAttentionCallId, fallbackCallId);
    assert.equal(reasonFilteredQueuePayload.summary.oldestAttentionReason, "audio degraded during live demo");

    const invalidReasonCalls = await requestJson(port, "GET", "/api/calls?attentionReason=%20%20");
    assert.equal(invalidReasonCalls.statusCode, 400);
    assert.deepEqual(invalidReasonCalls.payload, {
      ok: false,
      error: "call_list_attention_reason_invalid",
    });

    const invalidReasonQueue = await requestJson(port, "GET", "/api/queue?attentionReason=%20%20");
    assert.equal(invalidReasonQueue.statusCode, 400);
    assert.deepEqual(invalidReasonQueue.payload, {
      ok: false,
      error: "queue_attention_reason_invalid",
    });

    const invalidCalls = await requestJson(port, "GET", "/api/calls?attentionSource=triage_bot");
    assert.equal(invalidCalls.statusCode, 400);
    assert.deepEqual(invalidCalls.payload, {
      ok: false,
      error: "call_list_attention_source_invalid",
    });

    const invalidQueue = await requestJson(port, "GET", "/api/queue?attentionSource=triage_bot");
    assert.equal(invalidQueue.statusCode, 400);
    assert.deepEqual(invalidQueue.payload, {
      ok: false,
      error: "queue_attention_source_invalid",
    });
  });
});

test("GET /api/calls can filter by provider and attached OpenClaw session metadata", async () => {
  await withServer(async (port) => {
    await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "hb-session-01",
      openclawSessionLabel: "cluecon-demo/first",
    });

    const secondStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "hb-session-02",
      openclawSessionLabel: "cluecon-demo/second",
    });
    const secondCallId = (secondStarted.payload as SnapshotPayload).session.callId;

    const filteredByProvider = await requestJson(port, "GET", "/api/calls?providerCallId=mock-sw-call-001-0002");
    const filteredByProviderPayload = filteredByProvider.payload as CallListPayload;

    assert.equal(filteredByProvider.statusCode, 200);
    assert.deepEqual(filteredByProviderPayload.calls.map((call) => call.session.callId), [secondCallId]);
    assert.equal(filteredByProviderPayload.summary.totalCalls, 2);
    assert.equal(filteredByProviderPayload.summary.filteredCalls, 1);
    assert.equal(filteredByProviderPayload.summary.filteredSummary.totalCalls, 1);
    assert.equal(filteredByProviderPayload.summary.filteredSummary.oldestAttentionCallId, null);

    const filtered = await requestJson(port, "GET", "/api/calls?openclawSessionId=hb-session-02");
    const filteredPayload = filtered.payload as CallListPayload;

    assert.equal(filtered.statusCode, 200);
    assert.deepEqual(filteredPayload.calls.map((call) => call.session.callId), [secondCallId]);
    assert.equal(filteredPayload.summary.totalCalls, 2);
    assert.equal(filteredPayload.summary.filteredCalls, 1);

    const filteredByRefId = await requestJson(port, "GET", "/api/calls?openclawSessionRef=hb-session-02");
    const filteredByRefIdPayload = filteredByRefId.payload as CallListPayload;
    assert.equal(filteredByRefId.statusCode, 200);
    assert.deepEqual(filteredByRefIdPayload.calls.map((call) => call.session.callId), [secondCallId]);
    assert.equal(filteredByRefIdPayload.summary.totalCalls, 2);
    assert.equal(filteredByRefIdPayload.summary.filteredCalls, 1);
    assert.equal(filteredByRefIdPayload.summary.filteredSummary.totalCalls, 1);

    const filteredByRefLabel = await requestJson(port, "GET", "/api/calls?openclawSessionRef=cluecon-demo/second");
    const filteredByRefLabelPayload = filteredByRefLabel.payload as CallListPayload;
    assert.equal(filteredByRefLabel.statusCode, 200);
    assert.deepEqual(filteredByRefLabelPayload.calls.map((call) => call.session.callId), [secondCallId]);
    assert.equal(filteredByRefLabelPayload.summary.filteredCalls, 1);
    assert.equal(filteredByRefLabelPayload.summary.filteredSummary.totalCalls, 1);

    const filteredByLabel = await requestJson(port, "GET", "/api/calls?openclawSessionLabel=cluecon-demo/second");
    const filteredByLabelPayload = filteredByLabel.payload as CallListPayload;

    assert.equal(filteredByLabel.statusCode, 200);
    assert.deepEqual(filteredByLabelPayload.calls.map((call) => call.session.callId), [secondCallId]);
    assert.equal(filteredByLabelPayload.summary.totalCalls, 2);
    assert.equal(filteredByLabelPayload.summary.filteredCalls, 1);
    assert.equal(filteredByLabelPayload.summary.filteredSummary.totalCalls, 1);

    const missing = await requestJson(port, "GET", "/api/calls?openclawSessionId=hb-session-03");
    const missingPayload = missing.payload as CallListPayload;
    assert.equal(missing.statusCode, 200);
    assert.deepEqual(missingPayload.calls, []);
    assert.equal(missingPayload.summary.totalCalls, 2);
    assert.equal(missingPayload.summary.filteredCalls, 0);
    assert.equal(missingPayload.summary.filteredSummary.totalCalls, 0);

    const missingProvider = await requestJson(port, "GET", "/api/calls?providerCallId=mock-sw-call-001-9999");
    const missingProviderPayload = missingProvider.payload as CallListPayload;
    assert.equal(missingProvider.statusCode, 200);
    assert.deepEqual(missingProviderPayload.calls, []);
    assert.equal(missingProviderPayload.summary.totalCalls, 2);
    assert.equal(missingProviderPayload.summary.filteredCalls, 0);
    assert.equal(missingProviderPayload.summary.filteredSummary.totalCalls, 0);

    const missingRef = await requestJson(port, "GET", "/api/calls?openclawSessionRef=hb-session-03");
    const missingRefPayload = missingRef.payload as CallListPayload;
    assert.equal(missingRef.statusCode, 200);
    assert.deepEqual(missingRefPayload.calls, []);
    assert.equal(missingRefPayload.summary.filteredCalls, 0);

    const missingLabel = await requestJson(port, "GET", "/api/calls?openclawSessionLabel=cluecon-demo/missing");
    const missingLabelPayload = missingLabel.payload as CallListPayload;
    assert.equal(missingLabel.statusCode, 200);
    assert.deepEqual(missingLabelPayload.calls, []);
    assert.equal(missingLabelPayload.summary.totalCalls, 2);
    assert.equal(missingLabelPayload.summary.filteredCalls, 0);

    const invalidProvider = await requestJson(port, "GET", "/api/calls?providerCallId=%20%20%20");
    assert.equal(invalidProvider.statusCode, 400);
    assert.deepEqual(invalidProvider.payload, {
      ok: false,
      error: "call_list_provider_call_id_invalid",
    });

    const invalidLabel = await requestJson(port, "GET", "/api/calls?openclawSessionLabel=%20%20%20");
    assert.equal(invalidLabel.statusCode, 400);
    assert.deepEqual(invalidLabel.payload, {
      ok: false,
      error: "call_list_openclaw_session_label_invalid",
    });

    const invalidRef = await requestJson(port, "GET", "/api/calls?openclawSessionRef=%20%20%20");
    assert.equal(invalidRef.statusCode, 400);
    assert.deepEqual(invalidRef.payload, {
      ok: false,
      error: "call_list_openclaw_session_ref_invalid",
    });

    const invalid = await requestJson(port, "GET", "/api/calls?openclawSessionId=%20%20%20");
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.payload, {
      ok: false,
      error: "call_list_openclaw_session_id_invalid",
    });
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

    const scalarFallback = await requestRaw(port, "POST", `/api/calls/${callId}/fallback`, '"not-an-object"');
    const scalarFallbackPayload = scalarFallback.payload as { error: string };
    assert.equal(scalarFallback.statusCode, 400);
    assert.equal(scalarFallbackPayload.error, "json_object_required");

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
    assert.deepEqual(fetchedPayload.attention, {
      required: true,
      source: "fallback",
      reason: "pipecat tool exceeded latency budget",
      startedAt: "2026-06-10T14:00:02.000Z",
      ageMs: fetchedPayload.attention?.ageMs ?? null,
    });
    assert.equal(typeof fetchedPayload.attention?.ageMs, "number");
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


test("slash-command style steer text is parsed into operator actions", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;

    const paused = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      command: "pause",
      timestamp: "2026-06-10T14:00:01.000Z",
    });
    const pausedPayload = paused.payload as SnapshotPayload;
    assert.equal(paused.statusCode, 200);
    assert.equal(pausedPayload.flowState, "policy_hold");

    const redirected = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      command: "goto-slide pricing-proof",
      timestamp: "2026-06-10T14:00:02.000Z",
    });
    const redirectedPayload = redirected.payload as SnapshotPayload;
    assert.equal(redirected.statusCode, 200);
    assert.equal(redirectedPayload.flowState, "operator_steer");
    assert.equal(redirectedPayload.operatorSteer.lastAction, "goto_slide");
    assert.equal(redirectedPayload.operatorSteer.lastReason, "pricing-proof");

    const reRequested = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      command: "ask verify latency budget",
      timestamp: "2026-06-10T14:00:02.500Z",
    });
    const reRequestedPayload = reRequested.payload as SnapshotPayload;
    assert.equal(reRequested.statusCode, 200);
    assert.equal(reRequestedPayload.flowState, "operator_steer");
    assert.equal(reRequestedPayload.operatorSteer.lastAction, "ask_operator");
    assert.equal(reRequestedPayload.operatorSteer.lastReason, "verify latency budget");

    const resumed = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      command: "resume",
      timestamp: "2026-06-10T14:00:03.000Z",
    });
    const resumedPayload = resumed.payload as SnapshotPayload;
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumedPayload.flowState, "steered_response");
    assert.equal(resumedPayload.operatorSteer.lastAction, "resume");

    const slashPrefixed = await requestJson(port, "POST", "/api/calls/" + callId + "/operator-steer", {
      command: "/goto-slide pricing-proof",
      timestamp: "2026-06-10T14:00:03.500Z",
    });
    const slashPrefixedPayload = slashPrefixed.payload as SnapshotPayload;
    assert.equal(slashPrefixed.statusCode, 200);
    assert.equal(slashPrefixedPayload.flowState, "operator_steer");
    assert.equal(slashPrefixedPayload.operatorSteer.lastAction, "goto_slide");
    assert.equal(slashPrefixedPayload.operatorSteer.lastReason, "pricing-proof");

    const wrappedSlashCommand = await requestJson(port, "POST", "/api/calls/" + callId + "/operator-steer", {
      command: "/operator ask verify latency budget",
      timestamp: "2026-06-10T14:00:06.000Z",
    });
    const wrappedSlashCommandPayload = wrappedSlashCommand.payload as SnapshotPayload;
    assert.equal(wrappedSlashCommand.statusCode, 200);
    assert.equal(wrappedSlashCommandPayload.flowState, "operator_steer");
    assert.equal(wrappedSlashCommandPayload.operatorSteer.lastAction, "ask_operator");
    assert.equal(wrappedSlashCommandPayload.operatorSteer.lastReason, "verify latency budget");

    const slackPayload = await requestJson(port, "POST", "/api/calls/" + callId + "/operator-steer", {
      command: "/operator-steer",
      text: "resume",
      timestamp: "2026-06-10T14:00:16.000Z",
    });
    const slackPayloadBody = slackPayload.payload as SnapshotPayload;
    assert.equal(slackPayload.statusCode, 200);
    assert.equal(slackPayloadBody.flowState, "steered_response");
    assert.equal(slackPayloadBody.operatorSteer.lastAction, "resume");
  });
});

test("unknown calls and invalid operator steer requests are rejected", async () => {
  await withServer(async (port) => {
    const missing = await requestJson(port, "GET", "/api/calls/does-not-exist");
    assert.equal(missing.statusCode, 404);

    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as { session: { callId: string } }).session.callId;
    const scalarTurn = await requestRaw(port, "POST", `/api/calls/${callId}/caller-turn`, '"not-an-object"');
    const scalarTurnPayload = scalarTurn.payload as { error: string };
    assert.equal(scalarTurn.statusCode, 400);
    assert.equal(scalarTurnPayload.error, "json_object_required");

    const invalidTurn = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "   ",
    });
    const invalidTurnPayload = invalidTurn.payload as { error: string };
    assert.equal(invalidTurn.statusCode, 400);
    assert.equal(invalidTurnPayload.error, "caller_turn_text_required");

    const scalarSteer = await requestRaw(port, "POST", `/api/calls/${callId}/operator-steer`, '"not-an-object"');
    const scalarSteerPayload = scalarSteer.payload as { error: string };
    assert.equal(scalarSteer.statusCode, 400);
    assert.equal(scalarSteerPayload.error, "json_object_required");

    const invalidSteer = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {});
    const invalidSteerPayload = invalidSteer.payload as { error: string };
    assert.equal(invalidSteer.statusCode, 400);
    assert.equal(invalidSteerPayload.error, "operator_steer_action_required");

    const invalidCommand = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      command: "goto-slide",
    });
    const invalidCommandPayload = invalidCommand.payload as { error: string };
    assert.equal(invalidCommand.statusCode, 400);
    assert.equal(invalidCommandPayload.error, "operator_steer_command_invalid");

    const conflictingCommand = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "pause",
      command: "resume",
    });
    const conflictingCommandPayload = conflictingCommand.payload as { error: string };
    assert.equal(conflictingCommand.statusCode, 400);
    assert.equal(conflictingCommandPayload.error, "operator_steer_command_conflict");

    const invalidFallbackReason = await requestJson(port, "POST", `/api/calls/${callId}/fallback`, {
      mode: "tool_timeout",
      reason: 7,
    });
    const invalidFallbackReasonPayload = invalidFallbackReason.payload as { error: string };
    assert.equal(invalidFallbackReason.statusCode, 400);
    assert.equal(invalidFallbackReasonPayload.error, "fallback_reason_invalid");

    const invalidSteerReason = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "pause",
      reason: 7,
    });
    const invalidSteerReasonPayload = invalidSteerReason.payload as { error: string };
    assert.equal(invalidSteerReason.statusCode, 400);
    assert.equal(invalidSteerReasonPayload.error, "operator_steer_reason_invalid");

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

test("attention age metadata tracks when operator attention actually started", async () => {
  await withServer(async (port) => {
    const now = Date.now();
    const firstAttentionAt = new Date(now - 90_000).toISOString();
    const secondAttentionAt = new Date(now - 150_000).toISOString();

    const firstStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "age-session-01",
      openclawSessionLabel: "attention-age/first",
    });
    const firstCallId = (firstStarted.payload as SnapshotPayload).session.callId;

    const secondStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "age-session-02",
      openclawSessionLabel: "attention-age/second",
    });
    const secondCallId = (secondStarted.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${secondCallId}/fallback`, {
      mode: "tool_timeout",
      timestamp: secondAttentionAt,
      reason: "tool_timeout",
    });

    await requestJson(port, "POST", `/api/calls/${firstCallId}/caller-turn`, {
      text: "unexpected script deviation",
      timestamp: firstAttentionAt,
    });

    const queue = await requestJson(port, "GET", "/api/queue?attentionRequired=true");
    const queuePayload = queue.payload as QueueSummaryPayload;

    assert.equal(queue.statusCode, 200);
    assert.equal(queuePayload.summary.oldestAttentionCallId, secondCallId);
    assert.equal(queuePayload.summary.oldestAttentionOpenclawSessionId, "age-session-02");
    assert.equal(queuePayload.summary.oldestAttentionStartedAt, secondAttentionAt);
    assert.ok((queuePayload.summary.oldestAttentionAgeMs ?? 0) >= 120_000);

    const firstSnapshot = await requestJson(port, "GET", `/api/calls/${firstCallId}`);
    const firstPayload = firstSnapshot.payload as SnapshotPayload;
    assert.equal(firstSnapshot.statusCode, 200);
    assert.equal(firstPayload.attention?.source, "operator_steer");
    assert.ok((firstPayload.attention?.ageMs ?? 0) >= 60_000);
    assert.ok((firstPayload.attention?.ageMs ?? 0) < 120_000);
  });
});

test("GET /api/calls and /api/queue can scope operator state by call id", async () => {
  await withServer(async (port) => {
    const firstStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "call-filter-01",
      openclawSessionLabel: "call-filter/first",
    });
    const firstCallId = (firstStarted.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${firstCallId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });

    const secondStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "call-filter-02",
      openclawSessionLabel: "call-filter/second",
    });
    const secondCallId = (secondStarted.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${secondCallId}/fallback`, {
      mode: "tool_timeout",
      reason: "manual QA fallback",
      timestamp: "2026-06-10T14:00:05.000Z",
    });

    const filteredCalls = await requestJson(port, "GET", `/api/calls?callId=${secondCallId}`);
    const filteredCallsPayload = filteredCalls.payload as CallListPayload;

    assert.equal(filteredCalls.statusCode, 200);
    assert.deepEqual(filteredCallsPayload.calls.map((call) => call.session.callId), [secondCallId]);
    assert.equal(filteredCallsPayload.summary.totalCalls, 2);
    assert.equal(filteredCallsPayload.summary.filteredCalls, 1);
    assert.equal(filteredCallsPayload.summary.filteredSummary.totalCalls, 1);
    assert.equal(filteredCallsPayload.summary.filteredSummary.fallbackArmed, 1);
    assert.equal(filteredCallsPayload.summary.filteredSummary.oldestAttentionCallId, secondCallId);

    const queue = await requestJson(port, "GET", `/api/queue?callId=${firstCallId}`);
    const queuePayload = queue.payload as QueueSummaryPayload;

    assert.equal(queue.statusCode, 200);
    assert.equal(queuePayload.summary.totalCalls, 1);
    assert.equal(queuePayload.summary.byFlowState.diagnose, 1);
    assert.equal(queuePayload.summary.fallbackArmed, 0);
    assert.equal(queuePayload.summary.oldestAttentionCallId, null);

    const invalidQueue = await requestJson(port, "GET", "/api/queue?callId=%20%20%20");
    assert.equal(invalidQueue.statusCode, 400);
    assert.deepEqual(invalidQueue.payload, {
      ok: false,
      error: "queue_call_id_invalid",
    });
  });
});

test("GET /api/calls/:callId/events returns filterable event evidence", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "events-session-01",
      openclawSessionLabel: "events/filterable",
    });
    const callId = (started.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });

    const allEvents = await requestJson(port, "GET", `/api/calls/${callId}/events`);
    const allEventsPayload = allEvents.payload as EventTrailPayload;

    assert.equal(allEvents.statusCode, 200);
    assert.equal(allEventsPayload.callId, callId);
    assert.equal(allEventsPayload.openclawSession.sessionId, "events-session-01");
    assert.equal(allEventsPayload.summary.totalEvents, allEventsPayload.events.length);
    assert.equal(allEventsPayload.summary.returnedEvents, allEventsPayload.events.length);
    assert.equal(allEventsPayload.summary.filteredType, null);
    assert.equal(allEventsPayload.summary.filteredSource, null);
    assert.equal(allEventsPayload.summary.filteredSince, null);
    assert.equal(allEventsPayload.summary.order, "asc");
    assert.deepEqual(allEventsPayload.summary.page, {
      offset: 0,
      limit: null,
      totalFilteredEvents: allEventsPayload.summary.totalEvents,
      hasMore: false,
      nextOffset: null,
    });
    assert.equal(allEventsPayload.events.some((event) => event.type === "caller_turn_appended"), true);

    const sinceFilteredEvents = await requestJson(
      port,
      "GET",
      `/api/calls/${callId}/events?type=caller_turn_appended&since=${encodeURIComponent("2026-06-10T14:00:00.000Z")}`,
    );
    const sinceFilteredPayload = sinceFilteredEvents.payload as EventTrailPayload;

    assert.equal(sinceFilteredEvents.statusCode, 200);
    assert.equal(sinceFilteredPayload.summary.totalEvents, allEventsPayload.summary.totalEvents);
    assert.equal(sinceFilteredPayload.summary.filteredType, "caller_turn_appended");
    assert.equal(sinceFilteredPayload.summary.filteredSource, null);
    assert.equal(sinceFilteredPayload.summary.filteredSince, "2026-06-10T14:00:00.000Z");
    assert.deepEqual(sinceFilteredPayload.events.map((event) => event.type), ["caller_turn_appended"]);

    const futureEvents = await requestJson(port, "GET", `/api/calls/${callId}/events?since=2999-01-01T00:00:00.000Z`);
    const futurePayload = futureEvents.payload as EventTrailPayload;

    assert.equal(futureEvents.statusCode, 200);
    assert.equal(futurePayload.summary.returnedEvents, 0);
    assert.equal(futurePayload.summary.filteredSince, "2999-01-01T00:00:00.000Z");
    assert.equal(futurePayload.summary.lastReturnedEventType, null);
    assert.equal(futurePayload.summary.lastReturnedEventAt, null);
    assert.deepEqual(futurePayload.events, []);

    const filteredEvents = await requestJson(port, "GET", `/api/calls/${callId}/events?type=caller_turn_appended`);
    const filteredPayload = filteredEvents.payload as EventTrailPayload;

    assert.equal(filteredEvents.statusCode, 200);
    assert.equal(filteredPayload.summary.totalEvents, allEventsPayload.summary.totalEvents);
    assert.equal(filteredPayload.summary.returnedEvents, 1);
    assert.equal(filteredPayload.summary.filteredType, "caller_turn_appended");
    assert.equal(filteredPayload.summary.filteredSource, null);
    assert.equal(filteredPayload.summary.filteredSince, null);
    assert.equal(filteredPayload.summary.latestEventType, "caller_turn_appended");
    assert.equal(filteredPayload.summary.lastReturnedEventType, "caller_turn_appended");
    assert.equal(filteredPayload.summary.lastReturnedEventAt, filteredPayload.events.at(-1)?.at);
    assert.deepEqual(filteredPayload.events.map((event) => event.type), ["caller_turn_appended"]);

    const descendingEvents = await requestJson(port, "GET", `/api/calls/${callId}/events?order=desc&limit=2`);
    const descendingPayload = descendingEvents.payload as EventTrailPayload;

    assert.equal(descendingEvents.statusCode, 200);
    assert.equal(descendingPayload.summary.order, "desc");
    assert.deepEqual(
      descendingPayload.events.map((event) => event.type),
      [...allEventsPayload.events].reverse().slice(0, 2).map((event) => event.type),
    );
    assert.equal(descendingPayload.summary.latestEventType, allEventsPayload.events.at(-1)?.type);
    assert.equal(descendingPayload.summary.lastReturnedEventType, descendingPayload.events.at(-1)?.type);
    assert.equal(descendingPayload.summary.lastReturnedEventAt, descendingPayload.events.at(-1)?.at);

    const pagedEvents = await requestJson(port, "GET", `/api/calls/${callId}/events?offset=1&limit=2`);
    const pagedPayload = pagedEvents.payload as EventTrailPayload;

    assert.equal(pagedEvents.statusCode, 200);
    assert.equal(pagedPayload.events.length, 2);
    assert.deepEqual(pagedPayload.summary.page, {
      offset: 1,
      limit: 2,
      totalFilteredEvents: allEventsPayload.summary.totalEvents,
      hasMore: allEventsPayload.summary.totalEvents > 3,
      nextOffset: allEventsPayload.summary.totalEvents > 3 ? 3 : null,
    });

    await requestJson(port, "POST", `/api/calls/${callId}/fallback`, {
      mode: "tool_timeout",
      reason: "operator audit source filter",
      timestamp: "2026-06-10T14:00:15.000Z",
    });

    const sourceFilteredEvents = await requestJson(port, "GET", `/api/calls/${callId}/events?source=mock_http_route`);
    const sourceFilteredPayload = sourceFilteredEvents.payload as EventTrailPayload;

    assert.equal(sourceFilteredEvents.statusCode, 200);
    assert.equal(sourceFilteredPayload.summary.filteredSource, "mock_http_route");
    assert.equal(sourceFilteredPayload.summary.filteredType, null);
    assert.deepEqual(sourceFilteredPayload.events.map((event) => event.type), ["demo_fallback_triggered"]);

    const handoffSourceEvents = await requestJson(port, "GET", `/api/calls/${callId}/events?source=tool_timeout_fail_closed`);
    const handoffSourcePayload = handoffSourceEvents.payload as EventTrailPayload;

    assert.equal(handoffSourceEvents.statusCode, 200);
    assert.equal(handoffSourcePayload.summary.filteredSource, "tool_timeout_fail_closed");
    assert.deepEqual(handoffSourcePayload.events.map((event) => event.type), ["human_handoff_started"]);

    const invalidType = await requestJson(port, "GET", `/api/calls/${callId}/events?type=%20%20`);
    assert.equal(invalidType.statusCode, 400);
    assert.deepEqual(invalidType.payload, {
      ok: false,
      error: "event_type_invalid",
    });

    const invalidSource = await requestJson(port, "GET", `/api/calls/${callId}/events?source=%20%20`);
    assert.equal(invalidSource.statusCode, 400);
    assert.deepEqual(invalidSource.payload, {
      ok: false,
      error: "event_source_invalid",
    });

    const invalidSince = await requestJson(port, "GET", `/api/calls/${callId}/events?since=not-a-date`);
    assert.equal(invalidSince.statusCode, 400);
    assert.deepEqual(invalidSince.payload, {
      ok: false,
      error: "event_since_invalid",
    });

    const invalidOffset = await requestJson(port, "GET", `/api/calls/${callId}/events?offset=-1`);
    assert.equal(invalidOffset.statusCode, 400);
    assert.deepEqual(invalidOffset.payload, {
      ok: false,
      error: "event_offset_invalid",
    });

    const invalidLimit = await requestJson(port, "GET", `/api/calls/${callId}/events?limit=0`);
    assert.equal(invalidLimit.statusCode, 400);
    assert.deepEqual(invalidLimit.payload, {
      ok: false,
      error: "event_limit_invalid",
    });

    const oversizedLimit = await requestJson(port, "GET", `/api/calls/${callId}/events?limit=101`);
    assert.equal(oversizedLimit.statusCode, 400);
    assert.deepEqual(oversizedLimit.payload, {
      ok: false,
      error: "event_limit_invalid",
    });

    const invalidOrder = await requestJson(port, "GET", `/api/calls/${callId}/events?order=latest`);
    assert.equal(invalidOrder.statusCode, 400);
    assert.deepEqual(invalidOrder.payload, {
      ok: false,
      error: "event_order_invalid",
    });

    const missing = await requestJson(port, "GET", "/api/calls/missing-call/events");
    assert.equal(missing.statusCode, 404);
  });
});

test("GET /api/calls/:callId/transcript returns filterable transcript pages", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:00:05.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Okay, what safe options can you review for me?",
      timestamp: "2026-06-10T14:00:10.000Z",
    });

    const callerPage = await requestJson(port, "GET", `/api/calls/${callId}/transcript?speaker=caller&limit=2`);
    const callerPayload = callerPage.payload as {
      callId: string;
      transcript: Array<{ speaker: string; text: string; timestamp: string }>;
      summary: {
        totalTurns: number;
        returnedTurns: number;
        filteredSpeaker: string | null;
        filteredSince: string | null;
        filteredUntil: string | null;
        filteredText: string | null;
        order: "asc" | "desc";
        page: { offset: number; limit: number | null; totalFilteredTurns: number; hasMore: boolean; nextOffset: number | null };
        latestSpeaker: string | null;
        latestTurnAt: string | null;
        lastReturnedSpeaker: string | null;
        lastReturnedTurnAt: string | null;
      };
    };

    assert.equal(callerPage.statusCode, 200);
    assert.equal(callerPayload.callId, callId);
    assert.deepEqual(callerPayload.transcript.map((turn) => turn.speaker), ["caller", "caller"]);
    assert.deepEqual(callerPayload.transcript.map((turn) => turn.text), [
      "I want to cancel my policy today.",
      "The renewal increase is too high.",
    ]);
    assert.equal(callerPayload.summary.totalTurns, 6);
    assert.equal(callerPayload.summary.returnedTurns, 2);
    assert.equal(callerPayload.summary.filteredSpeaker, "caller");
    assert.equal(callerPayload.summary.filteredSince, null);
    assert.equal(callerPayload.summary.filteredUntil, null);
    assert.equal(callerPayload.summary.filteredText, null);
    assert.equal(callerPayload.summary.order, "asc");
    assert.deepEqual(callerPayload.summary.page, {
      offset: 0,
      limit: 2,
      totalFilteredTurns: 3,
      hasMore: true,
      nextOffset: 2,
    });
    assert.equal(callerPayload.summary.latestSpeaker, "caller");
    assert.equal(callerPayload.summary.latestTurnAt, "2026-06-10T14:00:10.000Z");
    assert.equal(callerPayload.summary.lastReturnedSpeaker, "caller");
    assert.equal(callerPayload.summary.lastReturnedTurnAt, "2026-06-10T14:00:05.000Z");

    const newestAgentTurn = await requestJson(port, "GET", `/api/calls/${callId}/transcript?speaker=agent&order=desc&limit=1`);
    const newestAgentPayload = newestAgentTurn.payload as { transcript: Array<{ speaker: string; text: string }> };

    assert.equal(newestAgentTurn.statusCode, 200);
    assert.equal(newestAgentPayload.transcript.length, 1);
    assert.equal(newestAgentPayload.transcript[0]?.speaker, "agent");
    assert.match(newestAgentPayload.transcript[0]?.text ?? "", /operator approves/);

    const sincePage = await requestJson(port, "GET", `/api/calls/${callId}/transcript?since=2026-06-10T14:00:05.000Z`);
    const sincePayload = sincePage.payload as {
      transcript: Array<{ speaker: string; text: string; timestamp: string }>;
      summary: { filteredSince: string | null; page: { totalFilteredTurns: number }; latestTurnAt: string | null };
    };

    assert.equal(sincePage.statusCode, 200);
    assert.equal(sincePayload.summary.filteredSince, "2026-06-10T14:00:05.000Z");
    assert.equal(sincePayload.summary.page.totalFilteredTurns, 4);
    assert.deepEqual(sincePayload.transcript.map((turn) => turn.timestamp), [
      "2026-06-10T14:00:05.000Z",
      "2026-06-10T14:00:05.000Z",
      "2026-06-10T14:00:10.000Z",
      "2026-06-10T14:00:10.000Z",
    ]);
    assert.equal(sincePayload.summary.latestTurnAt, "2026-06-10T14:00:10.000Z");

    const boundedPage = await requestJson(
      port,
      "GET",
      `/api/calls/${callId}/transcript?since=2026-06-10T14:00:05.000Z&until=2026-06-10T14:00:05.000Z`,
    );
    const boundedPayload = boundedPage.payload as {
      transcript: Array<{ speaker: string; timestamp: string }>;
      summary: { filteredSince: string | null; filteredUntil: string | null; page: { totalFilteredTurns: number } };
    };

    assert.equal(boundedPage.statusCode, 200);
    assert.equal(boundedPayload.summary.filteredSince, "2026-06-10T14:00:05.000Z");
    assert.equal(boundedPayload.summary.filteredUntil, "2026-06-10T14:00:05.000Z");
    assert.equal(boundedPayload.summary.page.totalFilteredTurns, 2);
    assert.deepEqual(boundedPayload.transcript.map((turn) => turn.timestamp), [
      "2026-06-10T14:00:05.000Z",
      "2026-06-10T14:00:05.000Z",
    ]);

    const textFiltered = await requestJson(port, "GET", `/api/calls/${callId}/transcript?text=renewal`);
    const textFilteredPayload = textFiltered.payload as {
      transcript: Array<{ speaker: string; text: string }>;
      summary: { filteredText: string | null; page: { totalFilteredTurns: number } };
    };

    assert.equal(textFiltered.statusCode, 200);
    assert.equal(textFilteredPayload.summary.filteredText, "renewal");
    assert.equal(textFilteredPayload.summary.page.totalFilteredTurns, 2);
    assert.deepEqual(textFilteredPayload.transcript.map((turn) => turn.text), [
      "The renewal increase is too high.",
      "I heard the renewal increase concern. I am pausing before I discuss any retention offer so I stay within approved options.",
    ]);

    const invalidText = await requestJson(port, "GET", `/api/calls/${callId}/transcript?text=%20%20`);
    assert.equal(invalidText.statusCode, 400);
    assert.deepEqual(invalidText.payload, { ok: false, error: "transcript_text_invalid" });

    const invalidSpeaker = await requestJson(port, "GET", `/api/calls/${callId}/transcript?speaker=supervisor`);
    assert.equal(invalidSpeaker.statusCode, 400);
    assert.deepEqual(invalidSpeaker.payload, { ok: false, error: "transcript_speaker_invalid" });

    const invalidSince = await requestJson(port, "GET", `/api/calls/${callId}/transcript?since=not-a-date`);
    assert.equal(invalidSince.statusCode, 400);
    assert.deepEqual(invalidSince.payload, { ok: false, error: "transcript_since_invalid" });

    const invalidLimit = await requestJson(port, "GET", `/api/calls/${callId}/transcript?limit=101`);
    assert.equal(invalidLimit.statusCode, 400);
    assert.deepEqual(invalidLimit.payload, { ok: false, error: "transcript_limit_invalid" });

    const invalidUntil = await requestJson(port, "GET", `/api/calls/${callId}/transcript?until=not-a-date`);
    assert.equal(invalidUntil.statusCode, 400);
    assert.deepEqual(invalidUntil.payload, { ok: false, error: "transcript_until_invalid" });

    const invalidWindow = await requestJson(
      port,
      "GET",
      `/api/calls/${callId}/transcript?since=2026-06-10T14:00:10.000Z&until=2026-06-10T14:00:05.000Z`,
    );
    assert.equal(invalidWindow.statusCode, 400);
    assert.deepEqual(invalidWindow.payload, { ok: false, error: "transcript_window_invalid" });
  });
});
