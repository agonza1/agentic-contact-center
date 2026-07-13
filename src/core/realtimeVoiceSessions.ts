import { randomUUID } from "node:crypto";

import type { CallSnapshot } from "./types";

export type RealtimeVoiceSessionStatus = "open" | "closing" | "closed";
export type RealtimeVoiceSessionTransport = "persistent_full_duplex";

export interface RealtimeVoiceSessionEvent {
  sequence: number;
  type: string;
  at: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface RealtimeVoiceSession {
  id: string;
  callId: string;
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
    play: `/api/voice/sessions/${encoded}/play`,
    mediaInput: `/api/voice/sessions/${encoded}/media/input`,
    events: `/api/voice/sessions/${encoded}/events`,
    control: `/api/voice/sessions/${encoded}/control`,
    close: `/api/voice/sessions/${encoded}/close`,
    proof: `/api/voice/sessions/${encoded}/proof`,
    websocketMediaInput: `/api/voice/sessions/${encoded}/media/input`,
  };
}

export class RealtimeVoiceSessionStore {
  private readonly sessions = new Map<string, RealtimeVoiceSession>();

  create(input: { requestedId?: string; callId: string; target?: string; metadata?: Record<string, string>; createdAt?: string }): RealtimeVoiceSession {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const id = input.requestedId?.trim() || `voice-session-${randomUUID()}`;
    const session: RealtimeVoiceSession = {
      id,
      callId: input.callId,
      status: "open",
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
      target: input.target?.trim() || "conversation-agent-evals",
      mode: "realtime_audio",
      transport: "persistent_full_duplex",
      metadata: { ...(input.metadata ?? {}) },
      media: { inputChunks: 0, inputBytes: 0, inputSampleRateHz: null, inputMimeType: null, lastInputAt: null },
      playback: { requestedTurns: 0, lastRequestedAt: null },
      controls: { lastAction: null, lastReason: null },
      events: [],
    };
    this.record(session, "session.created", createdAt, { callId: input.callId, target: session.target, realtimeAudioOnly: true });
    this.sessions.set(id, session);
    return cloneSession(session);
  }

  get(sessionId: string): RealtimeVoiceSession | null {
    const session = this.sessions.get(sessionId);
    return session ? cloneSession(session) : null;
  }

  recordPlaybackRequest(sessionId: string, input: { label?: string; audioBytes?: number; audioUrl?: string; timestamp?: string }): RealtimeVoiceSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === "closed") return null;
    const at = input.timestamp ?? new Date().toISOString();
    session.playback.requestedTurns += 1;
    session.playback.lastRequestedAt = at;
    this.record(session, "play.requested", at, {
      label: input.label ?? null,
      audioBytes: input.audioBytes ?? null,
      audioUrl: input.audioUrl ?? null,
      expectedTranscriptAccepted: false,
    });
    return cloneSession(session);
  }

  recordMediaInput(sessionId: string, input: { bytes: number; mimeType?: string; sampleRateHz?: number; timestamp?: string }): RealtimeVoiceSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === "closed") return null;
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
      transcriptShortcut: false,
    });
    return cloneSession(session);
  }

  recordControl(sessionId: string, input: { action: string; reason?: string; timestamp?: string }): RealtimeVoiceSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === "closed") return null;
    const at = input.timestamp ?? new Date().toISOString();
    session.controls.lastAction = input.action;
    session.controls.lastReason = input.reason ?? null;
    if (input.action === "close") session.status = "closing";
    this.record(session, "control.received", at, { action: input.action, reason: input.reason ?? null });
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
    const hasRtcAsrFinalTranscript = call?.events.some((event) => event.type === "rtc_asr_transcript") === true;
    const transcriptTurns = call?.transcript.length ?? 0;
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
        hasAudioInput,
        hasRtcAsrFinalTranscript,
        transcriptTurns,
        callProofRoute: call?.session.openclawSession.artifactLinks.proof ?? null,
        eventRoute: buildRealtimeVoiceSessionEndpoints(sessionId).events,
      },
      review: {
        status: hasAudioInput && hasRtcAsrFinalTranscript ? "ready_for_evaluator" : "collecting_realtime_evidence",
        ready: hasAudioInput && hasRtcAsrFinalTranscript,
        blockers: [hasAudioInput ? null : "voice_session_media_input_missing", hasRtcAsrFinalTranscript ? null : "rtc_asr_final_transcript_missing"].filter((blocker): blocker is string => blocker !== null),
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
    session.events.push({ sequence: session.events.length + 1, type, at, detail });
    session.updatedAt = at;
  }
}
