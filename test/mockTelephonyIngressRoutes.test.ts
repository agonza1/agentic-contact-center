import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { Script } from "node:vm";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

interface SnapshotPayload {
  session: {
    callId: string;
    providerCallId: string;
    openclawSession: {
      sessionId: string;
      label: string;
      artifactLinks: { transcript: string; events: string; latencyMarks: string; proof: string };
    };
  };
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
    prototypeMode: string;
    transport: string;
    runtimeEngine: string;
    credentialsMode: string;
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
    scriptCompleted: number;
    scriptInProgress: number;
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

interface OperatorConsolePayload {
  schemaVersion: number;
  generatedAt: string;
  refreshIntervalMs: number;
  runtimeHealth: { ok: boolean; mode: string; provider: string; pipecatFlow: { ready: boolean } };
  controls: {
    commandWrappers: string[];
    callReferenceFields: string[];
    routes: { startDemoCall: string; callerTurn: string; steerCall: string; noteCall: string; consoleAction: string };
    scriptedCallerTurns: string[];
    actions: Array<{
      action: string;
      method: string;
      requiresPendingCall: boolean;
      requiresReason: boolean;
      postTemplate: string;
      bodyTemplate: { action: string; reason?: string };
      operatorOutcome: string;
      reasonPrompt: string | null;
      confirmationRequired: boolean;
      confirmationMessage: string | null;
      commandExamples: string[];
    }>;
  };
  queue: QueueSummaryPayload;
  calls: {
    items: Array<
      SnapshotPayload & {
        evidenceSummary: {
          latestEventType: string | null;
          latestEventTrail: string | null;
          latestLatencyTrail: string | null;
          latestTranscriptSpeaker: string | null;
          latestEvidenceAt: string | null;
          transcriptTurns: number;
          eventCount: number;
          latencyMarkCount: number;
          operatorNoteCount: number;
          latestOperatorNoteText: string | null;
          latestOperatorNoteAt: string | null;
          latestDisposition: string | null;
          operatorNoteTrail: string | null;
          fallbackMode: string | null;
          fallbackReason: string | null;
          fallbackSource: string | null;
          fallbackSourceTrail: string | null;
          fallbackSourceQueue: string | null;
          fallbackSourceCallList: string | null;
          fallbackSourceOperatorConsole: string | null;
          fallbackModeQueue: string | null;
          fallbackModeCallList: string | null;
          fallbackModeOperatorConsole: string | null;
          fallbackModeTranscriptTrail: string | null;
          fallbackReasonQueue: string | null;
          fallbackReasonCallList: string | null;
          fallbackReasonOperatorConsole: string | null;
          fallbackReasonEventTrail: string | null;
          handoffTrail: string | null;
          handoffStartedAt: string | null;
          overBudgetLatencyMarkCount: number;
          overBudgetLatencyTrail: string | null;
          links: { transcript: string; events: string; latencyMarks: string; proof: string };
        };
        actionState: {
          attentionRequired: boolean;
          pendingApproval: boolean;
          pendingApprovalDetails: {
            recommendedAction: string | null;
            reason: string | null;
            requestedAt: string | null;
            source: string | null;
            approvalPrompt: string;
          } | null;
          fallbackArmed: boolean;
          nextRecommendedAction: string;
          scriptedCallerTurnState: {
            matchedTurns: number;
            totalTurns: number;
            remainingTurns: number;
            progressPct: number;
            nextTurnIndex: number | null;
            nextTurnText: string | null;
            completed: boolean;
          };
          actionDetails: Array<{
            action: string;
            enabled: boolean;
            disabledReason: string | null;
            confirmationRequired: boolean;
            confirmationMessage: string | null;
            requiresReason: boolean;
            reasonPrompt: string | null;
          }>;
          availableActions: string[];
          requiresConfirmationActions: Array<{ action: string; confirmationMessage: string | null }>;
          requiresReasonActions: Array<{ action: string; reasonPrompt: string | null }>;
          unavailableActions: Array<{ action: string; reason: string }>;
        };
      }
    >;
    summary: CallListPayload["summary"];
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
    filteredDetailKey: string | null;
    filteredDetailText: string | null;
    filteredSince: string | null;
    filteredUntil: string | null;
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

interface ArtifactManifestPayload {
  schemaVersion: number;
  callId: string;
  providerCallId: string;
  openclawSession: {
    sessionId: string;
    label: string;
    status: string;
    artifactLinks: { snapshot: string; artifacts: string; proof: string; transcript: string; events: string; latencyMarks: string };
  };
  artifacts: { snapshot: string; artifacts: string; proof: string; transcript: string; events: string; latencyMarks: string };
  runtimeMode: { flow: string; pipecatTransport: string; runtimeEngine: string; credentialsMode: string; runtimeCheck: { command: string; installCommand: string; liveTelephonyRequired: boolean }; telephony: string };
  evidenceRoutes: {
    transcript: string;
    events: string;
    latencyMarks: string;
    operatorConsole: string;
    latestEventTrail: string | null;
    latestLatencyTrail: string | null;
    operatorNoteTrail: string | null;
    fallbackSourceTrail: string | null;
    fallbackSourceQueue: string | null;
    fallbackSourceCallList: string | null;
    fallbackSourceOperatorConsole: string | null;
    fallbackModeQueue: string | null;
    fallbackModeCallList: string | null;
    fallbackModeOperatorConsole: string | null;
    fallbackModeTranscriptTrail: string | null;
    fallbackReasonQueue: string | null;
    fallbackReasonCallList: string | null;
    fallbackReasonOperatorConsole: string | null;
    fallbackReasonEventTrail: string | null;
        handoffTrail: string | null;
    overBudgetLatencyTrail: string | null;
  };
  summary: {
    transcriptTurns: number;
    eventCount: number;
    latencyMarkCount: number;
    overBudgetLatencyMarkCount: number;
    fallbackMode: string | null;
    fallbackReason: string | null;
    fallbackSource: string | null;
        handoffTrail: string | null;
    handoffStartedAt: string | null;
    latestEventType: string | null;
    latestEventAt: string | null;
    latestTranscriptSpeaker: string | null;
    latestTranscriptAt: string | null;
    latestLatencyStage: string | null;
    latestLatencyAt: string | null;
    latestLatencyTrail: string | null;
  };
}

interface LatencyPayload {
  callId: string;
  providerCallId: string;
  openclawSession: { sessionId: string; label: string; status: string };
  latencyBudgetsMs: Record<string, number>;
  marks: Array<{ stage: string; recordedAt: string; elapsedMs: number; budgetMs: number | null }>;
  summary: {
    totalMarks: number;
    returnedMarks: number;
    filteredStage: string | null;
    filteredOverBudget: boolean | null;
    filteredSince: string | null;
    filteredUntil: string | null;
    order: "asc" | "desc";
    page: {
      offset: number;
      limit: number | null;
      totalFilteredMarks: number;
      hasMore: boolean;
      nextOffset: number | null;
    };
    overBudgetMarks: number;
    latestMarkStage: string | null;
    latestMarkAt: string | null;
    lastReturnedMarkStage: string | null;
    lastReturnedMarkAt: string | null;
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

async function requestText(
  port: number,
  method: string,
  path: string,
): Promise<{ statusCode: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (response) => {
      let collected = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        collected += chunk;
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: collected,
          contentType: response.headers["content-type"],
        });
      });
    });

    req.on("error", reject);
    req.end();
  });
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
        openclawSession: {
          sessionId: string;
          label: string;
          status: string;
          eventTrailVersion: number;
          artifactLinks: { snapshot: string; artifacts: string; proof: string; transcript: string; events: string; latencyMarks: string };
        };
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
      pipecatFlow: {
        ready: boolean;
        prototypeMode: string;
        transport: string;
        runtimeEngine: string;
        credentialsMode: string;
        toolCoverage: string[];
      };
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
    assert.deepEqual(startedPayload.session.openclawSession.artifactLinks, {
      snapshot: `/api/calls/${startedPayload.session.callId}`,
      artifacts: `/api/calls/${startedPayload.session.callId}/artifacts`,
      proof: `/api/calls/${startedPayload.session.callId}/proof`,
      transcript: `/api/calls/${startedPayload.session.callId}/transcript`,
      events: `/api/calls/${startedPayload.session.callId}/events`,
      latencyMarks: `/api/calls/${startedPayload.session.callId}/latency`,
    });
    assert.equal(startedPayload.scenario.mode, "mocked_telephony");
    assert.equal(startedPayload.scenario.policyProfile, "retention_safe_mode");
    assert.equal(startedPayload.scenario.fallbackMode, "tool_timeout");
    assert.equal(startedPayload.pipecatFlow.ready, true);
    assert.equal(startedPayload.pipecatFlow.prototypeMode, "pipecat_local_runtime");
    assert.equal(startedPayload.pipecatFlow.transport, "local_process");
    assert.equal(startedPayload.pipecatFlow.runtimeEngine, "pipecat-ai");
    assert.equal(startedPayload.pipecatFlow.credentialsMode, "mocked");
    assert.equal(startedPayload.pipecatFlow.toolCoverage.includes("ask_operator"), true);
    assert.deepEqual(startedPayload.events.map((event) => event.type).slice(0, 3), [
      "call_bootstrapped",
      "pipecat_runtime_started",
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
    assert.equal(firstPayload.events.some((event) => event.type === "pipecat_runtime_turn_processed"), true);
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


test("GET /api/calls/:callId/proof exports a per-call QA proof bundle", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "proof-session-42",
      openclawSessionLabel: "qa/proof-bundle",
    });
    const callId = (started.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", "/api/calls/" + callId + "/caller-turn", {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-12T10:00:00.000Z",
    });
    await requestJson(port, "POST", "/api/calls/" + callId + "/caller-turn", {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-12T10:00:05.000Z",
    });

    const proof = await requestJson(port, "GET", "/api/calls/" + callId + "/proof");
    const payload = proof.payload as {
      schemaVersion: number;
      callId: string;
      providerCallId: string;
      runtimeMode: {
        flow: string;
        pipecatTransport: string;
        runtimeEngine: string;
        credentialsMode: string;
        runtimeCheck: { command: string; installCommand: string; liveTelephonyRequired: boolean };
        telephony: string;
        signalWire: string;
        openclawSession: { sessionId: string; label: string; status: string };
      };
      artifacts: { snapshot: string; artifacts: string; proof: string; transcript: string; events: string; latencyMarks: string };
      evidenceRoutes: {
        transcript: string;
        events: string;
        latencyMarks: string;
        operatorConsole: string;
        latestEventTrail: string | null;
        latestLatencyTrail: string | null;
        operatorNoteTrail: string | null;
        fallbackSourceTrail: string | null;
        fallbackSourceQueue: string | null;
        fallbackSourceCallList: string | null;
        fallbackSourceOperatorConsole: string | null;
        fallbackModeQueue: string | null;
        fallbackModeCallList: string | null;
        fallbackModeOperatorConsole: string | null;
        fallbackModeTranscriptTrail: string | null;
        fallbackReasonQueue: string | null;
        fallbackReasonCallList: string | null;
        fallbackReasonOperatorConsole: string | null;
        fallbackReasonEventTrail: string | null;
        handoffTrail: string | null;
        overBudgetLatencyTrail: string | null;
      };
      pii: { redactionApplied: boolean; assumptions: string };
      outcome: {
        flowState: string;
        scriptCompleted: boolean;
        fallbackArmed: boolean;
        fallbackSource: string | null;
        handoffStarted: boolean;
        handoffStartedAt: string | null;
        attentionRequired: boolean;
      };
      summary: {
        transcriptTurns: number;
        eventCount: number;
        eventTypes: string[];
        operatorActionCount: number;
        latencyMarkCount: number;
        overBudgetLatencyMarkCount: number;
        toolCoverage: string[];
      };
      session: { callId: string; openclawSession: { sessionId: string; label: string } };
      transcript: Array<{ speaker: string; text: string }>;
      events: Array<{ type: string }>;
      latencyMarks: Array<{ stage: string }>;
    };

    assert.equal(proof.statusCode, 200);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.callId, callId);
    assert.equal(payload.session.callId, callId);
    assert.equal(payload.runtimeMode.flow, "pipecat_local_runtime");
    assert.equal(payload.runtimeMode.pipecatTransport, "local_process");
    assert.equal(payload.runtimeMode.runtimeEngine, "pipecat-ai");
    assert.equal(payload.runtimeMode.credentialsMode, "mocked");
    assert.deepEqual(payload.runtimeMode.runtimeCheck, {
      command: "npm run pipecat:check",
      installCommand: "python3 -m pip install --target .pipecat-runtime -r requirements-pipecat.txt",
      liveTelephonyRequired: false,
    });
    assert.equal(payload.runtimeMode.telephony, "mocked_telephony");
    assert.equal(payload.runtimeMode.signalWire, "mocked_telephony");
    assert.equal(payload.runtimeMode.openclawSession.sessionId, "proof-session-42");
    assert.equal(payload.runtimeMode.openclawSession.label, "qa/proof-bundle");
    assert.deepEqual(payload.artifacts, {
      snapshot: `/api/calls/${callId}`,
      artifacts: `/api/calls/${callId}/artifacts`,
      proof: `/api/calls/${callId}/proof`,
      transcript: `/api/calls/${callId}/transcript`,
      events: `/api/calls/${callId}/events`,
      latencyMarks: `/api/calls/${callId}/latency`,
    });
    assert.deepEqual(payload.evidenceRoutes, {
      transcript: `/api/calls/${callId}/transcript`,
      events: `/api/calls/${callId}/events`,
      latencyMarks: `/api/calls/${callId}/latency`,
      operatorConsole: `/api/operator/console?callId=${callId}`,
      latestEventTrail: `/api/calls/${callId}/events?type=agent_turn_appended&limit=1&order=desc`,
      latestLatencyTrail: `/api/calls/${callId}/latency?stage=agent_response_ready&limit=1&order=desc`,
      operatorNoteTrail: null,
      fallbackSourceTrail: null,
      fallbackSourceQueue: null,
      fallbackSourceCallList: null,
      fallbackSourceOperatorConsole: null,
      fallbackModeQueue: null,
      fallbackModeCallList: null,
      fallbackModeOperatorConsole: null,
      fallbackModeTranscriptTrail: null,
      fallbackReasonQueue: null,
      fallbackReasonCallList: null,
      fallbackReasonOperatorConsole: null,
      fallbackReasonEventTrail: null,
      handoffTrail: null,
      overBudgetLatencyTrail: null,
    });
    assert.equal(payload.pii.redactionApplied, false);
    assert.match(payload.pii.assumptions, /mock caller text/);
    assert.equal(payload.outcome.flowState, "policy_hold");
    assert.equal(payload.outcome.fallbackArmed, false);
    assert.equal(payload.outcome.fallbackSource, null);
    assert.equal(payload.outcome.handoffStarted, false);
    assert.equal(payload.outcome.handoffStartedAt, null);
    assert.equal(payload.outcome.attentionRequired, false);
    assert.equal(payload.summary.transcriptTurns, payload.transcript.length);
    assert.equal(payload.summary.eventCount, payload.events.length);
    assert.equal(payload.summary.latencyMarkCount, payload.latencyMarks.length);
    assert.equal(payload.summary.eventTypes.includes("policy_hold_entered"), true);
    assert.equal(payload.summary.toolCoverage.includes("ask_operator"), true);
  });
});

test("GET /api/calls/:callId/artifacts returns an OpenClaw artifact manifest", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "artifact-session-42",
      openclawSessionLabel: "qa/artifact-manifest",
    });
    const callId = (started.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", "/api/calls/" + callId + "/caller-turn", {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-12T10:00:00.000Z",
    });

    const manifest = await requestJson(port, "GET", "/api/calls/" + callId + "/artifacts");
    const payload = manifest.payload as ArtifactManifestPayload;

    assert.equal(manifest.statusCode, 200);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.callId, callId);
    assert.equal(payload.providerCallId, "mock-sw-call-001-0001");
    assert.equal(payload.openclawSession.sessionId, "artifact-session-42");
    assert.equal(payload.openclawSession.label, "qa/artifact-manifest");
    assert.deepEqual(payload.artifacts, payload.openclawSession.artifactLinks);
    assert.deepEqual(payload.artifacts, {
      snapshot: `/api/calls/${callId}`,
      artifacts: `/api/calls/${callId}/artifacts`,
      proof: `/api/calls/${callId}/proof`,
      transcript: `/api/calls/${callId}/transcript`,
      events: `/api/calls/${callId}/events`,
      latencyMarks: `/api/calls/${callId}/latency`,
    });
    assert.deepEqual(payload.runtimeMode, {
      flow: "pipecat_local_runtime",
      pipecatTransport: "local_process",
      runtimeEngine: "pipecat-ai",
      credentialsMode: "mocked",
      runtimeCheck: {
        command: "npm run pipecat:check",
        installCommand: "python3 -m pip install --target .pipecat-runtime -r requirements-pipecat.txt",
        liveTelephonyRequired: false,
      },
      telephony: "mocked_telephony",
    });
    assert.deepEqual(payload.evidenceRoutes, {
      transcript: `/api/calls/${callId}/transcript`,
      events: `/api/calls/${callId}/events`,
      latencyMarks: `/api/calls/${callId}/latency`,
      operatorConsole: `/api/operator/console?callId=${callId}`,
      latestEventTrail: `/api/calls/${callId}/events?type=flow_state_transition&limit=1&order=desc`,
      latestLatencyTrail: `/api/calls/${callId}/latency?stage=agent_response_ready&limit=1&order=desc`,
      operatorNoteTrail: null,
      fallbackSourceTrail: null,
      fallbackSourceQueue: null,
      fallbackSourceCallList: null,
      fallbackSourceOperatorConsole: null,
      fallbackModeQueue: null,
      fallbackModeCallList: null,
      fallbackModeOperatorConsole: null,
      fallbackModeTranscriptTrail: null,
      fallbackReasonQueue: null,
      fallbackReasonCallList: null,
      fallbackReasonOperatorConsole: null,
      fallbackReasonEventTrail: null,
      handoffTrail: null,
      overBudgetLatencyTrail: null,
    });
    assert.equal(payload.summary.transcriptTurns, 2);
    assert.equal(payload.summary.eventCount > 2, true);
    assert.equal(payload.summary.latencyMarkCount > 1, true);
    assert.equal(payload.summary.latestEventType, "flow_state_transition");
    assert.equal(payload.summary.latestTranscriptSpeaker, "agent");
    assert.equal(payload.summary.latestTranscriptAt, "2026-06-12T10:00:00.000Z");
    assert.equal(payload.summary.latestLatencyStage, "agent_response_ready");
    assert.equal(payload.summary.latestLatencyTrail, `/api/calls/${callId}/latency?stage=agent_response_ready&limit=1&order=desc`);
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
        scriptCompleted: 0,
        scriptInProgress: 0,
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
      scriptCompleted: 0,
      scriptInProgress: 0,
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
        scriptCompleted: 0,
        scriptInProgress: 0,
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
      scriptCompleted: 0,
      scriptInProgress: 2,
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
        scriptCompleted: 0,
        scriptInProgress: 2,
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



test("POST /api/signalwire/events maps local SignalWire lifecycle into call runtime", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/signalwire/events", {
      eventType: "call.started",
      signalWireCallId: "sw-call-123",
      timestamp: "2026-06-10T14:09:00.000Z",
    });
    const startedPayload = started.payload as { ok: boolean; route: string; eventType: string; signalWireCallId: string; call: SnapshotPayload };

    assert.equal(started.statusCode, 201);
    assert.equal(startedPayload.ok, true);
    assert.equal(startedPayload.route, "/api/signalwire/events");
    assert.equal(startedPayload.eventType, "call.started");
    assert.equal(startedPayload.signalWireCallId, "sw-call-123");
    assert.equal(startedPayload.call.session.providerCallId, "sw-call-123");
    assert.equal(startedPayload.call.session.openclawSession.sessionId, "signalwire-sw-call-123");
    assert.equal(startedPayload.call.session.openclawSession.label, "signalwire/sw-call-123");

    const media = await requestJson(port, "POST", "/api/signalwire/events", {
      eventType: "media.transcript",
      callSid: "sw-call-123",
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:09:05.000Z",
    });
    const mediaPayload = media.payload as { ok: boolean; eventType: string; call: SnapshotPayload };

    assert.equal(media.statusCode, 200);
    assert.equal(mediaPayload.eventType, "media.transcript");
    assert.equal(mediaPayload.call.session.callId, startedPayload.call.session.callId);
    assert.equal(mediaPayload.call.session.providerCallId, "sw-call-123");
    assert.equal(mediaPayload.call.transcript.at(-2)?.speaker, "caller");
    assert.equal(mediaPayload.call.transcript.at(-2)?.text, "I want to cancel my policy today.");

    const error = await requestJson(port, "POST", "/api/signalwire/events", {
      eventType: "call.error",
      signalWireCallId: "sw-call-123",
      reason: "media websocket timeout",
      timestamp: "2026-06-10T14:09:08.000Z",
    });
    const errorPayload = error.payload as { ok: boolean; eventType: string; call: SnapshotPayload };

    assert.equal(error.statusCode, 200);
    assert.equal(errorPayload.eventType, "call.error");
    assert.equal(errorPayload.call.demoFallback.armed, true);
    assert.equal(errorPayload.call.demoFallback.reason, "media websocket timeout");
    assert.equal(errorPayload.call.flowState, "wrap");

    const filtered = await requestJson(port, "GET", "/api/calls?providerCallId=sw-call-123");
    const filteredPayload = filtered.payload as CallListPayload;
    assert.equal(filtered.statusCode, 200);
    assert.equal(filteredPayload.summary.totalCalls, 1);
    assert.equal(filteredPayload.calls[0]?.session.callId, startedPayload.call.session.callId);

    const missingText = await requestJson(port, "POST", "/api/signalwire/events", {
      eventType: "media.transcript",
      signalWireCallId: "sw-call-123",
      text: "   ",
    });

    assert.equal(missingText.statusCode, 400);
    assert.deepEqual(missingText.payload, { ok: false, error: "signalwire_transcript_text_required" });
  });
});

test("GET /api/operator/console returns operator-ready controls and attention-sorted calls", async () => {
  await withServer(async (port) => {
    const idleStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "console-session-idle",
      openclawSessionLabel: "cluecon-demo/console-idle",
    });
    const idleCallId = (idleStarted.payload as SnapshotPayload).session.callId;

    const operatorStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "console-session-operator",
      openclawSessionLabel: "cluecon-demo/console-operator",
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

    const consoleResponse = await requestJson(port, "GET", "/api/operator/console");
    const consolePayload = consoleResponse.payload as OperatorConsolePayload;

    assert.equal(consoleResponse.statusCode, 200);
    assert.equal(consolePayload.runtimeHealth.ok, true);
    assert.equal(typeof consolePayload.generatedAt, "string");
    assert.equal(consolePayload.refreshIntervalMs, 5000);
    assert.equal(consolePayload.runtimeHealth.pipecatFlow.ready, true);
    assert.deepEqual(consolePayload.controls.commandWrappers, ["/operator", "/steer"]);
    assert.deepEqual(consolePayload.controls.callReferenceFields, [
      "callId",
      "providerCallId",
      "openclawSessionId",
      "openclawSessionLabel",
      "openclawSessionRef",
    ]);
    assert.deepEqual(consolePayload.controls.routes, {
      startDemoCall: "/api/demo/start",
      callerTurn: "/api/calls/{callId}/caller-turn",
      steerCall: "/api/calls/{callId}/operator-steer",
      noteCall: "/api/calls/{callId}/operator-note",
      consoleAction: "/api/operator/console/action",
    });
    assert.deepEqual(consolePayload.controls.scriptedCallerTurns, [
      "I want to cancel my policy today.",
      "The renewal increase is too high.",
      "Okay, what safe options can you review for me?",
      "Thanks, please note that follow-up and close the call.",
    ]);
    const approveOfferAction = consolePayload.controls.actions.find((entry) => entry.action === "approve_offer");
    assert.deepEqual(approveOfferAction, {
      action: "approve_offer",
      method: "POST",
      requiresPendingCall: true,
      requiresReason: false,
      postTemplate: "/api/calls/{callId}/operator-steer",
      bodyTemplate: { action: "approve_offer" },
      operatorOutcome: "resume",
      reasonPrompt: null,
      confirmationRequired: false,
      confirmationMessage: null,
      commandExamples: ["/operator approve-offer", "/steer approve offer"],
    });
    const takeoverAction = consolePayload.controls.actions.find((entry) => entry.action === "takeover");
    assert.equal(takeoverAction?.method, "POST");
    assert.deepEqual(takeoverAction?.bodyTemplate, { action: "takeover" });
    assert.equal(takeoverAction?.operatorOutcome, "handoff");
    assert.equal(takeoverAction?.reasonPrompt, null);
    assert.equal(takeoverAction?.confirmationRequired, true);
    assert.equal(takeoverAction?.confirmationMessage, "Takeover gives the operator direct control of the live call.");
    const gotoSlideAction = consolePayload.controls.actions.find((entry) => entry.action === "goto_slide");
    assert.equal(gotoSlideAction?.requiresReason, true);
    assert.equal(gotoSlideAction?.reasonPrompt, "Slide or step");
    assert.equal(consolePayload.queue.summary.totalCalls, 2);
    assert.equal(consolePayload.queue.summary.pendingOperatorSteer, 1);
    assert.equal(consolePayload.queue.summary.scriptCompleted, 0);
    assert.equal(consolePayload.queue.summary.scriptInProgress, 2);
    assert.deepEqual(consolePayload.calls.items.map((call) => call.session.callId), [operatorCallId, idleCallId]);
    const operatorConsoleCall = consolePayload.calls.items[0];
    assert.equal(operatorConsoleCall.evidenceSummary.latestEventType, "agent_turn_appended");
    assert.equal(operatorConsoleCall.evidenceSummary.latestEventTrail, `/api/calls/${operatorCallId}/events?type=agent_turn_appended&limit=1&order=desc`);
    assert.equal(operatorConsoleCall.evidenceSummary.latestTranscriptSpeaker, "agent");
    assert.equal(operatorConsoleCall.evidenceSummary.latestEvidenceAt, "2026-06-10T14:10:10.000Z");
    assert.equal(operatorConsoleCall.evidenceSummary.transcriptTurns, 6);
    assert.equal(operatorConsoleCall.evidenceSummary.eventCount, 18);
    assert.equal(operatorConsoleCall.evidenceSummary.latencyMarkCount, 9);
    assert.equal(operatorConsoleCall.evidenceSummary.operatorNoteCount, 0);
    assert.equal(operatorConsoleCall.evidenceSummary.latestOperatorNoteText, null);
    assert.equal(operatorConsoleCall.evidenceSummary.latestOperatorNoteAt, null);
    assert.equal(operatorConsoleCall.evidenceSummary.latestDisposition, null);
    assert.equal(operatorConsoleCall.evidenceSummary.operatorNoteTrail, null);
    assert.equal(operatorConsoleCall.evidenceSummary.fallbackMode, null);
    assert.equal(operatorConsoleCall.evidenceSummary.fallbackSource, null);
    assert.equal(operatorConsoleCall.evidenceSummary.fallbackSourceTrail, null);
    assert.equal(operatorConsoleCall.evidenceSummary.fallbackSourceQueue, null);
    assert.equal(operatorConsoleCall.evidenceSummary.fallbackSourceCallList, null);
    assert.equal(operatorConsoleCall.evidenceSummary.fallbackSourceOperatorConsole, null);
    assert.equal(operatorConsoleCall.evidenceSummary.fallbackModeTranscriptTrail, null);
    assert.equal(operatorConsoleCall.evidenceSummary.handoffStartedAt, null);
    assert.equal(operatorConsoleCall.evidenceSummary.overBudgetLatencyMarkCount, 0);
    assert.equal(operatorConsoleCall.evidenceSummary.overBudgetLatencyTrail, null);
    assert.deepEqual(operatorConsoleCall.evidenceSummary.links, operatorConsoleCall.session.openclawSession.artifactLinks);
    assert.deepEqual(operatorConsoleCall.actionState, {
      attentionRequired: true,
      pendingApproval: true,
      pendingApprovalDetails: {
        recommendedAction: "approve_offer",
        reason: "safe_offer_review_requested",
        requestedAt: "2026-06-10T14:10:10.000Z",
        source: "mock_http_route",
        approvalPrompt: "Review the held safe-offer guidance before approving or denying the response.",
      },
      fallbackArmed: false,
      nextRecommendedAction: "approve_offer",
      scriptedCallerTurnState: {
        matchedTurns: 3,
        totalTurns: 4,
        remainingTurns: 1,
        progressPct: 75,
        nextTurnIndex: 3,
        nextTurnText: "Thanks, please note that follow-up and close the call.",
        completed: false,
      },
      actionDetails: [
        {
          action: "pause",
          enabled: true,
          disabledReason: null,
          confirmationRequired: false,
          confirmationMessage: null,
          requiresReason: false,
          reasonPrompt: null,
        },
        {
          action: "resume",
          enabled: true,
          disabledReason: null,
          confirmationRequired: false,
          confirmationMessage: null,
          requiresReason: false,
          reasonPrompt: null,
        },
        {
          action: "approve_offer",
          enabled: true,
          disabledReason: null,
          confirmationRequired: false,
          confirmationMessage: null,
          requiresReason: false,
          reasonPrompt: null,
        },
        {
          action: "deny_offer",
          enabled: true,
          disabledReason: null,
          confirmationRequired: false,
          confirmationMessage: null,
          requiresReason: false,
          reasonPrompt: null,
        },
        {
          action: "escalate_to_human",
          enabled: true,
          disabledReason: null,
          confirmationRequired: true,
          confirmationMessage: "Escalating hands the caller to a human operator.",
          requiresReason: false,
          reasonPrompt: null,
        },
        {
          action: "transfer",
          enabled: true,
          disabledReason: null,
          confirmationRequired: true,
          confirmationMessage: "Transferring moves the caller out of the automated demo flow to a human queue.",
          requiresReason: false,
          reasonPrompt: null,
        },
        {
          action: "takeover",
          enabled: true,
          disabledReason: null,
          confirmationRequired: true,
          confirmationMessage: "Takeover gives the operator direct control of the live call.",
          requiresReason: false,
          reasonPrompt: null,
        },
        {
          action: "end_call",
          enabled: true,
          disabledReason: null,
          confirmationRequired: true,
          confirmationMessage: "Ending the call closes the active demo session.",
          requiresReason: false,
          reasonPrompt: null,
        },
        {
          action: "goto_slide",
          enabled: true,
          disabledReason: null,
          confirmationRequired: false,
          confirmationMessage: null,
          requiresReason: true,
          reasonPrompt: "Slide or step",
        },
        {
          action: "ask_operator",
          enabled: true,
          disabledReason: null,
          confirmationRequired: false,
          confirmationMessage: null,
          requiresReason: true,
          reasonPrompt: "Operator question",
        },
        {
          action: "arm_fallback",
          enabled: true,
          disabledReason: null,
          confirmationRequired: true,
          confirmationMessage: "Arming fallback changes the live call path until fallback is disarmed.",
          requiresReason: true,
          reasonPrompt: "Fallback reason",
        },
        {
          action: "disarm_fallback",
          enabled: true,
          disabledReason: null,
          confirmationRequired: false,
          confirmationMessage: null,
          requiresReason: false,
          reasonPrompt: null,
        },
      ],
      availableActions: [
        "pause",
        "resume",
        "approve_offer",
        "deny_offer",
        "escalate_to_human",
        "transfer",
        "takeover",
        "end_call",
        "goto_slide",
        "ask_operator",
        "arm_fallback",
        "disarm_fallback",
      ],
      requiresConfirmationActions: [
        { action: "escalate_to_human", confirmationMessage: "Escalating hands the caller to a human operator." },
        { action: "transfer", confirmationMessage: "Transferring moves the caller out of the automated demo flow to a human queue." },
        { action: "takeover", confirmationMessage: "Takeover gives the operator direct control of the live call." },
        { action: "end_call", confirmationMessage: "Ending the call closes the active demo session." },
        { action: "arm_fallback", confirmationMessage: "Arming fallback changes the live call path until fallback is disarmed." },
      ],
      requiresReasonActions: [
        { action: "goto_slide", reasonPrompt: "Slide or step" },
        { action: "ask_operator", reasonPrompt: "Operator question" },
        { action: "arm_fallback", reasonPrompt: "Fallback reason" },
      ],
      unavailableActions: [],
    });
    const idleConsoleCall = consolePayload.calls.items[1];
    assert.equal(idleConsoleCall?.actionState.pendingApprovalDetails, null);
    assert.equal(idleConsoleCall?.actionState.nextRecommendedAction, "pause");
    assert.deepEqual(idleConsoleCall?.actionState.scriptedCallerTurnState, {
      matchedTurns: 0,
      totalTurns: 4,
      remainingTurns: 4,
      progressPct: 0,
      nextTurnIndex: 0,
      nextTurnText: "I want to cancel my policy today.",
      completed: false,
    });
    assert.deepEqual(
      idleConsoleCall?.actionState.actionDetails
        .filter((entry) => !entry.enabled)
        .map((entry) => ({ action: entry.action, disabledReason: entry.disabledReason })),
      [
        { action: "resume", disabledReason: "pending_operator_steer_required" },
        { action: "approve_offer", disabledReason: "pending_operator_steer_required" },
        { action: "deny_offer", disabledReason: "pending_operator_steer_required" },
        { action: "escalate_to_human", disabledReason: "pending_operator_steer_required" },
      ],
    );
    assert.deepEqual(idleConsoleCall?.actionState.unavailableActions, [
      { action: "resume", reason: "pending_operator_steer_required" },
      { action: "approve_offer", reason: "pending_operator_steer_required" },
      { action: "deny_offer", reason: "pending_operator_steer_required" },
      { action: "escalate_to_human", reason: "pending_operator_steer_required" },
    ]);
    assert.equal(consolePayload.calls.summary.sort, "attentionStartedAt");
    assert.equal(consolePayload.calls.summary.returnedCalls, 2);
    assert.deepEqual(consolePayload.calls.summary.page, {
      offset: 0,
      limit: 25,
      totalFilteredCalls: 2,
      hasMore: false,
      nextOffset: null,
    });

    const filteredConsole = await requestJson(port, "GET", "/api/operator/console?attentionRequired=true&limit=1");
    const filteredPayload = filteredConsole.payload as OperatorConsolePayload;

    assert.equal(filteredConsole.statusCode, 200);
    assert.deepEqual(filteredPayload.calls.items.map((call) => call.session.callId), [operatorCallId]);
    assert.equal(filteredPayload.calls.summary.filteredSummary.attentionRequired, 1);
    assert.equal(filteredPayload.calls.summary.page.limit, 1);

    await requestJson(port, "POST", `/api/calls/${operatorCallId}/fallback`, {
      mode: "tool_timeout",
      reason: "synthetic operator console latency audit",
      timestamp: "2099-01-01T00:00:00.000Z",
    });
    const overBudgetConsole = await requestJson(port, "GET", "/api/operator/console?latencyOverBudget=true");
    const overBudgetPayload = overBudgetConsole.payload as OperatorConsolePayload;
    const overBudgetConsoleCall = overBudgetPayload.calls.items.find((call) => call.session.callId === operatorCallId);

    assert.equal(overBudgetConsole.statusCode, 200);
    assert.equal(overBudgetConsoleCall?.evidenceSummary.overBudgetLatencyMarkCount, 3);
    assert.equal(
      overBudgetConsoleCall?.evidenceSummary.overBudgetLatencyTrail,
      `/api/calls/${operatorCallId}/latency?overBudget=true`,
    );
    assert.equal(overBudgetConsoleCall?.evidenceSummary.fallbackModeQueue, "/api/queue?attentionRequired=true&fallbackMode=tool_timeout");
    assert.equal(overBudgetConsoleCall?.evidenceSummary.fallbackModeCallList, "/api/calls?fallbackMode=tool_timeout&limit=5");
    assert.equal(
      overBudgetConsoleCall?.evidenceSummary.fallbackModeOperatorConsole,
      "/api/operator/console?fallbackMode=tool_timeout&limit=1",
    );

    const sourceFilteredConsole = await requestJson(port, "GET", "/api/operator/console?fallbackSource=tool_timeout_fail_closed");
    const sourceFilteredPayload = sourceFilteredConsole.payload as OperatorConsolePayload;
    assert.equal(sourceFilteredConsole.statusCode, 200);
    assert.deepEqual(sourceFilteredPayload.calls.items.map((call) => call.session.callId), [operatorCallId]);
    assert.equal(sourceFilteredPayload.calls.summary.filteredSummary.totalCalls, 1);

    const activeToolConsole = await requestJson(port, "GET", "/api/operator/console?pipecatActiveTool=pause_presentation");
    const activeToolPayload = activeToolConsole.payload as OperatorConsolePayload;

    assert.equal(activeToolConsole.statusCode, 200);
    assert.deepEqual(activeToolPayload.calls.items.map((call) => call.session.callId), [operatorCallId]);
    assert.equal(activeToolPayload.calls.summary.filteredSummary.attentionRequired, 1);

    const inProgressConsole = await requestJson(port, "GET", "/api/operator/console?scriptCompleted=false");
    const inProgressPayload = inProgressConsole.payload as OperatorConsolePayload;

    assert.equal(inProgressConsole.statusCode, 200);
    assert.deepEqual(inProgressPayload.calls.items.map((call) => call.session.callId), [operatorCallId, idleCallId]);
    assert.equal(inProgressPayload.calls.summary.filteredSummary.scriptCompleted, 0);
    assert.equal(inProgressPayload.calls.summary.filteredSummary.scriptInProgress, 2);

    await requestJson(port, "POST", `/api/calls/${operatorCallId}/operator-steer`, {
      action: "approve_offer",
      timestamp: "2026-06-10T14:10:12.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${operatorCallId}/caller-turn`, {
      text: "Thanks, please note that follow-up and close the call.",
      timestamp: "2026-06-10T14:10:15.000Z",
    });
    const progressedConsole = await requestJson(port, "GET", "/api/operator/console?minScriptProgressPct=75");
    const progressedPayload = progressedConsole.payload as OperatorConsolePayload;

    assert.equal(progressedConsole.statusCode, 200);
    assert.deepEqual(progressedPayload.calls.items.map((call) => call.session.callId), [operatorCallId]);
    assert.equal(progressedPayload.calls.summary.filteredSummary.totalCalls, 1);

    const completedConsole = await requestJson(port, "GET", "/api/operator/console?scriptCompleted=true");
    const completedPayload = completedConsole.payload as OperatorConsolePayload;

    assert.equal(completedConsole.statusCode, 200);
    assert.deepEqual(completedPayload.calls.items.map((call) => call.session.callId), [operatorCallId]);
    assert.equal(completedPayload.calls.summary.filteredSummary.scriptCompleted, 1);
    assert.equal(completedPayload.calls.summary.filteredSummary.scriptInProgress, 0);

    const invalidScriptProgressFilter = await requestJson(port, "GET", "/api/operator/console?minScriptProgressPct=101");
    assert.equal(invalidScriptProgressFilter.statusCode, 400);
    assert.deepEqual(invalidScriptProgressFilter.payload, { ok: false, error: "operator_console_min_script_progress_pct_invalid" });

    const invalidScriptCompletedFilter = await requestJson(port, "GET", "/api/operator/console?scriptCompleted=maybe");
    assert.equal(invalidScriptCompletedFilter.statusCode, 400);
    assert.deepEqual(invalidScriptCompletedFilter.payload, { ok: false, error: "operator_console_script_completed_invalid" });

    const invalidFilter = await requestJson(port, "GET", "/api/operator/console?attentionRequired=maybe");
    assert.equal(invalidFilter.statusCode, 400);
    assert.deepEqual(invalidFilter.payload, { ok: false, error: "operator_console_attention_required_invalid" });
  });
});

test("GET /operator/console serves the local console with the full action set", async () => {
  await withServer(async (port) => {
    const response = await requestText(port, "GET", "/operator/console");

    assert.equal(response.statusCode, 200);
    assert.equal(response.contentType, "text/html; charset=utf-8");
    assert.match(response.body, /<title>Operator Console<\/title>/);
    assert.match(response.body, /Start Demo Call/);
    assert.match(response.body, /Attention only/);
    assert.match(response.body, /Over-budget latency/);
    assert.match(response.body, /Flow state filter/);
    assert.match(response.body, /Fallback mode filter/);
    assert.match(response.body, /All fallback modes/);
    assert.match(response.body, /Fallback source filter/);
    assert.match(response.body, /All fallback sources/);
    assert.match(response.body, /tool_timeout_fail_closed/);
    assert.match(response.body, /pipecat_runtime_failure_fail_closed/);
    assert.match(response.body, /Fallback reason filter/);
    assert.match(response.body, /Fallback reason/);
    assert.match(response.body, /Active tool filter/);
    assert.match(response.body, /All active tools/);
    assert.match(response.body, /Script status filter/);
    assert.match(response.body, /All script states/);
    assert.match(response.body, /Transcript search/);
    assert.match(response.body, /operatorConsoleQuery/);
    assert.match(response.body, /refreshIntervalMs/);
    assert.match(response.body, /scheduleRefresh/);
    assert.match(response.body, /hasDirtyDetailInput/);
    assert.match(response.body, /Refresh paused while editing/);
    assert.match(response.body, /refresh\(\{ auto: true \}\)/);
    assert.match(response.body, /throw new Error\(message\)/);
    assert.match(response.body, /document.hidden/);
    assert.match(response.body, /visibilitychange/);
    assert.match(response.body, /attentionRequired/);
    assert.match(response.body, /latencyOverBudget/);
    assert.match(response.body, /fallbackMode/);
    assert.match(response.body, /fallbackSource/);
    assert.match(response.body, /fallbackReason/);
    assert.match(response.body, /pipecatActiveTool/);
    assert.match(response.body, /scriptCompleted/);
    assert.match(response.body, /script-completed-filter"\)\.addEventListener/);
    assert.match(response.body, /script-completed-filter"\)\.value = ""/);
    assert.match(response.body, /transcriptText/);
    assert.match(response.body, /\/api\/demo\/start/);
    assert.match(response.body, /caller-turn-form/);
    assert.match(response.body, /Caller transcript turn/);
    assert.match(response.body, /scripted-turns/);
    assert.match(response.body, /Scripted Turns/);
    assert.match(response.body, /data-scripted-turn/);
    assert.match(response.body, /postScriptedTurn/);
    assert.match(response.body, /\/caller-turn/);
    assert.match(response.body, /"goto_slide"/);
    assert.match(response.body, /"ask_operator"/);
    assert.match(response.body, /"transfer"/);
    assert.match(response.body, /reasonPrompt/);
    assert.match(response.body, /requiresReason/);
    assert.match(response.body, /confirmationRequired/);
    assert.match(response.body, /confirmationAcknowledged/);
    assert.match(response.body, /Evidence markers/);
    assert.match(response.body, /Live SIP proof/);
    assert.match(response.body, /liveProof/);
    assert.match(response.body, /Audio Capture/);
    assert.match(response.body, /Transcript \/ ASR/);
    assert.match(response.body, /Artifacts \/ Eval/);
    assert.match(response.body, /Handoff State/);
    assert.match(response.body, /runtimeLabels/);
    assert.match(response.body, /ready_with_rtc_asr_blocker/);
    assert.match(response.body, /not_review_ready/);
    assert.match(response.body, /pathHtml/);
    assert.match(response.body, /linkHtml/);
    assert.match(response.body, /attentionDetail/);
    assert.match(response.body, /Proof Bundle/);
    assert.match(response.body, /Artifacts/);
    assert.match(response.body, /Event Trail/);
    assert.match(response.body, /Fallback Queue/);
    assert.match(response.body, /Reason Trail/);
    assert.match(response.body, /reasonTrailHtml/);
    assert.match(response.body, /Note Trail/);
    assert.match(response.body, /operatorNoteTrail/);
    assert.match(response.body, /fallbackSourceTrail/);
    assert.match(response.body, /fallbackModeQueue/);
    assert.match(response.body, /fallbackReasonEventTrail/);
    assert.match(response.body, /overBudgetLatencyTrail/);
    assert.match(response.body, /Over budget:/);
    assert.match(response.body, /evidenceSummary/);
    assert.match(response.body, /callActionMetadata/);
    assert.match(response.body, /actionDetails/);
    assert.match(response.body, /disabledReason/);
    assert.match(response.body, /unavailableReasons/);
    const scripts = [...response.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.ok(scripts.length > 0);
    for (const script of scripts) {
      assert.doesNotThrow(() => new Script(script));
    }

    assert.match(response.body, /Confirm /);
  });
});

test("POST /api/operator/console/action dispatches live call controls", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:11:00.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "The renewal increase is too high.",
      timestamp: "2026-06-10T14:11:05.000Z",
    });
    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Okay, what safe options can you review for me?",
      timestamp: "2026-06-10T14:11:10.000Z",
    });

    const action = await requestJson(port, "POST", "/api/operator/console/action", {
      callId,
      command: "/operator approve-offer",
      timestamp: "2026-06-10T14:11:12.000Z",
    });
    const payload = action.payload as { ok: boolean; route: string; appliedAction: string; call: SnapshotPayload };

    assert.equal(action.statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/operator/console/action");
    assert.equal(payload.appliedAction, "approve_offer");
    assert.equal(payload.call.session.callId, callId);
    assert.equal(payload.call.operatorSteer.pending, false);
    assert.equal(payload.call.operatorSteer.lastAction, "approve_offer");
    assert.equal(payload.call.flowState, "steered_response");

    const refStarted = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "console-ref-session",
      openclawSessionLabel: "cluecon-demo/console-ref",
    });
    const refCall = refStarted.payload as SnapshotPayload;
    const refAction = await requestJson(port, "POST", "/api/operator/console/action", {
      providerCallId: refCall.session.providerCallId,
      command: "/operator pause",
      timestamp: "2026-06-10T14:11:20.000Z",
    });
    const refPayload = refAction.payload as { ok: boolean; call: SnapshotPayload };

    assert.equal(refAction.statusCode, 200);
    assert.equal(refPayload.call.session.callId, refCall.session.callId);
    assert.equal(refPayload.call.operatorSteer.lastAction, "pause");

    const unconfirmedSessionRefAction = await requestJson(port, "POST", "/api/operator/console/action", {
      openclawSessionRef: "cluecon-demo/console-ref",
      command: "/operator takeover",
      timestamp: "2026-06-10T14:11:21.000Z",
    });

    assert.equal(unconfirmedSessionRefAction.statusCode, 400);
    assert.deepEqual(unconfirmedSessionRefAction.payload, {
      ok: false,
      error: "operator_console_confirmation_required",
      action: "takeover",
      confirmationRequired: true,
      confirmationMessage: "Takeover gives the operator direct control of the live call.",
      confirmationAcknowledgementField: "confirmationAcknowledged",
    });

    const sessionRefAction = await requestJson(port, "POST", "/api/operator/console/action", {
      openclawSessionRef: "cluecon-demo/console-ref",
      command: "/operator takeover",
      confirmationAcknowledged: true,
      timestamp: "2026-06-10T14:11:21.000Z",
    });
    const sessionRefPayload = sessionRefAction.payload as { ok: boolean; call: SnapshotPayload };

    assert.equal(sessionRefAction.statusCode, 200);
    assert.equal(sessionRefPayload.call.session.callId, refCall.session.callId);
    assert.equal(sessionRefPayload.call.operatorSteer.lastAction, "takeover");
    const takeoverAppliedEvent = sessionRefPayload.call.events.find(
      (event) => event.type === "operator_steer_applied" && event.detail.action === "takeover",
    );
    assert.equal(takeoverAppliedEvent?.detail.sourceRoute, "/api/operator/console/action");
    assert.equal(takeoverAppliedEvent?.detail.confirmationAcknowledged, true);

    const transferStarted = await requestJson(port, "POST", "/api/demo/start");
    const transferCallId = (transferStarted.payload as SnapshotPayload).session.callId;
    const transferAction = await requestJson(port, "POST", "/api/operator/console/action", {
      callId: transferCallId,
      command: "/operator transfer",
      confirmationAcknowledged: true,
      timestamp: "2026-06-10T14:11:25.000Z",
    });
    const transferPayload = transferAction.payload as { ok: boolean; call: SnapshotPayload };

    assert.equal(transferAction.statusCode, 200);
    assert.equal(transferPayload.call.operatorSteer.lastAction, "transfer");
    assert.equal(transferPayload.call.flowState, "wrap");
    assert.equal(transferPayload.call.events.some((event) => event.type === "operator_transfer_started"), true);

    const missingCall = await requestJson(port, "POST", "/api/operator/console/action", { action: "pause" });
    assert.equal(missingCall.statusCode, 400);
    assert.deepEqual(missingCall.payload, { ok: false, error: "operator_console_action_call_ref_required" });

    const unknownRef = await requestJson(port, "POST", "/api/operator/console/action", {
      providerCallId: "missing-provider-call",
      action: "pause",
    });
    assert.equal(unknownRef.statusCode, 400);
    assert.deepEqual(unknownRef.payload, { ok: false, error: "operator_console_action_call_ref_not_found" });
  });
});

test("POST /api/calls/:callId/operator-note records operator notes and dispositions", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start");
    const callId = (started.payload as SnapshotPayload).session.callId;

    const noted = await requestJson(port, "POST", "/api/calls/" + callId + "/operator-note", {
      text: "Customer asked for licensed follow-up after safe offer review.",
      disposition: "follow_up_requested",
      timestamp: "2026-06-10T14:12:00.000Z",
    });
    const notedPayload = noted.payload as SnapshotPayload;

    assert.equal(noted.statusCode, 200);
    assert.deepEqual(notedPayload.transcript.at(-1), {
      speaker: "operator",
      text: "Customer asked for licensed follow-up after safe offer review.",
      timestamp: "2026-06-10T14:12:00.000Z",
    });
    assert.deepEqual(notedPayload.events.at(-1), {
      type: "operator_note_recorded",
      at: "2026-06-10T14:12:00.000Z",
      detail: {
        text: "Customer asked for licensed follow-up after safe offer review.",
        disposition: "follow_up_requested",
        source: "mock_http_route",
        transcriptLength: notedPayload.transcript.length,
      },
    });

    const proof = await requestJson(port, "GET", "/api/calls/" + callId + "/proof");
    const proofPayload = proof.payload as {
      evidenceRoutes: { operatorNoteTrail: string | null };
      summary: {
        operatorNoteCount: number;
        latestOperatorNoteAt: string | null;
        latestDisposition: string | null;
        operatorNoteTrail: string | null;
      };
      events: Array<{ type: string }>;
      transcript: Array<{ speaker: string; text: string }>;
    };
    assert.equal(proofPayload.events.some((event) => event.type === "operator_note_recorded"), true);
    assert.equal(proofPayload.transcript.some((turn) => turn.speaker === "operator" && turn.text.includes("licensed follow-up")), true);
    assert.equal(proofPayload.summary.operatorNoteCount, 1);
    assert.equal(proofPayload.summary.latestOperatorNoteAt, "2026-06-10T14:12:00.000Z");
    assert.equal(proofPayload.summary.latestDisposition, "follow_up_requested");
    assert.equal(proofPayload.summary.operatorNoteTrail, "/api/calls/" + callId + "/events?type=operator_note_recorded");
    assert.equal(proofPayload.evidenceRoutes.operatorNoteTrail, "/api/calls/" + callId + "/events?type=operator_note_recorded");

    const consoleResponse = await requestJson(port, "GET", "/api/operator/console?callId=" + callId);
    const consolePayload = consoleResponse.payload as OperatorConsolePayload;
    const consoleCall = consolePayload.calls.items[0];

    assert.equal(consoleResponse.statusCode, 200);
    assert.equal(consoleCall.evidenceSummary.operatorNoteCount, 1);
    assert.equal(consoleCall.evidenceSummary.latestOperatorNoteText, "Customer asked for licensed follow-up after safe offer review.");
    assert.equal(consoleCall.evidenceSummary.latestOperatorNoteAt, "2026-06-10T14:12:00.000Z");
    assert.equal(consoleCall.evidenceSummary.latestDisposition, "follow_up_requested");
    assert.equal(consoleCall.evidenceSummary.operatorNoteTrail, `/api/calls/${callId}/events?type=operator_note_recorded`);

    const manifest = await requestJson(port, "GET", "/api/calls/" + callId + "/artifacts");
    const manifestPayload = manifest.payload as ArtifactManifestPayload;
    assert.equal(manifestPayload.evidenceRoutes.operatorNoteTrail, `/api/calls/${callId}/events?type=operator_note_recorded`);

    const missingText = await requestJson(port, "POST", "/api/calls/" + callId + "/operator-note", { text: "   " });
    assert.equal(missingText.statusCode, 400);
    assert.deepEqual(missingText.payload, { ok: false, error: "operator_note_text_required" });
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

    const oversizedLimit = await requestJson(port, "GET", "/api/calls?limit=101");
    assert.equal(oversizedLimit.statusCode, 400);
    assert.deepEqual(oversizedLimit.payload, { ok: false, error: "call_list_limit_invalid" });

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

    const byTranscript = await requestJson(port, "GET", "/api/calls?transcriptText=RENEWAL%20increase");
    const byTranscriptPayload = byTranscript.payload as CallListPayload;
    assert.equal(byTranscript.statusCode, 200);
    assert.deepEqual(byTranscriptPayload.calls.map((call) => call.session.callId), [firstCallId]);
    assert.equal(byTranscriptPayload.summary.filteredCalls, 1);
    assert.equal(byTranscriptPayload.summary.filteredSummary.totalCalls, 1);

    const byLatencyStage = await requestJson(port, "GET", "/api/calls?latencyStage=caller_turn_received");
    const byLatencyStagePayload = byLatencyStage.payload as CallListPayload;
    assert.equal(byLatencyStage.statusCode, 200);
    assert.deepEqual(byLatencyStagePayload.calls.map((call) => call.session.callId), [firstCallId]);
    assert.equal(byLatencyStagePayload.summary.filteredCalls, 1);
    assert.equal(byLatencyStagePayload.summary.filteredSummary.totalCalls, 1);

    const byActiveTool = await requestJson(port, "GET", "/api/calls?pipecatActiveTool=goto_slide");
    const byActiveToolPayload = byActiveTool.payload as CallListPayload;
    assert.equal(byActiveTool.statusCode, 200);
    assert.deepEqual(byActiveToolPayload.calls.map((call) => call.session.callId), [firstCallId]);
    assert.equal(byActiveToolPayload.summary.filteredCalls, 1);
    assert.equal(byActiveToolPayload.summary.filteredSummary.totalCalls, 1);

    const nearCompleteScript = await requestJson(port, "GET", "/api/calls?minScriptProgressPct=50");
    const nearCompleteScriptPayload = nearCompleteScript.payload as CallListPayload;
    assert.equal(nearCompleteScript.statusCode, 200);
    assert.deepEqual(nearCompleteScriptPayload.calls.map((call) => call.session.callId), [firstCallId]);
    assert.equal(nearCompleteScriptPayload.summary.filteredSummary.totalCalls, 1);

    const earlyScript = await requestJson(port, "GET", "/api/calls?maxScriptProgressPct=25");
    const earlyScriptPayload = earlyScript.payload as CallListPayload;
    assert.equal(earlyScript.statusCode, 200);
    assert.deepEqual(earlyScriptPayload.calls.map((call) => call.session.callId), ["demo-call-0002"]);
    assert.equal(earlyScriptPayload.summary.filteredSummary.totalCalls, 1);

    const noActiveTool = await requestJson(port, "GET", "/api/calls?pipecatActiveTool=missing_tool");
    const noActiveToolPayload = noActiveTool.payload as CallListPayload;
    assert.equal(noActiveTool.statusCode, 200);
    assert.deepEqual(noActiveToolPayload.calls.map((call) => call.session.callId), []);
    assert.equal(noActiveToolPayload.summary.filteredSummary.totalCalls, 0);

    await requestJson(port, "POST", `/api/calls/${firstCallId}/fallback`, {
      mode: "tool_timeout",
      reason: "synthetic future latency audit",
      timestamp: "2099-01-01T00:00:00.000Z",
    });

    const byFallbackSource = await requestJson(port, "GET", "/api/calls?fallbackSource=tool_timeout_fail_closed");
    const byFallbackSourcePayload = byFallbackSource.payload as CallListPayload;
    assert.equal(byFallbackSource.statusCode, 200);
    assert.deepEqual(byFallbackSourcePayload.calls.map((call) => call.session.callId), [firstCallId]);
    assert.equal(byFallbackSourcePayload.summary.filteredSummary.totalCalls, 1);

    const noFallbackSource = await requestJson(port, "GET", "/api/calls?fallbackSource=pipecat_runtime_failure_fail_closed");
    const noFallbackSourcePayload = noFallbackSource.payload as CallListPayload;
    assert.equal(noFallbackSource.statusCode, 200);
    assert.deepEqual(noFallbackSourcePayload.calls.map((call) => call.session.callId), []);
    assert.equal(noFallbackSourcePayload.summary.filteredSummary.totalCalls, 0);

    const mismatchedLatencyFilters = await requestJson(
      port,
      "GET",
      "/api/calls?latencyStage=call_bootstrapped&latencyOverBudget=true",
    );
    const mismatchedLatencyPayload = mismatchedLatencyFilters.payload as CallListPayload;
    assert.equal(mismatchedLatencyFilters.statusCode, 200);
    assert.deepEqual(mismatchedLatencyPayload.calls.map((call) => call.session.callId), []);
    assert.equal(mismatchedLatencyPayload.summary.filteredSummary.totalCalls, 0);

    const noLatencyStage = await requestJson(port, "GET", "/api/calls?latencyStage=missing_stage");
    const noLatencyStagePayload = noLatencyStage.payload as CallListPayload;
    assert.equal(noLatencyStage.statusCode, 200);
    assert.deepEqual(noLatencyStagePayload.calls.map((call) => call.session.callId), []);
    assert.equal(noLatencyStagePayload.summary.filteredSummary.totalCalls, 0);

    const invalidFallbackSource = await requestJson(port, "GET", "/api/calls?fallbackSource=%20%20%20");
    assert.equal(invalidFallbackSource.statusCode, 400);
    assert.deepEqual(invalidFallbackSource.payload, {
      ok: false,
      error: "call_list_fallback_source_invalid",
    });

    const invalidLatencyStage = await requestJson(port, "GET", "/api/calls?latencyStage=%20%20%20");
    assert.equal(invalidLatencyStage.statusCode, 400);
    assert.deepEqual(invalidLatencyStage.payload, {
      ok: false,
      error: "call_list_latency_stage_invalid",
    });

    const invalidActiveTool = await requestJson(port, "GET", "/api/calls?pipecatActiveTool=%20%20%20");
    assert.equal(invalidActiveTool.statusCode, 400);
    assert.deepEqual(invalidActiveTool.payload, {
      ok: false,
      error: "call_list_pipecat_active_tool_invalid",
    });

    const invalidMinScriptProgress = await requestJson(port, "GET", "/api/calls?minScriptProgressPct=101");
    assert.equal(invalidMinScriptProgress.statusCode, 400);
    assert.deepEqual(invalidMinScriptProgress.payload, {
      ok: false,
      error: "call_list_min_script_progress_pct_invalid",
    });

    const invalidMaxScriptProgress = await requestJson(port, "GET", "/api/calls?maxScriptProgressPct=fast");
    assert.equal(invalidMaxScriptProgress.statusCode, 400);
    assert.deepEqual(invalidMaxScriptProgress.payload, {
      ok: false,
      error: "call_list_max_script_progress_pct_invalid",
    });

    const invalidLatencyOverBudget = await requestJson(port, "GET", "/api/calls?latencyOverBudget=maybe");
    assert.equal(invalidLatencyOverBudget.statusCode, 400);
    assert.deepEqual(invalidLatencyOverBudget.payload, {
      ok: false,
      error: "call_list_latency_over_budget_invalid",
    });

    const invalidTranscriptText = await requestJson(port, "GET", "/api/calls?transcriptText=%20%20%20");
    assert.equal(invalidTranscriptText.statusCode, 400);
    assert.deepEqual(invalidTranscriptText.payload, {
      ok: false,
      error: "call_list_transcript_text_invalid",
    });

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

    const freshAttention = await requestJson(port, "GET", "/api/calls?maxAttentionAgeMs=999999999999999");
    const freshPayload = freshAttention.payload as CallListPayload;
    assert.equal(freshAttention.statusCode, 200);
    assert.deepEqual(freshPayload.calls.map((call) => call.session.callId), [pendingCallId, fallbackCallId]);
    assert.equal(freshPayload.summary.filteredCalls, 2);

    const noFreshAttention = await requestJson(port, "GET", "/api/calls?maxAttentionAgeMs=0");
    const noFreshPayload = noFreshAttention.payload as CallListPayload;
    assert.equal(noFreshAttention.statusCode, 200);
    assert.deepEqual(noFreshPayload.calls.map((call) => call.session.callId), []);
    assert.equal(noFreshPayload.summary.filteredSummary.totalCalls, 0);

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

    const invalidMaxAge = await requestJson(port, "GET", "/api/calls?maxAttentionAgeMs=slow");
    assert.equal(invalidMaxAge.statusCode, 400);
    assert.deepEqual(invalidMaxAge.payload, {
      ok: false,
      error: "call_list_max_attention_age_ms_invalid",
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

    const freshAttention = await requestJson(port, "GET", "/api/queue?maxAttentionAgeMs=999999999999999");
    const freshPayload = freshAttention.payload as QueueSummaryPayload;
    assert.equal(freshAttention.statusCode, 200);
    assert.equal(freshPayload.summary.totalCalls, 2);
    assert.equal(freshPayload.summary.attentionRequired, 2);

    const noFreshAttention = await requestJson(port, "GET", "/api/queue?maxAttentionAgeMs=0");
    const noFreshPayload = noFreshAttention.payload as QueueSummaryPayload;
    assert.equal(noFreshAttention.statusCode, 200);
    assert.equal(noFreshPayload.summary.totalCalls, 0);
    assert.equal(noFreshPayload.summary.attentionRequired, 0);

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

    const byTranscript = await requestJson(port, "GET", "/api/queue?transcriptText=safe%20options");
    const byTranscriptPayload = byTranscript.payload as QueueSummaryPayload;
    assert.equal(byTranscript.statusCode, 200);
    assert.equal(byTranscriptPayload.summary.totalCalls, 1);
    assert.equal(byTranscriptPayload.summary.oldestAttentionCallId, firstCallId);

    const byLatencyStage = await requestJson(port, "GET", "/api/queue?latencyStage=caller_turn_received");
    const byLatencyStagePayload = byLatencyStage.payload as QueueSummaryPayload;
    assert.equal(byLatencyStage.statusCode, 200);
    assert.equal(byLatencyStagePayload.summary.totalCalls, 1);
    assert.equal(byLatencyStagePayload.summary.oldestAttentionCallId, firstCallId);

    await requestJson(port, "POST", `/api/calls/${fallbackCallId}/fallback`, {
      mode: "tool_timeout",
      reason: "synthetic future latency audit",
      timestamp: "2099-01-01T00:00:00.000Z",
    });

    const mismatchedLatencyFilters = await requestJson(
      port,
      "GET",
      "/api/queue?latencyStage=call_bootstrapped&latencyOverBudget=true",
    );
    const mismatchedLatencyPayload = mismatchedLatencyFilters.payload as QueueSummaryPayload;
    assert.equal(mismatchedLatencyFilters.statusCode, 200);
    assert.equal(mismatchedLatencyPayload.summary.totalCalls, 0);
    assert.equal(mismatchedLatencyPayload.summary.oldestAttentionCallId, null);

    const byActiveTool = await requestJson(port, "GET", "/api/queue?pipecatActiveTool=ask_operator");
    const byActiveToolPayload = byActiveTool.payload as QueueSummaryPayload;
    assert.equal(byActiveTool.statusCode, 200);
    assert.equal(byActiveToolPayload.summary.totalCalls, 1);
    assert.equal(byActiveToolPayload.summary.attentionRequired, 1);
    assert.equal(byActiveToolPayload.summary.oldestAttentionCallId, firstCallId);

    const noActiveTool = await requestJson(port, "GET", "/api/queue?pipecatActiveTool=missing_tool");
    const noActiveToolPayload = noActiveTool.payload as QueueSummaryPayload;
    assert.equal(noActiveTool.statusCode, 200);
    assert.equal(noActiveToolPayload.summary.totalCalls, 0);
    assert.equal(noActiveToolPayload.summary.oldestAttentionCallId, null);

    const noLatencyStage = await requestJson(port, "GET", "/api/queue?latencyStage=missing_stage");
    const noLatencyStagePayload = noLatencyStage.payload as QueueSummaryPayload;
    assert.equal(noLatencyStage.statusCode, 200);
    assert.equal(noLatencyStagePayload.summary.totalCalls, 0);
    assert.equal(noLatencyStagePayload.summary.oldestAttentionCallId, null);

    const invalidLatencyStage = await requestJson(port, "GET", "/api/queue?latencyStage=%20%20%20");
    assert.equal(invalidLatencyStage.statusCode, 400);
    assert.deepEqual(invalidLatencyStage.payload, {
      ok: false,
      error: "queue_latency_stage_invalid",
    });

    const invalidActiveTool = await requestJson(port, "GET", "/api/queue?pipecatActiveTool=%20%20%20");
    assert.equal(invalidActiveTool.statusCode, 400);
    assert.deepEqual(invalidActiveTool.payload, {
      ok: false,
      error: "queue_pipecat_active_tool_invalid",
    });

    const invalidLatencyOverBudget = await requestJson(port, "GET", "/api/queue?latencyOverBudget=maybe");
    assert.equal(invalidLatencyOverBudget.statusCode, 400);
    assert.deepEqual(invalidLatencyOverBudget.payload, {
      ok: false,
      error: "queue_latency_over_budget_invalid",
    });

    const invalidTranscriptText = await requestJson(port, "GET", "/api/queue?transcriptText=%20%20%20");
    assert.equal(invalidTranscriptText.statusCode, 400);
    assert.deepEqual(invalidTranscriptText.payload, {
      ok: false,
      error: "queue_transcript_text_invalid",
    });

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

    const invalidFallbackMode = await requestJson(port, "GET", "/api/queue?fallbackMode=manual_takeover");
    assert.equal(invalidFallbackMode.statusCode, 400);
    assert.deepEqual(invalidFallbackMode.payload, {
      ok: false,
      error: "queue_fallback_mode_invalid",
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

    const invalidMaxAge = await requestJson(port, "GET", "/api/queue?maxAttentionAgeMs=slow");
    assert.equal(invalidMaxAge.statusCode, 400);
    assert.deepEqual(invalidMaxAge.payload, {
      ok: false,
      error: "queue_max_attention_age_ms_invalid",
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

test("operators can deny an offer approval with a visible safe response", async () => {
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
    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Okay, what safe options can you review for me?",
      timestamp: "2026-06-10T14:00:10.000Z",
    });

    const denied = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "deny_offer",
      timestamp: "2026-06-10T14:00:11.000Z",
    });
    const deniedPayload = denied.payload as SnapshotPayload;
    assert.equal(denied.statusCode, 200);
    assert.equal(deniedPayload.flowState, "steered_response");
    assert.equal(deniedPayload.operatorSteer.pending, false);
    assert.equal(deniedPayload.operatorSteer.lastAction, "deny_offer");
    assert.equal(deniedPayload.events.some((event) => event.type === "operator_offer_denied"), true);

    const safeAgentTurn = [...deniedPayload.transcript].reverse().find((turn) => turn.speaker === "agent");
    assert.ok(safeAgentTurn);
    assert.equal(safeAgentTurn.text.includes("did not approve a retention offer"), true);
    assert.equal(safeAgentTurn.text.includes("cannot discuss a billing credit"), true);
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

    const invalidAttachFailureFlag = await requestJson(port, "POST", "/api/demo/start", {
      simulateOpenClawAttachFailure: "yes",
    });
    const invalidAttachFailureFlagPayload = invalidAttachFailureFlag.payload as { error: string };

    assert.equal(invalidAttachFailureFlag.statusCode, 400);
    assert.equal(invalidAttachFailureFlagPayload.error, "openclaw_attach_failure_flag_invalid");

    const attachFailure = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "attach-failure-session",
      openclawSessionLabel: "cluecon-demo/attach-failure",
      simulateOpenClawAttachFailure: true,
    });
    const attachFailurePayload = attachFailure.payload as {
      session: {
        callId: string;
        openclawSession: { sessionId: string; label: string; status: string; attachError: string | null };
      };
      events: Array<{ type: string; detail: Record<string, string | number | boolean | null> }>;
    };

    assert.equal(attachFailure.statusCode, 201);
    assert.equal(attachFailurePayload.session.openclawSession.sessionId, "attach-failure-session");
    assert.equal(attachFailurePayload.session.openclawSession.label, "cluecon-demo/attach-failure");
    assert.equal(attachFailurePayload.session.openclawSession.status, "attach_failed_mock");
    assert.equal(attachFailurePayload.session.openclawSession.attachError, "simulated_openclaw_session_attach_failure");
    assert.equal(
      attachFailurePayload.events.some((event) => event.type === "openclaw_session_attach_failed"),
      true,
    );
    assert.equal(
      attachFailurePayload.events.some((event) => event.detail.proofPath === `/api/calls/${attachFailurePayload.session.callId}/proof`),
      true,
    );

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

    const runtimeFailureStarted = await requestJson(port, "POST", "/api/demo/start");
    const runtimeFailureCallId = (runtimeFailureStarted.payload as { session: { callId: string } }).session.callId;
    const runtimeFailure = await requestJson(port, "POST", `/api/calls/${runtimeFailureCallId}/fallback`, {
      mode: "runtime_failure",
      reason: "pipecat local runtime import failed",
      timestamp: "2026-06-10T14:00:03.000Z",
    });
    const runtimeFailurePayload = runtimeFailure.payload as SnapshotPayload;

    assert.equal(runtimeFailure.statusCode, 200);
    assert.equal(runtimeFailurePayload.flowState, "wrap");
    assert.equal(runtimeFailurePayload.demoFallback.mode, "runtime_failure");
    assert.equal(runtimeFailurePayload.demoFallback.reason, "pipecat local runtime import failed");
    const runtimeFailureHandoff = runtimeFailurePayload.events.find((event) => event.type === "human_handoff_started");
    assert.ok(runtimeFailureHandoff);
    assert.equal(runtimeFailureHandoff.detail.source, "pipecat_runtime_failure_fail_closed");
    assert.equal(runtimeFailureHandoff.detail.reason, "pipecat local runtime import failed");
    const runtimeFailureAgentTurn = [...runtimeFailurePayload.transcript].reverse().find((turn) => turn.speaker === "agent");
    assert.ok(runtimeFailureAgentTurn);
    assert.equal(runtimeFailureAgentTurn.text.toLowerCase().includes("runtime reported a failure"), true);

    const runtimeFailureProof = await requestJson(port, "GET", `/api/calls/${runtimeFailureCallId}/proof`);
    const runtimeFailureProofPayload = runtimeFailureProof.payload as {
      outcome: { fallbackMode: string | null; fallbackReason: string | null; fallbackSource: string | null; handoffStarted: boolean; handoffStartedAt: string | null };
      evidenceRoutes: {
        fallbackSourceTrail: string | null;
        fallbackSourceQueue: string | null;
        fallbackSourceCallList: string | null;
        fallbackSourceOperatorConsole: string | null;
        fallbackModeQueue: string | null;
        fallbackModeCallList: string | null;
        fallbackModeOperatorConsole: string | null;
        fallbackModeTranscriptTrail: string | null;
        fallbackReasonQueue: string | null;
        fallbackReasonCallList: string | null;
        fallbackReasonOperatorConsole: string | null;
        fallbackReasonEventTrail: string | null;
        handoffTrail: string | null;
        overBudgetLatencyTrail: string | null;
      };
      summary: {
        fallbackSourceTrail: string | null;
        fallbackSourceQueue: string | null;
        fallbackSourceCallList: string | null;
        fallbackSourceOperatorConsole: string | null;
        fallbackModeQueue: string | null;
        fallbackModeCallList: string | null;
        fallbackModeOperatorConsole: string | null;
        fallbackModeTranscriptTrail: string | null;
        fallbackReasonQueue: string | null;
        fallbackReasonCallList: string | null;
        fallbackReasonOperatorConsole: string | null;
        fallbackReasonEventTrail: string | null;
        handoffTrail: string | null;
        overBudgetLatencyTrail: string | null;
      };
    };

    assert.equal(runtimeFailureProof.statusCode, 200);
    assert.equal(runtimeFailureProofPayload.outcome.fallbackMode, "runtime_failure");
    assert.equal(runtimeFailureProofPayload.outcome.fallbackReason, "pipecat local runtime import failed");
    assert.equal(runtimeFailureProofPayload.outcome.fallbackSource, "pipecat_runtime_failure_fail_closed");
    assert.equal(runtimeFailureProofPayload.outcome.handoffStarted, true);
    assert.equal(runtimeFailureProofPayload.outcome.handoffStartedAt, "2026-06-10T14:00:03.000Z");
    assert.equal(runtimeFailureProofPayload.summary.handoffTrail, `/api/calls/${runtimeFailureCallId}/events?type=human_handoff_started&limit=1&order=desc`);
    assert.equal(
      runtimeFailureProofPayload.summary.fallbackSourceTrail,
      `/api/calls/${runtimeFailureCallId}/events?source=pipecat_runtime_failure_fail_closed`,
    );
    assert.equal(runtimeFailureProofPayload.summary.fallbackSourceQueue, "/api/queue?attentionRequired=true&fallbackSource=pipecat_runtime_failure_fail_closed");
    assert.equal(runtimeFailureProofPayload.summary.fallbackSourceCallList, "/api/calls?fallbackSource=pipecat_runtime_failure_fail_closed&limit=5");
    assert.equal(runtimeFailureProofPayload.summary.fallbackSourceOperatorConsole, "/api/operator/console?fallbackSource=pipecat_runtime_failure_fail_closed&limit=1");
    assert.equal(runtimeFailureProofPayload.summary.fallbackModeQueue, "/api/queue?attentionRequired=true&fallbackMode=runtime_failure");
    assert.equal(runtimeFailureProofPayload.summary.fallbackModeCallList, "/api/calls?fallbackMode=runtime_failure&limit=5");
    assert.equal(runtimeFailureProofPayload.summary.fallbackModeOperatorConsole, "/api/operator/console?fallbackMode=runtime_failure&limit=1");
    assert.equal(
      runtimeFailureProofPayload.summary.fallbackModeTranscriptTrail,
      `/api/calls/${runtimeFailureCallId}/transcript?speaker=agent&text=runtime%20reported%20a%20failure`,
    );
    assert.equal(runtimeFailureProofPayload.summary.overBudgetLatencyTrail, null);
    assert.equal(
      runtimeFailureProofPayload.evidenceRoutes.fallbackSourceTrail,
      `/api/calls/${runtimeFailureCallId}/events?source=pipecat_runtime_failure_fail_closed`,
    );
    assert.equal(runtimeFailureProofPayload.evidenceRoutes.fallbackSourceQueue, "/api/queue?attentionRequired=true&fallbackSource=pipecat_runtime_failure_fail_closed");
    assert.equal(runtimeFailureProofPayload.evidenceRoutes.fallbackSourceCallList, "/api/calls?fallbackSource=pipecat_runtime_failure_fail_closed&limit=5");
    assert.equal(runtimeFailureProofPayload.evidenceRoutes.fallbackSourceOperatorConsole, "/api/operator/console?fallbackSource=pipecat_runtime_failure_fail_closed&limit=1");
    assert.equal(runtimeFailureProofPayload.evidenceRoutes.fallbackModeQueue, "/api/queue?attentionRequired=true&fallbackMode=runtime_failure");
    assert.equal(runtimeFailureProofPayload.evidenceRoutes.fallbackModeCallList, "/api/calls?fallbackMode=runtime_failure&limit=5");
    assert.equal(runtimeFailureProofPayload.evidenceRoutes.fallbackModeOperatorConsole, "/api/operator/console?fallbackMode=runtime_failure&limit=1");
    assert.equal(
      runtimeFailureProofPayload.evidenceRoutes.fallbackModeTranscriptTrail,
      `/api/calls/${runtimeFailureCallId}/transcript?speaker=agent&text=runtime%20reported%20a%20failure`,
    );
    assert.equal(runtimeFailureProofPayload.evidenceRoutes.handoffTrail, `/api/calls/${runtimeFailureCallId}/events?type=human_handoff_started&limit=1&order=desc`);
    assert.equal(runtimeFailureProofPayload.evidenceRoutes.overBudgetLatencyTrail, null);

    const runtimeFailureCalls = await requestJson(port, "GET", "/api/calls?fallbackMode=runtime_failure");
    const runtimeFailureCallsPayload = runtimeFailureCalls.payload as CallListPayload;
    assert.equal(runtimeFailureCalls.statusCode, 200);
    assert.deepEqual(runtimeFailureCallsPayload.calls.map((call) => call.session.callId), [runtimeFailureCallId]);
    assert.equal(runtimeFailureCallsPayload.summary.filteredSummary.fallbackArmed, 1);

    const runtimeFailureReason = encodeURIComponent("pipecat local runtime import failed");
    assert.equal(runtimeFailureProofPayload.summary.fallbackReasonQueue, "/api/queue?fallbackReason=" + runtimeFailureReason);
    assert.equal(runtimeFailureProofPayload.summary.fallbackReasonCallList, "/api/calls?fallbackReason=" + runtimeFailureReason + "&limit=5");
    assert.equal(
      runtimeFailureProofPayload.summary.fallbackReasonOperatorConsole,
      "/api/operator/console?fallbackReason=" + runtimeFailureReason + "&limit=1",
    );
    assert.equal(
      runtimeFailureProofPayload.summary.fallbackReasonEventTrail,
      `/api/calls/${runtimeFailureCallId}/events?detailText=${runtimeFailureReason}`,
    );
    assert.equal(runtimeFailureProofPayload.evidenceRoutes.fallbackReasonQueue, "/api/queue?fallbackReason=" + runtimeFailureReason);
    assert.equal(runtimeFailureProofPayload.evidenceRoutes.fallbackReasonCallList, "/api/calls?fallbackReason=" + runtimeFailureReason + "&limit=5");
    assert.equal(
      runtimeFailureProofPayload.evidenceRoutes.fallbackReasonOperatorConsole,
      "/api/operator/console?fallbackReason=" + runtimeFailureReason + "&limit=1",
    );
    assert.equal(
      runtimeFailureProofPayload.evidenceRoutes.fallbackReasonEventTrail,
      `/api/calls/${runtimeFailureCallId}/events?detailText=${runtimeFailureReason}`,
    );

    const runtimeFailureReasonTrail = await requestJson(port, "GET", `/api/calls/${runtimeFailureCallId}/events?detailText=${runtimeFailureReason}`);
    const runtimeFailureReasonTrailPayload = runtimeFailureReasonTrail.payload as EventTrailPayload;
    assert.equal(runtimeFailureReasonTrail.statusCode, 200);
    assert.equal(runtimeFailureReasonTrailPayload.summary.filteredDetailText, "pipecat local runtime import failed");
    assert.deepEqual(
      runtimeFailureReasonTrailPayload.events.map((event) => event.type),
      ["demo_fallback_triggered", "human_handoff_started"],
    );

    const runtimeFailureReasonCalls = await requestJson(port, "GET", "/api/calls?fallbackReason=" + runtimeFailureReason);
    const runtimeFailureReasonCallsPayload = runtimeFailureReasonCalls.payload as CallListPayload;
    assert.equal(runtimeFailureReasonCalls.statusCode, 200);
    assert.deepEqual(runtimeFailureReasonCallsPayload.calls.map((call) => call.session.callId), [runtimeFailureCallId]);
    assert.equal(runtimeFailureReasonCallsPayload.summary.filteredSummary.fallbackArmed, 1);

    const runtimeFailureReasonQueue = await requestJson(port, "GET", "/api/queue?fallbackReason=" + runtimeFailureReason);
    const runtimeFailureReasonQueuePayload = runtimeFailureReasonQueue.payload as QueueSummaryPayload;
    assert.equal(runtimeFailureReasonQueue.statusCode, 200);
    assert.equal(runtimeFailureReasonQueuePayload.summary.totalCalls, 1);
    assert.equal(runtimeFailureReasonQueuePayload.summary.oldestAttentionCallId, runtimeFailureCallId);

    const runtimeFailureReasonConsole = await requestJson(port, "GET", "/api/operator/console?fallbackReason=" + runtimeFailureReason);
    const runtimeFailureReasonConsolePayload = runtimeFailureReasonConsole.payload as OperatorConsolePayload;
    assert.equal(runtimeFailureReasonConsole.statusCode, 200);
    assert.deepEqual(runtimeFailureReasonConsolePayload.calls.items.map((call) => call.session.callId), [runtimeFailureCallId]);

    const runtimeFailureConsole = await requestJson(port, "GET", "/api/operator/console?fallbackMode=runtime_failure");
    const runtimeFailureConsolePayload = runtimeFailureConsole.payload as OperatorConsolePayload;
    const runtimeFailureConsoleCall = runtimeFailureConsolePayload.calls.items[0];
    assert.equal(runtimeFailureConsole.statusCode, 200);
    assert.equal(runtimeFailureConsolePayload.calls.summary.filteredSummary.fallbackArmed, 1);
    assert.equal(runtimeFailureConsoleCall?.evidenceSummary.fallbackMode, "runtime_failure");
    assert.equal(runtimeFailureConsoleCall?.evidenceSummary.fallbackReason, "pipecat local runtime import failed");
    assert.equal(runtimeFailureConsoleCall?.evidenceSummary.fallbackReasonQueue, "/api/queue?fallbackReason=" + runtimeFailureReason);
    assert.equal(runtimeFailureConsoleCall?.evidenceSummary.fallbackReasonCallList, "/api/calls?fallbackReason=" + runtimeFailureReason + "&limit=5");
    assert.equal(
      runtimeFailureConsoleCall?.evidenceSummary.fallbackReasonOperatorConsole,
      "/api/operator/console?fallbackReason=" + runtimeFailureReason + "&limit=1",
    );
    assert.equal(
      runtimeFailureConsoleCall?.evidenceSummary.fallbackReasonEventTrail,
      `/api/calls/${runtimeFailureCallId}/events?detailText=${runtimeFailureReason}`,
    );
    assert.equal(runtimeFailureConsoleCall?.evidenceSummary.fallbackSource, "pipecat_runtime_failure_fail_closed");
    assert.equal(
      runtimeFailureConsoleCall?.evidenceSummary.fallbackSourceTrail,
      `/api/calls/${runtimeFailureCallId}/events?source=pipecat_runtime_failure_fail_closed`,
    );
    assert.equal(
      runtimeFailureConsoleCall?.evidenceSummary.fallbackSourceQueue,
      "/api/queue?attentionRequired=true&fallbackSource=pipecat_runtime_failure_fail_closed",
    );
    assert.equal(
      runtimeFailureConsoleCall?.evidenceSummary.fallbackSourceCallList,
      "/api/calls?fallbackSource=pipecat_runtime_failure_fail_closed&limit=5",
    );
    assert.equal(
      runtimeFailureConsoleCall?.evidenceSummary.fallbackSourceOperatorConsole,
      "/api/operator/console?fallbackSource=pipecat_runtime_failure_fail_closed&limit=1",
    );
    assert.equal(runtimeFailureConsoleCall?.evidenceSummary.handoffTrail, `/api/calls/${runtimeFailureCallId}/events?type=human_handoff_started&limit=1&order=desc`);
    assert.equal(runtimeFailureConsoleCall?.evidenceSummary.handoffStartedAt, "2026-06-10T14:00:03.000Z");

    const runtimeFailureManifest = await requestJson(port, "GET", `/api/calls/${runtimeFailureCallId}/artifacts`);
    const runtimeFailureManifestPayload = runtimeFailureManifest.payload as ArtifactManifestPayload;
    assert.equal(runtimeFailureManifest.statusCode, 200);
    assert.equal(runtimeFailureManifestPayload.runtimeMode.flow, "pipecat_local_runtime");
    assert.equal(runtimeFailureManifestPayload.summary.fallbackMode, "runtime_failure");
    assert.equal(runtimeFailureManifestPayload.summary.fallbackReason, "pipecat local runtime import failed");
    assert.equal(runtimeFailureManifestPayload.summary.fallbackSource, "pipecat_runtime_failure_fail_closed");
    assert.equal(runtimeFailureManifestPayload.summary.handoffTrail, `/api/calls/${runtimeFailureCallId}/events?type=human_handoff_started&limit=1&order=desc`);
    assert.equal(runtimeFailureManifestPayload.summary.handoffStartedAt, "2026-06-10T14:00:03.000Z");
    assert.equal(
      runtimeFailureManifestPayload.evidenceRoutes.fallbackSourceTrail,
      `/api/calls/${runtimeFailureCallId}/events?source=pipecat_runtime_failure_fail_closed`,
    );
    assert.equal(runtimeFailureManifestPayload.evidenceRoutes.fallbackSourceQueue, "/api/queue?attentionRequired=true&fallbackSource=pipecat_runtime_failure_fail_closed");
    assert.equal(runtimeFailureManifestPayload.evidenceRoutes.fallbackSourceCallList, "/api/calls?fallbackSource=pipecat_runtime_failure_fail_closed&limit=5");
    assert.equal(runtimeFailureManifestPayload.evidenceRoutes.fallbackSourceOperatorConsole, "/api/operator/console?fallbackSource=pipecat_runtime_failure_fail_closed&limit=1");
    assert.equal(runtimeFailureManifestPayload.evidenceRoutes.fallbackModeQueue, "/api/queue?attentionRequired=true&fallbackMode=runtime_failure");
    assert.equal(runtimeFailureManifestPayload.evidenceRoutes.fallbackModeCallList, "/api/calls?fallbackMode=runtime_failure&limit=5");
    assert.equal(runtimeFailureManifestPayload.evidenceRoutes.fallbackModeOperatorConsole, "/api/operator/console?fallbackMode=runtime_failure&limit=1");
    assert.equal(runtimeFailureManifestPayload.evidenceRoutes.fallbackReasonQueue, "/api/queue?fallbackReason=" + runtimeFailureReason);
    assert.equal(runtimeFailureManifestPayload.evidenceRoutes.fallbackReasonCallList, "/api/calls?fallbackReason=" + runtimeFailureReason + "&limit=5");
    assert.equal(
      runtimeFailureManifestPayload.evidenceRoutes.fallbackReasonOperatorConsole,
      "/api/operator/console?fallbackReason=" + runtimeFailureReason + "&limit=1",
    );
    assert.equal(
      runtimeFailureManifestPayload.evidenceRoutes.fallbackReasonEventTrail,
      `/api/calls/${runtimeFailureCallId}/events?detailText=${runtimeFailureReason}`,
    );
    assert.equal(
      runtimeFailureManifestPayload.evidenceRoutes.fallbackModeTranscriptTrail,
      `/api/calls/${runtimeFailureCallId}/transcript?speaker=agent&text=runtime%20reported%20a%20failure`,
    );
    assert.equal(runtimeFailureManifestPayload.evidenceRoutes.handoffTrail, `/api/calls/${runtimeFailureCallId}/events?type=human_handoff_started&limit=1&order=desc`);

    const toolTimeoutQueue = await requestJson(port, "GET", "/api/queue?fallbackMode=tool_timeout");
    const toolTimeoutQueuePayload = toolTimeoutQueue.payload as QueueSummaryPayload;
    assert.equal(toolTimeoutQueue.statusCode, 200);
    assert.equal(toolTimeoutQueuePayload.summary.totalCalls, 1);
    assert.equal(toolTimeoutQueuePayload.summary.oldestAttentionCallId, callId);

    const invalidFallbackMode = await requestJson(port, "GET", "/api/calls?fallbackMode=manual_takeover");
    assert.equal(invalidFallbackMode.statusCode, 400);
    assert.deepEqual(invalidFallbackMode.payload, {
      ok: false,
      error: "call_list_fallback_mode_invalid",
    });

    const invalidFallbackReason = await requestJson(port, "GET", "/api/queue?fallbackReason=%20%20");
    assert.equal(invalidFallbackReason.statusCode, 400);
    assert.deepEqual(invalidFallbackReason.payload, {
      ok: false,
      error: "queue_fallback_reason_invalid",
    });
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

    const takeover = await requestJson(port, "POST", "/api/calls/" + callId + "/operator-steer", {
      command: "/steer barge-in",
      timestamp: "2026-06-10T14:00:17.000Z",
    });
    const takeoverPayload = takeover.payload as SnapshotPayload;
    assert.equal(takeover.statusCode, 200);
    assert.equal(takeoverPayload.flowState, "wrap");
    assert.equal(takeoverPayload.operatorSteer.lastAction, "takeover");
    assert.equal(takeoverPayload.demoFallback.armed, true);
    assert.equal(takeoverPayload.demoFallback.reason, "operator_barged_in");
    assert.equal(takeoverPayload.events.some((event) => event.type === "operator_takeover_started"), true);

    const endCall = await requestJson(port, "POST", "/api/calls/" + callId + "/operator-steer", {
      command: "/operator end-call",
      timestamp: "2026-06-10T14:00:18.000Z",
    });
    const endCallPayload = endCall.payload as SnapshotPayload;
    assert.equal(endCall.statusCode, 200);
    assert.equal(endCallPayload.flowState, "wrap");
    assert.equal(endCallPayload.operatorSteer.lastAction, "end_call");
    assert.equal(endCallPayload.events.some((event) => event.type === "operator_call_ended"), true);
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
    assert.equal(allEventsPayload.summary.filteredDetailText, null);
    assert.equal(allEventsPayload.summary.filteredSince, null);
    assert.equal(allEventsPayload.summary.filteredUntil, null);
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
    assert.equal(sinceFilteredPayload.summary.filteredDetailText, null);
    assert.equal(sinceFilteredPayload.summary.filteredSince, "2026-06-10T14:00:00.000Z");
    assert.equal(sinceFilteredPayload.summary.filteredUntil, null);
    assert.deepEqual(sinceFilteredPayload.events.map((event) => event.type), ["caller_turn_appended"]);

    const boundedEvents = await requestJson(
      port,
      "GET",
      "/api/calls/" + callId + "/events?type=caller_turn_appended&since=2026-06-10T14:00:00.000Z&until=2026-06-10T14:00:01.000Z",
    );
    const boundedPayload = boundedEvents.payload as EventTrailPayload;

    assert.equal(boundedEvents.statusCode, 200);
    assert.equal(boundedPayload.summary.filteredSince, "2026-06-10T14:00:00.000Z");
    assert.equal(boundedPayload.summary.filteredUntil, "2026-06-10T14:00:01.000Z");
    assert.deepEqual(boundedPayload.events.map((event) => event.type), ["caller_turn_appended"]);

    const futureEvents = await requestJson(port, "GET", `/api/calls/${callId}/events?since=2999-01-01T00:00:00.000Z`);
    const futurePayload = futureEvents.payload as EventTrailPayload;

    assert.equal(futureEvents.statusCode, 200);
    assert.equal(futurePayload.summary.returnedEvents, 0);
    assert.equal(futurePayload.summary.filteredSince, "2999-01-01T00:00:00.000Z");
    assert.equal(futurePayload.summary.filteredUntil, null);
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
    assert.equal(filteredPayload.summary.filteredDetailText, null);
    assert.equal(filteredPayload.summary.filteredSince, null);
    assert.equal(filteredPayload.summary.filteredUntil, null);
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

    const detailFilteredEvents = await requestJson(port, "GET", `/api/calls/${callId}/events?detailText=operator%20audit`);
    const detailFilteredPayload = detailFilteredEvents.payload as EventTrailPayload;

    assert.equal(detailFilteredEvents.statusCode, 200);
    assert.equal(detailFilteredPayload.summary.filteredDetailText, "operator audit");
    assert.deepEqual(detailFilteredPayload.events.map((event) => event.type), ["demo_fallback_triggered", "human_handoff_started"]);

    const detailKeyFilteredEvents = await requestJson(port, "GET", `/api/calls/${callId}/events?detailKey=source`);
    const detailKeyFilteredPayload = detailKeyFilteredEvents.payload as EventTrailPayload;

    assert.equal(detailKeyFilteredEvents.statusCode, 200);
    assert.equal(detailKeyFilteredPayload.summary.filteredDetailKey, "source");
    assert.deepEqual(detailKeyFilteredPayload.events.map((event) => event.type), ["demo_fallback_triggered", "human_handoff_started"]);

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

    const invalidDetailText = await requestJson(port, "GET", `/api/calls/${callId}/events?detailText=%20%20`);
    assert.equal(invalidDetailText.statusCode, 400);
    assert.deepEqual(invalidDetailText.payload, {
      ok: false,
      error: "event_detail_text_invalid",
    });

    const invalidDetailKey = await requestJson(port, "GET", `/api/calls/${callId}/events?detailKey=%20%20`);
    assert.equal(invalidDetailKey.statusCode, 400);
    assert.deepEqual(invalidDetailKey.payload, {
      ok: false,
      error: "event_detail_key_invalid",
    });

    const invalidSince = await requestJson(port, "GET", `/api/calls/${callId}/events?since=not-a-date`);
    assert.equal(invalidSince.statusCode, 400);
    assert.deepEqual(invalidSince.payload, {
      ok: false,
      error: "event_since_invalid",
    });

    const invalidUntil = await requestJson(port, "GET", "/api/calls/" + callId + "/events?until=not-a-date");
    assert.equal(invalidUntil.statusCode, 400);
    assert.deepEqual(invalidUntil.payload, {
      ok: false,
      error: "event_until_invalid",
    });

    const invalidWindow = await requestJson(
      port,
      "GET",
      "/api/calls/" + callId + "/events?since=2026-06-10T14:00:02.000Z&until=2026-06-10T14:00:01.000Z",
    );
    assert.equal(invalidWindow.statusCode, 400);
    assert.deepEqual(invalidWindow.payload, {
      ok: false,
      error: "event_window_invalid",
    });

    const invalidOffset = await requestJson(port, "GET", "/api/calls/" + callId + "/events?offset=-1");
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

test("GET /api/calls/:callId/latency returns filterable latency evidence", async () => {
  await withServer(async (port) => {
    const started = await requestJson(port, "POST", "/api/demo/start", {
      openclawSessionId: "latency-session-01",
      openclawSessionLabel: "latency/filterable",
    });
    const callId = (started.payload as SnapshotPayload).session.callId;

    await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "I want to cancel my policy today.",
      timestamp: "2026-06-10T14:00:00.000Z",
    });

    const allLatency = await requestJson(port, "GET", `/api/calls/${callId}/latency`);
    const allLatencyPayload = allLatency.payload as LatencyPayload;

    assert.equal(allLatency.statusCode, 200);
    assert.equal(allLatencyPayload.callId, callId);
    assert.equal(allLatencyPayload.openclawSession.sessionId, "latency-session-01");
    assert.equal(allLatencyPayload.latencyBudgetsMs.asrPartial, 500);
    assert.equal(allLatencyPayload.summary.totalMarks, allLatencyPayload.marks.length);
    assert.equal(allLatencyPayload.summary.returnedMarks, allLatencyPayload.marks.length);
    assert.equal(allLatencyPayload.summary.filteredStage, null);
    assert.equal(allLatencyPayload.summary.filteredOverBudget, null);
    assert.equal(allLatencyPayload.summary.filteredSince, null);
    assert.equal(allLatencyPayload.summary.filteredUntil, null);
    assert.equal(allLatencyPayload.summary.order, "asc");
    assert.deepEqual(allLatencyPayload.summary.page, {
      offset: 0,
      limit: null,
      totalFilteredMarks: allLatencyPayload.summary.totalMarks,
      hasMore: false,
      nextOffset: null,
    });
    assert.equal(allLatencyPayload.marks.some((mark) => mark.stage === "caller_turn_received"), true);

    const stageFiltered = await requestJson(port, "GET", `/api/calls/${callId}/latency?stage=caller_turn_received`);
    const stageFilteredPayload = stageFiltered.payload as LatencyPayload;

    assert.equal(stageFiltered.statusCode, 200);
    assert.equal(stageFilteredPayload.summary.filteredStage, "caller_turn_received");
    assert.equal(stageFilteredPayload.summary.filteredOverBudget, null);
    assert.equal(stageFilteredPayload.summary.latestMarkStage, "caller_turn_received");
    assert.equal(stageFilteredPayload.summary.lastReturnedMarkStage, "caller_turn_received");
    assert.deepEqual(stageFilteredPayload.marks.map((mark) => mark.stage), ["caller_turn_received"]);

    const descendingPage = await requestJson(port, "GET", `/api/calls/${callId}/latency?order=desc&limit=2`);
    const descendingPayload = descendingPage.payload as LatencyPayload;

    assert.equal(descendingPage.statusCode, 200);
    assert.equal(descendingPayload.summary.order, "desc");
    assert.deepEqual(
      descendingPayload.marks.map((mark) => mark.stage),
      [...allLatencyPayload.marks].reverse().slice(0, 2).map((mark) => mark.stage),
    );
    assert.deepEqual(descendingPayload.summary.page, {
      offset: 0,
      limit: 2,
      totalFilteredMarks: allLatencyPayload.summary.totalMarks,
      hasMore: allLatencyPayload.summary.totalMarks > 2,
      nextOffset: allLatencyPayload.summary.totalMarks > 2 ? 2 : null,
    });

    const boundedWindow = await requestJson(
      port,
      "GET",
      `/api/calls/${callId}/latency?since=2026-06-10T14%3A00%3A00.000Z&until=2026-06-10T14%3A00%3A00.000Z`,
    );
    const boundedWindowPayload = boundedWindow.payload as LatencyPayload;

    assert.equal(boundedWindow.statusCode, 200);
    assert.equal(boundedWindowPayload.summary.filteredSince, "2026-06-10T14:00:00.000Z");
    assert.equal(boundedWindowPayload.summary.filteredUntil, "2026-06-10T14:00:00.000Z");
    assert.equal(boundedWindowPayload.summary.page.totalFilteredMarks, boundedWindowPayload.marks.length);
    assert.equal(boundedWindowPayload.marks.some((mark) => mark.stage === "call_bootstrapped"), false);
    assert.equal(boundedWindowPayload.marks.every((mark) => mark.recordedAt === "2026-06-10T14:00:00.000Z"), true);

    const overBudget = await requestJson(port, "GET", `/api/calls/${callId}/latency?overBudget=true`);
    const overBudgetPayload = overBudget.payload as LatencyPayload;

    assert.equal(overBudget.statusCode, 200);
    assert.equal(overBudgetPayload.summary.filteredOverBudget, true);
    assert.equal(overBudgetPayload.summary.overBudgetMarks, overBudgetPayload.marks.length);
    assert.deepEqual(overBudgetPayload.marks, []);

    const invalidStage = await requestJson(port, "GET", `/api/calls/${callId}/latency?stage=%20%20`);
    assert.equal(invalidStage.statusCode, 400);
    assert.deepEqual(invalidStage.payload, {
      ok: false,
      error: "latency_stage_invalid",
    });

    const invalidOverBudget = await requestJson(port, "GET", `/api/calls/${callId}/latency?overBudget=yes`);
    assert.equal(invalidOverBudget.statusCode, 400);
    assert.deepEqual(invalidOverBudget.payload, {
      ok: false,
      error: "latency_over_budget_invalid",
    });

    const invalidSince = await requestJson(port, "GET", `/api/calls/${callId}/latency?since=not-a-date`);
    assert.equal(invalidSince.statusCode, 400);
    assert.deepEqual(invalidSince.payload, {
      ok: false,
      error: "latency_since_invalid",
    });

    const invalidUntil = await requestJson(port, "GET", `/api/calls/${callId}/latency?until=not-a-date`);
    assert.equal(invalidUntil.statusCode, 400);
    assert.deepEqual(invalidUntil.payload, {
      ok: false,
      error: "latency_until_invalid",
    });

    const invalidWindow = await requestJson(
      port,
      "GET",
      `/api/calls/${callId}/latency?since=2026-06-10T14%3A00%3A01.000Z&until=2026-06-10T14%3A00%3A00.000Z`,
    );
    assert.equal(invalidWindow.statusCode, 400);
    assert.deepEqual(invalidWindow.payload, {
      ok: false,
      error: "latency_window_invalid",
    });

    const invalidLimit = await requestJson(port, "GET", `/api/calls/${callId}/latency?limit=101`);
    assert.equal(invalidLimit.statusCode, 400);
    assert.deepEqual(invalidLimit.payload, {
      ok: false,
      error: "latency_limit_invalid",
    });

    const invalidOrder = await requestJson(port, "GET", `/api/calls/${callId}/latency?order=latest`);
    assert.equal(invalidOrder.statusCode, 400);
    assert.deepEqual(invalidOrder.payload, {
      ok: false,
      error: "latency_order_invalid",
    });

    const missing = await requestJson(port, "GET", "/api/calls/missing-call/latency");
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

test("GET /api/operator/actions exposes Slack-ready control metadata", async () => {
  await withServer(async (port) => {
    const response = await requestJson(port, "GET", "/api/operator/actions");
    const payload = response.payload as {
      schemaVersion: number;
      commandWrappers: string[];
      callReferenceFields: string[];
      routes: { startDemoCall: string; callerTurn: string; steerCall: string; noteCall: string; consoleAction: string };
      actions: Array<{
        action: string;
        requiresPendingCall: boolean;
        requiresReason: boolean;
        reasonPrompt: string | null;
        confirmationRequired: boolean;
        confirmationMessage: string | null;
        postTemplate: string;
        commandExamples: string[];
      }>;
    };

    assert.equal(response.statusCode, 200);
    assert.equal(payload.schemaVersion, 1);
    assert.deepEqual(payload.commandWrappers, ["/operator", "/steer"]);
    assert.deepEqual(payload.callReferenceFields, [
      "callId",
      "providerCallId",
      "openclawSessionId",
      "openclawSessionLabel",
      "openclawSessionRef",
    ]);
    assert.deepEqual(payload.routes, {
      startDemoCall: "/api/demo/start",
      callerTurn: "/api/calls/{callId}/caller-turn",
      steerCall: "/api/calls/{callId}/operator-steer",
      noteCall: "/api/calls/{callId}/operator-note",
      consoleAction: "/api/operator/console/action",
    });
    assert.deepEqual(
      payload.actions.map((action) => action.action),
      [
        "pause",
        "resume",
        "approve_offer",
        "deny_offer",
        "escalate_to_human",
        "transfer",
        "takeover",
        "end_call",
        "goto_slide",
        "ask_operator",
        "arm_fallback",
        "disarm_fallback",
      ],
    );

    const armFallback = payload.actions.find((action) => action.action === "arm_fallback");
    assert.equal(armFallback?.requiresReason, true);
    assert.equal(armFallback?.requiresPendingCall, false);
    assert.equal(armFallback?.reasonPrompt, "Fallback reason");
    assert.equal(armFallback?.confirmationRequired, true);
    assert.equal(armFallback?.confirmationMessage, "Arming fallback changes the live call path until fallback is disarmed.");
    assert.equal(armFallback?.commandExamples.includes("/operator arm-fallback audio degraded"), true);

    const approveOffer = payload.actions.find((action) => action.action === "approve_offer");
    assert.equal(approveOffer?.requiresPendingCall, true);
    assert.equal(approveOffer?.requiresReason, false);
    assert.equal(approveOffer?.postTemplate, "/api/calls/{callId}/operator-steer");

    const denyOffer = payload.actions.find((action) => action.action === "deny_offer");
    assert.equal(denyOffer?.requiresPendingCall, true);
    assert.equal(denyOffer?.requiresReason, false);
    assert.equal(denyOffer?.commandExamples.includes("/operator deny-offer"), true);

    const transfer = payload.actions.find((action) => action.action === "transfer");
    assert.equal(transfer?.requiresPendingCall, false);
    assert.equal(transfer?.requiresReason, false);
    assert.equal(transfer?.confirmationRequired, true);
    assert.equal(transfer?.confirmationMessage, "Transferring moves the caller out of the automated demo flow to a human queue.");
    assert.equal(transfer?.commandExamples.includes("/operator transfer"), true);

    const takeover = payload.actions.find((action) => action.action === "takeover");
    assert.equal(takeover?.requiresPendingCall, false);
    assert.equal(takeover?.requiresReason, false);
    assert.equal(takeover?.reasonPrompt, null);
    assert.equal(takeover?.confirmationRequired, true);
    assert.equal(takeover?.confirmationMessage, "Takeover gives the operator direct control of the live call.");
    assert.equal(takeover?.commandExamples.includes("/steer barge-in"), true);

    const endCall = payload.actions.find((action) => action.action === "end_call");
    assert.equal(endCall?.requiresPendingCall, false);
    assert.equal(endCall?.requiresReason, false);
    assert.equal(endCall?.commandExamples.includes("/operator end-call"), true);
  });
});
