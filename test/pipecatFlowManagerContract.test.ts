import test from "node:test";
import assert from "node:assert/strict";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildPipecatFlowManagerContractPayload } from "../src/core/pipecatFlowManagerContract";
import { includesUnsafeClaim, replayPipecatFlowManagerParityFixtures } from "../src/core/pipecatFlowManagerParity";

test("Pipecat FlowManager contract records required nodes and fail-closed guards", () => {
  const contract = buildPipecatFlowManagerContractPayload();

  assert.equal(contract.status, "parity_harness_defined_implementation_pending");
  assert.equal(contract.sidecarFree, true);
  assert.equal(contract.parityHarnessCommand, "npm run pipecat:flows:contract");
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
  assert.deepEqual(
    contract.nodeSpecs.map((spec) => spec.node),
    contract.requiredNodes,
  );
  assert.equal(
    contract.nodeSpecs.find((spec) => spec.node === "policy_hold")?.handlerIntent,
    "pause automated response before unapproved offer language and request approved next action",
  );
  assert.deepEqual(
    contract.nodeSpecs.find((spec) => spec.node === "policy_hold")?.emitsEvents,
    ["flow_state_transition", "policy_hold_entered", "agent_turn_appended"],
  );
  assert.equal(contract.nodeSpecs.find((spec) => spec.node === "operator_steer")?.requiresAccState.includes("operator_controls"), true);
  assert.equal(contract.nodeSpecs.find((spec) => spec.node === "wrap")?.emitsEvents.includes("human_handoff_started"), true);
  assert.equal(contract.requiredGuards.every((guard) => guard.failClosed), true);
  assert.equal(contract.retainedAccOwnership.includes("operator_controls"), true);
  assert.equal(contract.parityChecks.find((check) => check.id === "scripted_policy_hold")?.requiredState, "policy_hold");
  assert.equal(contract.parityChecks.find((check) => check.id === "operator_steer_handoff")?.requiredState, "operator_steer");
  assert.equal(contract.parityChecks.find((check) => check.id === "runtime_failure_fail_closed")?.requiredState, "wrap");
  assert.deepEqual(
    contract.parityFixtures.map((fixture) => fixture.id),
    ["scripted_policy_hold", "operator_steer_handoff", "runtime_failure_fail_closed"],
  );
  assert.deepEqual(contract.parityFixtures[0].callerTurns, [
    "I'm thinking about canceling my policy.",
    "My renewal went up a lot, and I can't afford it.",
  ]);
  assert.equal(contract.parityFixtures[0].expectedState, "policy_hold");
  assert.deepEqual(contract.parityFixtures[1].expectedEvents, ["operator_steer_requested"]);
  assert.equal(contract.parityFixtures[2].injectedFailure, "pipecat_runtime_failure");
  assert.equal(contract.parityFixtures.every((fixture) => fixture.forbiddenAgentClaims.includes("billing credit")), true);

  const parityFixturesById = new Map<string, (typeof contract.parityFixtures)[number]>(
    contract.parityFixtures.map((fixture) => [fixture.id, fixture]),
  );
  for (const parityCheck of contract.parityChecks) {
    const fixture = parityFixturesById.get(parityCheck.id);
    assert.ok(fixture);
    assert.equal(fixture.expectedState, parityCheck.requiredState);
    assert.deepEqual(fixture.expectedEvents, parityCheck.requiredEvents);
  }
});

test("Pipecat FlowManager parity fixtures replay against the current ACC flow", async () => {
  const replays = await replayPipecatFlowManagerParityFixtures(loadPocConfig());

  assert.deepEqual(
    replays.map((replay) => [replay.fixtureId, replay.actualState]),
    [
      ["scripted_policy_hold", "policy_hold"],
      ["operator_steer_handoff", "operator_steer"],
      ["runtime_failure_fail_closed", "wrap"],
    ],
  );
  assert.equal(replays.every((replay) => replay.passed), true);
  assert.equal(replays.every((replay) => replay.callId.startsWith("demo-call-")), true);
  assert.deepEqual(
    replays.map((replay) => replay.openclawSessionLabel),
    [
      "flowmanager-parity:scripted_policy_hold",
      "flowmanager-parity:operator_steer_handoff",
      "flowmanager-parity:runtime_failure_fail_closed",
    ],
  );
  assert.equal(replays.every((replay) => replay.missingExpectedEvents.length === 0), true);
  assert.equal(replays.every((replay) => replay.forbiddenAgentClaimsFound.length === 0), true);
  assert.deepEqual(
    replays.map((replay) => ({
      fixtureId: replay.fixtureId,
      traceStates: replay.transitionTrace.map((step) => step.flowState),
      finalTraceEvent: replay.transitionTrace.at(-1)?.latestEventType,
    })),
    [
      {
        fixtureId: "scripted_policy_hold",
        traceStates: ["call_started", "diagnose", "policy_hold"],
        finalTraceEvent: "agent_turn_appended",
      },
      {
        fixtureId: "operator_steer_handoff",
        traceStates: ["call_started", "diagnose", "policy_hold", "operator_steer"],
        finalTraceEvent: "agent_turn_appended",
      },
      {
        fixtureId: "runtime_failure_fail_closed",
        traceStates: ["call_started", "wrap"],
        finalTraceEvent: "flow_state_transition",
      },
    ],
  );
});

test("Pipecat FlowManager forbidden-claim detection only suppresses explicit negations", () => {
  assert.equal(
    includesUnsafeClaim("I am promising any billing credit if you stay.", "billing credit"),
    true,
  );
  assert.equal(
    includesUnsafeClaim("I can promise any billing credit after this call.", "billing credit"),
    true,
  );
  assert.equal(
    includesUnsafeClaim("I will not promise any billing credit on this call.", "billing credit"),
    false,
  );
  assert.equal(
    includesUnsafeClaim("I can review safe next steps without promising any billing credit.", "billing credit"),
    false,
  );
  assert.equal(
    includesUnsafeClaim("I cannot discuss a billing credit without operator approval.", "billing credit"),
    false,
  );
});
