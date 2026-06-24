export type FlowState =
  | "call_started"
  | "greet"
  | "diagnose"
  | "policy_hold"
  | "operator_steer"
  | "steered_response"
  | "wrap";

export type Speaker = "caller" | "agent" | "operator" | "system";

export type OperatorSteerAction =
  | "approve_offer"
  | "deny_offer"
  | "escalate_to_human"
  | "transfer"
  | "takeover"
  | "end_call"
  | "pause"
  | "resume"
  | "goto_slide"
  | "ask_operator"
  | "arm_fallback"
  | "disarm_fallback";

export type FallbackMode = "tool_timeout";

export type AttentionSource = "operator_steer" | "fallback" | "operator_steer+fallback";

export interface TranscriptTurn {
  speaker: Speaker;
  text: string;
  timestamp: string;
}

export interface LatencyBudgetsMs {
  asrPartial: number;
  policyGate: number;
  operatorNotification: number;
  ttsFirstAudio: number;
}

export type LatencyBudgetStage = keyof LatencyBudgetsMs;

export interface LatencyMark {
  stage: string;
  recordedAt: string;
  elapsedMs: number;
  budgetMs: number | null;
}

export interface ScriptProgress {
  name: string;
  expectedCallerTurns: string[];
  matchedCallerTurns: number;
  completed: boolean;
}

export interface PipecatFlowPrototypeStatus {
  ready: boolean;
  prototypeMode: "pipecat_local_runtime" | "deterministic_templates";
  transport: "local_process" | "adapter_ready";
  runtimeEngine: "pipecat-ai" | "deterministic_templates";
  credentialsMode: "mocked";
  activeTool: string | null;
  toolCoverage: string[];
  script: ScriptProgress;
}

export interface PocConfig {
  demoName: string;
  mode: "mocked_telephony";
  provider: {
    name: string;
    callId: string;
  };
  policy: {
    profile: string;
    toolScope: string;
    defaultSupervisorSteer: OperatorSteerAction;
    fallbackMode: FallbackMode;
  };
  operator: {
    channel: string;
  };
  latencyBudgetsMs: LatencyBudgetsMs;
}

export interface StartCallOptions {
  providerCallId?: string;
  openclawSessionId?: string;
  openclawSessionLabel?: string;
  simulateOpenClawAttachFailure?: boolean;
}

export interface OpenClawSessionEnvelope {
  sessionId: string;
  label: string;
  status: "attached_mock" | "attach_failed_mock";
  attachError: string | null;
  eventTrailVersion: number;
  artifactLinks: {
    snapshot: string;
    artifacts: string;
    proof: string;
    transcript: string;
    events: string;
    latencyMarks: string;
  };
}

export interface SessionMetadata {
  callId: string;
  demoName: string;
  providerName: string;
  providerCallId: string;
  startedAt: string;
  openclawSession: OpenClawSessionEnvelope;
}

export interface ScenarioMetadata {
  name: string;
  mode: PocConfig["mode"];
  policyProfile: string;
  defaultSupervisorSteer: OperatorSteerAction;
  fallbackMode: FallbackMode;
  operatorChannel: string;
}

export interface DemoFallbackState {
  armed: boolean;
  reason: string | null;
  mode: FallbackMode | null;
  armedAt: string | null;
  disarmedAt: string | null;
  source: "mock_http_route" | null;
}

export interface OperatorSteerState {
  pending: boolean;
  lastAction: OperatorSteerAction | null;
  lastReason: string | null;
  requestedAt: string | null;
  respondedAt: string | null;
  source: "mock_http_route" | null;
}

export interface EventTrailEntry {
  type: string;
  at: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface CallSnapshot {
  session: SessionMetadata;
  scenario: ScenarioMetadata;
  demoFallback: DemoFallbackState;
  operatorSteer: OperatorSteerState;
  pipecatFlow: PipecatFlowPrototypeStatus;
  flowState: FlowState;
  transcript: TranscriptTurn[];
  events: EventTrailEntry[];
  latencyBudgetsMs: LatencyBudgetsMs;
  latencyMarks: LatencyMark[];
}
