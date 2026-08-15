import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { DirectToolExecutionGateway, ToolHiveToolExecutionGateway } from "../src/core/toolExecutionGateway";

test("direct tool execution gateway allows declared non-mutating agent tools", async () => {
  const gateway = new DirectToolExecutionGateway();

  const result = await gateway.execute({
    requestId: "tool-request-lookup",
    callId: "call-123",
    principalType: "voice_agent",
    tool: "retention.lookup_options",
    policyVersion: "direct-local",
    policyHash: "sha256:direct",
    requestedAt: "2026-08-14T11:45:00.000Z",
    arguments: {
      call_id: "call-123",
    },
  });

  assert.equal(result.status, "allowed");
  assert.equal(result.gatewayMode, "direct");
  assert.equal(result.reasonCode, "cedar_allowed");
  assert.equal(result.backendInvoked, true);
  assert.deepEqual(result.normalizedArguments, { call_id: "call-123" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.decisionEvent.detail, {
    requestId: "tool-request-lookup",
    callId: "call-123",
    gatewayMode: "direct",
    principalType: "voice_agent",
    tool: "retention.lookup_options",
    policyVersion: "direct-local",
    policyHash: "sha256:direct",
    decision: "allow",
    reasonCode: "cedar_allowed",
    backendInvoked: true,
    durationMs: result.decisionEvent.detail.durationMs,
    argumentKeys: "call_id",
    argumentHash: result.decisionEvent.detail.argumentHash,
    discountPercent: null,
  });
});

test("direct tool execution gateway denies agent escalation attempts without backend execution", async () => {
  const gateway = new DirectToolExecutionGateway();

  const result = await gateway.execute({
    requestId: "tool-request-escalation",
    callId: "call-456",
    principalType: "voice_agent",
    tool: "retention.apply_offer",
    requestedAt: "2026-08-14T11:46:00.000Z",
    arguments: {
      call_id: "call-456",
      offer_id: "retention-10",
      discount_percent: 10,
      approval_id: "approval-secret",
      idempotency_key: "idem-secret",
      operatorApproved: true,
    },
  });

  assert.equal(result.status, "denied");
  assert.equal(result.reasonCode, "invalid_request");
  assert.equal(result.backendInvoked, false);
  assert.deepEqual(result.errors, [
    { argumentName: "operatorApproved", reason: "unknown_argument" },
  ]);
  assert.equal(result.decisionEvent.detail.decision, "deny");
  assert.equal(result.decisionEvent.detail.backendInvoked, false);
  assert.doesNotMatch(JSON.stringify(result.decisionEvent), /approval-secret|idem-secret/);
});

test("direct tool execution gateway records policy denial separately from malformed arguments", async () => {
  const gateway = new DirectToolExecutionGateway();

  const result = await gateway.execute({
    requestId: "tool-request-agent-apply-offer",
    callId: "call-789",
    principalType: "voice_agent",
    tool: "retention.apply_offer",
    requestedAt: "2026-08-14T11:47:00.000Z",
    arguments: {
      call_id: "call-789",
      offer_id: "retention-10",
      discount_percent: 10,
      approval_id: "approval-789",
      idempotency_key: "idem-789",
    },
  });

  assert.equal(result.status, "denied");
  assert.equal(result.reasonCode, "cedar_denied");
  assert.equal(result.backendInvoked, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.normalizedArguments, {
    call_id: "call-789",
    offer_id: "retention-10",
    discount_percent: 10,
    approval_id: "approval-789",
    idempotency_key: "idem-789",
  });
  assert.equal(result.decisionEvent.detail.decision, "deny");
  assert.equal(result.decisionEvent.detail.reasonCode, "cedar_denied");
  assert.doesNotMatch(JSON.stringify(result.decisionEvent), /approval-789|idem-789/);
});

test("ToolHive tool execution gateway initializes an MCP session before tools/call", async () => {
  const requests: Array<{ principalType: string | undefined; sessionId: string | undefined; body: any }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        principalType: request.headers["x-acc-principal-type"]?.toString(),
        sessionId: request.headers["mcp-session-id"]?.toString(),
        body: JSON.parse(body),
      });
      response.setHeader("content-type", "application/json");
      const lastRequest = requests[requests.length - 1];
      if (lastRequest.body.method === "initialize") {
        response.setHeader("mcp-session-id", "mcp-session-1");
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: lastRequest.body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "test-mcp", version: "0.0.0" },
          },
        }));
        return;
      }
      if (lastRequest.body.method === "notifications/initialized") {
        response.statusCode = 202;
        response.end();
        return;
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: lastRequest.body.id, result: { content: [] } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const gateway = new ToolHiveToolExecutionGateway({
      mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
      timeoutMs: 500,
    });
    const result = await gateway.execute({
      requestId: "tool-request-1",
      callId: "call-1",
      principalType: "operator",
      tool: "retention.apply_offer",
      policyVersion: "toolhive-demo-v1",
      policyHash: "policy-hash",
      idempotencyKey: "idem-1",
      arguments: {
        call_id: "call-1",
        offer_id: "retention-10",
        discount_percent: 10,
        approval_id: "approval-1",
        idempotency_key: "idem-1",
      },
    });

    assert.equal(result.status, "allowed");
    assert.equal(result.gatewayMode, "toolhive");
    assert.equal(result.reasonCode, "cedar_allowed");
    assert.equal(result.backendInvoked, true);
    assert.equal(requests.length, 3);
    assert.equal(requests[0].principalType, "operator");
    assert.equal(requests[0].sessionId, undefined);
    assert.equal(requests[0].body.method, "initialize");
    assert.equal(requests[1].principalType, "operator");
    assert.equal(requests[1].sessionId, "mcp-session-1");
    assert.equal(requests[1].body.method, "notifications/initialized");
    assert.equal(requests[2].principalType, "operator");
    assert.equal(requests[2].sessionId, "mcp-session-1");
    assert.equal(requests[2].body.method, "tools/call");
    assert.deepEqual(requests[2].body.params, {
      name: "retention.apply_offer",
      arguments: {
        call_id: "call-1",
        offer_id: "retention-10",
        discount_percent: 10,
        approval_id: "approval-1",
        idempotency_key: "idem-1",
      },
      _meta: {
        callId: "call-1",
        principalType: "operator",
        policyVersion: "toolhive-demo-v1",
      },
    });
    assert.doesNotMatch(JSON.stringify(result.decisionEvent), /approval-1|idem-1/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("ToolHive gateway denies forbidden agent tool calls before invoking ToolHive", async () => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const gateway = new ToolHiveToolExecutionGateway({
      mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
      timeoutMs: 500,
    });
    const result = await gateway.execute({
      requestId: "tool-request-2",
      callId: "call-2",
      principalType: "voice_agent",
      tool: "retention.apply_offer",
      arguments: {
        call_id: "call-2",
        offer_id: "retention-10",
        discount_percent: 10,
        approval_id: "approval-2",
        idempotency_key: "idem-2",
        operatorApproved: true,
      },
    });

    assert.equal(result.status, "denied");
    assert.equal(result.reasonCode, "invalid_request");
    assert.equal(result.backendInvoked, false);
    assert.equal(requestCount, 0);
    assert.deepEqual(result.errors, [{ argumentName: "operatorApproved", reason: "unknown_argument" }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("ToolHive gateway fails closed on malformed successful JSON-RPC responses", async () => {
  const responses = [
    { id: "tool-request-malformed", result: { content: [] } },
    { jsonrpc: "1.0", id: "tool-request-malformed", result: { content: [] } },
    { jsonrpc: "2.0", id: "wrong-id", result: { content: [] } },
    { jsonrpc: "2.0", id: "tool-request-malformed", result: { isError: true, content: [] } },
    { jsonrpc: "2.0", id: "tool-request-malformed" },
    { jsonrpc: "2.0", id: "tool-request-malformed", result: 42 },
    { jsonrpc: "2.0", id: "tool-request-malformed", result: {} },
    { jsonrpc: "2.0", id: "tool-request-malformed", result: { isError: "true", content: [] } },
  ];
  let responseIndex = 0;
  const server = createServer((_request, response) => {
    const payload = responses[responseIndex] ?? responses[responses.length - 1];
    responseIndex += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const gateway = new ToolHiveToolExecutionGateway({
      mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
      timeoutMs: 500,
    });

    for (let attempt = 0; attempt < responses.length; attempt += 1) {
      const result = await gateway.execute({
        requestId: "tool-request-malformed",
        callId: "call-malformed",
        principalType: "operator",
        tool: "retention.apply_offer",
        arguments: {
          call_id: "call-malformed",
          offer_id: "retention-10",
          discount_percent: 10,
          approval_id: "approval-malformed",
          idempotency_key: "idem-malformed",
        },
      });

      assert.equal(result.status, "error");
      assert.equal(result.reasonCode, "toolhive_unavailable");
      assert.equal(result.backendInvoked, false);
      assert.equal(result.decisionEvent.detail.decision, "error");
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("ToolHive gateway fails closed on stale JSON-RPC error responses", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: "stale-tool-request",
      error: {
        code: -32000,
        message: "Denied",
        data: { reasonCode: "cedar_denied" },
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const gateway = new ToolHiveToolExecutionGateway({
      mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
      timeoutMs: 500,
    });
    const result = await gateway.execute({
      requestId: "current-tool-request",
      callId: "call-stale-error",
      principalType: "operator",
      tool: "retention.apply_offer",
      arguments: {
        call_id: "call-stale-error",
        offer_id: "retention-10",
        discount_percent: 10,
        approval_id: "approval-stale-error",
        idempotency_key: "idem-stale-error",
      },
    });

    assert.equal(result.status, "error");
    assert.equal(result.reasonCode, "toolhive_unavailable");
    assert.equal(result.backendInvoked, false);
    assert.equal(result.decisionEvent.detail.decision, "error");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("ToolHive gateway timeout fails closed without backend execution evidence", async () => {
  const server = createServer((_request, _response) => {
    // Keep the request open until the client-side hard deadline aborts it.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const gateway = new ToolHiveToolExecutionGateway({
      mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
      timeoutMs: 50,
    });
    const result = await gateway.execute({
      requestId: "tool-request-3",
      callId: "call-3",
      principalType: "operator",
      tool: "retention.apply_offer",
      arguments: {
        call_id: "call-3",
        offer_id: "retention-10",
        discount_percent: 10,
        approval_id: "approval-3",
        idempotency_key: "idem-3",
      },
    });

    assert.equal(result.status, "error");
    assert.equal(result.reasonCode, "toolhive_timeout");
    assert.equal(result.backendInvoked, false);
    assert.equal(result.decisionEvent.detail.reasonCode, "toolhive_timeout");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
