import test from "node:test";
import assert from "node:assert/strict";

import { buildSpeechEnhancementSpikeReport, evaluateSpeechEnhancementReplayMetric } from "../src/core/speechEnhancementSpike";

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
