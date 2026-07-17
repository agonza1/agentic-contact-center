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

export interface PipecatFlowManagerAdapterInvocation {
  id: string;
  source: "acc_pipecat_voice_pipeline";
  target: "pipecat_flows.FlowManager";
  inputFrame: string;
  handlerResult: string;
  commitPolicy: "preview_until_output_delivery_ack" | "terminal_handoff";
  failClosedFallback: FlowState;
}

export interface PipecatFlowManagerRuntimePlanValidation {
  ok: boolean;
  missingRequiredNodes: FlowState[];
  duplicateNodeHandlers: FlowState[];
  transitionsToUnknownNodes: Array<{ sourceNode: FlowState; targetNode: FlowState }>;
  guardIdsOnDuplicateTransitions: string[];
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

const FLOW_MANAGER_ADAPTER_INVOCATIONS: readonly PipecatFlowManagerAdapterInvocation[] = [
  {
    id: "caller_transcript_to_flowmanager_node",
    source: "acc_pipecat_voice_pipeline",
    target: "pipecat_flows.FlowManager",
    inputFrame: "TranscriptionFrame",
    handlerResult: "ACC caller-turn preview with flowState, agentText, events, and snapshotVersion",
    commitPolicy: "preview_until_output_delivery_ack",
    failClosedFallback: "wrap",
  },
  {
    id: "operator_control_to_flowmanager_node",
    source: "acc_pipecat_voice_pipeline",
    target: "pipecat_flows.FlowManager",
    inputFrame: "ACC operator control event",
    handlerResult: "bounded steer result for steered_response or wrap",
    commitPolicy: "preview_until_output_delivery_ack",
    failClosedFallback: "wrap",
  },
  {
    id: "runtime_failure_to_flowmanager_wrap",
    source: "acc_pipecat_voice_pipeline",
    target: "pipecat_flows.FlowManager",
    inputFrame: "Pipeline error or interruption frame",
    handlerResult: "fail-closed wrap/handoff event set",
    commitPolicy: "terminal_handoff",
    failClosedFallback: "wrap",
  },
] as const;

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
  const nodeHandlerCounts = new Map<FlowState, number>();
  for (const handler of input.nodeHandlers) {
    nodeHandlerCounts.set(handler.node, (nodeHandlerCounts.get(handler.node) ?? 0) + 1);
  }
  const duplicateNodeHandlers = Array.from(nodeHandlerCounts)
    .filter(([, count]) => count > 1)
    .map(([node]) => node);
  const transitionsToUnknownNodes = input.nodeHandlers.flatMap((handler) =>
    handler.allowedTransitions
      .filter((targetNode) => !requiredNodeSet.has(targetNode))
      .map((targetNode) => ({ sourceNode: handler.node, targetNode })),
  );
  const guardTransitionKeys = new Set<string>();
  const guardIdsOnDuplicateTransitions = input.requiredGuards
    .filter((guard) => {
      const transitionKey = `${guard.sourceNode}->${guard.targetNode}`;
      if (guardTransitionKeys.has(transitionKey)) {
        return true;
      }
      guardTransitionKeys.add(transitionKey);
      return false;
    })
    .map((guard) => guard.id);
  const guardsOnUnknownTransitions = input.requiredGuards
    .filter((guard) => {
      const sourceHandler = input.nodeHandlers.find((handler) => handler.node === guard.sourceNode);
      return !sourceHandler || !sourceHandler.allowedTransitions.includes(guard.targetNode);
    })
    .map((guard) => guard.id);
  const nonFailClosedGuardIds = input.requiredGuards.filter((guard) => !guard.failClosed).map((guard) => guard.id);

  return {
    ok: missingRequiredNodes.length === 0
      && duplicateNodeHandlers.length === 0
      && transitionsToUnknownNodes.length === 0
      && guardIdsOnDuplicateTransitions.length === 0
      && guardsOnUnknownTransitions.length === 0
      && nonFailClosedGuardIds.length === 0,
    missingRequiredNodes,
    duplicateNodeHandlers,
    transitionsToUnknownNodes,
    guardIdsOnDuplicateTransitions,
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
  const nextPendingCutoverStep = FLOW_MANAGER_CUTOVER_SEQUENCE.find((step) => step.status === "pending") ?? null;

  return {
    status: "node_handlers_mirrored_adapter_cutover_pending",
    runtimeAdapter: "pipecat_flows.FlowManager",
    adapterCutoverPending: true,
    implementationEntryPoint: "scripts/acc_pipecat_voice_pipeline.py",
    retainedAccOwnership: ["product_state", "operator_controls", "proof_artifacts", "queue_state"],
    adapterInvocations: FLOW_MANAGER_ADAPTER_INVOCATIONS,
    nodeHandlers,
    cutoverSequence: FLOW_MANAGER_CUTOVER_SEQUENCE,
    nextPendingCutoverStep,
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
