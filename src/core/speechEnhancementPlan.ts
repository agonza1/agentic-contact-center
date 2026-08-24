import type { SpeechEnhancementPlacement } from "./types";

const issue97 = "agonza1/agentic-contact-center#97";
const issue97Url = "https://github.com/agonza1/agentic-contact-center/issues/97";

export function buildSpeechEnhancementPlan() {
  return {
    issue: issue97,
    issueUrl: issue97Url,
    status: "spike_ready_feature_flag_disabled",
    provider: "laco_senet",
    featureFlag: "ACC_SPEECH_ENHANCEMENT_ENABLED",
    recommendedLatencyTargetMs: 25,
    latencySweepMs: [12.5, 25, 50, 75],
    recommendedPlacement: "rtc_asr_frontend" satisfies SpeechEnhancementPlacement,
    fallbackPlacement: "sidecar_preprocessor" satisfies SpeechEnhancementPlacement,
    defaultPlacement: "disabled" satisfies SpeechEnhancementPlacement,
    decision: "prototype_after_noisy_capture_replay",
    rationale: [
      "Keep speech enhancement upstream of rtc-asr so ACC receives the same Local STT v1 transcript contract and proof labels.",
      "Start at 25 ms because it is below the current 500 ms ASR partial budget while leaving headroom for denoising quality over the 12.5 ms floor.",
      "Retain sidecar_preprocessor as the rollback-friendly deployment shape if rtc-asr ownership or dependencies make an in-engine frontend expensive.",
    ],
    measurementPlan: [
      {
        id: "latency_budget",
        metric: "added_algorithmic_latency_ms",
        acceptance: "Measured added latency at 12.5, 25, 50, and 75 ms stays visible beside ASR partial latency marks.",
      },
      {
        id: "asr_quality",
        metric: "baseline_vs_enhanced_transcript_delta",
        acceptance: "Replay at least one noisy live-call capture through baseline and enhanced rtc-asr inputs.",
      },
      {
        id: "endpointing",
        metric: "interim_revisions_finalization_and_barge_in_events",
        acceptance: "Endpointing and interruption evidence does not regress against the unenhanced path.",
      },
      {
        id: "runtime_cost",
        metric: "cpu_percent_and_realtime_factor",
        acceptance: "Local/demo runtime cost is recorded before enabling the feature flag by default.",
      },
    ],
    configShape: {
      enabled: false,
      provider: "none",
      placement: "disabled",
      targetAlgorithmicLatencyMs: null,
      featureFlag: "ACC_SPEECH_ENHANCEMENT_ENABLED",
    },
  };
}
