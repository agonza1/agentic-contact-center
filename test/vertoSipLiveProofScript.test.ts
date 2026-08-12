import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("Verto SIP live proof self-test validates digest, SDP, and RTP packet helpers", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");

  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/verto-sip-live-proof.mjs", "--self-test"],
    { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
  );

  const summary = JSON.parse(stdout) as {
    ok: boolean;
    authorizationReady: boolean;
    authorizationUriReady: boolean;
    sdpTarget: { host: string; port: number };
    packetCount: number;
    continuedRtpClock: { sequence: number; timestamp: number };
    responsePlayback: { packetCount: number; confirmed: boolean };
    inferredLocalHost: { host: string; source: string };
    loopbackRejected: boolean;
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.authorizationReady, true);
  assert.equal(summary.authorizationUriReady, true);
  assert.deepEqual(summary.sdpTarget, { host: "127.0.0.1", port: 29790 });
  assert.ok(summary.packetCount > 0);
  assert.deepEqual(summary.continuedRtpClock, { sequence: 13, timestamp: 1920 });
  assert.equal(summary.responsePlayback.packetCount, 10);
  assert.equal(summary.responsePlayback.confirmed, true);
  assert.deepEqual(summary.inferredLocalHost, { host: "192.168.86.28", source: "network_interface" });
  assert.equal(summary.loopbackRejected, true);
});

test("Verto SIP proof requires transcript-backed non-silent caller playback", () => {
  const script = readFileSync("scripts/verto-sip-live-proof.mjs", "utf8").replaceAll("\r\n", "\n");

  assert.match(script, /--caller-audio/);
  assert.match(script, /--tail-silence-ms/);
  assert.match(script, /stt\.transcript_final/);
  assert.match(script, /snapshot\?\.lastEvidence\?\.callerTranscript/);
  assert.match(script, /finalTranscriptSource === "rtc_asr_interim_fallback"/);
  assert.match(script, /snapshot\?\.lastEvidence\?\.stt\?\.finalEventObserved === true/);
  assert.match(script, /extractVertoCallId\(snapshot\)/);
  assert.match(script, /snapshot\?\.accCallId/);
  assert.match(script, /accCallId: rtcAsrEvidence\.accCallId/);
  assert.match(script, /evidenceSipCallId: rtcAsrEvidence\.sipCallId/);
  assert.match(script, /linkedSipCallId: rtcAsrEvidence\.linkedSipCallId/);
  assert.match(script, /tts\.audio_ready/);
  assert.match(script, /tts\.stream_started/);
  assert.match(script, /tts\.audio_chunk/);
  assert.match(script, /tts\.stream_completed/);
  assert.match(script, /baselineCallIds\.has\(evidenceCallId\)/);
  assert.match(script, /fallbackReadyEvidence/);
  assert.match(script, /if \(matchesExpectedCall\) return readyEvidence/);
  assert.match(script, /correlationMode: matchesExpectedCall \? "expected_sip_call_id" : "fresh_non_baseline_current_window"/);
  assert.match(script, /if \(!expectedCorrelationId && fallbackReadyEvidence\) return fallbackReadyEvidence/);
  assert.match(script, /correlationMode: rtcAsrEvidence\.correlationMode \|\| null/);
  assert.match(script, /waitForRtcAsrEvidence/);
  assert.match(script, /Date\.parse\(event\.timestamp\) >= startedAtMs/);
  assert.match(script, /rtc-asr-transcript-evidence\.json/);
  assert.match(script, /callId: this\.callId/);
  assert.match(script, /type: rtcAsrReady \? "transcript\.final"/);
  assert.match(script, /this\.returnPacketCount >= 10/);
  assert.match(script, /playbackRms >= 50/);
  assert.match(script, /waitForObservableIntroCompletion/);
  assert.match(script, /rtp\.media_path_primed/);
  assert.match(script, /startSequence: primePacketCount \+ 1/);
  assert.match(script, /startTimestamp: primePacketCount \* 160/);
  assert.match(script, /rtp\.prerecorded_intro_completed/);
  assert.match(script, /caller_rtp_non_silent_then_240ms_silence/);
  assert.match(script, /responsePlaybackBoundaryAt = latestTimestamp/);
  assert.match(script, /this\.observableIntroCompletedAt/);
  assert.match(script, /playbackBeforeTimestamp\(this\.returnRtpChunks, responsePlaybackBoundaryAt\)/);
  assert.match(script, /playbackAfterTimestamp\(this\.returnRtpChunks, responsePlaybackBoundaryAt\)/);
  assert.match(script, /const callerPlaybackConfirmed = rtcAsrReady && Boolean\(this\.observableIntroCompletedAt\) && responsePlayback\.confirmed/);
  assert.match(script, /responsePlaybackConfirmed/);
  assert.match(script, /No caller-side return RTP audio was captured after the response TTS start event/);
  assert.match(script, /--local-host must be a non-loopback IPv4 address reachable from FreeSWITCH/);
  assert.match(script, /networkInterfaces\(\)/);
  assert.match(script, /localBindHost: argValue\("--local-bind-host"/);
  assert.match(script, /this\.rtpSocket\.bind\(this\.options\.localRtpPort, this\.options\.localBindHost/);
});

test("Verto SIP proof does not accept unrelated rtc-asr evidence while waiting for the proof call", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/verto-sip-live-proof.mjs", "--correlation-self-test"],
    { cwd: repoRoot, timeout: 10_000, encoding: "utf8" },
  );
  const summary = JSON.parse(stdout) as {
    ok: boolean;
    blocked: { ready: boolean };
    correlated: { ready: boolean; transcript: string; correlationMode: string };
    fallback: { ready: boolean; transcript: string; correlationMode: string };
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.blocked.ready, false);
  assert.equal(summary.correlated.ready, true);
  assert.equal(summary.correlated.transcript, "right call");
  assert.equal(summary.correlated.correlationMode, "expected_sip_call_id");
  assert.equal(summary.fallback.ready, true);
  assert.equal(summary.fallback.transcript, "wrong call");
  assert.equal(summary.fallback.correlationMode, "fresh_non_baseline_current_window");
});

test("Verto bridge records live rtc-asr, deferred greeting, barge-in output, and call cleanup evidence", () => {
  const bridge = readFileSync("scripts/pipecat-verto-agent-bridge.py", "utf8").replaceAll("\r\n", "\n");
  const callStartedIndex = bridge.indexOf("\"eventType\": \"call.started\"");
  const queueFramesIndex = bridge.indexOf("await task.queue_frames(intro_frames)");
  const finishIntroIndex = bridge.indexOf("async def finish_intro_output_stream");
  const scheduleFinishIntroIndex = bridge.indexOf("asyncio.create_task(finish_intro_output_stream())");
  const introCompletedIndex = bridge.indexOf("\"tts.prerecorded_intro_completed\"");
  const greetingIndex = bridge.indexOf("\"eventType\": \"agent.greeting\"");

  assert.ok(callStartedIndex >= 0);
  assert.ok(bridge.indexOf("\"rtcAsrMode\": \"rtc_asr_live\"", callStartedIndex) > callStartedIndex);
  assert.match(bridge, /def telephony_mode\(self, params: dict\[str, Any\]\) -> str:/);
  assert.match(bridge, /"acc_route"/);
  assert.match(bridge, /"telephonyMode": telephony_mode/);
  assert.ok(queueFramesIndex >= 0);
  assert.ok(finishIntroIndex > queueFramesIndex);
  assert.ok(scheduleFinishIntroIndex > finishIntroIndex);
  assert.ok(introCompletedIndex > queueFramesIndex);
  assert.ok(greetingIndex > finishIntroIndex);
  assert.ok(greetingIndex < scheduleFinishIntroIndex);
  assert.ok(greetingIndex < introCompletedIndex);
  assert.match(bridge, /session\.begin_output_stream\(stream_id=intro_context_id\)/);
  assert.match(bridge, /session\.extend_output_window\(audio_bytes=len\(audio_chunk\), sample_rate=intro_sample_rate\)/);
  assert.match(bridge, /session\.record_output_chunk\(len\(audio_chunk\)\)/);
  assert.match(bridge, /session\.finish_output_stream\(\)/);
  assert.match(bridge, /"tts\.prerecorded_intro_interrupted"/);
  assert.match(bridge, /session\.release_caller_turns\("prerecorded_greeting_interrupted"\)/);
  assert.match(bridge, /except Exception as exc:\n\s+session\.record_stage\(\n\s+"greeting\.evidence_post_failed"/);
  assert.match(bridge, /finally:\n\s+session\.release_caller_turns\("prerecorded_greeting_evidence_finished"\)/);
  assert.match(bridge, /session\.record_agent_track\(/);
  assert.match(bridge, /"source": "freeswitch_verto"/);
  assert.match(bridge, /"rtcAsrMode": "rtc_asr_live" if readiness\.ok else "rtc_asr_blocked"/);
  assert.match(bridge, /blockedEvidencePosted/);
  assert.match(bridge, /finally:\n\s+self\.last_answer = \{/);
  assert.match(bridge, /offerSdpArtifactPersisted/);
  assert.match(bridge, /verto\.invite\.artifact_error/);
  assert.match(bridge, /answerSdpArtifactPersisted/);
  assert.match(bridge, /verto\.answer\.artifact_error/);
  assert.match(bridge, /def call_scoped_proof_paths/);
  assert.match(bridge, /"callScopedProofArtifactPaths"/);
  assert.match(bridge, /self\.proof_out\.parent \/ "calls" \/ artifact_id \/ self\.proof_out\.name/);
  assert.match(bridge, /affected_artifact_ids=\[call_id, acc_call_id, linked_sip_call_id, proof_sip_call_id\]/);
  assert.match(bridge, /for key in \("lastInvite", "lastAnswer", "lastError"\):/);
  assert.match(bridge, /linked_sip_call_id = self\.linked_sip_call_id\(params\)/);
  assert.match(bridge, /"vertoCallId": call_id/);
  assert.match(bridge, /"sipCallId": linked_sip_call_id or call_id/);
  assert.match(bridge, /"accCallId": acc_call_id/);
  assert.match(bridge, /"vertoParams": sanitize_verto_params\(params\)/);
  assert.doesNotMatch(bridge, /"vertoParams": \{key: value for key, value in params\.items\(\) if key != "sdp"\}/);
  assert.match(bridge, /diversion\|history\[-_\\s\]\*info\|referred\[-_\\s\]\*by/);
  assert.match(bridge, /greeting\.owner_selected/);
  assert.match(bridge, /asyncio\.create_task\(session\.prewarm_conversation_tts_cache\(\)\)/);
  assert.match(bridge, /session_record\["prewarmTask"\] = prewarm_task/);
  assert.match(bridge, /asyncio\.create_task\(session\.get_flow_manager_adapter\(\)\.initialize\(\)\)/);
  assert.match(bridge, /owner="pipecat_verto_bridge" if verto_owns_greeting else "freeswitch_esl_bridge"/);
  assert.match(bridge, /async def end_acc_call/);
  assert.match(bridge, /"eventType": "call\.ended"/);
  assert.match(bridge, /await self\.end_acc_call\(call_id, reason="verto_readiness_blocked", linked_sip_call_id=linked_sip_call_id\)/);
  assert.match(bridge, /await self\.end_acc_call\(call_id, reason="verto_sdp_answer_failed", linked_sip_call_id=linked_sip_call_id\)/);
  assert.match(bridge, /await self\.close_session\(session_id, reason="verto_answer_send_failed"\)/);
  assert.match(bridge, /await self\.end_acc_call\(call_id, reason="verto_pipeline_start_failed", linked_sip_call_id=linked_sip_call_id\)/);
  const closeSessionIndex = bridge.indexOf("async def close_session");
  const closeRtcAsrIndex = bridge.indexOf("await turn_session.close_rtc_asr_stream(reason)", closeSessionIndex);
  const closeEndCallIndex = bridge.indexOf("await self.end_acc_call(", closeRtcAsrIndex);
  const closeEndCallBlock = bridge.slice(closeEndCallIndex, closeEndCallIndex + 360);
  assert.ok(closeSessionIndex >= 0);
  assert.ok(closeRtcAsrIndex > closeSessionIndex);
  assert.ok(closeEndCallIndex > closeRtcAsrIndex);
  assert.match(bridge.slice(closeSessionIndex, closeEndCallIndex), /record_teardown_error\("runner_task", exc\)/);
  assert.match(bridge.slice(closeSessionIndex, closeEndCallIndex), /finally:\n\s+if teardown_errors:/);
  assert.match(closeEndCallBlock, /linked_sip_call_id=linked_sip_call_id/);
  const closePrewarmIndex = bridge.indexOf('prewarm_task = session.get("prewarmTask")', closeSessionIndex);
  const closePrewarmCancelBlock = bridge.slice(closePrewarmIndex, closePrewarmIndex + 320);
  assert.ok(closePrewarmIndex > closeSessionIndex);
  assert.match(closePrewarmCancelBlock, /prewarm_task\.cancel\(\)/);
  assert.match(closePrewarmCancelBlock, /await prewarm_task/);
});

test("Verto bridge scopes call artifact rewrites and lastError", { skip: !existsSync(".pipecat-runtime") }, async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const { stdout } = await execFileAsync(
    "python3",
    ["-P", path.join(repoRoot, "test/fixtures/verto_bridge_artifact_regression.py")],
    { cwd: tmpdir(), timeout: 20_000, encoding: "utf8" },
  );
  const summary = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
    ok: boolean;
    callARewritten: boolean;
    callBStage: string;
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.callARewritten, false);
  assert.equal(summary.callBStage, "updated");
});

test("Verto bridge normalizes FreeSWITCH ICE, DTLS, and G.711 RTP", { skip: !existsSync(".pipecat-runtime") }, async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const { stdout } = await execFileAsync(
    "python3",
    ["-P", path.join(repoRoot, "scripts/pipecat-verto-agent-bridge.py"), "--sdp-normalization-self-test"],
    { cwd: tmpdir(), timeout: 20_000, encoding: "utf8" },
  );
  const summary = JSON.parse(stdout.trim().split("\n").slice(-16).join("\n")) as {
    ok: boolean;
    checks: Record<string, boolean>;
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.checks.marks_freeswitch_offer_ice_lite, true);
  assert.equal(summary.checks.clears_repeated_pcmu_marker, true);
});
