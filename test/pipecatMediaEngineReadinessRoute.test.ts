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
    assert.equal(payload.status, "shared_media_live_proof_complete_flows_pending");
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
    assert.equal(payload.pipecat14Alignment.sipTransportStrategy.transport, "FreeSWITCH Verto/WebRTC agent leg");
    assert.equal(payload.pipecat14Alignment.sipTransportStrategy.sharesPipelineProcessors, true);
    assert.equal(payload.pipecat14Alignment.sipTransportStrategy.processorContractAligned, true);
    assert.equal(payload.pipecat14Alignment.sipTransportStrategy.liveMediaProofComplete, true);
    assert.match(payload.pipecat14Alignment.sipTransportStrategy.preferredRoute, /acc-pipecat/);
    assert.match(payload.pipecat14Alignment.sipTransportStrategy.legacyFallback, /freeswitch-acc-bridge/);
    assert.deepEqual(payload.pipecat14Alignment.sipTransportStrategy.pipelineUnificationDelta, [
      "Answer incoming Verto dialogs with a Pipecat media transport that calls build_acc_voice_pipeline().",
      "Reuse the same RtcAsrTurnProcessor, AccCallerTurnProcessor, and KokoroTtsProcessor stage-event contract as the browser SmallWebRTC path.",
      "Keep SIP/RTP and WebRTC DTLS-SRTP/Opus ownership inside FreeSWITCH; Pipecat should only see decoded PCM frames.",
    ]);
    assert.equal(payload.pipecat14Alignment.flowsDecision.owner, "ACC TypeScript flow for current cancellation-rescue MVP");
    assert.equal(payload.pipecat14Alignment.flowsDecision.flowManagerRequiredNow, true);
    assert.deepEqual(payload.validationCommands, [
      "npm run pipecat:flows:contract",
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
      ["browser_webrtc", "sip_freeswitch_verto", "sip_freeswitch_rtp_legacy", "fixture_audio_injection", "signalwire_sip_trunk"],
    );
    assert.equal(adapters.find((adapter: any) => adapter.id === "browser_webrtc").implementedNow, true);
    assert.equal(adapters.find((adapter: any) => adapter.id === "browser_webrtc").currentEntryPoint, "scripts/pipecat-browser-webrtc-bridge.py");
    const sipAdapter = adapters.find((adapter: any) => adapter.id === "sip_freeswitch_verto");
    assert.equal(sipAdapter.implementedNow, true);
    assert.equal(sipAdapter.processorContractAligned, true);
    assert.equal(sipAdapter.liveMediaProofComplete, true);
    assert.equal(sipAdapter.currentEntryPoint, "scripts/pipecat-verto-agent-bridge.py");
    assert.match(sipAdapter.freeswitchDialplan, /acc-pipecat/);
    assert.match(sipAdapter.pipelineUnificationDelta, /build_acc_voice_pipeline\(\)/);
    assert.match(sipAdapter.pipelineUnificationDelta, /Verto WebRTC dialog answer/);
    assert.equal(sipAdapter.blocker, null);
    const legacySipAdapter = adapters.find((adapter: any) => adapter.id === "sip_freeswitch_rtp_legacy");
    assert.equal(legacySipAdapter.implementedNow, true);
    assert.match(legacySipAdapter.blocker, /proof diagnostics/);
    const fixtureAdapter = adapters.find((adapter: any) => adapter.id === "fixture_audio_injection");
    assert.equal(fixtureAdapter.implementedNow, true);
    assert.equal(fixtureAdapter.currentEntryPoint, "scripts/pipecat-fixture-pipeline-smoke.py --input-wav <mono-pcm16.wav>");
    assert.equal(fixtureAdapter.contractEntryPoint, "scripts/pipecat-fixture-pipeline-smoke.py --contract-only");
    assert.match(fixtureAdapter.path, /InputAudioRawFrame/);
    assert.match(fixtureAdapter.blocker, /build_acc_voice_pipeline\(\)/);
    assert.match(fixtureAdapter.blocker, /sidecars/);
    assert.match(adapters.find((adapter: any) => adapter.id === "signalwire_sip_trunk").blocker, /past-call import remains out of scope/);

    assert.deepEqual(payload.reviewBlockers, [
      "Pipecat Flows/FlowManager does not yet own the cancellation-rescue conversation flow; ACC TypeScript still owns policy hold, operator steer, proof artifacts, and queue state.",
    ]);
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "browser_webrtc_uses_pipecat_rtc_asr_kokoro").passed,
      true,
    );
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "sip_freeswitch_verto_route_configured").passed,
      true,
    );
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "sip_caller_audible_playback_live_proof").passed,
      true,
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
    assert.equal(
      payload.acceptanceCriteria.find((criterion: any) => criterion.name === "pipecat_flows_flowmanager_owns_conversation_flow").passed,
      false,
    );
    assert.equal(payload.remainingWork.some((item: string) => item.includes("Implement the Verto incoming-call media answer")), false);
    assert.equal(payload.remainingWork.some((item: string) => item.includes("Capture live softphone evidence")), false);
    assert.equal(payload.remainingWork.some((item: string) => item.includes("FlowManager")), true);
    assert.deepEqual(payload.liveSipProofAcceptance, {
      requiredManifestFlags: ["live_capture", "rtc_asr_live", "pipecat_verto_webrtc", "caller_audible_playback"],
      requiredRuntimeEndpoints: [
        { id: "acc_http", defaultUrl: "http://127.0.0.1:8026", evidence: "ACC health/readiness routes are reachable while the SIP proof listener runs." },
        { id: "freeswitch_sip", defaultAddress: "127.0.0.1:5060", evidence: "A local softphone can place an accepted INVITE to extension 8600." },
        { id: "freeswitch_esl", defaultAddress: "127.0.0.1:8021", evidence: "freeswitch-acc-bridge can observe CHANNEL_ANSWER and RTP call events." },
        { id: "freeswitch_verto", defaultUrl: "ws://127.0.0.1:8081", evidence: "FreeSWITCH Verto accepts the registered acc-pipecat WebRTC agent leg." },
        { id: "pipecat_verto_bridge", defaultUrl: "http://127.0.0.1:8770/health", evidence: "Pipecat Verto sidecar is registered and ready to answer the FreeSWITCH WebRTC dialog." },
        { id: "rtc_asr_ws", env: "RTC_ASR_WS_URL", evidence: "The current call audio is transcribed into fresh rtc_asr_live final transcript evidence." },
        { id: "kokoro_http", env: "KOKORO_BASE_URL", evidence: "Kokoro returns TTS audio that is packetized and played back to the caller." },
      ],
      rejectedShortcuts: [
        "generated_media_without_live_capture",
        "stale_rtc_asr_evidence_reused_across_calls",
        "uuid_broadcast_without_caller_capture",
        "parked_esl_post_hangup_transcription",
      ],
      proofBundleCommand: "node scripts/live-sip-proof-bundle.mjs --require-live-capture --require-rtc-asr-live --require-caller-playback",
    });
    assert.deepEqual(payload.nextUnblockedSlice, {
      id: "flow_manager_conversation_migration",
      title: "Move cancellation-rescue policy flow into Pipecat Flows/FlowManager",
      adapter: "pipecat_flows",
      entryPoint: "scripts/acc_pipecat_voice_pipeline.py",
      targetContract: "FlowManager nodes own cancellation-rescue state transitions while ACC TypeScript retains product state, operator controls, proof artifacts, and queue state.",
      verification: "Run the sidecar-free FlowManager contract check plus route tests proving policy_hold and operator_steer still fail closed before #222 can be accepted.",
      migrationStages: [
        {
          id: "sidecar_free_contract_lock",
          deliverable: "Keep the TypeScript parity harness as the acceptance contract before moving runtime ownership.",
          verificationCommand: "npm run pipecat:flows:contract",
        },
        {
          id: "flowmanager_node_handlers",
          deliverable: "Mirror call_started, greet, diagnose, policy_hold, operator_steer, steered_response, and wrap as Pipecat FlowManager node handlers.",
          verificationCommand: "npm run pipecat:flows:contract",
          status: "implemented_contract_only",
        },
        {
          id: "acc_runtime_adapter_cutover",
          deliverable: "Route caller turns through FlowManager while ACC continues to own product state, operator controls, proof artifacts, and queue state.",
          verificationCommand: "npm test",
        },
      ],
      acceptance: {
        requiredFlowNodes: ["call_started", "greet", "diagnose", "policy_hold", "operator_steer", "steered_response", "wrap"],
        retainedAccOwnership: ["product_state", "operator_controls", "proof_artifacts", "queue_state"],
        rejectedShortcuts: [
          "typescript_only_flow_claimed_as_flowmanager",
          "flowmanager_without_policy_hold_guard",
          "flowmanager_without_operator_steer_handoff",
        ],
      },
    });
    assert.deepEqual(payload.flowManagerContract.requiredNodes, [
      "call_started",
      "greet",
      "diagnose",
      "policy_hold",
      "operator_steer",
      "steered_response",
      "wrap",
    ]);
    assert.equal(payload.flowManagerContract.sidecarFree, true);
    assert.equal(payload.flowManagerContract.status, "node_handlers_mirrored_adapter_cutover_pending");
    assert.equal(payload.flowManagerContract.runtimePlan.runtimeAdapter, "pipecat_flows.FlowManager");
    assert.deepEqual(payload.flowManagerContract.runtimePlan.missingRequiredNodes, []);
    assert.equal(payload.flowManagerContract.requiredGuards.every((guard: any) => guard.failClosed), true);
    assert.deepEqual(
      payload.flowManagerContract.parityChecks.map((check: any) => check.id),
      ["scripted_policy_hold", "operator_steer_handoff", "runtime_failure_fail_closed"],
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
