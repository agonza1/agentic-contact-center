const issue214 = "agonza1/agentic-contact-center#214";
const issue214Url = "https://github.com/agonza1/agentic-contact-center/issues/214";
const issue222 = "agonza1/agentic-contact-center#222";
const issue222Url = "https://github.com/agonza1/agentic-contact-center/issues/222";

export function buildPipecatMediaEngineReadinessPayload() {
  const liveSoftphoneProofBlocker =
    "Local 8600 now routes to the preferred FreeSWITCH Verto/WebRTC agent leg, but live softphone capture still needs to prove caller PCM reaches Pipecat and Kokoro/Pipecat audio returns through that same active call.";
  const liveSipProofAcceptance = {
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
  };
  const nextUnblockedSlice = {
    id: "live_softphone_playback_acceptance",
    title: "Capture end-to-end softphone playback proof",
    adapter: "sip_freeswitch_verto",
    entryPoint: "scripts/pipecat-verto-agent-bridge.py",
    targetContract: "softphone SIP call -> FreeSWITCH Verto/WebRTC agent leg -> Pipecat input frames -> rtc-asr transcript -> ACC turn -> Kokoro/Pipecat TTS -> same Verto/WebRTC leg heard by caller",
    verification: "scripts/live-sip-proof-bundle.mjs must carry live_capture, rtc_asr_live, pipecat_verto_webrtc, and caller-audible playback proof before issue #222 can be accepted.",
    acceptance: liveSipProofAcceptance,
  };

  return {
    ok: true,
    route: "/api/pipecat-media-engine/readiness",
    issue: issue214,
    issueUrl: issue214Url,
    status: "shared_contract_ready_local_sip_playback_proof_pending",
    reviewReady: false,
    pipecat14Alignment: {
      issue: issue222,
      issueUrl: issue222Url,
      status: "small_webrtc_pipeline_primary",
      packageRequirement: "pipecat-ai[webrtc]==1.4.0",
      primaryTransportTarget: "SmallWebRTCTransport",
      targetPipeline: ["transport.input", "rtc-asr STT", "ACC caller-turn adapter", "Kokoro TTS", "transport.output"],
      browserPrimaryBridge: {
        current: "scripts/pipecat-browser-webrtc-bridge.py",
        target: "Pipecat SmallWebRTCTransport offer route backed by a Pipeline",
        implementedNow: true,
        legacyFallbackAllowed: false,
      },
      sipTransportStrategy: {
        transport: "FreeSWITCH Verto/WebRTC agent leg",
        sharesPipelineProcessors: true,
        processorContractAligned: true,
        liveMediaProofComplete: false,
        preferredRoute: "Linphone SIP 1000 -> FreeSWITCH 8600 -> registered Verto user acc-pipecat -> Pipecat Verto/WebRTC sidecar",
        legacyFallback: "scripts/freeswitch-acc-bridge.mjs remains a proof/debug bridge and must not be used as the acceptance route for #222.",
        note: "SIP is now targeted at a FreeSWITCH-owned WebRTC/Verto leg. It must not be called complete until that active leg feeds the shared Pipecat processors and live caller-audible proof exists.",
        pipelineUnificationDelta: [
          "Answer incoming Verto dialogs with a Pipecat media transport that calls build_acc_voice_pipeline().",
          "Reuse the same RtcAsrTurnProcessor, AccCallerTurnProcessor, and KokoroTtsProcessor stage-event contract as the browser SmallWebRTC path.",
          "Keep SIP/RTP and WebRTC DTLS-SRTP/Opus ownership inside FreeSWITCH; Pipecat should only see decoded PCM frames.",
        ],
      },
      flowsDecision: {
        owner: "ACC TypeScript flow for current cancellation-rescue MVP",
        flowManagerRequiredNow: false,
        rationale: "Policy hold, operator steer, proof artifacts, and queue state already live in ACC; Pipecat Flows can be revisited after the shared media Pipeline is live.",
      },
      deprecatedBridges: [
        {
          entryPoint: "scripts/pipecat-local-voice-bridge.py",
          status: "removed",
          replacement: "SmallWebRTCTransport + Pipeline browser path",
        },
      ],
      nextUnblockedSlice: "Capture live browser media proof against the SmallWebRTCTransport/Pipeline sidecar while preserving /api/browser-webrtc/session semantics.",
    },
    sharedEngineContract: {
      engine: "pipecat-ai",
      callTurnEngine: "rtc-asr -> ACC caller-turn -> Kokoro",
      normalizedAudioFrame: {
        format: "pcm_s16le",
        browserInputSampleRateHz: 16000,
        sipInputSampleRateHz: 8000,
        ttsOutputSampleRateHz: 24000,
        sipCodecBoundary: "PCMU/8000 RTP from FreeSWITCH must be decoded to PCM16 before Pipecat and encoded back for RTP playback.",
      },
      requiredAdapters: [
        {
          id: "browser_webrtc",
          source: "browser microphone",
          transport: "browser WebRTC bridge; target is Pipecat SmallWebRTCTransport",
          implementedNow: true,
          currentEntryPoint: "scripts/pipecat-browser-webrtc-bridge.py",
          path: "browser mic -> Pipecat InputAudioRawFrame -> rtc-asr -> ACC caller-turn -> Kokoro -> browser playback",
        },
        {
          id: "sip_freeswitch_verto",
          source: "FreeSWITCH local SIP extension 8600",
          transport: "SIP/FreeSWITCH bridged to Verto/WebRTC",
          implementedNow: true,
          processorContractAligned: true,
          liveMediaProofComplete: false,
          currentEntryPoint: "scripts/pipecat-verto-agent-bridge.py",
          freeswitchDialplan: "freeswitch/conf/dialplan/default/acc_local_sip.xml bridges 8600 to ${verto_contact(acc-pipecat@$${domain})}",
          path: "SIP/FreeSWITCH RTP -> Verto/WebRTC agent leg -> Pipecat PCM frames -> rtc-asr -> ACC caller-turn -> Kokoro -> same Verto/WebRTC leg -> SIP caller",
          pipelineUnificationDelta: "Verto WebRTC dialog answers are routed through build_acc_voice_pipeline(); strict acceptance still waits on caller-side playback capture.",
          blocker: `${liveSoftphoneProofBlocker} The Verto media answer is implemented, but live caller audio plus returned Kokoro/Pipecat playback proof is still required.`,
        },
        {
          id: "sip_freeswitch_rtp_legacy",
          source: "FreeSWITCH local SIP extension 8600 legacy proof/debug lane",
          transport: "SIP/FreeSWITCH RTP plus ESL uuid_broadcast",
          implementedNow: true,
          processorContractAligned: true,
          liveMediaProofComplete: false,
          currentEntryPoint: "scripts/freeswitch-acc-bridge.mjs",
          path: "SIP/FreeSWITCH RTP -> Node proof bridge -> rtc-asr -> ACC caller-turn -> Kokoro -> uuid_broadcast/RTP playback",
          blocker: "This lane is retained for proof diagnostics only and is no longer the preferred #222 SIP acceptance route.",
        },
        {
          id: "fixture_audio_injection",
          source: "deterministic PCM/WAV fixture or tester harness audio",
          transport: "fixture/tester injection adapter",
          implementedNow: true,
          currentEntryPoint: "scripts/pipecat-fixture-pipeline-smoke.py --input-wav <mono-pcm16.wav>",
          contractEntryPoint: "scripts/pipecat-fixture-pipeline-smoke.py --contract-only",
          path: "fixture PCM/WAV -> Pipecat InputAudioRawFrame -> rtc-asr -> ACC caller-turn -> Kokoro -> captured OutputAudioRawFrame proof",
          blocker: "Live fixture execution now feeds build_acc_voice_pipeline() through in-process Pipecat source/sink processors; full success still requires ACC, rtc-asr, and Kokoro sidecars to be running.",
        },
        {
          id: "signalwire_sip_trunk",
          source: "SignalWire SIP trunk routed to FreeSWITCH",
          transport: "SignalWire SIP trunk -> FreeSWITCH RTP",
          implementedNow: false,
          currentEntryPoint: "/api/signalwire/events and scripts/freeswitch-acc-bridge.mjs",
          path: "SignalWire SIP trunk -> FreeSWITCH/Pipecat -> rtc-asr -> ACC caller-turn -> Kokoro -> SignalWire caller",
          blocker: "SignalWire live path depends on the same FreeSWITCH/Pipecat bridge plus trunk routing proof; past-call import remains out of scope for the realtime trunk path.",
        },
      ],
    },
    implementedNow: [
      "Browser voice turns use scripts/pipecat-browser-webrtc-bridge.py with Pipecat SmallWebRTCTransport and a Pipeline of rtc-asr, ACC caller-turn, Kokoro, and transport output processors.",
      "Local SIP extension 8600 now targets a registered FreeSWITCH Verto/WebRTC user (acc-pipecat) and a Pipecat Verto sidecar health surface; the older ESL/RTP bridge remains proof/debug support, not the preferred acceptance path.",
      "Fixture/tester audio can now be injected through an in-process Pipecat source/sink around build_acc_voice_pipeline(), with sidecar-free contract mode retained for CI.",
      "SignalWire readiness is explicit through local webhook labels and the future SIP trunk-to-FreeSWITCH route.",
      "Operator console payloads label local_sip, signalwire_live, live_capture, generated_media, rtc_asr_live, and rtc_asr_blocked modes.",
    ],
    remainingWork: [
      "Run the live fixture/tester injection adapter with sidecars in CI or local proof mode and archive captured OutputAudioRawFrame evidence with the media-engine readiness artifact.",
      "Implement the Verto incoming-call media answer so the active FreeSWITCH WebRTC leg feeds the same shared Pipecat Pipeline processors used by the browser SmallWebRTC path.",
      "Capture live softphone evidence that the caller hears Kokoro/Pipecat TTS returned through the same bridged Verto/WebRTC leg on the 8600 path.",
      "Route SignalWire DIDs through the same FreeSWITCH/Pipecat trunk path and add a separate past-call importer if historical call ingestion is required.",
    ],
    nextUnblockedSlice,
    liveSipProofAcceptance,
    reviewBlockers: [liveSoftphoneProofBlocker],
    acceptanceCriteria: [
      {
        name: "browser_webrtc_uses_pipecat_rtc_asr_kokoro",
        passed: true,
        evidence: "scripts/pipecat-browser-webrtc-bridge.py builds SmallWebRTCTransport plus Pipeline([transport.input(), RtcAsrTurnProcessor, AccCallerTurnProcessor, KokoroTtsProcessor, transport.output()]).",
      },
      {
        name: "sip_freeswitch_verto_route_configured",
        passed: true,
        evidence: "freeswitch/conf/dialplan/default/acc_local_sip.xml bridges 8600 to the registered Verto user acc-pipecat, docker-compose exposes Verto 8081/8082, and scripts/pipecat-verto-agent-bridge.py owns the sidecar health/registration surface.",
      },
      {
        name: "sip_caller_audible_playback_live_proof",
        passed: false,
        evidence: "SIP remains blocked until a fresh Linphone/FreeSWITCH 8600 proof bundle shows caller-audible Kokoro/Pipecat playback plus current rtc-asr final transcript evidence.",
      },
      {
        name: "shared_media_engine_contract_documented",
        passed: true,
        evidence: "This readiness route exposes one contract for browser, fixture/tester, local SIP/FreeSWITCH, and SignalWire SIP trunk adapters.",
      },
      {
        name: "fixture_tester_pipeline_adapter_present",
        passed: true,
        evidence: "scripts/pipecat-fixture-pipeline-smoke.py supports --contract-only and --input-wav live in-process modes; the live mode calls build_acc_voice_pipeline() with fixture source/sink processors and captures OutputAudioRawFrame proof when ACC, rtc-asr, and Kokoro are available.",
      },
      {
        name: "operator_console_runtime_labels",
        passed: true,
        evidence: "Live SIP ingress tests assert local_sip/live_capture/rtc_asr_blocked labels and SignalWire can be labeled signalwire_live.",
      },
      {
        name: "signalwire_past_call_gap_explicit",
        passed: true,
        evidence: "SignalWire future path is SIP trunk -> FreeSWITCH/Pipecat; past-call import is not part of the realtime trunk path.",
      },
      {
        name: "rtp_pcmu_fixture_decodes_to_pipecat_input_frame",
        passed: true,
        evidence: "test/pipecatRtpAdapter.test.ts covers deterministic PCMU RTP -> PCM16 InputAudioRawFrame fixtures plus batch sequence-gap metadata; scripts/freeswitch-acc-bridge.mjs can collect live RTP packets into matching manifest evidence.",
      },
      {
        name: "pipecat_tts_frames_packetize_to_freeswitch_rtp",
        passed: true,
        evidence: "scripts/freeswitch-acc-bridge.mjs accepts Pipecat OutputAudioRawFrame/TTSAudioRawFrame fixtures, packetizes them as PCMU RTP, sends them to the discovered FreeSWITCH playback target, writes the same Kokoro frame as a WAV, issues FreeSWITCH uuid_broadcast for caller-audible playback, and records playback send evidence in the live proof manifest.",
      },
      {
        name: "pipecat_14_small_webrtc_migration_recorded",
        passed: true,
        evidence: "requirements-pipecat-voice.txt requests pipecat-ai[webrtc]==1.4.0, the browser sidecar imports SmallWebRTCTransport/Pipeline, and docs/runtime-reference.md records the ACC-owned Flows decision.",
      },
    ],
    validationCommands: ["npm test", "curl -fsS http://127.0.0.1:8026/api/pipecat-media-engine/readiness"],
    relatedRoutes: [
      { route: "/api/pipecat-media-engine/readiness", method: "GET", purpose: "Shared browser/SIP/SignalWire Pipecat media engine contract and proof-pending status." },
      { route: "/api/live-sip/events", method: "POST", purpose: "Local SIP/FreeSWITCH event and proof adapter." },
      { route: "/api/signalwire/events", method: "POST", purpose: "Local SignalWire event adapter and future trunk label surface." },
      { route: "/api/browser-webrtc/readiness", method: "GET", purpose: "Browser WebRTC signaling and sidecar readiness evidence." },
    ],
  };
}
