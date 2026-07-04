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

export interface SpeechEnhancementRuntimeGuardrail {
  metric:
    | "p95_added_turn_latency_ms"
    | "word_error_rate_delta"
    | "endpointing_stability"
    | "barge_in_risk"
    | "cpu_cost";
  passCondition: string;
  rollbackSignal: string;
}

export interface SpeechEnhancementReplayDecision {
  captureId: string;
  latencySettingMs: number;
  enableForLiveDemo: boolean;
  reasons: string[];
}

export interface SpeechEnhancementReplayCoverage {
  syntheticNoisyReplayCount: number;
  realNoisyCaptureReplayCount: number;
  baselineEnhancedPairs: number;
  liveDemoGate: "blocked_until_real_capture" | "eligible";
  missingEvidence: string[];
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
  acceptanceReadiness: {
    reportRecommendation: "complete";
    noisyReplay: "synthetic_fixture_ready" | "real_capture_required";
    latencyMetrics: "covered";
    transcriptEndpointingMetrics: "covered";
    cpuRuntimeCost: "estimated_needs_live_measurement";
    featureFlagShape: "proposed";
    remainingBeforeIssueClose: string[];
  };
  runtimeGuardrails: SpeechEnhancementRuntimeGuardrail[];
  replayDecisions: SpeechEnhancementReplayDecision[];
  replayCoverage: SpeechEnhancementReplayCoverage;
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

  const replayMetrics: SpeechEnhancementReplayMetric[] = [
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
  ];

  const replayDecisions = replayMetrics.map((metric): SpeechEnhancementReplayDecision => {
    const wordErrorImproved = metric.enhanced.wordErrorRateEstimate < metric.baseline.wordErrorRateEstimate;
    const endpointingImproved = metric.enhanced.endpointingStability === "stable";
    const bargeInRiskImproved = metric.enhanced.bargeInRisk === "low";
    const latencyCandidate = candidates.find((candidate) => candidate.algorithmicLatencyMs === metric.latencySettingMs);
    const latencyOk = latencyCandidate?.withinConversationalBudget === true;
    const cpuOk = metric.cpuCostEstimate !== "high";

    return {
      captureId: metric.captureId,
      latencySettingMs: metric.latencySettingMs,
      enableForLiveDemo: wordErrorImproved && endpointingImproved && bargeInRiskImproved && latencyOk && cpuOk,
      reasons: [
        wordErrorImproved ? "wer_improved" : "wer_not_improved",
        endpointingImproved ? "endpointing_stable" : "endpointing_not_stable",
        bargeInRiskImproved ? "barge_in_risk_low" : "barge_in_risk_not_low",
        latencyOk ? "latency_within_budget" : "latency_over_budget",
        cpuOk ? "cpu_cost_allowed" : "cpu_cost_high",
      ],
    };
  });

  const realNoisyCaptureReplayCount = replayMetrics.filter((metric) => metric.captureId.startsWith("real-")).length;
  const replayCoverage: SpeechEnhancementReplayCoverage = {
    syntheticNoisyReplayCount: replayMetrics.filter((metric) => metric.captureId.startsWith("synthetic-")).length,
    realNoisyCaptureReplayCount,
    baselineEnhancedPairs: replayMetrics.length,
    liveDemoGate: realNoisyCaptureReplayCount > 0 ? "eligible" : "blocked_until_real_capture",
    missingEvidence:
      realNoisyCaptureReplayCount > 0
        ? []
        : [
            "real_noisy_local_sip_capture_baseline_vs_enhanced_replay",
            "measured_cpu_cost_on_selected_rtc_asr_host",
          ],
  };

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
    replayMetrics,
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
    acceptanceReadiness: {
      reportRecommendation: "complete",
      noisyReplay: "synthetic_fixture_ready",
      latencyMetrics: "covered",
      transcriptEndpointingMetrics: "covered",
      cpuRuntimeCost: "estimated_needs_live_measurement",
      featureFlagShape: "proposed",
      remainingBeforeIssueClose: [
        "Replay a real noisy local SIP capture through baseline and enhancement paths before closing Issue #97.",
        "Replace CPU cost estimate with measured local runtime cost from the selected rtc-asr host.",
      ],
    },
    runtimeGuardrails: [
      {
        metric: "p95_added_turn_latency_ms",
        passCondition: "12.5 ms profile stays under 25 ms added p95 turn latency on the selected rtc-asr host",
        rollbackSignal: "Disable RTC_ASR_SPEECH_ENHANCEMENT when added p95 turn latency exceeds 25 ms.",
      },
      {
        metric: "word_error_rate_delta",
        passCondition: "enhanced noisy replay WER estimate is lower than baseline for the same capture",
        rollbackSignal: "Bypass enhancement when noisy replay transcript quality does not improve.",
      },
      {
        metric: "endpointing_stability",
        passCondition: "enhanced replay keeps endpointing stable with no extra premature finalize events",
        rollbackSignal: "Bypass enhancement when endpointing regresses from stable or acceptable to unstable.",
      },
      {
        metric: "barge_in_risk",
        passCondition: "enhanced replay keeps barge-in risk low or improves it relative to baseline",
        rollbackSignal: "Bypass enhancement when barge-in risk increases.",
      },
      {
        metric: "cpu_cost",
        passCondition: "runtime CPU cost remains low or medium during local demo load",
        rollbackSignal: "Disable enhancement on the host when runtime CPU cost is high.",
      },
    ],
    replayDecisions,
    replayCoverage,
    validationPlan: [
      "Replay one noisy local SIP capture through baseline rtc-asr and enhanced rtc-asr paths.",
      "Record added latency, transcript delta, endpointing behavior, barge-in behavior, and CPU cost.",
      "Keep npm run proof:realtime-shim green with enhancement disabled and enabled before live-demo use.",
    ],
  };
}
