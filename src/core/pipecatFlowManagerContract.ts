import type { FlowState } from "./types";

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

export function buildPipecatFlowManagerContractPayload() {
  return {
    status: "contract_defined_implementation_pending",
    sidecarFree: true,
    implementationEntryPoint: "scripts/acc_pipecat_voice_pipeline.py",
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
    acceptanceBlockedUntil: "FlowManager nodes execute these transitions instead of the ACC TypeScript deterministic flow.",
  };
}
