import test from "node:test";
import assert from "node:assert/strict";

import { DirectToolExecutionGateway } from "../src/core/toolExecutionGateway";

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
