import test from "node:test";
import assert from "node:assert/strict";

import { buildToolPolicyDecisionEvent } from "../src/core/toolGatewayDecision";

test("tool policy decision event records the redacted gateway evidence contract", () => {
  const event = buildToolPolicyDecisionEvent({
    requestId: "tool-request-123",
    callId: "call-123",
    gatewayMode: "toolhive",
    principalType: "operator",
    tool: "retention.apply_offer",
    policyVersion: "toolhive-demo-v1",
    policyHash: "sha256:abc123",
    decision: "allow",
    reasonCode: "cedar_allowed",
    backendInvoked: true,
    durationMs: 12.8,
    timestamp: "2026-08-14T05:40:00.000Z",
    arguments: {
      call_id: "call-123",
      offer_id: "retention-10",
      discount_percent: 10,
      approval_id: "approval-secret",
      idempotency_key: "idem-secret",
      operatorApproved: true,
      token: "bearer-secret",
    },
  });

  assert.equal(event.type, "tool_policy_decision");
  assert.equal(event.at, "2026-08-14T05:40:00.000Z");
  assert.deepEqual(event.detail, {
    requestId: "tool-request-123",
    callId: "call-123",
    gatewayMode: "toolhive",
    principalType: "operator",
    tool: "retention.apply_offer",
    policyVersion: "toolhive-demo-v1",
    policyHash: "sha256:abc123",
    decision: "allow",
    reasonCode: "cedar_allowed",
    backendInvoked: true,
    durationMs: 12,
    argumentKeys: "approval_id,call_id,discount_percent,idempotency_key,offer_id,operatorApproved,token",
    argumentHash: event.detail.argumentHash,
    discountPercent: 10,
  });
  assert.equal(typeof event.detail.argumentHash, "string");
  assert.equal(String(event.detail.argumentHash).length, 64);
  assert.doesNotMatch(JSON.stringify(event), /approval-secret|idem-secret|bearer-secret/);
});

test("tool policy decision event distinguishes fail-closed gateway errors without backend execution", () => {
  const event = buildToolPolicyDecisionEvent({
    requestId: "tool-request-timeout",
    callId: "call-456",
    gatewayMode: "toolhive",
    principalType: "voice_agent",
    tool: "retention.apply_offer",
    policyVersion: null,
    policyHash: null,
    decision: "error",
    reasonCode: "toolhive_timeout",
    backendInvoked: false,
    durationMs: -1,
    timestamp: "2026-08-14T05:41:00.000Z",
  });

  assert.equal(event.detail.decision, "error");
  assert.equal(event.detail.reasonCode, "toolhive_timeout");
  assert.equal(event.detail.backendInvoked, false);
  assert.equal(event.detail.durationMs, 0);
  assert.equal(event.detail.argumentHash, null);
});
