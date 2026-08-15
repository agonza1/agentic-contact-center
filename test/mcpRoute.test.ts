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

test("POST /mcp tools/call executes declared voice-agent read tools", async () => {
  const response = await postMcp("voice_agent", {
    jsonrpc: "2.0",
    id: "lookup-options",
    method: "tools/call",
    params: {
      name: "retention.lookup_options",
      arguments: {
        call_id: "call-123",
      },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.jsonrpc, "2.0");
  assert.equal(response.payload.id, "lookup-options");
  assert.equal(response.payload.result.content[0].type, "text");

  const content = JSON.parse(response.payload.result.content[0].text);
  assert.deepEqual(content.options, [
    {
      offer_id: "retention-10",
      label: "retention specialist review",
      discount_percent_max: 10,
      requires_operator_approval: true,
    },
  ]);
});

test("POST /mcp tools/call denies voice-agent apply_offer without invoking backend semantics", async () => {
  const response = await postMcp("voice_agent", {
    jsonrpc: "2.0",
    id: "agent-apply-offer",
    method: "tools/call",
    params: {
      name: "retention.apply_offer",
      arguments: {
        call_id: "call-123",
        offer_id: "retention-10",
        discount_percent: 10,
        approval_id: "approval-123",
        idempotency_key: "idem-123",
      },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    jsonrpc: "2.0",
    id: "agent-apply-offer",
    error: {
      code: -32003,
      message: "ACC MCP tool is not authorized for this principal",
      data: { reasonCode: "cedar_denied" },
    },
  });
});

test("POST /mcp tools/call rejects escalation flags before authorization", async () => {
  const response = await postMcp("voice_agent", {
    jsonrpc: "2.0",
    id: "agent-escalation-flag",
    method: "tools/call",
    params: {
      name: "retention.apply_offer",
      arguments: {
        call_id: "call-123",
        offer_id: "retention-10",
        discount_percent: 10,
        approval_id: "approval-123",
        idempotency_key: "idem-123",
        operatorApproved: true,
      },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    jsonrpc: "2.0",
    id: "agent-escalation-flag",
    error: {
      code: -32602,
      message: "Invalid ACC MCP tool arguments",
      data: { reasonCode: "invalid_request" },
    },
  });
});
