import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

function requestJson(port: number, route: string): Promise<{ statusCode: number; payload: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method: "GET",
      },
      (response) => {
        let collected = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { collected += chunk; });
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, payload: collected ? JSON.parse(collected) : null }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("GET /api/pipecat-media-engine/readiness exposes the shared browser/SIP contract and honest SIP blocker", async () => {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await requestJson(address.port, "/api/pipecat-media-engine/readiness");
    assert.equal(response.statusCode, 200);

    const payload = response.payload;
    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/pipecat-media-engine/readiness");
    assert.equal(payload.issue, "agonza1/agentic-contact-center#214");
    assert.equal(payload.status, "shared_contract_ready_sip_rtp_blocked");
    assert.equal(payload.reviewReady, false);
    assert.deepEqual(payload.validationCommands, [
      "npm test",
      "curl -fsS http://127.0.0.1:8026/api/pipecat-media-engine/readiness",
    ]);

    assert.equal(payload.sharedEngineContract.engine, "pipecat-ai");
    assert.equal(payload.sharedEngineContract.callTurnEngine, "rtc-asr -> ACC caller-turn -> Kokoro");
    assert.equal(payload.sharedEngineContract.normalizedAudioFrame.format, "pcm_s16le");
    assert.equal(payload.sharedEngineContract.normalizedAudioFrame.sipCodecBoundary.includes("PCMU/8000 RTP"), true);

    const adapters = payload.sharedEngineContract.requiredAdapters;
    assert.deepEqual(
      adapters.map((adapter: any) => adapter.id),
      ["browser_webrtc", "sip_freeswitch_rtp", "signalwire_sip_trunk"],
    );
    assert.equal(adapters.find((adapter: any) => adapter.id === "browser_webrtc").implementedNow, true);
    assert.equal(adapters.find((adapter: any) => adapter.id === "sip_freeswitch_rtp").implementedNow, false);
    assert.match(adapters.find((adapter: any) => adapter.id === "sip_freeswitch_rtp").blocker, /softphone caller playback/);
    assert.match(adapters.find((adapter: any) => adapter.id === "signalwire_sip_trunk").blocker, /past-call import remains out of scope/);

    assert.deepEqual(payload.reviewBlockers, [
      "Live softphone caller playback has not yet been accepted end-to-end; the current SIP bridge can collect FreeSWITCH RTP into Pipecat input frames, stream those frames to rtc-asr, packetize Pipecat/Kokoro TTS frames back to PCMU RTP, and report socket-send playback evidence.",
    ]);
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "browser_webrtc_uses_pipecat_rtc_asr_kokoro").passed,
      true,
    );
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "sip_freeswitch_uses_same_realtime_pipecat_engine").passed,
      false,
    );
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "signalwire_past_call_gap_explicit").passed,
      true,
    );
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "rtp_pcmu_fixture_decodes_to_pipecat_input_frame").passed,
      true,
    );
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "pipecat_tts_frames_packetize_to_freeswitch_rtp").passed,
      true,
    );
    assert.equal(payload.remainingWork.some((item: string) => item.includes("softphone evidence")), true);
    assert.deepEqual(payload.nextUnblockedSlice, {
      id: "live_softphone_playback_acceptance",
      title: "Capture end-to-end softphone playback proof",
      adapter: "sip_freeswitch_rtp",
      entryPoint: "scripts/freeswitch-acc-bridge.mjs",
      targetContract: "softphone SIP call -> FreeSWITCH RTP -> Pipecat input frames -> rtc-asr transcript -> ACC turn -> Kokoro/Pipecat TTS -> PCMU RTP playback heard by caller",
      verification: "scripts/live-sip-proof-bundle.mjs must carry live_capture, rtc_asr_live, Pipecat RTP playback send evidence, and caller-audible playback proof before issue #214 can be accepted.",
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
