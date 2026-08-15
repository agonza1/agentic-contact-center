import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

async function postMcp(
  principalType: string | undefined,
  body: unknown,
): Promise<{ statusCode: number; payload: any }> {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    return await new Promise((resolve, reject) => {
      const requestBody = JSON.stringify(body);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestBody).toString(),
      };
      if (principalType) headers["x-acc-principal-type"] = principalType;

      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/mcp",
          method: "POST",
          headers,
        },
        (response) => {
          let responseBody = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            responseBody += chunk;
          });
          response.on("end", () => {
            resolve({
              statusCode: response.statusCode ?? 0,
              payload: JSON.parse(responseBody),
            });
          });
        },
      );
      req.on("error", reject);
      req.write(requestBody);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("POST /mcp tools/list exposes only voice-agent callable ACC tools", async () => {
  const response = await postMcp("voice_agent", {
    jsonrpc: "2.0",
    id: "list-agent-tools",
    method: "tools/list",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.jsonrpc, "2.0");
  assert.equal(response.payload.id, "list-agent-tools");
  assert.deepEqual(response.payload.result.tools.map((tool: { name: string }) => tool.name), [
    "retention.lookup_options",
    "operator.request_approval",
  ]);
  assert.equal(JSON.stringify(response.payload.result.tools).includes("retention.apply_offer"), false);
  assert.equal(response.payload.result.tools[0].annotations.openWorldHint, false);
});

test("POST /mcp tools/list exposes operator-only apply_offer to operator principals", async () => {
  const response = await postMcp("operator", {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.result.tools.map((tool: { name: string }) => tool.name), [
    "retention.lookup_options",
    "operator.request_approval",
    "retention.apply_offer",
  ]);
  const applyOffer = response.payload.result.tools.find((tool: { name: string }) => tool.name === "retention.apply_offer");
  assert.equal(applyOffer.annotations.destructiveHint, true);
  assert.equal(applyOffer.inputSchema.properties.discount_percent.maximum, 10);
});

test("POST /mcp fails closed without an ACC principal header", async () => {
  const response = await postMcp(undefined, {
    jsonrpc: "2.0",
    id: "missing-principal",
    method: "tools/list",
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.payload, {
    jsonrpc: "2.0",
    id: "missing-principal",
    error: {
      code: -32001,
      message: "Missing or invalid ACC principal type",
    },
  });
});
