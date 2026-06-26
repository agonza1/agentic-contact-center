import {
  buildLocalSttCancelMessage,
  buildLocalSttCloseMessage,
  buildLocalSttFinalizeMessage,
  buildLocalSttStartMessage,
  createRealtimeShimAppendAudioRequest,
  createRealtimeShimAudioRelayEvent,
  createRealtimeShimCancelOutputRequest,
  createRealtimeShimClearRelayEvent,
  createRealtimeShimCloseRelayEvent,
  createRealtimeShimCloseRequest,
  createRealtimeShimSessionEnvelope,
  type LocalSttControlMessage,
  type LocalSttStartMessage,
  type RealtimeShimRelayEvent,
  type RealtimeShimSessionEnvelope,
} from "./realtimeShimContract";

export type LocalRealtimeShimState =
  | "idle"
  | "listening"
  | "finalizing"
  | "responding"
  | "speaking"
  | "closed";

export type LocalRealtimeShimDiagnostic =
  | { type: "ready"; sessionId: string; relaySessionId: string; state: LocalRealtimeShimState }
  | { type: "input.audio.delta"; sessionId: string; relaySessionId: string; byteLength: number; timestamp?: number }
  | { type: "transcript.delta"; sessionId: string; relaySessionId: string; text: string; final: false }
  | { type: "transcript.done"; sessionId: string; relaySessionId: string; text: string; final: true }
  | { type: "output.text.done"; sessionId: string; relaySessionId: string; text: string }
  | { type: "output.audio.started"; sessionId: string; relaySessionId: string }
  | { type: "output.audio.done"; sessionId: string; relaySessionId: string; chunks: number }
  | { type: "turn.cancelled"; sessionId: string; relaySessionId: string; reason: "barge-in" | "cancelled" | "error" }
  | { type: "session.closed"; sessionId: string; relaySessionId: string; reason: "client" | "complete" | "error" };

export interface LocalRealtimeShimTimelineEntry {
  sequence: number;
  source: "diagnostic" | "local-stt" | "relay";
  type: string;
  byteLength?: number;
  text?: string;
  final?: boolean;
  reason?: "barge-in" | "cancelled" | "error" | "client" | "complete";
}

export interface LocalRealtimeShimEvidence {
  envelope: RealtimeShimSessionEnvelope;
  state: LocalRealtimeShimState;
  diagnostics: LocalRealtimeShimDiagnostic[];
  relayEvents: RealtimeShimRelayEvent[];
  timeline: LocalRealtimeShimTimelineEntry[];
  localSttMessages: Array<LocalSttStartMessage | LocalSttControlMessage | { type: "audio"; byteLength: number }>;
  mockedPieces: string[];
  limitations: string[];
}

interface LocalRealtimeShimSession {
  envelope: RealtimeShimSessionEnvelope;
  state: LocalRealtimeShimState;
  audioBytesReceived: number;
  sttStarted: boolean;
  outputCancelled: boolean;
  diagnostics: LocalRealtimeShimDiagnostic[];
  relayEvents: RealtimeShimRelayEvent[];
  timeline: LocalRealtimeShimTimelineEntry[];
  localSttMessages: LocalRealtimeShimEvidence["localSttMessages"];
}

export class LocalRealtimeShimPrototype {
  private readonly sessions = new Map<string, LocalRealtimeShimSession>();
  private nextSessionIndex = 1;

  createSession(options: { brain?: string; relaySessionId?: string } = {}): RealtimeShimSessionEnvelope {
    const relaySessionId = options.relaySessionId ?? `local-rt-${this.nextSessionIndex++}`;
    const envelope = createRealtimeShimSessionEnvelope({ relaySessionId, brain: options.brain });
    const session: LocalRealtimeShimSession = {
      envelope,
      state: "idle",
      audioBytesReceived: 0,
      sttStarted: false,
      outputCancelled: false,
      diagnostics: [],
      relayEvents: [],
      timeline: [],
      localSttMessages: [],
    };

    this.recordDiagnostic(session, {
      type: "ready",
      sessionId: envelope.sessionId,
      relaySessionId: envelope.relaySessionId,
      state: session.state,
    });
    this.sessions.set(envelope.sessionId, session);

    return envelope;
  }

  appendAudio(options: { sessionId: string; audioBase64: string; timestamp?: number }): LocalRealtimeShimEvidence {
    const request = createRealtimeShimAppendAudioRequest(options);
    const session = this.requireOpenSession(request.sessionId);

    if (!session.sttStarted) {
      this.recordLocalSttMessage(session, buildLocalSttStartMessage());
      session.sttStarted = true;
      session.state = "listening";
    }

    session.audioBytesReceived += request.pcm16.length;
    this.recordLocalSttMessage(session, { type: "audio", byteLength: request.pcm16.length });
    this.recordDiagnostic(session, {
      type: "input.audio.delta",
      sessionId: session.envelope.sessionId,
      relaySessionId: session.envelope.relaySessionId,
      byteLength: request.pcm16.length,
      timestamp: request.timestamp,
    });

    return this.getEvidence(request.sessionId);
  }

  finalizeTurn(options: { sessionId: string; transcriptText?: string }): LocalRealtimeShimEvidence {
    const session = this.requireOpenSession(options.sessionId);

    if (!session.sttStarted) {
      this.recordLocalSttMessage(session, buildLocalSttStartMessage());
      session.sttStarted = true;
    }

    session.state = "finalizing";
    this.recordLocalSttMessage(session, buildLocalSttFinalizeMessage());

    const transcriptText = options.transcriptText?.trim() || "I need help with my account.";
    this.recordDiagnostic(session, {
      type: "transcript.delta",
      sessionId: session.envelope.sessionId,
      relaySessionId: session.envelope.relaySessionId,
      text: transcriptText,
      final: false,
    });
    this.recordDiagnostic(session, {
      type: "transcript.done",
      sessionId: session.envelope.sessionId,
      relaySessionId: session.envelope.relaySessionId,
      text: transcriptText,
      final: true,
    });

    session.state = "responding";
    const assistantText = `Local prototype response: I heard "${transcriptText}" and will keep the flow in a safe handoff lane.`;
    this.recordDiagnostic(session, {
      type: "output.text.done",
      sessionId: session.envelope.sessionId,
      relaySessionId: session.envelope.relaySessionId,
      text: assistantText,
    });

    if (!session.outputCancelled) {
      session.state = "speaking";
      this.recordDiagnostic(session, {
        type: "output.audio.started",
        sessionId: session.envelope.sessionId,
        relaySessionId: session.envelope.relaySessionId,
      });
      const audioBase64 = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]).toString("base64");
      this.recordRelayEvent(session, createRealtimeShimAudioRelayEvent(session.envelope, audioBase64));
      this.recordDiagnostic(session, {
        type: "output.audio.done",
        sessionId: session.envelope.sessionId,
        relaySessionId: session.envelope.relaySessionId,
        chunks: 1,
      });
    }

    return this.getEvidence(options.sessionId);
  }

  cancelOutput(options: { sessionId: string; reason?: "barge-in" | "cancelled" | "error" }): LocalRealtimeShimEvidence {
    const request = createRealtimeShimCancelOutputRequest(options);
    const session = this.requireOpenSession(request.sessionId);

    session.outputCancelled = true;
    session.state = "listening";
    this.recordRelayEvent(session, createRealtimeShimClearRelayEvent(session.envelope, request.reason));
    this.recordDiagnostic(session, {
      type: "turn.cancelled",
      sessionId: session.envelope.sessionId,
      relaySessionId: session.envelope.relaySessionId,
      reason: request.reason,
    });

    return this.getEvidence(request.sessionId);
  }

  cancelInput(options: { sessionId: string }): LocalRealtimeShimEvidence {
    const session = this.requireOpenSession(options.sessionId);
    this.recordLocalSttMessage(session, buildLocalSttCancelMessage());
    session.state = "idle";
    return this.getEvidence(options.sessionId);
  }

  closeSession(options: { sessionId: string; reason?: "client" | "complete" | "error" }): LocalRealtimeShimEvidence {
    const request = createRealtimeShimCloseRequest(options);
    const session = this.sessions.get(request.sessionId);

    if (!session) {
      throw new Error(`Unknown realtime shim session: ${request.sessionId}`);
    }

    if (session.state !== "closed") {
      this.recordLocalSttMessage(session, buildLocalSttCloseMessage());
      session.state = "closed";
      this.recordRelayEvent(session, createRealtimeShimCloseRelayEvent(session.envelope, request.reason));
      this.recordDiagnostic(session, {
        type: "session.closed",
        sessionId: session.envelope.sessionId,
        relaySessionId: session.envelope.relaySessionId,
        reason: request.reason,
      });
    }

    return this.getEvidence(request.sessionId);
  }

  getEvidence(sessionId: string): LocalRealtimeShimEvidence {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Unknown realtime shim session: ${sessionId}`);
    }

    return {
      envelope: session.envelope,
      state: session.state,
      diagnostics: [...session.diagnostics],
      relayEvents: [...session.relayEvents],
      timeline: [...session.timeline],
      localSttMessages: [...session.localSttMessages],
      mockedPieces: ["local LLM response text", "Kokoro PCM output audio"],
      limitations: [
        "rtc-asr websocket is represented by Local STT v1 message evidence, not a live sidecar connection",
        "turn endpointing is explicit through finalizeTurn for the first deterministic proof",
      ],
    };
  }

  private requireOpenSession(sessionId: string): LocalRealtimeShimSession {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Unknown realtime shim session: ${sessionId}`);
    }
    if (session.state === "closed") {
      throw new Error(`Realtime shim session is closed: ${sessionId}`);
    }

    return session;
  }

  private recordDiagnostic(session: LocalRealtimeShimSession, diagnostic: LocalRealtimeShimDiagnostic): void {
    session.diagnostics.push(diagnostic);
    session.timeline.push({
      sequence: session.timeline.length + 1,
      source: "diagnostic",
      type: diagnostic.type,
      ...pickTimelineDetails(diagnostic),
    });
  }

  private recordRelayEvent(session: LocalRealtimeShimSession, relayEvent: RealtimeShimRelayEvent): void {
    session.relayEvents.push(relayEvent);
    session.timeline.push({
      sequence: session.timeline.length + 1,
      source: "relay",
      type: relayEvent.type,
      ...pickTimelineDetails(relayEvent),
    });
  }

  private recordLocalSttMessage(
    session: LocalRealtimeShimSession,
    message: LocalRealtimeShimEvidence["localSttMessages"][number],
  ): void {
    session.localSttMessages.push(message);
    session.timeline.push({
      sequence: session.timeline.length + 1,
      source: "local-stt",
      type: message.type,
      ...pickTimelineDetails(message),
    });
  }
}

function pickTimelineDetails(
  event:
    | LocalRealtimeShimDiagnostic
    | RealtimeShimRelayEvent
    | LocalRealtimeShimEvidence["localSttMessages"][number],
): Omit<LocalRealtimeShimTimelineEntry, "sequence" | "source" | "type"> {
  return {
    ...("byteLength" in event ? { byteLength: event.byteLength } : {}),
    ...("text" in event ? { text: event.text } : {}),
    ...("final" in event ? { final: event.final } : {}),
    ...("reason" in event ? { reason: event.reason } : {}),
  };
}
