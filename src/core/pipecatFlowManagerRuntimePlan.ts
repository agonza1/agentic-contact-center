import type { FlowState } from "./types";

interface PipecatFlowManagerNodeSpec {
  node: FlowState;
  owns: string;
  handlerIntent: string;
  emitsEvents: readonly string[];
  requiresAccState: readonly string[];
}

interface PipecatFlowManagerGuardSpec {
  id: string;
  sourceNode: FlowState;
  targetNode: FlowState;
  failClosed: boolean;
}

export interface PipecatFlowManagerNodeHandlerPlan {
  node: FlowState;
  owns: string;
  handlerIntent: string;
  emitsEvents: string[];
  accStateInputs: string[];
  allowedTransitions: FlowState[];
  guardIds: string[];
}

const FLOW_MANAGER_CUTOVER_PRECONDITIONS = [
  {
    id: "node_handlers_mirrored",
    evidence: "All required cancellation-rescue nodes are represented in the FlowManager handler plan.",
    verificationCommand: "npm run pipecat:flows:contract",
    satisfied: true,
  },
  {
    id: "fail_closed_guards_locked",
    evidence: "Policy hold, operator steer, and fallback transitions have fail-closed guard coverage.",
    verificationCommand: "npm run pipecat:flows:contract",
    satisfied: true,
  },
  {
    id: "caller_turn_adapter_cutover",
    evidence: "ACC caller turns are routed through pipecat_flows.FlowManager while ACC retains product state, operator controls, proof artifacts, and queue state.",
    verificationCommand: "npm test",
    satisfied: false,
  },
] as const;

const FLOW_MANAGER_TRANSITIONS: Readonly<Record<FlowState, readonly FlowState[]>> = {
  call_started: ["greet", "diagnose", "wrap"],
  greet: ["diagnose", "wrap"],
  diagnose: ["policy_hold", "wrap"],
  policy_hold: ["operator_steer", "wrap"],
  operator_steer: ["steered_response", "wrap"],
  steered_response: ["wrap"],
  wrap: [],
};

function guardIdsForTransition(
  sourceNode: FlowState,
  targetNode: FlowState,
  requiredGuards: readonly PipecatFlowManagerGuardSpec[],
): string[] {
  return requiredGuards.filter(
    (guard) => guard.sourceNode === sourceNode && guard.targetNode === targetNode,
  ).map((guard) => guard.id);
}

export function buildPipecatFlowManagerNodeHandlerPlan(
  nodeSpecs: readonly PipecatFlowManagerNodeSpec[],
  requiredGuards: readonly PipecatFlowManagerGuardSpec[],
): PipecatFlowManagerNodeHandlerPlan[] {
  return nodeSpecs.map((spec) => ({
    node: spec.node,
    owns: spec.owns,
    handlerIntent: spec.handlerIntent,
    emitsEvents: [...spec.emitsEvents],
    accStateInputs: [...spec.requiresAccState],
    allowedTransitions: [...FLOW_MANAGER_TRANSITIONS[spec.node]],
    guardIds: FLOW_MANAGER_TRANSITIONS[spec.node].flatMap((targetNode) =>
      guardIdsForTransition(spec.node, targetNode, requiredGuards),
    ),
  }));
}

export function buildPipecatFlowManagerRuntimePlan(input: {
  requiredNodes: readonly FlowState[];
  nodeSpecs: readonly PipecatFlowManagerNodeSpec[];
  requiredGuards: readonly PipecatFlowManagerGuardSpec[];
}) {
  const nodeHandlers = buildPipecatFlowManagerNodeHandlerPlan(input.nodeSpecs, input.requiredGuards);

  return {
    status: "node_handlers_mirrored_adapter_cutover_pending",
    runtimeAdapter: "pipecat_flows.FlowManager",
    adapterCutoverPending: true,
    implementationEntryPoint: "scripts/acc_pipecat_voice_pipeline.py",
    retainedAccOwnership: ["product_state", "operator_controls", "proof_artifacts", "queue_state"],
    nodeHandlers,
    cutoverPreconditions: FLOW_MANAGER_CUTOVER_PRECONDITIONS,
    missingRequiredNodes: input.requiredNodes.filter(
      (node) => !nodeHandlers.some((handler) => handler.node === node),
    ),
    guardedTransitions: input.requiredGuards.map((guard) => ({
      id: guard.id,
      sourceNode: guard.sourceNode,
      targetNode: guard.targetNode,
      failClosed: guard.failClosed,
    })),
  };
}
