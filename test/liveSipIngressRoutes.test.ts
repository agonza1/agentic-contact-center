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
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
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
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

test("live SIP 8600 fails closed when OpenAI credentials are missing", async () => {
  const originalApiKey = process.env.ACC_OPENAI_API_KEY;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  delete process.env.ACC_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

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
    if (originalApiKey === undefined) delete process.env.ACC_OPENAI_API_KEY;
    else process.env.ACC_OPENAI_API_KEY = originalApiKey;
    if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
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
