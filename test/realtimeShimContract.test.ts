import test from "node:test";
import assert from "node:assert/strict";

import {
  REALTIME_SHIM_RPCS,
  buildLocalSttStartMessage,
  createRealtimeShimSessionEnvelope,
  decodeGatewayRelayPcm16,
} from "../src/core/realtimeShimContract";

test("realtime shim session envelope preserves the OpenClaw gateway relay boundary", () => {
  const envelope = createRealtimeShimSessionEnvelope({ relaySessionId: "local-rt-test" });

  assert.deepEqual(envelope, {
    provider: "local-realtime-shim",
    transport: "gateway-relay",
    relaySessionId: "local-rt-test",
    sessionId: "local-rt-test",
    mode: "realtime",
    brain: "agent-consult",
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
    model: "local-llm",
    voice: "kokoro",
    expiresAt: 0,
  });
});

test("realtime shim contract lists the browser-facing gateway relay RPCs", () => {
  assert.deepEqual(REALTIME_SHIM_RPCS, [
    "talk.session.create",
    "talk.session.appendAudio",
    "talk.session.cancelOutput",
    "talk.session.submitToolResult",
    "talk.session.close",
  ]);
});

test("local STT start message uses binary pcm16 framing details", () => {
  assert.deepEqual(buildLocalSttStartMessage(), {
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
  });
});

test("gateway relay audio decode rejects empty or malformed pcm16 frames", () => {
  const pcm16Frame = Buffer.from([0, 0, 255, 127]);

  assert.deepEqual(decodeGatewayRelayPcm16(pcm16Frame.toString("base64")), pcm16Frame);
  assert.throws(() => decodeGatewayRelayPcm16("   "), /audioBase64 is required/);
  assert.throws(() => decodeGatewayRelayPcm16(Buffer.from([1]).toString("base64")), /even number of bytes/);
});
