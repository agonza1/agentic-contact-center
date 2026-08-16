import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

async function postMcp(
  principalType: string | undefined,
  body: unknown,
): Promise<{ statusCode: number; payload: any; headers: Record<string, string | string[] | undefined> }> {
  return (await postMcpSequence(principalType, [body]))[0];
}

async function postRawMcp(
  principalType: string | undefined,
  body: string,
): Promise<{ statusCode: number; payload: any; headers: Record<string, string | string[] | undefined> }> {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }
  const port = address.port;

  try {
    return await new Promise<{ statusCode: number; payload: any; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body).toString(),
      };
      if (principalType) headers["x-acc-principal-type"] = principalType;

      const req = request(
        {
          host: "127.0.0.1",
          port,
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
              payload: responseBody ? JSON.parse(responseBody) : null,
              headers: response.headers,
            });
          });
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function postInitializedMcp(
  principalType: string,
  body: unknown,
): Promise<{ statusCode: number; payload: any; headers: Record<string, string | string[] | undefined> }> {
  return (await postMcpSequence(principalType, [
    {
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "acc-route-test", version: "0.0.0" },
      },
    },
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    body,
  ]))[2];
}

async function postMcpSequence(
  principalType: string | undefined,
  bodies: unknown[],
): Promise<Array<{ statusCode: number; payload: any; headers: Record<string, string | string[] | undefined> }>> {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }
  const port = address.port;

  try {
    const responses: Array<{ statusCode: number; payload: any; headers: Record<string, string | string[] | undefined> }> = [];
    let sessionId: string | undefined;
    for (const body of bodies) {
      const response = await new Promise<{ statusCode: number; payload: any; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
        const requestBody = JSON.stringify(body);
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(requestBody).toString(),
        };
        if (principalType) headers["x-acc-principal-type"] = principalType;
        if (sessionId) headers["mcp-session-id"] = sessionId;

        const req = request(
          {
            host: "127.0.0.1",
            port,
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
                payload: responseBody ? JSON.parse(responseBody) : null,
                headers: response.headers,
              });
            });
          },
        );
        req.on("error", reject);
        req.write(requestBody);
        req.end();
      });
      const responseSessionId = response.headers["mcp-session-id"];
      if (typeof responseSessionId === "string") sessionId = responseSessionId;
      responses.push(response);
    }
    return responses;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("POST /mcp supports the initialize and initialized notification lifecycle", async () => {
  const [initialize, initialized, toolsList] = await postMcpSequence("voice_agent", [
    {
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "acc-route-test", version: "0.0.0" },
      },
    },
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    {
      jsonrpc: "2.0",
      id: "list-agent-tools",
      method: "tools/list",
    },
  ]);

  assert.equal(initialize.statusCode, 200);
  assert.match(initialize.headers["mcp-session-id"] as string, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(initialize.payload.result, {
    protocolVersion: "2025-06-18",
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    serverInfo: {
      name: "agentic-contact-center",
      version: "0.1.0",
    },
  });
  assert.equal(initialized.statusCode, 202);
  assert.equal(initialized.payload, null);
  assert.deepEqual(toolsList.payload.result.tools.map((tool: { name: string }) => tool.name), [
    "retention.lookup_options",
    "operator.request_approval",
  ]);
});

test("POST /mcp negotiates unsupported protocol versions down to a supported version", async () => {
  const response = await postMcp("voice_agent", {
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: "2999-01-01",
      clientInfo: { name: "future-client", version: "1.0.0" },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.result.protocolVersion, "2025-06-18");
  assert.match(response.headers["mcp-session-id"] as string, /^[0-9a-f-]{36}$/i);
});

test("POST /mcp returns JSON-RPC parse errors for malformed JSON", async () => {
  const response = await postRawMcp("voice_agent", "{\"jsonrpc\":\"2.0\",");

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32700,
      message: "Parse error",
    },
  });
});

test("POST /mcp scopes initialization to each MCP session", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }
  const sessionScopePort = address.port;

  async function requestMcp(body: unknown, sessionId?: string) {
    return await new Promise<{ statusCode: number; payload: any; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const requestBody = JSON.stringify(body);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestBody).toString(),
        "x-acc-principal-type": "voice_agent",
      };
      if (sessionId) headers["mcp-session-id"] = sessionId;

      const req = request(
        {
          host: "127.0.0.1",
          port: sessionScopePort,
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
              payload: responseBody ? JSON.parse(responseBody) : null,
              headers: response.headers,
            });
          });
        },
      );
      req.on("error", reject);
      req.write(requestBody);
      req.end();
    });
  }

  try {
    const initializeA = await requestMcp({
      jsonrpc: "2.0",
      id: "initialize-a",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const sessionA = initializeA.headers["mcp-session-id"] as string;
    await requestMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionA);

    const initializeB = await requestMcp({
      jsonrpc: "2.0",
      id: "initialize-b",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const sessionB = initializeB.headers["mcp-session-id"] as string;

    const sessionAList = await requestMcp({ jsonrpc: "2.0", id: "list-a", method: "tools/list" }, sessionA);
    const sessionBListBeforeInitialized = await requestMcp({ jsonrpc: "2.0", id: "list-b", method: "tools/list" }, sessionB);

    assert.notEqual(sessionA, sessionB);
    assert.equal(sessionAList.statusCode, 200);
    assert.equal(sessionAList.payload.result.tools.length, 2);
    assert.equal(sessionBListBeforeInitialized.statusCode, 428);

    await requestMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionB);
    const sessionBList = await requestMcp({ jsonrpc: "2.0", id: "list-b-ready", method: "tools/list" }, sessionB);
    assert.equal(sessionBList.statusCode, 200);
    assert.equal(sessionBList.payload.result.tools.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("POST /mcp caps retained session state and evicts the oldest session", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }
  const mcpSessionCapPort = address.port;

  async function requestMcp(body: unknown, sessionId?: string) {
    return await new Promise<{ statusCode: number; payload: any; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const requestBody = JSON.stringify(body);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestBody).toString(),
        "x-acc-principal-type": "voice_agent",
      };
      if (sessionId) headers["mcp-session-id"] = sessionId;

      const req = request(
        {
          host: "127.0.0.1",
          port: mcpSessionCapPort,
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
              payload: responseBody ? JSON.parse(responseBody) : null,
              headers: response.headers,
            });
          });
        },
      );
      req.on("error", reject);
      req.write(requestBody);
      req.end();
    });
  }

  try {
    const firstInitialize = await requestMcp({
      jsonrpc: "2.0",
      id: "initialize-oldest",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const oldestSession = firstInitialize.headers["mcp-session-id"] as string;
    await requestMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, oldestSession);
    await new Promise((resolve) => setTimeout(resolve, 5));

    for (let index = 0; index < 64; index += 1) {
      await requestMcp({
        jsonrpc: "2.0",
        id: `initialize-${index}`,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      });
    }

    const evictedList = await requestMcp({ jsonrpc: "2.0", id: "list-evicted", method: "tools/list" }, oldestSession);
    assert.equal(evictedList.statusCode, 428);
    assert.equal(evictedList.payload.error.message, "ACC MCP session is not initialized");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("POST /mcp fails closed when tools are requested before initialization completes", async () => {
  const response = await postMcp("voice_agent", {
    jsonrpc: "2.0",
    id: "premature-list",
    method: "tools/list",
  });

  assert.equal(response.statusCode, 428);
  assert.deepEqual(response.payload, {
    jsonrpc: "2.0",
    id: "premature-list",
    error: {
      code: -32002,
      message: "ACC MCP session is not initialized",
    },
  });
});

test("POST /mcp tools/list exposes only voice-agent callable ACC tools", async () => {
  const response = await postInitializedMcp("voice_agent", {
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
  const response = await postInitializedMcp("operator", {
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
  const response = await postInitializedMcp("voice_agent", {
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
  const response = await postInitializedMcp("voice_agent", {
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
  const response = await postInitializedMcp("voice_agent", {
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
