import test from "node:test";
import assert from "node:assert/strict";

import { buildToolGatewayReadiness } from "../src/core/toolGatewayReadiness";

test("tool gateway readiness keeps direct mode as the no-dependency default", () => {
  const readiness = buildToolGatewayReadiness({});

  assert.equal(readiness.mode, "direct");
  assert.equal(readiness.configured, true);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.failClosed, false);
  assert.equal(readiness.mcpUrl, null);
  assert.equal(readiness.timeoutMs, 1500);
  assert.match(readiness.policyHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(readiness.toolhiveVersion, "v0.40.0");
  assert.equal(readiness.validatingWebhookFailurePolicy, "fail");
  assert.deepEqual(readiness.blockers, []);
});

test("toolhive mode reports exact blockers and remains fail-closed when incomplete", () => {
  const readiness = buildToolGatewayReadiness({
    ACC_TOOL_GATEWAY_MODE: "toolhive",
  });

  assert.equal(readiness.mode, "toolhive");
  assert.equal(readiness.configured, false);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.failClosed, true);
  assert.deepEqual(readiness.blockers, ["missing_TOOLHIVE_MCP_URL", "missing_TOOLHIVE_POLICY_VERSION"]);
  assert.match(readiness.evidence, /fail closed/);
});

test("toolhive mode accepts the minimum required gateway configuration", () => {
  const readiness = buildToolGatewayReadiness({
    ACC_TOOL_GATEWAY_MODE: "toolhive",
    TOOLHIVE_MCP_URL: "http://127.0.0.1:24100/mcp",
    TOOLHIVE_POLICY_VERSION: "toolhive-demo-v1",
    TOOLHIVE_TIMEOUT_MS: "2750",
  });

  assert.equal(readiness.mode, "toolhive");
  assert.equal(readiness.configured, true);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.failClosed, true);
  assert.equal(readiness.mcpUrl, "http://127.0.0.1:24100/mcp");
  assert.equal(readiness.policyVersion, "toolhive-demo-v1");
  assert.match(readiness.policyHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(readiness.toolhiveVersion, "v0.40.0");
  assert.equal(readiness.validatingWebhookFailurePolicy, "fail");
  assert.equal(readiness.timeoutMs, 2750);
  assert.deepEqual(readiness.toolExposure, [
    { principalType: "voice_agent", tools: ["retention.lookup_options", "operator.request_approval"] },
    { principalType: "operator", tools: ["retention.lookup_options", "operator.request_approval", "retention.apply_offer"] },
  ]);
  assert.deepEqual(readiness.blockers, []);
});
