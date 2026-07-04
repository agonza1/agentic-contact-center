import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

test("GET /api/realtime-shim/readiness returns issue 85 acceptance summary", async () => {
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
          path: "/api/realtime-shim/readiness",
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
      status: string;
      adapter: {
        rpcBoundary: string;
        localSttContract: string;
        rpcRoute: string;
        supportedRpcs: string[];
        statefulSession: boolean;
        boundedErrors: boolean;
      };
      browserRelayCompatibility: { status: string; uiRewriteRequired: boolean; requiredRpcs: string[] };
      latencyBudget: {
        profile: string;
        targetFirstAudioMs: number;
        targetSessionCloseMs: number;
        observedFirstAudioMs?: number;
        observedSessionCloseMs?: number;
        modelGuidance: string;
        status: string;
      };
      sampleRateBridge: {
        browserInputSampleRateHz: number;
        localSttSampleRateHz: number;
        browserOutputSampleRateHz: number;
        resamplingRequired: boolean;
        boundary: string;
        evidence: string;
      };
      runtimeMode: {
        labels: { relay: string; stt: string; llm: string; tts: string };
        liveSidecarsRequired: boolean;
        reviewStatus: string;
      };
      liveSidecarPromotion: {
        status: string;
        nextSwap: { sidecar: string; mockedStage: string; validationGate: string; rollbackSignal: string };
        requiredSidecars: string[];
        contractToPreserve: { rpcBoundary: string; localSttContract: string; browserRelayCompatibility: string };
        firstValidationGate: string;
        rollbackSignal: string;
      };
      reviewBlockers: string[];
      sidecarAcceptanceGates: Array<{
        sidecar: string;
        replaces: string;
        requiredEvidence: string[];
        validationCommand: string;
        rollbackSignal: string;
      }>;
      reviewPacket: {
        ready: boolean;
        issue: string;
        issueUrl: string;
        primaryRoute: string;
        readinessRoute: string;
        rpcRoute: string;
        validationCommands: string[];
        probeCommands: string[];
        artifactOutputs: { defaultProof: string; defaultLatest: string; explicitProofCommand: string };
        proofSignals: {
          readyForIssue85Review: boolean;
          acceptanceCriteriaPassed: number;
          acceptanceCriteriaTotal: number;
          inProcessRpcSmokePassed: number;
          inProcessRpcSmokeTotal: number;
          requestIdEchoed: boolean;
          oneTurnClosed: boolean;
          cancelAndErrorEvidence: { outputCancelled: boolean; inputCancelled: boolean; boundedErrors: boolean };
          bargeInRecoveryReady: boolean;
          liveSidecarPromotionStatus: string;
        };
        mockedPieces: string[];
        limitations: string[];
        rpcExamples: Array<{ label: string; method: string; body: { method: string; params: Record<string, unknown> } }>;
        reviewerChecklist: string[];
      };
      validationCommands: string[];
      qaEvidenceRoutes: Array<{ route: string; method: string; evidence: string[] }>;
      acceptanceCriteria: Array<{ name: string; passed: boolean; evidence: string }>;
      pipelineStages: Array<{ stage: string; status: string; mocked: boolean; evidence: string }>;
      mockedPieces: string[];
      limitations: string[];
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.route, "/api/realtime-shim/readiness");
    assert.equal(payload.issue, "agonza1/agentic-contact-center#85");
    assert.equal(payload.status, "ready_for_issue_85_review");
    assert.deepEqual(payload.adapter, {
      rpcBoundary: "gateway-relay",
      localSttContract: "local-stt.v1",
      rpcRoute: "POST /api/realtime-shim/rpc",
      supportedRpcs: [
        "talk.session.create",
        "talk.session.appendAudio",
        "talk.session.finalizeTurn",
        "talk.session.getEvidence",
        "talk.session.cancelOutput",
        "talk.session.cancelInput",
        "talk.session.recordError",
        "talk.session.submitToolResult",
        "talk.session.close",
      ],
      statefulSession: true,
      boundedErrors: true,
    });
    assert.equal(payload.browserRelayCompatibility.status, "ready_for_browser_flow");
    assert.equal(payload.browserRelayCompatibility.uiRewriteRequired, false);
    assert.deepEqual(payload.latencyBudget, {
      profile: "fast_local_turn",
      targetFirstAudioMs: 500,
      targetSessionCloseMs: 1000,
      observedFirstAudioMs: 135,
      modelGuidance: "small_fast_local_models",
      status: "within_budget",
    });
    assert.deepEqual(payload.sampleRateBridge, {
      browserInputSampleRateHz: 24000,
      localSttSampleRateHz: 16000,
      browserOutputSampleRateHz: 24000,
      resamplingRequired: true,
      boundary: "gateway_pcm16_to_local_stt_pcm16",
      evidence:
        "Gateway relay audio remains 24kHz PCM16 at the browser boundary while Local STT v1 consumes 16kHz PCM16 frames.",
    });
    assert.deepEqual(payload.runtimeMode, {
      labels: {
        relay: "gateway_relay",
        stt: "local_stt_mock",
        llm: "local_llm_mock",
        tts: "kokoro_tts_mock",
      },
      liveSidecarsRequired: false,
      reviewStatus: "deterministic_local_proof_ready",
    });
    assert.deepEqual(payload.liveSidecarPromotion, {
      status: "ready_for_sidecar_swap",
      nextSwap: {
        sidecar: "rtc-asr",
        mockedStage: "local_stt",
        validationGate: "npm run proof:realtime-shim",
        rollbackSignal: "Revert to Local STT v1 deterministic messages if transcript.done, barge-in recovery, or bounded error evidence regresses.",
      },
      requiredSidecars: ["rtc-asr", "local_llm", "kokoro_tts"],
      contractToPreserve: {
        rpcBoundary: "POST /api/realtime-shim/rpc",
        localSttContract: "local-stt.v1",
        browserRelayCompatibility: "ready_for_browser_flow",
      },
      firstValidationGate: "npm run proof:realtime-shim -- --out artifacts/realtime-shim-proof.json --latest-out artifacts/realtime-shim-proof-latest.json",
      rollbackSignal: "Keep mocked local proof green before replacing one sidecar at a time.",
    });
    assert.deepEqual(payload.reviewBlockers, []);
    assert.deepEqual(payload.sidecarAcceptanceGates, [
      {
        sidecar: "rtc-asr",
        replaces: "local_stt_mock",
        requiredEvidence: ["transcript.done", "input cancel drops buffered audio", "bounded STT error evidence"],
        validationCommand: "npm run proof:realtime-shim",
        rollbackSignal: "Missing final transcript, cancelled-input evidence, or bounded STT error evidence.",
      },
      {
        sidecar: "local_llm",
        replaces: "local LLM response text",
        requiredEvidence: ["policy-safe response text", "tool-result not-applicable evidence", "no unsafe retention promise"],
        validationCommand: "npm test -- test/realtimeShimProofScript.test.js",
        rollbackSignal: "Policy gate, tool-result, or unsafe-offer evidence regresses.",
      },
      {
        sidecar: "kokoro_tts",
        replaces: "Kokoro PCM output audio mock",
        requiredEvidence: ["output audio chunks", "barge-in clear event", "same-session recovery turn"],
        validationCommand: "npm run proof:realtime-shim",
        rollbackSignal: "First audio, output cancel, or barge-in recovery evidence regresses.",
      },
    ]);
    assert.equal(payload.reviewPacket.ready, true);
    assert.equal(payload.reviewPacket.issue, "agonza1/agentic-contact-center#85");
    assert.equal(payload.reviewPacket.issueUrl, "https://github.com/agonza1/agentic-contact-center/issues/85");
    assert.equal(payload.reviewPacket.primaryRoute, "/api/realtime-shim/proof");
    assert.equal(payload.reviewPacket.readinessRoute, "/api/realtime-shim/readiness");
    assert.equal(payload.reviewPacket.rpcRoute, "POST /api/realtime-shim/rpc");
    assert.deepEqual(payload.reviewPacket.validationCommands, ["npm test", "npm run pipecat:check", "npm run proof:realtime-shim"]);
    assert.deepEqual(payload.reviewPacket.probeCommands, [
      "curl -fsS http://127.0.0.1:8026/api/realtime-shim/proof",
      "curl -fsS http://127.0.0.1:8026/api/realtime-shim/readiness",
      "curl -fsS -X POST http://127.0.0.1:8026/api/realtime-shim/rpc -H 'content-type: application/json' --data '{\"method\":\"talk.session.getEvidence\",\"params\":{\"sessionId\":\"local-rt-review\"}}'",
    ]);
    assert.deepEqual(payload.reviewPacket.artifactOutputs, {
      defaultProof: "artifacts/realtime-shim-proof-<timestamp>.json",
      defaultLatest: "artifacts/realtime-shim-proof-latest.json",
      explicitProofCommand: "npm run proof:realtime-shim -- --out artifacts/realtime-shim-proof.json --latest-out artifacts/realtime-shim-proof-latest.json",
    });
    assert.deepEqual(payload.reviewPacket.proofSignals, {
      readyForIssue85Review: true,
      acceptanceCriteriaPassed: 6,
      acceptanceCriteriaTotal: 6,
      inProcessRpcSmokePassed: 13,
      inProcessRpcSmokeTotal: 13,
      requestIdEchoed: true,
      oneTurnClosed: true,
      cancelAndErrorEvidence: {
        outputCancelled: true,
        inputCancelled: true,
        boundedErrors: true,
      },
      bargeInRecoveryReady: true,
      liveSidecarPromotionStatus: "ready_for_sidecar_swap",
    });
    assert.deepEqual(payload.reviewPacket.mockedPieces, ["local LLM response text", "Kokoro PCM output audio"]);
    assert.ok(payload.reviewPacket.limitations.some((limitation) => limitation.includes("not a live sidecar connection")));
    assert.deepEqual(
      payload.reviewPacket.rpcExamples.map((example) => example.method),
      [
        "talk.session.create",
        "talk.session.appendAudio",
        "talk.session.finalizeTurn",
        "talk.session.getEvidence",
        "talk.session.cancelOutput",
        "talk.session.cancelInput",
        "talk.session.recordError",
        "talk.session.submitToolResult",
        "talk.session.close",
      ],
    );
    assert.deepEqual(payload.reviewPacket.rpcExamples[0].body, {
      method: "talk.session.create",
      params: { mode: "realtime", transport: "gateway-relay", relaySessionId: "local-rt-review" },
    });
    assert.equal(payload.reviewPacket.rpcExamples[1].body.params.sessionId, "local-rt-review");
    assert.equal(payload.reviewPacket.rpcExamples[2].body.params.transcriptText, "Need a retention credit.");
    assert.equal(payload.reviewPacket.rpcExamples[4].body.params.reason, "barge-in");
    assert.equal(payload.reviewPacket.rpcExamples[6].body.params.code, "stt_disconnected");
    assert.deepEqual(payload.reviewPacket.rpcExamples[7].body.params.result, { ok: true });
    assert.equal(payload.reviewPacket.rpcExamples[8].body.params.reason, "complete");
    assert.deepEqual(payload.reviewPacket.reviewerChecklist, [
      "Confirm the Gateway relay RPC boundary matches the OpenClaw browser voice surface.",
      "Inspect proof.evidence.eventTranscript, proof.evidence.logs, proof.evidence.latencyMarks, and latencyBudget for the one-turn path.",
      "Inspect interruptionEvidence, inputCancelEvidence, errorEvidence, and invalidAudioResult for cancel/error behavior.",
      "Confirm mockedPieces and limitations name the non-live rtc-asr, local LLM, and Kokoro boundaries.",
    ]);
    assert.deepEqual(payload.validationCommands, ["npm test", "npm run pipecat:check", "npm run proof:realtime-shim"]);
    assert.deepEqual(payload.qaEvidenceRoutes, [
      {
        route: "/api/realtime-shim/proof",
        method: "GET",
        evidence: ["logs", "eventTranscript", "timeline", "latencyMarks", "latencyBudget", "sampleRateBridge", "pipelineStages"],
      },
      {
        route: "/api/realtime-shim/rpc",
        method: "POST",
        evidence: ["statefulSession", "cancelInput", "cancelOutput", "boundedErrors", "toolResults"],
      },
      {
        route: "/api/realtime-shim/readiness",
        method: "GET",
        evidence: ["acceptanceCriteria", "runtimeMode", "reviewBlockers", "reviewPacket"],
      },
    ]);
    assert.equal(payload.acceptanceCriteria.length, 6);
    assert.deepEqual(
      Object.fromEntries(payload.acceptanceCriteria.map((criterion) => [criterion.name, criterion.passed])),
      {
        adapter_contract: true,
        one_local_voice_turn: true,
        interruption_cancel_behavior: true,
        qa_evidence: true,
        mocked_pieces_isolated: true,
        bounded_error_evidence: true,
      },
    );
    assert.ok(payload.acceptanceCriteria.every((criterion) => criterion.evidence.length > 0));
    assert.deepEqual(
      payload.pipelineStages.map((stage) => [stage.stage, stage.mocked]),
      [
        ["gateway_relay", false],
        ["local_stt", true],
        ["local_llm", true],
        ["kokoro_tts", true],
      ],
    );
    assert.deepEqual(payload.mockedPieces, ["local LLM response text", "Kokoro PCM output audio"]);
    assert.ok(payload.limitations.some((limitation) => limitation.includes("not a live sidecar connection")));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
