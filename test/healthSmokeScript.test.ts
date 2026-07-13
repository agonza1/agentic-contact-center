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

test("health smoke script requires a JSON payload when metadata assertions are configured", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
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
    assert.match(result.stderr, /Last failure: json_payload_required/);
  });
});

test("health smoke script can assert expected health metadata and multiple runtime seams", async () => {
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
        policyProfile: "retention_safe_mode",
        policyToolScope: "deny_by_default",
        operatorChannel: "slack",
        fallbackMode: "tool_timeout",
        runtimeSeams: ["flow engine", "mocked telephony ingress"],
        productionReadiness: {
          demoReady: true,
          productionReady: false,
          statePersistence: "in_memory",
          blockers: ["live_telephony_not_enabled", "provider_credentials_mocked", "state_store_in_memory"],
        },
        pipecatFlow: {
          ready: true,
          prototypeMode: "pipecat_local_runtime",
          transport: "local_process",
          runtimeEngine: "pipecat-ai",
          credentialsMode: "mocked",
          runtimeCheck: {
            command: "npm run pipecat:check",
            installCommand: "python3 -m pip install --target .pipecat-runtime -r requirements-pipecat.txt",
            liveTelephonyRequired: false,
          },
          activeTool: "get_current_slide",
          toolCoverage: ["goto_slide", "approve_offer"],
          script: { completed: true },
        },
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
      "--expect-policy-profile",
      "retention_safe_mode",
      "--expect-policy-tool-scope",
      "deny_by_default",
      "--expect-operator-channel",
      "slack",
      "--expect-fallback-mode",
      "tool_timeout",
      "--expect-runtime-seam",
      "flow engine",
      "--expect-runtime-seam",
      "mocked telephony ingress",
      "--expect-pipecat-ready",
      "true",
      "--expect-production-ready",
      "false",
      "--expect-production-readiness-blocker",
      "live_telephony_not_enabled",
      "--expect-production-readiness-blocker",
      "provider_credentials_mocked",
      "--expect-production-readiness-blocker",
      "state_store_in_memory",
      "--expect-pipecat-prototype-mode",
      "pipecat_local_runtime",
      "--expect-pipecat-transport",
      "local_process",
      "--expect-pipecat-runtime-engine",
      "pipecat-ai",
      "--expect-pipecat-credentials-mode",
      "mocked",
      "--expect-pipecat-runtime-check-command",
      "npm run pipecat:check",
      "--expect-pipecat-runtime-check-install-command",
      "python3 -m pip install --target .pipecat-runtime -r requirements-pipecat.txt",
      "--expect-pipecat-runtime-check-live-telephony-required",
      "false",
      "--expect-pipecat-active-tool",
      "get_current_slide",
      "--expect-pipecat-tool",
      "goto_slide",
      "--expect-pipecat-tool",
      "approve_offer",
      "--expect-pipecat-script-completed",
      "true",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Health probe succeeded/);
  });
});

test("health smoke script reports production readiness mismatches", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, productionReadiness: { productionReady: true, blockers: [] } }));
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-production-ready",
      "false",
      "--expect-production-readiness-blocker",
      "provider_credentials_mocked",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /json_productionReadiness_productionReady_mismatch/);
  });
});

test("health smoke script reports metadata mismatches in the timeout summary", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, provider: "signalwire", policyProfile: "retention_safe_mode", fallbackMode: "operator_override" }));
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-provider",
      "signalwire",
      "--expect-policy-profile",
      "strict_retention_mode",
      "--expect-fallback-mode",
      "tool_timeout",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last failure: json_policyProfile_mismatch\(expected="strict_retention_mode",actual="retention_safe_mode"\)/);
  });
});

test("health smoke script can assert expected latency budgets", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        latencyBudgetsMs: {
          asrPartial: 350,
          operatorNotification: 1000,
        },
      }),
    );
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-latency-budget-ms",
      "asrPartial=350",
      "--expect-latency-budget-ms",
      "operatorNotification=1000",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Health probe succeeded/);
  });
});

test("health smoke script accepts latency budget maximum expectations", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, latencyBudgetsMs: { asrPartial: 320 } }));
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-latency-budget-max-ms",
      "asrPartial=350",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Health probe succeeded/);
  });
});

test("health smoke script reports latency budget maximum overruns", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, latencyBudgetsMs: { asrPartial: 375 } }));
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-latency-budget-max-ms",
      "asrPartial=350",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last failure: json_latencyBudgetsMs_asrPartial_over_max\(expected<=350,actual=375\)/);
  });
});

test("health smoke script rejects malformed latency budget expectations before probing", async () => {
  const result = await runProbe([
    "--url",
    "http://127.0.0.1:1/health",
    "--expect-latency-budget-ms",
    "asrPartial",
    "--timeout-ms",
    "1500",
    "--interval-ms",
    "25",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid_latency_budget_expectation\("asrPartial"\)/);
  assert.doesNotMatch(result.stderr, /Timed out waiting for a healthy response/);
});

test("health smoke script rejects non-integer latency budget expectations before probing", async () => {
  const result = await runProbe([
    "--url",
    "http://127.0.0.1:1/health",
    "--expect-latency-budget-ms",
    "asrPartial=350.5",
    "--timeout-ms",
    "1500",
    "--interval-ms",
    "25",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid_latency_budget_value\("asrPartial=350\.5"\)/);
  assert.doesNotMatch(result.stderr, /Timed out waiting for a healthy response/);
});

test("health smoke script rejects unknown arguments before probing", async () => {
  const result = await runProbe([
    "--url",
    "http://127.0.0.1:1/health",
    "--expect-provider",
    "signalwire",
    "--expect-prvodier",
    "signalwire",
    "--timeout-ms",
    "1500",
    "--interval-ms",
    "25",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown_argument\("--expect-prvodier"\)/);
  assert.doesNotMatch(result.stderr, /Timed out waiting for a healthy response/);
});

test("health smoke script rejects malformed timeout and interval values before probing", async () => {
  const invalidTimeout = await runProbe([
    "--url",
    "http://127.0.0.1:1/health",
    "--timeout-ms",
    "200.5",
    "--interval-ms",
    "25",
  ]);

  assert.equal(invalidTimeout.code, 1);
  assert.match(invalidTimeout.stderr, /invalid_timeout_ms_value\("200\.5"\)/);
  assert.doesNotMatch(invalidTimeout.stderr, /Timed out waiting for a healthy response/);

  const invalidInterval = await runProbe([
    "--url",
    "http://127.0.0.1:1/health",
    "--timeout-ms",
    "1500",
    "--interval-ms",
    "25ms",
  ]);

  assert.equal(invalidInterval.code, 1);
  assert.match(invalidInterval.stderr, /invalid_interval_ms_value\("25ms"\)/);
  assert.doesNotMatch(invalidInterval.stderr, /Timed out waiting for a healthy response/);
});

test("health smoke script rejects missing argument values before probing", async () => {
  const result = await runProbe([
    "--url",
    "http://127.0.0.1:1/health",
    "--expect-provider",
    "--timeout-ms",
    "1500",
    "--interval-ms",
    "25",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /missing_value\("--expect-provider"\)/);
  assert.doesNotMatch(result.stderr, /Timed out waiting for a healthy response/);
});

test("health smoke script rejects malformed Pipecat script-completed expectations before probing", async () => {
  const result = await runProbe([
    "--url",
    "http://127.0.0.1:1/health",
    "--expect-pipecat-script-completed",
    "yes",
    "--timeout-ms",
    "1500",
    "--interval-ms",
    "25",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid_pipecat_script_completed_value\("yes"\)/);
  assert.doesNotMatch(result.stderr, /Timed out waiting for a healthy response/);
});

test("health smoke script rejects malformed Pipecat readiness expectations before probing", async () => {
  const result = await runProbe([
    "--url",
    "http://127.0.0.1:1/health",
    "--expect-pipecat-ready",
    "yes",
    "--timeout-ms",
    "1500",
    "--interval-ms",
    "25",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid_pipecat_ready_value\("yes"\)/);
  assert.doesNotMatch(result.stderr, /Timed out waiting for a healthy response/);
});

test("health smoke script reports Pipecat runtime metadata mismatches in the timeout summary", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, pipecatFlow: { ready: true, prototypeMode: "deterministic_templates" } }));
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-pipecat-prototype-mode",
      "pipecat_local_runtime",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last failure: json_pipecatFlow_prototypeMode_mismatch\(expected="pipecat_local_runtime",actual="deterministic_templates"\)/);
  });
});

test("health smoke script reports Pipecat runtime-check mismatches in the timeout summary", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        pipecatFlow: {
          runtimeCheck: {
            command: "npm run pipecat:check",
            installCommand: "python3 -m pip install --target .pipecat-runtime -r requirements-pipecat.txt",
            liveTelephonyRequired: false,
          },
        },
      }),
    );
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-pipecat-runtime-check-command",
      "npm run pipecat:verify",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last failure: json_pipecatFlow_runtimeCheck_command_mismatch\(expected="npm run pipecat:verify",actual="npm run pipecat:check"\)/);
  });
});

test("health smoke script reports Pipecat active-tool mismatches in the timeout summary", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, pipecatFlow: { activeTool: "pause_presentation" } }));
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-pipecat-active-tool",
      "get_current_slide",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last failure: json_pipecatFlow_activeTool_mismatch\(expected="get_current_slide",actual="pause_presentation"\)/);
  });
});

test("health smoke script reports Pipecat readiness mismatches in the timeout summary", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, pipecatFlow: { ready: false, toolCoverage: ["goto_slide"] } }));
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-pipecat-ready",
      "true",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last failure: json_pipecatFlow_ready_mismatch\(expected=true,actual=false\)/);
  });
});

test("health smoke script reports Pipecat script-completed mismatches in the timeout summary", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, pipecatFlow: { script: { completed: false } } }));
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-pipecat-script-completed",
      "true",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last failure: json_pipecatFlow_script_completed_mismatch\(expected=true,actual=false\)/);
  });
});

test("health smoke script reports missing Pipecat tools in the timeout summary", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, pipecatFlow: { toolCoverage: ["goto_slide"] } }));
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-pipecat-tool",
      "approve_offer",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last failure: json_pipecatFlow_toolCoverage_missing\(expected="approve_offer",actual=\["goto_slide"\]\)/);
  });
});

test("health smoke script reports latency budget mismatches in the timeout summary", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, latencyBudgetsMs: { asrPartial: 475 } }));
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-latency-budget-ms",
      "asrPartial=350",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last failure: json_latencyBudgetsMs_asrPartial_mismatch\(expected=350,actual=475\)/);
  });
});

test("health smoke script reports missing runtime seams in the timeout summary", async () => {
  await withServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, runtimeSeams: ["mocked telephony ingress"] }));
  }, async (port) => {
    const result = await runProbe([
      "--url",
      `http://127.0.0.1:${port}/health`,
      "--expect-runtime-seam",
      "flow engine",
      "--timeout-ms",
      "200",
      "--interval-ms",
      "25",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Last failure: json_runtimeSeams_missing\(expected="flow engine",actual=\["mocked telephony ingress"\]\)/);
  });
});
