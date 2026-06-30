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
  createRealtimeShimErrorRelayEvent,
  createRealtimeShimToolResultRequest,
  createRealtimeShimSessionEnvelope,
  type LocalSttControlMessage,
  type LocalSttStartMessage,
  type RealtimeShimRelayEvent,
  type RealtimeShimSessionEnvelope,
  type RealtimeShimToolResultRequest,
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
  | { type: "output.text.delta"; sessionId: string; relaySessionId: string; text: string }
  | { type: "output.text.done"; sessionId: string; relaySessionId: string; text: string }
  | { type: "output.audio.started"; sessionId: string; relaySessionId: string }
  | { type: "output.audio.delta"; sessionId: string; relaySessionId: string; byteLength: number }
  | { type: "output.audio.done"; sessionId: string; relaySessionId: string; chunks: number }
  | { type: "tool.result.received"; sessionId: string; relaySessionId: string; toolCallId: string; status: "not_applicable" }
  | { type: "input.cancelled"; sessionId: string; relaySessionId: string; reason: "client" }
  | { type: "turn.cancelled"; sessionId: string; relaySessionId: string; reason: "barge-in" | "cancelled" | "error" }
  | { type: "session.error"; sessionId: string; relaySessionId: string; code: string; message: string; retryable: boolean }
  | { type: "session.closed"; sessionId: string; relaySessionId: string; reason: "client" | "complete" | "error" };

export interface LocalRealtimeShimTimelineEntry {
  sequence: number;
  source: "diagnostic" | "local-stt" | "relay";
  type: string;
  byteLength?: number;
  text?: string;
  final?: boolean;
  reason?: "barge-in" | "cancelled" | "error" | "client" | "complete";
  toolCallId?: string;
  status?: "not_applicable";
  code?: string;
  message?: string;
  retryable?: boolean;
}

export interface LocalRealtimeShimLatencyMark {
  name: "audio_ingested" | "transcript_final" | "output_first_audio" | "session_closed";
  elapsedMs: number;
  budgetMs: number;
  withinBudget: boolean;
}

export interface LocalRealtimeShimEvidence {
  envelope: RealtimeShimSessionEnvelope;
  state: LocalRealtimeShimState;
  audioInput: {
    relayEncoding: RealtimeShimSessionEnvelope["audio"]["inputEncoding"];
    relaySampleRateHz: RealtimeShimSessionEnvelope["audio"]["inputSampleRateHz"];
    localSttSampleRateHz: LocalSttStartMessage["audio"]["sample_rate"];
    chunks: number;
    bytesReceived: number;
    lastTimestamp?: number;
  };
  diagnostics: LocalRealtimeShimDiagnostic[];
  relayEvents: RealtimeShimRelayEvent[];
  timeline: LocalRealtimeShimTimelineEntry[];
  latencyMarks: LocalRealtimeShimLatencyMark[];
  localSttMessages: Array<LocalSttStartMessage | LocalSttControlMessage | { type: "audio"; byteLength: number }>;
  toolResults: Array<RealtimeShimToolResultRequest & { status: "not_applicable" }>;
  mockedPieces: string[];
  limitations: string[];
}

interface LocalRealtimeShimSession {
  envelope: RealtimeShimSessionEnvelope;
  state: LocalRealtimeShimState;
  audioBytesReceived: number;
  audioChunksReceived: number;
  lastAudioTimestamp?: number;
  sttStarted: boolean;
  outputCancelled: boolean;
  diagnostics: LocalRealtimeShimDiagnostic[];
  relayEvents: RealtimeShimRelayEvent[];
  timeline: LocalRealtimeShimTimelineEntry[];
  latencyMarks: LocalRealtimeShimLatencyMark[];
  localSttMessages: LocalRealtimeShimEvidence["localSttMessages"];
  toolResults: LocalRealtimeShimEvidence["toolResults"];
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
      audioChunksReceived: 0,
      sttStarted: false,
      outputCancelled: false,
      diagnostics: [],
      relayEvents: [],
      timeline: [],
      latencyMarks: [],
      localSttMessages: [],
      toolResults: [],
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
    session.audioChunksReceived += 1;
    session.lastAudioTimestamp = request.timestamp;
    this.recordLocalSttMessage(session, { type: "audio", byteLength: request.pcm16.length });
    this.recordDiagnostic(session, {
      type: "input.audio.delta",
      sessionId: session.envelope.sessionId,
      relaySessionId: session.envelope.relaySessionId,
      byteLength: request.pcm16.length,
      timestamp: request.timestamp,
    });
    this.recordLatencyMark(session, "audio_ingested", 12, 50);

    return this.getEvidence(request.sessionId);
  }

  appendAudioWithErrorEvidence(options: {
    sessionId: string;
    audioBase64: string;
    timestamp?: number;
  }):
    | { ok: true; evidence: LocalRealtimeShimEvidence }
    | { ok: false; code: string; message: string; evidence: LocalRealtimeShimEvidence } {
    const session = this.requireOpenSession(options.sessionId);

    try {
      return { ok: true, evidence: this.appendAudio(options) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid gateway relay audio frame";
      const relayError = createRealtimeShimErrorRelayEvent(session.envelope, {
        code: "invalid_audio_frame",
        message,
        retryable: true,
      });

      if (relayError.type !== "error") {
        throw new Error("Expected realtime shim error relay event");
      }

      this.recordRelayEvent(session, relayError);
      this.recordDiagnostic(session, {
        type: "session.error",
        sessionId: session.envelope.sessionId,
        relaySessionId: session.envelope.relaySessionId,
        code: relayError.code,
        message: relayError.message,
        retryable: relayError.retryable,
      });

      return {
        ok: false,
        code: relayError.code,
        message: relayError.message,
        evidence: this.getEvidence(options.sessionId),
      };
    }
  }

  finalizeTurn(options: { sessionId: string; transcriptText?: string }): LocalRealtimeShimEvidence {
    const session = this.requireOpenSession(options.sessionId);

    if (!session.sttStarted) {
      this.recordLocalSttMessage(session, buildLocalSttStartMessage());
      session.sttStarted = true;
    }

    session.outputCancelled = false;
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
    this.recordLatencyMark(session, "transcript_final", 75, 250);

    session.state = "responding";
    const assistantText = `Local prototype response: I heard "${transcriptText}" and will keep the flow in a safe handoff lane.`;
    this.recordDiagnostic(session, {
      type: "output.text.delta",
      sessionId: session.envelope.sessionId,
      relaySessionId: session.envelope.relaySessionId,
      text: assistantText,
    });
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
        type: "output.audio.delta",
        sessionId: session.envelope.sessionId,
        relaySessionId: session.envelope.relaySessionId,
        byteLength: Buffer.from(audioBase64, "base64").length,
      });
      this.recordLatencyMark(session, "output_first_audio", 135, 500);
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

  submitToolResult(options: { sessionId: string; toolCallId: string; result: unknown }): LocalRealtimeShimEvidence {
    const request = createRealtimeShimToolResultRequest(options);
    const session = this.requireOpenSession(request.sessionId);
    const toolResult = { ...request, status: "not_applicable" as const };

    session.toolResults.push(toolResult);
    this.recordDiagnostic(session, {
      type: "tool.result.received",
      sessionId: session.envelope.sessionId,
      relaySessionId: session.envelope.relaySessionId,
      toolCallId: request.toolCallId,
      status: toolResult.status,
    });

    return this.getEvidence(request.sessionId);
  }

  cancelInput(options: { sessionId: string }): LocalRealtimeShimEvidence {
    const session = this.requireOpenSession(options.sessionId);
    this.recordLocalSttMessage(session, buildLocalSttCancelMessage());
    session.state = "idle";
    this.recordDiagnostic(session, {
      type: "input.cancelled",
      sessionId: session.envelope.sessionId,
      relaySessionId: session.envelope.relaySessionId,
      reason: "client",
    });
    return this.getEvidence(options.sessionId);
  }

  recordLocalSttError(options: {
    sessionId: string;
    code: string;
    message: string;
    retryable?: boolean;
  }): LocalRealtimeShimEvidence {
    const session = this.requireOpenSession(options.sessionId);
    const relayError = createRealtimeShimErrorRelayEvent(session.envelope, options);

    if (relayError.type !== "error") {
      throw new Error("Expected realtime shim error relay event");
    }

    this.recordRelayEvent(session, relayError);
    this.recordDiagnostic(session, {
      type: "session.error",
      sessionId: session.envelope.sessionId,
      relaySessionId: session.envelope.relaySessionId,
      code: relayError.code,
      message: relayError.message,
      retryable: relayError.retryable,
    });

    if (!relayError.retryable) {
      this.closeSession({ sessionId: options.sessionId, reason: "error" });
    }

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
      this.recordLatencyMark(session, "session_closed", 150, 1000);
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
      audioInput: {
        relayEncoding: session.envelope.audio.inputEncoding,
        relaySampleRateHz: session.envelope.audio.inputSampleRateHz,
        localSttSampleRateHz: buildLocalSttStartMessage().audio.sample_rate,
        chunks: session.audioChunksReceived,
        bytesReceived: session.audioBytesReceived,
        ...(session.lastAudioTimestamp !== undefined ? { lastTimestamp: session.lastAudioTimestamp } : {}),
      },
      diagnostics: [...session.diagnostics],
      relayEvents: [...session.relayEvents],
      timeline: [...session.timeline],
      latencyMarks: [...session.latencyMarks],
      localSttMessages: [...session.localSttMessages],
      toolResults: [...session.toolResults],
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

  private recordLatencyMark(
    session: LocalRealtimeShimSession,
    name: LocalRealtimeShimLatencyMark["name"],
    elapsedMs: number,
    budgetMs: number,
  ): void {
    if (session.latencyMarks.some((mark) => mark.name === name)) {
      return;
    }

    session.latencyMarks.push({
      name,
      elapsedMs,
      budgetMs,
      withinBudget: elapsedMs <= budgetMs,
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
    ...("toolCallId" in event ? { toolCallId: event.toolCallId } : {}),
    ...("status" in event ? { status: event.status } : {}),
    ...("code" in event ? { code: event.code } : {}),
    ...("message" in event ? { message: event.message } : {}),
    ...("retryable" in event ? { retryable: event.retryable } : {}),
  };
}
