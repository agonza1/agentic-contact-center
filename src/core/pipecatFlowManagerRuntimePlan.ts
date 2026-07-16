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

export interface PipecatFlowManagerRuntimePlanValidation {
  ok: boolean;
  missingRequiredNodes: FlowState[];
  transitionsToUnknownNodes: Array<{ sourceNode: FlowState; targetNode: FlowState }>;
  guardsOnUnknownTransitions: string[];
  nonFailClosedGuardIds: string[];
}

interface PipecatFlowManagerCutoverStep {
  id: string;
  status: "complete" | "pending";
  owner: string;
  evidence: string;
  verificationCommand: string;
  blocker?: string;
}

const FLOW_MANAGER_CUTOVER_SEQUENCE: readonly PipecatFlowManagerCutoverStep[] = [
  {
    id: "mirror_node_handlers",
    status: "complete",
    owner: "ACC TypeScript contract",
    evidence: "Required cancellation-rescue nodes are mirrored as FlowManager handler specs.",
    verificationCommand: "npm run pipecat:flows:contract",
  },
  {
    id: "lock_fail_closed_parity",
    status: "complete",
    owner: "ACC parity harness",
    evidence: "Policy hold, operator steer, denial, approval, and runtime failure fixtures replay safely.",
    verificationCommand: "npm run pipecat:flows:contract",
  },
  {
    id: "route_caller_turns_through_flowmanager",
    status: "pending",
    owner: "Pipecat FlowManager adapter",
    evidence: "Caller-turn runtime must invoke pipecat_flows.FlowManager node handlers before #222 can be accepted.",
    verificationCommand: "npm test",
    blocker: "typescript_deterministic_flow_still_owns_runtime_turns",
  },
] as const;

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

export function validatePipecatFlowManagerRuntimePlan(input: {
  requiredNodes: readonly FlowState[];
  nodeHandlers: readonly PipecatFlowManagerNodeHandlerPlan[];
  requiredGuards: readonly PipecatFlowManagerGuardSpec[];
}): PipecatFlowManagerRuntimePlanValidation {
  const implementedNodes = new Set(input.nodeHandlers.map((handler) => handler.node));
  const requiredNodeSet = new Set(input.requiredNodes);
  const missingRequiredNodes = input.requiredNodes.filter((node) => !implementedNodes.has(node));
  const transitionsToUnknownNodes = input.nodeHandlers.flatMap((handler) =>
    handler.allowedTransitions
      .filter((targetNode) => !requiredNodeSet.has(targetNode))
      .map((targetNode) => ({ sourceNode: handler.node, targetNode })),
  );
  const guardsOnUnknownTransitions = input.requiredGuards
    .filter((guard) => {
      const sourceHandler = input.nodeHandlers.find((handler) => handler.node === guard.sourceNode);
      return !sourceHandler || !sourceHandler.allowedTransitions.includes(guard.targetNode);
    })
    .map((guard) => guard.id);
  const nonFailClosedGuardIds = input.requiredGuards.filter((guard) => !guard.failClosed).map((guard) => guard.id);

  return {
    ok: missingRequiredNodes.length === 0
      && transitionsToUnknownNodes.length === 0
      && guardsOnUnknownTransitions.length === 0
      && nonFailClosedGuardIds.length === 0,
    missingRequiredNodes,
    transitionsToUnknownNodes,
    guardsOnUnknownTransitions,
    nonFailClosedGuardIds,
  };
}

export function buildPipecatFlowManagerRuntimePlan(input: {
  requiredNodes: readonly FlowState[];
  nodeSpecs: readonly PipecatFlowManagerNodeSpec[];
  requiredGuards: readonly PipecatFlowManagerGuardSpec[];
}) {
  const nodeHandlers = buildPipecatFlowManagerNodeHandlerPlan(input.nodeSpecs, input.requiredGuards);
  const validation = validatePipecatFlowManagerRuntimePlan({
    requiredNodes: input.requiredNodes,
    nodeHandlers,
    requiredGuards: input.requiredGuards,
  });

  return {
    status: "node_handlers_mirrored_adapter_cutover_pending",
    runtimeAdapter: "pipecat_flows.FlowManager",
    adapterCutoverPending: true,
    implementationEntryPoint: "scripts/acc_pipecat_voice_pipeline.py",
    retainedAccOwnership: ["product_state", "operator_controls", "proof_artifacts", "queue_state"],
    nodeHandlers,
    cutoverSequence: FLOW_MANAGER_CUTOVER_SEQUENCE,
    cutoverPreconditions: FLOW_MANAGER_CUTOVER_PRECONDITIONS,
    validation,
    missingRequiredNodes: validation.missingRequiredNodes,
    guardedTransitions: input.requiredGuards.map((guard) => ({
      id: guard.id,
      sourceNode: guard.sourceNode,
      targetNode: guard.targetNode,
      failClosed: guard.failClosed,
    })),
  };
}
