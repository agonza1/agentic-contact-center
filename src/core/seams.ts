import type {
  CallSnapshot,
  EventTrailEntry,
  OperatorSteerAction,
  PocConfig,
  TranscriptTurn,
} from "./types";

export interface TelephonyIngress {
  startCall(config: PocConfig): Promise<CallSnapshot>;
  appendCallerTurn(callId: string, turn: TranscriptTurn, config: PocConfig): Promise<CallSnapshot>;
}

export interface FlowEngine {
  getSnapshot(callId: string): Promise<CallSnapshot | null>;
  recordEvent(callId: string, event: EventTrailEntry): Promise<void>;
}

export interface OperatorSteerGateway {
  requestSteer(callId: string, recommendation: OperatorSteerAction): Promise<void>;
}

export interface SessionRecorder {
  createEnvelope(config: PocConfig): Promise<CallSnapshot>;
}

export interface ProofArtifactWriter {
  serialize(callId: string): Promise<string>;
}

export const runtimeSeams = [
  "mocked telephony ingress",
  "flow engine",
  "policy hold and operator steer",
  "session metadata and event trail",
  "proof artifact generation",
] as const;
