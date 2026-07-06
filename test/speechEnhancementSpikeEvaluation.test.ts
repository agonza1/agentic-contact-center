import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSpeechEnhancementSpikeReport,
  buildSpeechEnhancementReviewGate,
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
      "endpointing_stable",
      "barge_in_risk_low",
      "latency_within_budget",
      "cpu_cost_allowed",
    ],
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

test("speech enhancement capture replay manifest requires artifact-relative audio evidence", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-005",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "../private/local-sip-real-noisy-005.wav",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-005.json",
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

test("speech enhancement capture replay manifest requires a real capture id", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "synthetic-noisy-local-sip-001",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-synthetic-001.wav",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-synthetic-001.json",
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

test("speech enhancement capture replay manifest rejects generic real capture ids", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-call-001",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-real-call-001.wav",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-real-call-001.json",
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

test("speech enhancement capture replay manifest names missing fields", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-002",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-real-noisy-002.wav",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-002.json",
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
    source_manifest_uri: "artifacts/local-sip/proof-manifest-004.json",
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
