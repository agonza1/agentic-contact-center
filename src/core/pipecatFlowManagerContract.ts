import type { FlowState } from "./types";
import { SCRIPTED_CALLER_TURNS } from "./pipecatFlowPrototype";

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

export function buildPipecatFlowManagerContractPayload() {
  return {
    status: "parity_harness_defined_implementation_pending",
    sidecarFree: true,
    implementationEntryPoint: "scripts/acc_pipecat_voice_pipeline.py",
    parityHarnessCommand: "npm run pipecat:flows:contract",
    currentOwner: "ACC TypeScript flow",
    targetOwner: "Pipecat Flows/FlowManager",
    requiredNodes: PIPECAT_FLOW_MANAGER_REQUIRED_NODES,
    requiredGuards: PIPECAT_FLOW_MANAGER_REQUIRED_GUARDS,
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
    acceptanceBlockedUntil: "FlowManager nodes execute these transitions instead of the ACC TypeScript deterministic flow.",
  };
}
