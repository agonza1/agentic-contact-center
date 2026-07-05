import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSpeechEnhancementSpikeReport,
  evaluateSpeechEnhancementReplayMetric,
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
  assert.equal(validation.metric?.enhanced.addedTurnLatencyMsP95, 19);
  assert.equal(validation.evaluation?.issueCloseReady, true);
});

test("speech enhancement capture replay manifest names missing fields", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-002",
    recorded_at: "2026-07-05T15:45:00Z",
    audio_source_uri: "artifacts/local-sip-real-noisy-002.wav",
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

test("speech enhancement capture replay manifest rejects invalid metric ranges", () => {
  const validation = validateSpeechEnhancementCaptureReplayManifest({
    capture_id: "real-noisy-local-sip-003",
    recorded_at: "not-a-date",
    audio_source_uri: "artifacts/local-sip-real-noisy-003.wav",
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
    "baseline_rtc_asr.word_error_rate_estimate",
    "enhanced_rtc_asr.word_error_rate_estimate",
    "enhanced_rtc_asr.added_turn_latency_ms_p95",
    "enhanced_rtc_asr.cpu_percent_p95",
  ]);
  assert.equal(validation.metric, undefined);
  assert.equal(validation.evaluation, undefined);
});
