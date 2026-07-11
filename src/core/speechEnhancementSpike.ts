export interface SpeechEnhancementLatencyCandidate {
  algorithmicLatencyMs: number;
  estimatedP95AddedTurnLatencyMs: number;
  withinConversationalBudget: boolean;
  expectedUse: "default" | "noisy_room" | "offline_review";
  recommendation: "recommended" | "acceptable" | "avoid_for_live_turns";
}

export interface SpeechEnhancementLatencyProfile {
  profileId: "latency_12_5_ms" | "latency_25_ms" | "latency_50_ms" | "latency_75_ms";
  latencyMs: number;
  rtcAsrFrameMs: 20;
  lookaheadFrames: number;
  maxBufferedAudioMs: number;
  expectedUse: SpeechEnhancementLatencyCandidate["expectedUse"];
  recommendation: SpeechEnhancementLatencyCandidate["recommendation"];
  liveDemoEligible: boolean;
  envValue: string;
  enableCommand: string;
  bypassWhen: string[];
}

export interface SpeechEnhancementReplayMetric {
  captureId: string;
  scenario: string;
  captureEvidence?: {
    recordedAt: string;
    audioSourceUri: string;
    audioSha256?: string;
    sourceManifestUri?: string;
    sourceManifestSha256?: string;
    noiseProfile: string;
    runtimeHost: string;
  };
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
  diagnostics: {
    wordErrorRateDelta: number;
    addedLatencyBudgetHeadroomMs: number;
    cpuP95BudgetHeadroomPercent: number;
  };
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

export interface SpeechEnhancementCloseGateProfile {
  requiredCaptureIdPrefix: "real-noisy-local-sip-";
  requiredLatencySettingMs: 12.5;
  maxAddedTurnLatencyMsP95: 25;
  maxCpuPercentP95: 80;
  allowedCpuCostEstimates: Array<"low" | "medium">;
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
  strictArtifactFields: string[];
  strictArtifactChecks: Array<
    | "exists"
    | "sha256_matches"
    | "artifact_uri_is_workspace_relative"
    | "source_manifest_json_object"
    | "source_manifest_identity_fields_present"
    | "source_manifest_capture_id_matches"
    | "source_manifest_audio_source_uri_matches"
    | "source_manifest_recorded_at_matches"
    | "source_manifest_noise_profile_matches"
    | "source_manifest_scenario_matches"
    | "source_manifest_runtime_host_matches"
  >;
  comparisonPairs: Array<"baseline_rtc_asr" | "enhanced_rtc_asr">;
  minimumPassingCriteria: string[];
}

export interface SpeechEnhancementCaptureReplayChecklistItem {
  step: "record_real_noisy_local_sip" | "run_baseline_rtc_asr" | "run_enhanced_rtc_asr" | "verify_artifacts" | "run_close_gate";
  owner: "agentic_contact_center" | "rtc_asr";
  evidence: string;
  command: string;
}

export interface SpeechEnhancementCaptureReplayManifest {
  capture_id: string;
  recorded_at: string;
  audio_source_uri: string;
  audio_sha256?: string;
  source_manifest_uri?: string;
  source_manifest_sha256?: string;
  noise_profile: string;
  scenario: string;
  runtime_host: string;
  baseline_rtc_asr: {
    transcript: string;
    word_error_rate_estimate: number;
    endpointing_stability: SpeechEnhancementReplayMetric["baseline"]["endpointingStability"];
    barge_in_risk: SpeechEnhancementReplayMetric["baseline"]["bargeInRisk"];
  };
  enhanced_rtc_asr: {
    transcript: string;
    word_error_rate_estimate: number;
    endpointing_stability: SpeechEnhancementReplayMetric["enhanced"]["endpointingStability"];
    barge_in_risk: SpeechEnhancementReplayMetric["enhanced"]["bargeInRisk"];
    added_turn_latency_ms_p95: number;
    cpu_percent_p95: number;
    cpu_cost_estimate: SpeechEnhancementReplayMetric["cpuCostEstimate"];
  };
  latency_setting_ms: number;
}

export interface SpeechEnhancementCaptureReplayTemplate extends SpeechEnhancementCaptureReplayManifest {
  audio_sha256: "replace_with_64_char_lowercase_sha256";
  source_manifest_sha256: "replace_with_64_char_lowercase_sha256";
}

export interface SpeechEnhancementSourceManifestTemplate {
  capture_id: SpeechEnhancementCaptureReplayTemplate["capture_id"];
  audio_source_uri: SpeechEnhancementCaptureReplayTemplate["audio_source_uri"];
  recorded_at: SpeechEnhancementCaptureReplayTemplate["recorded_at"];
  noise_profile: SpeechEnhancementCaptureReplayTemplate["noise_profile"];
  scenario: SpeechEnhancementCaptureReplayTemplate["scenario"];
  runtime_host: SpeechEnhancementCaptureReplayTemplate["runtime_host"];
  source: {
    kind: "local_sip_noisy_capture";
    sample_rate_hz: 16000;
    channel_count: 1;
    format: "pcm_s16le_wav";
  };
}

export interface SpeechEnhancementCaptureReplayValidation {
  manifestOk: boolean;
  missingFields: string[];
  metric?: SpeechEnhancementReplayMetric;
  evaluation?: SpeechEnhancementReplayEvaluation;
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
  latencyProfiles: SpeechEnhancementLatencyProfile[];
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
    cpuRuntimeCost: "estimated_needs_live_measurement" | "covered";
    featureFlagShape: "proposed";
    remainingBeforeIssueClose: string[];
  };
  runtimeGuardrails: SpeechEnhancementRuntimeGuardrail[];
  replayDecisions: SpeechEnhancementReplayDecision[];
  replayCoverage: SpeechEnhancementReplayCoverage;
  closeGateProfile: SpeechEnhancementCloseGateProfile;
  captureReplayContract: SpeechEnhancementCaptureReplayContract;
  rolloutPlan: SpeechEnhancementRolloutStep[];
  validationPlan: string[];
}

export interface SpeechEnhancementSpikeReportInput {
  captureReplayMetrics?: SpeechEnhancementReplayMetric[];
}

export interface SpeechEnhancementRuntimeConfigInput {
  featureFlag?: string;
  latencyMs?: string;
}

export interface SpeechEnhancementRuntimeConfig {
  enabled: boolean;
  latencyMs: number;
  bypassReason?: "feature_flag_disabled" | "invalid_latency_ms" | "unsupported_latency_ms";
  env: {
    featureFlag: "RTC_ASR_SPEECH_ENHANCEMENT";
    latencyMs: "RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS";
  };
}

export interface SpeechEnhancementRuntimeReadiness {
  status: "disabled" | "blocked" | "ready";
  enabled: boolean;
  latencyMs: number;
  liveDemoEligible: boolean;
  selectedLatencyProfile: SpeechEnhancementLatencyProfile | null;
  frameBudget: {
    rtcAsrFrameMs: 20;
    lookaheadFrames: number | null;
    maxBufferedAudioMs: number | null;
  };
  bypassReasons: string[];
}

export interface SpeechEnhancementReviewHandoff {
  issueUrl: "https://github.com/agonza1/agentic-contact-center/issues/97";
  reviewRoute: "/api/realtime-shim/speech-enhancement-spike";
  captureTemplateRoute: "/api/realtime-shim/speech-enhancement-spike/capture-template?includeContract=1";
  captureReplayChecklistRoute: "/api/realtime-shim/speech-enhancement-spike/capture-replay/checklist";
  captureReplayCloseGateRoute: "/api/realtime-shim/speech-enhancement-spike/capture-replay/close-gate";
  captureReplayValidationRoute: "/api/realtime-shim/speech-enhancement-spike/capture-replay/validate";
  captureTemplateCommand: "npm run proof:speech-enhancement -- --capture-replay-template-out artifacts/speech-enhancement-real-capture-replay.json";
  validationCommand: "npm run proof:speech-enhancement -- --require-close-ready";
  strictValidationCommand: "npm run proof:speech-enhancement -- --require-close-ready --strict-capture-artifacts --capture-replay artifacts/speech-enhancement-real-capture-replay.json";
  nextEvidenceOwner: "agentic_contact_center";
}

export function buildSpeechEnhancementCaptureReplayChecklist(): SpeechEnhancementCaptureReplayChecklistItem[] {
  return [
    {
      step: "record_real_noisy_local_sip",
      owner: "agentic_contact_center",
      evidence: "Real noisy local SIP audio plus source manifest with matching capture_id and audio_source_uri.",
      command: "npm run proof:speech-enhancement -- --capture-replay-template-out artifacts/speech-enhancement-real-capture-replay.json",
    },
    {
      step: "run_baseline_rtc_asr",
      owner: "rtc_asr",
      evidence: "baseline_rtc_asr transcript, WER estimate, endpointing stability, and barge-in risk for the same capture.",
      command: "Fill baseline_rtc_asr in artifacts/speech-enhancement-real-capture-replay.json",
    },
    {
      step: "run_enhanced_rtc_asr",
      owner: "rtc_asr",
      evidence: "enhanced_rtc_asr transcript, WER estimate, added p95 latency, CPU p95, and CPU cost for 12.5 ms latency.",
      command: "Fill enhanced_rtc_asr and latency_setting_ms in artifacts/speech-enhancement-real-capture-replay.json",
    },
    {
      step: "verify_artifacts",
      owner: "agentic_contact_center",
      evidence: "Workspace-relative audio and source manifest artifacts whose lowercase sha256 values match the replay manifest.",
      command: "npm run proof:speech-enhancement -- --strict-capture-artifacts --capture-replay artifacts/speech-enhancement-real-capture-replay.json",
    },
    {
      step: "run_close_gate",
      owner: "agentic_contact_center",
      evidence: "Issue #97 review gate is close-ready with no blocked real capture replay IDs.",
      command: "npm run proof:speech-enhancement -- --require-close-ready --strict-capture-artifacts --capture-replay artifacts/speech-enhancement-real-capture-replay.json",
    },
  ];
}

export interface SpeechEnhancementCaptureReplayNextStep extends SpeechEnhancementCaptureReplayChecklistItem {
  status: "blocked" | "ready_to_close";
  reason: string;
}

export function buildSpeechEnhancementCaptureReplayNextStep(
  reviewGate: SpeechEnhancementReviewGate,
): SpeechEnhancementCaptureReplayNextStep {
  const checklist = buildSpeechEnhancementCaptureReplayChecklist();

  if (reviewGate.issueCloseReady) {
    const closeStep = checklist.at(-1)!;
    return {
      ...closeStep,
      status: "ready_to_close",
      reason: "All Issue #97 close-gate checks passed; run the strict close command before closing the issue.",
    };
  }

  const nextStep = reviewGate.checks.realNoisyCaptureReplay
    ? reviewGate.checks.baselineEnhancedPairs
      ? checklist[2]!
      : checklist[1]!
    : checklist[0]!;

  return {
    ...nextStep,
    status: "blocked",
    reason: reviewGate.nextAction.reason,
  };
}

export interface SpeechEnhancementStrictArtifactVerificationSource {
  strictArtifactsVerified: boolean;
}

export interface SpeechEnhancementStrictArtifactVerification {
  requiredForClose: true;
  verified: boolean;
  sourceCount: number;
  verifiedSourceCount: number;
  unverifiedSourceCount: number;
  reason:
    | "all_loaded_capture_replay_artifacts_verified"
    | "run_with_strict_capture_artifacts_before_closing"
    | "attach_real_capture_replay_before_strict_artifact_verification";
}

export interface SpeechEnhancementReviewGate {
  issueCloseReady: boolean;
  checks: Record<
    | "realNoisyCaptureReplay"
    | "baselineEnhancedPairs"
    | "wordErrorImproved"
    | "endpointingNoRegression"
    | "bargeInNoRegression"
    | "addedLatencyP95"
    | "cpuRuntimeCost",
    boolean
  >;
  failureReasons: Record<string, string>;
  blockers: string[];
  nextEvidence: string[];
  nextAction: {
    owner: SpeechEnhancementReviewHandoff["nextEvidenceOwner"];
    action: "attach_real_capture_replay" | "ready_to_close";
    command: SpeechEnhancementReviewHandoff["strictValidationCommand"];
    reason: string;
  };
  realCaptureReplayIds: string[];
  passingRealCaptureReplayIds: string[];
  blockedRealCaptureReplayIds: string[];
  realCaptureReplayEvidence: Array<{
    captureId: string;
    status: "passing" | "blocked";
    enableForLiveDemo: boolean;
    failingEvidence: string[];
    reasons: string[];
    wordErrorRateDelta: number;
    addedLatencyBudgetHeadroomMs: number;
    cpuP95BudgetHeadroomPercent: number;
    recordedAt: string | null;
    audioSourceUri: string | null;
    audioSha256: string | null;
    sourceManifestUri: string | null;
    sourceManifestSha256: string | null;
    noiseProfile: string | null;
    runtimeHost: string | null;
  }>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringField(record: Record<string, unknown>, field: string): boolean {
  return typeof record[field] === "string" && record[field].trim().length > 0;
}

function hasNumberField(record: Record<string, unknown>, field: string): boolean {
  return typeof record[field] === "number" && Number.isFinite(record[field]);
}

function hasNumberInRangeField(record: Record<string, unknown>, field: string, min: number, max: number): boolean {
  return hasNumberField(record, field) && (record[field] as number) >= min && (record[field] as number) <= max;
}

function hasParseableIsoStringField(record: Record<string, unknown>, field: string): boolean {
  return hasStringField(record, field) && !Number.isNaN(Date.parse(record[field] as string));
}

function hasSha256Field(record: Record<string, unknown>, field: string): boolean {
  return typeof record[field] === "string" && /^[a-f0-9]{64}$/u.test(record[field]);
}

function hasArtifactUriField(record: Record<string, unknown>, field: string): boolean {
  if (!hasStringField(record, field)) {
    return false;
  }

  const value = record[field] as string;
  const pathParts = value.split("/");
  return (
    /^artifacts\/[A-Za-z0-9._/-]+$/u.test(value) &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !pathParts.includes("..")
  );
}

function hasEnumField<T extends string>(record: Record<string, unknown>, field: string, allowed: readonly T[]): boolean {
  return typeof record[field] === "string" && allowed.includes(record[field] as T);
}

function getNestedRecord(record: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = record[field];
  return isRecord(value) ? value : undefined;
}

const endpointingStabilityValues = ["unstable", "acceptable", "stable"] as const;
const bargeInRiskValues = ["low", "medium", "high"] as const;
const cpuCostEstimateValues = ["low", "medium", "high"] as const;
const allowedLatencySettingsMs = [12.5, 25, 50, 75] as const;
const realNoisyLocalSipCaptureIdPrefix = "real-noisy-local-sip-";
const realNoisyLocalSipCaptureIdPattern = /^real-noisy-local-sip-[a-z0-9][a-z0-9._-]*$/u;
const closeGateProfile: SpeechEnhancementCloseGateProfile = {
  requiredCaptureIdPrefix: realNoisyLocalSipCaptureIdPrefix,
  requiredLatencySettingMs: 12.5,
  maxAddedTurnLatencyMsP95: 25,
  maxCpuPercentP95: 80,
  allowedCpuCostEstimates: ["low", "medium"],
};

function isTruthyFeatureFlag(value: string | undefined): boolean {
  const normalizedValue = value?.trim().toLowerCase();
  return (
    normalizedValue === "1" ||
    normalizedValue === "true" ||
    normalizedValue === "enabled" ||
    normalizedValue === "on" ||
    normalizedValue === "yes"
  );
}

export function resolveSpeechEnhancementRuntimeConfig(
  input: SpeechEnhancementRuntimeConfigInput = {},
): SpeechEnhancementRuntimeConfig {
  const defaultLatencyMs = 12.5;
  const latencyInput = input.latencyMs?.trim();
  const hasExplicitLatency = latencyInput !== undefined && latencyInput !== "";
  const parsedLatencyMs = hasExplicitLatency ? Number(latencyInput) : defaultLatencyMs;
  const env = {
    featureFlag: "RTC_ASR_SPEECH_ENHANCEMENT" as const,
    latencyMs: "RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS" as const,
  };

  if (!isTruthyFeatureFlag(input.featureFlag)) {
    return { enabled: false, latencyMs: defaultLatencyMs, bypassReason: "feature_flag_disabled", env };
  }

  if (!Number.isFinite(parsedLatencyMs)) {
    return { enabled: false, latencyMs: defaultLatencyMs, bypassReason: "invalid_latency_ms", env };
  }

  const latencyMs = parsedLatencyMs;

  if (!(allowedLatencySettingsMs as readonly number[]).includes(latencyMs)) {
    return { enabled: false, latencyMs, bypassReason: "unsupported_latency_ms", env };
  }

  return { enabled: true, latencyMs, env };
}

export function buildSpeechEnhancementRuntimeReadiness(
  runtimeConfig: SpeechEnhancementRuntimeConfig,
  report: SpeechEnhancementSpikeReport = buildSpeechEnhancementSpikeReport(),
): SpeechEnhancementRuntimeReadiness {
  const selectedLatencyProfile =
    report.latencyProfiles.find((profile) => profile.latencyMs === runtimeConfig.latencyMs) ?? null;
  const bypassReasons = [
    runtimeConfig.bypassReason ?? null,
    selectedLatencyProfile && !selectedLatencyProfile.liveDemoEligible ? "latency_profile_not_live_demo_eligible" : null,
    report.replayCoverage.liveDemoGate === "eligible" ? null : report.replayCoverage.liveDemoGate,
  ].filter((reason): reason is string => reason !== null);
  const liveDemoEligible =
    runtimeConfig.enabled && selectedLatencyProfile?.liveDemoEligible === true && bypassReasons.length === 0;

  return {
    status: !runtimeConfig.enabled ? "disabled" : liveDemoEligible ? "ready" : "blocked",
    enabled: runtimeConfig.enabled,
    latencyMs: runtimeConfig.latencyMs,
    liveDemoEligible,
    selectedLatencyProfile,
    frameBudget: {
      rtcAsrFrameMs: 20,
      lookaheadFrames: selectedLatencyProfile?.lookaheadFrames ?? null,
      maxBufferedAudioMs: selectedLatencyProfile?.maxBufferedAudioMs ?? null,
    },
    bypassReasons,
  };
}

function hasAllowedLatencySetting(record: Record<string, unknown>, field: string): boolean {
  return hasNumberField(record, field) && (allowedLatencySettingsMs as readonly number[]).includes(record[field] as number);
}

export function validateSpeechEnhancementCaptureReplayManifest(
  manifest: unknown,
): SpeechEnhancementCaptureReplayValidation {
  const missingFields: string[] = [];

  if (!isRecord(manifest)) {
    return { manifestOk: false, missingFields: ["manifest"] };
  }

  for (const field of ["capture_id", "noise_profile", "scenario", "runtime_host"]) {
    if (!hasStringField(manifest, field)) {
      missingFields.push(field);
    }
  }
  if (!hasArtifactUriField(manifest, "audio_source_uri")) {
    missingFields.push("audio_source_uri.artifacts_relative_path_required");
  }
  if (!hasArtifactUriField(manifest, "source_manifest_uri")) {
    missingFields.push("source_manifest_uri.artifacts_relative_path_required");
  }
  if (
    hasArtifactUriField(manifest, "audio_source_uri") &&
    hasArtifactUriField(manifest, "source_manifest_uri") &&
    manifest.audio_source_uri === manifest.source_manifest_uri
  ) {
    missingFields.push("source_manifest_uri.distinct_from_audio_source_uri");
  }
  if (hasStringField(manifest, "capture_id") && !realNoisyLocalSipCaptureIdPattern.test(manifest.capture_id as string)) {
    missingFields.push("capture_id.real_noisy_local_sip_required");
  }
  if (!hasParseableIsoStringField(manifest, "recorded_at")) {
    missingFields.push("recorded_at");
  }
  if (!hasAllowedLatencySetting(manifest, "latency_setting_ms")) {
    missingFields.push("latency_setting_ms");
  }
  if (!hasSha256Field(manifest, "audio_sha256")) {
    missingFields.push("audio_sha256");
  }
  if (!hasSha256Field(manifest, "source_manifest_sha256")) {
    missingFields.push("source_manifest_sha256");
  }

  const baseline = getNestedRecord(manifest, "baseline_rtc_asr");
  const enhanced = getNestedRecord(manifest, "enhanced_rtc_asr");
  if (!baseline) {
    missingFields.push("baseline_rtc_asr");
  }
  if (!enhanced) {
    missingFields.push("enhanced_rtc_asr");
  }

  if (baseline) {
    if (!hasStringField(baseline, "transcript")) missingFields.push("baseline_rtc_asr.transcript");
    if (!hasNumberInRangeField(baseline, "word_error_rate_estimate", 0, 1)) {
      missingFields.push("baseline_rtc_asr.word_error_rate_estimate");
    }
    if (!hasEnumField(baseline, "endpointing_stability", endpointingStabilityValues)) {
      missingFields.push("baseline_rtc_asr.endpointing_stability");
    }
    if (!hasEnumField(baseline, "barge_in_risk", bargeInRiskValues)) {
      missingFields.push("baseline_rtc_asr.barge_in_risk");
    }
  }

  if (enhanced) {
    if (!hasStringField(enhanced, "transcript")) missingFields.push("enhanced_rtc_asr.transcript");
    if (!hasNumberInRangeField(enhanced, "word_error_rate_estimate", 0, 1)) {
      missingFields.push("enhanced_rtc_asr.word_error_rate_estimate");
    }
    if (!hasEnumField(enhanced, "endpointing_stability", endpointingStabilityValues)) {
      missingFields.push("enhanced_rtc_asr.endpointing_stability");
    }
    if (!hasEnumField(enhanced, "barge_in_risk", bargeInRiskValues)) {
      missingFields.push("enhanced_rtc_asr.barge_in_risk");
    }
    if (!hasNumberInRangeField(enhanced, "added_turn_latency_ms_p95", 0, Number.MAX_SAFE_INTEGER)) {
      missingFields.push("enhanced_rtc_asr.added_turn_latency_ms_p95");
    }
    if (!hasNumberInRangeField(enhanced, "cpu_percent_p95", 0, 100)) {
      missingFields.push("enhanced_rtc_asr.cpu_percent_p95");
    }
    if (!hasEnumField(enhanced, "cpu_cost_estimate", cpuCostEstimateValues)) {
      missingFields.push("enhanced_rtc_asr.cpu_cost_estimate");
    }
  }

  if (missingFields.length > 0 || !baseline || !enhanced) {
    return { manifestOk: false, missingFields };
  }

  const typedManifest = manifest as unknown as SpeechEnhancementCaptureReplayManifest;
  const metric: SpeechEnhancementReplayMetric = {
    captureId: typedManifest.capture_id,
    scenario: typedManifest.scenario,
    captureEvidence: {
      recordedAt: typedManifest.recorded_at,
      audioSourceUri: typedManifest.audio_source_uri,
      audioSha256: typedManifest.audio_sha256,
      sourceManifestUri: typedManifest.source_manifest_uri,
      sourceManifestSha256: typedManifest.source_manifest_sha256,
      noiseProfile: typedManifest.noise_profile,
      runtimeHost: typedManifest.runtime_host,
    },
    baseline: {
      transcript: typedManifest.baseline_rtc_asr.transcript,
      wordErrorRateEstimate: typedManifest.baseline_rtc_asr.word_error_rate_estimate,
      endpointingStability: typedManifest.baseline_rtc_asr.endpointing_stability,
      bargeInRisk: typedManifest.baseline_rtc_asr.barge_in_risk,
    },
    enhanced: {
      transcript: typedManifest.enhanced_rtc_asr.transcript,
      wordErrorRateEstimate: typedManifest.enhanced_rtc_asr.word_error_rate_estimate,
      endpointingStability: typedManifest.enhanced_rtc_asr.endpointing_stability,
      bargeInRisk: typedManifest.enhanced_rtc_asr.barge_in_risk,
      addedTurnLatencyMsP95: typedManifest.enhanced_rtc_asr.added_turn_latency_ms_p95,
      cpuPercentP95: typedManifest.enhanced_rtc_asr.cpu_percent_p95,
    },
    latencySettingMs: typedManifest.latency_setting_ms,
    cpuCostEstimate: typedManifest.enhanced_rtc_asr.cpu_cost_estimate,
  };

  return {
    manifestOk: true,
    missingFields: [],
    metric,
    evaluation: evaluateSpeechEnhancementReplayMetric(metric),
  };
}

export function evaluateSpeechEnhancementReplayMetric(
  metric: SpeechEnhancementReplayMetric,
): SpeechEnhancementReplayEvaluation {
  const wordErrorImproved = metric.enhanced.wordErrorRateEstimate < metric.baseline.wordErrorRateEstimate;
  const endpointingOk = isEndpointingNoWorse(metric.enhanced.endpointingStability, metric.baseline.endpointingStability);
  const bargeInOk = isBargeInRiskNoWorse(metric.enhanced.bargeInRisk, metric.baseline.bargeInRisk);
  const latencyOk =
    metric.latencySettingMs === closeGateProfile.requiredLatencySettingMs &&
    metric.enhanced.addedTurnLatencyMsP95 <= closeGateProfile.maxAddedTurnLatencyMsP95;
  const cpuOk =
    (closeGateProfile.allowedCpuCostEstimates as readonly string[]).includes(metric.cpuCostEstimate) &&
    metric.enhanced.cpuPercentP95 <= closeGateProfile.maxCpuPercentP95;
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
      endpointingOk ? "endpointing_no_regression" : "endpointing_not_stable",
      bargeInOk ? "barge_in_risk_no_regression" : "barge_in_risk_not_low",
      latencyOk ? "latency_within_budget" : "latency_over_budget",
      cpuOk ? "cpu_cost_allowed" : "cpu_cost_high",
    ],
  };
}

export function buildSpeechEnhancementReplayDiagnostics(metric: SpeechEnhancementReplayMetric): {
  wordErrorRateDelta: number;
  addedLatencyBudgetHeadroomMs: number;
  cpuP95BudgetHeadroomPercent: number;
} {
  return {
    wordErrorRateDelta: Number(
      (metric.baseline.wordErrorRateEstimate - metric.enhanced.wordErrorRateEstimate).toFixed(4),
    ),
    addedLatencyBudgetHeadroomMs: roundBudgetHeadroom(
      closeGateProfile.maxAddedTurnLatencyMsP95 - metric.enhanced.addedTurnLatencyMsP95,
    ),
    cpuP95BudgetHeadroomPercent: roundBudgetHeadroom(
      closeGateProfile.maxCpuPercentP95 - metric.enhanced.cpuPercentP95,
    ),
  };
}

function roundBudgetHeadroom(rawHeadroom: number): number {
  const rounded = Number(rawHeadroom.toFixed(2));
  if (rawHeadroom < 0 && Object.is(rounded, -0)) {
    return -0.01;
  }

  return rounded;
}

export function applySpeechEnhancementCaptureReplayMetric(
  report: SpeechEnhancementSpikeReport,
  metric: SpeechEnhancementReplayMetric,
): SpeechEnhancementSpikeReport {
  const { issueCloseReady, reasons } = evaluateSpeechEnhancementReplayMetric(metric);
  const replayMetrics = [...report.replayMetrics, metric];
  const realReplayMetrics = replayMetrics.filter((candidate) =>
    candidate.captureId.startsWith(realNoisyLocalSipCaptureIdPrefix),
  );
  const realReplayEvaluations = realReplayMetrics.map((candidate) => ({
    metric: candidate,
    evaluation: evaluateSpeechEnhancementReplayMetric(candidate),
  }));
  const remainingBeforeIssueClose =
    realReplayEvaluations.length === 0
      ? report.acceptanceReadiness.remainingBeforeIssueClose
      : realReplayEvaluations.flatMap(({ metric: replayMetric, evaluation }) =>
          evaluation.issueCloseReady
            ? []
            : [
                `Replay ${replayMetric.captureId} did not pass all enhancement close gates: ${evaluation.failingEvidence.join(
                  ", ",
                )}.`,
              ],
        );
  const missingEvidence =
    realReplayMetrics.length === 0
      ? report.replayCoverage.missingEvidence
      : Array.from(new Set(realReplayEvaluations.flatMap(({ evaluation }) => evaluation.failingEvidence)));
  const allRealReplaysPass = realReplayMetrics.length > 0 && remainingBeforeIssueClose.length === 0;

  return {
    ...report,
    replayMetrics,
    replayDecisions: [
      ...report.replayDecisions,
      {
        captureId: metric.captureId,
        latencySettingMs: metric.latencySettingMs,
        enableForLiveDemo: issueCloseReady,
        diagnostics: buildSpeechEnhancementReplayDiagnostics(metric),
        reasons,
      },
    ],
    replayCoverage: {
      syntheticNoisyReplayCount: replayMetrics.filter((candidate) => candidate.captureId.startsWith("synthetic-")).length,
      realNoisyCaptureReplayCount: realReplayMetrics.length,
      baselineEnhancedPairs: replayMetrics.length,
      liveDemoGate: allRealReplaysPass ? "eligible" : "blocked_until_real_capture",
      missingEvidence,
    },
    acceptanceReadiness: {
      ...report.acceptanceReadiness,
      noisyReplay: allRealReplaysPass ? "real_capture_ready" : "real_capture_required",
      cpuRuntimeCost: allRealReplaysPass ? "covered" : "estimated_needs_live_measurement",
      remainingBeforeIssueClose,
    },
  };
}

export function buildSpeechEnhancementSpikeReport(
  input: SpeechEnhancementSpikeReportInput = {},
): SpeechEnhancementSpikeReport {
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

  const latencyProfiles: SpeechEnhancementLatencyProfile[] = candidates.map((candidate) => {
    const envValue = String(candidate.algorithmicLatencyMs);
    const profileId = `latency_${envValue.replace(".", "_")}_ms` as SpeechEnhancementLatencyProfile["profileId"];

    return {
      profileId,
      latencyMs: candidate.algorithmicLatencyMs,
      rtcAsrFrameMs: 20,
      lookaheadFrames: Math.ceil(candidate.algorithmicLatencyMs / 20),
      maxBufferedAudioMs: candidate.algorithmicLatencyMs + 20,
      expectedUse: candidate.expectedUse,
      recommendation: candidate.recommendation,
      liveDemoEligible: candidate.recommendation !== "avoid_for_live_turns",
      envValue,
      enableCommand: `RTC_ASR_SPEECH_ENHANCEMENT=enabled RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS=${envValue} npm run proof:realtime-shim`,
      bypassWhen: [
        "added_turn_latency_p95_exceeds_candidate_budget",
        "enhanced_cpu_percent_p95_exceeds_80",
        "barge_in_or_endpointing_regresses",
      ],
    };
  });

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
      diagnostics: buildSpeechEnhancementReplayDiagnostics(metric),
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

  const report: SpeechEnhancementSpikeReport = {
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
    latencyProfiles,
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
    closeGateProfile,
    captureReplayContract: {
      requiredCaptureKind: "real_noisy_local_sip",
      fixtureManifestPath: "artifacts/speech-enhancement-real-capture-replay.json",
      requiredFields: [
        "capture_id",
        "recorded_at",
        "audio_source_uri",
        "audio_sha256",
        "source_manifest_uri",
        "source_manifest_sha256",
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
        "latency_setting_ms",
      ],
      strictArtifactFields: [
        "audio_source_uri",
        "audio_sha256",
        "source_manifest_uri",
        "source_manifest_sha256",
      ],
      strictArtifactChecks: [
        "exists",
        "sha256_matches",
        "artifact_uri_is_workspace_relative",
        "source_manifest_json_object",
        "source_manifest_identity_fields_present",
        "source_manifest_capture_id_matches",
        "source_manifest_audio_source_uri_matches",
        "source_manifest_recorded_at_matches",
        "source_manifest_noise_profile_matches",
        "source_manifest_scenario_matches",
        "source_manifest_runtime_host_matches",
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

  return (input.captureReplayMetrics ?? []).reduce(applySpeechEnhancementCaptureReplayMetric, report);
}


export function buildSpeechEnhancementCaptureReplayTemplate(): SpeechEnhancementCaptureReplayTemplate {
  return {
    capture_id: "real-noisy-local-sip-001",
    recorded_at: "2026-07-08T00:00:00.000Z",
    audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-001.wav",
    audio_sha256: "replace_with_64_char_lowercase_sha256",
    source_manifest_uri: "artifacts/local-sip/proof-manifest-001.json",
    source_manifest_sha256: "replace_with_64_char_lowercase_sha256",
    noise_profile: "describe_real_call_noise",
    scenario: "local SIP caller replayed through baseline and enhanced rtc-asr paths",
    runtime_host: "selected-rtc-asr-hostname",
    baseline_rtc_asr: {
      transcript: "baseline transcript from the same real noisy capture",
      word_error_rate_estimate: 0.18,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "enhanced transcript from the same real noisy capture",
      word_error_rate_estimate: 0.06,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 18,
      cpu_percent_p95: 42,
      cpu_cost_estimate: "medium",
    },
    latency_setting_ms: 12.5,
  };
}

export function buildSpeechEnhancementSourceManifestTemplate(): SpeechEnhancementSourceManifestTemplate {
  const template = buildSpeechEnhancementCaptureReplayTemplate();

  return {
    capture_id: template.capture_id,
    audio_source_uri: template.audio_source_uri,
    recorded_at: template.recorded_at,
    noise_profile: template.noise_profile,
    scenario: template.scenario,
    runtime_host: template.runtime_host,
    source: {
      kind: "local_sip_noisy_capture",
      sample_rate_hz: 16000,
      channel_count: 1,
      format: "pcm_s16le_wav",
    },
  };
}

export function buildSpeechEnhancementHealthSummary(): {
  issue: string;
  issueUrl: SpeechEnhancementReviewHandoff["issueUrl"];
  reviewRoute: SpeechEnhancementReviewHandoff["reviewRoute"];
  captureTemplateRoute: SpeechEnhancementReviewHandoff["captureTemplateRoute"];
  captureReplayChecklistRoute: SpeechEnhancementReviewHandoff["captureReplayChecklistRoute"];
  captureReplayCloseGateRoute: SpeechEnhancementReviewHandoff["captureReplayCloseGateRoute"];
  captureReplayValidationRoute: SpeechEnhancementReviewHandoff["captureReplayValidationRoute"];
  recommendedLatencyMs: number;
  runtimeEnv: SpeechEnhancementRuntimeConfig["env"];
  runtimeStatus: SpeechEnhancementRuntimeReadiness["status"];
  runtimeEnabled: boolean;
  runtimeLatencyMs: number;
  runtimeBypassReason?: SpeechEnhancementRuntimeConfig["bypassReason"];
  runtimeBypassReasons: string[];
  runtimeLookaheadFrames: number | null;
  runtimeMaxBufferedAudioMs: number | null;
  runtimeProfileExpectedUse: SpeechEnhancementLatencyProfile["expectedUse"] | null;
  runtimeProfileRecommendation: SpeechEnhancementLatencyProfile["recommendation"] | null;
  runtimeProfileId: SpeechEnhancementLatencyProfile["profileId"] | null;
  runtimeProfileEnvValue: string | null;
  runtimeProfileEnableCommand: string | null;
  runtimeProfileBypassWhen: string[];
  runtimeLiveDemoEligible: boolean;
  closeGateRequiredLatencyMs: number;
  closeGateMaxAddedTurnLatencyMsP95: number;
  closeGateMaxCpuPercentP95: number;
  captureReplayCoverage: SpeechEnhancementReplayCoverage;
  liveDemoGate: string;
  issueCloseReady: boolean;
  reviewChecks: SpeechEnhancementReviewGate["checks"];
  failureReasons: SpeechEnhancementReviewGate["failureReasons"];
  missingEvidence: string[];
  blockers: string[];
  nextEvidence: string[];
  nextAction: SpeechEnhancementReviewGate["nextAction"];
  nextChecklistStep: SpeechEnhancementCaptureReplayNextStep;
  passingRealCaptureReplayIds: string[];
  blockedRealCaptureReplayIds: string[];
  strictArtifactVerification: SpeechEnhancementStrictArtifactVerification;
  captureReplayFixturePath: SpeechEnhancementCaptureReplayContract["fixtureManifestPath"];
  captureTemplateCommand: SpeechEnhancementReviewHandoff["captureTemplateCommand"];
  validationCommand: "npm run proof:speech-enhancement -- --require-close-ready";
  strictValidationCommand: SpeechEnhancementReviewHandoff["strictValidationCommand"];
} {
  const report = buildSpeechEnhancementSpikeReport();
  const reviewGate = buildSpeechEnhancementReviewGate(report);
  const handoff = buildSpeechEnhancementReviewHandoff();
  const strictArtifactVerification = buildSpeechEnhancementStrictArtifactVerification();
  const runtimeConfig = resolveSpeechEnhancementRuntimeConfig({
    featureFlag: process.env.RTC_ASR_SPEECH_ENHANCEMENT,
    latencyMs: process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS,
  });
  const runtimeReadiness = buildSpeechEnhancementRuntimeReadiness(runtimeConfig, report);

  return {
    issue: report.issue,
    issueUrl: handoff.issueUrl,
    reviewRoute: handoff.reviewRoute,
    captureTemplateRoute: handoff.captureTemplateRoute,
    captureReplayChecklistRoute: handoff.captureReplayChecklistRoute,
    captureReplayCloseGateRoute: handoff.captureReplayCloseGateRoute,
    captureReplayValidationRoute: handoff.captureReplayValidationRoute,
    recommendedLatencyMs: report.decision.recommendedLatencyMs,
    runtimeEnv: runtimeConfig.env,
    runtimeStatus: runtimeReadiness.status,
    runtimeEnabled: runtimeConfig.enabled,
    runtimeLatencyMs: runtimeConfig.latencyMs,
    runtimeBypassReason: runtimeConfig.bypassReason,
    runtimeBypassReasons: runtimeReadiness.bypassReasons,
    runtimeLookaheadFrames: runtimeReadiness.frameBudget.lookaheadFrames,
    runtimeMaxBufferedAudioMs: runtimeReadiness.frameBudget.maxBufferedAudioMs,
    runtimeProfileExpectedUse: runtimeReadiness.selectedLatencyProfile?.expectedUse ?? null,
    runtimeProfileRecommendation: runtimeReadiness.selectedLatencyProfile?.recommendation ?? null,
    runtimeProfileId: runtimeReadiness.selectedLatencyProfile?.profileId ?? null,
    runtimeProfileEnvValue: runtimeReadiness.selectedLatencyProfile?.envValue ?? null,
    runtimeProfileEnableCommand: runtimeReadiness.selectedLatencyProfile?.enableCommand ?? null,
    runtimeProfileBypassWhen: runtimeReadiness.selectedLatencyProfile?.bypassWhen ?? [],
    runtimeLiveDemoEligible: runtimeReadiness.liveDemoEligible,
    closeGateRequiredLatencyMs: report.closeGateProfile.requiredLatencySettingMs,
    closeGateMaxAddedTurnLatencyMsP95: report.closeGateProfile.maxAddedTurnLatencyMsP95,
    closeGateMaxCpuPercentP95: report.closeGateProfile.maxCpuPercentP95,
    captureReplayCoverage: report.replayCoverage,
    liveDemoGate: report.replayCoverage.liveDemoGate,
    issueCloseReady: reviewGate.issueCloseReady,
    reviewChecks: reviewGate.checks,
    failureReasons: reviewGate.failureReasons,
    missingEvidence: reviewGate.nextEvidence,
    blockers: reviewGate.blockers,
    nextEvidence: reviewGate.nextEvidence,
    nextAction: reviewGate.nextAction,
    nextChecklistStep: buildSpeechEnhancementCaptureReplayNextStep(reviewGate),
    passingRealCaptureReplayIds: reviewGate.passingRealCaptureReplayIds,
    blockedRealCaptureReplayIds: reviewGate.blockedRealCaptureReplayIds,
    strictArtifactVerification,
    captureReplayFixturePath: report.captureReplayContract.fixtureManifestPath,
    captureTemplateCommand: handoff.captureTemplateCommand,
    validationCommand: handoff.validationCommand,
    strictValidationCommand: handoff.strictValidationCommand,
  };
}

export function buildSpeechEnhancementReviewHandoff(): SpeechEnhancementReviewHandoff {
  return {
    issueUrl: "https://github.com/agonza1/agentic-contact-center/issues/97",
    reviewRoute: "/api/realtime-shim/speech-enhancement-spike",
    captureTemplateRoute: "/api/realtime-shim/speech-enhancement-spike/capture-template?includeContract=1",
    captureReplayChecklistRoute: "/api/realtime-shim/speech-enhancement-spike/capture-replay/checklist",
    captureReplayCloseGateRoute: "/api/realtime-shim/speech-enhancement-spike/capture-replay/close-gate",
    captureReplayValidationRoute: "/api/realtime-shim/speech-enhancement-spike/capture-replay/validate",
    captureTemplateCommand:
      "npm run proof:speech-enhancement -- --capture-replay-template-out artifacts/speech-enhancement-real-capture-replay.json",
    validationCommand: "npm run proof:speech-enhancement -- --require-close-ready",
    strictValidationCommand:
      "npm run proof:speech-enhancement -- --require-close-ready --strict-capture-artifacts --capture-replay artifacts/speech-enhancement-real-capture-replay.json",
    nextEvidenceOwner: "agentic_contact_center",
  };
}

export function buildSpeechEnhancementStrictArtifactVerification(
  sources: SpeechEnhancementStrictArtifactVerificationSource[] = [],
  strictCaptureArtifacts = false,
): SpeechEnhancementStrictArtifactVerification {
  const hasCaptureReplay = sources.length > 0;
  const verifiedSourceCount = sources.filter((source) => source.strictArtifactsVerified).length;
  const unverifiedSourceCount = sources.length - verifiedSourceCount;
  const verified = hasCaptureReplay && strictCaptureArtifacts && unverifiedSourceCount === 0;

  return {
    requiredForClose: true,
    verified,
    sourceCount: sources.length,
    verifiedSourceCount,
    unverifiedSourceCount,
    reason: verified
      ? "all_loaded_capture_replay_artifacts_verified"
      : hasCaptureReplay
        ? "run_with_strict_capture_artifacts_before_closing"
        : "attach_real_capture_replay_before_strict_artifact_verification",
  };
}

export function buildSpeechEnhancementReviewGate(
  report: SpeechEnhancementSpikeReport,
): SpeechEnhancementReviewGate {
  const missingEvidence = new Set(report.replayCoverage.missingEvidence);
  const realCaptureReplayMetrics = report.replayMetrics.filter((metric) =>
    metric.captureId.startsWith(realNoisyLocalSipCaptureIdPrefix),
  );
  const hasRealCaptureReplay = realCaptureReplayMetrics.length > 0;
  const realCaptureReplayDecisions = report.replayDecisions.filter((decision) =>
    decision.captureId.startsWith(realNoisyLocalSipCaptureIdPrefix),
  );
  const passingRealCaptureReplayIds = realCaptureReplayDecisions
    .filter((decision) => decision.enableForLiveDemo)
    .map((decision) => decision.captureId);
  const blockedRealCaptureReplayIds = realCaptureReplayDecisions
    .filter((decision) => !decision.enableForLiveDemo)
    .map((decision) => decision.captureId);
  const blockedReplayMessages = blockedRealCaptureReplayIds.map(
    (captureId) => `Replay ${captureId} is attached but does not pass all Issue #97 close gates.`,
  );
  const issueCloseReady =
    hasRealCaptureReplay &&
    passingRealCaptureReplayIds.length > 0 &&
    blockedRealCaptureReplayIds.length === 0 &&
    report.acceptanceReadiness.remainingBeforeIssueClose.length === 0;
  const checks = {
    realNoisyCaptureReplay: hasRealCaptureReplay,
    baselineEnhancedPairs: hasRealCaptureReplay && report.replayCoverage.baselineEnhancedPairs > 0,
    wordErrorImproved: hasRealCaptureReplay && !missingEvidence.has("enhanced_noisy_replay_wer_improvement"),
    endpointingNoRegression: hasRealCaptureReplay && !missingEvidence.has("enhanced_endpointing_no_regression"),
    bargeInNoRegression: hasRealCaptureReplay && !missingEvidence.has("enhanced_barge_in_no_regression"),
    addedLatencyP95: hasRealCaptureReplay && !missingEvidence.has("measured_12_5_ms_added_turn_latency_under_25_ms_p95"),
    cpuRuntimeCost:
      hasRealCaptureReplay && !missingEvidence.has("measured_cpu_cost_on_selected_rtc_asr_host_under_80_percent_p95"),
  };
  const failureReasons = Object.fromEntries(
    Object.entries({
      realNoisyCaptureReplay: "Attach one real noisy local SIP capture replay before closing Issue #97.",
      baselineEnhancedPairs: "Attach paired baseline and enhanced rtc-asr replay metrics for the real capture.",
      wordErrorImproved: "Enhanced noisy replay WER estimate must improve over baseline.",
      endpointingNoRegression: "Enhanced endpointing must remain stable or no worse than baseline.",
      bargeInNoRegression: "Enhanced barge-in risk must remain low or no worse than baseline.",
      addedLatencyP95: "Measured 12.5 ms profile added turn latency must stay at or below 25 ms p95.",
      cpuRuntimeCost: "Measured enhanced CPU p95 must stay at or below 80% on the selected rtc-asr host.",
    }).filter(([check]) => !checks[check as keyof typeof checks]),
  );
  const handoff = buildSpeechEnhancementReviewHandoff();

  return {
    issueCloseReady,
    checks,
    failureReasons,
    blockers: [...report.acceptanceReadiness.remainingBeforeIssueClose, ...blockedReplayMessages],
    nextEvidence: report.replayCoverage.missingEvidence,
    nextAction: {
      owner: handoff.nextEvidenceOwner,
      action: issueCloseReady ? "ready_to_close" : "attach_real_capture_replay",
      command: handoff.strictValidationCommand,
      reason: issueCloseReady
        ? "Issue #97 close gates have a passing real noisy local SIP replay."
        : failureReasons.realNoisyCaptureReplay ??
          blockedReplayMessages[0] ??
          "Attach a passing real noisy local SIP capture replay before closing Issue #97.",
    },
    realCaptureReplayIds: realCaptureReplayDecisions.map((decision) => decision.captureId),
    passingRealCaptureReplayIds,
    blockedRealCaptureReplayIds,
    realCaptureReplayEvidence: realCaptureReplayMetrics.map((metric) => {
      const decision = realCaptureReplayDecisions.find((candidate) => candidate.captureId === metric.captureId);
      const diagnostics = decision?.diagnostics ?? buildSpeechEnhancementReplayDiagnostics(metric);
      const evaluation = evaluateSpeechEnhancementReplayMetric(metric);

      return {
        captureId: metric.captureId,
        status: decision?.enableForLiveDemo ? "passing" : "blocked",
        enableForLiveDemo: decision?.enableForLiveDemo ?? false,
        failingEvidence: evaluation.failingEvidence,
        reasons: decision?.reasons ?? evaluation.reasons,
        wordErrorRateDelta: diagnostics.wordErrorRateDelta,
        addedLatencyBudgetHeadroomMs: diagnostics.addedLatencyBudgetHeadroomMs,
        cpuP95BudgetHeadroomPercent: diagnostics.cpuP95BudgetHeadroomPercent,
        recordedAt: metric.captureEvidence?.recordedAt ?? null,
        audioSourceUri: metric.captureEvidence?.audioSourceUri ?? null,
        audioSha256: metric.captureEvidence?.audioSha256 ?? null,
        sourceManifestUri: metric.captureEvidence?.sourceManifestUri ?? null,
        sourceManifestSha256: metric.captureEvidence?.sourceManifestSha256 ?? null,
        noiseProfile: metric.captureEvidence?.noiseProfile ?? null,
        runtimeHost: metric.captureEvidence?.runtimeHost ?? null,
      };
    }),
  };
}
