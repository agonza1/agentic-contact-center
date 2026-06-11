import {
  applyDeterministicPipecatFlow,
  applyOperatorSteer,
  buildPipecatFlowPrototypeStatus,
  triggerFailClosedFallback,
} from "./pipecatFlowPrototype";
import type {
  CallSnapshot,
  LatencyBudgetStage,
  FallbackMode,
  OperatorSteerAction,
  PocConfig,
  StartCallOptions,
  TranscriptTurn,
} from "./types";

function cloneSnapshot(snapshot: CallSnapshot): CallSnapshot {
  return {
    session: {
      ...snapshot.session,
      openclawSession: { ...snapshot.session.openclawSession },
    },
    scenario: { ...snapshot.scenario },
    demoFallback: { ...snapshot.demoFallback },
    operatorSteer: { ...snapshot.operatorSteer },
    pipecatFlow: {
      ...snapshot.pipecatFlow,
      toolCoverage: [...snapshot.pipecatFlow.toolCoverage],
      script: {
        ...snapshot.pipecatFlow.script,
        expectedCallerTurns: [...snapshot.pipecatFlow.script.expectedCallerTurns],
      },
    },
    flowState: snapshot.flowState,
    transcript: snapshot.transcript.map((turn) => ({ ...turn })),
    events: snapshot.events.map((event) => ({ ...event, detail: { ...event.detail } })),
    latencyBudgetsMs: { ...snapshot.latencyBudgetsMs },
    latencyMarks: snapshot.latencyMarks.map((mark) => ({ ...mark })),
  };
}

function recordLatencyMark(
  snapshot: CallSnapshot,
  stage: string,
  recordedAt: string,
  budgetStage?: LatencyBudgetStage,
): void {
  const startedAt = new Date(snapshot.session.startedAt).getTime();
  const recordedAtMs = new Date(recordedAt).getTime();
  const elapsedMs = Math.max(0, recordedAtMs - startedAt);

  snapshot.latencyMarks.push({
    stage,
    recordedAt,
    elapsedMs,
    budgetMs: budgetStage ? snapshot.latencyBudgetsMs[budgetStage] : null,
  });
}

export class InMemoryTelephonyIngress {
  private readonly calls = new Map<string, CallSnapshot>();

  private nextCallSequence = 1;

  async startCall(config: PocConfig, options: StartCallOptions = {}): Promise<CallSnapshot> {
    const sequence = this.nextCallSequence;
    this.nextCallSequence += 1;

    const paddedSequence = String(sequence).padStart(4, "0");
    const callId = `demo-call-${paddedSequence}`;
    const providerCallId = `${config.provider.callId}-${paddedSequence}`;
    const startedAt = new Date().toISOString();
    const openclawSessionId = options.openclawSessionId ?? `openclaw-call-${paddedSequence}`;
    const openclawSessionLabel = options.openclawSessionLabel ?? `${config.demoName}:${callId}`;

    const snapshot: CallSnapshot = {
      session: {
        callId,
        demoName: config.demoName,
        providerName: config.provider.name,
        providerCallId,
        startedAt,
        openclawSession: {
          sessionId: openclawSessionId,
          label: openclawSessionLabel,
          status: "attached_mock",
          eventTrailVersion: 1,
        },
      },
      scenario: {
        name: config.demoName,
        mode: config.mode,
        policyProfile: config.policy.profile,
        defaultSupervisorSteer: config.policy.defaultSupervisorSteer,
        fallbackMode: config.policy.fallbackMode,
        operatorChannel: config.operator.channel,
      },
      demoFallback: {
        armed: false,
        reason: null,
        mode: null,
        armedAt: null,
        disarmedAt: null,
        source: null,
      },
      operatorSteer: {
        pending: false,
        lastAction: null,
        lastReason: null,
        requestedAt: null,
        respondedAt: null,
        source: null,
      },
      pipecatFlow: buildPipecatFlowPrototypeStatus(),
      flowState: "call_started",
      transcript: [],
      events: [
        {
          type: "call_bootstrapped",
          at: startedAt,
          detail: {
            providerCallId,
            mode: config.mode,
          },
        },
        {
          type: "openclaw_session_attached",
          at: startedAt,
          detail: {
            sessionId: openclawSessionId,
            sessionLabel: openclawSessionLabel,
            status: "attached_mock",
          },
        },
      ],
      latencyBudgetsMs: { ...config.latencyBudgetsMs },
      latencyMarks: [],
    };

    recordLatencyMark(snapshot, "call_bootstrapped", startedAt);
    this.calls.set(callId, snapshot);
    return cloneSnapshot(snapshot);
  }

  async appendCallerTurn(callId: string, turn: TranscriptTurn, config: PocConfig): Promise<CallSnapshot> {
    const snapshot = this.calls.get(callId);

    if (!snapshot) {
      throw new Error(`Unknown call id: ${callId}`);
    }

    snapshot.transcript.push({ ...turn });
    snapshot.events.push({
      type: "caller_turn_appended",
      at: turn.timestamp,
      detail: {
        speaker: turn.speaker,
        text: turn.text,
        transcriptLength: snapshot.transcript.length,
      },
    });
    recordLatencyMark(snapshot, "caller_turn_received", turn.timestamp, "asrPartial");

    applyDeterministicPipecatFlow(snapshot, config, turn);

    if (snapshot.flowState === "policy_hold") {
      recordLatencyMark(snapshot, "policy_hold_entered", turn.timestamp, "policyGate");
    }

    if (snapshot.flowState === "operator_steer" || snapshot.flowState === "steered_response") {
      recordLatencyMark(snapshot, "operator_notified", turn.timestamp, "operatorNotification");
    }

    if (snapshot.transcript.at(-1)?.speaker === "agent") {
      recordLatencyMark(snapshot, "agent_response_ready", turn.timestamp, "ttsFirstAudio");
    }

    return cloneSnapshot(snapshot);
  }

  async triggerFallback(
    callId: string,
    mode: FallbackMode,
    timestamp: string,
    reason?: string,
  ): Promise<CallSnapshot> {
    const snapshot = this.calls.get(callId);

    if (!snapshot) {
      throw new Error(`Unknown call id: ${callId}`);
    }

    triggerFailClosedFallback(snapshot, mode, timestamp, reason);
    recordLatencyMark(snapshot, "policy_hold_entered", timestamp, "policyGate");
    recordLatencyMark(snapshot, "operator_notified", timestamp, "operatorNotification");
    recordLatencyMark(snapshot, "agent_response_ready", timestamp, "ttsFirstAudio");

    return cloneSnapshot(snapshot);
  }

  async applyOperatorSteer(
    callId: string,
    action: OperatorSteerAction,
    timestamp: string,
    reason?: string,
  ): Promise<CallSnapshot> {
    const snapshot = this.calls.get(callId);

    if (!snapshot) {
      throw new Error(`Unknown call id: ${callId}`);
    }

    const requiresPendingState = action === "approve_offer" || action === "escalate_to_human" || action === "resume";
    if (requiresPendingState && snapshot.flowState !== "policy_hold" && snapshot.flowState !== "operator_steer") {
      throw new Error(`Call is not awaiting operator steer: ${callId}`);
    }

    applyOperatorSteer(snapshot, action, timestamp, reason);
    recordLatencyMark(snapshot, "operator_notified", timestamp, "operatorNotification");
    recordLatencyMark(snapshot, "agent_response_ready", timestamp, "ttsFirstAudio");

    return cloneSnapshot(snapshot);
  }

  async getSnapshot(callId: string): Promise<CallSnapshot | null> {
    const snapshot = this.calls.get(callId);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }
}
