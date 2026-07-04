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
      replayMetrics: Array<{ baseline: { wordErrorRateEstimate: number }; enhanced: { wordErrorRateEstimate: number }; latencySettingMs: number }>;
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
      validationPlan: string[];
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
    assert.ok(payload.validationPlan.some((step) => step.includes("noisy local SIP capture")));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
