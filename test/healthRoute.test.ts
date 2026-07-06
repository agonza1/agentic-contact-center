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
    operatorChannel: string;
    policyProfile: string;
    policyToolScope: string;
    fallbackMode: string;
    latencyBudgetsMs: { asrPartial: number; policyGate: number; operatorNotification: number; ttsFirstAudio: number };
    runtimeSeams: string[];
    pipecatFlow: {
      ready: boolean;
      prototypeMode: string;
      transport: string;
      runtimeEngine: string;
      credentialsMode: string;
      runtimeCheck: { command: string; installCommand: string; liveTelephonyRequired: boolean };
      activeTool: string | null;
      toolCoverage: string[];
    };
    speechEnhancement: {
      issue: string;
      recommendedLatencyMs: number;
      runtimeEnabled: boolean;
      runtimeLatencyMs: number;
      runtimeBypassReason?: string;
      liveDemoGate: string;
      issueCloseReady: boolean;
      missingEvidence: string[];
      blockers: string[];
    };
  };

  assert.equal(payload.ok, true);
  assert.equal(payload.demoName, config.demoName);
  assert.equal(payload.policyProfile, config.policy.profile);
  assert.equal(payload.policyToolScope, config.policy.toolScope);
  assert.equal(payload.operatorChannel, config.operator.channel);
  assert.equal(payload.fallbackMode, config.policy.fallbackMode);
  assert.deepEqual(payload.latencyBudgetsMs, config.latencyBudgetsMs);
  assert.equal(payload.runtimeSeams.includes("flow engine"), true);
  assert.equal(payload.pipecatFlow.ready, true);
  assert.equal(payload.pipecatFlow.prototypeMode, "pipecat_local_runtime");
  assert.equal(payload.pipecatFlow.transport, "local_process");
  assert.equal(payload.pipecatFlow.runtimeEngine, "pipecat-ai");
  assert.equal(payload.pipecatFlow.credentialsMode, "mocked");
  assert.equal(payload.pipecatFlow.runtimeCheck.command, "npm run pipecat:check");
  assert.equal(payload.pipecatFlow.runtimeCheck.liveTelephonyRequired, false);
  assert.match(payload.pipecatFlow.runtimeCheck.installCommand, /requirements-pipecat\.txt/);
  assert.equal(payload.pipecatFlow.activeTool, "get_current_slide");
  assert.equal(payload.pipecatFlow.toolCoverage.includes("goto_slide"), true);
  assert.equal(payload.speechEnhancement.issue, "agonza1/agentic-contact-center#97");
  assert.equal(payload.speechEnhancement.recommendedLatencyMs, 12.5);
  assert.equal(payload.speechEnhancement.runtimeEnabled, false);
  assert.equal(payload.speechEnhancement.runtimeLatencyMs, 12.5);
  assert.equal(payload.speechEnhancement.runtimeBypassReason, "feature_flag_disabled");
  assert.equal(payload.speechEnhancement.liveDemoGate, "blocked_until_real_capture");
  assert.equal(payload.speechEnhancement.issueCloseReady, false);
  assert.ok(
    payload.speechEnhancement.missingEvidence.includes(
      "real_noisy_local_sip_capture_baseline_vs_enhanced_replay",
    ),
  );
  assert.ok(payload.speechEnhancement.blockers.some((item) => item.includes("real noisy local SIP capture")));
});
