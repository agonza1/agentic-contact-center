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

function resolveOutputPath() {
  const explicitOutputPath = resolveArgPath("--out");
  if (explicitOutputPath) {
    return explicitOutputPath;
  }

  const timestamp = new Date().toISOString().replace(/[:]/g, "-");
  return path.resolve(process.cwd(), "artifacts", `realtime-shim-proof-${timestamp}.json`);
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

async function main() {
  const outputPath = resolveOutputPath();
  const artifact = await withServer(async (port) => {
    const [proofResponse, readinessResponse] = await Promise.all([
      requestJson(port, "/api/realtime-shim/proof"),
      requestJson(port, "/api/realtime-shim/readiness"),
    ]);

    assert.equal(proofResponse.statusCode, 200);
    assert.equal(proofResponse.payload.ok, true);
    assert.equal(proofResponse.payload.readyForIssue85Review, true);
    assert.equal(proofResponse.payload.acceptanceSummary.oneLocalVoiceTurn, true);
    assert.equal(proofResponse.payload.acceptanceSummary.interruptionCancelBehavior, true);
    assert.equal(proofResponse.payload.acceptanceSummary.boundedErrorEvidence, true);
    assert.equal(proofResponse.payload.evidence.qaChecklist.logEvidence, true);

    assert.equal(readinessResponse.statusCode, 200);
    assert.equal(readinessResponse.payload.ok, true);
    assert.equal(readinessResponse.payload.status, "ready_for_issue_85_review");
    assert.deepEqual(readinessResponse.payload.reviewBlockers, []);
    assert.equal(readinessResponse.payload.acceptanceCriteria.every((criterion) => criterion.passed), true);

    return {
      ok: true,
      issue: proofResponse.payload.issue,
      generatedAt: new Date().toISOString(),
      readiness: readinessResponse.payload,
      proof: proofResponse.payload,
    };
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

  console.log(`Saved realtime shim proof artifact to ${path.relative(process.cwd(), outputPath)}`);
  console.log(`Issue #85 ready: ${artifact.proof.readyForIssue85Review ? "yes" : "no"}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
