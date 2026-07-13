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
    browserWebRtc: {
      ok: boolean;
      route: string;
      issue: string;
      status: string;
      normalOperation: { transport: string; mediaRecorderRequired: boolean; ffmpegRequired: boolean };
      readiness: {
        acc: { status: string };
        pipecatWebrtcBridge: { status: string };
        rtcAsr: { status: string; engine: string; contract: string };
        kokoro: { status: string; engine: string };
      };
      liveMedia: { verified: boolean; status: string };
      blockers: string[];
      contractReady: boolean;
      liveMediaVerified: boolean;
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
  assert.equal(payload.browserWebRtc.ok, true);
  assert.equal(payload.browserWebRtc.route, "/api/browser-webrtc/readiness");
  assert.equal(payload.browserWebRtc.issue, "agonza1/agentic-contact-center#213");
  assert.equal(payload.browserWebRtc.status, "contract_ready_pending_live_media_evidence");
  assert.deepEqual(payload.browserWebRtc.normalOperation, {
    transport: "webrtc",
    browserCapture: "getUserMedia MediaStreamTrack",
    browserPlayback: "WebRTC remote audio track",
    mediaRecorderRequired: false,
    ffmpegRequired: false,
  });
  assert.equal(payload.browserWebRtc.readiness.acc.status, "ready");
  assert.equal(payload.browserWebRtc.readiness.pipecatWebrtcBridge.status, "signaling_ready");
  assert.equal(payload.browserWebRtc.readiness.rtcAsr.engine, "rtc-asr");
  assert.equal(payload.browserWebRtc.readiness.rtcAsr.contract, "local-stt.v1");
  assert.equal(payload.browserWebRtc.readiness.kokoro.engine, "kokoro");
  assert.equal(payload.browserWebRtc.liveMedia.verified, false);
  assert.equal(payload.browserWebRtc.liveMedia.status, "pending_local_bridge_proof");
  assert.deepEqual(payload.browserWebRtc.blockers, ["live_webrtc_media_turn_evidence_missing"]);
  assert.equal(payload.browserWebRtc.contractReady, true);
  assert.equal(payload.browserWebRtc.liveMediaVerified, false);
});
