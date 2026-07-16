import test from "node:test";
import assert from "node:assert/strict";

import { buildPipecatFlowManagerContractPayload } from "../src/core/pipecatFlowManagerContract";

test("Pipecat FlowManager contract records required nodes and fail-closed guards", () => {
  const contract = buildPipecatFlowManagerContractPayload();

  assert.equal(contract.status, "contract_defined_implementation_pending");
  assert.equal(contract.sidecarFree, true);
  assert.deepEqual(contract.requiredNodes, [
    "call_started",
    "greet",
    "diagnose",
    "policy_hold",
    "operator_steer",
    "steered_response",
    "wrap",
  ]);
  assert.deepEqual(
    contract.requiredGuards.map((guard) => guard.id),
    [
      "policy_hold_before_retention_offer",
      "operator_steer_required_for_safe_offer",
      "fallback_escalates_to_wrap",
    ],
  );
  assert.equal(contract.requiredGuards.every((guard) => guard.failClosed), true);
  assert.equal(contract.retainedAccOwnership.includes("operator_controls"), true);
  assert.equal(contract.parityChecks.find((check) => check.id === "scripted_policy_hold")?.requiredState, "policy_hold");
  assert.equal(contract.parityChecks.find((check) => check.id === "operator_steer_handoff")?.requiredState, "operator_steer");
  assert.equal(contract.parityChecks.find((check) => check.id === "runtime_failure_fail_closed")?.requiredState, "wrap");
});
