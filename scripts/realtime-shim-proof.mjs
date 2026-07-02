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
  const proof = await withServer(async (port) => {
    const response = await requestJson(port, "/api/realtime-shim/proof");

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.readyForIssue85Review, true);
    assert.equal(response.payload.acceptanceSummary.oneLocalVoiceTurn, true);
    assert.equal(response.payload.acceptanceSummary.interruptionCancelBehavior, true);
    assert.equal(response.payload.acceptanceSummary.boundedErrorEvidence, true);
    assert.equal(response.payload.evidence.qaChecklist.logEvidence, true);

    return response.payload;
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(proof, null, 2) + "\n", "utf8");

  console.log(`Saved realtime shim proof artifact to ${path.relative(process.cwd(), outputPath)}`);
  console.log(`Issue #85 ready: ${proof.readyForIssue85Review ? "yes" : "no"}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
