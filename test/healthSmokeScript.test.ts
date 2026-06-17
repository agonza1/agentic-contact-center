import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { Socket } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";

const repoRoot = join(__dirname, "..", "..");

type RequestHandler = (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void;

async function withServer(handler: RequestHandler, run: (port: number) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer(handler);

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    await run(address.port);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }

    server.close();
    await once(server, "close");
  }
}

async function runProbe(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const scriptPath = join(repoRoot, "scripts", "health-smoke.mjs");

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd: repoRoot });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("health smoke script retries until the endpoint becomes healthy", async () => {
  let attempts = 0;

  await withServer((request, response) => {
    attempts += 1;
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    if (attempts < 3) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  }, async (port) => {
    const result = await runProbe(["--url", `http://127.0.0.1:${port}/health`, "--timeout-ms", "1500", "--interval-ms", "25"]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Health probe succeeded/);
    assert.equal(attempts, 3);
  });
});

test("health smoke script fails fast with a timeout summary when the endpoint stays unhealthy", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  }, async (port) => {
    const result = await runProbe(["--url", `http://127.0.0.1:${port}/health`, "--timeout-ms", "200", "--interval-ms", "25"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Timed out waiting for a healthy response/);
    assert.match(result.stderr, /Last failure: http_503/);
  });
});


test("health smoke script aborts a hanging response within the outer timeout", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    // Leave the response open to simulate an app that accepts the socket but never finishes /health.
  }, async (port) => {
    const startedAt = Date.now();
    const result = await runProbe(["--url", `http://127.0.0.1:${port}/health`, "--timeout-ms", "200", "--interval-ms", "25"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Timed out waiting for a healthy response/);
    assert.match(result.stderr, /Last failure:/);
    assert.ok(Date.now() - startedAt < 1500);
  });
});

test("health smoke script rejects 200 responses that still report ok false", async () => {
  let attempts = 0;

  await withServer((request, response) => {
    attempts += 1;
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  }, async (port) => {
    const result = await runProbe(["--url", `http://127.0.0.1:${port}/health`, "--timeout-ms", "200", "--interval-ms", "25"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last failure: json_ok_false/);
    assert.ok(attempts >= 2);
  });
});

test("health smoke script can assert expected health metadata", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        demoName: "ClueCon cancellation rescue",
        mode: "mocked_telephony",
        provider: "signalwire",
        operatorChannel: "slack",
      }),
    );
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-demo-name",
      "ClueCon cancellation rescue",
      "--expect-mode",
      "mocked_telephony",
      "--expect-provider",
      "signalwire",
      "--expect-operator-channel",
      "slack",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Health probe succeeded/);
  });
});

test("health smoke script reports metadata mismatches in the timeout summary", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, provider: "twilio" }));
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-provider",
      "signalwire",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last failure: json_provider_mismatch/);
  });
});
