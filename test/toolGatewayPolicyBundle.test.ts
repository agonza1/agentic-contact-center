import test from "node:test";
import assert from "node:assert/strict";

import { summarizeToolHivePolicyBundle } from "../src/core/toolGatewayPolicyBundle";

test("ToolHive policy bundle pins Cedar enforcement for the ACC tool manifest", () => {
  const summary = summarizeToolHivePolicyBundle();

  assert.equal(summary.policyVersion, "toolhive-demo-v1");
  assert.equal(summary.toolhiveVersion, "v0.40.0");
  assert.equal(summary.failClosedWebhook, true);
  assert.equal(summary.agentApplyOfferForbidden, true);
  assert.equal(summary.operatorDiscountPercentMax, 10);
  assert.equal(summary.manifestMatchesToolExposure, true);
});
