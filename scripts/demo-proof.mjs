import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

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

function resolveOutputPath() {
  const outIndex = process.argv.indexOf("--out");
  if (outIndex >= 0 && process.argv[outIndex + 1]) {
    return path.resolve(process.cwd(), process.argv[outIndex + 1]);
  }

  const timestamp = new Date().toISOString().replace(/[:]/g, "-");
  return path.resolve(process.cwd(), "artifacts", `demo-proof-${timestamp}.json`);
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
      wrapped: wrapped.payload,
    },
  };
}

async function runFallbackScenario(port) {
  const started = await requestJson(port, "POST", "/api/demo/start", {
    openclawSessionLabel: "cluecon-demo/fallback-proof",
  });
  assert.equal(started.statusCode, 201);

  const callId = started.payload.session.callId;
  const fallback = await requestJson(port, "POST", `/api/calls/${callId}/fallback`, {
    mode: "tool_timeout",
    reason: "pipecat tool exceeded latency budget",
    timestamp: "2026-06-11T20:46:02.000Z",
  });

  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.payload.flowState, "wrap");
  assert.equal(fallback.payload.demoFallback.armed, true);
  assert.equal(fallback.payload.demoFallback.mode, "tool_timeout");
  assert.equal(fallback.payload.events.some((event) => event.type === "demo_fallback_triggered"), true);
  assert.equal(fallback.payload.events.some((event) => event.type === "human_handoff_started"), true);

  const finalAgentTurn = [...fallback.payload.transcript].reverse().find((turn) => turn.speaker === "agent");
  assert.ok(finalAgentTurn);
  assert.equal(finalAgentTurn.text.toLowerCase().includes("tool timed out"), true);

  return {
    callId,
    outcome: "fail_closed_handoff",
    checkpoint: fallback.payload,
  };
}

async function main() {
  const outputPath = resolveOutputPath();

  const artifact = await withServer(async (port, config) => {
    const health = await requestJson(port, "GET", "/health");
    assert.equal(health.statusCode, 200);

    const scripted = await runScriptedScenario(port);
    const fallback = await runFallbackScenario(port);

    return {
      generatedAt: new Date().toISOString(),
      demoName: config.demoName,
      provider: config.provider.name,
      health: health.payload,
      scripted,
      fallback,
    };
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Saved proof artifact to ${path.relative(process.cwd(), outputPath)}`);
  console.log(
    JSON.stringify(
      {
        scriptedOutcome: artifact.scripted.outcome,
        fallbackOutcome: artifact.fallback.outcome,
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
