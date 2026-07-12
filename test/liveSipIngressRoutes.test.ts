import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

function requestJson(port: number, method: string, route: string, body?: unknown): Promise<{ statusCode: number; payload: any }> {
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        headers: rawBody
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(rawBody) }
          : undefined,
      },
      (response) => {
        let collected = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { collected += chunk; });
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, payload: collected ? JSON.parse(collected) : null }));
      },
    );
    req.on("error", reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

test("live SIP events create local_sip live-capture calls and attach honest rtc-asr blockers", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-06-30T10:00:00.000Z",
      sipCallId: "sip-proof-1",
      source: "freeswitch_esl",
      telephonyMode: "local_sip",
    });
    assert.equal(started.statusCode, 201);
    assert.equal(started.payload.call.session.providerName, "freeswitch-local-sip");
    assert.deepEqual(started.payload.call.session.runtimeModeLabels, {
      telephony: "local_sip",
      media: "live_capture",
      rtcAsr: "rtc_asr_blocked",
      credentialsMode: "mocked",
    });
    assert.equal(started.payload.call.session.openclawSession.status, "attached_live");

    const capture = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.capture",
      timestamp: "2026-06-30T10:00:02.000Z",
      sipCallId: "sip-proof-1",
      audioWavPath: "artifacts/freeswitch-live/media/sip-proof-1.wav",
      sipLogPath: "artifacts/freeswitch-live/freeswitch-esl-events.json",
      rtpPacketCount: 42,
      generatedMedia: false,
    });
    assert.equal(capture.statusCode, 200);
    assert.equal(capture.payload.call.events.some((event: any) => event.type === "media_capture_attached" && event.detail.rtpPacketCount === 42), true);

    const playback = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.playback",
      timestamp: "2026-06-30T10:00:02.250Z",
      sipCallId: "sip-proof-1",
      outboundRtpReady: true,
      rtpSocketSendReady: true,
      packetCount: 3,
      sentPacketCount: 3,
      remoteHost: "127.0.0.1",
      remotePort: 40002,
      evidencePath: "artifacts/freeswitch-live/freeswitch-live-proof-manifest.json",
    });
    assert.equal(playback.statusCode, 200);
    assert.equal(playback.payload.call.events.some((event: any) => event.type === "pipecat_rtp_playback_attached" && event.detail.sentPacketCount === 3), true);

    const invalidCapture = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.capture",
      timestamp: "2026-06-30T10:00:02.500Z",
      sipCallId: "sip-proof-1",
      rtpPacketCount: -1,
    });
    assert.equal(invalidCapture.statusCode, 400);
    assert.equal(invalidCapture.payload.error, "live_sip_rtp_packet_count_invalid");

    const blocked = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "rtc_asr.blocked",
      timestamp: "2026-06-30T10:00:03.000Z",
      sipCallId: "sip-proof-1",
      blocker: "rtc-asr sidecar not running",
    });
    assert.equal(blocked.statusCode, 200);
    assert.equal(blocked.payload.call.events.some((event: any) => event.type === "rtc_asr_blocked" && event.detail.blocker === "rtc-asr sidecar not running"), true);

    const blockedConsoleResponse = await requestJson(address.port, "GET", "/api/operator/console?callId=" + started.payload.call.session.callId);
    assert.equal(blockedConsoleResponse.statusCode, 200);
    const blockedLiveProof = blockedConsoleResponse.payload.calls.items[0].liveProof;
    assert.equal(blockedLiveProof.eval.status, "ready_with_rtc_asr_blocker");
    assert.equal(blockedLiveProof.eval.reviewReady, false);
    assert.equal(blockedLiveProof.eval.assertRequestExpected, true);

    const transcript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-06-30T10:00:04.000Z",
      sipCallId: "sip-proof-1",
      text: "I need help with a billing question.",
      rtcAsrEvidencePath: "artifacts/freeswitch-live/rtc-asr-evidence.json",
    });
    assert.equal(transcript.statusCode, 200);
    assert.equal(transcript.payload.call.events.some((event: any) => event.type === "rtc_asr_transcript" && event.detail.transcriptText === "I need help with a billing question."), true);
    assert.equal(transcript.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === "I need help with a billing question."), true);

    const invalidEnded = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: "2026-06-30T10:00:05.000Z",
      sipCallId: "sip-proof-1",
      durationSeconds: 2.5,
    });
    assert.equal(invalidEnded.statusCode, 400);
    assert.equal(invalidEnded.payload.error, "live_sip_duration_seconds_invalid");

    const consoleResponse = await requestJson(address.port, "GET", "/api/operator/console?callId=" + started.payload.call.session.callId);
    assert.equal(consoleResponse.statusCode, 200);
    const liveProof = consoleResponse.payload.calls.items[0].liveProof;
    assert.equal(liveProof.run.sessionId, "live-sip-sip-proof-1");
    assert.deepEqual(liveProof.labels, {
      telephony: "local_sip",
      media: "live_capture",
      rtcAsr: "rtc_asr_blocked",
      credentialsMode: "mocked",
    });
    assert.equal(liveProof.audioCapture.status, "live_capture_attached");
    assert.equal(liveProof.audioCapture.audioWavPath, "artifacts/freeswitch-live/media/sip-proof-1.wav");
    assert.equal(liveProof.audioCapture.sipLogPath, "artifacts/freeswitch-live/freeswitch-esl-events.json");
    assert.equal(liveProof.playback.status, "rtp_sent_to_socket");
    assert.equal(liveProof.playback.sentPacketCount, 3);
    assert.equal(liveProof.playback.remotePort, 40002);
    assert.equal(liveProof.asr.status, "transcript_received");
    assert.equal(liveProof.asr.latestTranscriptText, "I need help with a billing question.");
    assert.equal(liveProof.asr.evidencePath, "artifacts/freeswitch-live/rtc-asr-evidence.json");
    assert.equal(liveProof.eval.status, "ready_for_conversation_agent_evals");
    assert.equal(liveProof.eval.reviewReady, true);
    assert.equal(liveProof.operator.handoffState, "operator_review_required");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("SignalWire webhook can be labeled signalwire_live without credentials in config", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/signalwire/events", {
      eventType: "call.started",
      timestamp: "2026-06-30T10:05:00.000Z",
      signalWireCallId: "sw-live-1",
      telephonyMode: "signalwire_live",
      credentialsMode: "signalwire_live",
    });
    assert.equal(started.statusCode, 201);
    assert.equal(started.payload.call.session.runtimeModeLabels.telephony, "signalwire_live");
    assert.equal(started.payload.call.session.runtimeModeLabels.credentialsMode, "signalwire_live");
    assert.equal(started.payload.call.session.openclawSession.status, "attached_live");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
