import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { loadPocConfig } = require("../dist/src/config/loadPocConfig.js");
const { buildHttpServer } = require("../dist/src/http/createServer.js");

function resolveArgPath(flag) {
  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) {
    return path.resolve(process.cwd(), process.argv[flagIndex + 1]);
  }

  return undefined;
}

function hasArg(flag) {
  return process.argv.includes(flag);
}

function resolveOutputPath() {
  const explicitOutputPath = resolveArgPath("--out");
  if (explicitOutputPath) {
    return explicitOutputPath;
  }

  const timestamp = new Date().toISOString().replace(/[:]/g, "-");
  return path.resolve(process.cwd(), "artifacts", `realtime-shim-proof-${timestamp}.json`);
}

function resolveLatestOutputPath() {
  const explicitLatestOutputPath = resolveArgPath("--latest-out");
  if (explicitLatestOutputPath) {
    return explicitLatestOutputPath;
  }

  if (hasArg("--out")) {
    return undefined;
  }

  return path.resolve(process.cwd(), "artifacts", "realtime-shim-proof-latest.json");
}

async function withServer(run) {
  const server = buildHttpServer(loadPocConfig());

  await new Promise((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the realtime shim proof server to bind an ephemeral TCP port.");
  }

  try {
    return await run(address.port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function requestJson(port, route) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method: "GET",
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ statusCode: response.statusCode ?? 0, payload: body ? JSON.parse(body) : null });
        });
      },
    );

    req.on("error", reject);
    req.end();
  });
}

async function postJson(port, route, body) {
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({ statusCode: response.statusCode ?? 0, payload: responseBody ? JSON.parse(responseBody) : null });
        });
      },
    );

    req.on("error", reject);
    req.end(payload);
  });
}

async function runRealtimeShimRpcHttpSmoke(port) {
  const audioBase64 = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]).toString("base64");
  const sessionId = "local-rt-http-smoke";
  const requests = [
    {
      requestId: "rt-http-1",
      method: "talk.session.create",
      params: { mode: "realtime", transport: "gateway-relay", relaySessionId: sessionId },
    },
    { requestId: "rt-http-2", method: "talk.session.appendAudio", params: { sessionId, audioBase64, timestamp: 42 } },
    {
      requestId: "rt-http-3",
      method: "talk.session.finalizeTurn",
      params: { sessionId, transcriptText: "Need a retention credit." },
    },
    { requestId: "rt-http-4", method: "talk.session.cancelOutput", params: { sessionId, reason: "barge-in" } },
    { requestId: "rt-http-5", method: "talk.session.appendAudio", params: { sessionId, audioBase64, timestamp: 96 } },
    {
      requestId: "rt-http-6",
      method: "talk.session.finalizeTurn",
      params: { sessionId, transcriptText: "Continue with a human handoff instead." },
    },
    { requestId: "rt-http-7", method: "talk.session.getEvidence", params: { sessionId } },
    { requestId: "rt-http-8", method: "talk.session.close", params: { sessionId, reason: "complete" } },
  ];

  const responses = [];
  for (const rpcRequest of requests) {
    const response = await postJson(port, "/api/realtime-shim/rpc", rpcRequest);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.method, rpcRequest.method);
    assert.equal(response.payload.requestId, rpcRequest.requestId);
    assert.equal(response.payload.id, rpcRequest.requestId);
    responses.push(response.payload);
  }

  const cancelResponse = responses.find((response) => response.method === "talk.session.cancelOutput");
  const evidenceResponse = responses.find((response) => response.method === "talk.session.getEvidence");
  const closeResponse = responses.find((response) => response.method === "talk.session.close");

  assert.equal(cancelResponse.result.turnSummary.outputCancelled, true);
  assert.equal(cancelResponse.result.state, "listening");
  assert.equal(evidenceResponse.result.turnSummary.finalTranscript, "Continue with a human handoff instead.");
  assert.equal(evidenceResponse.result.turnSummary.outputAudioChunks, 2);
  assert.equal(evidenceResponse.result.turnSummary.outputCancelled, true);
  assert.equal(closeResponse.result.state, "closed");

  const boundedError = await postJson(port, "/api/realtime-shim/rpc", {
    requestId: "rt-http-error-1",
    method: "talk.session.appendAudio",
    params: { sessionId, audioBase64: Buffer.from([1]).toString("base64") },
  });

  assert.equal(boundedError.statusCode, 400);
  assert.equal(boundedError.payload.ok, false);
  assert.equal(boundedError.payload.error, "realtime_shim_rpc_error");
  assert.equal(boundedError.payload.method, "talk.session.appendAudio");
  assert.equal(boundedError.payload.requestId, "rt-http-error-1");
  assert.equal(boundedError.payload.id, "rt-http-error-1");
  assert.equal(boundedError.payload.rpcCompatibility.boundedErrors, true);
  assert.match(boundedError.payload.message, /even number of bytes/);

  return {
    route: "/api/realtime-shim/rpc",
    sessionId,
    requests: requests.length,
    requestIdsEchoed: responses.every((response, index) => response.requestId === `rt-http-${index + 1}`) &&
      boundedError.payload.requestId === "rt-http-error-1",
    methods: requests.map((request) => request.method),
    finalTranscript: evidenceResponse.result.turnSummary.finalTranscript,
    outputAudioChunks: evidenceResponse.result.turnSummary.outputAudioChunks,
    bargeInRecovery: {
      outputCancelled: cancelResponse.result.turnSummary.outputCancelled,
      recoveredFinalTranscript: evidenceResponse.result.turnSummary.finalTranscript,
      recoveredOutputAudioChunks: evidenceResponse.result.turnSummary.outputAudioChunks,
    },
    closed: closeResponse.result.state === "closed",
    boundedError: {
      statusCode: boundedError.statusCode,
      error: boundedError.payload.error,
      message: boundedError.payload.message,
    },
  };
}

async function main() {
  const outputPath = resolveOutputPath();
  const latestOutputPath = resolveLatestOutputPath();
  const artifact = await withServer(async (port) => {
    const [proofResponse, readinessResponse] = await Promise.all([
      requestJson(port, "/api/realtime-shim/proof"),
      requestJson(port, "/api/realtime-shim/readiness"),
    ]);

    const rpcHttpSmoke = await runRealtimeShimRpcHttpSmoke(port);

    assert.equal(proofResponse.statusCode, 200);
    assert.equal(proofResponse.payload.ok, true);
    assert.equal(proofResponse.payload.readyForIssue85Review, true);
    assert.equal(proofResponse.payload.acceptanceSummary.oneLocalVoiceTurn, true);
    assert.equal(proofResponse.payload.acceptanceSummary.interruptionCancelBehavior, true);
    assert.equal(proofResponse.payload.acceptanceSummary.boundedErrorEvidence, true);
    assert.equal(proofResponse.payload.evidence.qaChecklist.logEvidence, true);
    assert.equal(proofResponse.payload.rpcSmoke.every((step) => step.ok), true);

    assert.equal(readinessResponse.statusCode, 200);
    assert.equal(readinessResponse.payload.ok, true);
    assert.equal(readinessResponse.payload.status, "ready_for_issue_85_review");
    assert.deepEqual(readinessResponse.payload.reviewBlockers, []);
    assert.equal(readinessResponse.payload.acceptanceCriteria.every((criterion) => criterion.passed), true);

    const artifactSummary = {
      readyForIssue85Review: proofResponse.payload.readyForIssue85Review,
      readinessStatus: readinessResponse.payload.status,
      reviewBlockers: readinessResponse.payload.reviewBlockers,
      acceptanceCriteriaPassed: readinessResponse.payload.acceptanceCriteria.filter((criterion) => criterion.passed)
        .length,
      acceptanceCriteriaTotal: readinessResponse.payload.acceptanceCriteria.length,
      cancelAndErrorEvidence: {
        outputCancelled: proofResponse.payload.interruptionEvidence.turnSummary.outputCancelled,
        inputCancelled: proofResponse.payload.inputCancelEvidence.turnSummary.inputCancelled,
        boundedErrors: proofResponse.payload.errorEvidence.turnSummary.errorCount +
          proofResponse.payload.invalidAudioResult.evidence.turnSummary.errorCount,
      },
      runtimeMode: readinessResponse.payload.runtimeMode,
      reviewPacketRoutes: {
        primaryRoute: readinessResponse.payload.reviewPacket.primaryRoute,
        readinessRoute: readinessResponse.payload.reviewPacket.readinessRoute,
        rpcRoute: readinessResponse.payload.reviewPacket.rpcRoute,
      },
      evidence: {
        eventTranscriptLines: proofResponse.payload.evidence.qaEvidenceSummary.eventTranscriptLines,
        logLines: proofResponse.payload.evidence.qaEvidenceSummary.logLines,
        timelineEvents: proofResponse.payload.evidence.qaEvidenceSummary.timelineEvents,
        latencyMarks: proofResponse.payload.evidence.qaEvidenceSummary.latencyMarks,
        relayEvents: proofResponse.payload.evidence.qaEvidenceSummary.relayEvents,
      },
      rpcSmokeCoverage: {
        passed: proofResponse.payload.rpcSmoke.filter((step) => step.ok).length,
        total: proofResponse.payload.rpcSmoke.length,
        methods: proofResponse.payload.rpcSmoke.map((step) => step.method),
      },
      rpcHttpSmoke,
    };

    return {
      ok: true,
      issue: proofResponse.payload.issue,
      generatedAt: new Date().toISOString(),
      artifactSummary,
      readiness: readinessResponse.payload,
      proof: proofResponse.payload,
    };
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

  if (latestOutputPath && latestOutputPath !== outputPath) {
    await mkdir(path.dirname(latestOutputPath), { recursive: true });
    await writeFile(latestOutputPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  }

  console.log(`Saved realtime shim proof artifact to ${path.relative(process.cwd(), outputPath)}`);
  if (latestOutputPath) {
    console.log(`Updated latest realtime shim proof artifact at ${path.relative(process.cwd(), latestOutputPath)}`);
  }
  console.log(`Issue #85 ready: ${artifact.proof.readyForIssue85Review ? "yes" : "no"}`);
  console.log(
    `Acceptance criteria: ${artifact.artifactSummary.acceptanceCriteriaPassed}/${artifact.artifactSummary.acceptanceCriteriaTotal}`,
  );
  console.log(
    `In-process RPC smoke: ${artifact.artifactSummary.rpcSmokeCoverage.passed}/${artifact.artifactSummary.rpcSmokeCoverage.total}`,
  );
  console.log(
    `RPC HTTP smoke: ${artifact.artifactSummary.rpcHttpSmoke.requests} requests + bounded error`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
