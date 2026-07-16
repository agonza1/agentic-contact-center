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
  return path.resolve(process.cwd(), "artifacts", `pipecat-media-engine-readiness-${timestamp}.json`);
}

function resolveLatestOutputPath() {
  const explicitLatestOutputPath = resolveArgPath("--latest-out");
  if (explicitLatestOutputPath) {
    return explicitLatestOutputPath;
  }

  if (hasArg("--out")) {
    return undefined;
  }

  return path.resolve(process.cwd(), "artifacts", "pipecat-media-engine-readiness-latest.json");
}

async function withServer(run) {
  const server = buildHttpServer(loadPocConfig());

  await new Promise((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the Pipecat media readiness proof server to bind an ephemeral TCP port.");
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

async function main() {
  const outputPath = resolveOutputPath();
  const latestOutputPath = resolveLatestOutputPath();
  const readiness = await withServer(async (port) => {
    const response = await requestJson(port, "/api/pipecat-media-engine/readiness");
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.route, "/api/pipecat-media-engine/readiness");
    assert.equal(response.payload.issue, "agonza1/agentic-contact-center#214");
    assert.equal(response.payload.status, "shared_media_live_proof_complete_flows_pending");
    return response.payload;
  });

  const passedCriteria = readiness.acceptanceCriteria.filter((criterion) => criterion.passed).length;
  const failingCriteria = readiness.acceptanceCriteria
    .filter((criterion) => !criterion.passed)
    .map((criterion) => criterion.name);
  const totalCriteria = readiness.acceptanceCriteria.length;
  const artifact = {
    ok: true,
    issue: readiness.issue,
    generatedAt: new Date().toISOString(),
    artifactSummary: {
      readinessStatus: readiness.status,
      reviewReady: readiness.reviewReady,
      reviewBlockers: readiness.reviewBlockers,
      reviewBlockerCount: readiness.reviewBlockers.length,
      acceptanceCriteriaPassed: passedCriteria,
      acceptanceCriteriaTotal: totalCriteria,
      failingAcceptanceCriteria: failingCriteria,
      implementedAdapters: readiness.sharedEngineContract.requiredAdapters
        .filter((adapter) => adapter.implementedNow)
        .map((adapter) => adapter.id),
      blockedAdapters: readiness.sharedEngineContract.requiredAdapters
        .filter((adapter) => !adapter.implementedNow)
        .map((adapter) => adapter.id),
      nextUnblockedSlice: {
        id: readiness.nextUnblockedSlice.id,
        title: readiness.nextUnblockedSlice.title,
        adapter: readiness.nextUnblockedSlice.adapter,
        entryPoint: readiness.nextUnblockedSlice.entryPoint,
      },
      liveSipProofAcceptance: readiness.liveSipProofAcceptance,
      remainingWorkCount: readiness.remainingWork.length,
      validationCommands: readiness.validationCommands,
      nextValidationCommand: readiness.liveSipProofAcceptance.proofBundleCommand,
      requiredRuntimeEndpoints: readiness.liveSipProofAcceptance.requiredRuntimeEndpoints,
    },
    readiness,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Saved Pipecat media engine readiness artifact: ${outputPath}`);

  if (latestOutputPath) {
    await mkdir(path.dirname(latestOutputPath), { recursive: true });
    await writeFile(latestOutputPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`Updated latest Pipecat media engine readiness artifact: ${latestOutputPath}`);
  }

  console.log(`Review ready: ${artifact.artifactSummary.reviewReady ? "yes" : "no"}`);
  console.log(`Review blockers: ${artifact.artifactSummary.reviewBlockerCount}`);
  console.log(`Acceptance criteria: ${passedCriteria}/${totalCriteria}`);
  console.log(`Failing criteria: ${failingCriteria.length > 0 ? failingCriteria.join(", ") : "none"}`);
  console.log(`Next slice: ${readiness.nextUnblockedSlice.id}`);
  console.log(`Next validation: ${artifact.artifactSummary.nextValidationCommand}`);
  console.log(`Runtime prerequisites: ${artifact.artifactSummary.requiredRuntimeEndpoints.map((endpoint) => endpoint.id).join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
