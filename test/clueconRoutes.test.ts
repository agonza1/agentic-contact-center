import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer } from "../src/http/createServer";

async function requestPath(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ statusCode: number; body: string; contentType: string }> {
  const server = buildHttpServer(loadPocConfig());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    return await new Promise((resolve, reject) => {
      const requestBody = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path,
          method,
          headers: requestBody ? { "content-type": "application/json" } : undefined,
        },
        (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body,
            contentType: response.headers["content-type"] ?? "",
          });
        });
      });
      req.on("error", reject);
      if (requestBody) {
        req.write(requestBody);
      }
      req.end();
    });
  } finally {
    server.close();
  }
}

async function get(path: string): Promise<{ statusCode: number; body: string; contentType: string }> {
  return requestPath(path);
}

async function post(path: string, body?: unknown): Promise<{ statusCode: number; body: string; contentType: string }> {
  return requestPath(path, "POST", body);
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function startHealthServer(payload: object): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected fake sidecar server to listen on TCP");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function startRtcAsrServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ready", backend: "parakeet-mlx", model: "mlx-community/parakeet-tdt_ctc-110m", ready: true }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "ready",
        ready: true,
        backend: "parakeet-mlx",
        model: "mlx-community/parakeet-tdt_ctc-110m",
        models: [{ id: "mlx-community/parakeet-tdt_ctc-110m", loaded: true }],
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/transcribe") {
      let rawBody = "";
      for await (const chunk of request) rawBody += chunk.toString();
      const body = JSON.parse(rawBody) as { audio_data?: string; sample_rate?: number };
      response.writeHead(body.audio_data ? 200 : 400, { "content-type": "application/json" });
      response.end(JSON.stringify(body.audio_data
        ? { text: "rtc-asr live transcription", backend: "parakeet-mlx", model: "mlx-community/parakeet-tdt_ctc-110m", sample_rate: body.sample_rate }
        : { detail: "audio_data required" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected fake rtc-asr server to listen on TCP");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
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

test("GET /api/cluecon exposes first-slice readiness, scenario, and proof metadata", async () => {
  const response = await get("/api/cluecon");
  assert.equal(response.statusCode, 200);
  assert.match(response.contentType, /application\/json/);

  const payload = JSON.parse(response.body) as {
    ok: boolean;
    workboardCard: string;
    activeWorkboardCard: string;
    sourceRepos: { agenticContactCenter: string; rtcAsr: string };
    routes: { scrollable: string; present: string; scriptedDemo: string; operatorDrill: string; evalPreview: string; evalRun: string };
    readiness: Array<{ id: string; status: string; caveat: string; repoUrl?: string }>;
    liveProbes: Array<{ id: string; configured: boolean; status: string; ok: boolean; metadata: Record<string, unknown> }>;
    demoGoal: { issue: string; statement: string; chain: string[]; successSignal: string };
    callFlow: { issue: string; cadenceMs: number; credentialRequirement: string; stages: Array<{ id: string; label: string; packet: string }> };
    scenario: { callerTurns: string[]; failureDrills: string[] };
    asrPanel: {
      contract: string;
      modelsRoute: string;
      transcribeRoute: string;
      benchmarkUrl: string;
      streamStates: string[];
      fixtureEvents: Array<{ state: string }>;
      benchmarks: Array<{ label: string }>;
      benchmarkProfiles: Record<string, { firstPartial: string; finalization: string; rtf: string; detailUrl: string }>;
    };
    brainBlocks: Array<{ file: string; affects: string[] }>;
    brainPanel: { previewRoute: string; applyRoute: string; resetRoute: string; safeMutation: string; activeFiles: string[] };
    operatorCockpit: { workboardCard: string; drillRoute: string; modes: string[]; drillKinds: string[]; actions: string[] };
    proofPreview: { workboardCard: string; previewRoute: string; runRoute: string; compatibleRequest: string; includes: string[]; scorecardChecks: string[] };
  };

  assert.equal(payload.ok, true);
  assert.equal(payload.workboardCard, "85ea5a1a-3a68-4e5d-ac1d-10d5851017ae");
  assert.equal(payload.activeWorkboardCard, "6017890d-8f17-4ce0-aab9-d4cf3015d82c");
  assert.equal(payload.sourceRepos.agenticContactCenter, "https://github.com/agonza1/agentic-contact-center");
  assert.equal(payload.sourceRepos.rtcAsr, "https://github.com/agonza1/rtc-asr");
  assert.equal(payload.demoGoal.issue, "agonza1/agentic-contact-center#177");
  assert.deepEqual(payload.demoGoal.chain, ["sip", "pipecat", "rtc_asr", "openclaw_agent", "kokoro_tts", "conversation_agent_evals"]);
  assert.match(payload.demoGoal.successSignal, /scorecard passes/);
  assert.equal(payload.callFlow.issue, "agonza1/agentic-contact-center#217");
  assert.equal(payload.callFlow.cadenceMs, 1000);
  assert.equal(payload.callFlow.credentialRequirement, "none");
  assert.deepEqual(payload.callFlow.stages.map((stage) => stage.id), ["audio_in", "transport", "stt", "agent", "tts"]);
  assert.ok(payload.callFlow.stages.some((stage) => stage.label === "Caller audio in"));
  assert.ok(payload.callFlow.stages.some((stage) => stage.label === "Transport + codec normalize"));
  assert.ok(payload.callFlow.stages.some((stage) => stage.label === "Text → audio out"));
  assert.ok(payload.callFlow.stages.some((stage) => /PCM16/.test(stage.packet)));
  assert.equal(payload.routes.scrollable, "/cluecon");
  assert.equal(payload.routes.present, "/cluecon/present");
  assert.equal(payload.routes.scriptedDemo, "/api/demo/run-end-to-end");
  assert.equal(payload.routes.operatorDrill, "/api/cluecon/operator/drill");
  assert.equal(payload.routes.evalPreview, "/api/cluecon/eval/preview");
  assert.equal(payload.routes.evalRun, "/api/cluecon/eval/run");
  assert.ok(payload.readiness.some((item) => item.id === "pipecat" && item.status === "ready"));
  assert.ok(payload.readiness.some((item) => item.id === "acc" && item.repoUrl === "https://github.com/agonza1/agentic-contact-center"));
  assert.ok(payload.readiness.some((item) => item.id === "rtc_asr" && item.repoUrl === "https://github.com/agonza1/rtc-asr" && /Optional for this scripted presentation/.test(item.caveat)));
  assert.ok(payload.liveProbes.some((probe) => probe.id === "rtc_asr" && probe.configured === false && probe.status === "fixture"));
  assert.ok(payload.liveProbes.some((probe) => probe.id === "kokoro" && probe.configured === false && probe.status === "fixture"));
  assert.equal(payload.scenario.callerTurns.length, 4);
  assert.ok(payload.scenario.failureDrills.includes("tts_unavailable"));
  assert.equal(payload.asrPanel.contract, "PCM16 16 kHz mono in; transcript events out");
  assert.equal(payload.asrPanel.modelsRoute, "/api/cluecon/asr/models");
  assert.equal(payload.asrPanel.transcribeRoute, "/api/cluecon/asr/transcribe");
  assert.equal(payload.asrPanel.benchmarkUrl, "https://agonza1.github.io/rtc-asr/docs/");
  assert.ok(payload.asrPanel.streamStates.includes("partial"));
  assert.ok(payload.asrPanel.fixtureEvents.some((event) => event.state === "error"));
  assert.ok(payload.asrPanel.benchmarks.some((benchmark) => benchmark.label === "first partial"));
  assert.equal(payload.asrPanel.benchmarkProfiles["parakeet-mlx|mlx-community/parakeet-tdt_ctc-110m"].firstPartial, "250.7 ms");
  assert.equal(payload.asrPanel.benchmarkProfiles["parakeet-mlx|mlx-community/parakeet-tdt_ctc-110m"].finalization, "251.8 ms");
  assert.equal(payload.asrPanel.benchmarkProfiles["faster-whisper|base.en"].rtf, "0.066x");
  assert.ok(payload.brainBlocks.some((block) => block.file === "policy.md" && block.affects.includes("policy hold")));
  assert.equal(payload.brainPanel.previewRoute, "/api/cluecon/brain/preview");
  assert.equal(payload.brainPanel.applyRoute, "/api/cluecon/brain/apply");
  assert.equal(payload.brainPanel.resetRoute, "/api/cluecon/brain/reset");
  assert.equal(payload.brainPanel.safeMutation, "session_scoped_in_memory");
  assert.ok(payload.brainPanel.activeFiles.includes("policy.md"));
  assert.equal(payload.operatorCockpit.workboardCard, "3ea982b1-627a-4698-8b02-0c270b688237");
  assert.equal(payload.operatorCockpit.drillRoute, "/api/cluecon/operator/drill");
  assert.ok(payload.operatorCockpit.modes.includes("operator_click_simulation"));
  assert.ok(payload.operatorCockpit.drillKinds.includes("transfer"));
  assert.ok(payload.operatorCockpit.actions.includes("takeover"));
  assert.equal(payload.proofPreview.workboardCard, "6017890d-8f17-4ce0-aab9-d4cf3015d82c");
  assert.equal(payload.proofPreview.compatibleRequest, "conversation-agent-evals-assert-request.json");
  assert.equal(payload.proofPreview.previewRoute, "/api/cluecon/eval/preview");
  assert.equal(payload.proofPreview.runRoute, "/api/cluecon/eval/run");
  assert.ok(payload.proofPreview.includes.includes("ASR/TTS caveats"));
  assert.ok(payload.proofPreview.scorecardChecks.includes("operator_approval"));
});

test("GET /cluecon renders each transcript turn as a separate block", async () => {
  const response = await get("/cluecon");
  assert.equal(response.statusCode, 200);
  assert.match(response.contentType, /text\/html/);
  assert.match(response.body, /#demo \.screen\.has-transcript \{[^}]*display: grid;/);
  assert.match(response.body, /class="transcript-turn transcript-turn--/);
  assert.match(response.body, /renderDemoTranscript\(payload\.call\.transcript\)/);
});

test("POST /api/cluecon/brain preview, apply, and reset keep edits session-scoped", async () => {
  const initialResponse = await get("/api/cluecon");
  assert.equal(initialResponse.statusCode, 200);
  const initialPayload = JSON.parse(initialResponse.body) as {
    brainBlocks: Array<{ file: string; summary: string; affects: string[] }>;
  };
  const editedBlocks = initialPayload.brainBlocks.map((block) =>
    block.file === "policy.md"
      ? { ...block, summary: "Require explicit operator approval before any retention offer is quoted." }
      : block,
  );

  const previewResponse = await post("/api/cluecon/brain/preview", { blocks: editedBlocks });
  assert.equal(previewResponse.statusCode, 200);
  const preview = JSON.parse(previewResponse.body) as {
    ok: boolean;
    previewOnly: boolean;
    changedFiles: string[];
    evidence: { mutation: string; corruptsRuntime: boolean };
  };
  assert.equal(preview.ok, true);
  assert.equal(preview.previewOnly, true);
  assert.ok(preview.changedFiles.includes("policy.md"));
  assert.equal(preview.evidence.mutation, "preview_only");
  assert.equal(preview.evidence.corruptsRuntime, false);

  const applyResponse = await post("/api/cluecon/brain/apply", { blocks: editedBlocks });
  assert.equal(applyResponse.statusCode, 200);
  const applied = JSON.parse(applyResponse.body) as {
    ok: boolean;
    applied: boolean;
    mutation: string;
    corruptsRuntime: boolean;
    activeBrainBlocks: Array<{ file: string; summary: string }>;
    brainPanel: { activeFiles: string[] };
  };
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.mutation, "session_scoped_in_memory");
  assert.equal(applied.corruptsRuntime, false);
  assert.ok(applied.brainPanel.activeFiles.includes("policy.md"));
  assert.equal(
    applied.activeBrainBlocks.find((block) => block.file === "policy.md")?.summary,
    "Require explicit operator approval before any retention offer is quoted.",
  );

  const resetResponse = await post("/api/cluecon/brain/reset");
  assert.equal(resetResponse.statusCode, 200);
  const reset = JSON.parse(resetResponse.body) as {
    ok: boolean;
    reset: boolean;
    activeBrainBlocks: Array<{ file: string; summary: string }>;
  };
  assert.equal(reset.ok, true);
  assert.equal(reset.reset, true);
  assert.equal(
    reset.activeBrainBlocks.find((block) => block.file === "policy.md")?.summary,
    "Pause before risky offers, require operator approval, and fail closed on runtime uncertainty.",
  );
});

test("POST /api/cluecon/brain/apply rejects unsafe missing policy blocks", async () => {
  const response = await post("/api/cluecon/brain/apply", {
    blocks: [{ file: "mission.md", summary: "Too little evidence control.", affects: ["agent response"] }],
  });
  assert.equal(response.statusCode, 400);
  const payload = JSON.parse(response.body) as { ok: boolean; errors: string[]; corruptsRuntime: boolean };
  assert.equal(payload.ok, false);
  assert.ok(payload.errors.includes("policy.md block is required for the ClueCon agent panel"));
  assert.equal(payload.corruptsRuntime, false);
});

test("POST /api/cluecon/operator/drill runs fail-closed and operator action drills", async () => {
  const fallbackResponse = await post("/api/cluecon/operator/drill", { kind: "runtime_failure" });
  assert.equal(fallbackResponse.statusCode, 201);
  const fallback = JSON.parse(fallbackResponse.body) as {
    ok: boolean;
    workboardCard: string;
    kind: string;
    outcome: string;
    summary: string;
    simulatedEvents: string[];
    call: { flowState: string; demoFallback: { mode: string | null; reason: string | null }; session: { openclawSession: { label: string } } };
    proofLinks: { proof: string; operatorConsole: string };
  };
  assert.equal(fallback.ok, true);
  assert.equal(fallback.workboardCard, "3ea982b1-627a-4698-8b02-0c270b688237");
  assert.equal(fallback.kind, "runtime_failure");
  assert.equal(fallback.outcome, "fail_closed_handoff");
  assert.match(fallback.summary, /fail-closed human handoff/);
  assert.ok(fallback.simulatedEvents.includes("call_error_fail_closed"));
  assert.equal(fallback.call.demoFallback.mode, "runtime_failure");
  assert.match(fallback.call.demoFallback.reason ?? "", /runtime_failure ClueCon operator drill/);
  assert.match(fallback.proofLinks.proof, /\/api\/calls\/demo-call-\d+\/proof/);
  assert.match(fallback.proofLinks.operatorConsole, /openclawSessionLabel=cluecon%2Foperator-runtime_failure/);

  const transferResponse = await post("/api/cluecon/operator/drill", { kind: "transfer" });
  assert.equal(transferResponse.statusCode, 201);
  const transfer = JSON.parse(transferResponse.body) as {
    outcome: string;
    call: { flowState: string; operatorSteer: { lastAction: string | null }; events: Array<{ type: string }> };
  };
  assert.equal(transfer.outcome, "operator_transfer");
  assert.equal(transfer.call.flowState, "wrap");
  assert.equal(transfer.call.operatorSteer.lastAction, "transfer");
  assert.ok(transfer.call.events.some((event) => event.type === "operator_transfer_started"));
});

test("POST /api/cluecon/operator/drill rejects unknown drill kinds", async () => {
  const response = await post("/api/cluecon/operator/drill", { kind: "magic_success" });
  assert.equal(response.statusCode, 400);
  const payload = JSON.parse(response.body) as { ok: boolean; error: string };
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "cluecon_operator_drill_kind_invalid");
});

test("GET /api/cluecon upgrades readiness when live sidecar health probes pass", async () => {
  const rtcAsr = await startHealthServer({
    ok: true,
    status: "ready",
    backend: "faster-whisper",
    model: "base.en",
  });
  const kokoro = await startHealthServer({
    ok: true,
    status: "ready",
    service: "kokoro",
    voices: ["af_heart"],
  });

  try {
    await withEnv(
      {
        RTC_ASR_BASE_URL: rtcAsr.baseUrl,
        KOKORO_BASE_URL: kokoro.baseUrl,
        PIPECAT_VOICE_WS_URL: "ws://127.0.0.1:8765",
      },
      async () => {
        const response = await get("/api/cluecon");
        assert.equal(response.statusCode, 200);

        const payload = JSON.parse(response.body) as {
          readiness: Array<{ id: string; status: string; caveat: string }>;
          liveProbes: Array<{ id: string; configured: boolean; status: string; ok: boolean; metadata: Record<string, unknown> }>;
          asrPanel: { status: string; liveProbe: { ok: boolean; metadata: Record<string, unknown> } };
        };

        assert.ok(payload.readiness.some((item) => item.id === "rtc_asr" && item.status === "ready"));
        assert.ok(payload.readiness.some((item) => item.id === "kokoro" && item.status === "ready"));
        assert.ok(payload.readiness.some((item) => item.id === "pipecat" && item.status === "configured"));
        assert.ok(payload.liveProbes.some((probe) => probe.id === "rtc_asr" && probe.configured && probe.ok && probe.metadata.backend === "faster-whisper"));
        assert.ok(payload.liveProbes.some((probe) => probe.id === "kokoro" && probe.configured && probe.ok && probe.metadata.service === "kokoro"));
        assert.equal(payload.asrPanel.status, "live_ready");
        assert.equal(payload.asrPanel.liveProbe.ok, true);
      },
    );
  } finally {
    await closeServer(rtcAsr.server);
    await closeServer(kokoro.server);
  }
});

test("ClueCon ASR routes discover warmed models and proxy live transcription", async () => {
  const rtcAsr = await startRtcAsrServer();
  try {
    await withEnv({ RTC_ASR_BASE_URL: rtcAsr.baseUrl }, async () => {
      const modelsResponse = await get("/api/cluecon/asr/models");
      assert.equal(modelsResponse.statusCode, 200);
      const models = JSON.parse(modelsResponse.body) as {
        ok: boolean;
        activeTargetId: string;
        benchmarkUrl: string;
        models: Array<{ targetId: string; targetLabel: string; websocketUrl: string; backend: string; model: string; status: string; ready: boolean; loaded: boolean; responseMs: number; error: string | null }>;
      };
      assert.equal(models.ok, true);
      assert.equal(models.activeTargetId, "primary");
      assert.equal(models.benchmarkUrl, "https://agonza1.github.io/rtc-asr/docs/");
      assert.equal(models.models[0].targetId, "primary");
      assert.equal(models.models[0].targetLabel, "Active local model");
      assert.equal(models.models[0].websocketUrl, `${rtcAsr.baseUrl.replace("http:", "ws:")}/v1/stt/stream`);
      assert.equal(models.models[0].backend, "parakeet-mlx");
      assert.equal(models.models[0].model, "mlx-community/parakeet-tdt_ctc-110m");
      assert.equal(models.models[0].status, "ready");
      assert.equal(models.models[0].ready, true);
      assert.equal(models.models[0].loaded, true);
      assert.equal(typeof models.models[0].responseMs, "number");
      assert.equal(models.models[0].error, null);

      const transcriptionResponse = await post("/api/cluecon/asr/transcribe", {
        targetId: "primary",
        audioData: "UklGRg==",
        sampleRate: 16000,
        language: "en",
      });
      assert.equal(transcriptionResponse.statusCode, 200);
      const transcription = JSON.parse(transcriptionResponse.body) as {
        ok: boolean;
        targetId: string;
        transcription: { text: string; backend: string; sample_rate: number };
      };
      assert.equal(transcription.ok, true);
      assert.equal(transcription.targetId, "primary");
      assert.equal(transcription.transcription.text, "rtc-asr live transcription");
      assert.equal(transcription.transcription.backend, "parakeet-mlx");
      assert.equal(transcription.transcription.sample_rate, 16000);
    });
  } finally {
    await closeServer(rtcAsr.server);
  }
});

test("ClueCon ASR routes fail clearly when rtc-asr is not configured", async () => {
  await withEnv({ RTC_ASR_BASE_URL: undefined, RTC_ASR_MODEL_ENDPOINTS: undefined }, async () => {
    const models = await get("/api/cluecon/asr/models");
    assert.equal(models.statusCode, 503);
    assert.match(models.body, /rtc_asr_not_configured/);

    const transcription = await post("/api/cluecon/asr/transcribe", {
      audioData: "UklGRg==",
      sampleRate: 16000,
    });
    assert.equal(transcription.statusCode, 503);
    assert.match(transcription.body, /rtc_asr_not_configured/);
  });
});


test("GET/POST /api/cluecon/eval expose ASSERT handoff preview and scorecard", async () => {
  const previewResponse = await get("/api/cluecon/eval/preview");
  assert.equal(previewResponse.statusCode, 200);
  const preview = JSON.parse(previewResponse.body) as {
    ok: boolean;
    workboardCard: string;
    mode: string;
    compatibleRequest: string;
    runRoute: string;
    scorecardChecks: string[];
    evidenceArtifacts: string[];
  };
  assert.equal(preview.ok, true);
  assert.equal(preview.workboardCard, "6017890d-8f17-4ce0-aab9-d4cf3015d82c");
  assert.equal(preview.mode, "non_mutating_preview");
  assert.equal(preview.compatibleRequest, "conversation-agent-evals-assert-request.json");
  assert.equal(preview.runRoute, "/api/cluecon/eval/run");
  assert.ok(preview.scorecardChecks.includes("policy_hold"));
  assert.ok(preview.evidenceArtifacts.includes("action_trace"));

  const runResponse = await post("/api/cluecon/eval/run");
  assert.equal(runResponse.statusCode, 201);
  const run = JSON.parse(runResponse.body) as {
    ok: boolean;
    workboardCard: string;
    compatibleRequest: string;
    scorecard: { overallPassed: boolean; passed: number; total: number; checks: Array<{ id: string; passed: boolean; evidence: string }> };
    assertRequestPreview: { spec_ref: { assert_project: string }; evidence: { transcript: { readiness: string }; proof_bundle: { routes: { transcript: string } } }; metadata: { compatible_file: string } };
    proofLinks: { proof: string; operatorConsole: string };
  };
  assert.equal(run.ok, true);
  assert.equal(run.workboardCard, "6017890d-8f17-4ce0-aab9-d4cf3015d82c");
  assert.equal(run.compatibleRequest, "conversation-agent-evals-assert-request.json");
  assert.equal(run.scorecard.overallPassed, true);
  assert.equal(run.scorecard.passed, run.scorecard.total);
  assert.ok(run.scorecard.checks.some((check) => check.id === "operator_approval" && check.passed));
  assert.equal(run.assertRequestPreview.spec_ref.assert_project, "conversation-agent-evals");
  assert.equal(run.assertRequestPreview.evidence.transcript.readiness, "inline_preview");
  assert.match(run.assertRequestPreview.evidence.proof_bundle.routes.transcript, /\/api\/calls\/demo-call-\d+\/transcript/);
  assert.equal(run.assertRequestPreview.metadata.compatible_file, "conversation-agent-evals-assert-request.json");
  assert.match(run.proofLinks.proof, /\/api\/calls\/demo-call-\d+\/proof/);
  assert.match(run.proofLinks.operatorConsole, /\/api\/operator\/console\?callId=demo-call-\d+/);
});

test("GET /cluecon and /cluecon/present render the interactive presentation shells", async () => {
  const narrative = await get("/cluecon");
  assert.equal(narrative.statusCode, 200);
  assert.match(narrative.contentType, /text\/html/);
  assert.match(narrative.body, /From SIP to Tokens/);
  assert.match(narrative.body, /ClueCon 2026 presentation/);
  assert.doesNotMatch(narrative.body, /ClueCon vertical slice/i);
  assert.match(narrative.body, /Alberto Gonzalez CTO @ WebRTC\.ventures/);
  assert.match(narrative.body, /Realtime call flow visualization/);
  assert.match(narrative.body, /Caller audio in/);
  assert.match(narrative.body, /Telephony SIP/);
  assert.match(narrative.body, /Browser WebRTC/);
  assert.match(narrative.body, /Transport \+ codec normalize/);
  assert.match(narrative.body, /Audio → text \/ tokens/);
  assert.match(narrative.body, /Text → audio out/);
  assert.match(narrative.body, /voice-pipeline/);
  assert.match(narrative.body, /xform-carrier/);
  assert.match(narrative.body, /media-wave/);
  assert.match(narrative.body, /media-tokens/);
  assert.match(narrative.body, /Run scripted demo/);
  assert.match(narrative.body, /Run scripted proof/);
  assert.match(narrative.body, /Run eval proof/);
  assert.match(narrative.body, /window\.__CLUECON__/);
  assert.match(narrative.body, /rtc-asr is measurable and swappable/);
  assert.match(narrative.body, /Microphone → Local STT v1 → live transcript/);
  assert.match(narrative.body, /id="asr-model-select"/);
  assert.match(narrative.body, /id="asr-realtime"/);
  assert.match(narrative.body, /Start realtime/);
  assert.match(narrative.body, /local-stt\.v1/);
  assert.match(narrative.body, /handleAsrRealtimeMessage/);
  assert.match(narrative.body, /id="asr-record"/);
  assert.match(narrative.body, /Pipecat demo source/);
  assert.match(narrative.body, /rtc-asr\/tree\/main\/examples\/browser_pipecat_demo/);
  assert.match(narrative.body, /Open benchmark site/);
  assert.match(narrative.body, /https:\/\/agonza1\.github\.io\/rtc-asr\/docs\//);
  assert.match(narrative.body, /renderAsrBenchmarks\(model\)/);
  assert.match(narrative.body, /250\.7 ms/);
  assert.match(narrative.body, /676\.5 ms/);
  assert.match(narrative.body, /0\.021x/);
  assert.match(narrative.body, /0\.066x/);
  assert.match(narrative.body, /https:\/\/github\.com\/agonza1\/rtc-asr/);
  assert.match(narrative.body, /renderAsrPanel/);
  assert.match(narrative.body, /runEvalProof/);
  assert.match(narrative.body, /goToSlide/);
  assert.match(narrative.body, /@media \(max-width: 1100px\) \{ #demo \.two/);
  assert.match(narrative.body, /\.present #demo \{ height: calc\(100vh - 62px\)/);
  assert.match(narrative.body, /\.present \.topbar \{ position: static/);
  assert.match(narrative.body, /#demo \.actions \{ display: grid/);
  assert.match(narrative.body, /#demo \.event strong, #demo \.event \.muted \{ overflow-wrap: anywhere/);
  assert.match(narrative.body, /class="transcript-turn transcript-turn--/);
  assert.match(narrative.body, /renderDemoTranscript\(payload\.call\.transcript\)/);
  assert.match(narrative.body, /class="scroll"/);
  assert.match(narrative.body, /RTF \(Real-Time Factor\) = processing time ÷ audio duration/);

  const present = await get("/cluecon/present");
  assert.equal(present.statusCode, 200);
  assert.match(present.body, /class="present"/);
  assert.match(present.body, /From SIP to tokens/);
  assert.match(present.body, /Alberto Gonzalez CTO @ WebRTC\.ventures/);
  assert.match(present.body, /ArrowRight/);
  assert.match(present.body, /Run eval proof/);
  assert.match(present.body, /eval-scorecard/);
  assert.match(present.body, /ClueCon 2026 presentation/);
  assert.match(present.body, /RTF \(Real-Time Factor\) = processing time ÷ audio duration/);
});

test("ClueCon static export renders GitHub Pages artifact", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("node", ["scripts/cluecon-pages-export.mjs"]);

  const indexPath = "site/cluecon-pages/index.html";
  const presentPath = "site/cluecon-pages/present/index.html";
  const fallbackPath = "site/cluecon-pages/404.html";
  assert.equal(existsSync(indexPath), true);
  assert.equal(existsSync(presentPath), true);
  assert.equal(existsSync(fallbackPath), true);

  const html = readFileSync(indexPath, "utf8");
  assert.match(html, /Agentic Contact Center/);
  assert.match(html, /Static GitHub Pages snapshot/);
  assert.match(html, /window\.__CLUECON__/);
  assert.match(html, /href="\.\/present\/"/);
  assert.doesNotMatch(html, /href="\/cluecon"/);

  const presentHtml = readFileSync(presentPath, "utf8");
  assert.match(presentHtml, /href="\.\/"/);
  assert.match(presentHtml, /href="\.\.\/"/);
  assert.doesNotMatch(presentHtml, /href="\.\/present\/"/);

  const fallbackHtml = readFileSync(fallbackPath, "utf8");
  assert.match(fallbackHtml, /Static GitHub Pages snapshot/);
});
