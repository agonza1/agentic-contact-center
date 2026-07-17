import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { loadPocConfig } from "../src/config/loadPocConfig";
import {
  buildPipecatFlowManagerContractPayload,
  PIPECAT_FLOW_MANAGER_NODE_SPECS,
  PIPECAT_FLOW_MANAGER_REQUIRED_GUARDS,
  PIPECAT_FLOW_MANAGER_REQUIRED_NODES,
} from "../src/core/pipecatFlowManagerContract";
import { buildPipecatFlowManagerRuntimePlan } from "../src/core/pipecatFlowManagerRuntimePlan";
import { includesUnsafeClaim, replayPipecatFlowManagerParityFixtures } from "../src/core/pipecatFlowManagerParity";

test("Pipecat FlowManager adapter owns guarded runtime transitions and fails closed", () => {
  const payload = JSON.parse(execFileSync("python3", [
    "test/fixtures/pipecat_flowmanager_adapter_regression.py",
  ], { encoding: "utf8" }));

  assert.equal(payload.ok, true);
  assert.equal(payload.runtimeAdapter, "pipecat_flows.FlowManager");
  assert.deepEqual(payload.requiredVersions, {
    "pipecat-ai": "1.4.0",
    "pipecat-ai-flows": "1.4.0",
  });
  assert.deepEqual(payload.normalTransitionTrace.map((step: any) => step.to), [
    "greet",
    "diagnose",
    "diagnose",
    "wrap",
  ]);
  assert.equal(payload.unsafeEvidence.commitPolicy, "terminal_handoff");
  assert.equal(payload.missingRuntimeEvidence.error, "flowmanager_runtime_failed_closed");
  assert.equal(Object.values(payload.checks).every(Boolean), true);
});

test("Pipecat FlowManager contract records required nodes and fail-closed guards", () => {
  const contract = buildPipecatFlowManagerContractPayload();

  assert.equal(contract.status, "runtime_adapter_wired");
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
  assert.equal(contract.runtimePlan.status, "runtime_adapter_wired");
  assert.equal(contract.runtimePlan.adapterCutoverPending, false);
  assert.equal(contract.runtimePlan.runtimePackageRequirement, "pipecat-ai-flows==1.4.0");
  assert.equal(contract.runtimeHarnessCommand, "npm run pipecat:flows:runtime");
  assert.deepEqual(
    contract.adapterCutoverPreconditions.map((precondition) => [precondition.id, precondition.satisfied]),
    [
      ["node_handlers_mirrored", true],
      ["fail_closed_guards_locked", true],
      ["caller_turn_adapter_cutover", true],
    ],
  );
  assert.deepEqual(contract.adapterCutoverPreconditions, contract.runtimePlan.cutoverPreconditions);
  assert.deepEqual(
    contract.runtimePlan.cutoverSequence.map((step) => [step.id, step.status]),
    [
      ["mirror_node_handlers", "complete"],
      ["lock_fail_closed_parity", "complete"],
      ["route_caller_turns_through_flowmanager", "complete"],
    ],
  );
  assert.equal(contract.runtimePlan.nextPendingCutoverStep, null);
  assert.equal(contract.runtimePlan.cutoverSequence.at(-1)?.blocker, undefined);
  assert.equal(contract.acceptanceBlockedUntil, null);
  assert.deepEqual(
    contract.runtimePlan.adapterInvocations.map((invocation) => [
      invocation.id,
      invocation.source,
      invocation.target,
      invocation.commitPolicy,
      invocation.failClosedFallback,
    ]),
    [
      [
        "caller_transcript_to_flowmanager_node",
        "acc_pipecat_voice_pipeline",
        "pipecat_flows.FlowManager",
        "preview_until_output_delivery_ack",
        "wrap",
      ],
      [
        "runtime_failure_to_flowmanager_wrap",
        "acc_pipecat_voice_pipeline",
        "pipecat_flows.FlowManager",
        "terminal_handoff",
        "wrap",
      ],
    ],
  );
  assert.deepEqual(contract.runtimePlan.missingRequiredNodes, []);
  assert.deepEqual(contract.runtimePlan.validation, {
    ok: true,
    missingRequiredNodes: [],
    duplicateNodeHandlers: [],
    transitionsToUnknownNodes: [],
    guardIdsOnDuplicateTransitions: [],
    guardsOnUnknownTransitions: [],
    nonFailClosedGuardIds: [],
  });
  assert.deepEqual(
    contract.runtimePlan.nodeHandlers.map((handler) => handler.node),
    contract.requiredNodes,
  );
  assert.deepEqual(contract.runtimePlan.retainedAccOwnership, contract.retainedAccOwnership);
  assert.equal(contract.retainedAccOwnership.includes("operator_controls"), true);
  assert.equal(contract.parityChecks.find((check) => check.id === "scripted_policy_hold")?.requiredState, "policy_hold");
  assert.equal(contract.parityChecks.find((check) => check.id === "operator_steer_handoff")?.requiredState, "operator_steer");
  assert.equal(contract.parityChecks.find((check) => check.id === "operator_denial_safe_response")?.requiredState, "steered_response");
  assert.equal(contract.parityChecks.find((check) => check.id === "operator_approval_safe_response")?.requiredState, "steered_response");
  assert.equal(contract.parityChecks.find((check) => check.id === "runtime_failure_fail_closed")?.requiredState, "wrap");
  assert.deepEqual(
    contract.parityFixtures.map((fixture) => fixture.id),
    [
      "scripted_policy_hold",
      "operator_steer_handoff",
      "operator_denial_safe_response",
      "operator_approval_safe_response",
      "runtime_failure_fail_closed",
    ],
  );
  assert.deepEqual(contract.parityFixtures[0].callerTurns, [
    "I'm thinking about canceling my policy.",
    "My renewal went up a lot, and I can't afford it.",
  ]);
  assert.equal(contract.parityFixtures[0].expectedState, "policy_hold");
  assert.deepEqual(contract.parityFixtures[1].expectedEvents, ["operator_steer_requested"]);
  assert.equal(contract.parityFixtures[2].operatorAction, "deny_offer");
  assert.deepEqual(contract.parityFixtures[2].expectedEvents, ["operator_steer_requested", "operator_steer_applied", "operator_offer_denied"]);
  assert.equal(contract.parityFixtures[3].operatorAction, "approve_offer");
  assert.deepEqual(contract.parityFixtures[3].expectedEvents, ["operator_steer_requested", "operator_steer_applied"]);
  assert.deepEqual(contract.parityFixtures[3].requiredAgentClaims, ["retention specialist follow-up"]);
  assert.equal(contract.parityFixtures[4].injectedFailure, "pipecat_runtime_failure");
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

test("Pipecat FlowManager runtime plan mirrors node handlers and guarded transitions", () => {
  const runtimePlan = buildPipecatFlowManagerRuntimePlan({
    requiredNodes: PIPECAT_FLOW_MANAGER_REQUIRED_NODES,
    nodeSpecs: PIPECAT_FLOW_MANAGER_NODE_SPECS,
    requiredGuards: PIPECAT_FLOW_MANAGER_REQUIRED_GUARDS,
  });

  assert.equal(runtimePlan.runtimeAdapter, "pipecat_flows.FlowManager");
  assert.equal(runtimePlan.adapterCutoverPending, false);
  assert.deepEqual(runtimePlan.missingRequiredNodes, []);
  assert.deepEqual(
    runtimePlan.nodeHandlers.map((handler) => [handler.node, handler.allowedTransitions]),
    [
      ["call_started", ["call_started", "greet", "diagnose", "wrap"]],
      ["greet", ["greet", "diagnose", "wrap"]],
      ["diagnose", ["diagnose", "policy_hold", "wrap"]],
      ["policy_hold", ["policy_hold", "operator_steer", "wrap"]],
      ["operator_steer", ["operator_steer", "steered_response", "wrap"]],
      ["steered_response", ["steered_response", "wrap"]],
      ["wrap", ["wrap"]],
    ],
  );
  assert.deepEqual(
    runtimePlan.guardedTransitions.map((guard) => [guard.id, guard.sourceNode, guard.targetNode, guard.failClosed]),
    [
      ["policy_hold_before_retention_offer", "diagnose", "policy_hold", true],
      ["operator_steer_required_for_safe_offer", "policy_hold", "operator_steer", true],
      ["fallback_escalates_to_wrap", "policy_hold", "wrap", true],
    ],
  );
  assert.deepEqual(runtimePlan.nodeHandlers.find((handler) => handler.node === "diagnose")?.guardIds, [
    "policy_hold_before_retention_offer",
  ]);
  assert.deepEqual(runtimePlan.nodeHandlers.find((handler) => handler.node === "policy_hold")?.guardIds, [
    "operator_steer_required_for_safe_offer",
    "fallback_escalates_to_wrap",
  ]);
  assert.equal(runtimePlan.nodeHandlers.find((handler) => handler.node === "operator_steer")?.accStateInputs.includes("operator_controls"), true);
  assert.deepEqual(
    runtimePlan.cutoverPreconditions.map((precondition) => precondition.id),
    ["node_handlers_mirrored", "fail_closed_guards_locked", "caller_turn_adapter_cutover"],
  );
  assert.deepEqual(
    runtimePlan.cutoverSequence.map((step) => step.verificationCommand),
    ["npm run pipecat:flows:contract", "npm run pipecat:flows:contract", "npm run pipecat:flows:runtime"],
  );
  assert.equal(runtimePlan.cutoverSequence.at(-1)?.owner, "Pipecat FlowManager adapter");
  assert.equal(runtimePlan.nextPendingCutoverStep, null);
  assert.equal(runtimePlan.cutoverPreconditions.filter((precondition) => precondition.satisfied).length, 3);
  assert.equal(runtimePlan.cutoverPreconditions.at(-1)?.verificationCommand, "npm run pipecat:flows:runtime");
  assert.deepEqual(
    runtimePlan.adapterInvocations.map((invocation) => [invocation.id, invocation.inputFrame, invocation.handlerResult]),
    [
      [
        "caller_transcript_to_flowmanager_node",
        "TranscriptionFrame",
        "ACC caller-turn preview with flowState, agentText, events, and snapshotVersion",
      ],
      [
        "runtime_failure_to_flowmanager_wrap",
        "FlowManager initialization or transition failure",
        "ACC runtime_failure fallback with terminal wrap/handoff evidence",
      ],
    ],
  );
  assert.deepEqual(
    runtimePlan.adapterInvocations.map((invocation) => invocation.failClosedFallback),
    ["wrap", "wrap"],
  );
  assert.deepEqual(runtimePlan.validation, {
    ok: true,
    missingRequiredNodes: [],
    duplicateNodeHandlers: [],
    transitionsToUnknownNodes: [],
    guardIdsOnDuplicateTransitions: [],
    guardsOnUnknownTransitions: [],
    nonFailClosedGuardIds: [],
  });
});

test("Pipecat FlowManager runtime plan validation flags duplicate ownership", () => {
  const runtimePlan = buildPipecatFlowManagerRuntimePlan({
    requiredNodes: PIPECAT_FLOW_MANAGER_REQUIRED_NODES,
    nodeSpecs: [
      ...PIPECAT_FLOW_MANAGER_NODE_SPECS,
      PIPECAT_FLOW_MANAGER_NODE_SPECS[0],
    ],
    requiredGuards: [
      ...PIPECAT_FLOW_MANAGER_REQUIRED_GUARDS,
      {
        ...PIPECAT_FLOW_MANAGER_REQUIRED_GUARDS[0],
        id: "duplicate_policy_hold_guard",
      },
    ],
  });

  assert.equal(runtimePlan.validation.ok, false);
  assert.deepEqual(runtimePlan.validation.duplicateNodeHandlers, ["call_started"]);
  assert.deepEqual(runtimePlan.validation.guardIdsOnDuplicateTransitions, ["duplicate_policy_hold_guard"]);
});

test("Pipecat FlowManager parity fixtures replay against the current ACC flow", async () => {
  const replays = await replayPipecatFlowManagerParityFixtures(loadPocConfig());

  assert.deepEqual(
    replays.map((replay) => [replay.fixtureId, replay.actualState]),
    [
      ["scripted_policy_hold", "policy_hold"],
      ["operator_steer_handoff", "operator_steer"],
      ["operator_denial_safe_response", "steered_response"],
      ["operator_approval_safe_response", "steered_response"],
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
      "flowmanager-parity:operator_denial_safe_response",
      "flowmanager-parity:operator_approval_safe_response",
      "flowmanager-parity:runtime_failure_fail_closed",
    ],
  );
  assert.equal(replays.every((replay) => replay.missingExpectedEvents.length === 0), true);
  assert.equal(replays.every((replay) => replay.expectedEventsInOrder), true);
  assert.equal(replays.every((replay) => replay.missingRequiredAgentClaims.length === 0), true);
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
        fixtureId: "operator_denial_safe_response",
        traceStates: ["call_started", "diagnose", "policy_hold", "operator_steer", "steered_response"],
        finalTraceEvent: "agent_turn_appended",
      },
      {
        fixtureId: "operator_approval_safe_response",
        traceStates: ["call_started", "diagnose", "policy_hold", "operator_steer", "steered_response"],
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
    includesUnsafeClaim("I am promising a BILLING CREDIT if you stay.", "billing credit"),
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
    includesUnsafeClaim("I CANNOT discuss a Billing Credit without operator approval.", "billing credit"),
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
