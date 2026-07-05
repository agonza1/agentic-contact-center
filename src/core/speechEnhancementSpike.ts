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
    addedTurnLatencyMsP95: number;
    cpuPercentP95: number;
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

export interface SpeechEnhancementReplayEvaluation {
  issueCloseReady: boolean;
  failingEvidence: string[];
  reasons: string[];
}

export interface SpeechEnhancementReplayCoverage {
  syntheticNoisyReplayCount: number;
  realNoisyCaptureReplayCount: number;
  baselineEnhancedPairs: number;
  liveDemoGate: "blocked_until_real_capture" | "eligible";
  missingEvidence: string[];
}

export interface SpeechEnhancementRolloutStep {
  step: "capture_replay" | "feature_flag" | "shadow_compare" | "live_enablement";
  owner: "agentic_contact_center" | "rtc_asr";
  gate: string;
}

export interface SpeechEnhancementCaptureReplayContract {
  requiredCaptureKind: "real_noisy_local_sip";
  fixtureManifestPath: "artifacts/speech-enhancement-real-capture-replay.json";
  requiredFields: string[];
  comparisonPairs: Array<"baseline_rtc_asr" | "enhanced_rtc_asr">;
  minimumPassingCriteria: string[];
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
    noisyReplay: "synthetic_fixture_ready" | "real_capture_required" | "real_capture_ready";
    latencyMetrics: "covered";
    transcriptEndpointingMetrics: "covered";
    cpuRuntimeCost: "estimated_needs_live_measurement";
    featureFlagShape: "proposed";
    remainingBeforeIssueClose: string[];
  };
  runtimeGuardrails: SpeechEnhancementRuntimeGuardrail[];
  replayDecisions: SpeechEnhancementReplayDecision[];
  replayCoverage: SpeechEnhancementReplayCoverage;
  captureReplayContract: SpeechEnhancementCaptureReplayContract;
  rolloutPlan: SpeechEnhancementRolloutStep[];
  validationPlan: string[];
}

const endpointingRank = new Map<SpeechEnhancementReplayMetric["baseline"]["endpointingStability"], number>([
  ["unstable", 0],
  ["acceptable", 1],
  ["stable", 2],
]);

const bargeInRiskRank = new Map<SpeechEnhancementReplayMetric["baseline"]["bargeInRisk"], number>([
  ["low", 0],
  ["medium", 1],
  ["high", 2],
]);

function isEndpointingNoWorse(
  enhanced: SpeechEnhancementReplayMetric["baseline"]["endpointingStability"],
  baseline: SpeechEnhancementReplayMetric["baseline"]["endpointingStability"],
): boolean {
  return endpointingRank.get(enhanced)! >= endpointingRank.get(baseline)!;
}

function isBargeInRiskNoWorse(
  enhanced: SpeechEnhancementReplayMetric["baseline"]["bargeInRisk"],
  baseline: SpeechEnhancementReplayMetric["baseline"]["bargeInRisk"],
): boolean {
  return bargeInRiskRank.get(enhanced)! <= bargeInRiskRank.get(baseline)!;
}

export function evaluateSpeechEnhancementReplayMetric(
  metric: SpeechEnhancementReplayMetric,
): SpeechEnhancementReplayEvaluation {
  const wordErrorImproved = metric.enhanced.wordErrorRateEstimate < metric.baseline.wordErrorRateEstimate;
  const endpointingOk = isEndpointingNoWorse(metric.enhanced.endpointingStability, metric.baseline.endpointingStability);
  const bargeInOk = isBargeInRiskNoWorse(metric.enhanced.bargeInRisk, metric.baseline.bargeInRisk);
  const latencyOk = metric.latencySettingMs === 12.5 && metric.enhanced.addedTurnLatencyMsP95 <= 25;
  const cpuOk = metric.cpuCostEstimate !== "high" && metric.enhanced.cpuPercentP95 <= 80;
  const failingEvidence = [
    wordErrorImproved ? null : "enhanced_noisy_replay_wer_improvement",
    endpointingOk ? null : "enhanced_endpointing_no_regression",
    bargeInOk ? null : "enhanced_barge_in_no_regression",
    latencyOk ? null : "measured_12_5_ms_added_turn_latency_under_25_ms_p95",
    cpuOk ? null : "measured_cpu_cost_on_selected_rtc_asr_host_under_80_percent_p95",
  ].filter((evidence): evidence is string => evidence !== null);

  return {
    issueCloseReady: failingEvidence.length === 0,
    failingEvidence,
    reasons: [
      wordErrorImproved ? "wer_improved" : "wer_not_improved",
      endpointingOk ? "endpointing_stable" : "endpointing_not_stable",
      bargeInOk ? "barge_in_risk_low" : "barge_in_risk_not_low",
      latencyOk ? "latency_within_budget" : "latency_over_budget",
      cpuOk ? "cpu_cost_allowed" : "cpu_cost_high",
    ],
  };
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
        addedTurnLatencyMsP95: 18,
        cpuPercentP95: 42,
      },
      latencySettingMs: 12.5,
      cpuCostEstimate: "medium",
    },
  ];

  const replayDecisions = replayMetrics.map((metric): SpeechEnhancementReplayDecision => {
    const evaluation = evaluateSpeechEnhancementReplayMetric(metric);

    return {
      captureId: metric.captureId,
      latencySettingMs: metric.latencySettingMs,
      enableForLiveDemo: evaluation.issueCloseReady,
      reasons: evaluation.reasons,
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
            "measured_cpu_cost_on_selected_rtc_asr_host_under_80_percent_p95",
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
        passCondition: "runtime CPU cost remains low or medium and enhanced CPU p95 stays at or below 80% during local demo load",
        rollbackSignal: "Disable enhancement on the host when runtime CPU cost is high.",
      },
    ],
    replayDecisions,
    replayCoverage,
    captureReplayContract: {
      requiredCaptureKind: "real_noisy_local_sip",
      fixtureManifestPath: "artifacts/speech-enhancement-real-capture-replay.json",
      requiredFields: [
        "capture_id",
        "recorded_at",
        "audio_source_uri",
        "noise_profile",
        "scenario",
        "runtime_host",
        "baseline_rtc_asr.transcript",
        "baseline_rtc_asr.word_error_rate_estimate",
        "baseline_rtc_asr.endpointing_stability",
        "baseline_rtc_asr.barge_in_risk",
        "enhanced_rtc_asr.transcript",
        "enhanced_rtc_asr.word_error_rate_estimate",
        "enhanced_rtc_asr.endpointing_stability",
        "enhanced_rtc_asr.barge_in_risk",
        "enhanced_rtc_asr.added_turn_latency_ms_p95",
        "enhanced_rtc_asr.cpu_percent_p95",
        "enhanced_rtc_asr.cpu_cost_estimate",
      ],
      comparisonPairs: ["baseline_rtc_asr", "enhanced_rtc_asr"],
      minimumPassingCriteria: [
        "enhanced word error estimate improves over baseline",
        "enhanced endpointing is stable or no worse than baseline",
        "enhanced barge-in risk is low or no worse than baseline",
        "12.5 ms profile stays under 25 ms added p95 turn latency",
        "runtime CPU cost is low or medium and enhanced CPU p95 stays at or below 80% on the selected rtc-asr host",
      ],
    },
    rolloutPlan: [
      {
        step: "capture_replay",
        owner: "agentic_contact_center",
        gate: "Attach one real noisy local SIP capture and compare baseline vs enhanced replay metrics before Issue #97 can close.",
      },
      {
        step: "feature_flag",
        owner: "rtc_asr",
        gate: "Implement RTC_ASR_SPEECH_ENHANCEMENT with 12.5 ms default latency and bypass-on-regression behavior.",
      },
      {
        step: "shadow_compare",
        owner: "rtc_asr",
        gate: "Run enhancement in shadow mode until WER, endpointing, barge-in, and CPU guardrails pass on the selected host.",
      },
      {
        step: "live_enablement",
        owner: "agentic_contact_center",
        gate: "Enable the feature only for demo calls whose proof bundle includes passing enhancement replay and runtime evidence.",
      },
    ],
    validationPlan: [
      "Replay one noisy local SIP capture through baseline rtc-asr and enhanced rtc-asr paths.",
      "Record added latency, transcript delta, endpointing behavior, barge-in behavior, and CPU cost.",
      "Keep npm run proof:realtime-shim green with enhancement disabled and enabled before live-demo use.",
    ],
  };
}
