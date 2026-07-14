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
    assert.equal(payload.status, "shared_contract_ready_local_sip_playback_proof_pending");
    assert.equal(payload.reviewReady, false);
    assert.equal(payload.pipecat14Alignment.issue, "agonza1/agentic-contact-center#222");
    assert.equal(payload.pipecat14Alignment.packageRequirement, "pipecat-ai[webrtc]==1.4.0");
    assert.equal(payload.pipecat14Alignment.primaryTransportTarget, "SmallWebRTCTransport");
    assert.deepEqual(payload.pipecat14Alignment.targetPipeline, [
      "transport.input",
      "rtc-asr STT",
      "ACC caller-turn adapter",
      "Kokoro TTS",
      "transport.output",
    ]);
    assert.equal(payload.pipecat14Alignment.browserPrimaryBridge.current, "scripts/pipecat-browser-webrtc-bridge.py");
    assert.equal(payload.pipecat14Alignment.browserPrimaryBridge.legacyFallbackAllowed, false);
    assert.equal(payload.pipecat14Alignment.sipTransportStrategy.sharesPipelineProcessors, false);
    assert.equal(payload.pipecat14Alignment.sipTransportStrategy.processorContractAligned, true);
    assert.equal(payload.pipecat14Alignment.sipTransportStrategy.liveMediaProofComplete, false);
    assert.deepEqual(payload.pipecat14Alignment.sipTransportStrategy.pipelineUnificationDelta, [
      "Move SIP RTP PCM frames into build_acc_voice_pipeline() instead of the Node mirror of rtc-asr/ACC/Kokoro stages.",
      "Reuse the same RtcAsrTurnProcessor, AccCallerTurnProcessor, and KokoroTtsProcessor stage-event contract as the browser SmallWebRTC path.",
      "Keep FreeSWITCH packetization and uuid_broadcast at the telephony boundary after transport.output() emits caller audio.",
    ]);
    assert.equal(payload.pipecat14Alignment.flowsDecision.owner, "ACC TypeScript flow for current cancellation-rescue MVP");
    assert.equal(payload.pipecat14Alignment.flowsDecision.flowManagerRequiredNow, false);
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
      ["browser_webrtc", "sip_freeswitch_rtp", "fixture_audio_injection", "signalwire_sip_trunk"],
    );
    assert.equal(adapters.find((adapter: any) => adapter.id === "browser_webrtc").implementedNow, true);
    assert.equal(adapters.find((adapter: any) => adapter.id === "browser_webrtc").currentEntryPoint, "scripts/pipecat-browser-webrtc-bridge.py");
    const sipAdapter = adapters.find((adapter: any) => adapter.id === "sip_freeswitch_rtp");
    assert.equal(sipAdapter.implementedNow, true);
    assert.equal(sipAdapter.processorContractAligned, true);
    assert.equal(sipAdapter.liveMediaProofComplete, false);
    assert.match(sipAdapter.pipelineUnificationDelta, /build_acc_voice_pipeline\(\)/);
    assert.match(sipAdapter.pipelineUnificationDelta, /FreeSWITCH RTP ingress\/egress/);
    assert.match(sipAdapter.blocker, /live softphone capture/);
    assert.match(sipAdapter.blocker, /not yet the same Python Pipeline object/);
    const fixtureAdapter = adapters.find((adapter: any) => adapter.id === "fixture_audio_injection");
    assert.equal(fixtureAdapter.implementedNow, true);
    assert.equal(fixtureAdapter.currentEntryPoint, "scripts/pipecat-fixture-pipeline-smoke.py --input-wav <mono-pcm16.wav>");
    assert.equal(fixtureAdapter.contractEntryPoint, "scripts/pipecat-fixture-pipeline-smoke.py --contract-only");
    assert.match(fixtureAdapter.path, /InputAudioRawFrame/);
    assert.match(fixtureAdapter.blocker, /build_acc_voice_pipeline\(\)/);
    assert.match(fixtureAdapter.blocker, /sidecars/);
    assert.match(adapters.find((adapter: any) => adapter.id === "signalwire_sip_trunk").blocker, /past-call import remains out of scope/);

    assert.deepEqual(payload.reviewBlockers, [
      "Local 8600 return audio is wired through Kokoro/Pipecat TTS, PCMU RTP packetization evidence, and FreeSWITCH uuid_broadcast WAV playback; live softphone capture still needs to prove the caller heard that playback end-to-end.",
    ]);
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "browser_webrtc_uses_pipecat_rtc_asr_kokoro").passed,
      true,
    );
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "sip_freeswitch_processor_contract_aligned").passed,
      true,
    );
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "sip_caller_audible_playback_live_proof").passed,
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
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "pipecat_14_small_webrtc_migration_recorded").passed,
      true,
    );
    assert.equal(payload.remainingWork.some((item: string) => item.includes("softphone evidence")), true);
    assert.deepEqual(payload.liveSipProofAcceptance, {
      requiredManifestFlags: ["live_capture", "rtc_asr_live", "pipecat_rtp_playback_sent", "caller_audible_playback"],
      rejectedShortcuts: [
        "generated_media_without_live_capture",
        "stale_rtc_asr_evidence_reused_across_calls",
        "uuid_broadcast_without_caller_capture",
      ],
      proofBundleCommand: "node scripts/live-sip-proof-bundle.mjs --require-live-capture --require-rtc-asr-live --require-caller-playback",
    });
    assert.deepEqual(payload.nextUnblockedSlice, {
      id: "live_softphone_playback_acceptance",
      title: "Capture end-to-end softphone playback proof",
      adapter: "sip_freeswitch_rtp",
      entryPoint: "scripts/freeswitch-acc-bridge.mjs",
      targetContract: "softphone SIP call -> FreeSWITCH RTP -> Pipecat input frames -> rtc-asr transcript -> ACC turn -> Kokoro/Pipecat TTS -> PCMU RTP playback heard by caller",
      verification: "scripts/live-sip-proof-bundle.mjs must carry live_capture, rtc_asr_live, Pipecat RTP playback send evidence, and caller-audible playback proof before issue #214 can be accepted.",
      acceptance: payload.liveSipProofAcceptance,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
