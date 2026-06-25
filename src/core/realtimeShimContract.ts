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

export function decodeGatewayRelayPcm16(audioBase64: string): Buffer {
  const normalizedAudio = audioBase64.trim();

  if (!normalizedAudio) {
    throw new Error("audioBase64 is required");
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
