import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

test("GET /health returns config-backed demo metadata", async () => {
  const config = loadPocConfig();
  const server = buildHttpServer(config);

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  const responseBody = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: "/health",
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

  server.close();

  const payload = JSON.parse(responseBody) as {
    ok: boolean;
    demoName: string;
    operatorChannel: string;
    policyProfile: string;
    policyToolScope: string;
    fallbackMode: string;
    latencyBudgetsMs: { asrPartial: number; policyGate: number; operatorNotification: number; ttsFirstAudio: number };
    runtimeSeams: string[];
    productionReadiness: {
      demoReady: boolean;
      productionReady: boolean;
      statePersistence: string;
      requiredForProduction: string[];
      blockers: string[];
    };
    pipecatFlow: {
      ready: boolean;
      prototypeMode: string;
      transport: string;
      runtimeEngine: string;
      credentialsMode: string;
      runtimeCheck: { command: string; installCommand: string; liveTelephonyRequired: boolean };
      activeTool: string | null;
      toolCoverage: string[];
    };
    speechEnhancement: {
      issue: string;
      issueUrl: string;
      reviewRoute: string;
      captureTemplateRoute: string;
      captureReplayChecklistRoute: string;
      captureReplayCloseGateRoute: string;
      captureReplayValidationRoute: string;
      captureTemplateCommand: string;
      recommendedLatencyMs: number;
      runtimeEnv: { featureFlag: string; latencyMs: string };
      runtimeStatus: string;
      runtimeEnabled: boolean;
      runtimeLatencyMs: number;
      runtimeBypassReason?: string;
      runtimeBypassReasons: string[];
      runtimeLookaheadFrames: number | null;
      runtimeMaxBufferedAudioMs: number | null;
      runtimeProfileExpectedUse: string | null;
      runtimeProfileRecommendation: string | null;
      runtimeProfileBypassWhen: string[];
      runtimeLiveDemoEligible: boolean;
      closeGateRequiredLatencyMs: number;
      closeGateMaxAddedTurnLatencyMsP95: number;
      closeGateMaxCpuPercentP95: number;
      liveDemoGate: string;
      issueCloseReady: boolean;
      reviewChecks: { realNoisyCaptureReplay: boolean; cpuRuntimeCost: boolean };
      failureReasons: Record<string, string>;
      missingEvidence: string[];
      blockers: string[];
      nextEvidence: string[];
      nextAction: { owner: string; action: string; command: string; reason: string };
      passingRealCaptureReplayIds: string[];
      blockedRealCaptureReplayIds: string[];
      strictArtifactVerification: { requiredForClose: boolean; verified: boolean; reason: string };
      captureReplayFixturePath: string;
      validationCommand: string;
      strictValidationCommand: string;
    };
  };

  assert.equal(payload.ok, true);
  assert.equal(payload.demoName, config.demoName);
  assert.equal(payload.policyProfile, config.policy.profile);
  assert.equal(payload.policyToolScope, config.policy.toolScope);
  assert.equal(payload.operatorChannel, config.operator.channel);
  assert.equal(payload.fallbackMode, config.policy.fallbackMode);
  assert.deepEqual(payload.latencyBudgetsMs, config.latencyBudgetsMs);
  assert.equal(payload.runtimeSeams.includes("flow engine"), true);
  assert.equal(payload.productionReadiness.demoReady, true);
  assert.equal(payload.productionReadiness.productionReady, false);
  assert.equal(payload.productionReadiness.statePersistence, "in_memory");
  assert.equal(payload.productionReadiness.requiredForProduction.includes("signalwire_live_telephony"), true);
  assert.equal(payload.productionReadiness.requiredForProduction.includes("persistent_call_state"), true);
  assert.equal(payload.productionReadiness.blockers.includes("live_telephony_not_enabled"), true);
  assert.equal(payload.productionReadiness.blockers.includes("provider_credentials_mocked"), true);
  assert.equal(payload.productionReadiness.blockers.includes("state_store_in_memory"), true);
  assert.equal(payload.pipecatFlow.ready, true);
  assert.equal(payload.pipecatFlow.prototypeMode, "pipecat_local_runtime");
  assert.equal(payload.pipecatFlow.transport, "local_process");
  assert.equal(payload.pipecatFlow.runtimeEngine, "pipecat-ai");
  assert.equal(payload.pipecatFlow.credentialsMode, "mocked");
  assert.equal(payload.pipecatFlow.runtimeCheck.command, "npm run pipecat:check");
  assert.equal(payload.pipecatFlow.runtimeCheck.liveTelephonyRequired, false);
  assert.match(payload.pipecatFlow.runtimeCheck.installCommand, /requirements-pipecat\.txt/);
  assert.equal(payload.pipecatFlow.activeTool, "get_current_slide");
  assert.equal(payload.pipecatFlow.toolCoverage.includes("goto_slide"), true);
  assert.equal(payload.speechEnhancement.issue, "agonza1/agentic-contact-center#97");
  assert.equal(payload.speechEnhancement.issueUrl, "https://github.com/agonza1/agentic-contact-center/issues/97");
  assert.equal(payload.speechEnhancement.reviewRoute, "/api/realtime-shim/speech-enhancement-spike");
  assert.equal(
    payload.speechEnhancement.captureTemplateRoute,
    "/api/realtime-shim/speech-enhancement-spike/capture-template?includeContract=1",
  );
  assert.equal(
    payload.speechEnhancement.captureReplayChecklistRoute,
    "/api/realtime-shim/speech-enhancement-spike/capture-replay/checklist",
  );
  assert.equal(
    payload.speechEnhancement.captureReplayCloseGateRoute,
    "/api/realtime-shim/speech-enhancement-spike/capture-replay/close-gate",
  );
  assert.equal(
    payload.speechEnhancement.captureReplayValidationRoute,
    "/api/realtime-shim/speech-enhancement-spike/capture-replay/validate",
  );
  assert.equal(
    payload.speechEnhancement.captureTemplateCommand,
    "npm run proof:speech-enhancement -- --capture-replay-template-out artifacts/speech-enhancement-real-capture-replay.json",
  );
  assert.equal(payload.speechEnhancement.recommendedLatencyMs, 12.5);
  assert.deepEqual(payload.speechEnhancement.runtimeEnv, {
    featureFlag: "RTC_ASR_SPEECH_ENHANCEMENT",
    latencyMs: "RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS",
  });
  assert.equal(payload.speechEnhancement.runtimeStatus, "disabled");
  assert.equal(payload.speechEnhancement.runtimeEnabled, false);
  assert.equal(payload.speechEnhancement.runtimeLatencyMs, 12.5);
  assert.equal(payload.speechEnhancement.runtimeBypassReason, "feature_flag_disabled");
  assert.deepEqual(payload.speechEnhancement.runtimeBypassReasons, [
    "feature_flag_disabled",
    "blocked_until_real_capture",
  ]);
  assert.equal(payload.speechEnhancement.runtimeLookaheadFrames, 1);
  assert.equal(payload.speechEnhancement.runtimeMaxBufferedAudioMs, 32.5);
  assert.equal(payload.speechEnhancement.runtimeProfileExpectedUse, "default");
  assert.equal(payload.speechEnhancement.runtimeProfileRecommendation, "recommended");
  assert.deepEqual(payload.speechEnhancement.runtimeProfileBypassWhen, [
    "added_turn_latency_p95_exceeds_candidate_budget",
    "enhanced_cpu_percent_p95_exceeds_80",
    "barge_in_or_endpointing_regresses",
  ]);
  assert.equal(payload.speechEnhancement.runtimeLiveDemoEligible, false);
  assert.equal(payload.speechEnhancement.closeGateRequiredLatencyMs, 12.5);
  assert.equal(payload.speechEnhancement.closeGateMaxAddedTurnLatencyMsP95, 25);
  assert.equal(payload.speechEnhancement.closeGateMaxCpuPercentP95, 80);
  assert.equal(payload.speechEnhancement.liveDemoGate, "blocked_until_real_capture");
  assert.equal(payload.speechEnhancement.issueCloseReady, false);
  assert.equal(payload.speechEnhancement.reviewChecks.realNoisyCaptureReplay, false);
  assert.equal(payload.speechEnhancement.reviewChecks.cpuRuntimeCost, false);
  assert.match(payload.speechEnhancement.failureReasons.realNoisyCaptureReplay, /real noisy local SIP capture/);
  assert.ok(
    payload.speechEnhancement.missingEvidence.includes(
      "real_noisy_local_sip_capture_baseline_vs_enhanced_replay",
    ),
  );
  assert.ok(payload.speechEnhancement.blockers.some((item) => item.includes("real noisy local SIP capture")));
  assert.deepEqual(payload.speechEnhancement.nextEvidence, payload.speechEnhancement.missingEvidence);
  assert.deepEqual(payload.speechEnhancement.nextAction, {
    owner: "agentic_contact_center",
    action: "attach_real_capture_replay",
    command:
      "npm run proof:speech-enhancement -- --require-close-ready --strict-capture-artifacts --capture-replay artifacts/speech-enhancement-real-capture-replay.json",
    reason: "Attach one real noisy local SIP capture replay before closing Issue #97.",
  });
  assert.deepEqual(payload.speechEnhancement.passingRealCaptureReplayIds, []);
  assert.deepEqual(payload.speechEnhancement.blockedRealCaptureReplayIds, []);
  assert.deepEqual(payload.speechEnhancement.strictArtifactVerification, {
    requiredForClose: true,
    verified: false,
    sourceCount: 0,
    verifiedSourceCount: 0,
    unverifiedSourceCount: 0,
    reason: "attach_real_capture_replay_before_strict_artifact_verification",
  });
  assert.equal(
    payload.speechEnhancement.captureReplayFixturePath,
    "artifacts/speech-enhancement-real-capture-replay.json",
  );
  assert.equal(
    payload.speechEnhancement.validationCommand,
    "npm run proof:speech-enhancement -- --require-close-ready",
  );
  assert.equal(
    payload.speechEnhancement.strictValidationCommand,
    "npm run proof:speech-enhancement -- --require-close-ready --strict-capture-artifacts --capture-replay artifacts/speech-enhancement-real-capture-replay.json",
  );
});
