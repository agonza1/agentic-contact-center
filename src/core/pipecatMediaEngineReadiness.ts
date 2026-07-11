const issue214 = "agonza1/agentic-contact-center#214";
const issue214Url = "https://github.com/agonza1/agentic-contact-center/issues/214";

export function buildPipecatMediaEngineReadinessPayload() {
  const realtimeRtpBlocker =
    "FreeSWITCH RTP is not yet streamed bidirectionally through Pipecat frames; the current SIP bridge records/captures media, posts ACC events, and can attach rtc-asr evidence after capture.";

  return {
    ok: true,
    route: "/api/pipecat-media-engine/readiness",
    issue: issue214,
    issueUrl: issue214Url,
    status: "shared_contract_ready_sip_rtp_blocked",
    reviewReady: false,
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
          transport: "browser WebRTC/WebSocket media bridge",
          implementedNow: true,
          currentEntryPoint: "scripts/pipecat-local-voice-bridge.py",
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
      "Browser voice turns are normalized into Pipecat frames by scripts/pipecat-local-voice-bridge.py and use rtc-asr, ACC caller-turn, and Kokoro.",
      "Local SIP and FreeSWITCH proof paths preserve live_capture/generated_media labels, attach WAV/SIP artifacts, and fail closed when rtc-asr evidence is absent.",
      "SignalWire readiness is explicit through local webhook labels and the future SIP trunk-to-FreeSWITCH route.",
      "Operator console payloads label local_sip, signalwire_live, live_capture, generated_media, rtc_asr_live, and rtc_asr_blocked modes.",
    ],
    remainingWork: [
      "Implement a FreeSWITCH RTP adapter that decodes inbound RTP to Pipecat InputAudioRawFrame in realtime.",
      "Stream Kokoro/Pipecat TTSAudioRawFrame output back to FreeSWITCH RTP for SIP caller playback.",
      "Feed rtc-asr final transcripts from the SIP media adapter directly into the shared ACC call-turn loop during the call.",
      "Route SignalWire DIDs through the same FreeSWITCH/Pipecat trunk path and add a separate past-call importer if historical call ingestion is required.",
    ],
    reviewBlockers: [realtimeRtpBlocker],
    acceptanceCriteria: [
      {
        name: "browser_webrtc_uses_pipecat_rtc_asr_kokoro",
        passed: true,
        evidence: "scripts/pipecat-local-voice-bridge.py normalizes browser audio to Pipecat frames and calls rtc-asr, ACC, and Kokoro.",
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
        name: "tests_cover_readiness_contract",
        passed: true,
        evidence: "test/pipecatMediaEngineReadinessRoute.test.ts covers the route shape and blocker.",
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
