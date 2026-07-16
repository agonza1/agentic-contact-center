import type { FlowState } from "./types";
import { SCRIPTED_CALLER_TURNS } from "./pipecatFlowPrototype";
import { buildPipecatFlowManagerRuntimePlan } from "./pipecatFlowManagerRuntimePlan";

export const PIPECAT_FLOW_MANAGER_REQUIRED_NODES: FlowState[] = [
  "call_started",
  "greet",
  "diagnose",
  "policy_hold",
  "operator_steer",
  "steered_response",
  "wrap",
];

export const PIPECAT_FLOW_MANAGER_REQUIRED_GUARDS = [
  {
    id: "policy_hold_before_retention_offer",
    sourceNode: "diagnose",
    targetNode: "policy_hold",
    evidenceEvent: "policy_hold_entered",
    failClosed: true,
  },
  {
    id: "operator_steer_required_for_safe_offer",
    sourceNode: "policy_hold",
    targetNode: "operator_steer",
    evidenceEvent: "operator_steer_requested",
    failClosed: true,
  },
  {
    id: "fallback_escalates_to_wrap",
    sourceNode: "policy_hold",
    targetNode: "wrap",
    evidenceEvent: "human_handoff_started",
    failClosed: true,
  },
] as const;

export const PIPECAT_FLOW_MANAGER_NODE_SPECS = [
  {
    node: "call_started",
    owns: "session bootstrap and first user turn handoff",
    handlerIntent: "create FlowManager context from ACC call metadata, then wait for caller audio/transcript",
    emitsEvents: ["flow_state_transition"],
    requiresAccState: ["product_state", "proof_artifacts"],
  },
  {
    node: "greet",
    owns: "first cancellation-rescue acknowledgement",
    handlerIntent: "acknowledge caller intent without offering retention terms",
    emitsEvents: ["flow_state_transition", "agent_turn_appended"],
    requiresAccState: ["proof_artifacts"],
  },
  {
    node: "diagnose",
    owns: "reason collection before any retention discussion",
    handlerIntent: "collect the cancellation reason and classify whether the retention boundary was reached",
    emitsEvents: ["flow_state_transition", "agent_turn_appended"],
    requiresAccState: ["proof_artifacts"],
  },
  {
    node: "policy_hold",
    owns: "fail-closed retention boundary",
    handlerIntent: "pause automated response before unapproved offer language and request approved next action",
    emitsEvents: ["flow_state_transition", "policy_hold_entered", "agent_turn_appended"],
    requiresAccState: ["operator_controls", "proof_artifacts", "queue_state"],
  },
  {
    node: "operator_steer",
    owns: "operator approval wait",
    handlerIntent: "hold response generation until ACC records a bounded operator steer action",
    emitsEvents: ["flow_state_transition", "operator_steer_requested", "agent_turn_appended"],
    requiresAccState: ["operator_controls", "proof_artifacts", "queue_state"],
  },
  {
    node: "steered_response",
    owns: "approved or denied safe response",
    handlerIntent: "speak only the bounded response permitted by ACC operator controls",
    emitsEvents: ["flow_state_transition", "operator_steer_applied", "agent_turn_appended"],
    requiresAccState: ["operator_controls", "proof_artifacts"],
  },
  {
    node: "wrap",
    owns: "safe close or human handoff",
    handlerIntent: "stop automated retention handling and attach wrap/handoff proof",
    emitsEvents: ["flow_state_transition", "human_handoff_started", "agent_turn_appended"],
    requiresAccState: ["product_state", "proof_artifacts", "queue_state"],
  },
] as const satisfies ReadonlyArray<{
  node: FlowState;
  owns: string;
  handlerIntent: string;
  emitsEvents: readonly string[];
  requiresAccState: readonly string[];
}>;

export const PIPECAT_FLOW_MANAGER_PARITY_FIXTURES = [
  {
    id: "scripted_policy_hold",
    callerTurns: SCRIPTED_CALLER_TURNS.slice(0, 2),
    expectedState: "policy_hold",
    expectedEvents: ["policy_hold_entered"],
    forbiddenAgentClaims: ["billing credit", "discount approved", "premium credit"],
  },
  {
    id: "operator_steer_handoff",
    callerTurns: SCRIPTED_CALLER_TURNS.slice(0, 3),
    expectedState: "operator_steer",
    expectedEvents: ["operator_steer_requested"],
    forbiddenAgentClaims: ["billing credit", "discount approved", "premium credit"],
  },
  {
    id: "runtime_failure_fail_closed",
    injectedFailure: "pipecat_runtime_failure",
    expectedState: "wrap",
    expectedEvents: ["demo_fallback_triggered", "human_handoff_started"],
    forbiddenAgentClaims: ["billing credit", "discount approved", "premium credit"],
  },
] as const;

export type PipecatFlowManagerParityFixture = (typeof PIPECAT_FLOW_MANAGER_PARITY_FIXTURES)[number];

export function buildPipecatFlowManagerContractPayload() {
  const runtimePlan = buildPipecatFlowManagerRuntimePlan({
    requiredNodes: PIPECAT_FLOW_MANAGER_REQUIRED_NODES,
    nodeSpecs: PIPECAT_FLOW_MANAGER_NODE_SPECS,
    requiredGuards: PIPECAT_FLOW_MANAGER_REQUIRED_GUARDS,
  });

  return {
    status: runtimePlan.status,
    sidecarFree: true,
    implementationEntryPoint: "scripts/acc_pipecat_voice_pipeline.py",
    parityHarnessCommand: "npm run pipecat:flows:contract",
    currentOwner: "ACC TypeScript flow",
    targetOwner: "Pipecat Flows/FlowManager",
    requiredNodes: PIPECAT_FLOW_MANAGER_REQUIRED_NODES,
    nodeSpecs: PIPECAT_FLOW_MANAGER_NODE_SPECS,
    requiredGuards: PIPECAT_FLOW_MANAGER_REQUIRED_GUARDS,
    runtimePlan,
    retainedAccOwnership: ["product_state", "operator_controls", "proof_artifacts", "queue_state"],
    parityChecks: [
      {
        id: "scripted_policy_hold",
        input: "second seeded caller turn reaches renewal increase boundary",
        requiredState: "policy_hold",
        requiredEvents: ["policy_hold_entered"],
      },
      {
        id: "operator_steer_handoff",
        input: "third seeded caller turn requests safe offer review",
        requiredState: "operator_steer",
        requiredEvents: ["operator_steer_requested"],
      },
      {
        id: "runtime_failure_fail_closed",
        input: "Pipecat runtime failure",
        requiredState: "wrap",
        requiredEvents: ["demo_fallback_triggered", "human_handoff_started"],
      },
    ],
    parityFixtures: PIPECAT_FLOW_MANAGER_PARITY_FIXTURES,
    acceptanceBlockedUntil: "The ACC caller-turn runtime adapter routes these node handlers through Pipecat FlowManager instead of the TypeScript deterministic flow.",
  };
}
