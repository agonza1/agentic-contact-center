import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSpeechEnhancementSpikeReport,
  buildSpeechEnhancementReviewGate,
  buildSpeechEnhancementReplayDiagnostics,
  buildSpeechEnhancementRuntimeReadiness,
  evaluateSpeechEnhancementReplayMetric,
  resolveSpeechEnhancementRuntimeConfig,
  validateSpeechEnhancementCaptureReplayManifest,
} from "../src/core/speechEnhancementSpike";

test("speech enhancement replay evaluation reports close-gate failures", () => {
  const report = buildSpeechEnhancementSpikeReport();
  const passingMetric = report.replayMetrics[0];

  assert.deepEqual(evaluateSpeechEnhancementReplayMetric(passingMetric), {
    issueCloseReady: true,
    failingEvidence: [],
    reasons: [
      "wer_improved",
      "endpointing_no_regression",
      "barge_in_risk_no_regression",
      "latency_within_budget",
      "cpu_cost_allowed",
    ],
  });

  assert.deepEqual(report.replayDecisions[0].diagnostics, {
    wordErrorRateDelta: 0.05,
    addedLatencyBudgetHeadroomMs: 7,
    cpuP95BudgetHeadroomPercent: 38,
  });

  const failingMetric = {
    ...passingMetric,
    enhanced: {
      ...passingMetric.enhanced,
      wordErrorRateEstimate: passingMetric.baseline.wordErrorRateEstimate,
      endpointingStability: "unstable" as const,
      bargeInRisk: "high" as const,
      addedTurnLatencyMsP95: 31,
      cpuPercentP95: 86,
    },
    latencySettingMs: 25,
    cpuCostEstimate: "high" as const,
  };

  assert.deepEqual(evaluateSpeechEnhancementReplayMetric(failingMetric), {
    issueCloseReady: false,
    failingEvidence: [
      "enhanced_noisy_replay_wer_improvement",
      "enhanced_endpointing_no_regression",
      "enhanced_barge_in_no_regression",
      "measured_12_5_ms_added_turn_latency_under_25_ms_p95",
      "measured_cpu_cost_on_selected_rtc_asr_host_under_80_percent_p95",
    ],
    reasons: [
      "wer_not_improved",
      "endpointing_not_stable",
      "barge_in_risk_not_low",
      "latency_over_budget",
      "cpu_cost_high",
    ],
  });
});

test("speech enhancement replay diagnostics preserve tiny over-budget deficits", () => {
  const report = buildSpeechEnhancementSpikeReport();
  const metric = {
    ...report.replayMetrics[0],
    enhanced: {
      ...report.replayMetrics[0].enhanced,
      addedTurnLatencyMsP95: 25.004,
      cpuPercentP95: 80.004,
    },
  };

  assert.deepEqual(buildSpeechEnhancementReplayDiagnostics(metric), {
    wordErrorRateDelta: 0.05,
    addedLatencyBudgetHeadroomMs: -0.01,
    cpuP95BudgetHeadroomPercent: -0.01,
  });
});



test("speech enhancement runtime readiness exposes selected frame budget", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-020",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-real-noisy-020.wav",
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-020.json",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with real local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.14,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.08,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 19,
      cpu_percent_p95: 44,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 12.5,
  });

  assert.ok(validation.metric);

  const report = buildSpeechEnhancementSpikeReport({ captureReplayMetrics: [validation.metric] });
  const runtimeConfig = resolveSpeechEnhancementRuntimeConfig({ featureFlag: "enabled", latencyMs: "12.5" });

  assert.deepEqual(buildSpeechEnhancementRuntimeReadiness(runtimeConfig, report), {
    status: "ready",
    enabled: true,
    latencyMs: 12.5,
    liveDemoEligible: true,
    selectedLatencyProfile: {
      latencyMs: 12.5,
      rtcAsrFrameMs: 20,
      lookaheadFrames: 1,
      maxBufferedAudioMs: 32.5,
      expectedUse: "default",
      recommendation: "recommended",
      liveDemoEligible: true,
      bypassWhen: [
        "added_turn_latency_p95_exceeds_candidate_budget",
        "enhanced_cpu_percent_p95_exceeds_80",
        "barge_in_or_endpointing_regresses",
      ],
    },
    frameBudget: {
      rtcAsrFrameMs: 20,
      lookaheadFrames: 1,
      maxBufferedAudioMs: 32.5,
    },
    bypassReasons: [],
  });
});

test("speech enhancement capture replay manifest validates real evidence shape", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-001",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-real-noisy-001.wav",
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-001.json",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with real local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.14,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.08,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 19,
      cpu_percent_p95: 44,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 12.5,
  });

  assert.equal(validation.manifestOk, true);
  assert.deepEqual(validation.missingFields, []);
  assert.equal(validation.metric?.captureId, "real-noisy-local-sip-001");
  assert.deepEqual(validation.metric?.captureEvidence, {
    recordedAt: "2026-07-05T15:45:00Z",
    audioSourceUri: "artifacts/local-sip-real-noisy-001.wav",
    audioSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceManifestUri: "artifacts/local-sip/proof-manifest-001.json",
    sourceManifestSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noiseProfile: "speakerphone fan noise",
    runtimeHost: "local-rtc-asr-host",
  });
  assert.equal(validation.metric?.enhanced.addedTurnLatencyMsP95, 19);
  assert.equal(validation.evaluation?.issueCloseReady, true);
});

test("speech enhancement spike report can attach a passing real capture replay", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-010",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-real-noisy-010.wav",
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-010.json",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with real local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.14,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.08,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 19,
      cpu_percent_p95: 44,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 12.5,
  });

  assert.equal(validation.manifestOk, true);
  assert.ok(validation.metric);

  const report = buildSpeechEnhancementSpikeReport({ captureReplayMetrics: [validation.metric] });
  const reviewGate = buildSpeechEnhancementReviewGate(report);

  assert.equal(report.acceptanceReadiness.noisyReplay, "real_capture_ready");
  assert.equal(report.acceptanceReadiness.cpuRuntimeCost, "covered");
  assert.deepEqual(report.acceptanceReadiness.remainingBeforeIssueClose, []);
  assert.equal(report.replayCoverage.realNoisyCaptureReplayCount, 1);
  assert.equal(report.replayCoverage.liveDemoGate, "eligible");
  assert.equal(reviewGate.issueCloseReady, true);
  assert.deepEqual(reviewGate.passingRealCaptureReplayIds, ["real-noisy-local-sip-010"]);
  assert.deepEqual(reviewGate.realCaptureReplayEvidence, [
    {
      captureId: "real-noisy-local-sip-010",
      status: "passing",
      enableForLiveDemo: true,
      failingEvidence: [],
      reasons: [
        "wer_improved",
        "endpointing_no_regression",
        "barge_in_risk_no_regression",
        "latency_within_budget",
        "cpu_cost_allowed",
      ],
      wordErrorRateDelta: 0.06,
      addedLatencyBudgetHeadroomMs: 6,
      cpuP95BudgetHeadroomPercent: 36,
      recordedAt: "2026-07-05T15:45:00Z",
      audioSourceUri: "artifacts/local-sip-real-noisy-010.wav",
      audioSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sourceManifestUri: "artifacts/local-sip/proof-manifest-010.json",
      sourceManifestSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      noiseProfile: "speakerphone fan noise",
      runtimeHost: "local-rtc-asr-host",
    },
  ]);
});

test("speech enhancement spike report does not treat extra synthetic replay as real close evidence", () => {
  const report = buildSpeechEnhancementSpikeReport();
  const syntheticMetric = {
    ...report.replayMetrics[0],
    captureId: "synthetic-noisy-cancellation-rescue-002",
  };

  const reportWithSyntheticReplay = buildSpeechEnhancementSpikeReport({ captureReplayMetrics: [syntheticMetric] });
  const reviewGate = buildSpeechEnhancementReviewGate(reportWithSyntheticReplay);

  assert.equal(reportWithSyntheticReplay.acceptanceReadiness.noisyReplay, "real_capture_required");
  assert.equal(reportWithSyntheticReplay.acceptanceReadiness.cpuRuntimeCost, "estimated_needs_live_measurement");
  assert.deepEqual(reportWithSyntheticReplay.acceptanceReadiness.remainingBeforeIssueClose, [
    "Replay a real noisy local SIP capture through baseline and enhancement paths before closing Issue #97.",
    "Replace CPU cost estimate with measured local runtime cost from the selected rtc-asr host.",
  ]);
  assert.equal(reportWithSyntheticReplay.replayCoverage.syntheticNoisyReplayCount, 2);
  assert.equal(reportWithSyntheticReplay.replayCoverage.realNoisyCaptureReplayCount, 0);
  assert.equal(reportWithSyntheticReplay.replayCoverage.baselineEnhancedPairs, 2);
  assert.equal(reportWithSyntheticReplay.replayCoverage.liveDemoGate, "blocked_until_real_capture");
  assert.deepEqual(reportWithSyntheticReplay.replayCoverage.missingEvidence, [
    "real_noisy_local_sip_capture_baseline_vs_enhanced_replay",
    "measured_cpu_cost_on_selected_rtc_asr_host_under_80_percent_p95",
  ]);
  assert.equal(reviewGate.issueCloseReady, false);
  assert.deepEqual(reviewGate.passingRealCaptureReplayIds, []);
});

test("speech enhancement spike report keeps failing real capture replay blockers", () => {
  const report = buildSpeechEnhancementSpikeReport();
  const failingMetric = {
    ...report.replayMetrics[0],
    captureId: "real-noisy-local-sip-011",
    captureEvidence: {
      recordedAt: "2026-07-05T15:45:00Z",
      audioSourceUri: "artifacts/local-sip-real-noisy-011.wav",
      sourceManifestUri: "artifacts/local-sip/proof-manifest-011.json",
      noiseProfile: "speakerphone fan noise",
      runtimeHost: "local-rtc-asr-host",
    },
    enhanced: {
      ...report.replayMetrics[0].enhanced,
      wordErrorRateEstimate: report.replayMetrics[0].baseline.wordErrorRateEstimate,
      addedTurnLatencyMsP95: 40,
      cpuPercentP95: 90,
    },
    cpuCostEstimate: "high" as const,
  };

  const reportWithReplay = buildSpeechEnhancementSpikeReport({ captureReplayMetrics: [failingMetric] });
  const reviewGate = buildSpeechEnhancementReviewGate(reportWithReplay);

  assert.equal(reportWithReplay.replayCoverage.liveDemoGate, "blocked_until_real_capture");
  assert.deepEqual(reportWithReplay.replayCoverage.missingEvidence, [
    "enhanced_noisy_replay_wer_improvement",
    "measured_12_5_ms_added_turn_latency_under_25_ms_p95",
    "measured_cpu_cost_on_selected_rtc_asr_host_under_80_percent_p95",
  ]);
  assert.match(
    reportWithReplay.acceptanceReadiness.remainingBeforeIssueClose[0],
    /^Replay real-noisy-local-sip-011 did not pass all enhancement close gates:/,
  );
  assert.equal(reviewGate.issueCloseReady, false);
  assert.deepEqual(reviewGate.blockedRealCaptureReplayIds, ["real-noisy-local-sip-011"]);
  assert.deepEqual(reportWithReplay.replayDecisions.at(-1)?.diagnostics, {
    wordErrorRateDelta: 0,
    addedLatencyBudgetHeadroomMs: -15,
    cpuP95BudgetHeadroomPercent: -10,
  });
});

test("speech enhancement spike report downgrades readiness when a later real replay fails", () => {
  const report = buildSpeechEnhancementSpikeReport();
  const passingMetric = {
    ...report.replayMetrics[0],
    captureId: "real-noisy-local-sip-012",
    captureEvidence: {
      recordedAt: "2026-07-05T15:45:00Z",
      audioSourceUri: "artifacts/local-sip-real-noisy-012.wav",
      sourceManifestUri: "artifacts/local-sip/proof-manifest-012.json",
      noiseProfile: "speakerphone fan noise",
      runtimeHost: "local-rtc-asr-host",
    },
  };
  const failingMetric = {
    ...passingMetric,
    captureId: "real-noisy-local-sip-013",
    enhanced: {
      ...passingMetric.enhanced,
      wordErrorRateEstimate: passingMetric.baseline.wordErrorRateEstimate,
      addedTurnLatencyMsP95: 40,
      cpuPercentP95: 90,
    },
    cpuCostEstimate: "high" as const,
  };

  const reportWithReplays = buildSpeechEnhancementSpikeReport({
    captureReplayMetrics: [passingMetric, failingMetric],
  });
  const reviewGate = buildSpeechEnhancementReviewGate(reportWithReplays);

  assert.equal(reportWithReplays.acceptanceReadiness.noisyReplay, "real_capture_required");
  assert.equal(reportWithReplays.acceptanceReadiness.cpuRuntimeCost, "estimated_needs_live_measurement");
  assert.equal(reportWithReplays.replayCoverage.liveDemoGate, "blocked_until_real_capture");
  assert.deepEqual(reviewGate.passingRealCaptureReplayIds, ["real-noisy-local-sip-012"]);
  assert.deepEqual(reviewGate.blockedRealCaptureReplayIds, ["real-noisy-local-sip-013"]);
  assert.equal(reviewGate.issueCloseReady, false);
});

test("speech enhancement capture replay manifest requires artifact-relative audio evidence", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-005",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "../private/local-sip-real-noisy-005.wav",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-005.json",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with real local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.14,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.08,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 19,
      cpu_percent_p95: 44,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 12.5,
  });

  assert.equal(validation.manifestOk, false);
  assert.deepEqual(validation.missingFields, ["audio_source_uri.artifacts_relative_path_required"]);
  assert.equal(validation.metric, undefined);
  assert.equal(validation.evaluation, undefined);
});

test("speech enhancement capture replay manifest requires distinct audio and source manifest artifacts", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-same-artifact",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip/shared-evidence.json",
    source_manifest_uri: "artifacts/local-sip/shared-evidence.json",
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with real local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.14,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.08,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 19,
      cpu_percent_p95: 44,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 12.5,
  });

  assert.equal(validation.manifestOk, false);
  assert.deepEqual(validation.missingFields, ["source_manifest_uri.distinct_from_audio_source_uri"]);
  assert.equal(validation.metric, undefined);
  assert.equal(validation.evaluation, undefined);
});

test("speech enhancement capture replay manifest rejects non-canonical artifact URI syntax", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-006",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-real-noisy-006.wav?download=1",
    source_manifest_uri: "artifacts/local-sip//proof-manifest-006.json",
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with real local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.14,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.08,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 19,
      cpu_percent_p95: 44,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 12.5,
  });

  assert.equal(validation.manifestOk, false);
  assert.deepEqual(validation.missingFields, [
    "audio_source_uri.artifacts_relative_path_required",
    "source_manifest_uri.artifacts_relative_path_required",
  ]);
  assert.equal(validation.metric, undefined);
  assert.equal(validation.evaluation, undefined);
});

test("speech enhancement capture replay manifest requires a real capture id", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "synthetic-noisy-local-sip-001",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-synthetic-001.wav",
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-synthetic-001.json",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with synthetic local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.14,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.08,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 19,
      cpu_percent_p95: 44,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 12.5,
  });

  assert.equal(validation.manifestOk, false);
  assert.deepEqual(validation.missingFields, ["capture_id.real_noisy_local_sip_required"]);
  assert.equal(validation.metric, undefined);
  assert.equal(validation.evaluation, undefined);
});

test("speech enhancement capture replay manifest requires a capture id suffix", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-real-noisy-empty.wav",
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-empty.json",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with real local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.14,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.08,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 19,
      cpu_percent_p95: 44,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 12.5,
  });

  assert.equal(validation.manifestOk, false);
  assert.deepEqual(validation.missingFields, ["capture_id.real_noisy_local_sip_required"]);
  assert.equal(validation.metric, undefined);
  assert.equal(validation.evaluation, undefined);
});

test("speech enhancement capture replay manifest rejects generic real capture ids", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-call-001",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-real-call-001.wav",
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-real-call-001.json",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with real local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.14,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.08,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 19,
      cpu_percent_p95: 44,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 12.5,
  });

  assert.equal(validation.manifestOk, false);
  assert.deepEqual(validation.missingFields, ["capture_id.real_noisy_local_sip_required"]);
  assert.equal(validation.metric, undefined);
  assert.equal(validation.evaluation, undefined);
});

test("speech enhancement capture replay manifest requires lowercase sha256 evidence", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-uppercase-hash",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-real-noisy-uppercase-hash.wav",
    audio_sha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-uppercase-hash.json",
    source_manifest_sha256: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with real local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.14,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.08,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 19,
      cpu_percent_p95: 44,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 12.5,
  });

  assert.equal(validation.manifestOk, false);
  assert.deepEqual(validation.missingFields, ["audio_sha256", "source_manifest_sha256"]);
  assert.equal(validation.metric, undefined);
  assert.equal(validation.evaluation, undefined);
});

test("speech enhancement capture replay manifest names missing fields", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-002",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-real-noisy-002.wav",
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-002.json",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with real local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.14,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.08,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 19,
      cpu_cost_estimate: "medium",
    },
  });

  assert.equal(validation.manifestOk, false);
  assert.deepEqual(validation.missingFields, [
    "latency_setting_ms",
    "enhanced_rtc_asr.cpu_percent_p95",
  ]);
  assert.equal(validation.metric, undefined);
  assert.equal(validation.evaluation, undefined);
});

test("speech enhancement review gate only counts canonical real noisy local SIP captures", () => {
  const report = buildSpeechEnhancementSpikeReport();
  const genericRealMetric = {
    ...report.replayMetrics[0],
    captureId: "real-call-should-not-count",
    captureEvidence: {
      recordedAt: "2026-07-05T15:45:00Z",
      audioSourceUri: "artifacts/generic-real-call.wav",
      noiseProfile: "speakerphone fan noise",
      runtimeHost: "local-rtc-asr-host",
    },
  };
  const reviewGate = buildSpeechEnhancementReviewGate({
    ...report,
    replayMetrics: [...report.replayMetrics, genericRealMetric],
    replayDecisions: [
      ...report.replayDecisions,
      {
        captureId: genericRealMetric.captureId,
        latencySettingMs: genericRealMetric.latencySettingMs,
        enableForLiveDemo: true,
        diagnostics: buildSpeechEnhancementReplayDiagnostics(genericRealMetric),
        reasons: ["wer_improved"],
      },
    ],
    replayCoverage: {
      ...report.replayCoverage,
      realNoisyCaptureReplayCount: 1,
      missingEvidence: [],
    },
    acceptanceReadiness: {
      ...report.acceptanceReadiness,
      remainingBeforeIssueClose: [],
    },
  });

  assert.equal(reviewGate.issueCloseReady, false);
  assert.equal(reviewGate.checks.realNoisyCaptureReplay, false);
  assert.deepEqual(reviewGate.realCaptureReplayIds, []);
  assert.deepEqual(reviewGate.passingRealCaptureReplayIds, []);
  assert.deepEqual(reviewGate.realCaptureReplayEvidence, []);
});

test("speech enhancement capture replay manifest rejects unsupported latency settings", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-004",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-real-noisy-004.wav",
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-004.json",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with real local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.14,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.08,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 19,
      cpu_percent_p95: 44,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 13,
  });

  assert.equal(validation.manifestOk, false);
  assert.deepEqual(validation.missingFields, ["latency_setting_ms"]);
  assert.equal(validation.metric, undefined);
  assert.equal(validation.evaluation, undefined);
});

test("speech enhancement capture replay manifest rejects invalid metric ranges", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-003",
    recorded_at: "not-a-date",
    audio_source_uri: "artifacts/local-sip-real-noisy-003.wav",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-003.json",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    audio_sha256: "not-a-sha",
    noise_profile: "speakerphone fan noise",
    scenario: "seeded caller with real local SIP noise",
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 1.2,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: -0.01,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: -1,
      cpu_percent_p95: 101,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 12.5,
  });

  assert.equal(validation.manifestOk, false);
  assert.deepEqual(validation.missingFields, [
    "recorded_at",
    "audio_sha256",
    "baseline_rtc_asr.word_error_rate_estimate",
    "enhanced_rtc_asr.word_error_rate_estimate",
    "enhanced_rtc_asr.added_turn_latency_ms_p95",
    "enhanced_rtc_asr.cpu_percent_p95",
  ]);
  assert.equal(validation.metric, undefined);
  assert.equal(validation.evaluation, undefined);
});

test("speech enhancement runtime config keeps feature flag disabled by default", () => {
  assert.deepEqual(resolveSpeechEnhancementRuntimeConfig(), {
    enabled: false,
    latencyMs: 12.5,
    bypassReason: "feature_flag_disabled",
    env: {
      featureFlag: "RTC_ASR_SPEECH_ENHANCEMENT",
      latencyMs: "RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS",
    },
  });
});

test("speech enhancement runtime config accepts supported feature-flagged latency", () => {
  assert.deepEqual(resolveSpeechEnhancementRuntimeConfig({ featureFlag: "enabled", latencyMs: "25" }), {
    enabled: true,
    latencyMs: 25,
    env: {
      featureFlag: "RTC_ASR_SPEECH_ENHANCEMENT",
      latencyMs: "RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS",
    },
  });
});

test("speech enhancement runtime config trims truthy feature flags", () => {
  for (const featureFlag of [" TRUE ", "on", "yes"]) {
    assert.deepEqual(resolveSpeechEnhancementRuntimeConfig({ featureFlag, latencyMs: "12.5" }), {
      enabled: true,
      latencyMs: 12.5,
      env: {
        featureFlag: "RTC_ASR_SPEECH_ENHANCEMENT",
        latencyMs: "RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS",
      },
    });
  }
});

test("speech enhancement runtime config bypasses invalid latency", () => {
  assert.deepEqual(resolveSpeechEnhancementRuntimeConfig({ featureFlag: "true", latencyMs: "fast" }), {
    enabled: false,
    latencyMs: 12.5,
    bypassReason: "invalid_latency_ms",
    env: {
      featureFlag: "RTC_ASR_SPEECH_ENHANCEMENT",
      latencyMs: "RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS",
    },
  });
});

test("speech enhancement runtime config bypasses unsupported latency", () => {
  assert.deepEqual(resolveSpeechEnhancementRuntimeConfig({ featureFlag: "true", latencyMs: "13" }), {
    enabled: false,
    latencyMs: 13,
    bypassReason: "unsupported_latency_ms",
    env: {
      featureFlag: "RTC_ASR_SPEECH_ENHANCEMENT",
      latencyMs: "RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS",
    },
  });
});
