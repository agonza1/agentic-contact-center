import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const { loadPocConfig } = require("../dist/src/config/loadPocConfig.js");
const { buildHttpServer } = require("../dist/src/http/createServer.js");

const SCRIPTED_CALLER_TURNS = [
  {
    text: "I want to cancel my policy today.",
    timestamp: "2026-06-11T20:45:00.000Z",
  },
  {
    text: "The renewal increase is too high.",
    timestamp: "2026-06-11T20:45:05.000Z",
  },
  {
    text: "Okay, what safe options can you review for me?",
    timestamp: "2026-06-11T20:45:10.000Z",
  },
  {
    text: "Thanks, please note that follow-up and close the call.",
    timestamp: "2026-06-11T20:45:15.000Z",
  },
];

function resolveArgPath(flag) {
  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) {
    return path.resolve(process.cwd(), process.argv[flagIndex + 1]);
  }

  return undefined;
}

function resolveOutputPaths() {
  const explicitOutputPath = resolveArgPath("--out");
  if (explicitOutputPath) {
    return {
      outputPath: explicitOutputPath,
      latestOutputPath: resolveArgPath("--latest-out"),
    };
  }

  const timestamp = new Date().toISOString().replace(/[:]/g, "-");
  return {
    outputPath: path.resolve(process.cwd(), "artifacts", `demo-proof-${timestamp}.json`),
    latestOutputPath: resolveArgPath("--latest-out"),
  };
}

async function withServer(run) {
  const config = loadPocConfig();
  const server = buildHttpServer(config);

  await new Promise((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the proof harness server to bind an ephemeral TCP port.");
  }

  try {
    return await run(address.port, config);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function requestJson(port, method, route, body) {
  const rawBody = body ? JSON.stringify(body) : undefined;

  const responseBody = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: route,
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
          resolve({
            statusCode: response.statusCode ?? 0,
            payload: collected ? JSON.parse(collected) : null,
          });
        });
      },
    );

    req.on("error", reject);
    if (rawBody) {
      req.write(rawBody);
    }
    req.end();
  });

  return responseBody;
}

async function runScriptedScenario(port) {
  const started = await requestJson(port, "POST", "/api/demo/start", {
    openclawSessionLabel: "cluecon-demo/scripted-proof",
  });
  assert.equal(started.statusCode, 201);

  const callId = started.payload.session.callId;
  const snapshots = {
    started: started.payload,
  };

  for (const turn of SCRIPTED_CALLER_TURNS.slice(0, 3)) {
    const response = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, turn);
    assert.equal(response.statusCode, 200);
    snapshots[turn.timestamp] = response.payload;
  }

  const policyHoldSnapshot = snapshots[SCRIPTED_CALLER_TURNS[1].timestamp];
  assert.equal(policyHoldSnapshot.flowState, "policy_hold");
  assert.equal(policyHoldSnapshot.events.some((event) => event.type === "policy_hold_entered"), true);

  const pendingSnapshot = snapshots[SCRIPTED_CALLER_TURNS[2].timestamp];
  assert.equal(pendingSnapshot.flowState, "operator_steer");
  assert.equal(pendingSnapshot.operatorSteer.pending, true);

  const approved = await requestJson(port, "POST", `/api/calls/${callId}/operator-steer`, {
    action: "approve_offer",
    timestamp: "2026-06-11T20:45:11.000Z",
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.payload.flowState, "steered_response");

  const wrapped = await requestJson(port, "POST", `/api/calls/${callId}/caller-turn`, SCRIPTED_CALLER_TURNS[3]);
  assert.equal(wrapped.statusCode, 200);
  assert.equal(wrapped.payload.flowState, "wrap");
  assert.equal(wrapped.payload.pipecatFlow.script.completed, true);

  const noted = await requestJson(port, "POST", `/api/calls/${callId}/operator-note`, {
    text: "QA confirmed safe retention wrap and no billing credit promise.",
    disposition: "qa_verified",
    timestamp: "2026-06-11T20:45:16.000Z",
  });
  assert.equal(noted.statusCode, 200);
  assert.equal(noted.payload.events.some((event) => event.type === "operator_note_recorded"), true);

  const finalAgentTurn = [...wrapped.payload.transcript].reverse().find((turn) => turn.speaker === "agent");
  assert.ok(finalAgentTurn);
  assert.equal(finalAgentTurn.text.toLowerCase().includes("billing credit"), false);

  return {
    callId,
    outcome: "scripted_wrap_complete",
    checkpoints: {
      policyHold: policyHoldSnapshot,
      operatorSteerPending: pendingSnapshot,
      approvedSteer: approved.payload,
      wrapped: noted.payload,
    },
  };
}

async function runFallbackScenario(port, options = {}) {
  const {
    mode = "tool_timeout",
    reason = "pipecat tool exceeded latency budget",
    label = "cluecon-demo/fallback-proof",
    timestamp = "2026-06-11T20:46:02.000Z",
  } = options;
  const started = await requestJson(port, "POST", "/api/demo/start", {
    openclawSessionLabel: label,
  });
  assert.equal(started.statusCode, 201);

  const callId = started.payload.session.callId;
  const fallback = await requestJson(port, "POST", `/api/calls/${callId}/fallback`, {
    mode,
    reason,
    timestamp,
  });

  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.payload.flowState, "wrap");
  assert.equal(fallback.payload.demoFallback.armed, true);
  assert.equal(fallback.payload.demoFallback.mode, mode);
  assert.equal(fallback.payload.events.some((event) => event.type === "demo_fallback_triggered"), true);
  assert.equal(fallback.payload.events.some((event) => event.type === "human_handoff_started"), true);

  const finalAgentTurn = [...fallback.payload.transcript].reverse().find((turn) => turn.speaker === "agent");
  assert.ok(finalAgentTurn);
  const expectedMessageFragment = mode === "runtime_failure" ? "runtime reported a failure" : "tool timed out";
  assert.equal(finalAgentTurn.text.toLowerCase().includes(expectedMessageFragment), true);

  return {
    callId,
    outcome: mode === "runtime_failure" ? "runtime_failure_fail_closed_handoff" : "fail_closed_handoff",
    checkpoint: fallback.payload,
  };
}

async function getQueueAttentionSummary(port) {
  const queue = await requestJson(
    port,
    "GET",
    "/api/queue?attentionRequired=true&attentionReason=pipecat%20tool%20exceeded%20latency%20budget",
  );
  assert.equal(queue.statusCode, 200);

  return queue.payload.summary;
}

async function getAttentionSortedCallList(port) {
  const list = await requestJson(
    port,
    "GET",
    "/api/calls?attentionRequired=true&sort=attentionStartedAt&limit=1",
  );
  assert.equal(list.statusCode, 200);
  assert.equal(list.payload.calls.length, 1);
  assert.equal(list.payload.calls[0].attention.required, true);

  return {
    route: "attentionRequired=true&sort=attentionStartedAt&limit=1",
    firstCallId: list.payload.calls[0].session.callId,
    firstAttentionStartedAt: list.payload.calls[0].attention.startedAt,
    filteredSummary: list.payload.summary.filteredSummary,
  };
}

async function getFallbackSourceTrail(port, callId, source = "tool_timeout_fail_closed") {
  const trail = await requestJson(port, "GET", `/api/calls/${callId}/events?source=${source}`);
  assert.equal(trail.statusCode, 200);
  assert.equal(trail.payload.summary.filteredSource, source);
  assert.deepEqual(
    trail.payload.events.map((event) => event.type),
    ["human_handoff_started"],
  );

  return {
    route: `calls/${callId}/events?source=${source}`,
    returnedEvents: trail.payload.summary.returnedEvents,
    filteredSource: trail.payload.summary.filteredSource,
    eventTypes: trail.payload.events.map((event) => event.type),
  };
}

async function getOperatorNoteTrail(port, callId) {
  const trail = await requestJson(port, "GET", `/api/calls/${callId}/events?type=operator_note_recorded`);
  assert.equal(trail.statusCode, 200);
  assert.equal(trail.payload.summary.filteredType, "operator_note_recorded");
  assert.deepEqual(
    trail.payload.events.map((event) => event.type),
    ["operator_note_recorded"],
  );

  return {
    route: `calls/${callId}/events?type=operator_note_recorded`,
    returnedEvents: trail.payload.summary.returnedEvents,
    filteredType: trail.payload.summary.filteredType,
    latestDisposition: trail.payload.events.at(-1).detail.disposition,
    eventTypes: trail.payload.events.map((event) => event.type),
  };
}

async function getGitRevision() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: path.resolve(__dirname, ".."),
      timeout: 2_000,
    });

    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function summarizeArtifact(artifact) {
  const scriptedWrapped = artifact.scripted.checkpoints.wrapped;
  const fallbackCheckpoint = artifact.fallback.checkpoint;
  const summarizeScenario = (checkpoint) => ({
    flowState: checkpoint.flowState,
    transcriptTurns: checkpoint.transcript.length,
    agentTurns: checkpoint.transcript.filter((turn) => turn.speaker === "agent").length,
    callerTurns: checkpoint.transcript.filter((turn) => turn.speaker === "caller").length,
    eventCount: checkpoint.events.length,
    eventTypes: [...new Set(checkpoint.events.map((event) => event.type))],
    latencyMarkCount: checkpoint.latencyMarks.length,
    latencyStages: checkpoint.latencyMarks.map((mark) => mark.stage),
  });

  return {
    schemaVersion: artifact.schemaVersion,
    healthOk: artifact.health.ok,
    gitRevision: artifact.gitRevision,
    pipecatRuntime: {
      ready: artifact.health.pipecatFlow.ready,
      prototypeMode: artifact.health.pipecatFlow.prototypeMode,
      transport: artifact.health.pipecatFlow.transport,
      runtimeEngine: artifact.health.pipecatFlow.runtimeEngine,
      credentialsMode: artifact.health.pipecatFlow.credentialsMode,
      activeTool: artifact.health.pipecatFlow.activeTool,
      toolCoverage: artifact.health.pipecatFlow.toolCoverage,
    },
    runtimeSeams: artifact.health.runtimeSeams,
    proofContract: artifact.proofContract,
    queueAttention: {
      totalCalls: artifact.queueAttention.totalCalls,
      attentionRequired: artifact.queueAttention.attentionRequired,
      oldestAttentionCallId: artifact.queueAttention.oldestAttentionCallId,
      oldestAttentionOpenclawSessionLabel: artifact.queueAttention.oldestAttentionOpenclawSessionLabel,
      oldestAttentionAgeMs: artifact.queueAttention.oldestAttentionAgeMs,
      oldestAttentionStartedAt: artifact.queueAttention.oldestAttentionStartedAt,
      oldestAttentionFlowState: artifact.queueAttention.oldestAttentionFlowState,
      oldestAttentionReason: artifact.queueAttention.oldestAttentionReason,
      oldestAttentionSource: artifact.queueAttention.oldestAttentionSource,
    },
    callAttentionList: artifact.callAttentionList,
    operatorNoteTrail: artifact.operatorNoteTrail,
    fallbackSourceTrail: artifact.fallbackSourceTrail,
    runtimeFailureSourceTrail: artifact.runtimeFailureSourceTrail,
    scripted: {
      outcome: artifact.scripted.outcome,
      callId: artifact.scripted.callId,
      ...summarizeScenario(scriptedWrapped),
    },
    fallback: {
      outcome: artifact.fallback.outcome,
      callId: artifact.fallback.callId,
      mode: fallbackCheckpoint.demoFallback.mode,
      reason: fallbackCheckpoint.demoFallback.reason,
      ...summarizeScenario(fallbackCheckpoint),
    },
    runtimeFailure: {
      outcome: artifact.runtimeFailure.outcome,
      callId: artifact.runtimeFailure.callId,
      mode: artifact.runtimeFailure.checkpoint.demoFallback.mode,
      reason: artifact.runtimeFailure.checkpoint.demoFallback.reason,
      ...summarizeScenario(artifact.runtimeFailure.checkpoint),
    },
  };
}

async function main() {
  const { outputPath, latestOutputPath } = resolveOutputPaths();

  const artifact = await withServer(async (port, config) => {
    const health = await requestJson(port, "GET", "/health");
    assert.equal(health.statusCode, 200);

    const scripted = await runScriptedScenario(port);
    const operatorNoteTrail = await getOperatorNoteTrail(port, scripted.callId);
    const fallback = await runFallbackScenario(port);
    const queueAttention = await getQueueAttentionSummary(port);
    const callAttentionList = await getAttentionSortedCallList(port);
    const fallbackSourceTrail = await getFallbackSourceTrail(port, fallback.callId);
    const runtimeFailure = await runFallbackScenario(port, {
      mode: "runtime_failure",
      reason: "pipecat local runtime import failed",
      label: "cluecon-demo/runtime-failure-proof",
      timestamp: "2026-06-11T20:47:02.000Z",
    });
    const runtimeFailureSourceTrail = await getFallbackSourceTrail(
      port,
      runtimeFailure.callId,
      "pipecat_runtime_failure_fail_closed",
    );

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      gitRevision: await getGitRevision(),
      demoName: config.demoName,
      provider: config.provider.name,
      proofContract: {
        requiredOutcomes: [
          "scripted_wrap_complete",
          "fail_closed_handoff",
          "runtime_failure_fail_closed_handoff",
        ],
        requiredEventTypes: ["policy_hold_entered", "demo_fallback_triggered", "human_handoff_started"],
        queueAttentionFilter: "attentionRequired=true&attentionReason=pipecat%20tool%20exceeded%20latency%20budget",
        callAttentionSort: "attentionRequired=true&sort=attentionStartedAt&limit=1",
        operatorNoteTrail: "events?type=operator_note_recorded",
        fallbackSourceTrail: "events?source=tool_timeout_fail_closed",
        runtimeFailureSourceTrail: "events?source=pipecat_runtime_failure_fail_closed",
      },
      health: health.payload,
      operatorNoteTrail,
      queueAttention,
      callAttentionList,
      fallbackSourceTrail,
      runtimeFailureSourceTrail,
      scripted,
      fallback,
      runtimeFailure,
    };
  });

  artifact.summary = summarizeArtifact(artifact);

  const serializedArtifact = `${JSON.stringify(artifact, null, 2)}\n`;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializedArtifact, "utf8");

  if (latestOutputPath && latestOutputPath !== outputPath) {
    await mkdir(path.dirname(latestOutputPath), { recursive: true });
    await writeFile(latestOutputPath, serializedArtifact, "utf8");
  }

  console.log(`Saved proof artifact to ${path.relative(process.cwd(), outputPath)}`);
  if (latestOutputPath && latestOutputPath !== outputPath) {
    console.log(`Updated latest proof artifact at ${path.relative(process.cwd(), latestOutputPath)}`);
  }
  console.log(
    JSON.stringify(
      {
        scriptedOutcome: artifact.scripted.outcome,
        fallbackOutcome: artifact.fallback.outcome,
        runtimeFailureOutcome: artifact.runtimeFailure.outcome,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
