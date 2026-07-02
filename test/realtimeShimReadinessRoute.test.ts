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
      reviewBlockers: string[];
      reviewPacket: {
        ready: boolean;
        issue: string;
        primaryRoute: string;
        readinessRoute: string;
        rpcRoute: string;
        validationCommands: string[];
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
    assert.deepEqual(payload.reviewBlockers, []);
    assert.deepEqual(payload.reviewPacket, {
      ready: true,
      issue: "agonza1/agentic-contact-center#85",
      primaryRoute: "/api/realtime-shim/proof",
      readinessRoute: "/api/realtime-shim/readiness",
      rpcRoute: "POST /api/realtime-shim/rpc",
      validationCommands: ["npm test", "npm run pipecat:check", "npm run proof:realtime-shim"],
      reviewerChecklist: [
        "Confirm the Gateway relay RPC boundary matches the OpenClaw browser voice surface.",
        "Inspect proof.evidence.eventTranscript, proof.evidence.logs, and proof.evidence.latencyMarks for the one-turn path.",
        "Inspect interruptionEvidence, inputCancelEvidence, errorEvidence, and invalidAudioResult for cancel/error behavior.",
        "Confirm mockedPieces and limitations name the non-live rtc-asr, local LLM, and Kokoro boundaries.",
      ],
    });
    assert.deepEqual(payload.validationCommands, ["npm test", "npm run pipecat:check"]);
    assert.deepEqual(payload.qaEvidenceRoutes, [
      {
        route: "/api/realtime-shim/proof",
        method: "GET",
        evidence: ["logs", "eventTranscript", "timeline", "latencyMarks", "pipelineStages"],
      },
      {
        route: "/api/realtime-shim/rpc",
        method: "POST",
        evidence: ["statefulSession", "cancelInput", "cancelOutput", "boundedErrors", "toolResults"],
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
