import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

test("GET /api/realtime-shim/speech-enhancement-spike returns issue 97 recommendation", async () => {
  const previousFeatureFlag = process.env.RTC_ASR_SPEECH_ENHANCEMENT;
  const previousLatencyMs = process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS;
  delete process.env.RTC_ASR_SPEECH_ENHANCEMENT;
  delete process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS;

  const server = buildHttpServer(loadPocConfig());

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/realtime-shim/speech-enhancement-spike",
          method: "GET",
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
        },
      );

      req.on("error", reject);
      req.end();
    });

    const payload = JSON.parse(responseBody) as {
      ok: boolean;
      route: string;
      issue: string;
      reference: { modelFamily: string; paperUrl: string; latencyRangeMs: number[] };
      pipelinePlacement: { recommendedOwner: string; stage: string; preservedContracts: string[] };
      candidates: Array<{ algorithmicLatencyMs: number; withinConversationalBudget: boolean; recommendation: string }>;
      latencyProfiles: Array<{
        latencyMs: number;
        rtcAsrFrameMs: number;
        lookaheadFrames: number;
        maxBufferedAudioMs: number;
        expectedUse: string;
        recommendation: string;
        liveDemoEligible: boolean;
        bypassWhen: string[];
      }>;
      replayMetrics: Array<{
        baseline: { wordErrorRateEstimate: number };
        enhanced: { wordErrorRateEstimate: number; addedTurnLatencyMsP95: number; cpuPercentP95: number };
        latencySettingMs: number;
      }>;
      decision: { status: string; recommendedLatencyMs: number };
      proposedConfig: { featureFlag: string; allowedLatencyMs: number[]; defaultLatencyMs: number };
      runtimeConfig: {
        enabled: boolean;
        latencyMs: number;
        bypassReason?: string;
        env: { featureFlag: string; latencyMs: string };
      };
      runtimeReadiness: {
        status: string;
        enabled: boolean;
        latencyMs: number;
        liveDemoEligible: boolean;
        selectedLatencyProfile: { latencyMs: number; lookaheadFrames: number; maxBufferedAudioMs: number } | null;
        frameBudget: { rtcAsrFrameMs: number; lookaheadFrames: number | null; maxBufferedAudioMs: number | null };
        bypassReasons: string[];
      };
      acceptanceReadiness: {
        reportRecommendation: string;
        noisyReplay: string;
        latencyMetrics: string;
        transcriptEndpointingMetrics: string;
        cpuRuntimeCost: string;
        featureFlagShape: string;
        remainingBeforeIssueClose: string[];
      };
      runtimeGuardrails: Array<{ metric: string; passCondition: string; rollbackSignal: string }>;
      replayDecisions: Array<{
        captureId: string;
        latencySettingMs: number;
        enableForLiveDemo: boolean;
        reasons: string[];
      }>;
      replayCoverage: {
        syntheticNoisyReplayCount: number;
        realNoisyCaptureReplayCount: number;
        baselineEnhancedPairs: number;
        liveDemoGate: string;
        missingEvidence: string[];
      };
      closeGateProfile: {
        requiredCaptureIdPrefix: string;
        requiredLatencySettingMs: number;
        maxAddedTurnLatencyMsP95: number;
        maxCpuPercentP95: number;
        allowedCpuCostEstimates: string[];
      };
      captureReplayContract: {
        requiredCaptureKind: string;
        fixtureManifestPath: string;
        requiredFields: string[];
        strictArtifactFields: string[];
        strictArtifactChecks: string[];
        comparisonPairs: string[];
        minimumPassingCriteria: string[];
      };
      rolloutPlan: Array<{ step: string; owner: string; gate: string }>;
      validationPlan: string[];
      reviewGate: {
        issueCloseReady: boolean;
        checks: Record<string, boolean>;
        failureReasons: Record<string, string>;
        blockers: string[];
        nextEvidence: string[];
        nextAction: { owner: string; action: string; command: string; reason: string };
        realCaptureReplayIds: string[];
        realCaptureReplayEvidence: Array<{ captureId: string; status: "passing" | "blocked" }>;
      };
      reviewHandoff: {
        issueUrl: string;
        reviewRoute: string;
        captureTemplateRoute: string;
        captureReplayChecklistRoute: string;
        captureReplayValidationRoute: string;
        captureTemplateCommand: string;
        validationCommand: string;
        strictValidationCommand: string;
        nextEvidenceOwner: string;
      };
      strictArtifactVerification: { requiredForClose: boolean; verified: boolean; reason: string };
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/realtime-shim/speech-enhancement-spike");
    assert.equal(payload.issue, "agonza1/agentic-contact-center#97");
    assert.equal(payload.reference.modelFamily, "LaCo-SENet");
    assert.deepEqual(payload.reference.latencyRangeMs, [12.5, 75]);
    assert.equal(payload.pipelinePlacement.recommendedOwner, "rtc-asr");
    assert.equal(payload.pipelinePlacement.stage, "before_local_stt_v1_frames");
    assert.ok(payload.pipelinePlacement.preservedContracts.includes("POST /api/realtime-shim/rpc remains unchanged"));
    assert.deepEqual(
      payload.candidates.map((candidate) => candidate.algorithmicLatencyMs),
      [12.5, 25, 50, 75],
    );
    assert.equal(payload.candidates[0].recommendation, "recommended");
    assert.equal(payload.candidates.at(-1)?.withinConversationalBudget, false);
    assert.deepEqual(
      payload.latencyProfiles.map((profile) => profile.latencyMs),
      [12.5, 25, 50, 75],
    );
    assert.deepEqual(payload.latencyProfiles[0], {
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
    });
    assert.equal(payload.latencyProfiles.at(-1)?.liveDemoEligible, false);
    assert.equal(payload.replayMetrics.length, 1);
    assert.equal(payload.replayMetrics[0].latencySettingMs, 12.5);
    assert.equal(payload.replayMetrics[0].enhanced.addedTurnLatencyMsP95, 18);
    assert.equal(payload.replayMetrics[0].enhanced.cpuPercentP95, 42);
    assert.ok(
      payload.replayMetrics[0].enhanced.wordErrorRateEstimate <
        payload.replayMetrics[0].baseline.wordErrorRateEstimate,
    );
    assert.equal(payload.decision.status, "go_for_feature_flagged_spike");
    assert.equal(payload.decision.recommendedLatencyMs, 12.5);
    assert.equal(payload.proposedConfig.featureFlag, "RTC_ASR_SPEECH_ENHANCEMENT");
    assert.deepEqual(payload.proposedConfig.allowedLatencyMs, [12.5, 25, 50, 75]);
    assert.equal(payload.proposedConfig.defaultLatencyMs, 12.5);
    assert.deepEqual(payload.runtimeConfig, {
      enabled: false,
      latencyMs: 12.5,
      bypassReason: "feature_flag_disabled",
      env: {
        featureFlag: "RTC_ASR_SPEECH_ENHANCEMENT",
        latencyMs: "RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS",
      },
    });
    assert.equal(payload.runtimeReadiness.status, "disabled");
    assert.equal(payload.runtimeReadiness.enabled, false);
    assert.equal(payload.runtimeReadiness.latencyMs, 12.5);
    assert.equal(payload.runtimeReadiness.liveDemoEligible, false);
    assert.equal(payload.runtimeReadiness.selectedLatencyProfile?.lookaheadFrames, 1);
    assert.deepEqual(payload.runtimeReadiness.frameBudget, {
      rtcAsrFrameMs: 20,
      lookaheadFrames: 1,
      maxBufferedAudioMs: 32.5,
    });
    assert.deepEqual(payload.runtimeReadiness.bypassReasons, [
      "feature_flag_disabled",
      "blocked_until_real_capture",
    ]);
    assert.equal(payload.acceptanceReadiness.reportRecommendation, "complete");
    assert.equal(payload.acceptanceReadiness.noisyReplay, "synthetic_fixture_ready");
    assert.equal(payload.acceptanceReadiness.latencyMetrics, "covered");
    assert.equal(payload.acceptanceReadiness.transcriptEndpointingMetrics, "covered");
    assert.equal(payload.acceptanceReadiness.cpuRuntimeCost, "estimated_needs_live_measurement");
    assert.equal(payload.acceptanceReadiness.featureFlagShape, "proposed");
    assert.ok(
      payload.acceptanceReadiness.remainingBeforeIssueClose.some((item) => item.includes("real noisy local SIP capture")),
    );
    assert.deepEqual(
      payload.runtimeGuardrails.map((guardrail) => guardrail.metric),
      [
        "p95_added_turn_latency_ms",
        "word_error_rate_delta",
        "endpointing_stability",
        "barge_in_risk",
        "cpu_cost",
      ],
    );
    assert.ok(payload.runtimeGuardrails.every((guardrail) => guardrail.rollbackSignal.length > 0));
    assert.equal(payload.replayDecisions.length, 1);
    assert.equal(payload.replayDecisions[0].captureId, "synthetic-noisy-cancellation-rescue-001");
    assert.equal(payload.replayDecisions[0].latencySettingMs, 12.5);
    assert.equal(payload.replayDecisions[0].enableForLiveDemo, true);
    assert.deepEqual(payload.replayDecisions[0].reasons, [
      "wer_improved",
      "endpointing_no_regression",
      "barge_in_risk_no_regression",
      "latency_within_budget",
      "cpu_cost_allowed",
    ]);
    assert.equal(payload.replayCoverage.syntheticNoisyReplayCount, 1);
    assert.equal(payload.replayCoverage.realNoisyCaptureReplayCount, 0);
    assert.equal(payload.replayCoverage.baselineEnhancedPairs, 1);
    assert.equal(payload.replayCoverage.liveDemoGate, "blocked_until_real_capture");
    assert.deepEqual(payload.closeGateProfile, {
      requiredCaptureIdPrefix: "real-noisy-local-sip-",
      requiredLatencySettingMs: 12.5,
      maxAddedTurnLatencyMsP95: 25,
      maxCpuPercentP95: 80,
      allowedCpuCostEstimates: ["low", "medium"],
    });
    assert.ok(payload.replayCoverage.missingEvidence.includes("real_noisy_local_sip_capture_baseline_vs_enhanced_replay"));
    assert.equal(payload.captureReplayContract.requiredCaptureKind, "real_noisy_local_sip");
    assert.equal(
      payload.captureReplayContract.fixtureManifestPath,
      "artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.deepEqual(payload.captureReplayContract.comparisonPairs, ["baseline_rtc_asr", "enhanced_rtc_asr"]);
    assert.ok(payload.captureReplayContract.requiredFields.includes("enhanced_rtc_asr.added_turn_latency_ms_p95"));
    assert.ok(payload.captureReplayContract.requiredFields.includes("enhanced_rtc_asr.cpu_percent_p95"));
    assert.ok(payload.captureReplayContract.requiredFields.includes("latency_setting_ms"));
    assert.deepEqual(payload.captureReplayContract.strictArtifactChecks, [
      "exists",
      "sha256_matches",
      "artifact_uri_is_workspace_relative",
      "source_manifest_json_object",
      "source_manifest_identity_fields_present",
      "source_manifest_capture_id_matches",
      "source_manifest_audio_source_uri_matches",
      "source_manifest_recorded_at_matches",
    ]);
    assert.ok(
      payload.captureReplayContract.minimumPassingCriteria.some((criterion) => criterion.includes("word error")),
    );
    assert.deepEqual(
      payload.rolloutPlan.map((step) => [step.step, step.owner]),
      [
        ["capture_replay", "agentic_contact_center"],
        ["feature_flag", "rtc_asr"],
        ["shadow_compare", "rtc_asr"],
        ["live_enablement", "agentic_contact_center"],
      ],
    );
    assert.ok(payload.rolloutPlan.every((step) => step.gate.length > 0));
    assert.ok(payload.validationPlan.some((step) => step.includes("noisy local SIP capture")));
    assert.equal(payload.reviewGate.issueCloseReady, false);
    assert.equal(payload.reviewGate.checks.realNoisyCaptureReplay, false);
    assert.equal(payload.reviewGate.checks.cpuRuntimeCost, false);
    assert.match(payload.reviewGate.failureReasons.realNoisyCaptureReplay, /real noisy local SIP capture/);
    assert.ok(payload.reviewGate.blockers.some((blocker) => blocker.includes("real noisy local SIP capture")));
    assert.ok(payload.reviewGate.nextEvidence.includes("real_noisy_local_sip_capture_baseline_vs_enhanced_replay"));
    assert.deepEqual(payload.reviewGate.nextAction, {
      owner: "agentic_contact_center",
      action: "attach_real_capture_replay",
      command:
        "npm run proof:speech-enhancement -- --require-close-ready --strict-capture-artifacts --capture-replay artifacts/speech-enhancement-real-capture-replay.json",
      reason: "Attach one real noisy local SIP capture replay before closing Issue #97.",
    });
    assert.deepEqual(payload.reviewGate.realCaptureReplayIds, []);
    assert.equal(payload.reviewHandoff.issueUrl, "https://github.com/agonza1/agentic-contact-center/issues/97");
    assert.equal(payload.reviewHandoff.reviewRoute, "/api/realtime-shim/speech-enhancement-spike");
    assert.equal(
      payload.reviewHandoff.captureTemplateRoute,
      "/api/realtime-shim/speech-enhancement-spike/capture-template?includeContract=1",
    );
    assert.equal(
      payload.reviewHandoff.captureReplayChecklistRoute,
      "/api/realtime-shim/speech-enhancement-spike/capture-replay/checklist",
    );
    assert.equal(
      payload.reviewHandoff.captureReplayValidationRoute,
      "/api/realtime-shim/speech-enhancement-spike/capture-replay/validate",
    );
    assert.equal(
      payload.reviewHandoff.captureTemplateCommand,
      "npm run proof:speech-enhancement -- --capture-replay-template-out artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.equal(payload.reviewHandoff.validationCommand, "npm run proof:speech-enhancement -- --require-close-ready");
    assert.equal(
      payload.reviewHandoff.strictValidationCommand,
      "npm run proof:speech-enhancement -- --require-close-ready --strict-capture-artifacts --capture-replay artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.equal(payload.reviewHandoff.nextEvidenceOwner, "agentic_contact_center");
    assert.deepEqual(payload.strictArtifactVerification, {
      requiredForClose: true,
      verified: false,
      sourceCount: 0,
      verifiedSourceCount: 0,
      unverifiedSourceCount: 0,
      reason: "attach_real_capture_replay_before_strict_artifact_verification",
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

    if (previousFeatureFlag === undefined) {
      delete process.env.RTC_ASR_SPEECH_ENHANCEMENT;
    } else {
      process.env.RTC_ASR_SPEECH_ENHANCEMENT = previousFeatureFlag;
    }

    if (previousLatencyMs === undefined) {
      delete process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS;
    } else {
      process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS = previousLatencyMs;
    }
  }
});

test("GET /api/realtime-shim/speech-enhancement-spike/capture-template returns reusable manifest shape", async () => {
  const server = buildHttpServer(loadPocConfig());

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/realtime-shim/speech-enhancement-spike/capture-template",
          method: "GET",
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
        },
      );

      req.on("error", reject);
      req.end();
    });

    const payload = JSON.parse(responseBody) as {
      capture_id: string;
      audio_source_uri: string;
      audio_sha256: string;
      source_manifest_uri: string;
      source_manifest_sha256: string;
      baseline_rtc_asr: { endpointing_stability: string; barge_in_risk: string };
      enhanced_rtc_asr: {
        endpointing_stability: string;
        barge_in_risk: string;
        added_turn_latency_ms_p95: number;
        cpu_percent_p95: number;
        cpu_cost_estimate: string;
      };
      latency_setting_ms: number;
    };

    assert.equal(payload.capture_id, "real-noisy-local-sip-001");
    assert.equal(payload.audio_source_uri, "artifacts/local-sip/real-noisy-local-sip-001.wav");
    assert.equal(payload.audio_sha256, "replace_with_64_char_lowercase_sha256");
    assert.equal(payload.source_manifest_uri, "artifacts/local-sip/proof-manifest-001.json");
    assert.equal(payload.source_manifest_sha256, "replace_with_64_char_lowercase_sha256");
    assert.equal(payload.baseline_rtc_asr.endpointing_stability, "acceptable");
    assert.equal(payload.baseline_rtc_asr.barge_in_risk, "medium");
    assert.equal(payload.enhanced_rtc_asr.endpointing_stability, "stable");
    assert.equal(payload.enhanced_rtc_asr.barge_in_risk, "low");
    assert.equal(payload.enhanced_rtc_asr.added_turn_latency_ms_p95, 18);
    assert.equal(payload.enhanced_rtc_asr.cpu_percent_p95, 42);
    assert.equal(payload.enhanced_rtc_asr.cpu_cost_estimate, "medium");
    assert.equal(payload.latency_setting_ms, 12.5);
  } finally {
    server.close();
  }
});

test("GET /api/realtime-shim/speech-enhancement-spike/capture-template can include contract metadata", async () => {
  const server = buildHttpServer(loadPocConfig());

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/realtime-shim/speech-enhancement-spike/capture-template?includeContract=1",
          method: "GET",
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
        },
      );

      req.on("error", reject);
      req.end();
    });

    const payload = JSON.parse(responseBody) as {
      template: { capture_id: string; latency_setting_ms: number };
      contract: {
        fixtureManifestPath: string;
        strictArtifactFields: string[];
        strictArtifactChecks: string[];
        minimumPassingCriteria: string[];
      };
      validation: { command: string; route: string };
      captureReplayChecklist: Array<{ step: string; owner: string; command: string }>;
    };

    assert.equal(payload.template.capture_id, "real-noisy-local-sip-001");
    assert.equal(payload.template.latency_setting_ms, 12.5);
    assert.equal(
      payload.contract.fixtureManifestPath,
      "artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.ok(payload.contract.strictArtifactFields.includes("audio_sha256"));
    assert.ok(payload.contract.strictArtifactChecks.includes("sha256_matches"));
    assert.ok(payload.contract.minimumPassingCriteria.some((criterion) => criterion.includes("CPU p95")));
    assert.equal(payload.validation.route, "/api/realtime-shim/speech-enhancement-spike/capture-replay/validate");
    assert.equal(
      payload.validation.command,
      "npm run proof:speech-enhancement -- --require-close-ready --strict-capture-artifacts --capture-replay artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.deepEqual(
      payload.captureReplayChecklist.map((item) => item.step),
      ["record_real_noisy_local_sip", "run_baseline_rtc_asr", "run_enhanced_rtc_asr", "verify_artifacts", "run_close_gate"],
    );
    assert.equal(payload.captureReplayChecklist[1].owner, "rtc_asr");
  } finally {
    server.close();
  }
});

test("GET /api/realtime-shim/speech-enhancement-spike/capture-replay/checklist exposes ordered close-gate steps", async () => {
  const server = buildHttpServer(loadPocConfig());

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/realtime-shim/speech-enhancement-spike/capture-replay/checklist",
          method: "GET",
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
        },
      );

      req.on("error", reject);
      req.end();
    });

    const payload = JSON.parse(responseBody) as {
      ok: boolean;
      route: string;
      issue: string;
      captureReplayChecklist: Array<{ step: string; owner: string; evidence: string; command: string }>;
      closeGateProfile: {
        requiredCaptureIdPrefix: string;
        requiredLatencySettingMs: number;
        maxAddedTurnLatencyMsP95: number;
        maxCpuPercentP95: number;
        allowedCpuCostEstimates: string[];
      };
      captureReplayContract: { fixtureManifestPath: string; requiredFields: string[]; minimumPassingCriteria: string[] };
      handoff: {
        captureReplayChecklistRoute: string;
        captureReplayValidationRoute: string;
        strictValidationCommand: string;
      };
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/realtime-shim/speech-enhancement-spike/capture-replay/checklist");
    assert.equal(payload.issue, "agonza1/agentic-contact-center#97");
    assert.equal(payload.handoff.captureReplayChecklistRoute, payload.route);
    assert.deepEqual(payload.closeGateProfile, {
      requiredCaptureIdPrefix: "real-noisy-local-sip-",
      requiredLatencySettingMs: 12.5,
      maxAddedTurnLatencyMsP95: 25,
      maxCpuPercentP95: 80,
      allowedCpuCostEstimates: ["low", "medium"],
    });
    assert.equal(
      payload.captureReplayContract.fixtureManifestPath,
      "artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.ok(payload.captureReplayContract.requiredFields.includes("source_manifest_sha256"));
    assert.ok(payload.captureReplayContract.minimumPassingCriteria.some((criterion) => criterion.includes("CPU p95")));
    assert.equal(
      payload.handoff.captureReplayValidationRoute,
      "/api/realtime-shim/speech-enhancement-spike/capture-replay/validate",
    );
    assert.deepEqual(
      payload.captureReplayChecklist.map((item) => item.step),
      ["record_real_noisy_local_sip", "run_baseline_rtc_asr", "run_enhanced_rtc_asr", "verify_artifacts", "run_close_gate"],
    );
    assert.equal(payload.captureReplayChecklist.at(-1)?.command, payload.handoff.strictValidationCommand);
    assert.ok(payload.captureReplayChecklist.every((item) => item.evidence.length > 0));
  } finally {
    server.close();
  }
});


test("GET /api/realtime-shim/speech-enhancement-spike/capture-replay/close-gate exposes current close readiness", async () => {
  const previousFeatureFlag = process.env.RTC_ASR_SPEECH_ENHANCEMENT;
  const previousLatencyMs = process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS;
  process.env.RTC_ASR_SPEECH_ENHANCEMENT = "enabled";
  process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS = "12.5";
  const server = buildHttpServer(loadPocConfig());

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/realtime-shim/speech-enhancement-spike/capture-replay/close-gate",
          method: "GET",
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
        },
      );

      req.on("error", reject);
      req.end();
    });

    const payload = JSON.parse(responseBody) as {
      ok: boolean;
      route: string;
      issue: string;
      closeGateStatus: string;
      reviewGate: { issueCloseReady: boolean; nextAction: { action: string; command: string }; nextEvidence: string[] };
      runtimeReadiness: { status: string; liveDemoEligible: boolean; bypassReasons: string[] };
      strictArtifactVerification: { requiredForClose: boolean; verified: boolean; reason: string };
      handoff: { strictValidationCommand: string };
      captureReplayChecklist: Array<{ step: string; command: string }>;
      nextChecklistStep: { step: string; command: string; status: string; reason: string };
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/realtime-shim/speech-enhancement-spike/capture-replay/close-gate");
    assert.equal(payload.issue, "agonza1/agentic-contact-center#97");
    assert.equal(payload.closeGateStatus, "blocked_before_real_capture");
    assert.equal(payload.reviewGate.issueCloseReady, false);
    assert.equal(payload.reviewGate.nextAction.action, "attach_real_capture_replay");
    assert.equal(payload.reviewGate.nextAction.command, payload.handoff.strictValidationCommand);
    assert.ok(payload.reviewGate.nextEvidence.includes("real_noisy_local_sip_capture_baseline_vs_enhanced_replay"));
    assert.equal(payload.runtimeReadiness.status, "blocked");
    assert.equal(payload.runtimeReadiness.liveDemoEligible, false);
    assert.deepEqual(payload.runtimeReadiness.bypassReasons, ["blocked_until_real_capture"]);
    assert.deepEqual(payload.strictArtifactVerification, {
      requiredForClose: true,
      verified: false,
      sourceCount: 0,
      verifiedSourceCount: 0,
      unverifiedSourceCount: 0,
      reason: "attach_real_capture_replay_before_strict_artifact_verification",
    });
    assert.equal(payload.captureReplayChecklist.at(-1)?.step, "run_close_gate");
    assert.equal(payload.captureReplayChecklist.at(-1)?.command, payload.handoff.strictValidationCommand);
    assert.equal(payload.nextChecklistStep.step, "record_real_noisy_local_sip");
    assert.equal(payload.nextChecklistStep.status, "blocked");
    assert.equal(
      payload.nextChecklistStep.command,
      "npm run proof:speech-enhancement -- --capture-replay-template-out artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.equal(
      payload.nextChecklistStep.reason,
      "Attach one real noisy local SIP capture replay before closing Issue #97.",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

    if (previousFeatureFlag === undefined) {
      delete process.env.RTC_ASR_SPEECH_ENHANCEMENT;
    } else {
      process.env.RTC_ASR_SPEECH_ENHANCEMENT = previousFeatureFlag;
    }

    if (previousLatencyMs === undefined) {
      delete process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS;
    } else {
      process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS = previousLatencyMs;
    }
  }
});


test("POST /api/realtime-shim/speech-enhancement-spike/capture-replay/validate gates a real replay manifest", async () => {
  const previousFeatureFlag = process.env.RTC_ASR_SPEECH_ENHANCEMENT;
  const previousLatencyMs = process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS;
  process.env.RTC_ASR_SPEECH_ENHANCEMENT = "enabled";
  process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS = "12.5";
  const server = buildHttpServer(loadPocConfig());

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    const body = JSON.stringify({
      capture_id: "real-noisy-local-sip-validate-001",
      recorded_at: "2026-07-05T15:45:00Z",
      audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-validate-001.wav",
      audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      source_manifest_uri: "artifacts/local-sip/proof-manifest-validate-001.json",
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

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/realtime-shim/speech-enhancement-spike/capture-replay/validate",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let responseBody = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            responseBody += chunk;
          });
          res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody }));
        },
      );

      req.on("error", reject);
      req.end(body);
    });

    const payload = JSON.parse(response.body) as {
      ok: boolean;
      route: string;
      validation: { manifestOk: boolean; evaluation: { issueCloseReady: boolean } };
      reviewGate: { issueCloseReady: boolean; passingRealCaptureReplayIds: string[]; nextEvidence: string[] };
      handoff: { captureReplayValidationRoute: string; strictValidationCommand: string };
      captureReplayChecklist: Array<{ command: string }>;
      runtimeReadiness: { status: string; liveDemoEligible: boolean; bypassReasons: string[] };
      strictArtifactVerification: { requiredForClose: boolean; verified: boolean; reason: string };
    };

    assert.equal(response.statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/realtime-shim/speech-enhancement-spike/capture-replay/validate");
    assert.equal(payload.validation.manifestOk, true);
    assert.equal(payload.validation.evaluation.issueCloseReady, true);
    assert.equal(payload.reviewGate.issueCloseReady, true);
    assert.deepEqual(payload.reviewGate.passingRealCaptureReplayIds, ["real-noisy-local-sip-validate-001"]);
    assert.deepEqual(payload.reviewGate.nextEvidence, []);
    assert.equal(payload.handoff.captureReplayValidationRoute, payload.route);
    assert.equal(payload.handoff.strictValidationCommand, payload.captureReplayChecklist.at(-1)?.command);
    assert.equal(payload.runtimeReadiness.status, "ready");
    assert.equal(payload.runtimeReadiness.liveDemoEligible, true);
    assert.deepEqual(payload.runtimeReadiness.bypassReasons, []);
    assert.deepEqual(payload.strictArtifactVerification, {
      requiredForClose: true,
      verified: false,
      sourceCount: 1,
      verifiedSourceCount: 0,
      unverifiedSourceCount: 1,
      reason: "run_with_strict_capture_artifacts_before_closing",
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

    if (previousFeatureFlag === undefined) {
      delete process.env.RTC_ASR_SPEECH_ENHANCEMENT;
    } else {
      process.env.RTC_ASR_SPEECH_ENHANCEMENT = previousFeatureFlag;
    }

    if (previousLatencyMs === undefined) {
      delete process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS;
    } else {
      process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS = previousLatencyMs;
    }
  }
});
