import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTestServer, request } from "node:http";

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
      totalDurationMs: 60,
      ssrc: 0xacc0ffee,
      lastSentAt: "2026-06-30T10:00:02.220Z",
      evidencePath: "artifacts/freeswitch-live/freeswitch-live-proof-manifest.json",
      callerPlaybackConfirmed: true,
      callerPlaybackEvidencePath: "artifacts/freeswitch-live/caller-playback-proof.json",
    });
    assert.equal(playback.statusCode, 200);
    assert.equal(playback.payload.call.events.some((event: any) => event.type === "pipecat_rtp_playback_attached" && event.detail.sentPacketCount === 3), true);

    const invalidPlayback = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.playback",
      timestamp: "2026-06-30T10:00:02.400Z",
      sipCallId: "sip-proof-1",
      outboundRtpReady: true,
      rtpSocketSendReady: true,
      packetCount: 2,
      sentPacketCount: 3,
      remotePort: 40002,
    });
    assert.equal(invalidPlayback.statusCode, 400);
    assert.equal(invalidPlayback.payload.error, "live_sip_playback_sent_packet_count_exceeds_packet_count");

    const invalidConfirmedPlayback = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.playback",
      timestamp: "2026-06-30T10:00:02.450Z",
      sipCallId: "sip-proof-1",
      outboundRtpReady: true,
      rtpSocketSendReady: true,
      packetCount: 2,
      sentPacketCount: 2,
      remoteHost: "127.0.0.1",
      remotePort: 40002,
      callerPlaybackConfirmed: true,
    });
    assert.equal(invalidConfirmedPlayback.statusCode, 400);
    assert.equal(invalidConfirmedPlayback.payload.error, "live_sip_playback_confirmation_evidence_required");

    const invalidConfirmedBroadcast = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.playback",
      timestamp: "2026-06-30T10:00:02.455Z",
      sipCallId: "sip-proof-1",
      outboundRtpReady: true,
      packetCount: 4,
      freeswitchBroadcast: {
        mode: "freeswitch_uuid_broadcast",
        audioBytes: 8,
      },
      callerPlaybackConfirmed: true,
      callerPlaybackEvidencePath: "artifacts/freeswitch-live/caller-playback-proof.json",
    });
    assert.equal(invalidConfirmedBroadcast.statusCode, 400);
    assert.equal(invalidConfirmedBroadcast.payload.error, "live_sip_playback_broadcast_evidence_incomplete");

    const invalidBroadcastEvidence = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.playback",
      timestamp: "2026-06-30T10:00:02.457Z",
      sipCallId: "sip-proof-1",
      outboundRtpReady: true,
      packetCount: 4,
      freeswitchBroadcast: {
        mode: "freeswitch_uuid_broadcast",
        freeswitchPath: "/var/log/freeswitch/acc/media/response.wav",
        audioBytes: 0,
      },
    });
    assert.equal(invalidBroadcastEvidence.statusCode, 400);
    assert.equal(invalidBroadcastEvidence.payload.error, "live_sip_playback_broadcast_evidence_incomplete");

    const invalidConfirmedBroadcastPacketization = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.playback",
      timestamp: "2026-06-30T10:00:02.458Z",
      sipCallId: "sip-proof-1",
      outboundRtpReady: true,
      packetCount: 0,
      freeswitchBroadcast: {
        mode: "freeswitch_uuid_broadcast",
        hostPath: "artifacts/freeswitch-live/media/response.wav",
        freeswitchPath: "/var/log/freeswitch/acc/media/response.wav",
        audioBytes: 3200,
      },
      callerPlaybackConfirmed: true,
      callerPlaybackEvidencePath: "artifacts/freeswitch-live/caller-playback-proof.json",
    });
    assert.equal(invalidConfirmedBroadcastPacketization.statusCode, 400);
    assert.equal(
      invalidConfirmedBroadcastPacketization.payload.error,
      "live_sip_playback_broadcast_packetization_evidence_incomplete",
    );

    const invalidPlaybackMissingHost = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.playback",
      timestamp: "2026-06-30T10:00:02.460Z",
      sipCallId: "sip-proof-1",
      outboundRtpReady: true,
      rtpSocketSendReady: true,
      packetCount: 2,
      sentPacketCount: 2,
      remotePort: 40002,
    });
    assert.equal(invalidPlaybackMissingHost.statusCode, 400);
    assert.equal(invalidPlaybackMissingHost.payload.error, "live_sip_playback_socket_send_evidence_incomplete");

    const invalidPlaybackPortZero = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.playback",
      timestamp: "2026-06-30T10:00:02.470Z",
      sipCallId: "sip-proof-1",
      outboundRtpReady: true,
      rtpSocketSendReady: true,
      packetCount: 2,
      sentPacketCount: 2,
      remotePort: 0,
    });
    assert.equal(invalidPlaybackPortZero.statusCode, 400);
    assert.equal(invalidPlaybackPortZero.payload.error, "live_sip_playback_remote_port_invalid");

    const invalidPlaybackPortTooHigh = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.playback",
      timestamp: "2026-06-30T10:00:02.480Z",
      sipCallId: "sip-proof-1",
      outboundRtpReady: true,
      rtpSocketSendReady: true,
      packetCount: 2,
      sentPacketCount: 2,
      remotePort: 65536,
    });
    assert.equal(invalidPlaybackPortTooHigh.statusCode, 400);
    assert.equal(invalidPlaybackPortTooHigh.payload.error, "live_sip_playback_remote_port_invalid");

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
    assert.equal(transcript.payload.call.session.runtimeModeLabels.rtcAsr, "rtc_asr_live");
    assert.equal(transcript.payload.call.events.some((event: any) => event.type === "rtc_asr_transcript" && event.detail.transcriptText === "I need help with a billing question."), true);
    assert.equal(transcript.payload.call.events.some((event: any) => event.type === "rtc_asr_transcript" && event.detail.previousRtcAsrMode === "rtc_asr_blocked" && event.detail.rtcAsrMode === "rtc_asr_live"), true);
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
      rtcAsr: "rtc_asr_live",
      credentialsMode: "mocked",
    });
    assert.equal(liveProof.audioCapture.status, "live_capture_attached");
    assert.equal(liveProof.audioCapture.audioWavPath, "artifacts/freeswitch-live/media/sip-proof-1.wav");
    assert.equal(liveProof.audioCapture.sipLogPath, "artifacts/freeswitch-live/freeswitch-esl-events.json");
    assert.equal(liveProof.playback.status, "caller_playback_confirmed");
    assert.equal(liveProof.playback.sentPacketCount, 3);
    assert.equal(liveProof.playback.remotePort, 40002);
    assert.equal(liveProof.playback.totalDurationMs, 60);
    assert.equal(liveProof.playback.ssrc, 0xacc0ffee);
    assert.equal(liveProof.playback.lastSentAt, "2026-06-30T10:00:02.220Z");
    assert.equal(liveProof.playback.callerPlaybackConfirmed, true);
    assert.equal(liveProof.playback.callerPlaybackEvidencePath, "artifacts/freeswitch-live/caller-playback-proof.json");
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

test("live SIP proof reports FreeSWITCH broadcast playback as confirmed", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-06-30T10:10:00.000Z",
      sipCallId: "sip-broadcast-proof",
      source: "freeswitch_esl",
      telephonyMode: "local_sip",
    });
    assert.equal(started.statusCode, 201);

    const capture = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.capture",
      timestamp: "2026-06-30T10:10:01.000Z",
      sipCallId: "sip-broadcast-proof",
      audioWavPath: "artifacts/freeswitch-live/media/sip-broadcast-proof.wav",
      sipLogPath: "artifacts/freeswitch-live/freeswitch-esl-events.json",
      rtpPacketCount: 24,
      generatedMedia: false,
    });
    assert.equal(capture.statusCode, 200);

    const playback = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.playback",
      timestamp: "2026-06-30T10:10:02.000Z",
      sipCallId: "sip-broadcast-proof",
      outboundRtpReady: true,
      packetCount: 4,
      freeswitchBroadcast: {
        mode: "freeswitch_uuid_broadcast",
        hostPath: "artifacts/freeswitch-live/media/response.wav",
        freeswitchPath: "/var/log/freeswitch/acc/media/response.wav",
        sampleRateHz: 8000,
        audioBytes: 3200,
      },
      callerPlaybackConfirmed: true,
      callerPlaybackEvidencePath: "artifacts/freeswitch-live/caller-playback-proof.json",
    });
    assert.equal(playback.statusCode, 200);

    const transcript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-06-30T10:10:03.000Z",
      sipCallId: "sip-broadcast-proof",
      text: "I need a live agent.",
      rtcAsrEvidencePath: "artifacts/freeswitch-live/rtc-asr-evidence.json",
    });
    assert.equal(transcript.statusCode, 200);

    const consoleResponse = await requestJson(address.port, "GET", "/api/operator/console?callId=" + started.payload.call.session.callId);
    assert.equal(consoleResponse.statusCode, 200);
    const liveProof = consoleResponse.payload.calls.items[0].liveProof;
    assert.equal(liveProof.playback.status, "caller_playback_confirmed");
    assert.equal(liveProof.playback.rtpSocketSendReady, false);
    assert.equal(liveProof.playback.freeswitchBroadcast.mode, "freeswitch_uuid_broadcast");
    assert.equal(liveProof.playback.freeswitchBroadcast.audioBytes, 3200);
    assert.equal(liveProof.eval.reviewReady, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP call.started and call.ended are idempotent for shared Verto and FreeSWITCH call ids", async () => {
  const originalDateNow = Date.now;
  let nowMs = Date.parse("2026-07-26T22:00:00.000Z");
  Date.now = () => nowMs;
  let server: ReturnType<typeof buildHttpServer> | undefined;

  try {
    server = buildHttpServer(loadPocConfig());
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const vertoStarted = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-26T22:00:00.000Z",
      sipCallId: "sip-verto-duplicate",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(vertoStarted.statusCode, 201);
    assert.equal(vertoStarted.payload.call.session.runtimeModeLabels.rtcAsr, "rtc_asr_live");
    assert.equal(
      vertoStarted.payload.call.events.some((event: any) => event.type === "call_bootstrapped" && event.detail.ingressSource === "freeswitch_verto"),
      true,
    );

    const freeswitchStarted = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-26T22:00:00.100Z",
      sipCallId: "sip-verto-duplicate",
      source: "freeswitch_esl",
      telephonyMode: "local_sip",
    });
    assert.equal(freeswitchStarted.statusCode, 200);
    assert.equal(freeswitchStarted.payload.idempotent, true);
    assert.equal(freeswitchStarted.payload.call.session.callId, vertoStarted.payload.call.session.callId);
    assert.equal(freeswitchStarted.payload.call.session.runtimeModeLabels.rtcAsr, "rtc_asr_live");

    const freeswitchALegStarted = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-26T22:00:00.200Z",
      sipCallId: "fs-a-leg-uuid",
      source: "freeswitch_esl",
      telephonyMode: "local_sip",
    });
    assert.equal(freeswitchALegStarted.statusCode, 201);
    assert.equal(freeswitchALegStarted.payload.call.session.providerCallId, "fs-a-leg-uuid");

    const vertoBLegStarted = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-26T22:00:00.300Z",
      sipCallId: "verto-b-leg-uuid",
      linkedSipCallId: "fs-a-leg-uuid",
      vertoCallId: "verto-b-leg-uuid",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(vertoBLegStarted.statusCode, 200);
    assert.equal(vertoBLegStarted.payload.idempotent, true);
    assert.equal(vertoBLegStarted.payload.call.session.callId, freeswitchALegStarted.payload.call.session.callId);
    assert.equal(vertoBLegStarted.payload.call.session.providerCallId, "fs-a-leg-uuid");
    assert.deepEqual(vertoBLegStarted.payload.correlationIds, ["fs-a-leg-uuid", "verto-b-leg-uuid"]);

    const vertoTranscript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-26T22:00:00.400Z",
      sipCallId: "verto-b-leg-uuid",
      text: "Transcript posted from the Verto leg.",
      rtcAsrEvidencePath: "artifacts/freeswitch-live/verto-rtc-asr-evidence.json",
    });
    assert.equal(vertoTranscript.statusCode, 200);
    assert.equal(vertoTranscript.payload.call.session.callId, freeswitchALegStarted.payload.call.session.callId);

    const vertoEnded = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: "2026-07-26T22:00:00.500Z",
      sipCallId: "verto-b-leg-uuid",
      linkedSipCallId: "fs-a-leg-uuid",
      vertoCallId: "verto-b-leg-uuid",
      hangupCause: "verto_peer_closed",
    });
    assert.equal(vertoEnded.statusCode, 200);
    assert.equal(vertoEnded.payload.call.session.callId, freeswitchALegStarted.payload.call.session.callId);
    assert.equal(vertoEnded.payload.call.events.filter((event: any) => event.type === "sip_call_ended").length, 1);

    const freeswitchDuplicateEnded = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: "2026-07-26T22:00:00.600Z",
      sipCallId: "fs-a-leg-uuid",
      hangupCause: "normal_clearing",
    });
    assert.equal(freeswitchDuplicateEnded.statusCode, 200);
    assert.equal(freeswitchDuplicateEnded.payload.idempotent, true);
    assert.equal(freeswitchDuplicateEnded.payload.call.events.filter((event: any) => event.type === "sip_call_ended").length, 1);

    const vertoDuplicateEnded = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: "2026-07-26T22:00:00.650Z",
      sipCallId: "verto-b-leg-uuid",
      hangupCause: "verto_duplicate_hangup",
    });
    assert.equal(vertoDuplicateEnded.statusCode, 200);
    assert.equal(vertoDuplicateEnded.payload.idempotent, true);
    assert.equal(vertoDuplicateEnded.payload.call.session.callId, freeswitchALegStarted.payload.call.session.callId);

    const staleVertoTranscript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-26T22:00:00.700Z",
      sipCallId: "verto-b-leg-uuid",
      text: "This should not attach to an already-ended call.",
    });
    assert.equal(staleVertoTranscript.statusCode, 400);
    assert.equal(staleVertoTranscript.payload.error, "live_sip_call_not_started");

    const staleALegTranscript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-26T22:00:00.750Z",
      sipCallId: "fs-a-leg-uuid",
      text: "This should not attach through the original A-leg alias either.",
    });
    assert.equal(staleALegTranscript.statusCode, 400);
    assert.equal(staleALegTranscript.payload.error, "live_sip_call_not_started");

    const delayedVertoStarted = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-26T22:00:00.800Z",
      sipCallId: "verto-b-leg-uuid",
      linkedSipCallId: "fs-a-leg-uuid",
      vertoCallId: "verto-b-leg-uuid",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(delayedVertoStarted.statusCode, 400);
    assert.equal(delayedVertoStarted.payload.error, "live_sip_call_already_ended");

    nowMs += 10 * 60 * 1000 + 1;

    const expiredVertoDuplicateEnded = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: "2026-07-26T22:10:01.000Z",
      sipCallId: "verto-b-leg-uuid",
      hangupCause: "late_verto_duplicate_hangup",
    });
    assert.equal(expiredVertoDuplicateEnded.statusCode, 400);
    assert.equal(expiredVertoDuplicateEnded.payload.error, "live_sip_call_not_started");

    const transcript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-26T22:00:01.000Z",
      sipCallId: "sip-verto-duplicate",
      text: "Hello from the same current call.",
      rtcAsrEvidencePath: "artifacts/freeswitch-live/rtc-asr-evidence.json",
    });
    assert.equal(transcript.statusCode, 200);
    assert.equal(transcript.payload.call.session.callId, vertoStarted.payload.call.session.callId);
    assert.equal(transcript.payload.call.events.some((event: any) => event.type === "rtc_asr_transcript"), true);

    const ended = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: "2026-07-26T22:00:02.000Z",
      sipCallId: "sip-verto-duplicate",
      hangupCause: "verto_peer_closed",
    });
    assert.equal(ended.statusCode, 200);
    assert.equal(ended.payload.call.events.some((event: any) => event.type === "sip_call_ended" && event.detail.hangupCause === "verto_peer_closed"), true);

    const duplicateEnded = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: "2026-07-26T22:00:02.100Z",
      sipCallId: "sip-verto-duplicate",
      hangupCause: "freeswitch_channel_hangup",
    });
    assert.equal(duplicateEnded.statusCode, 200);
    assert.equal(duplicateEnded.payload.idempotent, true);
    assert.equal(duplicateEnded.payload.call.session.callId, vertoStarted.payload.call.session.callId);
    assert.equal(duplicateEnded.payload.call.events.filter((event: any) => event.type === "sip_call_ended").length, 1);

    const [concurrentVertoStarted, concurrentFreeSwitchStarted] = await Promise.all([
      requestJson(address.port, "POST", "/api/live-sip/events", {
        eventType: "call.started",
        timestamp: "2026-07-26T22:01:00.000Z",
        sipCallId: "sip-verto-concurrent-start",
        source: "freeswitch_verto",
        telephonyMode: "local_sip",
        rtcAsrMode: "rtc_asr_live",
      }),
      requestJson(address.port, "POST", "/api/live-sip/events", {
        eventType: "call.started",
        timestamp: "2026-07-26T22:01:00.001Z",
        sipCallId: "sip-verto-concurrent-start",
        source: "freeswitch_esl",
        telephonyMode: "local_sip",
      }),
    ]);
    assert.ok([200, 201].includes(concurrentVertoStarted.statusCode));
    assert.ok([200, 201].includes(concurrentFreeSwitchStarted.statusCode));
    assert.equal(concurrentVertoStarted.payload.call.session.callId, concurrentFreeSwitchStarted.payload.call.session.callId);
    assert.equal(concurrentVertoStarted.payload.call.session.runtimeModeLabels.rtcAsr, "rtc_asr_live");

    const concurrentEndedStart = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-26T22:02:00.000Z",
      sipCallId: "sip-verto-concurrent-end",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(concurrentEndedStart.statusCode, 201);
    const [concurrentVertoEnded, concurrentFreeSwitchEnded] = await Promise.all([
      requestJson(address.port, "POST", "/api/live-sip/events", {
        eventType: "call.ended",
        timestamp: "2026-07-26T22:02:02.000Z",
        sipCallId: "sip-verto-concurrent-end",
        hangupCause: "verto_peer_closed",
      }),
      requestJson(address.port, "POST", "/api/live-sip/events", {
        eventType: "call.ended",
        timestamp: "2026-07-26T22:02:02.001Z",
        sipCallId: "sip-verto-concurrent-end",
        hangupCause: "freeswitch_channel_hangup",
      }),
    ]);
    assert.equal(concurrentVertoEnded.statusCode, 200);
    assert.equal(concurrentFreeSwitchEnded.statusCode, 200);
    assert.equal(concurrentVertoEnded.payload.call.session.callId, concurrentEndedStart.payload.call.session.callId);
    assert.equal(concurrentFreeSwitchEnded.payload.call.session.callId, concurrentEndedStart.payload.call.session.callId);
    assert.equal(concurrentVertoEnded.payload.call.events.filter((event: any) => event.type === "sip_call_ended").length, 1);
    assert.equal(concurrentFreeSwitchEnded.payload.call.events.filter((event: any) => event.type === "sip_call_ended").length, 1);
    assert.equal(concurrentVertoEnded.payload.idempotent || concurrentFreeSwitchEnded.payload.idempotent, true);
  } finally {
    Date.now = originalDateNow;
    if (server?.listening) {
      const runningServer = server;
      await new Promise<void>((resolve, reject) => runningServer.close((error) => error ? reject(error) : resolve()));
    }
  }
});

test("live SIP proof stays review-blocked until caller playback is confirmed", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-06-30T10:10:00.000Z",
      sipCallId: "sip-no-playback-proof",
      telephonyMode: "local_sip",
    });
    assert.equal(started.statusCode, 201);

    await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.capture",
      timestamp: "2026-06-30T10:10:01.000Z",
      sipCallId: "sip-no-playback-proof",
      rtpPacketCount: 12,
      generatedMedia: false,
    });
    await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-06-30T10:10:02.000Z",
      sipCallId: "sip-no-playback-proof",
      text: "I can hear the agent now.",
      rtcAsrEvidencePath: "artifacts/freeswitch-live/rtc-asr-evidence.json",
    });

    const consoleResponse = await requestJson(address.port, "GET", "/api/operator/console?callId=" + started.payload.call.session.callId);
    assert.equal(consoleResponse.statusCode, 200);
    const liveProof = consoleResponse.payload.calls.items[0].liveProof;
    assert.equal(liveProof.eval.status, "not_review_ready");
    assert.equal(liveProof.eval.reviewReady, false);
    assert.equal(liveProof.playback.status, "not_attempted");
    assert.ok(liveProof.caveats.includes("No caller-audible playback proof is attached yet."));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP prerecorded greeting advances context before the first caller turn", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-26T21:30:00.000Z",
      sipCallId: "sip-prerecorded-greeting",
      telephonyMode: "local_sip",
    });
    assert.equal(started.statusCode, 201);

    const greeting = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "agent.greeting",
      timestamp: "2026-07-26T21:30:00.100Z",
      sipCallId: "sip-prerecorded-greeting",
      text: "Hello, you are calling AgilityFeat.",
    });
    assert.equal(greeting.statusCode, 200);
    assert.equal(greeting.payload.call.flowState, "greet");
    assert.deepEqual(greeting.payload.call.transcript, [{
      speaker: "agent",
      text: "Hello, you are calling AgilityFeat.",
      timestamp: "2026-07-26T21:30:00.100Z",
    }]);
    assert.equal(greeting.payload.call.events.at(-1).detail.reason, "prerecorded_intro_delivered");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP separates 8611 scripted flow from 8600 OpenAI flow", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_CONVERSATION_MODEL: process.env.ACC_OPENAI_CONVERSATION_MODEL,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  const openAiRequests: any[] = [];
  const openAiServer = createTestServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      openAiRequests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-live-8600", output_text: "I can help review that safely. What account detail should I check first?" }));
    });
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  const openAiAddress = openAiServer.address();
  assert.ok(openAiAddress && typeof openAiAddress !== "string");

  process.env.ACC_OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${openAiAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ACC_OPENAI_CONVERSATION_MODEL;
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const scriptedStarted = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T22:30:00.000Z",
      sipCallId: "sip-scripted-8611",
      destination: "8611",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(scriptedStarted.statusCode, 201);
    assert.equal(scriptedStarted.payload.call.scenario.conversationMode, "scripted");
    assert.equal(scriptedStarted.payload.call.scenario.sipExtension, "8611");

    const scriptedTranscript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-27T22:30:01.000Z",
      sipCallId: "sip-scripted-8611",
      text: "I'm thinking about canceling my policy.",
    });
    assert.equal(scriptedTranscript.statusCode, 200);
    assert.equal(
      scriptedTranscript.payload.call.transcript.at(-1).text,
      "I can help with that. Before I review options, what is pushing you to cancel today?",
    );
    assert.equal(openAiRequests.length, 0);

    const llmStarted = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T22:31:00.000Z",
      sipCallId: "sip-openai-8600",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(llmStarted.statusCode, 201);
    assert.equal(llmStarted.payload.call.scenario.conversationMode, "openai_llm");
    assert.equal(llmStarted.payload.call.scenario.sipExtension, "8600");

    const llmTranscript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-27T22:31:01.000Z",
      sipCallId: "sip-openai-8600",
      text: "I need help changing my account address.",
    });
    assert.equal(llmTranscript.statusCode, 200);
    assert.equal(
      llmTranscript.payload.call.transcript.at(-1).text,
      "I can help review that safely. What account detail should I check first?",
    );
    assert.equal(openAiRequests.length, 1);
    assert.equal(openAiRequests[0].url, "/v1/responses");
    assert.equal(openAiRequests[0].authorization, "Bearer test-openai-key");
    assert.equal(openAiRequests[0].body.model, "GPT-5.4-mini");
    assert.equal(
      llmTranscript.payload.call.events.some((event: any) => event.type === "openai_conversation_turn_processed" && event.detail.model === "GPT-5.4-mini"),
      true,
    );
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => openAiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP 8600 can use the OpenClaw OAuth Responses gateway", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_CONVERSATION_MODEL: process.env.ACC_OPENAI_CONVERSATION_MODEL,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  const gatewayRequests: any[] = [];
  const gatewayServer = createTestServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      gatewayRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
        agentId: req.headers["x-openclaw-agent-id"],
        backendModel: req.headers["x-openclaw-model"],
        body: JSON.parse(body),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-openclaw-oauth", output_text: "I can help safely through the live path. What should I verify first?" }));
    });
  });
  await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gatewayServer.address();
  assert.ok(gatewayAddress && typeof gatewayAddress !== "string");

  process.env.ACC_OPENAI_AUTH_MODE = "openclaw_oauth";
  process.env.ACC_OPENAI_AUTH_TOKEN = "test-openclaw-gateway-token";
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.ACC_OPENCLAW_AGENT_ID = "acc-voice";
  process.env.ACC_OPENAI_CONVERSATION_MODEL = "GPT-5.4-mini";
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${gatewayAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ACC_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T22:35:00.000Z",
      sipCallId: "sip-openclaw-oauth-8600",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    assert.equal(started.payload.call.scenario.conversationMode, "openai_llm");

    const transcript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-27T22:35:01.000Z",
      sipCallId: "sip-openclaw-oauth-8600",
      text: "Can you check my policy address?",
    });
    assert.equal(transcript.statusCode, 200);
    assert.equal(
      transcript.payload.call.transcript.at(-1).text,
      "I can help safely through the live path. What should I verify first?",
    );
    assert.equal(gatewayRequests.length, 1);
    assert.equal(gatewayRequests[0].url, "/v1/responses");
    assert.equal(gatewayRequests[0].authorization, "Bearer test-openclaw-gateway-token");
    assert.equal(gatewayRequests[0].agentId, "acc-voice");
    assert.equal(gatewayRequests[0].backendModel, "openai/gpt-5.4-mini");
    assert.equal(gatewayRequests[0].body.model, "openclaw/acc-voice");
    assert.equal(typeof gatewayRequests[0].body.input, "string");
    assert.match(gatewayRequests[0].body.input, /Latest caller turn: Can you check my policy address\?/);
    assert.equal(
      transcript.payload.call.events.some((event: any) => event.type === "openai_conversation_turn_processed" && event.detail.model === "GPT-5.4-mini"),
      true,
    );
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => gatewayServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP 8600 fails closed when OpenAI credentials are missing", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  delete process.env.ACC_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T22:40:00.000Z",
      sipCallId: "sip-openai-missing-key",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);

    const transcript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-27T22:40:01.000Z",
      sipCallId: "sip-openai-missing-key",
      text: "Can you cancel my policy?",
    });
    assert.equal(transcript.statusCode, 200);
    assert.equal(transcript.payload.call.flowState, "wrap");
    assert.equal(
      transcript.payload.call.events.some((event: any) => event.type === "openai_conversation_generation_failed" && event.detail.error === "openai_api_key_missing"),
      true,
    );
    assert.equal(
      transcript.payload.call.transcript.some((turn: any) => turn.speaker === "agent" && /Before I review options/.test(turn.text)),
      false,
    );
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP 8600 fails closed when OpenClaw OAuth gateway token is missing", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  process.env.ACC_OPENAI_AUTH_MODE = "openclaw_oauth";
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENCLAW_AGENT_ID = "acc-voice";

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T22:42:00.000Z",
      sipCallId: "sip-openclaw-missing-token",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);

    const transcript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-27T22:42:01.000Z",
      sipCallId: "sip-openclaw-missing-token",
      text: "Can you cancel my policy?",
    });
    assert.equal(transcript.statusCode, 200);
    assert.equal(transcript.payload.call.flowState, "wrap");
    assert.equal(
      transcript.payload.call.events.some((event: any) => event.type === "openai_conversation_generation_failed" && event.detail.error === "openclaw_gateway_token_missing"),
      true,
    );
    assert.equal(
      transcript.payload.call.transcript.some((turn: any) => turn.speaker === "agent" && /Before I review options/.test(turn.text)),
      false,
    );
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("delivery-ack commits must match the server-side OpenAI preview", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  const openAiServer = createTestServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-bound-preview", output_text: "I can help with that safely. What should I review first?" }));
    });
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  const openAiAddress = openAiServer.address();
  assert.ok(openAiAddress && typeof openAiAddress !== "string");

  process.env.ACC_OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${openAiAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T22:50:00.000Z",
      sipCallId: "sip-openai-delivery-ack",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    const callId = started.payload.call.session.callId;

    const preview = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Can you help with my account?",
      timestamp: "2026-07-27T22:50:01.000Z",
      commitMode: "delivery_ack",
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.payload.callerTurnCommit.conversationMode, "openai_llm");
    assert.equal(preview.payload.callerTurnCommit.expectedAgentText, "I can help with that safely. What should I review first?");

    const tampered = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn/commit`, {
      text: "Can you help with my account?",
      timestamp: "2026-07-27T22:50:01.000Z",
      expectedSnapshotVersion: preview.payload.callerTurnCommit.snapshotVersion,
      expectedAgentText: "I guarantee I can give you a refund.",
    });
    assert.equal(tampered.statusCode, 400);
    assert.equal(tampered.payload.error, "caller_turn_commit_stale");

    const committed = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn/commit`, {
      text: "Can you help with my account?",
      timestamp: "2026-07-27T22:50:01.000Z",
      expectedSnapshotVersion: preview.payload.callerTurnCommit.snapshotVersion,
      expectedAgentText: preview.payload.callerTurnCommit.expectedAgentText,
    });
    assert.equal(committed.statusCode, 200);
    assert.equal(committed.payload.transcript.at(-1).text, "I can help with that safely. What should I review first?");
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => openAiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("delivery-ack OpenAI previews reject a concurrent preview for the same snapshot", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  const openAiServer = createTestServer((req, res) => {
    req.resume();
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "resp-concurrent-preview", output_text: "I can help with the live AI path." }));
      }, 25);
    });
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  const openAiAddress = openAiServer.address();
  assert.ok(openAiAddress && typeof openAiAddress !== "string");

  process.env.ACC_OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${openAiAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T22:51:00.000Z",
      sipCallId: "sip-openai-concurrent-delivery-ack",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    const callId = started.payload.call.session.callId;

    const [first, second] = await Promise.all([
      requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
        text: "Can you help with my account?",
        timestamp: "2026-07-27T22:51:01.000Z",
        commitMode: "delivery_ack",
      }),
      requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
        text: "Can you also update my address?",
        timestamp: "2026-07-27T22:51:02.000Z",
        commitMode: "delivery_ack",
      }),
    ]);
    const accepted = [first, second].find((result) => result.statusCode === 200);
    const rejected = [first, second].find((result) => result.statusCode === 409);
    assert.ok(accepted);
    assert.ok(rejected);
    assert.equal(rejected.payload.error, "caller_turn_delivery_ack_preview_pending");
    assert.equal(rejected.payload.callerTurnCommit.snapshotVersion, accepted.payload.callerTurnCommit.snapshotVersion);

    const committed = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn/commit`, {
      text: accepted.payload.callerTurnCommit.callerTranscript,
      timestamp: accepted.payload.callerTurnCommit.timestamp,
      expectedSnapshotVersion: accepted.payload.callerTurnCommit.snapshotVersion,
      expectedAgentText: accepted.payload.callerTurnCommit.expectedAgentText,
    });
    assert.equal(committed.statusCode, 200);
    assert.equal(
      committed.payload.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === rejected.payload.callerTurnCommit.callerTranscript),
      false,
    );
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => openAiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP immediate OpenAI caller turns serialize concurrent generation per call", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  let resolveFirstOpenAiRequest: (() => void) | null = null;
  const firstOpenAiRequestSeen = new Promise<void>((resolve) => {
    resolveFirstOpenAiRequest = resolve;
  });
  const openAiServer = createTestServer((req, res) => {
    let collected = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      collected += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(collected) as { input?: unknown };
      const input = payload.input;
      const userPromptText = Array.isArray(input)
        ? input.find((entry): entry is { role?: string; content?: Array<{ type?: string; text?: string }> } => {
            return typeof entry === "object" && entry !== null && "role" in entry && (entry as { role?: unknown }).role === "user";
          })?.content?.[0]?.text ?? ""
        : typeof input === "string"
          ? input
          : "";
      const latestCallerTurn = userPromptText.match(/Latest caller turn:\s*([^\n]+)/)?.[1]?.trim() ?? "";
      const firstTurn = latestCallerTurn === "Can you help with my account?";
      if (firstTurn) resolveFirstOpenAiRequest?.();
      const responseText = firstTurn ? "First live AI response." : "Second live AI response.";
      const delayMs = firstTurn ? 50 : 0;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: firstTurn ? "resp-live-serial-1" : "resp-live-serial-2",
          output_text: responseText,
        }));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  const openAiAddress = openAiServer.address();
  assert.ok(openAiAddress && typeof openAiAddress !== "string");

  process.env.ACC_OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${openAiAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T23:01:00.000Z",
      sipCallId: "sip-openai-immediate-serial",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    const callId = started.payload.call.session.callId;

    const firstTurnRequest = requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Can you help with my account?",
      timestamp: "2026-07-27T23:01:01.000Z",
    });
    await firstOpenAiRequestSeen;
    const secondTurnRequest = requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Can you also update my address?",
      timestamp: "2026-07-27T23:01:02.000Z",
    });
    const [first, second] = await Promise.all([firstTurnRequest, secondTurnRequest]);

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);

    const firstPayload = first.payload as {
      transcript: Array<{ speaker: string; text: string }>;
      events: Array<{ type: string }>;
    };
    const secondPayload = second.payload as {
      transcript: Array<{ speaker: string; text: string }>;
      events: Array<{ type: string }>;
    };
    const combinedCall = secondPayload.transcript.length > firstPayload.transcript.length ? secondPayload : firstPayload;

    assert.equal(combinedCall.transcript.length, 4);
    assert.deepEqual(
      combinedCall.transcript.map((turn: { speaker: string }) => turn.speaker),
      ["caller", "agent", "caller", "agent"],
    );
    assert.deepEqual(
      combinedCall.transcript.map((turn: { text: string }) => turn.text),
      [
        "Can you help with my account?",
        "First live AI response.",
        "Can you also update my address?",
        "Second live AI response.",
      ],
    );
    assert.equal(
      combinedCall.events.filter((event: { type: string }) => event.type === "caller_turn_appended").length,
      2,
    );
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => openAiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP media transcript OpenAI generation serializes with immediate caller turns", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  const mediaTranscriptOpenAiGate: { release?: () => void } = {};
  let mediaTranscriptOpenAiReleased = false;
  let directOpenAiRequestSeenBeforeRelease = false;
  let resolveMediaTranscriptOpenAiSeen!: () => void;
  const mediaTranscriptOpenAiSeen = new Promise<void>((resolve) => {
    resolveMediaTranscriptOpenAiSeen = resolve;
  });
  const openAiServer = createTestServer((req, res) => {
    let collected = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      collected += chunk;
    });
    req.on("end", () => {
      void (async () => {
        const payload = JSON.parse(collected) as { input?: unknown };
        const input = payload.input;
        const userPromptText = Array.isArray(input)
          ? input.find((entry): entry is { role?: string; content?: Array<{ type?: string; text?: string }> } => {
              return typeof entry === "object" && entry !== null && "role" in entry && (entry as { role?: unknown }).role === "user";
            })?.content?.[0]?.text ?? ""
          : typeof input === "string"
            ? input
            : "";
        const latestCallerTurn = userPromptText.match(/Latest caller turn:\s*([^\n]+)/)?.[1]?.trim() ?? "";
        if (latestCallerTurn === "Legacy media transcript turn") {
          resolveMediaTranscriptOpenAiSeen();
          await new Promise<void>((release) => {
            mediaTranscriptOpenAiGate.release = release;
          });
          mediaTranscriptOpenAiReleased = true;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "resp-media-transcript-serial",
            output_text: "Legacy media transcript response.",
          }));
          return;
        }
        if (!mediaTranscriptOpenAiReleased) directOpenAiRequestSeenBeforeRelease = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "resp-media-transcript-direct",
          output_text: "Direct response after media transcript.",
        }));
      })().catch((error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  const openAiAddress = openAiServer.address();
  assert.ok(openAiAddress && typeof openAiAddress !== "string");

  process.env.ACC_OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${openAiAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T23:01:30.000Z",
      sipCallId: "sip-openai-media-transcript-serial",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    const callId = started.payload.call.session.callId;

    const mediaTranscriptRequest = requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-27T23:01:31.000Z",
      sipCallId: "sip-openai-media-transcript-serial",
      text: "Legacy media transcript turn",
      rtcAsrEvidencePath: "artifacts/live-sip/media-transcript-final.json",
    });
    await mediaTranscriptOpenAiSeen;
    const directTurnRequest = requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Direct overlapping test turn",
      timestamp: "2026-07-27T23:01:32.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(directOpenAiRequestSeenBeforeRelease, false);
    mediaTranscriptOpenAiGate.release?.();

    const [mediaTranscript, directTurn] = await Promise.all([mediaTranscriptRequest, directTurnRequest]);
    assert.equal(mediaTranscript.statusCode, 200);
    assert.equal(directTurn.statusCode, 200);
    assert.deepEqual(
      directTurn.payload.transcript.map((turn: { text: string }) => turn.text),
      [
        "Legacy media transcript turn",
        "Legacy media transcript response.",
        "Direct overlapping test turn",
        "Direct response after media transcript.",
      ],
    );
  } finally {
    mediaTranscriptOpenAiGate.release?.();
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => openAiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP media transcript OpenAI generation does not block hangup lifecycle events", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  const mediaTranscriptOpenAiGate: { release?: () => void } = {};
  let resolveMediaTranscriptOpenAiSeen!: () => void;
  const mediaTranscriptOpenAiSeen = new Promise<void>((resolve) => {
    resolveMediaTranscriptOpenAiSeen = resolve;
  });
  const openAiServer = createTestServer((req, res) => {
    let collected = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      collected += chunk;
    });
    req.on("end", () => {
      void (async () => {
        resolveMediaTranscriptOpenAiSeen();
        await new Promise<void>((release) => {
          mediaTranscriptOpenAiGate.release = release;
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "resp-media-transcript-hangup",
          output_text: "This response should not be appended after hangup.",
        }));
      })().catch((error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  const openAiAddress = openAiServer.address();
  assert.ok(openAiAddress && typeof openAiAddress !== "string");

  process.env.ACC_OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${openAiAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T23:01:40.000Z",
      sipCallId: "sip-openai-media-transcript-hangup",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);

    const mediaTranscriptRequest = requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-27T23:01:41.000Z",
      sipCallId: "sip-openai-media-transcript-hangup",
      text: "Slow legacy media transcript",
    });
    await mediaTranscriptOpenAiSeen;

    const endedRequest = requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: "2026-07-27T23:01:42.000Z",
      sipCallId: "sip-openai-media-transcript-hangup",
    });
	    const endedBeforeRelease = await Promise.race([
	      endedRequest,
	      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
	    ]);
	    if (endedBeforeRelease === "timeout") {
	      assert.fail("call.ended was blocked behind pending media.transcript OpenAI generation");
	    }
	    assert.equal(endedBeforeRelease.statusCode, 200);
    mediaTranscriptOpenAiGate.release?.();

    const mediaTranscript = await mediaTranscriptRequest;
    assert.equal(mediaTranscript.statusCode, 400);
    assert.equal(mediaTranscript.payload.error, "live_sip_call_not_started");
  } finally {
    mediaTranscriptOpenAiGate.release?.();
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => openAiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP delivery-ack OpenAI previews serialize with immediate caller turns", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  const deliveryAckOpenAiGate: { release?: () => void } = {};
  let deliveryAckOpenAiReleased = false;
  let secondOpenAiRequestSeenBeforeRelease = false;
  let resolveDeliveryAckOpenAiSeen!: () => void;
  const deliveryAckOpenAiSeen = new Promise<void>((resolve) => {
    resolveDeliveryAckOpenAiSeen = resolve;
  });
  const openAiServer = createTestServer((req, res) => {
    let collected = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      collected += chunk;
    });
    req.on("end", () => {
      void (async () => {
        const payload = JSON.parse(collected) as { input?: unknown };
        const input = payload.input;
        const userPromptText = Array.isArray(input)
          ? input.find((entry): entry is { role?: string; content?: Array<{ type?: string; text?: string }> } => {
              return typeof entry === "object" && entry !== null && "role" in entry && (entry as { role?: unknown }).role === "user";
            })?.content?.[0]?.text ?? ""
          : typeof input === "string"
            ? input
            : "";
        const latestCallerTurn = userPromptText.match(/Latest caller turn:\s*([^\n]+)/)?.[1]?.trim() ?? "";
        if (latestCallerTurn === "Can you help with billing?") {
          resolveDeliveryAckOpenAiSeen();
          await new Promise<void>((release) => {
            deliveryAckOpenAiGate.release = release;
          });
          deliveryAckOpenAiReleased = true;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "resp-delivery-ack-serial-preview",
            output_text: "Delivery ack preview response.",
          }));
          return;
        }
        if (!deliveryAckOpenAiReleased) secondOpenAiRequestSeenBeforeRelease = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "resp-delivery-ack-serial-immediate",
          output_text: "Immediate response after delivery ack preview.",
        }));
      })().catch((error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  const openAiAddress = openAiServer.address();
  assert.ok(openAiAddress && typeof openAiAddress !== "string");

  process.env.ACC_OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${openAiAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T23:02:00.000Z",
      sipCallId: "sip-openai-delivery-ack-serial",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    const callId = started.payload.call.session.callId;

    const previewRequest = requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Can you help with billing?",
      timestamp: "2026-07-27T23:02:01.000Z",
      commitMode: "delivery_ack",
    });
    await deliveryAckOpenAiSeen;
    const immediateRequest = requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Can you also update my address?",
      timestamp: "2026-07-27T23:02:02.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondOpenAiRequestSeenBeforeRelease, false);
    deliveryAckOpenAiGate.release?.();

    const [preview, immediate] = await Promise.all([previewRequest, immediateRequest]);
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.payload.callerTurnCommit.status, "pending");
    assert.equal(preview.payload.callerTurnCommit.expectedAgentText, "Delivery ack preview response.");
    assert.equal(immediate.statusCode, 200);
    assert.deepEqual(
      immediate.payload.transcript.map((turn: { text: string }) => turn.text),
      ["Can you also update my address?", "Immediate response after delivery ack preview."],
    );
  } finally {
    deliveryAckOpenAiGate.release?.();
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => openAiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("delivery-ack OpenAI failures persist fail-closed state before audible commit", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  delete process.env.ACC_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T22:52:00.000Z",
      sipCallId: "sip-openai-delivery-fail-closed",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    const callId = started.payload.call.session.callId;

    const preview = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Can you help with my account?",
      timestamp: "2026-07-27T22:52:01.000Z",
      commitMode: "delivery_ack",
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.payload.callerTurnCommit.status, "pending");
    assert.match(preview.payload.callerTurnCommit.expectedAgentText, /live AI path/);
    assert.match(preview.payload.transcript.at(-1).text, /live AI path/);

    const fetchedBeforeCommit = await requestJson(address.port, "GET", `/api/calls/${callId}`);
    assert.equal(fetchedBeforeCommit.statusCode, 200);
    assert.equal(fetchedBeforeCommit.payload.flowState, "wrap");
    assert.equal(fetchedBeforeCommit.payload.demoFallback.armed, true);
    assert.deepEqual(fetchedBeforeCommit.payload.transcript, []);
    assert.equal(
      fetchedBeforeCommit.payload.events.some((event: any) => event.type === "openai_conversation_generation_failed" && event.detail.error === "openai_api_key_missing"),
      true,
    );
    assert.equal(
      fetchedBeforeCommit.payload.events.some((event: any) => event.type === "human_handoff_started" && event.detail.source === "openai_llm_fail_closed"),
      true,
    );

    const committed = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn/commit`, {
      text: "Can you help with my account?",
      timestamp: "2026-07-27T22:52:01.000Z",
      expectedSnapshotVersion: preview.payload.callerTurnCommit.snapshotVersion,
      expectedAgentText: preview.payload.callerTurnCommit.expectedAgentText,
    });
    assert.equal(committed.statusCode, 200);
    assert.equal(committed.payload.transcript.length, 2);
    assert.equal(committed.payload.transcript[0].text, "Can you help with my account?");
    assert.match(committed.payload.transcript[1].text, /live AI path/);
    assert.equal(
      committed.payload.events.filter((event: any) => event.type === "openai_conversation_generation_failed").length,
      1,
    );

    const heldTurn = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Are you still automating?",
      timestamp: "2026-07-27T22:52:02.000Z",
    });
    assert.equal(heldTurn.statusCode, 409);
    assert.equal(heldTurn.payload.error, "live_sip_openai_automation_stopped");
    assert.equal(
      heldTurn.payload.call.transcript.some((turn: any) => turn.text === "Are you still automating?"),
      false,
    );

    const resumed = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "resume",
      timestamp: "2026-07-27T22:52:03.000Z",
      reason: "operator approved automation resume",
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.payload.flowState, "steered_response");
    assert.equal(resumed.payload.demoFallback.armed, false);
    assert.equal(
      resumed.payload.events.some((event: any) => event.type === "demo_fallback_disarmed" && event.detail.source === "operator_resume"),
      true,
    );

    const resumedTurn = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      text: "Continue after resume.",
      timestamp: "2026-07-27T22:52:04.000Z",
    });
    assert.equal(resumedTurn.statusCode, 200);
    assert.notEqual(resumedTurn.payload.error, "live_sip_operator_hold_active");

    const secondStarted = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T22:53:00.000Z",
      sipCallId: "sip-openai-delivery-fail-closed-disarm",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(secondStarted.statusCode, 201);
    const secondCallId = secondStarted.payload.call.session.callId;
    const secondFailure = await requestJson(address.port, "POST", `/api/calls/${secondCallId}/caller-turn`, {
      text: "Trigger a second fail-closed hold.",
      timestamp: "2026-07-27T22:53:01.000Z",
    });
    assert.equal(secondFailure.statusCode, 200);
    assert.equal(secondFailure.payload.demoFallback.armed, true);

    const disarmed = await requestJson(address.port, "POST", `/api/calls/${secondCallId}/operator-steer`, {
      action: "disarm_fallback",
      timestamp: "2026-07-27T22:53:02.000Z",
    });
    assert.equal(disarmed.statusCode, 200);
    assert.equal(disarmed.payload.flowState, "steered_response");
    assert.equal(disarmed.payload.demoFallback.armed, false);

    const disarmedTurn = await requestJson(address.port, "POST", `/api/calls/${secondCallId}/caller-turn`, {
      text: "Continue after disarm.",
      timestamp: "2026-07-27T22:53:03.000Z",
    });
    assert.equal(disarmedTurn.statusCode, 200);
    assert.notEqual(disarmedTurn.payload.error, "live_sip_operator_hold_active");
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP 8600 fails closed when OpenAI stalls", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_REQUEST_TIMEOUT_MS: process.env.ACC_OPENAI_REQUEST_TIMEOUT_MS,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  let openAiRequestCount = 0;
  const openAiServer = createTestServer((req) => {
    openAiRequestCount += 1;
    req.resume();
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  const openAiAddress = openAiServer.address();
  assert.ok(openAiAddress && typeof openAiAddress !== "string");

  process.env.ACC_OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${openAiAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  process.env.ACC_OPENAI_REQUEST_TIMEOUT_MS = "25";
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T22:55:00.000Z",
      sipCallId: "sip-openai-timeout",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    const callId = started.payload.call.session.callId;

    const transcript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-27T22:55:01.000Z",
      sipCallId: "sip-openai-timeout",
      text: "Can you help with my claim?",
    });
    assert.equal(transcript.statusCode, 200);
    assert.equal(
      transcript.payload.call.events.some((event: any) => event.type === "openai_conversation_generation_failed" && event.detail.error === "openai_request_timeout"),
      true,
    );
    assert.equal(transcript.payload.call.flowState, "wrap");
    assert.equal(openAiRequestCount, 1);

    const heldTranscript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-27T22:55:03.000Z",
      sipCallId: "sip-openai-timeout",
      text: "Are you still there?",
    });
    assert.equal(heldTranscript.statusCode, 409);
    assert.equal(heldTranscript.payload.error, "live_sip_openai_automation_stopped");
    assert.equal(openAiRequestCount, 1);
    assert.equal(
      heldTranscript.payload.call.events.some((event: any) => event.type === "rtc_asr_transcript" && event.detail.held === true),
      true,
    );
    assert.equal(
      heldTranscript.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === "Are you still there?"),
      false,
    );

    const directHeldTranscript = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      timestamp: "2026-07-27T22:55:04.000Z",
      text: "Can automation resume?",
      conversationMode: "openai_llm",
    });
    assert.equal(directHeldTranscript.statusCode, 409);
    assert.equal(directHeldTranscript.payload.error, "live_sip_openai_automation_stopped");
    assert.equal(openAiRequestCount, 1);
    assert.equal(
      directHeldTranscript.payload.call.events.some((event: any) => event.type === "rtc_asr_transcript" && event.detail.held === true),
      true,
    );
    assert.equal(
      directHeldTranscript.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === "Can automation resume?"),
      false,
    );

    const overrideHeldTranscript = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      timestamp: "2026-07-27T22:55:05.000Z",
      text: "Can a scripted response resume?",
      conversationMode: "scripted",
    });
    assert.equal(overrideHeldTranscript.statusCode, 409);
    assert.equal(overrideHeldTranscript.payload.error, "live_sip_openai_automation_stopped");
    assert.equal(openAiRequestCount, 1);
    assert.equal(
      overrideHeldTranscript.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === "Can a scripted response resume?"),
      false,
    );

    const ended = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: "2026-07-27T22:55:06.000Z",
      sipCallId: "sip-openai-timeout",
      reason: "caller_hangup",
    });
    assert.equal(ended.statusCode, 200);

    const postEndTurn = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      timestamp: "2026-07-27T22:55:07.000Z",
      text: "Can anyone still hear me?",
      conversationMode: "openai_llm",
    });
    assert.equal(postEndTurn.statusCode, 409);
    assert.equal(postEndTurn.payload.error, "live_sip_call_ended");
    assert.equal(openAiRequestCount, 1);
    assert.equal(
      postEndTurn.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === "Can anyone still hear me?"),
      false,
    );
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => openAiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("direct OpenAI caller turns recheck SIP termination after async generation", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_REQUEST_TIMEOUT_MS: process.env.ACC_OPENAI_REQUEST_TIMEOUT_MS,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };

  let releaseOpenAiResponse: () => void = () => {
    throw new Error("OpenAI response release requested before request was received");
  };
  let openAiRequestCount = 0;
  let markOpenAiRequestSeen: (() => void) | null = null;
  const openAiRequestSeen = new Promise<void>((resolve) => { markOpenAiRequestSeen = resolve; });
  const openAiServer = createTestServer((req, res) => {
    openAiRequestCount += 1;
    req.resume();
    releaseOpenAiResponse = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-ended-call", output_text: "I can help safely after checking the account." }));
    };
    markOpenAiRequestSeen?.();
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  const openAiAddress = openAiServer.address();
  assert.ok(openAiAddress && typeof openAiAddress !== "string");

  process.env.ACC_OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${openAiAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  process.env.ACC_OPENAI_REQUEST_TIMEOUT_MS = "5000";
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T22:58:00.000Z",
      sipCallId: "sip-openai-ended-midflight",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    const callId = started.payload.call.session.callId;

    const turnRequest = requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      timestamp: "2026-07-27T22:58:01.000Z",
      text: "Can you keep helping me?",
      conversationMode: "openai_llm",
    });
    await openAiRequestSeen;

    const ended = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: "2026-07-27T22:58:02.000Z",
      sipCallId: "sip-openai-ended-midflight",
      reason: "caller_hangup",
    });
    assert.equal(ended.statusCode, 200);

    releaseOpenAiResponse();
    const rejectedTurn = await turnRequest;
    assert.equal(rejectedTurn.statusCode, 409);
    assert.equal(rejectedTurn.payload.error, "live_sip_call_ended");
    assert.equal(openAiRequestCount, 1);
    assert.equal(
      rejectedTurn.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === "Can you keep helping me?"),
      false,
    );
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => openAiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("direct OpenAI caller turns preserve operator holds after async generation", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_REQUEST_TIMEOUT_MS: process.env.ACC_OPENAI_REQUEST_TIMEOUT_MS,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };

  let releaseOpenAiResponse: () => void = () => {
    throw new Error("OpenAI response release requested before request was received");
  };
  let markOpenAiRequestSeen: (() => void) | null = null;
  const openAiRequestSeen = new Promise<void>((resolve) => { markOpenAiRequestSeen = resolve; });
  const openAiServer = createTestServer((req, res) => {
    req.resume();
    releaseOpenAiResponse = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-operator-hold", output_text: "I can keep helping safely." }));
    };
    markOpenAiRequestSeen?.();
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  const openAiAddress = openAiServer.address();
  assert.ok(openAiAddress && typeof openAiAddress !== "string");

  process.env.ACC_OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${openAiAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  process.env.ACC_OPENAI_REQUEST_TIMEOUT_MS = "5000";
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T23:00:00.000Z",
      sipCallId: "sip-openai-operator-hold",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    const callId = started.payload.call.session.callId;

    const turnRequest = requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      timestamp: "2026-07-27T23:00:01.000Z",
      text: "Can you keep helping me?",
      conversationMode: "openai_llm",
    });
    await openAiRequestSeen;

    const paused = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "pause",
      timestamp: "2026-07-27T23:00:02.000Z",
      reason: "operator needs to review before automation continues",
    });
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.payload.flowState, "policy_hold");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    releaseOpenAiResponse();
    const rejectedTurn = await turnRequest;
    assert.equal(rejectedTurn.statusCode, 409);
    assert.equal(rejectedTurn.payload.error, "live_sip_operator_hold_active");
    assert.equal(
      rejectedTurn.payload.call.events.some((event: any) => event.type === "rtc_asr_transcript" && event.detail.held === true && event.detail.holdReason === "operator_policy_hold_active"),
      true,
    );
    assert.equal(
      rejectedTurn.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === "Can you keep helping me?"),
      false,
    );
    assert.equal(
      rejectedTurn.payload.call.transcript.some((turn: any) => turn.speaker === "agent" && turn.text === "I can keep helping safely."),
      false,
    );
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => openAiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP media transcripts preserve operator holds after async OpenAI generation", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_REQUEST_TIMEOUT_MS: process.env.ACC_OPENAI_REQUEST_TIMEOUT_MS,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };

  let releaseOpenAiResponse: () => void = () => {
    throw new Error("OpenAI response release requested before request was received");
  };
  let markOpenAiRequestSeen: (() => void) | null = null;
  const openAiRequestSeen = new Promise<void>((resolve) => { markOpenAiRequestSeen = resolve; });
  const openAiServer = createTestServer((req, res) => {
    req.resume();
    releaseOpenAiResponse = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp-media-operator-hold", output_text: "I can continue the live call safely." }));
    };
    markOpenAiRequestSeen?.();
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  const openAiAddress = openAiServer.address();
  assert.ok(openAiAddress && typeof openAiAddress !== "string");

  process.env.ACC_OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${openAiAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  process.env.ACC_OPENAI_REQUEST_TIMEOUT_MS = "5000";
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T23:02:00.000Z",
      sipCallId: "sip-openai-media-operator-hold",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    const callId = started.payload.call.session.callId;

    const transcriptRequest = requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-27T23:02:01.000Z",
      sipCallId: "sip-openai-media-operator-hold",
      text: "Can you keep helping me on this call?",
    });
    await openAiRequestSeen;

    const paused = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "pause",
      timestamp: "2026-07-27T23:02:02.000Z",
      reason: "operator needs to review before media automation continues",
    });
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.payload.flowState, "policy_hold");

    releaseOpenAiResponse();
    const rejectedTranscript = await transcriptRequest;
    assert.equal(rejectedTranscript.statusCode, 409);
    assert.equal(rejectedTranscript.payload.error, "live_sip_operator_hold_active");
    assert.equal(
      rejectedTranscript.payload.call.events.some((event: any) => event.type === "rtc_asr_transcript" && event.detail.held === true && event.detail.holdReason === "operator_policy_hold_active"),
      true,
    );
    assert.equal(
      rejectedTranscript.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === "Can you keep helping me on this call?"),
      false,
    );
    assert.equal(
      rejectedTranscript.payload.call.transcript.some((turn: any) => turn.speaker === "agent" && turn.text === "I can continue the live call safely."),
      false,
    );
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => openAiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP terminal operator actions stop OpenAI automation until operator resume", async () => {
  const originalEnv = {
    ACC_OPENAI_API_KEY: process.env.ACC_OPENAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ACC_OPENAI_BASE_URL: process.env.ACC_OPENAI_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ACC_OPENAI_REQUEST_TIMEOUT_MS: process.env.ACC_OPENAI_REQUEST_TIMEOUT_MS,
    ACC_OPENAI_AUTH_MODE: process.env.ACC_OPENAI_AUTH_MODE,
    ACC_OPENAI_AUTH_TOKEN: process.env.ACC_OPENAI_AUTH_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    ACC_OPENCLAW_AGENT_ID: process.env.ACC_OPENCLAW_AGENT_ID,
  };
  const openAiRequests: any[] = [];
  const openAiServer = createTestServer((req, res) => {
    req.resume();
    openAiRequests.push({ url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp-terminal-release", output_text: "Automation is explicitly released." }));
  });
  await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  const openAiAddress = openAiServer.address();
  assert.ok(openAiAddress && typeof openAiAddress !== "string");

  process.env.ACC_OPENAI_API_KEY = "test-openai-key";
  delete process.env.OPENAI_API_KEY;
  process.env.ACC_OPENAI_BASE_URL = `http://127.0.0.1:${openAiAddress.port}/v1`;
  delete process.env.OPENAI_BASE_URL;
  process.env.ACC_OPENAI_REQUEST_TIMEOUT_MS = "5000";
  delete process.env.ACC_OPENAI_AUTH_MODE;
  delete process.env.ACC_OPENAI_AUTH_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.ACC_OPENCLAW_AGENT_ID;

  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    for (const action of ["escalate_to_human", "transfer", "end_call"]) {
      const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
        eventType: "call.started",
        timestamp: "2026-07-27T23:04:00.000Z",
        sipCallId: `sip-openai-terminal-${action}`,
        destination: "8600",
        source: "freeswitch_verto",
        telephonyMode: "local_sip",
        rtcAsrMode: "rtc_asr_live",
      });
      assert.equal(started.statusCode, 201);
      const callId = started.payload.call.session.callId;

      if (action === "escalate_to_human") {
        const pending = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
          action: "ask_operator",
          timestamp: "2026-07-27T23:04:00.500Z",
          reason: "operator is taking over",
        });
        assert.equal(pending.statusCode, 200);
      }

      const terminal = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
        action,
        timestamp: "2026-07-27T23:04:01.000Z",
        reason: `${action} requested by operator`,
      });
      assert.equal(terminal.statusCode, 200);
      assert.equal(terminal.payload.flowState, "wrap");

      const disarmed = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
        action: "disarm_fallback",
        timestamp: "2026-07-27T23:04:01.500Z",
        reason: "operator tried to clear fallback without arming it",
      });
      assert.equal(disarmed.statusCode, 200);
      assert.equal(disarmed.payload.flowState, "wrap");
      assert.equal(disarmed.payload.demoFallback.armed, false);
      assert.equal(disarmed.payload.events.some((event: any) => event.type === "demo_fallback_disarmed"), false);
      assert.equal(
        disarmed.payload.events.some(
          (event: any) => event.type === "demo_fallback_disarm_ignored" && event.detail.reason === "fallback_not_armed",
        ),
        true,
      );

      const heldTurn = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
        timestamp: "2026-07-27T23:04:02.000Z",
        text: `Do not automate after ${action}.`,
        conversationMode: "openai_llm",
      });
      assert.equal(heldTurn.statusCode, 409);
      assert.equal(heldTurn.payload.error, "live_sip_openai_automation_stopped");
      assert.equal(
        heldTurn.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === `Do not automate after ${action}.`),
        false,
      );
    }
    assert.equal(openAiRequests.length, 0);

    for (const action of ["escalate_to_human", "transfer", "end_call"]) {
      const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
        eventType: "call.started",
        timestamp: "2026-07-27T23:04:10.000Z",
        sipCallId: `sip-openai-terminal-fallback-${action}`,
        destination: "8600",
        source: "freeswitch_verto",
        telephonyMode: "local_sip",
        rtcAsrMode: "rtc_asr_live",
      });
      assert.equal(started.statusCode, 201);
      const callId = started.payload.call.session.callId;

      const fallback = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
        action: "arm_fallback",
        timestamp: "2026-07-27T23:04:10.500Z",
        reason: "operator armed manual fallback before terminal stop",
      });
      assert.equal(fallback.statusCode, 200);
      assert.equal(fallback.payload.demoFallback.armed, true);

      const terminal = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
        action,
        timestamp: "2026-07-27T23:04:11.000Z",
        reason: `${action} requested by operator after fallback was armed`,
      });
      assert.equal(terminal.statusCode, 200);
      assert.equal(terminal.payload.flowState, "wrap");

      const disarmed = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
        action: "disarm_fallback",
        timestamp: "2026-07-27T23:04:11.500Z",
        reason: "operator cleared only the fallback path",
      });
      assert.equal(disarmed.statusCode, 200);
      assert.equal(disarmed.payload.demoFallback.armed, false);
      assert.equal(disarmed.payload.events.some((event: any) => event.type === "demo_fallback_disarmed"), true);

      const heldTurn = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
        timestamp: "2026-07-27T23:04:12.000Z",
        text: `Do not automate after fallback disarm and ${action}.`,
        conversationMode: "openai_llm",
      });
      assert.equal(heldTurn.statusCode, 409);
      assert.equal(heldTurn.payload.error, "live_sip_openai_automation_stopped");
      assert.equal(
        heldTurn.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === `Do not automate after fallback disarm and ${action}.`),
        false,
      );
    }
    assert.equal(openAiRequests.length, 0);

    const releaseStarted = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T23:05:00.000Z",
      sipCallId: "sip-openai-terminal-release",
      destination: "8600",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(releaseStarted.statusCode, 201);
    const releaseCallId = releaseStarted.payload.call.session.callId;
    const terminal = await requestJson(address.port, "POST", `/api/calls/${releaseCallId}/operator-steer`, {
      action: "transfer",
      timestamp: "2026-07-27T23:05:01.000Z",
      reason: "operator transfer test",
    });
    assert.equal(terminal.statusCode, 200);
    const resumed = await requestJson(address.port, "POST", `/api/calls/${releaseCallId}/operator-steer`, {
      action: "resume",
      timestamp: "2026-07-27T23:05:02.000Z",
      reason: "operator explicitly released automation",
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.payload.flowState, "steered_response");
    const resumedTurn = await requestJson(address.port, "POST", `/api/calls/${releaseCallId}/caller-turn`, {
      timestamp: "2026-07-27T23:05:03.000Z",
      text: "Automation may continue after explicit release.",
      conversationMode: "openai_llm",
    });
    assert.equal(resumedTurn.statusCode, 200);
    assert.equal(openAiRequests.length, 1);
  } finally {
    Object.assign(process.env, originalEnv);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => openAiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP scripted caller turns honor explicit operator pause holds", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: "2026-07-27T23:06:00.000Z",
      sipCallId: "sip-scripted-explicit-pause",
      destination: "8611",
      source: "freeswitch_verto",
      telephonyMode: "local_sip",
      rtcAsrMode: "rtc_asr_live",
    });
    assert.equal(started.statusCode, 201);
    assert.equal(started.payload.call.scenario.conversationMode, "scripted");
    const callId = started.payload.call.session.callId;

    const paused = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "pause",
      timestamp: "2026-07-27T23:06:01.000Z",
      reason: "operator explicitly paused scripted SIP flow",
    });
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.payload.flowState, "policy_hold");

    const heldDirectTurn = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
      timestamp: "2026-07-27T23:06:02.000Z",
      text: "I want to keep talking while paused.",
      conversationMode: "scripted",
    });
    assert.equal(heldDirectTurn.statusCode, 409);
    assert.equal(heldDirectTurn.payload.error, "live_sip_operator_hold_active");
    assert.equal(
      heldDirectTurn.payload.call.events.some((event: any) => event.type === "rtc_asr_transcript" && event.detail.held === true && event.detail.holdReason === "operator_policy_hold_active"),
      true,
    );
    assert.equal(
      heldDirectTurn.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === "I want to keep talking while paused."),
      false,
    );

    const heldMediaTranscript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-27T23:06:03.000Z",
      sipCallId: "sip-scripted-explicit-pause",
      text: "Media transcript should also wait.",
    });
    assert.equal(heldMediaTranscript.statusCode, 409);
    assert.equal(heldMediaTranscript.payload.error, "live_sip_operator_hold_active");
    assert.equal(
      heldMediaTranscript.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === "Media transcript should also wait."),
      false,
    );

    const resumed = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
      action: "resume",
      timestamp: "2026-07-27T23:06:04.000Z",
      reason: "operator resumed scripted SIP flow",
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.payload.flowState, "steered_response");

    const acceptedMediaTranscript = await requestJson(address.port, "POST", "/api/live-sip/events", {
      eventType: "media.transcript",
      timestamp: "2026-07-27T23:06:05.000Z",
      sipCallId: "sip-scripted-explicit-pause",
      text: "I'm thinking about canceling my policy.",
    });
    assert.equal(acceptedMediaTranscript.statusCode, 200);
    assert.equal(
      acceptedMediaTranscript.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === "I'm thinking about canceling my policy."),
      true,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("live SIP scripted caller turns stay held after terminal operator stops", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    for (const action of ["takeover", "escalate_to_human", "transfer", "end_call"]) {
      const started = await requestJson(address.port, "POST", "/api/live-sip/events", {
        eventType: "call.started",
        timestamp: "2026-07-27T23:07:00.000Z",
        sipCallId: `sip-scripted-terminal-${action}`,
        destination: "8611",
        source: "freeswitch_verto",
        telephonyMode: "local_sip",
        rtcAsrMode: "rtc_asr_live",
      });
      assert.equal(started.statusCode, 201);
      assert.equal(started.payload.call.scenario.conversationMode, "scripted");
      const callId = started.payload.call.session.callId;

      if (action === "escalate_to_human") {
        const pending = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
          action: "ask_operator",
          timestamp: "2026-07-27T23:07:00.500Z",
          reason: "operator is taking over scripted automation",
        });
        assert.equal(pending.statusCode, 200);
      }

      const stopped = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
        action,
        timestamp: "2026-07-27T23:07:01.000Z",
        reason: `${action} stops scripted automation`,
      });
      assert.equal(stopped.statusCode, 200);
      assert.equal(stopped.payload.flowState, "wrap");

      const heldDirectTurn = await requestJson(address.port, "POST", `/api/calls/${callId}/caller-turn`, {
        timestamp: "2026-07-27T23:07:02.000Z",
        text: `Do not continue scripted automation after ${action}.`,
        conversationMode: "scripted",
      });
      assert.equal(heldDirectTurn.statusCode, 409);
      assert.equal(heldDirectTurn.payload.error, "live_sip_operator_hold_active");
      assert.equal(
        heldDirectTurn.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === `Do not continue scripted automation after ${action}.`),
        false,
      );

      const heldMediaTranscript = await requestJson(address.port, "POST", "/api/live-sip/events", {
        eventType: "media.transcript",
        timestamp: "2026-07-27T23:07:03.000Z",
        sipCallId: `sip-scripted-terminal-${action}`,
        text: `Media must not continue after ${action}.`,
      });
      assert.equal(heldMediaTranscript.statusCode, 409);
      assert.equal(heldMediaTranscript.payload.error, "live_sip_operator_hold_active");
      assert.equal(
        heldMediaTranscript.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === `Media must not continue after ${action}.`),
        false,
      );

      if (action !== "takeover") {
        const fallbackStarted = await requestJson(address.port, "POST", "/api/live-sip/events", {
          eventType: "call.started",
          timestamp: "2026-07-27T23:07:10.000Z",
          sipCallId: `sip-scripted-terminal-fallback-${action}`,
          destination: "8611",
          source: "freeswitch_verto",
          telephonyMode: "local_sip",
          rtcAsrMode: "rtc_asr_live",
        });
        assert.equal(fallbackStarted.statusCode, 201);
        const fallbackCallId = fallbackStarted.payload.call.session.callId;

        const fallback = await requestJson(address.port, "POST", `/api/calls/${fallbackCallId}/operator-steer`, {
          action: "arm_fallback",
          timestamp: "2026-07-27T23:07:10.500Z",
          reason: "operator armed scripted fallback before terminal stop",
        });
        assert.equal(fallback.statusCode, 200);
        assert.equal(fallback.payload.demoFallback.armed, true);

        const stoppedAfterFallback = await requestJson(address.port, "POST", `/api/calls/${fallbackCallId}/operator-steer`, {
          action,
          timestamp: "2026-07-27T23:07:11.000Z",
          reason: `${action} stops scripted automation after fallback was armed`,
        });
        assert.equal(stoppedAfterFallback.statusCode, 200);
        assert.equal(stoppedAfterFallback.payload.flowState, "wrap");

        const disarmed = await requestJson(address.port, "POST", `/api/calls/${fallbackCallId}/operator-steer`, {
          action: "disarm_fallback",
          timestamp: "2026-07-27T23:07:11.500Z",
          reason: "operator cleared only scripted fallback",
        });
        assert.equal(disarmed.statusCode, 200);
        assert.equal(disarmed.payload.demoFallback.armed, false);
        assert.equal(disarmed.payload.events.some((event: any) => event.type === "demo_fallback_disarmed"), true);

        const stillHeld = await requestJson(address.port, "POST", "/api/live-sip/events", {
          eventType: "media.transcript",
          timestamp: "2026-07-27T23:07:12.000Z",
          sipCallId: `sip-scripted-terminal-fallback-${action}`,
          text: `Media must not continue after fallback disarm and ${action}.`,
        });
        assert.equal(stillHeld.statusCode, 409);
        assert.equal(stillHeld.payload.error, "live_sip_operator_hold_active");
        assert.equal(
          stillHeld.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === `Media must not continue after fallback disarm and ${action}.`),
          false,
        );
      }

      const released = await requestJson(address.port, "POST", `/api/calls/${callId}/operator-steer`, {
        action: "resume",
        timestamp: "2026-07-27T23:07:04.000Z",
        reason: `operator explicitly released scripted automation after ${action}`,
      });
      assert.equal(released.statusCode, 200);

      const acceptedAfterRelease = await requestJson(address.port, "POST", "/api/live-sip/events", {
        eventType: "media.transcript",
        timestamp: "2026-07-27T23:07:05.000Z",
        sipCallId: `sip-scripted-terminal-${action}`,
        text: `Scripted automation can continue after explicit release from ${action}.`,
      });
      assert.equal(acceptedAfterRelease.statusCode, 200);
      assert.equal(
        acceptedAfterRelease.payload.call.transcript.some((turn: any) => turn.speaker === "caller" && turn.text === `Scripted automation can continue after explicit release from ${action}.`),
        true,
      );
    }
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
