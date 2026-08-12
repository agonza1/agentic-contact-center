import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";

import { loadPocConfig } from "../src/config/loadPocConfig";
import { buildHttpServer, getRtcAsrUpstreamStreamPath, warmConfiguredKokoro } from "../src/http/createServer";

async function requestPath(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ statusCode: number; body: string; contentType: string; headers: Record<string, string | string[] | undefined> }> {
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
            headers: response.headers,
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

async function get(path: string): Promise<{ statusCode: number; body: string; contentType: string; headers: Record<string, string | string[] | undefined> }> {
  return requestPath(path);
}

async function post(path: string, body?: unknown): Promise<{ statusCode: number; body: string; contentType: string; headers: Record<string, string | string[] | undefined> }> {
  return requestPath(path, "POST", body);
}

function extractIntegrationSection(html: string): string {
  const match = html.match(/<section class="section-band slide" data-slide="5" id="integration">[\s\S]*?<\/section>/);
  assert.ok(match, "expected the shared ClueCon integration section");
  return match[0];
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

async function startKokoroServer(
  chunks: Array<{ delayMs: number; value: string }> = [{ delayMs: 5, value: "audio" }],
): Promise<{
  server: Server;
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, status: "ready", service: "kokoro", voices: ["af_heart"] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/audio/speech") {
      let rawBody = "";
      for await (const chunk of request) rawBody += chunk.toString();
      requests.push(JSON.parse(rawBody) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "audio/mpeg" });
      response.write("ID3");
      for (const chunk of chunks) {
        await new Promise<void>((resolve) => setTimeout(resolve, chunk.delayMs));
        response.write(chunk.value);
      }
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected fake Kokoro server to listen on TCP");
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function startPocketTtsServer(
  chunks: Array<{ delayMs: number; value: string }> = [{ delayMs: 5, value: "audio" }],
): Promise<{
  server: Server;
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, status: "ready", service: "pocket", voices: ["alloy"] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/audio/speech") {
      let rawBody = "";
      for await (const chunk of request) rawBody += chunk.toString();
      requests.push(JSON.parse(rawBody) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "audio/mpeg" });
      response.write("ID3");
      for (const chunk of chunks) {
        await new Promise<void>((resolve) => setTimeout(resolve, chunk.delayMs));
        response.write(chunk.value);
      }
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected fake Pocket TTS server to listen on TCP");
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, requests };
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
    sourceRepos: {
      agenticContactCenter: string;
      rtcAsr: string;
      conversationAgentEvals: string;
      assert: string;
      realtimeVoiceAiGuardrails: string;
    };
    routes: { scrollable: string; present: string; scriptedDemo: string; ttsSynthesize: string; operatorDrill: string; evalPreview: string; evalRun: string };
    readiness: Array<{ id: string; status: string; caveat: string; repoUrl?: string }>;
    liveProbes: Array<{ id: string; configured: boolean; status: string; ok: boolean; metadata: Record<string, unknown> }>;
    architectureCenter: { issue: string; target: string; adapterRule: string; currentGaps: string[] };
    demoGoal: { issue: string; statement: string; chain: string[]; successSignal: string };
    turnTiming: { speechStartHoldMs: number; acousticStopHoldMs: number; endOfTurnSilenceMs: number; outputStartAfterEndOfTurnMs: number; rule: string };
    callFlow: { issue: string; cadenceMs: number; credentialRequirement: string; stages: Array<{ id: string; label: string; detail: string; packet: string }> };
    scenario: { callerTurns: string[]; failureDrills: string[] };
    asrPanel: {
      contract: string;
      modelsRoute: string;
      transcribeRoute: string;
      benchmarkUrl: string;
      streamStates: string[];
      fixtureEvents: Array<{ state: string }>;
      benchmarks: Array<{ label: string }>;
      benchmarkProfiles: Record<string, { firstPartial: string; finalization: string; rtf: string; referenceWer: string; detailUrl: string }>;
      noiseGuidance: { sourceUrl: string; findings: string[]; caveat: string };
    };
    ttsPanel: {
      provider: string;
      engine: string;
      model: string;
      voice: string;
      defaultProvider: string;
      providers: Array<{ id: string; label: string; voice: string; status: string; setup: string }>;
      synthesizeRoute: string;
      status: string;
      candidates: Array<{ name: string; latency: string; sourceLabel: string; sourceUrl: string }>;
      comparisonCaveat: string;
      harness: { sourceUrl: string; latency: string };
      pipecatStreaming: { enabled: boolean; provider: string; preservesAgentBrain: boolean; sttContract: string; outputContract: string; requiredEnv: string[] };
    };
    brainBlocks: Array<{ file: string; affects: string[] }>;
    brainPanel: { previewRoute: string; applyRoute: string; resetRoute: string; safeMutation: string; activeFiles: string[] };
    securityPanel: { articleUrl: string; referenceRepoUrl: string; trustBoundary: string; controls: string[]; scenarios: Array<{ id: string; action: string; llmInput: string | null }> };
    operatorCockpit: {
      workboardCard: string;
      drillRoute: string;
      modes: string[];
      drillKinds: string[];
      actions: string[];
      telephonyControlBoundary: { command: string; adapters: string[]; standardPatterns: string[]; responsibility: string };
    };
    proofPreview: { workboardCard: string; previewRoute: string; runRoute: string; compatibleRequest: string; includes: string[]; scorecardChecks: string[] };
    caePanel: { webBaseUrl: string; scenariosPath: string; runsPath: string; repoUrl: string; relationship: string };
    contactPanel: { name: string; role: string; email: string; linkedinUrl: string; websiteUrl: string; logoUrl: string };
  };

  assert.equal(payload.ok, true);
  assert.equal(payload.workboardCard, "85ea5a1a-3a68-4e5d-ac1d-10d5851017ae");
  assert.equal(payload.activeWorkboardCard, "6017890d-8f17-4ce0-aab9-d4cf3015d82c");
  assert.equal(payload.sourceRepos.agenticContactCenter, "https://github.com/agonza1/agentic-contact-center");
  assert.equal(payload.sourceRepos.rtcAsr, "https://github.com/agonza1/rtc-asr");
  assert.equal(payload.sourceRepos.conversationAgentEvals, "https://github.com/agonza1/ConversationAgentEvals");
  assert.equal(payload.sourceRepos.assert, "https://github.com/responsibleai/ASSERT");
  assert.equal(payload.sourceRepos.realtimeVoiceAiGuardrails, "https://github.com/WebRTCventures/realtime-voice-ai-guardrails");
  assert.equal(payload.architectureCenter.issue, "agonza1/agentic-contact-center#307");
  assert.match(payload.architectureCenter.target, /transport\.input -> rtc-asr STT/);
  assert.match(payload.architectureCenter.adapterRule, /FreeSWITCH owns the SIP\/RTP boundary/);
  assert.ok(payload.architectureCenter.currentGaps.some((gap) => /reliability-lab profile/.test(gap)));
  assert.ok(payload.architectureCenter.currentGaps.some((gap) => /strict local SIP\/Verto proof is accepted/.test(gap)));
  assert.equal(payload.demoGoal.issue, "agonza1/agentic-contact-center#307");
  assert.deepEqual(payload.demoGoal.chain, ["caller", "freeswitch", "pipecat_pipeline", "rtc_asr", "acc_policy_tools", "kokoro_tts", "evidence"]);
  assert.match(payload.demoGoal.successSignal, /Phase 2 reliability-lab blockers/);
  assert.equal(payload.turnTiming.speechStartHoldMs, 80);
  assert.equal(payload.turnTiming.acousticStopHoldMs, 350);
  assert.equal(payload.turnTiming.endOfTurnSilenceMs, 2000);
  assert.equal(payload.turnTiming.outputStartAfterEndOfTurnMs, 0);
  assert.match(payload.turnTiming.rule, /acoustic stop is only an end-of-turn candidate/);
  assert.equal(payload.callFlow.issue, "agonza1/agentic-contact-center#217");
  assert.equal(payload.callFlow.cadenceMs, 1000);
  assert.equal(payload.callFlow.credentialRequirement, "local");
  assert.deepEqual(payload.callFlow.stages.map((stage) => stage.id), ["audio_in", "transport", "stt", "agent", "tts"]);
  assert.ok(payload.callFlow.stages.some((stage) => stage.label === "Caller → SIP/RTP"));
  assert.ok(payload.callFlow.stages.some((stage) => stage.label === "FreeSWITCH boundary"));
  assert.ok(payload.callFlow.stages.some((stage) => stage.label === "Speech → caller"));
  assert.ok(payload.callFlow.stages.some((stage) => /PCM16/.test(stage.packet)));
  assert.ok(payload.callFlow.stages.some((stage) => /SIP dialog/.test(stage.detail)));
  assert.ok(payload.callFlow.stages.some((stage) => /media clock/.test(stage.detail)));
  assert.equal(payload.routes.scrollable, "/cluecon");
  assert.equal(payload.routes.present, "/cluecon/present");
  assert.equal(payload.routes.scriptedDemo, "/api/demo/run-end-to-end");
  assert.equal(payload.routes.ttsSynthesize, "/api/cluecon/tts/synthesize");
  assert.equal(payload.routes.operatorDrill, "/api/cluecon/operator/drill");
  assert.equal(payload.routes.evalPreview, "/api/cluecon/eval/preview");
  assert.equal(payload.routes.evalRun, "/api/cluecon/eval/run");
  assert.ok(payload.readiness.some((item) => item.id === "pipecat" && item.status === "ready"));
  assert.ok(payload.readiness.some((item) => item.id === "acc" && item.repoUrl === "https://github.com/agonza1/agentic-contact-center"));
  assert.ok(payload.readiness.some((item) => item.id === "rtc_asr" && item.repoUrl === "https://github.com/agonza1/rtc-asr" && /Optional for this scripted presentation/.test(item.caveat)));
  assert.ok(payload.liveProbes.some((probe) => probe.id === "rtc_asr" && probe.configured === false && probe.status === "fixture"));
  assert.ok(payload.liveProbes.some((probe) => probe.id === "kokoro" && probe.configured === false && probe.status === "fixture"));
  assert.ok(payload.liveProbes.some((probe) => probe.id === "pocket_tts" && probe.configured === false && probe.status === "fixture"));
  assert.equal(payload.scenario.callerTurns.length, 3);
  assert.ok(payload.scenario.failureDrills.includes("tts_unavailable"));
  assert.equal(payload.asrPanel.contract, "PCM16 16 kHz mono in; transcript events out");
  assert.equal(payload.asrPanel.modelsRoute, "/api/cluecon/asr/models");
  assert.equal(payload.asrPanel.transcribeRoute, "/api/cluecon/asr/transcribe");
  assert.equal(payload.asrPanel.benchmarkUrl, "https://agonza1.github.io/rtc-asr/docs/");
  assert.ok(payload.asrPanel.streamStates.includes("partial"));
  assert.ok(payload.asrPanel.fixtureEvents.some((event) => event.state === "error"));
  assert.ok(payload.asrPanel.benchmarks.some((benchmark) => benchmark.label === "first partial"));
  assert.ok(payload.asrPanel.benchmarks.some((benchmark) => benchmark.label === "Reference WER"));
  assert.equal(payload.asrPanel.benchmarkProfiles["parakeet-mlx|mlx-community/parakeet-tdt_ctc-110m"].firstPartial, "250.7 ms");
  assert.equal(payload.asrPanel.benchmarkProfiles["parakeet-mlx|mlx-community/parakeet-tdt_ctc-110m"].finalization, "251.8 ms");
  assert.equal(payload.asrPanel.benchmarkProfiles["parakeet-mlx|mlx-community/parakeet-tdt_ctc-110m"].referenceWer, "2.4% / 5.2%");
  assert.equal(payload.asrPanel.benchmarkProfiles["faster-whisper|base.en"].rtf, "0.066x");
  assert.equal(payload.asrPanel.benchmarkProfiles["faster-whisper|base.en"].referenceWer, "4.25% / 10.35%");
  assert.equal(payload.asrPanel.noiseGuidance.sourceUrl, "https://agonza1.github.io/rtc-asr/docs/");
  assert.ok(payload.asrPanel.noiseGuidance.findings.some((finding) => /false interruptions/.test(finding)));
  assert.match(payload.asrPanel.noiseGuidance.caveat, /complete turn/);
  assert.doesNotMatch(JSON.stringify(payload.asrPanel.noiseGuidance), /Twilio|Flux passed/);
  assert.equal(payload.ttsPanel.provider, "Kokoro-82M");
  assert.equal(payload.ttsPanel.engine, "kokoro");
  assert.equal(payload.ttsPanel.defaultProvider, "kokoro");
  assert.deepEqual(payload.ttsPanel.providers.map((provider) => provider.id), ["kokoro", "pocket"]);
  assert.equal(payload.ttsPanel.providers.find((provider) => provider.id === "pocket")?.voice, "alloy");
  assert.match(payload.ttsPanel.providers.find((provider) => provider.id === "pocket")?.setup ?? "", /OpenAI-compatible/);
  assert.equal(payload.ttsPanel.synthesizeRoute, "/api/cluecon/tts/synthesize");
  assert.equal(payload.ttsPanel.pipecatStreaming.enabled, false);
  assert.equal(payload.ttsPanel.pipecatStreaming.preservesAgentBrain, true);
  assert.match(payload.ttsPanel.pipecatStreaming.sttContract, /rtc-asr/);
  assert.match(payload.ttsPanel.pipecatStreaming.outputContract, /TTSAudioRawFrame/);
  assert.deepEqual(payload.ttsPanel.candidates.map((candidate) => candidate.name), ["Kokoro 82M", "Pocket TTS", "VoXtream2", "Qwen3-TTS 0.6B"]);
  assert.deepEqual(payload.ttsPanel.candidates.map((candidate) => candidate.latency), ["~300 ms first chunk", "~200 ms first chunk", "63 ms first packet", "97 ms first packet"]);
  assert.ok(payload.ttsPanel.candidates.every((candidate) => candidate.sourceLabel && /^https:/.test(candidate.sourceUrl)));
  assert.match(payload.ttsPanel.comparisonCaveat, /not a universal ranking/);
  assert.ok(payload.brainBlocks.some((block) => block.file === "policy.md" && block.affects.includes("policy hold")));
  assert.equal(payload.brainPanel.previewRoute, "/api/cluecon/brain/preview");
  assert.equal(payload.brainPanel.applyRoute, "/api/cluecon/brain/apply");
  assert.equal(payload.brainPanel.resetRoute, "/api/cluecon/brain/reset");
  assert.equal(payload.brainPanel.safeMutation, "session_scoped_in_memory");
  assert.ok(payload.brainPanel.activeFiles.includes("policy.md"));
  assert.match(payload.securityPanel.trustBoundary, /Minimize sensitive data crossing the LLM boundary/);
  assert.equal(payload.securityPanel.scenarios.find((scenario) => scenario.id === "pii")?.action, "redact");
  assert.equal(payload.securityPanel.scenarios.find((scenario) => scenario.id === "pci")?.llmInput, null);
  assert.match(payload.securityPanel.referenceRepoUrl, /realtime-voice-ai-guardrails/);
  assert.equal(payload.operatorCockpit.workboardCard, "3ea982b1-627a-4698-8b02-0c270b688237");
  assert.equal(payload.operatorCockpit.drillRoute, "/api/cluecon/operator/drill");
  assert.ok(payload.operatorCockpit.modes.includes("operator_click_simulation"));
  assert.ok(payload.operatorCockpit.drillKinds.includes("transfer"));
  assert.ok(payload.operatorCockpit.actions.includes("takeover"));
  assert.ok(payload.operatorCockpit.drillKinds.includes("rtc_asr_unavailable"));
  assert.ok(payload.operatorCockpit.drillKinds.includes("tts_unavailable"));
  assert.equal(payload.operatorCockpit.telephonyControlBoundary.command, "structured JSON from ACC");
  assert.ok(payload.operatorCockpit.telephonyControlBoundary.adapters.includes("FreeSWITCH mod_event_socket / ESL"));
  assert.ok(payload.operatorCockpit.telephonyControlBoundary.standardPatterns.includes("ESL uuid_transfer → dialplan / mod_callcenter"));
  assert.ok(payload.operatorCockpit.telephonyControlBoundary.standardPatterns.includes("ESL bgapi originate + uuid_bridge"));
  assert.ok(payload.operatorCockpit.telephonyControlBoundary.standardPatterns.includes("SIP REFER via deflect"));
  assert.equal(payload.proofPreview.workboardCard, "6017890d-8f17-4ce0-aab9-d4cf3015d82c");
  assert.equal(payload.proofPreview.compatibleRequest, "conversation-agent-evals-assert-request.json");
  assert.equal(payload.proofPreview.previewRoute, "/api/cluecon/eval/preview");
  assert.equal(payload.proofPreview.runRoute, "/api/cluecon/eval/run");
  assert.ok(payload.proofPreview.includes.includes("ASR/TTS caveats"));
  assert.ok(payload.proofPreview.scorecardChecks.includes("operator_approval"));
  assert.equal(payload.caePanel.webBaseUrl, "http://127.0.0.1:3012");
  assert.equal(payload.caePanel.scenariosPath, "/scenarios");
  assert.equal(payload.caePanel.runsPath, "/runs");
  assert.match(payload.caePanel.relationship, /ACC runs the local scorecard/);
  assert.equal(payload.contactPanel.email, "alberto@webrtc.ventures");
  assert.equal(payload.contactPanel.linkedinUrl, "https://www.linkedin.com/in/albertogonzaleztrastoy/");
  assert.match(payload.contactPanel.logoUrl, /logo-main-light\.svg/);
});

test("GET /cluecon keeps the detailed transcript behind expandable evidence", async () => {
  const response = await get("/cluecon");
  assert.equal(response.statusCode, 200);
  assert.match(response.contentType, /text\/html/);
  assert.match(response.body, /class="demo-evidence" id="demo-evidence"/);
  assert.match(response.body, /id="demo-transcript-detail"/);
  assert.match(response.body, /class="transcript-turn transcript-turn--/);
  assert.match(response.body, /renderDemoTranscript\(payload\.call\.transcript\)/);
  assert.match(response.body, /const VAD_END_OF_TURN_MS = Number\(data\.turnTiming\?\.endOfTurnSilenceMs\) \|\| 2000;/);
});

test("GET /cluecon/system-unavailable.mp3 serves the prerecorded failover prompt", async () => {
  const response = await get("/cluecon/system-unavailable.mp3");
  assert.equal(response.statusCode, 200);
  assert.match(response.contentType, /audio\/mpeg/);
  assert.ok(response.body.length > 1_000);
});

test("GET /cluecon/alberto-echo-show-prototype.jpg serves the personal-story photograph", async () => {
  const response = await get("/cluecon/alberto-echo-show-prototype.jpg");
  assert.equal(response.statusCode, 200);
  assert.match(response.contentType, /image\/jpeg/);
  assert.ok(response.body.length > 100_000);
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
    completedControlStages: string[];
    call: { flowState: string; demoFallback: { mode: string | null; reason: string | null }; session: { openclawSession: { label: string } } };
    proofLinks: { proof: string; operatorConsole: string };
  };
  assert.equal(fallback.ok, true);
  assert.equal(fallback.workboardCard, "3ea982b1-627a-4698-8b02-0c270b688237");
  assert.equal(fallback.kind, "runtime_failure");
  assert.equal(fallback.outcome, "fail_closed_handoff");
  assert.deepEqual(fallback.completedControlStages, ["understand", "prepare"]);
  assert.match(fallback.summary, /fail-closed human handoff/);
  assert.ok(fallback.simulatedEvents.includes("call_error_fail_closed"));
  assert.equal(fallback.call.demoFallback.mode, "runtime_failure");
  assert.match(fallback.call.demoFallback.reason ?? "", /runtime_failure ClueCon operator drill/);
  assert.match(fallback.proofLinks.proof, /\/api\/calls\/demo-call-\d+\/proof/);
  assert.match(fallback.proofLinks.operatorConsole, /openclawSessionLabel=cluecon%2Foperator-runtime_failure/);

  const mediaFailureResponse = await post("/api/cluecon/operator/drill", { kind: "rtc_asr_unavailable" });
  assert.equal(mediaFailureResponse.statusCode, 201);
  const mediaFailure = JSON.parse(mediaFailureResponse.body) as {
    outcome: string;
    summary: string;
    simulatedEvents: string[];
    integration: {
      controlSequence: Array<{ type: string; source?: string; asset?: string; route?: string; fallbackAsset?: string; components?: string[]; target?: { type: string; id: string } }>;
      executionPatterns: string[];
    };
    call: { flowState: string; demoFallback: { mode: string | null; reason: string | null } };
  };
  assert.equal(mediaFailure.outcome, "fail_closed_handoff");
  assert.match(mediaFailure.summary, /bounded TTS handoff prompt -> fail-closed human handoff/);
  assert.deepEqual(mediaFailure.simulatedEvents.slice(-3), ["failed_ai_path_stopped", "bounded_tts_prompt_requested", "human_handoff_requested"]);
  assert.equal(mediaFailure.integration.controlSequence[0]?.type, "telephony.ai_path.stop_requested");
  assert.deepEqual(mediaFailure.integration.controlSequence[0]?.components, ["asr", "llm"]);
  assert.equal(mediaFailure.integration.controlSequence[1]?.type, "telephony.tts.requested");
  assert.equal(mediaFailure.integration.controlSequence[1]?.source, "bounded_fixed_prompt");
  assert.equal(mediaFailure.integration.controlSequence[1]?.route, "/api/cluecon/tts");
  assert.equal(mediaFailure.integration.controlSequence[1]?.fallbackAsset, "/cluecon/system-unavailable.mp3");
  assert.equal(mediaFailure.integration.controlSequence[2]?.type, "telephony.handoff.requested");
  assert.equal(mediaFailure.integration.controlSequence[2]?.target?.id, "human-support");
  assert.ok(mediaFailure.integration.executionPatterns.some((pattern) => /same configured TTS route as the latency lab/.test(pattern)));
  assert.equal(mediaFailure.call.flowState, "wrap");
  assert.equal(mediaFailure.call.demoFallback.mode, "runtime_failure");
  assert.match(mediaFailure.call.demoFallback.reason ?? "", /rtc_asr_unavailable/);

  const ttsFailureResponse = await post("/api/cluecon/operator/drill", { kind: "tts_unavailable" });
  assert.equal(ttsFailureResponse.statusCode, 201);
  const ttsFailure = JSON.parse(ttsFailureResponse.body) as typeof mediaFailure;
  assert.equal(ttsFailure.outcome, "fail_closed_handoff");
  assert.match(ttsFailure.summary, /prerecorded error prompt -> fail-closed human handoff/);
  assert.deepEqual(ttsFailure.simulatedEvents.slice(-3), ["failed_ai_path_stopped", "prerecorded_error_prompt", "human_handoff_requested"]);
  assert.deepEqual(ttsFailure.integration.controlSequence[0]?.components, ["asr", "llm", "tts"]);
  assert.equal(ttsFailure.integration.controlSequence[1]?.type, "telephony.playback.requested");
  assert.equal(ttsFailure.integration.controlSequence[1]?.source, "prerecorded_media");
  assert.equal(ttsFailure.integration.controlSequence[1]?.asset, "/cluecon/system-unavailable.mp3");
  assert.equal(ttsFailure.integration.controlSequence[2]?.target?.id, "human-support");
  assert.ok(ttsFailure.integration.executionPatterns.some((pattern) => /does not depend on the unavailable TTS service/.test(pattern)));
  assert.ok(ttsFailure.integration.executionPatterns.some((pattern) => /apply-inbound-acl/.test(pattern)));
  assert.match(ttsFailure.call.demoFallback.reason ?? "", /tts_unavailable/);

  const transferResponse = await post("/api/cluecon/operator/drill", { kind: "transfer" });
  assert.equal(transferResponse.statusCode, 201);
  const transfer = JSON.parse(transferResponse.body) as {
    outcome: string;
    summary: string;
    integration: {
      boundary: string;
      controlPlane: string;
      mediaPlane: string;
      demoCaveat: string;
      controlMessage: { type: string; callId: string; mode: string; target: { type: string; uri: string } };
      executionPatterns: string[];
    };
    call: { flowState: string; operatorSteer: { lastAction: string | null }; events: Array<{ type: string }> };
  };
  assert.equal(transfer.outcome, "operator_transfer");
  assert.match(transfer.summary, /FreeSWITCH or SIP\/media-server adapter/);
  assert.equal(transfer.integration.boundary, "acc_control_plane_to_telephony_adapter");
  assert.equal(transfer.integration.controlMessage.type, "telephony.transfer.requested");
  assert.equal(transfer.integration.controlMessage.mode, "blind_transfer");
  assert.equal(transfer.integration.controlMessage.target.type, "sip_uri");
  assert.match(transfer.integration.controlMessage.target.uri, /^sip:/);
  assert.ok(transfer.integration.executionPatterns.some((pattern) => /uuid_transfer/.test(pattern)));
  assert.ok(transfer.integration.executionPatterns.some((pattern) => /SIP REFER/.test(pattern)));
  assert.ok(transfer.integration.executionPatterns.some((pattern) => /SIP B2BUA/.test(pattern)));
  assert.ok(transfer.integration.executionPatterns.some((pattern) => /callcenter support@default/.test(pattern)));
  assert.ok(transfer.integration.executionPatterns.some((pattern) => /BACKGROUND_JOB, CHANNEL_ANSWER, CHANNEL_BRIDGE/.test(pattern)));
  assert.match(transfer.integration.controlPlane, /mod_event_socket \/ ESL/);
  assert.match(transfer.integration.mediaPlane, /owns the SIP\/RTP legs/);
  assert.match(transfer.integration.demoCaveat, /does not place an external transfer leg/);
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
  const pocket = await startHealthServer({ status: "healthy", service: "pocket-tts" });

  try {
    await withEnv(
      {
        RTC_ASR_BASE_URL: rtcAsr.baseUrl,
        KOKORO_BASE_URL: kokoro.baseUrl,
        POCKET_TTS_BASE_URL: pocket.baseUrl,
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
        assert.ok(payload.liveProbes.some((probe) => probe.id === "pocket_tts" && probe.configured && probe.ok && probe.metadata.service === "pocket-tts"));
        assert.equal(payload.asrPanel.status, "live_ready");
        assert.equal(payload.asrPanel.liveProbe.ok, true);
      },
    );
  } finally {
    await closeServer(rtcAsr.server);
    await closeServer(kokoro.server);
    await closeServer(pocket.server);
  }
});

test("ClueCon ASR routes discover warmed models and proxy live transcription", async () => {
  const rtcAsr = await startRtcAsrServer();
  try {
    await withEnv({ RTC_ASR_BASE_URL: rtcAsr.baseUrl, RTC_ASR_WS_URL: undefined }, async () => {
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
  await withEnv({ RTC_ASR_BASE_URL: undefined, RTC_ASR_WS_URL: undefined, RTC_ASR_MODEL_ENDPOINTS: undefined }, async () => {
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

test("ClueCon TTS route streams Kokoro audio using the configured local model and voice", async () => {
  const kokoro = await startKokoroServer();
  try {
    await withEnv(
      {
        ACC_TTS_PROVIDER: "kokoro",
        POCKET_TTS_BASE_URL: undefined,
        KOKORO_BASE_URL: kokoro.baseUrl,
        KOKORO_MODEL: "kokoro",
        KOKORO_VOICE: "af_heart",
      },
      async () => {
        const response = await post("/api/cluecon/tts/synthesize", {
          text: "AI may be probabilistic, but the system around it does not have to be.",
          model: "kokoro",
          voice: "af_heart",
        });
        assert.equal(response.statusCode, 200);
        assert.match(response.contentType, /audio\/mpeg/);
        assert.equal(response.body, "ID3audio");
        assert.equal(kokoro.requests.length, 1);
        assert.deepEqual(kokoro.requests[0], {
          model: "kokoro",
          voice: "af_heart",
          input: "AI may be probabilistic, but the system around it does not have to be.",
          response_format: "mp3",
          stream: true,
        });
      },
    );
  } finally {
    await closeServer(kokoro.server);
  }
});

test("ClueCon TTS route rejects a model that differs from the selected local target", async () => {
  const kokoro = await startKokoroServer();
  try {
    await withEnv(
      {
        ACC_TTS_PROVIDER: "kokoro",
        POCKET_TTS_BASE_URL: undefined,
        KOKORO_BASE_URL: kokoro.baseUrl,
        KOKORO_MODEL: "kokoro",
      },
      async () => {
        const response = await post("/api/cluecon/tts/synthesize", {
          provider: "kokoro",
          model: "different-model",
          text: "This must not use a different model.",
        });
        assert.equal(response.statusCode, 409);
        const payload = JSON.parse(response.body) as { error: string; requestedModel: string; selectedModel: string };
        assert.equal(payload.error, "tts_model_selection_mismatch");
        assert.equal(payload.requestedModel, "different-model");
        assert.equal(payload.selectedModel, "kokoro");
        assert.equal(kokoro.requests.length, 0);
      },
    );
  } finally {
    await closeServer(kokoro.server);
  }
});

test("Kokoro startup warm-up performs a real configured synthesis", async () => {
  const kokoro = await startKokoroServer();
  try {
    await withEnv(
      {
        KOKORO_BASE_URL: kokoro.baseUrl,
        KOKORO_MODEL: "kokoro",
        KOKORO_VOICE: "af_heart",
        KOKORO_WARMUP_TEXT: "Ready.",
        KOKORO_WARMUP: undefined,
      },
      async () => {
        const result = await warmConfiguredKokoro();
        assert.equal(result.status, "warmed");
        assert.equal(kokoro.requests.length, 1);
        assert.deepEqual(kokoro.requests[0], {
          model: "kokoro",
          voice: "af_heart",
          input: "Ready.",
          response_format: "mp3",
          stream: true,
        });
      },
    );
  } finally {
    await closeServer(kokoro.server);
  }
});

test("ClueCon ASR model discovery preserves an explicit browser websocket endpoint", async () => {
  const rtcAsr = await startRtcAsrServer();
  const browserWebsocketUrl = "wss://speech.example.test/browser/stt";
  try {
    await withEnv({ RTC_ASR_BASE_URL: rtcAsr.baseUrl, RTC_ASR_WS_URL: browserWebsocketUrl }, async () => {
      const response = await get("/api/cluecon/asr/models");
      assert.equal(response.statusCode, 200);
      const payload = JSON.parse(response.body) as { models: Array<{ websocketUrl: string }> };
      assert.equal(payload.models[0]?.websocketUrl, browserWebsocketUrl);
    });
  } finally {
    await closeServer(rtcAsr.server);
  }
});

test("ClueCon TTS route auto-selects Pocket by URL and streams audio through the ACC provider proxy", async () => {
  const pocket = await startPocketTtsServer();
  try {
    await withEnv(
      {
        ACC_TTS_PROVIDER: undefined,
        POCKET_TTS_BASE_URL: pocket.baseUrl,
        POCKET_TTS_MODEL: "pocket-tts",
        POCKET_TTS_VOICE: "alloy",
        KOKORO_BASE_URL: undefined,
      },
      async () => {
        const payloadResponse = await get("/api/cluecon");
        const payload = JSON.parse(payloadResponse.body) as {
          demoGoal: { chain: string[] };
          readiness: Array<{ id: string; status: string }>;
          ttsPanel: {
            provider: string;
            engine: string;
            status: string;
            pipecatStreaming: { enabled: boolean; provider: string; preservesAgentBrain: boolean; outputContract: string };
          };
        };
        assert.equal(payload.ttsPanel.provider, "Pocket TTS");
        assert.equal(payload.ttsPanel.engine, "pocket");
        assert.equal(payload.ttsPanel.status, "streaming_ready");
        assert.equal(payload.ttsPanel.pipecatStreaming.enabled, true);
        assert.equal(payload.ttsPanel.pipecatStreaming.provider, "pocket");
        assert.equal(payload.ttsPanel.pipecatStreaming.preservesAgentBrain, true);
        assert.match(payload.ttsPanel.pipecatStreaming.outputContract, /TTSAudioRawFrame/);
        assert.deepEqual(payload.demoGoal.chain, ["caller", "freeswitch", "pipecat_pipeline", "rtc_asr", "acc_policy_tools", "pocket_tts", "evidence"]);
        assert.ok(payload.readiness.some((item) => item.id === "pocket_tts" && item.status === "ready"));

        const response = await post("/api/cluecon/tts/synthesize", {
          text: "Pocket should stream through the same Pipecat playback contract.",
          voice: "alloy",
        });
        assert.equal(response.statusCode, 200);
        assert.match(response.contentType, /audio\/mpeg/);
        assert.equal(response.body, "ID3audio");
        assert.equal(response.headers["x-acc-tts-provider"], "pocket");
        assert.equal(response.headers["x-acc-tts-through"], "acc_provider_proxy");
        assert.equal(response.headers["x-acc-tts-streaming"], "true");
        assert.deepEqual(pocket.requests[0], {
          model: "pocket-tts",
          voice: "alloy",
          input: "Pocket should stream through the same Pipecat playback contract.",
          response_format: "mp3",
          stream: true,
        });
      },
    );
  } finally {
    await closeServer(pocket.server);
  }
});

test("GET /api/cluecon blocks explicitly selected Pocket when its base URL is missing", async () => {
  await withEnv(
    {
      ACC_TTS_PROVIDER: "pocket",
      POCKET_TTS_BASE_URL: undefined,
      KOKORO_BASE_URL: undefined,
    },
    async () => {
      const payloadResponse = await get("/api/cluecon");
      assert.equal(payloadResponse.statusCode, 200);
      const payload = JSON.parse(payloadResponse.body) as {
        readiness: Array<{ id: string; status: string; detail: string }>;
        liveProbes: Array<{ id: string; configured: boolean; status: string }>;
        ttsPanel: { engine: string; status: string; liveProbe: { configured: boolean; status: string } | null };
      };
      const pocketReadiness = payload.readiness.find((item) => item.id === "pocket_tts");
      assert.equal(pocketReadiness?.status, "blocked");
      assert.match(pocketReadiness?.detail ?? "", /POCKET_TTS_BASE_URL/);
      assert.ok(payload.liveProbes.some((probe) => probe.id === "pocket_tts" && probe.configured === false && probe.status === "fixture"));
      assert.equal(payload.ttsPanel.engine, "pocket");
      assert.equal(payload.ttsPanel.status, "local_sidecar_required");
      assert.equal(payload.ttsPanel.liveProbe?.configured, false);

      const synthesizeResponse = await post("/api/cluecon/tts/synthesize", { text: "Pocket must be configured." });
      assert.equal(synthesizeResponse.statusCode, 503);
      assert.match(synthesizeResponse.body, /pocket_not_configured/);
    },
  );
});

test("Pocket TTS route ignores model mismatch and keeps using the configured model", async () => {
  const pocket = await startPocketTtsServer();
  try {
    await withEnv(
      {
        ACC_TTS_PROVIDER: "pocket",
        POCKET_TTS_BASE_URL: pocket.baseUrl,
        POCKET_TTS_MODEL: "pocket-tts",
        POCKET_TTS_VOICE: "alloy",
        KOKORO_BASE_URL: undefined,
      },
      async () => {
        const response = await post("/api/cluecon/tts/synthesize", {
          provider: "pocket",
          model: "legacy-pocket-model",
          text: "Model mismatch should stay usable for Pocket as long as the provider is healthy.",
        });
        assert.equal(response.statusCode, 200);
        assert.match(response.contentType, /audio\/mpeg/);
        assert.equal(pocket.requests.length, 1);
        assert.equal(pocket.requests[0].model, "pocket-tts");
      },
    );
  } finally {
    await closeServer(pocket.server);
  }
});

test("ClueCon ASR model discovery preserves a same-origin websocket proxy path", async () => {
  const rtcAsr = await startRtcAsrServer();
  try {
    await withEnv({ RTC_ASR_BASE_URL: rtcAsr.baseUrl, RTC_ASR_WS_URL: "/api/cluecon/asr/stream" }, async () => {
      const response = await get("/api/cluecon/asr/models");
      assert.equal(response.statusCode, 200);
      const payload = JSON.parse(response.body) as { models: Array<{ websocketUrl: string }> };
      assert.equal(payload.models[0]?.websocketUrl, "/api/cluecon/asr/stream?targetId=primary");
    });
  } finally {
    await closeServer(rtcAsr.server);
  }
});

test("ClueCon ASR same-origin websocket paths preserve the selected warmed target", async () => {
  const first = await startRtcAsrServer();
  const second = await startRtcAsrServer();
  try {
    await withEnv(
      {
        RTC_ASR_BASE_URL: undefined,
        RTC_ASR_WS_URL: undefined,
        RTC_ASR_MODEL_ENDPOINTS: JSON.stringify([
          { id: "parakeet-a", label: "Parakeet A", baseUrl: first.baseUrl, websocketUrl: "/api/cluecon/asr/stream" },
          { id: "parakeet-b", label: "Parakeet B", baseUrl: second.baseUrl, websocketUrl: "/api/cluecon/asr/stream" },
        ]),
      },
      async () => {
        const response = await get("/api/cluecon/asr/models");
        assert.equal(response.statusCode, 200);
        const payload = JSON.parse(response.body) as { models: Array<{ targetId: string; websocketUrl: string }> };
        assert.deepEqual(
          payload.models.map((model) => [model.targetId, model.websocketUrl]),
          [
            ["parakeet-a", "/api/cluecon/asr/stream?targetId=parakeet-a"],
            ["parakeet-b", "/api/cluecon/asr/stream?targetId=parakeet-b"],
          ],
        );
      },
    );
  } finally {
    await closeServer(first.server);
    await closeServer(second.server);
  }
});

test("ClueCon ASR websocket proxy preserves an upstream base-path prefix", () => {
  assert.equal(getRtcAsrUpstreamStreamPath("https://speech.example.test/asr"), "/asr/v1/stt/stream");
  assert.equal(getRtcAsrUpstreamStreamPath("https://speech.example.test/asr/"), "/asr/v1/stt/stream");
  assert.equal(getRtcAsrUpstreamStreamPath("http://rtc-asr:8080"), "/v1/stt/stream");
});

test("Pocket TTS route replaces the legacy alloy placeholder with the configured local voice", async () => {
  const pocket = await startPocketTtsServer();
  try {
    await withEnv(
      {
        ACC_TTS_PROVIDER: "kokoro",
        POCKET_TTS_BASE_URL: pocket.baseUrl,
        POCKET_TTS_MODEL: "pocket-tts",
        POCKET_TTS_VOICE: "alba",
      },
      async () => {
        const response = await post("/api/cluecon/tts/synthesize", {
          provider: "pocket",
          voice: "alloy",
          text: "A stale presentation tab should still use the configured Pocket voice.",
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers["x-acc-tts-voice"], "alba");
        assert.equal(pocket.requests[0]?.voice, "alba");
      },
    );
  } finally {
    await closeServer(pocket.server);
  }
});

test("ClueCon TTS route refreshes its idle timeout while audio keeps arriving", async () => {
  const kokoro = await startKokoroServer([
    { delayMs: 60, value: "audio-1" },
    { delayMs: 60, value: "audio-2" },
  ]);
  try {
    await withEnv(
      {
        ACC_TTS_PROVIDER: "kokoro",
        POCKET_TTS_BASE_URL: undefined,
        KOKORO_BASE_URL: kokoro.baseUrl,
        KOKORO_TTS_IDLE_TIMEOUT_MS: "100",
      },
      async () => {
        const response = await post("/api/cluecon/tts/synthesize", { text: "Keep an active stream alive." });
        assert.equal(response.statusCode, 200);
        assert.equal(response.body, "ID3audio-1audio-2");
      },
    );
  } finally {
    await closeServer(kokoro.server);
  }
});

test("ClueCon TTS route fails clearly when Kokoro is not configured", async () => {
  await withEnv({ ACC_TTS_PROVIDER: "kokoro", POCKET_TTS_BASE_URL: undefined, KOKORO_BASE_URL: undefined }, async () => {
    const response = await post("/api/cluecon/tts/synthesize", { text: "Test the local voice." });
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /kokoro_not_configured/);
  });
});

test("ClueCon TTS route fails clearly when Pocket TTS is not configured", async () => {
  await withEnv({ POCKET_TTS_BASE_URL: undefined }, async () => {
    const response = await post("/api/cluecon/tts/synthesize", { provider: "pocket", text: "Test Pocket TTS." });
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /pocket_not_configured/);
    assert.match(response.body, /start the local Pocket TTS service/);
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
    scorecardGroups: { safety: string[]; evidenceCoverage: string[]; performance: string };
    evidenceArtifacts: string[];
  };
  assert.equal(preview.ok, true);
  assert.equal(preview.workboardCard, "6017890d-8f17-4ce0-aab9-d4cf3015d82c");
  assert.equal(preview.mode, "non_mutating_preview");
  assert.equal(preview.compatibleRequest, "conversation-agent-evals-assert-request.json");
  assert.equal(preview.runRoute, "/api/cluecon/eval/run");
  assert.ok(preview.scorecardChecks.includes("policy_hold"));
  assert.deepEqual(preview.scorecardGroups.safety, ["task_completion", "policy_hold", "operator_approval", "final_state"]);
  assert.equal(preview.scorecardGroups.performance, "reported_separately");
  assert.ok(preview.evidenceArtifacts.includes("action_trace"));

  const runResponse = await post("/api/cluecon/eval/run");
  assert.equal(runResponse.statusCode, 201);
  const run = JSON.parse(runResponse.body) as {
    ok: boolean;
    workboardCard: string;
    compatibleRequest: string;
    scorecard: {
      overallPassed: boolean;
      passed: number;
      total: number;
      checks: Array<{ id: string; label: string; passed: boolean; evidence: string }>;
      safety: { passed: number; total: number };
      evidenceCoverage: { passed: number; total: number };
      performance: { status: string; total: number; overBudget: number; evidence: string };
    };
    assertRequestPreview: { spec_ref: { assert_project: string }; evidence: { transcript: { readiness: string }; proof_bundle: { routes: { transcript: string } } }; metadata: { compatible_file: string } };
    proofLinks: { proof: string; operatorConsole: string };
  };
  assert.equal(run.ok, true);
  assert.equal(run.workboardCard, "6017890d-8f17-4ce0-aab9-d4cf3015d82c");
  assert.equal(run.compatibleRequest, "conversation-agent-evals-assert-request.json");
  assert.equal(run.scorecard.overallPassed, true);
  assert.equal(run.scorecard.passed, run.scorecard.total);
  assert.deepEqual({ passed: run.scorecard.safety.passed, total: run.scorecard.safety.total }, { passed: 4, total: 4 });
  assert.deepEqual({ passed: run.scorecard.evidenceCoverage.passed, total: run.scorecard.evidenceCoverage.total }, { passed: 2, total: 2 });
  assert.equal(run.scorecard.performance.status, "warning");
  assert.ok(run.scorecard.performance.overBudget > 0);
  assert.ok(run.scorecard.performance.total >= run.scorecard.performance.overBudget);
  assert.ok(run.scorecard.checks.some((check) => check.id === "operator_approval" && check.passed && check.label === "Price review completed before cancellation"));
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
  assert.match(narrative.body, /From SIP to Tokens: Deterministic Telephony Meets Real-Time Voice AI/);
  assert.match(narrative.body, /ClueCon 2026 presentation/);
  assert.doesNotMatch(narrative.body, /ClueCon vertical slice/i);
  assert.doesNotMatch(narrative.body, /class="talk-time"/);
  assert.doesNotMatch(narrative.body, />2 minutes</);
  assert.doesNotMatch(narrative.body, />3 minutes</);
  assert.doesNotMatch(narrative.body, />Live browser demo</);
  assert.match(narrative.body, /Alberto Gonzalez CTO @ WebRTC\.ventures/);
  assert.match(narrative.body, /Realtime call flow visualization/);
  assert.doesNotMatch(narrative.body, /1s demo beat/);
  assert.doesNotMatch(narrative.body, /live sip freeswitch path/);
  assert.doesNotMatch(narrative.body, /local stack/);
  assert.match(narrative.body, /Caller → SIP\/RTP/);
  assert.match(narrative.body, /Live SIP caller/);
  assert.doesNotMatch(narrative.body, /Browser \/ fixture adapter/);
  assert.match(narrative.body, /<strong>Speech activity<\/strong>/);
  assert.match(narrative.body, /<strong>Turn completion<\/strong>/);
  assert.doesNotMatch(narrative.body, /<strong>VAD alternatives<\/strong>/);
  assert.match(narrative.body, /FreeSWITCH boundary/);
  assert.match(narrative.body, /Audio → text \/ tokens/);
  assert.match(narrative.body, /Speech → caller/);
  assert.match(narrative.body, /voice-pipeline/);
  assert.match(narrative.body, /xform-carrier/);
  assert.match(narrative.body, /media-wave/);
  assert.match(narrative.body, /media-tokens/);
  assert.equal((narrative.body.match(/data-slide="\d+"/g) ?? []).length, 15);
  assert.match(narrative.body, /January 2017 · My first voice prototype/);
  assert.match(narrative.body, /My first voice AI/);
  assert.match(narrative.body, /could do anything—/);
  assert.match(narrative.body, /as long as you said/);
  assert.match(narrative.body, /exactly what I expected\./);
  assert.match(narrative.body, /I’m sorry\. I didn’t understand\./);
  assert.match(narrative.body, /Six years later, GPT-4 arrived\./);
  assert.match(narrative.body, /<b>1<\/b>January 2017/);
  assert.match(narrative.body, /<b>2<\/b><span>Six years later, GPT-4 arrived\.<\/span>/);
  assert.match(narrative.body, /<b>3<\/b><strong>So we put <em>GPT-4<\/em><br>on a <em>WebRTC call\.<\/em><\/strong>/);
  assert.match(narrative.body, /voice-origin__turn/);
  assert.match(narrative.body, /voice-story-active/);
  assert.match(narrative.body, /\.present \.voice-origin__content \{ padding-top: clamp\(60px,7\.5vh,84px\); padding-bottom: clamp\(150px,18vh,190px\); \}/);
  assert.match(narrative.body, /\.present \.voice-origin__turn \{ position: absolute;/);
  assert.match(narrative.body, /alberto-echo-show-prototype\.jpg/);
  assert.match(narrative.body, /voiceOriginDrift/);
  assert.match(narrative.body, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(narrative.body, /We spent decades teaching machines to carry a conversation/);
  assert.doesNotMatch(narrative.body, /Switchboard/);
  assert.match(narrative.body, /Deterministic telephony meets probabilistic inference/);
  assert.match(narrative.body, /Telephony \/ WebRTC/);
  assert.match(narrative.body, /INVITE → 18x → 200 → ACK … BYE → 200/);
  assert.match(narrative.body, /Sequence-numbered RTP on a media deadline/);
  assert.match(narrative.body, /0 ms/);
  assert.match(narrative.body, /seq 8041/);
  assert.match(narrative.body, /80 ms/);
  assert.match(narrative.body, /seq 8045/);
  assert.match(narrative.body, /probability-curve--asr/);
  assert.match(narrative.body, /probability-curve--llm/);
  assert.doesNotMatch(narrative.body, /Illustrative distributions—not measured results/);
  assert.match(narrative.body, /Never block media/);
  assert.match(narrative.body, /Run call control independently/);
  assert.match(narrative.body, /contract boundary/);
  assert.match(narrative.body, /Never hide uncertainty/);
  assert.match(narrative.body, /Expose partial, timeout, cancel, and fallback/);
  assert.doesNotMatch(narrative.body, /id="two-machines"/);
  assert.doesNotMatch(narrative.body, /One runs on clocks\. One runs on confidence/);
  assert.doesNotMatch(narrative.body, /Illustrative local latency targets/);
  assert.match(narrative.body, /id="vad-interruption"/);
  assert.match(narrative.body, /id="vad-mic"/);
  assert.match(narrative.body, /id="vad-threshold"/);
  assert.match(narrative.body, /VADUserStartedSpeakingFrame/);
  assert.match(narrative.body, /UserStoppedSpeakingFrame/);
  assert.match(narrative.body, /VAD_END_OF_TURN_MS = Number\(data\.turnTiming\?\.endOfTurnSilenceMs\) \|\| 2000/);
  assert.match(narrative.body, /turn wait: 2\.0 s/);
  assert.match(narrative.body, /LLM, policy, and tools can process now; only audio output waits for 2\.0 s/);
  assert.match(narrative.body, /Audio output starts after the 2 s end-of-turn gate/);
  assert.match(narrative.body, /Agent audio cannot start while the 2 s end-of-turn gate/);
  assert.match(narrative.body, /End-of-turn timing diagram/);
  assert.match(narrative.body, /turn wait: 0\.5–2 s/);
  assert.match(narrative.body, /LLM \+ policy can run/);
  assert.doesNotMatch(narrative.body, /Start is urgent/);
  assert.doesNotMatch(narrative.body, /Policy runs early/);
  assert.doesNotMatch(narrative.body, /End is guarded/);
  assert.match(narrative.body, /MinWordsUserTurnStartStrategy/);
  assert.match(narrative.body, /https:\/\/docs\.pipecat\.ai\/api-reference\/server\/utilities\/turn-management\/user-turn-strategies#minwordsuserturnstartstrategy/);
  assert.match(narrative.body, /https:\/\/github\.com\/pipecat-ai\/smart-turn/);
  assert.match(narrative.body, /https:\/\/github\.com\/TEN-framework\/ten-vad/);
  assert.match(narrative.body, /https:\/\/github\.com\/snakers4\/silero-vad/);
  assert.match(narrative.body, /https:\/\/github\.com\/livekit\/agents\/tree\/main\/livekit-plugins\/livekit-plugins-turn-detector/);
  assert.doesNotMatch(narrative.body, /Audio output waits for 2 s of silence/);
  assert.match(narrative.body, /InterruptionFrame clears queue/);
  assert.match(narrative.body, /function vadLoop\(\)/);
  assert.match(narrative.body, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(narrative.body, /window\.speechSynthesis\.cancel/);
  assert.match(narrative.body, /vadStarting: false/);
  assert.match(narrative.body, /vadStartToken/);
  assert.match(narrative.body, /vadPendingStream/);
  assert.match(narrative.body, /Starting microphone…/);
  assert.match(narrative.body, /MIC_START_CANCELLED/);
  assert.match(narrative.body, /slideCount: slideOrder\.length/);
  assert.match(narrative.body, /\["flow", "voice-evolution", "realtime-problem", "map", "integration", "vad-interruption", "asr-architecture", "asr", "security", "agent", "demo", "tts", "ecosystem", "slo", "finale"\]/);
  assert.match(narrative.body, /Pipecat coordinates the realtime media and LLM loop\./);
  assert.match(narrative.body, /Agentic Call Center app authorizes tools and telephony actions/);
  assert.match(narrative.body, /orient="auto-start-reverse"/);
  assert.match(narrative.body, /markerUnits="userSpaceOnUse"/);
  assert.equal((narrative.body.match(/class="line line--media line--bidirectional"/g) ?? []).length, 3);
  assert.equal((narrative.body.match(/class="line line--media line--forward"/g) ?? []).length, 3);
  assert.equal((narrative.body.match(/class="line line--control line--bidirectional"/g) ?? []).length, 6);
  assert.equal((narrative.body.match(/class="line line--control line--forward"/g) ?? []).length, 2);
  assert.match(narrative.body, /\.line--media\.line--bidirectional \{ marker-start: url\(#arrow-media\); marker-end: url\(#arrow-media\); \}/);
  assert.match(narrative.body, /\.line--control\.line--bidirectional \{ marker-start: url\(#arrow-control\); marker-end: url\(#arrow-control\); \}/);
  assert.match(narrative.body, /Pipecat-coordinated runtime/);
  assert.match(narrative.body, /Flows \/ FlowManager/);
  assert.match(narrative.body, /LLM service/);
  assert.match(narrative.body, /Agentic Call Center App/);
  assert.match(narrative.body, /signaling \/ control \/ evidence/);
  assert.match(narrative.body, /Two realtime ingress paths\. One streaming Pipecat runtime/);
  assert.match(narrative.body, /SmallWebRTC \/ aiortc/);
  assert.match(narrative.body, /\.transport-node code \{ color: var\(--blue\); font-size: clamp\(13px,1vw,14px\); line-height: 1\.4;/);
  assert.match(narrative.body, /FreeSWITCH ↔ Pipecat/);
  assert.match(narrative.body, /SIP\/RTP \u2194 FreeSWITCH/);
  assert.equal((narrative.body.match(/class="transport-arrow" aria-label="bidirectional">↔<\/div>/g) ?? []).length, 2);
  assert.doesNotMatch(narrative.body, /class="shared-pipeline"/);
  assert.doesNotMatch(narrative.body, /persistent WebSocket \u00b7 16 kHz PCM16/);
  assert.doesNotMatch(narrative.body, /20 ms \/ 640 B \u00b7 interim events/);
  assert.doesNotMatch(narrative.body, /Agentic Call Center Reference App/);
  assert.match(narrative.body, /Commit after delivery/);
  assert.doesNotMatch(narrative.body, /rtc-asr keeps one socket session open and emits evolving partials/);
  assert.doesNotMatch(narrative.body, /FlowManager validates node transitions; ACC demonstrates bounded state/);
  assert.doesNotMatch(narrative.body, /Forward the first playable TTS chunk immediately/);
  assert.doesNotMatch(narrative.body, /Run scripted demo/);
  assert.match(narrative.body, /Policy-control example/);
  assert.doesNotMatch(narrative.body, /Failure-control demo/);
  assert.match(narrative.body, /Run cancellation scenario/);
  assert.match(narrative.body, /Try another control/);
  assert.match(narrative.body, /Simple for the caller\. Controlled underneath\./);
  assert.match(narrative.body, /Cancellation scheduled for August 31\./);
  assert.match(narrative.body, /Account validated/);
  assert.match(narrative.body, /Final plan state recorded/);
  assert.match(narrative.body, /Price review/);
  assert.match(narrative.body, /\.demo-control-story::before/);
  assert.match(narrative.body, /border-top: 2px solid #5072a7/);
  assert.doesNotMatch(narrative.body, /\.demo-control-step:not\(:last-child\)::after \{ content: "â†’"/);
  assert.match(narrative.body, /Conversation \+ audit evidence/);
  assert.match(narrative.body, /id="demo-drill-select"/);
  assert.doesNotMatch(narrative.body, /id="drill-tool"/);
  assert.match(narrative.body, /renderOperatorDrill\(payload\)/);
  assert.match(narrative.body, /integration\.controlSequence \|\| integration\.controlMessage/);
  assert.match(narrative.body, /system-unavailable\.mp3/);
  assert.match(narrative.body, /kind === "rtc_asr_unavailable"/);
  assert.match(narrative.body, /synthesizedAsrFailureAudio/);
  assert.match(narrative.body, /provider\.id !== "pocket" && provider\.model/);
  assert.match(narrative.body, /provider\.label \+ " · " \+ provider\.model \+ " live TTS"/);
  assert.match(narrative.body, /data\.ttsPanel\.synthesizeRoute/);
  assert.match(narrative.body, /demo-failure-audio/);
  assert.match(narrative.body, /Audible caller prompt/);
  assert.doesNotMatch(narrative.body, /id="run-demo-top"/);
  assert.doesNotMatch(narrative.body, /Run Voice AI target/);
  assert.match(narrative.body, /window\.__CLUECON__/);
  assert.match(narrative.body, /rtc-asr is measurable and swappable/);
  assert.match(narrative.body, /id="asr-architecture"/);
  assert.match(narrative.body, /Audio in\. Transcript events out\./);
  assert.match(narrative.body, /80–160 ms PCM16/);
  assert.match(narrative.body, /partial · final · cancel/);
  assert.match(narrative.body, /FreeSWITCH · any WebRTC media server/);
  assert.match(narrative.body, /PCM → WebSocket/);
  assert.match(narrative.body, /in-process · worker thread/);
  assert.doesNotMatch(narrative.body, /no HTTP hop/);
  assert.match(narrative.body, /PCM16 → normalized float32 array/);
  assert.match(narrative.body, /model\.transcribe\(\[audio\]\)/);
  assert.doesNotMatch(narrative.body, /PCM16 → float32 → WAV/);
  assert.doesNotMatch(narrative.body, /ASRModel\.transcribe\(\[wav\]\)/);
  assert.match(narrative.body, /preloaded · same process/);
  assert.match(narrative.body, /Local[\s\S]*Swappable[\s\S]*Realtime[\s\S]*Measurable/);
  assert.match(narrative.body, /#asr-architecture > \.kicker \{ font-size: 14px/);
  assert.match(narrative.body, /\.asr-app-node small[^}]*font-size: 12px/);
  assert.match(narrative.body, /\.asr-app-node span[^}]*font-size: 14px/);
  assert.match(narrative.body, /\.asr-app-node code[^}]*font-size: 13px/);
  assert.match(narrative.body, /\.asr-app-link span, \.asr-app-link em[^}]*font-size: 13px/);
  assert.match(narrative.body, /\.asr-app-link code[^}]*font: 12px\/1\.3/);
  assert.match(narrative.body, /\.asr-benefit b[^}]*width: 44px; height: 44px/);
  assert.match(narrative.body, /\.asr-benefit strong \{ font-size: 20px/);
  assert.match(narrative.body, /\.asr-benefit small[^}]*font-size: 16px/);
  assert.match(narrative.body, /Mic → Local STT → transcript/);
  assert.match(narrative.body, /id="asr-model-select"/);
  assert.match(narrative.body, /id="asr-realtime"/);
  assert.match(narrative.body, /Start realtime/);
  assert.match(narrative.body, /local-stt\.v1/);
  assert.match(narrative.body, /handleAsrRealtimeMessage/);
  assert.match(narrative.body, /handleAsrRealtimeMessage\(event, live\)/);
  assert.match(narrative.body, /state\.asrLive !== live/);
  assert.match(narrative.body, /event => handleAsrRealtimeMessage\(event, live\)/);
  assert.match(narrative.body, /function updateAsrRealtimeTranscript/);
  assert.doesNotMatch(narrative.body, /function appendAsrRealtimeText/);
  assert.match(narrative.body, /function asrStablePrefixCount/);
  assert.match(narrative.body, /normalizedBackend\.includes\("whisper"\) && normalizedModel === "base\.en"/);
  assert.doesNotMatch(narrative.body, /identity\.includes\("faster-whisper"\) \|\|/);
  assert.match(narrative.body, /history\.slice\(-3\)/);
  assert.match(narrative.body, /LIVE · GROWING TRANSCRIPT/);
  assert.match(narrative.body, /Bright = stable across 3 revisions · cyan = may change/);
  assert.match(narrative.body, /FINAL · FULL UTTERANCE/);
  assert.match(narrative.body, /full-buffer partials keep earlier words visible/);
  assert.match(narrative.body, /async function openAsrRealtimeSocket\(url\)/);
  assert.match(narrative.body, /attempt <= 3/);
  assert.match(narrative.body, /rtc-asr is starting · retry/);
  assert.match(narrative.body, /catch \(error\) \{\s*setAsrRealtimeControls\(false\);\s*throw error;/);
  assert.match(narrative.body, /asrConnecting: false/);
  assert.match(narrative.body, /setAsrRealtimeControls\(true, false, true\)/);
  assert.match(narrative.body, /realtimeButton\.disabled = stopping \|\| connecting/);
  assert.match(narrative.body, /partial_strategy: "full_buffer_stability"/);
  assert.doesNotMatch(narrative.body, /partial_window_seconds: 2/);
  assert.match(narrative.body, /captureClosePromise/);
  assert.match(narrative.body, /stopPromise/);
  assert.match(narrative.body, /context\.state !== "closed"/);
  assert.match(narrative.body, /function renderAsrRealtimeError/);
  assert.match(narrative.body, /id="asr-record"/);
  assert.match(narrative.body, /async function releaseAsrRecordingResources\(capture\)/);
  assert.match(narrative.body, /capture\.stream\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
  assert.match(narrative.body, /capture\.context && capture\.context\.state !== "closed"/);
  assert.match(narrative.body, /catch \(error\) \{ await releaseAsrRecordingResources\(capture\); throw error; \}/);
  assert.match(narrative.body, /Source ↗/);
  assert.match(narrative.body, /rtc-asr\/tree\/main\/examples\/browser_pipecat_demo/);
  assert.match(narrative.body, /Benchmarks ↗/);
  assert.match(narrative.body, /https:\/\/agonza1\.github\.io\/rtc-asr\/docs\//);
  assert.match(narrative.body, /renderAsrBenchmarks\(model\)/);
  assert.match(narrative.body, /identity\.includes\("parakeet"\) && identity\.includes\("110m"\)/);
  assert.match(narrative.body, /return profiles\[key\] \|\| compatibleFallback \|\| null/);
  assert.match(narrative.body, /250\.7 ms/);
  assert.match(narrative.body, /676\.5 ms/);
  assert.match(narrative.body, /0\.021x/);
  assert.match(narrative.body, /0\.066x/);
  assert.match(narrative.body, /Reference WER/);
  assert.match(narrative.body, /2\.4% \/ 5\.2%/);
  assert.match(narrative.body, /LibriSpeech clean \/ other/);
  assert.match(narrative.body, /huggingface\.co\/nvidia\/parakeet-tdt_ctc-110m/);
  assert.match(narrative.body, /https:\/\/github\.com\/agonza1\/rtc-asr/);
  assert.match(narrative.body, /renderAsrPanel/);
  assert.match(narrative.body, /Noise changes more than WER/);
  assert.match(narrative.body, /false interruptions, backchannels, and end-of-turn errors/);
  assert.match(narrative.body, /The reliability target is the complete turn/);
  assert.doesNotMatch(narrative.body, /Twilio|Flux passed/);
  assert.match(narrative.body, /id="tts"/);
  assert.match(narrative.body, /Run Kokoro/);
  assert.match(narrative.body, /id="tts-provider"/);
  assert.match(narrative.body, /value="pocket"/);
  assert.match(narrative.body, /function renderTtsProviderSelection\(\)/);
  assert.match(narrative.body, /function resetTtsMeasurements\(\)/);
  assert.match(narrative.body, /controller: new AbortController\(\)/);
  assert.match(narrative.body, /signal: requestController\.signal/);
  assert.match(narrative.body, /LIVE_TTS_KOKORO_FETCH_TIMEOUT_MS = 45_000/);
  assert.match(narrative.body, /provider\.id === "kokoro"/);
  assert.match(narrative.body, /readTtsAudioResponse\(response, byteLength =>/);
  assert.match(narrative.body, /}, timeouts\.readMs\)/);
  assert.match(narrative.body, /provider\.id === "pocket" \? "POCKET_TTS_BASE_URL" : "KOKORO_BASE_URL"/);
  assert.match(narrative.body, /provider\.label \+ " request timed out\. Confirm "/);
  assert.match(narrative.body, /if \(token !== state\.ttsStreamToken\) return;\s+if \(firstByteMs === null\)/);
  assert.match(narrative.body, /if \(token !== state\.ttsStreamToken\) return;\s+stopTtsStream\(\);/);
  assert.match(narrative.body, /providerSelect\.disabled = true/);
  assert.match(narrative.body, /renderTtsProviderSelection\(\); resetTtsMeasurements\(\)/);
  assert.match(narrative.body, /tts-text[^\n]+input[^\n]+stopTtsStream\(\); renderTtsProviderSelection\(\); resetTtsMeasurements\(\)/);
  assert.match(narrative.body, /provider: provider\.id/);
  assert.match(narrative.body, /id="tts-ttfb"/);
  assert.match(narrative.body, /id=\"tts-playback\"/);
  assert.match(narrative.body, /Main OSS recommendations/);
  assert.match(narrative.body, /Kokoro 82M/);
  assert.match(narrative.body, /Pocket TTS/);
  assert.match(narrative.body, /VoXtream2/);
  assert.match(narrative.body, /Qwen3-TTS 0\.6B/);
  assert.doesNotMatch(narrative.body, /FlashTTS/);
  assert.match(narrative.body, /63 ms first packet/);
  assert.match(narrative.body, /97 ms first packet/);
  assert.match(narrative.body, /id="tts-text-progress"/);
  assert.match(narrative.body, /natural-boundary chunks/);
  assert.match(narrative.body, /Here is the key\. AI may be probabilistic/);
  assert.match(narrative.body, /function segmentTtsText\(text\)/);
  assert.match(narrative.body, /return segments;/);
  assert.doesNotMatch(narrative.body, /segments\.slice\(0, 8\)/);
  assert.match(narrative.body, /Stop the batch recording before starting realtime transcription/);
  assert.match(narrative.body, /Stop realtime transcription before starting a batch recording/);
  assert.match(narrative.body, /const failedLive = state\.asrLive \|\| live/);
  assert.match(narrative.body, /context\.decodeAudioData/);
  assert.match(narrative.body, /source\.start\(scheduledAt\)/);
  assert.match(narrative.body, /Playing queued audio while synthesizing/);
  assert.doesNotMatch(narrative.body, /Expression as a governed layer|Harness TTS|2607\.17900/);
  assert.match(narrative.body, /function runTtsLab\(\)/);
  assert.match(narrative.body, /Minimize sensitive data crossing the LLM boundary/);
  assert.match(narrative.body, /id="security"/);
  assert.match(narrative.body, /\.security-boundary \{[^}]*color: #e8f4ff/);
  assert.match(narrative.body, /\.security-node small \{ color: #a5f3fc/);
  assert.match(narrative.body, /\.security-node strong, \.security-pane > strong \{ color: #f8fafc/);
  assert.match(narrative.body, /PII \/ PHI \/ PCI guardrail/);
  assert.match(narrative.body, /\[REDACTED_EMAIL\]/);
  assert.match(narrative.body, /NOT SENT TO LLM/);
  assert.match(narrative.body, /realtime-voice-ai-guardrails/);
  assert.match(narrative.body, /slug-voice-ai-security-webrtc-livekit-guardrails/);
  assert.match(narrative.body, /renderSecurityPanel/);
  assert.match(narrative.body, /Conversation state guides\. Application state authorizes/);
  assert.match(narrative.body, /FlowManager controls the model’s current task—not business truth/);
  assert.match(narrative.body, /Conversation · guidance/);
  assert.match(narrative.body, /Business · authority/);
  assert.match(narrative.body, /Approval · authority/);
  assert.match(narrative.body, /Pipecat Flows \+ LLM/);
  assert.match(narrative.body, /Conversation flow graph/);
  assert.match(narrative.body, /Collect identity/);
  assert.match(narrative.body, /Understand request/);
  assert.match(narrative.body, /1 · identity gate/);
  assert.match(narrative.body, /2 · request intent/);
  assert.doesNotMatch(narrative.body, /click for code/);
  assert.match(narrative.body, /Policy \+ approval/);
  assert.match(narrative.body, /policy auto-approval → execute/);
  assert.match(narrative.body, /operator approval → execute/);
  assert.match(narrative.body, /denied · expired · unavailable → explain or warm handoff/);
  assert.match(narrative.body, /data-agent-code="agent-code-identity"/);
  assert.match(narrative.body, /def collect_identity_node\(\) -> NodeConfig/);
  assert.match(narrative.body, /def understand_request_node\(\) -> NodeConfig/);
  assert.match(narrative.body, /functions=\[submit_identity, transfer_to_human\]/);
  assert.match(narrative.body, /lookup inputs—not proof/);
  assert.match(narrative.body, /role_message=\(/);
  assert.match(narrative.body, /ConsolidatedFunctionResult, FlowManager, NodeConfig/);
  assert.match(narrative.body, /functions=\[route_request, transfer_to_human\]/);
  assert.match(narrative.body, /data-agent-code="agent-code-verify"/);
  assert.match(narrative.body, /data-agent-code="agent-code-approval"/);
  assert.match(narrative.body, /data-agent-code="agent-code-execute"/);
  assert.match(narrative.body, /async def submit_identity\([\s\S]*flow_manager: FlowManager,[\s\S]*full_name: str,[\s\S]*zip_code: str/);
  assert.match(narrative.body, /identity_service\.verify/);
  assert.match(narrative.body, /bind_verified_customer/);
  assert.match(narrative.body, /state_version=state\.version/);
  assert.match(narrative.body, /operations\.execute_once/);
  assert.match(narrative.body, /idempotency_key=approval\.id/);
  assert.match(narrative.body, /operation_digest=operation\.digest/);
  assert.match(narrative.body, /events\.record_in_transaction/);
  assert.match(narrative.body, /Application \/ DB · authoritative handler/);
  assert.match(narrative.body, /function setupAgentCode\(\)/);
  assert.match(narrative.body, /A node defines what the model may discuss and propose/);
  assert.match(narrative.body, /Reliable audio is necessary\. Reliable conversation is the outcome\./);
  assert.match(narrative.body, /Traditional service SLO/);
  assert.match(narrative.body, /Conversational SLO/);
  assert.match(narrative.body, /Google SRE Workbook ↗/);
  assert.match(narrative.body, /ITU-T P\.851 ↗/);
  assert.match(narrative.body, /class="ecosystem-card ecosystem-card--primary" href="http:\/\/127\.0\.0\.1:3012\/scenarios"/);
  assert.match(narrative.body, /class="ecosystem-card" href="https:\/\/github\.com\/responsibleai\/ASSERT"/);
  assert.match(narrative.body, /class="ecosystem-card ecosystem-card--target" href="http:\/\/127\.0\.0\.1:8026\/operator\/console"/);
  assert.match(narrative.body, /class="ecosystem-card" href="http:\/\/127\.0\.0\.1:8090\/rtc-asr"/);
  assert.match(narrative.body, /\.ecosystem-card:focus-visible/);
  assert.match(narrative.body, /Start the demo from either side: click ConversationAgentEvals for scenarios, or Agentic Contact Center for the live operator view\./);
  assert.match(narrative.body, /<small>Demo entry · scenarios<\/small><strong>ConversationAgentEvals<\/strong>/);
  assert.match(narrative.body, /<small>Demo entry · operator<\/small><strong>Agentic Contact Center<\/strong>/);
  assert.doesNotMatch(narrative.body, /Different voice agents\. One evaluation contract\./);
  assert.doesNotMatch(narrative.body, /id="proof"|eval-scorecard|eval-demo-run-link/);
  assert.doesNotMatch(narrative.body, /CAE_WEB_URL/);
  assert.doesNotMatch(narrative.body, /id="proof-cards"/);
  assert.match(narrative.body, /Every enterprise workflow can now begin with a conversation\./);
  assert.match(narrative.body, /2017 · People adapted to systems\./);
  assert.match(narrative.body, /Now · Systems can adapt to people\./);
  assert.match(narrative.body, /\.finale-callback \{[^}]*font-size: 18px/);
  assert.match(narrative.body, /\.finale-callback strong \{[^}]*font-size: 22px/);
  assert.doesNotMatch(narrative.body, /The conversation can be open-ended\./);
  assert.doesNotMatch(narrative.body, /Identity, authority, and outcomes cannot be\./);
  assert.doesNotMatch(narrative.body, /Let AI handle the unexpected|Engineer everything that happens next/);
  assert.match(narrative.body, /Run it\. Break it\. Make it better\./);
  assert.match(narrative.body, /Connect on LinkedIn/);
  assert.match(narrative.body, /quickchart\.io\/qr\?text=https%3A%2F%2Fwww\.linkedin\.com%2Fin%2Falbertogonzaleztrastoy%2F/);
  assert.match(narrative.body, /alberto@webrtc\.ventures/);
  assert.match(narrative.body, /logo-main-light\.svg/);
  assert.match(narrative.body, /class="flow-brand"[^>]*aria-label="Visit WebRTC\.ventures"/);
  assert.match(narrative.body, /<section class="voice-pipeline">[\s\S]*class="flow-brand"[\s\S]*<\/section><\/div>/);
  assert.match(narrative.body, /\.flow-brand img \{[^}]*width: min\(250px, 62vw\)/);
  assert.doesNotMatch(narrative.body, /runEvalProof/);
  assert.match(narrative.body, /goToSlide/);
  assert.ok(narrative.body.includes('id="slide-status" aria-live="polite">1 / 15'));
  assert.match(narrative.body, /"ecosystem", "slo", "finale"/);
  assert.match(narrative.body, /aria-label="Previous slide"/);
  assert.ok(narrative.body.includes('status.textContent = String(state.slide + 1) + " / " + String(state.slideCount)'));
  assert.match(narrative.body, /@media \(max-width: 1100px\) \{ \.demo-control-step/);
  assert.match(narrative.body, /@media \(max-width: 920px\) \{ \.demo-commandbar/);
  assert.match(narrative.body, /--topbar-height: 48px/);
  assert.match(narrative.body, /\.brand \{ display: flex; align-items: baseline/);
  assert.match(narrative.body, /\.toolbar a, \.mode-link \{[^}]*min-height: 30px/);
  assert.match(narrative.body, /\.present #demo \{ height: calc\(100vh - var\(--topbar-height\)\)/);
  assert.match(narrative.body, /\.present \.topbar \{ position: static/);
  assert.match(narrative.body, /\.demo-commandbar \{ display: grid/);
  assert.match(narrative.body, /\.demo-drill-picker \{ display: grid/);
  assert.match(narrative.body, /#demo \.event strong, #demo \.event \.muted \{ overflow-wrap: anywhere/);
  assert.match(narrative.body, /class="transcript-turn transcript-turn--/);
  assert.match(narrative.body, /renderDemoTranscript\(payload\.call\.transcript\)/);
  assert.match(narrative.body, /renderDemoTranscript\(turns\).*evidence\.open = true;/);
  assert.match(narrative.body, /renderOperatorDrill\(payload\).*evidence\.open = true;/);
  assert.match(narrative.body, /class="scroll"/);
  assert.match(narrative.body, /\.scroll \.voice-origin__eyebrow/);
  assert.match(narrative.body, /RTF = processing time ÷ audio duration/);
  assert.match(narrative.body, /\.present #asr \{ align-content: center; \}/);
  assert.match(narrative.body, /\.present #demo, \.present #tts \{ align-content: start; padding-top: clamp\(16px, 2\.4vh, 24px\); \}/);
  assert.match(narrative.body, /\.voice-pipeline__detail \{ display: none; \}/);
  assert.match(narrative.body, /class="readiness-more"/);
  assert.doesNotMatch(narrative.body, /class="eval-details"/);

  const present = await get("/cluecon/present");
  assert.equal(present.statusCode, 200);
  assert.match(present.body, /class="present"/);
  assert.match(present.body, /From SIP to Tokens/);
  assert.match(present.body, /Alberto Gonzalez CTO @ WebRTC\.ventures/);
  assert.match(present.body, /ArrowRight/);
  assert.doesNotMatch(present.body, /Run Voice AI target|eval-scorecard/);
  assert.match(present.body, /ClueCon 2026 presentation/);
  assert.match(present.body, /RTF = processing time ÷ audio duration/);
  assert.doesNotMatch(present.body, /class="talk-time"/);
  assert.doesNotMatch(present.body, />2 minutes</);
  assert.doesNotMatch(present.body, />3 minutes</);
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
  const localNarrative = await get("/cluecon");
  assert.equal(localNarrative.statusCode, 200);
  assert.equal(
    extractIntegrationSection(html),
    extractIntegrationSection(localNarrative.body),
    "the Pages export must use the exact integration section rendered by the local ClueCon route",
  );
  assert.match(html, /Agentic Contact Center/);
  assert.match(html, /Static GitHub Pages snapshot/);
  assert.match(html, /--bg: #f5f7f8/);
  assert.doesNotMatch(html, /color-scheme: dark/);
  assert.doesNotMatch(html, /pages-notice|repo-strip|talk-progress|section-index/);
  assert.match(html, /window\.__CLUECON__/);
  assert.match(html, /Browser microphone VAD/);
  assert.match(html, /Simulate barge-in/);
  assert.match(html, /turn wait: 2\.0 s/);
  assert.match(html, /turn wait: 0\.5–2 s/);
  assert.match(html, /LLM \+ policy can run/);
  assert.match(html, /MinWordsUserTurnStartStrategy/);
  assert.match(html, /https:\/\/github\.com\/TEN-framework\/ten-vad/);
  assert.match(html, /https:\/\/github\.com\/snakers4\/silero-vad/);
  assert.match(html, /https:\/\/github\.com\/livekit\/agents\/tree\/main\/livekit-plugins\/livekit-plugins-turn-detector/);
  assert.match(html, /does not place an external transfer leg/);
  assert.doesNotMatch(html, /30-minute session/);
  assert.doesNotMatch(html, /15 min system story/);
  assert.doesNotMatch(html, /10 min live demo/);
  assert.doesNotMatch(html, /5 min proof \+ close/);
  assert.equal((html.match(/data-slide="\d+"/g) ?? []).length, 15);
  assert.match(html, /Reliable audio is necessary\. Reliable conversation is the outcome\./);
  assert.doesNotMatch(html, /Run Voice AI target/);
  assert.match(html, /Every enterprise workflow can now begin with a conversation\./);
  assert.match(html, /Open source projects to try below:/);
  assert.doesNotMatch(html, /Bring back evidence\. Let’s compare notes after the talk\./);
  assert.match(html, /Live \"\+provider\+\" TTFB requires the local ACC \+ selected TTS sidecar/);
  assert.match(html, /prerecorded system-unavailable prompt/i);
  assert.match(html, /human-support/);
  assert.match(html, /intercept\("run-demo-drill"/);
  assert.match(html, /detail\.dataset\.turns=String\(transcript\.length\)/);
  assert.match(html, /target\.dataset\.events=String\(items\.length\)/);
  assert.match(html, /if\(evidence\)evidence\.open=true/);
  assert.match(html, /demo-evidence-count/);
  assert.doesNotMatch(html, /intercept\("drill-tool"/);
  assert.match(html, /turns\[2\]/);
  assert.match(html, /cancellation_scheduled/);
  assert.match(html, /href="\.\/present\/"/);
  assert.match(html, /src="\.\/alberto-echo-show-prototype\.jpg"/);
  assert.doesNotMatch(html, /href="\/cluecon"/);
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new Function(script));
  }

  const presentHtml = readFileSync(presentPath, "utf8");
  assert.match(presentHtml, /href="\.\/"/);
  assert.match(presentHtml, /href="\.\.\/"/);
  assert.match(presentHtml, /src="\.\.\/alberto-echo-show-prototype\.jpg"/);
  assert.doesNotMatch(presentHtml, /href="\.\/present\/"/);
  assert.equal(existsSync("site/cluecon-pages/system-unavailable.mp3"), true);
  assert.equal(existsSync("site/cluecon-pages/alberto-echo-show-prototype.jpg"), true);

  const fallbackHtml = readFileSync(fallbackPath, "utf8");
  assert.match(fallbackHtml, /Static GitHub Pages snapshot/);
});
