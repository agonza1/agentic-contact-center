import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
    inferredLocalHost: { host: string; source: string };
    loopbackRejected: boolean;
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.authorizationReady, true);
  assert.equal(summary.authorizationUriReady, true);
  assert.deepEqual(summary.sdpTarget, { host: "127.0.0.1", port: 29790 });
  assert.ok(summary.packetCount > 0);
  assert.deepEqual(summary.inferredLocalHost, { host: "192.168.86.28", source: "network_interface" });
  assert.equal(summary.loopbackRejected, true);
});

test("Verto SIP proof requires transcript-backed non-silent caller playback", () => {
  const script = readFileSync("scripts/verto-sip-live-proof.mjs", "utf8");

  assert.match(script, /--caller-audio/);
  assert.match(script, /--tail-silence-ms/);
  assert.match(script, /stt\.transcript_final/);
  assert.match(script, /tts\.audio_ready/);
  assert.match(script, /baselineCallIds\.has\(evidenceCallId\)/);
  assert.match(script, /Date\.parse\(event\.timestamp\) >= startedAtMs/);
  assert.match(script, /rtc-asr-transcript-evidence\.json/);
  assert.match(script, /callId: this\.callId/);
  assert.match(script, /type: rtcAsrReady \? "transcript\.final"/);
  assert.match(script, /this\.returnPacketCount >= 10/);
  assert.match(script, /playbackRms >= 50/);
  assert.match(script, /--local-host must be a non-loopback IPv4 address reachable from FreeSWITCH/);
  assert.match(script, /networkInterfaces\(\)/);
  assert.match(script, /localBindHost: argValue\("--local-bind-host"/);
  assert.match(script, /this\.rtpSocket\.bind\(this\.options\.localRtpPort, this\.options\.localBindHost/);
});

test("Verto bridge records live rtc-asr, deferred greeting, barge-in output, and call cleanup evidence", () => {
  const bridge = readFileSync("scripts/pipecat-verto-agent-bridge.py", "utf8");
  const callStartedIndex = bridge.indexOf("\"eventType\": \"call.started\"");
  const queueFramesIndex = bridge.indexOf("await task.queue_frames(intro_frames)");
  const greetingIndex = bridge.indexOf("\"eventType\": \"agent.greeting\"");

  assert.ok(callStartedIndex >= 0);
  assert.ok(bridge.indexOf("\"rtcAsrMode\": \"rtc_asr_live\"", callStartedIndex) > callStartedIndex);
  assert.ok(queueFramesIndex >= 0);
  assert.ok(greetingIndex > queueFramesIndex);
  assert.match(bridge, /session\.begin_output_stream\(stream_id=intro_context_id\)/);
  assert.match(bridge, /session\.extend_output_window\(audio_bytes=len\(audio_chunk\), sample_rate=intro_sample_rate\)/);
  assert.match(bridge, /session\.record_output_chunk\(len\(audio_chunk\)\)/);
  assert.match(bridge, /session\.record_agent_track\(/);
  assert.match(bridge, /async def end_acc_call/);
  assert.match(bridge, /"eventType": "call\.ended"/);
  assert.match(bridge, /await self\.end_acc_call\(call_id, reason="verto_readiness_blocked"\)/);
  assert.match(bridge, /await self\.end_acc_call\(call_id, reason="verto_sdp_answer_failed"\)/);
  assert.match(bridge, /await self\.end_acc_call\(call_id, reason="verto_answer_send_failed"\)/);
  assert.match(bridge, /await self\.end_acc_call\(call_id, reason="verto_pipeline_start_failed"\)/);
});

test("Verto bridge normalizes FreeSWITCH ICE, DTLS, and G.711 RTP", { skip: !existsSync(".pipecat-runtime") }, async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const { stdout } = await execFileAsync(
    "python3",
    ["scripts/pipecat-verto-agent-bridge.py", "--sdp-normalization-self-test"],
    { cwd: repoRoot, timeout: 20_000, encoding: "utf8" },
  );
  const summary = JSON.parse(stdout.trim().split("\n").slice(-16).join("\n")) as {
    ok: boolean;
    checks: Record<string, boolean>;
  };

  assert.equal(summary.ok, true);
  assert.equal(summary.checks.marks_freeswitch_offer_ice_lite, true);
  assert.equal(summary.checks.clears_repeated_pcmu_marker, true);
});
