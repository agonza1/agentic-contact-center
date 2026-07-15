const issue214 = "agonza1/agentic-contact-center#214";
const issue214Url = "https://github.com/agonza1/agentic-contact-center/issues/214";
const issue222 = "agonza1/agentic-contact-center#222";
const issue222Url = "https://github.com/agonza1/agentic-contact-center/issues/222";

export function buildPipecatMediaEngineReadinessPayload() {
  const liveSoftphoneProofBlocker =
    "Local 8600 return audio is wired through Kokoro/Pipecat TTS, PCMU RTP packetization evidence, and FreeSWITCH uuid_broadcast WAV playback; live softphone capture still needs to prove the caller heard that playback end-to-end.";
  const liveSipProofAcceptance = {
    requiredManifestFlags: ["live_capture", "rtc_asr_live", "pipecat_rtp_playback_sent", "caller_audible_playback"],
    requiredRuntimeEndpoints: [
      { id: "acc_http", defaultUrl: "http://127.0.0.1:8026", evidence: "ACC health/readiness routes are reachable while the SIP proof listener runs." },
      { id: "freeswitch_sip", defaultAddress: "127.0.0.1:5060", evidence: "A local softphone can place an accepted INVITE to extension 8600." },
      { id: "freeswitch_esl", defaultAddress: "127.0.0.1:8021", evidence: "freeswitch-acc-bridge can observe CHANNEL_ANSWER and RTP call events." },
      { id: "rtc_asr_ws", env: "RTC_ASR_WS_URL", evidence: "The current call audio is transcribed into fresh rtc_asr_live final transcript evidence." },
      { id: "kokoro_http", env: "KOKORO_BASE_URL", evidence: "Kokoro returns TTS audio that is packetized and played back to the caller." },
    ],
    rejectedShortcuts: [
      "generated_media_without_live_capture",
      "stale_rtc_asr_evidence_reused_across_calls",
      "uuid_broadcast_without_caller_capture",
    ],
    proofBundleCommand: "node scripts/live-sip-proof-bundle.mjs --require-live-capture --require-rtc-asr-live --require-caller-playback",
  };
  const nextUnblockedSlice = {
    id: "live_softphone_playback_acceptance",
    title: "Capture end-to-end softphone playback proof",
    adapter: "sip_freeswitch_rtp",
    entryPoint: "scripts/freeswitch-acc-bridge.mjs",
    targetContract: "softphone SIP call -> FreeSWITCH RTP -> Pipecat input frames -> rtc-asr transcript -> ACC turn -> Kokoro/Pipecat TTS -> PCMU RTP playback heard by caller",
    verification: "scripts/live-sip-proof-bundle.mjs must carry live_capture, rtc_asr_live, Pipecat RTP playback send evidence, and caller-audible playback proof before issue #214 can be accepted.",
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
        transport: "FreeSWITCH/SIP RTP adapter",
        sharesPipelineProcessors: false,
        processorContractAligned: true,
        liveMediaProofComplete: false,
        note: "SIP is a FreeSWITCH/RTP transport aligned to the rtc-asr, ACC adapter, and Kokoro processor contract. It must not be called complete until it is wired through the shared Pipeline processors and live caller-audible proof exists.",
        pipelineUnificationDelta: [
          "Move SIP RTP PCM frames into build_acc_voice_pipeline() instead of the Node mirror of rtc-asr/ACC/Kokoro stages.",
          "Reuse the same RtcAsrTurnProcessor, AccCallerTurnProcessor, and KokoroTtsProcessor stage-event contract as the browser SmallWebRTC path.",
          "Keep FreeSWITCH packetization and uuid_broadcast at the telephony boundary after transport.output() emits caller audio.",
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
          id: "sip_freeswitch_rtp",
          source: "FreeSWITCH local SIP extension 8600",
          transport: "SIP/FreeSWITCH RTP",
          implementedNow: true,
          processorContractAligned: true,
          liveMediaProofComplete: false,
          currentEntryPoint: "scripts/freeswitch-acc-bridge.mjs",
          path: "SIP/FreeSWITCH RTP -> Pipecat-compatible PCM frames -> rtc-asr -> ACC caller-turn -> Kokoro -> FreeSWITCH uuid_broadcast caller playback",
          pipelineUnificationDelta: "Replace mirrored Node processor orchestration with build_acc_voice_pipeline() while preserving FreeSWITCH RTP ingress/egress and proof manifests.",
          blocker: `${liveSoftphoneProofBlocker} The adapter is not yet the same Python Pipeline object used by the browser SmallWebRTC path.`,
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
      "Local SIP and FreeSWITCH proof paths preserve live_capture/generated_media labels, attach WAV/SIP artifacts, collect live PCMU RTP into Pipecat-compatible frame evidence, stream captured frames to rtc-asr when RTC_ASR_WS_URL is set, packetize Kokoro/Pipecat-shaped TTS frames as PCMU RTP, write Kokoro WAV playback artifacts, issue FreeSWITCH uuid_broadcast, and report RTP socket-send playback evidence. This is transport alignment, not completed SIP acceptance.",
      "Fixture/tester audio can now be injected through an in-process Pipecat source/sink around build_acc_voice_pipeline(), with sidecar-free contract mode retained for CI.",
      "SignalWire readiness is explicit through local webhook labels and the future SIP trunk-to-FreeSWITCH route.",
      "Operator console payloads label local_sip, signalwire_live, live_capture, generated_media, rtc_asr_live, and rtc_asr_blocked modes.",
    ],
    remainingWork: [
      "Run the live fixture/tester injection adapter with sidecars in CI or local proof mode and archive captured OutputAudioRawFrame evidence with the media-engine readiness artifact.",
      "Wire the SIP media adapter through the same shared Pipecat Pipeline processors used by the browser SmallWebRTC path instead of only mirroring their rtc-asr/ACC/Kokoro contract.",
      "Capture live softphone evidence that the caller hears Kokoro/Pipecat TTS played through FreeSWITCH uuid_broadcast on the 8600 path.",
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
        name: "sip_freeswitch_processor_contract_aligned",
        passed: true,
        evidence: "scripts/freeswitch-acc-bridge.mjs preserves the rtc-asr -> ACC caller-turn -> Kokoro contract behind a FreeSWITCH/RTP transport, but does not yet instantiate the same Python Pipeline object as the browser path.",
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
