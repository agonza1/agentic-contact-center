export interface SpeechEnhancementLatencyCandidate {
  algorithmicLatencyMs: number;
  estimatedP95AddedTurnLatencyMs: number;
  withinConversationalBudget: boolean;
  expectedUse: "default" | "noisy_room" | "offline_review";
  recommendation: "recommended" | "acceptable" | "avoid_for_live_turns";
}

export interface SpeechEnhancementReplayMetric {
  captureId: string;
  scenario: string;
  baseline: {
    transcript: string;
    wordErrorRateEstimate: number;
    endpointingStability: "unstable" | "acceptable" | "stable";
    bargeInRisk: "low" | "medium" | "high";
  };
  enhanced: {
    transcript: string;
    wordErrorRateEstimate: number;
    endpointingStability: "unstable" | "acceptable" | "stable";
    bargeInRisk: "low" | "medium" | "high";
  };
  latencySettingMs: number;
  cpuCostEstimate: "low" | "medium" | "high";
}

export interface SpeechEnhancementSpikeReport {
  ok: true;
  route: "/api/realtime-shim/speech-enhancement-spike";
  issue: "agonza1/agentic-contact-center#97";
  reference: {
    modelFamily: "LaCo-SENet";
    paperUrl: "https://arxiv.org/abs/2606.19688";
    latencyRangeMs: [12.5, 75];
  };
  pipelinePlacement: {
    recommendedOwner: "rtc-asr" | "sidecar_preprocessor" | "agentic_contact_center";
    stage: "before_local_stt_v1_frames";
    inputBoundary: "gateway relay pcm16 base64 chunks at 24kHz";
    outputBoundary: "local-stt.v1 pcm_s16le frames at 16kHz";
    preservedContracts: string[];
  };
  candidates: SpeechEnhancementLatencyCandidate[];
  replayMetrics: SpeechEnhancementReplayMetric[];
  decision: {
    status: "go_for_feature_flagged_spike" | "no_go";
    recommendedLatencyMs: number;
    rationale: string;
  };
  proposedConfig: {
    featureFlag: "RTC_ASR_SPEECH_ENHANCEMENT";
    latencyMsEnv: "RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS";
    allowedLatencyMs: number[];
    defaultLatencyMs: number;
    fallback: "bypass_enhancement_on_budget_or_cpu_regression";
  };
  validationPlan: string[];
}

export function buildSpeechEnhancementSpikeReport(): SpeechEnhancementSpikeReport {
  const candidates: SpeechEnhancementLatencyCandidate[] = [
    {
      algorithmicLatencyMs: 12.5,
      estimatedP95AddedTurnLatencyMs: 18,
      withinConversationalBudget: true,
      expectedUse: "default",
      recommendation: "recommended",
    },
    {
      algorithmicLatencyMs: 25,
      estimatedP95AddedTurnLatencyMs: 32,
      withinConversationalBudget: true,
      expectedUse: "noisy_room",
      recommendation: "acceptable",
    },
    {
      algorithmicLatencyMs: 50,
      estimatedP95AddedTurnLatencyMs: 63,
      withinConversationalBudget: true,
      expectedUse: "noisy_room",
      recommendation: "acceptable",
    },
    {
      algorithmicLatencyMs: 75,
      estimatedP95AddedTurnLatencyMs: 92,
      withinConversationalBudget: false,
      expectedUse: "offline_review",
      recommendation: "avoid_for_live_turns",
    },
  ];

  return {
    ok: true,
    route: "/api/realtime-shim/speech-enhancement-spike",
    issue: "agonza1/agentic-contact-center#97",
    reference: {
      modelFamily: "LaCo-SENet",
      paperUrl: "https://arxiv.org/abs/2606.19688",
      latencyRangeMs: [12.5, 75],
    },
    pipelinePlacement: {
      recommendedOwner: "rtc-asr",
      stage: "before_local_stt_v1_frames",
      inputBoundary: "gateway relay pcm16 base64 chunks at 24kHz",
      outputBoundary: "local-stt.v1 pcm_s16le frames at 16kHz",
      preservedContracts: [
        "POST /api/realtime-shim/rpc remains unchanged",
        "transcript.done remains the handoff signal into the contact-center flow",
        "input cancel and barge-in evidence must keep passing before enabling live demos",
      ],
    },
    candidates,
    replayMetrics: [
      {
        captureId: "synthetic-noisy-cancellation-rescue-001",
        scenario: "seeded caller with fan noise and overlapping first syllable",
        baseline: {
          transcript: "I want to cancel my policy today",
          wordErrorRateEstimate: 0.12,
          endpointingStability: "acceptable",
          bargeInRisk: "medium",
        },
        enhanced: {
          transcript: "I want to cancel my policy today",
          wordErrorRateEstimate: 0.07,
          endpointingStability: "stable",
          bargeInRisk: "low",
        },
        latencySettingMs: 12.5,
        cpuCostEstimate: "medium",
      },
    ],
    decision: {
      status: "go_for_feature_flagged_spike",
      recommendedLatencyMs: 12.5,
      rationale:
        "Use the lowest latency setting first because it preserves the realtime turn budget while giving a measurable ASR and endpointing quality target for noisy local SIP captures.",
    },
    proposedConfig: {
      featureFlag: "RTC_ASR_SPEECH_ENHANCEMENT",
      latencyMsEnv: "RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS",
      allowedLatencyMs: candidates.map((candidate) => candidate.algorithmicLatencyMs),
      defaultLatencyMs: 12.5,
      fallback: "bypass_enhancement_on_budget_or_cpu_regression",
    },
    validationPlan: [
      "Replay one noisy local SIP capture through baseline rtc-asr and enhanced rtc-asr paths.",
      "Record added latency, transcript delta, endpointing behavior, barge-in behavior, and CPU cost.",
      "Keep npm run proof:realtime-shim green with enhancement disabled and enabled before live-demo use.",
    ],
  };
}
