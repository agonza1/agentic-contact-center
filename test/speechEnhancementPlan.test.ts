import test from "node:test";
import assert from "node:assert/strict";

import { buildSpeechEnhancementPlan } from "../src/core/speechEnhancementPlan";

test("speech enhancement spike plan keeps rtc-asr frontend disabled behind a flag", () => {
  const plan = buildSpeechEnhancementPlan();

  assert.equal(plan.issue, "agonza1/agentic-contact-center#97");
  assert.equal(plan.status, "spike_ready_feature_flag_disabled");
  assert.equal(plan.provider, "laco_senet");
  assert.equal(plan.featureFlag, "ACC_SPEECH_ENHANCEMENT_ENABLED");
  assert.equal(plan.recommendedLatencyTargetMs, 25);
  assert.deepEqual(plan.latencySweepMs, [12.5, 25, 50, 75]);
  assert.equal(plan.recommendedPlacement, "rtc_asr_frontend");
  assert.equal(plan.fallbackPlacement, "sidecar_preprocessor");
  assert.equal(plan.defaultPlacement, "disabled");
  assert.equal(plan.configShape.enabled, false);
  assert.equal(plan.configShape.provider, "none");
  assert.equal(plan.configShape.placement, "disabled");
  assert.equal(plan.configShape.targetAlgorithmicLatencyMs, null);
  assert.equal(plan.measurementPlan.length, 4);
  assert.deepEqual(
    plan.measurementPlan.map((item) => item.id),
    ["latency_budget", "asr_quality", "endpointing", "runtime_cost"],
  );
});
