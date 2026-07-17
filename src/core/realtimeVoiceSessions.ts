import { randomUUID } from "node:crypto";

import type { CallSnapshot } from "./types";

export type RealtimeVoiceSessionStatus = "open" | "closing" | "closed";
export type RealtimeVoiceSessionTransport = "persistent_full_duplex";

export interface RealtimeVoiceSessionEvent {
  sequence: number;
  type: string;
  at: string;
  correlationId: string;
  sessionId: string;
  callId: string;
  elapsedMs: number;
  detail: Record<string, string | number | boolean | null>;
}

export interface RealtimeVoiceSession {
  id: string;
  callId: string;
  correlationId: string;
  status: RealtimeVoiceSessionStatus;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  target: string;
  mode: "realtime_audio";
  transport: RealtimeVoiceSessionTransport;
  metadata: Record<string, string>;
  media: {
    inputChunks: number;
    inputBytes: number;
    inputSampleRateHz: number | null;
    inputMimeType: string | null;
    lastInputAt: string | null;
  };
  playback: {
    requestedTurns: number;
    lastRequestedAt: string | null;
    lastAudioBytes: number | null;
    lastAudioMimeType: string | null;
    lastAudioSampleRateHz: number | null;
    lastAudioAssetName: string | null;
  };
  output: {
    streamId: string | null;
    status: "idle" | "streaming" | "completed" | "cancelled";
    chunks: number;
    bytes: number;
    totalChunks: number;
    totalBytes: number;
    mimeType: string | null;
    sampleRateHz: number | null;
    startedAt: string | null;
    lastChunkAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
    cancellationReason: string | null;
    bargeInCancellationObserved: boolean;
  };
  controls: {
    lastAction: string | null;
    lastReason: string | null;
  };
  events: RealtimeVoiceSessionEvent[];
}

export interface RealtimeVoiceSessionSnapshot extends RealtimeVoiceSession {
  endpoints: ReturnType<typeof buildRealtimeVoiceSessionEndpoints>;
  call?: CallSnapshot;
}

type CorrelatedTimelineEntry = {
  sequence: number;
  source: "voice_session" | "call_event" | "call_latency";
  type: string;
  phase: string;
  at: string;
  elapsedMs: number;
  correlationId: string;
  sessionId: string;
  callId: string;
  streamId?: string | null;
  bytes?: number | null;
  status?: string | null;
  artifactPath?: string | null;
};

function cloneSession(session: RealtimeVoiceSession): RealtimeVoiceSession {
  return {
    ...session,
    metadata: { ...session.metadata },
    media: { ...session.media },
    playback: { ...session.playback },
    controls: { ...session.controls },
    events: session.events.map((event) => ({ ...event, detail: { ...event.detail } })),
  };
}

export function buildRealtimeVoiceSessionEndpoints(sessionId: string) {
  const encoded = encodeURIComponent(sessionId);
  return {
    create: "/api/voice/sessions",
    snapshot: `/api/voice/sessions/${encoded}`,
    play: `/api/voice/sessions/${encoded}/play`,
    mediaInput: `/api/voice/sessions/${encoded}/media/input`,
    mediaOutput: `/api/voice/sessions/${encoded}/media/output`,
    events: `/api/voice/sessions/${encoded}/events`,
    control: `/api/voice/sessions/${encoded}/control`,
    close: `/api/voice/sessions/${encoded}/close`,
    proof: `/api/voice/sessions/${encoded}/proof`,
    websocketMediaInput: `/api/voice/sessions/${encoded}/media/input`,
  };
}

function compareIsoTimestamps(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return left.localeCompare(right);
  return leftMs - rightMs;
}

function elapsedFrom(startedAt: string, at: string): number {
  const startedMs = Date.parse(startedAt);
  const atMs = Date.parse(at);
  if (!Number.isFinite(startedMs) || !Number.isFinite(atMs)) return 0;
  return Math.max(0, atMs - startedMs);
}

function eventElapsed(session: RealtimeVoiceSession, at: string): number {
  return elapsedFrom(session.createdAt, at);
}

function diffMs(later: string | null | undefined, earlier: string | null | undefined): number | null {
  if (!later || !earlier) return null;
  const laterMs = Date.parse(later);
  const earlierMs = Date.parse(earlier);
  if (!Number.isFinite(laterMs) || !Number.isFinite(earlierMs)) return null;
  return Math.max(0, laterMs - earlierMs);
}

function voiceSessionPhase(type: string): string {
  if (type === "media.input.received") return "media.ingress";
  if (type === "play.requested") return "transport.playback_request";
  if (type === "output.stream.started") return "tts.playback_started";
  if (type === "output.audio.chunk") return "tts.playback_chunk";
  if (type === "output.stream.completed") return "tts.playback_completed";
  if (type === "output.stream.cancelled") return "barge_in.cancelled";
  if (type === "output.audio.chunk.ignored") return "playback.ignored";
  if (type === "control.received") return "control";
  if (type === "session.created" || type === "session.closed") return "transport.session";
  return "voice_session.event";
}

function callEventPhase(type: string): string {
  if (type === "rtc_asr_transcript") return "stt.final";
  if (type === "rtc_asr_interim") return "stt.interim";
  if (type === "rtc_asr_blocked") return "stt.partial_failure";
  if (type === "media_capture_attached") return "media.capture_artifact";
  if (type === "pipecat_rtp_playback_attached") return "playback.artifact";
  if (type === "caller_turn_appended") return "acc.caller_turn";
  if (type === "pipecat_runtime_turn_processed") return "acc.agent_processing";
  return "call.event";
}

function latencyPhase(stage: string): string {
  if (stage === "agent_response_ready") return "acc.agent_response_ready";
  if (stage === "caller_turn_received") return "stt.final_to_acc";
  if (stage === "rtc_asr_transcript") return "stt.final";
  if (stage === "policy_hold_entered") return "acc.policy_gate";
  return "timing.latency_mark";
}

function artifactPathsFromMetadata(metadata: Record<string, string>): string[] {
  return [
    metadata.recordingPath,
    metadata.callerRecordingPath,
    metadata.agentRecordingPath,
    metadata.mixedRecordingPath,
    metadata.trackRecordingManifestPath,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function buildCorrelationProof(session: RealtimeVoiceSession, call?: CallSnapshot | null) {
  const callEvents = call?.events.filter((event) => compareIsoTimestamps(event.at, session.createdAt) >= 0) ?? [];
  const callLatencyMarks = call?.latencyMarks.filter((mark) => compareIsoTimestamps(mark.recordedAt, session.createdAt) >= 0) ?? [];
  const recordingPaths = artifactPathsFromMetadata(session.metadata);
  const voiceTimeline: CorrelatedTimelineEntry[] = session.events.map((event) => ({
    sequence: event.sequence,
    source: "voice_session",
    type: event.type,
    phase: voiceSessionPhase(event.type),
    at: event.at,
    elapsedMs: event.elapsedMs,
    correlationId: session.correlationId,
    sessionId: session.id,
    callId: session.callId,
    streamId: typeof event.detail.streamId === "string" ? event.detail.streamId : null,
    bytes: typeof event.detail.bytes === "number" ? event.detail.bytes : null,
    status: typeof event.detail.reason === "string" ? event.detail.reason : null,
    artifactPath: typeof event.detail.artifactPath === "string" ? event.detail.artifactPath : null,
  }));
  const callEventTimeline: CorrelatedTimelineEntry[] = callEvents.map((event, index) => ({
    sequence: session.events.length + index + 1,
    source: "call_event",
    type: event.type,
    phase: callEventPhase(event.type),
    at: event.at,
    elapsedMs: eventElapsed(session, event.at),
    correlationId: session.correlationId,
    sessionId: session.id,
    callId: session.callId,
    streamId: typeof event.detail.streamId === "string" ? event.detail.streamId : null,
    bytes: typeof event.detail.audioBytes === "number" ? event.detail.audioBytes : null,
    status: typeof event.detail.error === "string" ? event.detail.error : null,
    artifactPath: typeof event.detail.artifactPath === "string" ? event.detail.artifactPath : null,
  }));
  const latencyTimeline: CorrelatedTimelineEntry[] = callLatencyMarks.map((mark, index) => ({
    sequence: session.events.length + callEvents.length + index + 1,
    source: "call_latency",
    type: mark.stage,
    phase: latencyPhase(mark.stage),
    at: mark.recordedAt,
    elapsedMs: eventElapsed(session, mark.recordedAt),
    correlationId: session.correlationId,
    sessionId: session.id,
    callId: session.callId,
    status: mark.budgetMs !== null && mark.elapsedMs > mark.budgetMs ? "over_budget" : "within_budget",
  }));
  const timeline = [...voiceTimeline, ...callEventTimeline, ...latencyTimeline]
    .sort((left, right) => compareIsoTimestamps(left.at, right.at) || left.sequence - right.sequence)
    .map((entry, index) => ({ ...entry, sequence: index + 1 }));
  const firstInputAt = session.events.find((event) => event.type === "media.input.received")?.at ?? null;
  const firstOutputChunkAt = session.events.find((event) => event.type === "output.audio.chunk")?.at ?? null;
  const bargeInControlAt = session.events.find((event) => event.type === "control.received" && event.detail.action === "barge_in")?.at ?? null;
  const streamCancelledAt = session.events.find((event) => event.type === "output.stream.cancelled")?.at ?? null;
  const sttFinalAt = callEvents.find((event) => event.type === "rtc_asr_transcript")?.at ?? null;
  const agentResponseAt = callLatencyMarks.find((mark) => mark.stage === "agent_response_ready")?.recordedAt ?? null;
  const clockWarnings = [
    ...session.events.filter((event) => compareIsoTimestamps(event.at, session.createdAt) < 0).map((event) => `voice_session_event_before_created:${event.type}`),
    ...(call?.events ?? []).filter((event) => compareIsoTimestamps(event.at, session.createdAt) < 0).map((event) => `call_event_before_voice_session:${event.type}`),
  ];
  const expectedPhases = [
    "media.ingress",
    "stt.final",
    "acc.agent_processing",
    "tts.playback_chunk",
    "barge_in.cancelled",
    "tts.playback_completed",
  ];
  return {
    schemaVersion: 1,
    correlationId: session.correlationId,
    sessionId: session.id,
    callId: session.callId,
    redaction: {
      transcriptTextIncluded: false,
      audioContentIncluded: false,
      audioSha256Allowed: true,
    },
    timeline,
    coverage: Object.fromEntries(expectedPhases.map((phase) => [phase, timeline.some((event) => event.phase === phase)])),
    metrics: {
      endToEndResponseLatencyMs: diffMs(firstOutputChunkAt, firstInputAt),
      interruptionLatencyMs: diffMs(streamCancelledAt, bargeInControlAt),
      sttFinalLatencyMs: diffMs(sttFinalAt, firstInputAt),
      agentResponseLatencyMs: diffMs(agentResponseAt, firstInputAt),
    },
    artifactPaths: {
      sessionEvents: buildRealtimeVoiceSessionEndpoints(session.id).events,
      callEvents: call?.session.openclawSession.artifactLinks.events ?? null,
      callLatencyMarks: call?.session.openclawSession.artifactLinks.latencyMarks ?? null,
      recordings: recordingPaths,
    },
    missingArtifactPaths: recordingPaths.length > 0 ? [] : ["recording_paths_not_attached"],
    clock: {
      source: "server_iso8601_utc",
      warnings: clockWarnings,
    },
  };
}

export class RealtimeVoiceSessionStore {
  private readonly sessions = new Map<string, RealtimeVoiceSession>();

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  create(input: { requestedId?: string; callId: string; target?: string; metadata?: Record<string, string>; createdAt?: string }): RealtimeVoiceSession {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const id = input.requestedId?.trim() || `voice-session-${randomUUID()}`;
    const correlationId = input.metadata?.correlationId?.trim() || `voice-correlation-${randomUUID()}`;
    const session: RealtimeVoiceSession = {
      id,
      callId: input.callId,
      correlationId,
      status: "open",
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
      target: input.target?.trim() || "conversation-agent-evals",
      mode: "realtime_audio",
      transport: "persistent_full_duplex",
      metadata: { ...(input.metadata ?? {}) },
      media: { inputChunks: 0, inputBytes: 0, inputSampleRateHz: null, inputMimeType: null, lastInputAt: null },
      playback: { requestedTurns: 0, lastRequestedAt: null, lastAudioBytes: null, lastAudioMimeType: null, lastAudioSampleRateHz: null, lastAudioAssetName: null },
      output: {
        streamId: null,
        status: "idle",
        chunks: 0,
        bytes: 0,
        totalChunks: 0,
        totalBytes: 0,
        mimeType: null,
        sampleRateHz: null,
        startedAt: null,
        lastChunkAt: null,
        completedAt: null,
        cancelledAt: null,
        cancellationReason: null,
        bargeInCancellationObserved: false,
      },
      controls: { lastAction: null, lastReason: null },
      events: [],
    };
    this.record(session, "session.created", createdAt, { callId: input.callId, target: session.target, correlationId, realtimeAudioOnly: true });
    this.sessions.set(id, session);
    return cloneSession(session);
  }

  get(sessionId: string): RealtimeVoiceSession | null {
    const session = this.sessions.get(sessionId);
    return session ? cloneSession(session) : null;
  }

  recordPlaybackRequest(sessionId: string, input: {
    label?: string;
    audioBytes?: number;
    audioUrl?: string;
    audioMimeType?: string;
    sampleRateHz?: number;
    assetName?: string;
    audioSha256?: string;
    injectedToMediaInput?: boolean;
    silentAudio?: boolean;
    timestamp?: string;
  }): RealtimeVoiceSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "open") return null;
    const at = input.timestamp ?? new Date().toISOString();
    session.playback.requestedTurns += 1;
    session.playback.lastRequestedAt = at;
    session.playback.lastAudioBytes = input.audioBytes ?? null;
    session.playback.lastAudioMimeType = input.audioMimeType ?? null;
    session.playback.lastAudioSampleRateHz = input.sampleRateHz ?? null;
    session.playback.lastAudioAssetName = input.assetName ?? input.label ?? null;
    this.record(session, "play.requested", at, {
      label: input.label ?? null,
      assetName: input.assetName ?? input.label ?? null,
      audioBytes: input.audioBytes ?? null,
      audioMimeType: input.audioMimeType ?? null,
      sampleRateHz: input.sampleRateHz ?? null,
      audioUrl: input.audioUrl ?? null,
      audioSha256: input.audioSha256 ?? null,
      injectedToMediaInput: input.injectedToMediaInput ?? false,
      injectionPath: input.injectedToMediaInput ? "voice_session_media_input" : null,
      silentAudio: input.silentAudio ?? false,
      expectedTranscriptAccepted: false,
    });
    return cloneSession(session);
  }

  recordMediaInput(sessionId: string, input: {
    bytes: number;
    mimeType?: string;
    sampleRateHz?: number;
    assetName?: string;
    source?: string;
    audioSha256?: string;
    timestamp?: string;
  }): RealtimeVoiceSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "open") return null;
    const at = input.timestamp ?? new Date().toISOString();
    session.media.inputChunks += 1;
    session.media.inputBytes += input.bytes;
    session.media.inputMimeType = input.mimeType ?? session.media.inputMimeType;
    session.media.inputSampleRateHz = input.sampleRateHz ?? session.media.inputSampleRateHz;
    session.media.lastInputAt = at;
    this.record(session, "media.input.received", at, {
      bytes: input.bytes,
      totalBytes: session.media.inputBytes,
      chunks: session.media.inputChunks,
      mimeType: session.media.inputMimeType,
      sampleRateHz: session.media.inputSampleRateHz,
      source: input.source ?? null,
      assetName: input.assetName ?? null,
      audioSha256: input.audioSha256 ?? null,
      transcriptShortcut: false,
    });
    return cloneSession(session);
  }

  recordOutputChunk(sessionId: string, input: { bytes: number; mimeType?: string; sampleRateHz?: number; streamId?: string; final?: boolean; timestamp?: string }): RealtimeVoiceSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "open") return null;
    const at = input.timestamp ?? new Date().toISOString();
    const streamId = input.streamId?.trim() || session.output.streamId || `output-${session.playback.requestedTurns || 1}`;
    if ((session.output.status === "cancelled" || session.output.status === "completed") && session.output.streamId === streamId) {
      this.record(session, "output.audio.chunk.ignored", at, {
        streamId,
        bytes: input.bytes,
        reason: session.output.status === "cancelled" ? session.output.cancellationReason ?? "cancelled_stream" : "completed_stream",
      });
      return cloneSession(session);
    }
    const starting = session.output.status !== "streaming" || session.output.streamId !== streamId;
    if (starting) {
      session.output.streamId = streamId;
      session.output.status = "streaming";
      session.output.chunks = 0;
      session.output.bytes = 0;
      session.output.startedAt = at;
      session.output.completedAt = null;
      session.output.cancelledAt = null;
      session.output.cancellationReason = null;
      this.record(session, "output.stream.started", at, { streamId });
    }
    session.output.chunks += 1;
    session.output.bytes += input.bytes;
    session.output.totalChunks += 1;
    session.output.totalBytes += input.bytes;
    session.output.mimeType = input.mimeType ?? session.output.mimeType;
    session.output.sampleRateHz = input.sampleRateHz ?? session.output.sampleRateHz;
    session.output.lastChunkAt = at;
    this.record(session, "output.audio.chunk", at, {
      streamId,
      bytes: input.bytes,
      totalBytes: session.output.bytes,
      chunks: session.output.chunks,
      mimeType: session.output.mimeType,
      sampleRateHz: session.output.sampleRateHz,
    });
    if (input.final) {
      session.output.status = "completed";
      session.output.completedAt = at;
      this.record(session, "output.stream.completed", at, { streamId, chunks: session.output.chunks, bytes: session.output.bytes });
    }
    return cloneSession(session);
  }

  recordControl(sessionId: string, input: { action: string; reason?: string; timestamp?: string }): RealtimeVoiceSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "open") return null;
    const at = input.timestamp ?? new Date().toISOString();
    session.controls.lastAction = input.action;
    session.controls.lastReason = input.reason ?? null;
    this.record(session, "control.received", at, { action: input.action, reason: input.reason ?? null });
    if (input.action === "barge_in" && session.output.status === "streaming") {
      session.output.status = "cancelled";
      session.output.cancelledAt = at;
      session.output.cancellationReason = input.reason ?? "barge_in";
      session.output.bargeInCancellationObserved = true;
      this.record(session, "output.stream.cancelled", at, {
        streamId: session.output.streamId,
        reason: session.output.cancellationReason,
        chunks: session.output.chunks,
        bytes: session.output.bytes,
      });
    }
    if (input.action === "flush" && session.output.status === "streaming") {
      session.output.status = "completed";
      session.output.completedAt = at;
      this.record(session, "output.stream.completed", at, {
        streamId: session.output.streamId,
        reason: input.reason ?? "flush",
        chunks: session.output.chunks,
        bytes: session.output.bytes,
      });
    }
    if (input.action === "close") {
      session.status = "closed";
      session.closedAt = at;
      this.record(session, "session.closed", at, { inputChunks: session.media.inputChunks, inputBytes: session.media.inputBytes });
    }
    return cloneSession(session);
  }

  close(sessionId: string, timestamp = new Date().toISOString()): RealtimeVoiceSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.status !== "closed") {
      session.status = "closed";
      session.closedAt = timestamp;
      this.record(session, "session.closed", timestamp, { inputChunks: session.media.inputChunks, inputBytes: session.media.inputBytes });
    }
    return cloneSession(session);
  }

  events(sessionId: string, afterSequence = 0): RealtimeVoiceSessionEvent[] | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return session.events.filter((event) => event.sequence > afterSequence).map((event) => ({ ...event, detail: { ...event.detail } }));
  }

  proof(sessionId: string, call?: CallSnapshot | null): object | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const snapshot = cloneSession(session);
    const hasAudioInput = snapshot.media.inputChunks > 0 && snapshot.media.inputBytes > 0;
    const hasOutputAudio = snapshot.output.chunks > 0 && snapshot.output.bytes > 0;
    const sessionRtcAsrTranscriptEvents = call?.events.filter((event) => {
      if (event.type !== "rtc_asr_transcript") return false;
      if (compareIsoTimestamps(event.at, snapshot.createdAt) < 0) return false;
      const eventSessionId = typeof event.detail.voiceSessionId === "string"
        ? event.detail.voiceSessionId
        : typeof event.detail.realtimeVoiceSessionId === "string"
          ? event.detail.realtimeVoiceSessionId
          : null;
      return eventSessionId === null || eventSessionId === snapshot.id;
    }) ?? [];
    const hasRtcAsrFinalTranscript = sessionRtcAsrTranscriptEvents.length > 0;
    const transcriptTurns = call?.transcript.length ?? 0;
    const outputCancelledByBargeIn = snapshot.output.bargeInCancellationObserved
      || snapshot.events.some((event) => event.type === "output.stream.cancelled" && event.detail.reason === "barge_in");
    return {
      ok: true,
      schemaVersion: 1,
      route: "/api/voice/sessions/:id/proof",
      session: snapshot,
      endpoints: buildRealtimeVoiceSessionEndpoints(sessionId),
      ownership: {
        evaluator: "ConversationAgentEvals selects fixtures, pacing, provenance, and scoring.",
        acc: "ACC owns realtime audio intake, VAD/barge-in boundary, rtc-asr, agent behavior, TTS, events, and proof.",
      },
      mediaPipeline: {
        persistent: true,
        fullDuplex: true,
        sharedEngineContract: "transport adapter -> rtc-asr STT -> ACC brain -> Kokoro TTS -> transport adapter",
        realtimeAudioMode: true,
        transcriptShortcutAllowed: false,
      },
      evidence: {
        callId: snapshot.callId,
        inputChunks: snapshot.media.inputChunks,
        inputBytes: snapshot.media.inputBytes,
        playbackRequests: snapshot.playback.requestedTurns,
        outputChunks: snapshot.output.chunks,
        outputBytes: snapshot.output.bytes,
        totalOutputChunks: snapshot.output.totalChunks,
        totalOutputBytes: snapshot.output.totalBytes,
        hasOutputAudio,
        outputStatus: snapshot.output.status,
        outputCancelledByBargeIn,
        hasAudioInput,
        hasRtcAsrFinalTranscript,
        rtcAsrTranscriptEvents: sessionRtcAsrTranscriptEvents.length,
        transcriptTurns,
        callProofRoute: call?.session.openclawSession.artifactLinks.proof ?? null,
        eventRoute: buildRealtimeVoiceSessionEndpoints(sessionId).events,
      },
      correlation: buildCorrelationProof(snapshot, call),
      review: {
        status: hasAudioInput && hasOutputAudio && hasRtcAsrFinalTranscript ? "ready_for_evaluator" : "collecting_realtime_evidence",
        ready: hasAudioInput && hasOutputAudio && hasRtcAsrFinalTranscript,
        blockers: [hasAudioInput ? null : "voice_session_media_input_missing", hasOutputAudio ? null : "voice_session_output_audio_missing", hasRtcAsrFinalTranscript ? null : "rtc_asr_final_transcript_missing"].filter((blocker): blocker is string => blocker !== null),
      },
      call: call ?? null,
    };
  }

  snapshot(sessionId: string, call?: CallSnapshot | null): RealtimeVoiceSessionSnapshot | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return { ...cloneSession(session), endpoints: buildRealtimeVoiceSessionEndpoints(sessionId), call: call ?? undefined };
  }

  private record(session: RealtimeVoiceSession, type: string, at: string, detail: Record<string, string | number | boolean | null>): void {
    session.events.push({
      sequence: session.events.length + 1,
      type,
      at,
      correlationId: session.correlationId,
      sessionId: session.id,
      callId: session.callId,
      elapsedMs: eventElapsed(session, at),
      detail: {
        correlationId: session.correlationId,
        sessionId: session.id,
        callId: session.callId,
        ...detail,
      },
    });
    session.updatedAt = at;
  }
}
