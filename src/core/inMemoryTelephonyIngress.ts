import {
  applyFreeCallerPipecatFlow,
  applyDeterministicPipecatFlow,
  applyOperatorSteer,
  buildPipecatFlowPrototypeStatus,
  triggerFailClosedFallback,
} from "./pipecatFlowPrototype";
import { compareTimestamps, getAttentionMetadata } from "./attention";
import type {
  AttentionSource,
  CallSnapshot,
  FlowState,
  LatencyMark,
  LatencyBudgetStage,
  FallbackMode,
  OperatorSteerAction,
  PocConfig,
  RuntimeModeLabels,
  StartCallOptions,
  TranscriptTurn,
} from "./types";

function cloneSnapshot(snapshot: CallSnapshot): CallSnapshot {
  return {
    session: {
      ...snapshot.session,
      openclawSession: {
        ...snapshot.session.openclawSession,
        artifactLinks: { ...snapshot.session.openclawSession.artifactLinks },
      },
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


function buildOpenClawArtifactLinks(callId: string) {
  const basePath = `/api/calls/${callId}`;

  return {
    snapshot: basePath,
    artifacts: `${basePath}/artifacts`,
    proof: `${basePath}/proof`,
    transcript: `${basePath}/transcript`,
    events: `${basePath}/events`,
    latencyMarks: `${basePath}/latency`,
  };
}

function buildRuntimeModeLabels(config: PocConfig, options: StartCallOptions): RuntimeModeLabels {
  const telephony = options.runtimeModeLabels?.telephony ?? config.mode;
  return {
    telephony,
    media: options.runtimeModeLabels?.media ?? (telephony === "mocked_telephony" ? "generated_media" : "live_capture"),
    rtcAsr: options.runtimeModeLabels?.rtcAsr ?? (telephony === "mocked_telephony" ? "rtc_asr_replay" : "rtc_asr_blocked"),
    credentialsMode:
      options.runtimeModeLabels?.credentialsMode ?? (telephony === "signalwire_live" ? "signalwire_live" : "mocked"),
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

function latencyMarkMatchesFilters(
  mark: LatencyMark,
  filters: { latencyStage?: string; latencyOverBudget?: boolean },
): boolean {
  if (filters.latencyStage !== undefined && mark.stage !== filters.latencyStage) {
    return false;
  }

  if (filters.latencyOverBudget === undefined) {
    return true;
  }

  const isOverBudget = mark.budgetMs !== null && mark.elapsedMs > mark.budgetMs;
  return isOverBudget === filters.latencyOverBudget;
}

function getScriptProgressPct(snapshot: CallSnapshot): number {
  const totalTurns = snapshot.pipecatFlow.script.expectedCallerTurns.length;
  if (totalTurns === 0) {
    return snapshot.pipecatFlow.script.completed ? 100 : 0;
  }

  return Math.round((snapshot.pipecatFlow.script.matchedCallerTurns / totalTurns) * 100);
}

export class InMemoryTelephonyIngress {
  private readonly calls = new Map<string, CallSnapshot>();

  private nextCallSequence = 1;

  async startCall(config: PocConfig, options: StartCallOptions = {}): Promise<CallSnapshot> {
    const sequence = this.nextCallSequence;
    this.nextCallSequence += 1;

    const paddedSequence = String(sequence).padStart(4, "0");
    const callId = `demo-call-${paddedSequence}`;
    const providerName = options.providerName ?? config.provider.name;
    const runtimeModeLabels = buildRuntimeModeLabels(config, options);
    const providerCallId = options.providerCallId ?? `${config.provider.callId}-${paddedSequence}`;
    const startedAt = new Date().toISOString();
    const openclawSessionId = options.openclawSessionId ?? `openclaw-call-${paddedSequence}`;
    const openclawSessionLabel = options.openclawSessionLabel ?? `${config.demoName}:${callId}`;
    const openclawAttachFailed = options.simulateOpenClawAttachFailure === true;

    const snapshot: CallSnapshot = {
      session: {
        callId,
        demoName: config.demoName,
        providerName,
        providerCallId,
        startedAt,
        runtimeModeLabels,
        openclawSession: {
          sessionId: openclawSessionId,
          label: openclawSessionLabel,
          status: openclawAttachFailed ? "attach_failed_mock" : runtimeModeLabels.telephony === "mocked_telephony" ? "attached_mock" : "attached_live",
          attachError: openclawAttachFailed ? "simulated_openclaw_session_attach_failure" : null,
          eventTrailVersion: 1,
          artifactLinks: buildOpenClawArtifactLinks(callId),
        },
      },
      scenario: {
        name: config.demoName,
        mode: runtimeModeLabels.telephony,
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
            mode: runtimeModeLabels.telephony,
            mediaMode: runtimeModeLabels.media,
            rtcAsrMode: runtimeModeLabels.rtcAsr,
            pipecatRuntimeMode: "pipecat_local_runtime",
            credentialsMode: runtimeModeLabels.credentialsMode,
            ingressSource: options.source ?? "mock_http_route",
          },
        },
        {
          type: "pipecat_runtime_started",
          at: startedAt,
          detail: {
            runtimeEngine: "pipecat-ai",
            transport: "local_process",
            credentialsMode: runtimeModeLabels.credentialsMode,
            telephonyMode: runtimeModeLabels.telephony,
            mediaMode: runtimeModeLabels.media,
            rtcAsrMode: runtimeModeLabels.rtcAsr,
          },
        },
        {
          type: openclawAttachFailed ? "openclaw_session_attach_failed" : "openclaw_session_attached",
          at: startedAt,
          detail: {
            sessionId: openclawSessionId,
            sessionLabel: openclawSessionLabel,
            status: openclawAttachFailed ? "attach_failed_mock" : runtimeModeLabels.telephony === "mocked_telephony" ? "attached_mock" : "attached_live",
            attachError: openclawAttachFailed ? "simulated_openclaw_session_attach_failure" : null,
            proofPath: `/api/calls/${callId}/proof`,
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

  async appendCallerTurn(
    callId: string,
    turn: TranscriptTurn,
    config: PocConfig,
    options: { conversationMode?: "scripted" | "free_caller" } = {},
  ): Promise<CallSnapshot> {
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

    snapshot.events.push({
      type: "pipecat_runtime_turn_processed",
      at: turn.timestamp,
      detail: {
        runtimeEngine: snapshot.pipecatFlow.runtimeEngine,
        runtimeMode: snapshot.pipecatFlow.prototypeMode,
        transport: snapshot.pipecatFlow.transport,
        credentialsMode: snapshot.pipecatFlow.credentialsMode,
      },
    });

    const conversationMode =
      options.conversationMode ?? (snapshot.session.openclawSession.label === "pipecat-local-voice" ? "free_caller" : "scripted");

    if (conversationMode === "free_caller") {
      applyFreeCallerPipecatFlow(snapshot, turn);
    } else {
      applyDeterministicPipecatFlow(snapshot, config, turn);
    }

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

  async recordLiveTelephonyEvidence(
    callId: string,
    evidence: {
      eventType: "media_capture_attached" | "rtc_asr_transcript" | "rtc_asr_blocked" | "sip_call_ended";
      timestamp?: string;
      detail?: Record<string, string | number | boolean | null>;
    },
  ): Promise<CallSnapshot> {
    const snapshot = this.calls.get(callId);

    if (!snapshot) {
      throw new Error(`Unknown call id: ${callId}`);
    }

    const recordedAt = evidence.timestamp ?? new Date().toISOString();
    snapshot.events.push({
      type: evidence.eventType,
      at: recordedAt,
      detail: {
        telephonyMode: snapshot.session.runtimeModeLabels.telephony,
        mediaMode: snapshot.session.runtimeModeLabels.media,
        rtcAsrMode: snapshot.session.runtimeModeLabels.rtcAsr,
        ...evidence.detail,
      },
    });
    recordLatencyMark(snapshot, evidence.eventType, recordedAt);

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
    audit: { sourceRoute?: string; confirmationAcknowledged?: boolean | null } = {},
  ): Promise<CallSnapshot> {
    const snapshot = this.calls.get(callId);

    if (!snapshot) {
      throw new Error(`Unknown call id: ${callId}`);
    }

    const requiresPendingState =
      action === "approve_offer" || action === "deny_offer" || action === "escalate_to_human" || action === "resume";
    if (requiresPendingState && snapshot.flowState !== "policy_hold" && snapshot.flowState !== "operator_steer") {
      throw new Error(`Call is not awaiting operator steer: ${callId}`);
    }

    applyOperatorSteer(snapshot, action, timestamp, reason, audit);
    recordLatencyMark(snapshot, "operator_notified", timestamp, "operatorNotification");
    recordLatencyMark(snapshot, "agent_response_ready", timestamp, "ttsFirstAudio");

    return cloneSnapshot(snapshot);
  }

  async recordOperatorNote(callId: string, text: string, timestamp: string, disposition?: string): Promise<CallSnapshot> {
    const snapshot = this.calls.get(callId);

    if (!snapshot) {
      throw new Error(`Unknown call id: ${callId}`);
    }

    snapshot.transcript.push({
      speaker: "operator",
      text,
      timestamp,
    });
    snapshot.events.push({
      type: "operator_note_recorded",
      at: timestamp,
      detail: {
        text,
        disposition: disposition ?? null,
        source: "mock_http_route",
        transcriptLength: snapshot.transcript.length,
      },
    });

    return cloneSnapshot(snapshot);
  }

  async getSnapshot(callId: string): Promise<CallSnapshot | null> {
    const snapshot = this.calls.get(callId);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }

  async listSnapshots(filters: {
    flowState?: FlowState;
    pipecatActiveTool?: string;
    pendingOperatorSteer?: boolean;
    fallbackArmed?: boolean;
    fallbackMode?: FallbackMode;
    fallbackReason?: string;
    fallbackSource?: string;
    attentionRequired?: boolean;
    attentionSource?: AttentionSource;
    attentionReason?: string;
    openclawSessionId?: string;
    openclawSessionLabel?: string;
    openclawSessionRef?: string;
    callId?: string;
    providerCallId?: string;
    transcriptText?: string;
    scriptCompleted?: boolean;
    minScriptProgressPct?: number;
    maxScriptProgressPct?: number;
    minAttentionAgeMs?: number;
    maxAttentionAgeMs?: number;
    latencyStage?: string;
    latencyOverBudget?: boolean;
  } = {}): Promise<CallSnapshot[]> {
    return this.getSnapshots(filters).map((snapshot) => cloneSnapshot(snapshot));
  }

  private getSnapshots(filters: {
    flowState?: FlowState;
    pipecatActiveTool?: string;
    pendingOperatorSteer?: boolean;
    fallbackArmed?: boolean;
    fallbackMode?: FallbackMode;
    fallbackReason?: string;
    fallbackSource?: string;
    attentionRequired?: boolean;
    attentionSource?: AttentionSource;
    attentionReason?: string;
    openclawSessionId?: string;
    openclawSessionLabel?: string;
    openclawSessionRef?: string;
    callId?: string;
    providerCallId?: string;
    transcriptText?: string;
    scriptCompleted?: boolean;
    minScriptProgressPct?: number;
    maxScriptProgressPct?: number;
    minAttentionAgeMs?: number;
    maxAttentionAgeMs?: number;
    latencyStage?: string;
    latencyOverBudget?: boolean;
  } = {}): CallSnapshot[] {
    return [...this.calls.values()]
      .filter((snapshot) => (filters.flowState ? snapshot.flowState === filters.flowState : true))
      .filter((snapshot) =>
        filters.pipecatActiveTool === undefined ? true : snapshot.pipecatFlow.activeTool === filters.pipecatActiveTool,
      )
      .filter((snapshot) =>
        filters.pendingOperatorSteer === undefined ? true : snapshot.operatorSteer.pending === filters.pendingOperatorSteer,
      )
      .filter((snapshot) =>
        filters.fallbackArmed === undefined ? true : snapshot.demoFallback.armed === filters.fallbackArmed,
      )
      .filter((snapshot) =>
        filters.fallbackMode === undefined ? true : snapshot.demoFallback.mode === filters.fallbackMode,
      )
      .filter((snapshot) =>
        filters.fallbackReason === undefined ? true : snapshot.demoFallback.reason === filters.fallbackReason,
      )
      .filter((snapshot) => {
        if (filters.fallbackSource === undefined) {
          return true;
        }

        return snapshot.events.some(
          (event) => event.type === "human_handoff_started" && event.detail.source === filters.fallbackSource,
        );
      })
      .filter((snapshot) => {
        if (filters.attentionRequired === undefined) {
          return true;
        }

        const attentionRequired = snapshot.operatorSteer.pending || snapshot.demoFallback.armed;
        return attentionRequired === filters.attentionRequired;
      })
      .filter((snapshot) => {
        if (filters.attentionSource === undefined) {
          return true;
        }

        const attentionSource =
          snapshot.operatorSteer.pending && snapshot.demoFallback.armed
            ? "operator_steer+fallback"
            : snapshot.demoFallback.armed
              ? "fallback"
              : snapshot.operatorSteer.pending
                ? "operator_steer"
                : null;

        return attentionSource === filters.attentionSource;
      })
      .filter((snapshot) => {
        if (filters.attentionReason === undefined) {
          return true;
        }

        return getAttentionMetadata(snapshot).reason === filters.attentionReason;
      })
      .filter((snapshot) => (filters.callId === undefined ? true : snapshot.session.callId === filters.callId))
      .filter((snapshot) => {
        if (filters.minAttentionAgeMs === undefined) {
          return true;
        }

        const attentionAgeMs = getAttentionMetadata(snapshot).ageMs;
        return attentionAgeMs !== null && attentionAgeMs >= filters.minAttentionAgeMs;
      })
      .filter((snapshot) => {
        if (filters.maxAttentionAgeMs === undefined) {
          return true;
        }

        const attentionAgeMs = getAttentionMetadata(snapshot).ageMs;
        return attentionAgeMs !== null && attentionAgeMs <= filters.maxAttentionAgeMs;
      })
      .filter((snapshot) =>
        filters.providerCallId === undefined ? true : snapshot.session.providerCallId === filters.providerCallId,
      )
      .filter((snapshot) => {
        if (filters.transcriptText === undefined) {
          return true;
        }

        const normalizedText = filters.transcriptText.toLocaleLowerCase();
        return snapshot.transcript.some((turn) => turn.text.toLocaleLowerCase().includes(normalizedText));
      })
      .filter((snapshot) =>
        filters.scriptCompleted === undefined ? true : snapshot.pipecatFlow.script.completed === filters.scriptCompleted,
      )
      .filter((snapshot) => {
        if (filters.minScriptProgressPct === undefined) {
          return true;
        }

        return getScriptProgressPct(snapshot) >= filters.minScriptProgressPct;
      })
      .filter((snapshot) => {
        if (filters.maxScriptProgressPct === undefined) {
          return true;
        }

        return getScriptProgressPct(snapshot) <= filters.maxScriptProgressPct;
      })
      .filter((snapshot) => snapshot.latencyMarks.some((mark) => latencyMarkMatchesFilters(mark, filters)))
      .filter((snapshot) =>
        filters.openclawSessionId === undefined
          ? true
          : snapshot.session.openclawSession.sessionId === filters.openclawSessionId,
      )
      .filter((snapshot) =>
        filters.openclawSessionLabel === undefined
          ? true
          : snapshot.session.openclawSession.label === filters.openclawSessionLabel,
      )
      .filter((snapshot) => {
        if (filters.openclawSessionRef === undefined) {
          return true;
        }

        return (
          snapshot.session.openclawSession.sessionId === filters.openclawSessionRef ||
          snapshot.session.openclawSession.label === filters.openclawSessionRef
        );
      })
      .sort((left, right) => left.session.startedAt.localeCompare(right.session.startedAt));
  }

  async getQueueSummary(filters: {
    flowState?: FlowState;
    pipecatActiveTool?: string;
    pendingOperatorSteer?: boolean;
    fallbackArmed?: boolean;
    fallbackMode?: FallbackMode;
    fallbackReason?: string;
    fallbackSource?: string;
    attentionRequired?: boolean;
    attentionSource?: AttentionSource;
    attentionReason?: string;
    openclawSessionId?: string;
    openclawSessionLabel?: string;
    openclawSessionRef?: string;
    callId?: string;
    providerCallId?: string;
    transcriptText?: string;
    scriptCompleted?: boolean;
    minScriptProgressPct?: number;
    maxScriptProgressPct?: number;
    minAttentionAgeMs?: number;
    maxAttentionAgeMs?: number;
    latencyStage?: string;
    latencyOverBudget?: boolean;
  } = {}): Promise<{
    totalCalls: number;
    pendingOperatorSteer: number;
    fallbackArmed: number;
    attentionRequired: number;
    scriptCompleted: number;
    scriptInProgress: number;
    oldestAttentionCallId: string | null;
    oldestAttentionProviderCallId: string | null;
    oldestAttentionOpenclawSessionId: string | null;
    oldestAttentionOpenclawSessionLabel: string | null;
    oldestAttentionAgeMs: number | null;
    oldestAttentionStartedAt: string | null;
    oldestAttentionFlowState: FlowState | null;
    oldestAttentionReason: string | null;
    oldestAttentionSource: AttentionSource | null;
    byFlowState: Record<FlowState, number>;
  }> {
    const byFlowState: Record<FlowState, number> = {
      call_started: 0,
      greet: 0,
      diagnose: 0,
      policy_hold: 0,
      operator_steer: 0,
      steered_response: 0,
      wrap: 0,
    };

    let pendingOperatorSteer = 0;
    let fallbackArmed = 0;
    let attentionRequired = 0;
    let scriptCompleted = 0;
    let scriptInProgress = 0;
    let oldestAttentionCallId: string | null = null;
    let oldestAttentionProviderCallId: string | null = null;
    let oldestAttentionOpenclawSessionId: string | null = null;
    let oldestAttentionOpenclawSessionLabel: string | null = null;
    let oldestAttentionAgeMs: number | null = null;
    let oldestAttentionStartedAt: string | null = null;
    let oldestAttentionFlowState: FlowState | null = null;
    let oldestAttentionReason: string | null = null;
    let oldestAttentionSource: AttentionSource | null = null;

    const snapshots = this.getSnapshots(filters);

    for (const snapshot of snapshots) {
      const attention = getAttentionMetadata(snapshot);

      byFlowState[snapshot.flowState] += 1;

      if (snapshot.operatorSteer.pending) {
        pendingOperatorSteer += 1;
      }

      if (snapshot.demoFallback.armed) {
        fallbackArmed += 1;
      }

      if (attention.required) {
        attentionRequired += 1;

        if (
          oldestAttentionStartedAt === null ||
          (attention.startedAt !== null && compareTimestamps(attention.startedAt, oldestAttentionStartedAt) < 0)
        ) {
          oldestAttentionCallId = snapshot.session.callId;
          oldestAttentionProviderCallId = snapshot.session.providerCallId;
          oldestAttentionOpenclawSessionId = snapshot.session.openclawSession.sessionId;
          oldestAttentionOpenclawSessionLabel = snapshot.session.openclawSession.label;
          oldestAttentionAgeMs = attention.ageMs;
          oldestAttentionStartedAt = attention.startedAt;
          oldestAttentionFlowState = snapshot.flowState;
          oldestAttentionReason = attention.reason;
          oldestAttentionSource = attention.source;
        }
      }

      if (snapshot.pipecatFlow.script.completed) {
        scriptCompleted += 1;
      } else {
        scriptInProgress += 1;
      }
    }

    return {
      totalCalls: snapshots.length,
      pendingOperatorSteer,
      fallbackArmed,
      attentionRequired,
      scriptCompleted,
      scriptInProgress,
      oldestAttentionCallId,
      oldestAttentionProviderCallId,
      oldestAttentionOpenclawSessionId,
      oldestAttentionOpenclawSessionLabel,
      oldestAttentionAgeMs,
      oldestAttentionStartedAt,
      oldestAttentionFlowState,
      oldestAttentionReason,
      oldestAttentionSource,
      byFlowState,
    };
  }
}
