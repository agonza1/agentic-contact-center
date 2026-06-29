export type RealtimeShimRpc =
  | "talk.session.create"
  | "talk.session.appendAudio"
  | "talk.session.cancelOutput"
  | "talk.session.submitToolResult"
  | "talk.session.close";

export interface RealtimeShimAudioContract {
  inputEncoding: "pcm16";
  inputSampleRateHz: 24000;
  outputEncoding: "pcm16";
  outputSampleRateHz: 24000;
}

export interface RealtimeShimSessionEnvelope {
  provider: "local-realtime-shim";
  transport: "gateway-relay";
  relaySessionId: string;
  sessionId: string;
  mode: "realtime";
  brain: string;
  audio: RealtimeShimAudioContract;
  model: "local-llm";
  voice: "kokoro";
  expiresAt: 0;
}

export interface LocalSttStartMessage {
  type: "start";
  version: "local-stt.v1";
  audio: {
    sample_rate: 16000;
    channels: 1;
    format: "pcm_s16le";
    frame_ms: 20;
    bytes_per_frame: 640;
  };
  interim_results: true;
}

export type LocalSttControlMessage =
  | { type: "finalize" }
  | { type: "cancel" }
  | { type: "close" };

export interface RealtimeShimAppendAudioRequest {
  sessionId: string;
  audioBase64: string;
  timestamp?: number;
  pcm16: Buffer;
}

export interface RealtimeShimCancelOutputRequest {
  sessionId: string;
  reason: "barge-in" | "cancelled" | "error";
}

export interface RealtimeShimToolResultRequest {
  sessionId: string;
  toolCallId: string;
  result: unknown;
}

export interface RealtimeShimCloseRequest {
  sessionId: string;
  reason: "client" | "complete" | "error";
}

export type RealtimeShimRelayEvent =
  | {
      relaySessionId: string;
      sessionId: string;
      type: "audio";
      audioBase64: string;
    }
  | {
      relaySessionId: string;
      sessionId: string;
      type: "clear";
      reason: "barge-in" | "cancelled" | "error";
    }
  | {
      relaySessionId: string;
      sessionId: string;
      type: "close";
      reason: "client" | "complete" | "error";
    }
  | {
      relaySessionId: string;
      sessionId: string;
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
    };

export const REALTIME_SHIM_RPCS: RealtimeShimRpc[] = [
  "talk.session.create",
  "talk.session.appendAudio",
  "talk.session.cancelOutput",
  "talk.session.submitToolResult",
  "talk.session.close",
];

export function createRealtimeShimSessionEnvelope(options: {
  relaySessionId: string;
  brain?: string;
}): RealtimeShimSessionEnvelope {
  return {
    provider: "local-realtime-shim",
    transport: "gateway-relay",
    relaySessionId: options.relaySessionId,
    sessionId: options.relaySessionId,
    mode: "realtime",
    brain: options.brain ?? "agent-consult",
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
    model: "local-llm",
    voice: "kokoro",
    expiresAt: 0,
  };
}

export function buildLocalSttStartMessage(): LocalSttStartMessage {
  return {
    type: "start",
    version: "local-stt.v1",
    audio: {
      sample_rate: 16000,
      channels: 1,
      format: "pcm_s16le",
      frame_ms: 20,
      bytes_per_frame: 640,
    },
    interim_results: true,
  };
}

export function buildLocalSttFinalizeMessage(): LocalSttControlMessage {
  return { type: "finalize" };
}

export function buildLocalSttCancelMessage(): LocalSttControlMessage {
  return { type: "cancel" };
}

export function buildLocalSttCloseMessage(): LocalSttControlMessage {
  return { type: "close" };
}

export function decodeGatewayRelayPcm16(audioBase64: string): Buffer {
  const normalizedAudio = audioBase64.trim();

  if (!normalizedAudio) {
    throw new Error("audioBase64 is required");
  }

  if (!/^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/.test(normalizedAudio)) {
    throw new Error("audioBase64 must be valid base64");
  }

  const decodedAudio = Buffer.from(normalizedAudio, "base64");

  if (decodedAudio.length === 0) {
    throw new Error("audioBase64 decoded to an empty audio frame");
  }

  if (decodedAudio.length % 2 !== 0) {
    throw new Error("pcm16 audio frames must contain an even number of bytes");
  }

  return decodedAudio;
}

export function createRealtimeShimAppendAudioRequest(options: {
  sessionId: string;
  audioBase64: string;
  timestamp?: number;
}): RealtimeShimAppendAudioRequest {
  const sessionId = normalizeRealtimeShimRequiredString(options.sessionId, "sessionId");

  if (
    options.timestamp !== undefined &&
    (!Number.isFinite(options.timestamp) || options.timestamp < 0)
  ) {
    throw new Error("timestamp must be a non-negative finite number");
  }

  const audioBase64 = options.audioBase64.trim();

  return {
    sessionId,
    audioBase64,
    timestamp: options.timestamp,
    pcm16: decodeGatewayRelayPcm16(audioBase64),
  };
}

export function createRealtimeShimCancelOutputRequest(options: {
  sessionId: string;
  reason?: "barge-in" | "cancelled" | "error";
}): RealtimeShimCancelOutputRequest {
  return {
    sessionId: normalizeRealtimeShimRequiredString(options.sessionId, "sessionId"),
    reason: options.reason ?? "cancelled",
  };
}

export function createRealtimeShimToolResultRequest(options: {
  sessionId: string;
  toolCallId: string;
  result: unknown;
}): RealtimeShimToolResultRequest {
  return {
    sessionId: normalizeRealtimeShimRequiredString(options.sessionId, "sessionId"),
    toolCallId: normalizeRealtimeShimRequiredString(options.toolCallId, "toolCallId"),
    result: options.result,
  };
}

export function createRealtimeShimCloseRequest(options: {
  sessionId: string;
  reason?: "client" | "complete" | "error";
}): RealtimeShimCloseRequest {
  return {
    sessionId: normalizeRealtimeShimRequiredString(options.sessionId, "sessionId"),
    reason: options.reason ?? "client",
  };
}

export function createRealtimeShimAudioRelayEvent(
  envelope: Pick<RealtimeShimSessionEnvelope, "relaySessionId" | "sessionId">,
  audioBase64: string,
): RealtimeShimRelayEvent {
  decodeGatewayRelayPcm16(audioBase64);

  return {
    relaySessionId: envelope.relaySessionId,
    sessionId: envelope.sessionId,
    type: "audio",
    audioBase64: audioBase64.trim(),
  };
}

export function createRealtimeShimClearRelayEvent(
  envelope: Pick<RealtimeShimSessionEnvelope, "relaySessionId" | "sessionId">,
  reason: "barge-in" | "cancelled" | "error" = "cancelled",
): RealtimeShimRelayEvent {
  return {
    relaySessionId: envelope.relaySessionId,
    sessionId: envelope.sessionId,
    type: "clear",
    reason,
  };
}

export function createRealtimeShimCloseRelayEvent(
  envelope: Pick<RealtimeShimSessionEnvelope, "relaySessionId" | "sessionId">,
  reason: "client" | "complete" | "error" = "client",
): RealtimeShimRelayEvent {
  return {
    relaySessionId: envelope.relaySessionId,
    sessionId: envelope.sessionId,
    type: "close",
    reason,
  };
}

export function createRealtimeShimErrorRelayEvent(
  envelope: Pick<RealtimeShimSessionEnvelope, "relaySessionId" | "sessionId">,
  options: { code: string; message: string; retryable?: boolean },
): RealtimeShimRelayEvent {
  return {
    relaySessionId: envelope.relaySessionId,
    sessionId: envelope.sessionId,
    type: "error",
    code: normalizeRealtimeShimRequiredString(options.code, "code"),
    message: normalizeRealtimeShimRequiredString(options.message, "message"),
    retryable: options.retryable ?? false,
  };
}

function normalizeRealtimeShimRequiredString(value: string, fieldName: string): string {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw new Error(`${fieldName} is required`);
  }

  return normalizedValue;
}
