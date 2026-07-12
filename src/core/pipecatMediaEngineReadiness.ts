const issue214 = "agonza1/agentic-contact-center#214";
const issue214Url = "https://github.com/agonza1/agentic-contact-center/issues/214";
const issue222 = "agonza1/agentic-contact-center#222";
const issue222Url = "https://github.com/agonza1/agentic-contact-center/issues/222";

export function buildPipecatMediaEngineReadinessPayload() {
  const realtimeRtpBlocker =
    "Live softphone caller playback has not yet been accepted end-to-end; the current SIP bridge can collect FreeSWITCH RTP into Pipecat input frames, stream those frames to rtc-asr, packetize Pipecat/Kokoro TTS frames back to PCMU RTP, and report socket-send playback evidence.";
  const nextUnblockedSlice = {
    id: "live_softphone_playback_acceptance",
    title: "Capture end-to-end softphone playback proof",
    adapter: "sip_freeswitch_rtp",
    entryPoint: "scripts/freeswitch-acc-bridge.mjs",
    targetContract: "softphone SIP call -> FreeSWITCH RTP -> Pipecat input frames -> rtc-asr transcript -> ACC turn -> Kokoro/Pipecat TTS -> PCMU RTP playback heard by caller",
    verification: "scripts/live-sip-proof-bundle.mjs must carry live_capture, rtc_asr_live, Pipecat RTP playback send evidence, and caller-audible playback proof before issue #214 can be accepted.",
  };

  return {
    ok: true,
    route: "/api/pipecat-media-engine/readiness",
    issue: issue214,
    issueUrl: issue214Url,
    status: "shared_contract_ready_sip_rtp_blocked",
    reviewReady: false,
    pipecat14Alignment: {
      issue: issue222,
      issueUrl: issue222Url,
      status: "migration_contract_recorded",
      packageRequirement: "pipecat-ai[webrtc]==1.4.0",
      primaryTransportTarget: "SmallWebRTCTransport",
      targetPipeline: ["transport.input", "rtc-asr STT", "ACC caller-turn adapter", "Kokoro TTS", "transport.output"],
      browserPrimaryBridge: {
        current: "scripts/pipecat-browser-webrtc-bridge.py",
        target: "Pipecat SmallWebRTCTransport offer route backed by a Pipeline",
        legacyFallbackAllowed: false,
      },
      sipTransportStrategy: {
        transport: "FreeSWITCH/SIP RTP adapter",
        sharesPipelineProcessors: true,
        note: "SIP should feed the same rtc-asr, ACC adapter, and Kokoro processors; SmallWebRTCTransport remains browser-only.",
      },
      flowsDecision: {
        owner: "ACC TypeScript flow for current cancellation-rescue MVP",
        flowManagerRequiredNow: false,
        rationale: "Policy hold, operator steer, proof artifacts, and queue state already live in ACC; Pipecat Flows can be revisited after the shared media Pipeline is live.",
      },
      deprecatedBridges: [
        {
          entryPoint: "scripts/pipecat-local-voice-bridge.py",
          status: "legacy_proof_only",
          replacement: "SmallWebRTCTransport + Pipeline browser path",
        },
      ],
      nextUnblockedSlice: "Replace the custom aiortc turn loop with a SmallWebRTCTransport/Pipeline sidecar while preserving /api/browser-webrtc/session semantics.",
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
          implementedNow: false,
          currentEntryPoint: "scripts/freeswitch-acc-bridge.mjs",
          path: "SIP/FreeSWITCH RTP -> Pipecat InputAudioRawFrame -> rtc-asr -> ACC caller-turn -> Kokoro -> SIP/FreeSWITCH RTP",
          blocker: realtimeRtpBlocker,
        },
        {
          id: "signalwire_sip_trunk",
          source: "SignalWire SIP trunk routed to FreeSWITCH",
          transport: "SignalWire SIP trunk -> FreeSWITCH RTP",
          implementedNow: false,
          currentEntryPoint: "/api/signalwire/events and scripts/freeswitch-acc-bridge.mjs",
          path: "SignalWire SIP trunk -> FreeSWITCH/Pipecat -> rtc-asr -> ACC caller-turn -> Kokoro -> SignalWire caller",
          blocker: "SignalWire live path depends on the same missing FreeSWITCH RTP adapter; past-call import remains out of scope for the realtime trunk path.",
        },
      ],
    },
    implementedNow: [
      "Browser voice turns are normalized into Pipecat frames by scripts/pipecat-browser-webrtc-bridge.py and use rtc-asr, ACC caller-turn, and Kokoro; Issue #222 tracks replacing the custom aiortc loop with SmallWebRTCTransport plus Pipeline processors.",
      "Local SIP and FreeSWITCH proof paths preserve live_capture/generated_media labels, attach WAV/SIP artifacts, collect live PCMU RTP into Pipecat InputAudioRawFrameBatch evidence, stream captured frames to rtc-asr when RTC_ASR_WS_URL is set, packetize Pipecat/Kokoro TTS frames as PCMU RTP, and report RTP socket-send playback evidence.",
      "SignalWire readiness is explicit through local webhook labels and the future SIP trunk-to-FreeSWITCH route.",
      "Operator console payloads label local_sip, signalwire_live, live_capture, generated_media, rtc_asr_live, and rtc_asr_blocked modes.",
    ],
    remainingWork: [
      "Feed rtc-asr final transcripts from the SIP media adapter directly into the shared ACC call-turn loop during the call.",
      "Capture live softphone evidence that the caller hears packetized Kokoro/Pipecat TTS RTP playback through FreeSWITCH.",
      "Route SignalWire DIDs through the same FreeSWITCH/Pipecat trunk path and add a separate past-call importer if historical call ingestion is required.",
    ],
    nextUnblockedSlice,
    reviewBlockers: [realtimeRtpBlocker],
    acceptanceCriteria: [
      {
        name: "browser_webrtc_uses_pipecat_rtc_asr_kokoro",
        passed: true,
        evidence: "scripts/pipecat-browser-webrtc-bridge.py normalizes browser audio to Pipecat frames and calls rtc-asr, ACC, and Kokoro; SmallWebRTCTransport/Pipeline migration status is exposed under pipecat14Alignment.",
      },
      {
        name: "sip_freeswitch_uses_same_realtime_pipecat_engine",
        passed: false,
        evidence: realtimeRtpBlocker,
      },
      {
        name: "shared_media_engine_contract_documented",
        passed: true,
        evidence: "This readiness route exposes one contract for browser, local SIP/FreeSWITCH, and SignalWire SIP trunk adapters.",
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
        evidence: "scripts/freeswitch-acc-bridge.mjs accepts Pipecat OutputAudioRawFrame/TTSAudioRawFrame fixtures, packetizes them as PCMU RTP, sends them to the discovered FreeSWITCH playback target, and records playback send evidence in the live proof manifest.",
      },
      {
        name: "pipecat_14_small_webrtc_migration_recorded",
        passed: true,
        evidence: "requirements-pipecat-voice.txt requests pipecat-ai[webrtc]==1.4.0, the readiness payload records the SmallWebRTCTransport/Pipeline target, and docs/runtime-reference.md records the ACC-owned Flows decision.",
      },
    ],
    validationCommands: ["npm test", "curl -fsS http://127.0.0.1:8026/api/pipecat-media-engine/readiness"],
    relatedRoutes: [
      { route: "/api/pipecat-media-engine/readiness", method: "GET", purpose: "Shared browser/SIP/SignalWire Pipecat media engine contract and blocker status." },
      { route: "/api/live-sip/events", method: "POST", purpose: "Local SIP/FreeSWITCH event and proof adapter." },
      { route: "/api/signalwire/events", method: "POST", purpose: "Local SignalWire event adapter and future trunk label surface." },
      { route: "/api/realtime-shim/readiness", method: "GET", purpose: "Existing realtime shim readiness and sidecar promotion evidence." },
    ],
  };
}
