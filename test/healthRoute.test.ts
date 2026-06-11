import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

test("GET /health returns config-backed demo metadata", async () => {
  const config = loadPocConfig();
  const server = buildHttpServer(config);

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  const responseBody = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: "/health",
        method: "GET",
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve(body));
      },
    );

    req.on("error", reject);
    req.end();
  });

  server.close();

  const payload = JSON.parse(responseBody) as {
    ok: boolean;
    demoName: string;
    runtimeSeams: string[];
    pipecatFlow: { ready: boolean; toolCoverage: string[] };
  };

  assert.equal(payload.ok, true);
  assert.equal(payload.demoName, config.demoName);
  assert.equal(payload.runtimeSeams.includes("flow engine"), true);
  assert.equal(payload.pipecatFlow.ready, true);
  assert.equal(payload.pipecatFlow.toolCoverage.includes("goto_slide"), true);
});
