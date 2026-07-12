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
        artifactRefs: snapshot.session.openclawSession.artifactRefs.map((artifact) => ({ ...artifact })),
        evidenceSummary: { ...snapshot.session.openclawSession.evidenceSummary },
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

function buildOpenClawSessionRef(sessionId: string): string {
  return `openclaw://sessions/${encodeURIComponent(sessionId)}`;
}

function buildOpenClawArtifactRefs(
  links: ReturnType<typeof buildOpenClawArtifactLinks>,
  attachStatus: "attached" | "degraded",
) {
  return [
    { artifactId: "call-snapshot", kind: "snapshot" as const, href: links.snapshot, attachStatus },
    { artifactId: "artifact-manifest", kind: "manifest" as const, href: links.artifacts, attachStatus },
    { artifactId: "qa-proof-bundle", kind: "proof" as const, href: links.proof, attachStatus },
    { artifactId: "transcript", kind: "transcript" as const, href: links.transcript, attachStatus },
    { artifactId: "event-trail", kind: "events" as const, href: links.events, attachStatus },
    { artifactId: "latency-marks", kind: "latency_marks" as const, href: links.latencyMarks, attachStatus },
    {
      artifactId: "tool-calls",
      kind: "tool_calls" as const,
      href: `${links.events}?detailKey=runtimeEngine`,
      attachStatus,
    },
  ];
}

function refreshOpenClawSessionEvidence(snapshot: CallSnapshot, updatedAt = new Date().toISOString()): void {
  const latestEvent = snapshot.events.at(-1);
  const latestTranscriptTurn = snapshot.transcript.at(-1);
  const operatorActionTypes = new Set([
    "operator_steer_applied",
    "operator_steer_requested",
    "operator_demo_paused",
    "operator_offer_denied",
    "operator_transfer_started",
    "operator_takeover_started",
    "operator_call_ended",
    "operator_note_recorded",
  ]);
  const fallbackEventCount = snapshot.events.filter((event) => event.type.includes("fallback")).length;
  const handoffEventCount = snapshot.events.filter((event) => event.type === "human_handoff_started").length;
  const runtimeToolEvents = snapshot.events.filter((event) =>
    event.type === "pipecat_runtime_started" || event.type === "pipecat_runtime_turn_processed",
  ).length;
  const degraded = snapshot.session.openclawSession.status === "attach_failed_mock";

  snapshot.session.openclawSession.evidenceSummary = {
    mode: snapshot.session.runtimeModeLabels.telephony === "mocked_telephony" ? "local_mock_only" : "local_reference_only",
    streamStatus: degraded ? "degraded" : "attached",
    transcriptTurns: snapshot.transcript.length,
    eventCount: snapshot.events.length,
    operatorActionCount: snapshot.events.filter((event) => operatorActionTypes.has(event.type)).length,
    toolCallCount: runtimeToolEvents + (snapshot.pipecatFlow.activeTool ? 1 : 0),
    fallbackEventCount,
    handoffEventCount,
    proofArtifactCount: snapshot.session.openclawSession.artifactRefs.length,
    latestEventType: latestEvent?.type ?? null,
    latestEventAt: latestEvent?.at ?? null,
    latestTranscriptAt: latestTranscriptTurn?.timestamp ?? null,
    updatedAt,
    failureSafe: snapshot.session.openclawSession.artifactRefs.length > 0 && snapshot.events.length > 0,
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
    const openclawAttachStatus = openclawAttachFailed ? "degraded" : "attached";
    const openclawArtifactLinks = buildOpenClawArtifactLinks(callId);
    const openclawSessionRef = buildOpenClawSessionRef(openclawSessionId);

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
          ref: openclawSessionRef,
          status: openclawAttachFailed ? "attach_failed_mock" : runtimeModeLabels.telephony === "mocked_telephony" ? "attached_mock" : "attached_live",
          attachError: openclawAttachFailed ? "simulated_openclaw_session_attach_failure" : null,
          eventTrailVersion: 1,
          artifactLinks: openclawArtifactLinks,
          artifactRefs: buildOpenClawArtifactRefs(openclawArtifactLinks, openclawAttachStatus),
          evidenceSummary: {
            mode: runtimeModeLabels.telephony === "mocked_telephony" ? "local_mock_only" : "local_reference_only",
            streamStatus: openclawAttachFailed ? "degraded" : "attached",
            transcriptTurns: 0,
            eventCount: 0,
            operatorActionCount: 0,
            toolCallCount: 0,
            fallbackEventCount: 0,
            handoffEventCount: 0,
            proofArtifactCount: 0,
            latestEventType: null,
            latestEventAt: null,
            latestTranscriptAt: null,
            updatedAt: startedAt,
            failureSafe: false,
          },
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
            sessionRef: openclawSessionRef,
            status: openclawAttachFailed ? "attach_failed_mock" : runtimeModeLabels.telephony === "mocked_telephony" ? "attached_mock" : "attached_live",
            attachError: openclawAttachFailed ? "simulated_openclaw_session_attach_failure" : null,
            attachmentMode: runtimeModeLabels.telephony === "mocked_telephony" ? "local_mock_only" : "local_reference_only",
            externalSideEffects: false,
            evidencePreserved: true,
            artifactManifestPath: openclawArtifactLinks.artifacts,
            transcriptPath: openclawArtifactLinks.transcript,
            eventsPath: openclawArtifactLinks.events,
            proofPath: openclawArtifactLinks.proof,
          },
        },
      ],
      latencyBudgetsMs: { ...config.latencyBudgetsMs },
      latencyMarks: [],
    };

    recordLatencyMark(snapshot, "call_bootstrapped", startedAt);
    refreshOpenClawSessionEvidence(snapshot, startedAt);
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
        activeTool: snapshot.pipecatFlow.activeTool,
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

    refreshOpenClawSessionEvidence(snapshot, turn.timestamp);
    return cloneSnapshot(snapshot);
  }

  async recordLiveTelephonyEvidence(
    callId: string,
    evidence: {
      eventType: "media_capture_attached" | "pipecat_rtp_playback_attached" | "rtc_asr_transcript" | "rtc_asr_blocked" | "sip_call_ended";
      timestamp?: string;
      detail?: Record<string, string | number | boolean | null>;
    },
  ): Promise<CallSnapshot> {
    const snapshot = this.calls.get(callId);

    if (!snapshot) {
      throw new Error(`Unknown call id: ${callId}`);
    }

    const recordedAt = evidence.timestamp ?? new Date().toISOString();
    const previousRtcAsrMode = snapshot.session.runtimeModeLabels.rtcAsr;
    if (evidence.eventType === "rtc_asr_transcript") {
      snapshot.session.runtimeModeLabels.rtcAsr = "rtc_asr_live";
    } else if (evidence.eventType === "rtc_asr_blocked") {
      snapshot.session.runtimeModeLabels.rtcAsr = "rtc_asr_blocked";
    }

    snapshot.events.push({
      type: evidence.eventType,
      at: recordedAt,
      detail: {
        telephonyMode: snapshot.session.runtimeModeLabels.telephony,
        mediaMode: snapshot.session.runtimeModeLabels.media,
        rtcAsrMode: snapshot.session.runtimeModeLabels.rtcAsr,
        previousRtcAsrMode,
        ...evidence.detail,
      },
    });
    recordLatencyMark(snapshot, evidence.eventType, recordedAt);

    refreshOpenClawSessionEvidence(snapshot, recordedAt);
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

    refreshOpenClawSessionEvidence(snapshot, timestamp);
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

    refreshOpenClawSessionEvidence(snapshot, timestamp);
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

    refreshOpenClawSessionEvidence(snapshot, timestamp);
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
