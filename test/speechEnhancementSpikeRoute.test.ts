import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

test("GET /api/realtime-shim/speech-enhancement-spike returns issue 97 recommendation", async () => {
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
      replayMetrics: Array<{
        baseline: { wordErrorRateEstimate: number };
        enhanced: { wordErrorRateEstimate: number; addedTurnLatencyMsP95: number; cpuPercentP95: number };
        latencySettingMs: number;
      }>;
      decision: { status: string; recommendedLatencyMs: number };
      proposedConfig: { featureFlag: string; allowedLatencyMs: number[]; defaultLatencyMs: number };
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
      captureReplayContract: {
        requiredCaptureKind: string;
        fixtureManifestPath: string;
        requiredFields: string[];
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
        realCaptureReplayIds: string[];
      };
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
      "endpointing_stable",
      "barge_in_risk_low",
      "latency_within_budget",
      "cpu_cost_allowed",
    ]);
    assert.equal(payload.replayCoverage.syntheticNoisyReplayCount, 1);
    assert.equal(payload.replayCoverage.realNoisyCaptureReplayCount, 0);
    assert.equal(payload.replayCoverage.baselineEnhancedPairs, 1);
    assert.equal(payload.replayCoverage.liveDemoGate, "blocked_until_real_capture");
    assert.ok(payload.replayCoverage.missingEvidence.includes("real_noisy_local_sip_capture_baseline_vs_enhanced_replay"));
    assert.equal(payload.captureReplayContract.requiredCaptureKind, "real_noisy_local_sip");
    assert.equal(
      payload.captureReplayContract.fixtureManifestPath,
      "artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.deepEqual(payload.captureReplayContract.comparisonPairs, ["baseline_rtc_asr", "enhanced_rtc_asr"]);
    assert.ok(payload.captureReplayContract.requiredFields.includes("enhanced_rtc_asr.added_turn_latency_ms_p95"));
    assert.ok(payload.captureReplayContract.requiredFields.includes("enhanced_rtc_asr.cpu_percent_p95"));
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
    assert.deepEqual(payload.reviewGate.realCaptureReplayIds, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
