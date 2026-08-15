import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { summarizeToolHivePolicyBundle } from "../src/core/toolGatewayPolicyBundle";

test("ToolHive policy bundle pins Cedar enforcement for the ACC tool manifest", () => {
  const summary = summarizeToolHivePolicyBundle();

  assert.equal(summary.policyVersion, "toolhive-demo-v1");
  assert.match(summary.policyHash, /^[a-f0-9]{64}$/);
  assert.equal(summary.toolhiveVersion, "v0.40.0");
  assert.equal(summary.failClosedWebhook, true);
  assert.equal(summary.validatingWebhookFailurePolicy, "fail");
  assert.equal(summary.agentApplyOfferForbidden, true);
  assert.equal(summary.operatorDiscountPercentMax, 10);
  assert.equal(summary.manifestMatchesToolExposure, true);
  assert.equal(summary.ready, true);
  assert.deepEqual(summary.blockers, []);
});

test("ToolHive policy bundle reports fail-closed blockers when manifest drifts", () => {
  const bundleDir = mkdtempSync(path.join(tmpdir(), "acc-toolhive-bundle-"));
  writeFileSync(path.join(bundleDir, "authorization.cedar"), `
permit (
  principal,
  action == Action::"retention.apply_offer",
  resource
)
when {
  principal.type == "operator"
};
`);
  writeFileSync(path.join(bundleDir, "manifest.json"), JSON.stringify({
    policyVersion: "toolhive-demo-v1",
    toolhiveVersion: "v0.40.0",
    policyFile: "authorization.cedar",
    webhook: { failurePolicy: "ignore" },
    principals: {
      voice_agent: {
        allowedTools: ["retention.lookup_options", "retention.apply_offer"],
        forbiddenTools: [],
      },
      operator: {
        allowedTools: ["retention.lookup_options", "operator.request_approval", "retention.apply_offer"],
      },
    },
    retentionBoundary: { discountPercentMax: 25 },
  }));

  const summary = summarizeToolHivePolicyBundle(bundleDir);

  assert.equal(summary.ready, false);
  assert.deepEqual(summary.blockers, [
    "toolhive_webhook_not_fail_closed",
    "voice_agent_apply_offer_not_forbidden",
    "retention_discount_boundary_mismatch",
    "toolhive_manifest_tool_exposure_mismatch",
  ]);
});
