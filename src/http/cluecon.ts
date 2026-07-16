import { SCRIPTED_CALLER_TURNS, getPipecatPrototypeHealth } from "../core/pipecatFlowPrototype";
import type { PocConfig } from "../core/types";

type ClueConReadinessStatus = "ready" | "blocked" | "fixture" | "configured";

interface ClueConReadinessItem {
  id: string;
  label: string;
  status: ClueConReadinessStatus;
  detail: string;
  caveat: string;
}

interface ClueConSidecarProbe {
  id: string;
  label: string;
  configured: boolean;
  status: ClueConReadinessStatus;
  url: string | null;
  healthPath: string | null;
  ok: boolean;
  responseMs: number | null;
  detail: string;
  error: string | null;
  metadata: Record<string, unknown>;
}

interface ClueConProbeOptions {
  rtcAsrBaseUrl?: string;
  rtcAsrHealthPath?: string;
  kokoroBaseUrl?: string;
  kokoroHealthPath?: string;
  pipecatVoiceUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ClueConBrainBlock {
  file: string;
  summary: string;
  affects: string[];
}

export const clueConAgentBrainCard = "71d60b43-0de0-4a67-bb60-d6539780c3a4";
export const clueConOperatorCockpitCard = "3ea982b1-627a-4698-8b02-0c270b688237";
export const clueConProofEvalCard = "6017890d-8f17-4ce0-aab9-d4cf3015d82c";
const defaultProbeTimeoutMs = 600;
const clueConVadTiming = {
  speechStartHoldMs: 80,
  acousticStopHoldMs: 350,
  endOfTurnSilenceMs: 2000,
  outputStartAfterEndOfTurnMs: 0,
};
const defaultBrainBlockRows: Array<[string, string, string]> = [
  ["mission.md", "Rescue an at-risk cancellation only inside approved retention boundaries.", "agent response, final state"],
  ["policy.md", "Pause before risky offers, require operator approval, and fail closed on runtime uncertainty.", "policy hold, fallback"],
  ["tools.md", "Expose bounded call controls, slide controls, proof export, and operator steer actions.", "active tool, action trace"],
  ["operator.md", "Ask for human steer at the retention boundary and record approval or escalation evidence.", "operator hold, proof bundle"],
  ["fallback.md", "Escalate to a human instead of improvising when ASR, TTS, tools, or runtime are unavailable.", "handoff, caveats"],
  ["eval.md", "Score task completion, policy compliance, final state, latency, and evidence quality.", "ASSERT request, scorecard"],
];

export function defaultClueConBrainBlocks(): ClueConBrainBlock[] {
  return defaultBrainBlockRows.map(([file, summary, affects]) => ({
    file,
    summary,
    affects: affects.split(/,\s*/),
  }));
}

function normalizeBrainBlock(input: unknown, index: number): { block?: ClueConBrainBlock; errors: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { errors: [`brain block ${index + 1} must be an object`] };
  }
  const record = input as Record<string, unknown>;
  const file = typeof record.file === "string" ? record.file.trim() : "";
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  const affects = Array.isArray(record.affects)
    ? record.affects.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
    : [];
  const errors: string[] = [];
  if (!/^[a-z0-9_-]+\.md$/i.test(file)) {
    errors.push(`brain block ${index + 1} file must be a markdown filename`);
  }
  if (summary.length < 12) {
    errors.push(`brain block ${file || index + 1} summary must be at least 12 characters`);
  }
  if (!affects.length) {
    errors.push(`brain block ${file || index + 1} must declare affected evidence fields`);
  }
  if (errors.length) {
    return { errors };
  }
  return { block: { file, summary, affects }, errors: [] };
}

export function normalizeClueConBrainBlocks(input: unknown): { ok: boolean; blocks: ClueConBrainBlock[]; errors: string[] } {
  const source = input && typeof input === "object" && !Array.isArray(input) && "blocks" in input
    ? (input as { blocks?: unknown }).blocks
    : input;
  if (!Array.isArray(source)) {
    return { ok: false, blocks: [], errors: ["blocks must be an array"] };
  }
  const blocks: ClueConBrainBlock[] = [];
  const errors: string[] = [];
  for (const [index, item] of source.entries()) {
    const normalized = normalizeBrainBlock(item, index);
    errors.push(...normalized.errors);
    if (normalized.block) {
      blocks.push(normalized.block);
    }
  }
  if (!blocks.some((block) => block.file === "policy.md")) {
    errors.push("policy.md block is required for the ClueCon agent panel");
  }
  if (!blocks.some((block) => block.file === "fallback.md")) {
    errors.push("fallback.md block is required for the ClueCon agent panel");
  }
  return { ok: errors.length === 0, blocks, errors };
}

export function buildClueConBrainPreview(input: unknown, currentBlocks: ClueConBrainBlock[]) {
  const normalized = normalizeClueConBrainBlocks(input);
  const currentByFile = new Map(currentBlocks.map((block) => [block.file, block.summary]));
  const changedFiles = normalized.blocks
    .filter((block) => currentByFile.get(block.file) !== block.summary)
    .map((block) => block.file);

  return {
    ok: normalized.ok,
    previewOnly: true,
    errors: normalized.errors,
    changedFiles,
    activeBrainBlocks: normalized.blocks,
    evidence: {
      sessionLabel: "cluecon/agent-brain-preview",
      mutation: "preview_only",
      corruptsRuntime: false,
      affectedEvidence: Array.from(new Set(normalized.blocks.flatMap((block) => block.affects))),
    },
  };
}

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function normalizeHealthPath(value: string | undefined, fallback: string): string {
  return trimEnv(value) ?? fallback;
}

function probeMetadata(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  return Object.fromEntries(
    ["status", "ready", "backend", "model", "service", "version", "voices"].flatMap((key) =>
      key in record ? [[key, record[key]]] : [],
    ),
  );
}

async function probeHttpSidecar({
  id,
  label,
  baseUrl,
  healthPath,
  configuredDetail,
  missingDetail,
  timeoutMs,
  fetchImpl,
}: {
  id: string;
  label: string;
  baseUrl?: string;
  healthPath: string;
  configuredDetail: string;
  missingDetail: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<ClueConSidecarProbe> {
  if (!baseUrl) {
    return {
      id,
      label,
      configured: false,
      status: "fixture",
      url: null,
      healthPath,
      ok: false,
      responseMs: null,
      detail: missingDetail,
      error: null,
      metadata: {},
    };
  }

  const url = joinUrl(baseUrl, healthPath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const responseMs = Date.now() - started;
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const metadata = probeMetadata(payload);
    const explicitOk = payload && typeof payload === "object" && "ok" in payload ? Boolean((payload as { ok?: unknown }).ok) : true;
    const ready = response.ok && explicitOk;
    return {
      id,
      label,
      configured: true,
      status: ready ? "ready" : "blocked",
      url,
      healthPath,
      ok: ready,
      responseMs,
      detail: ready ? configuredDetail : `${label} responded but is not ready.`,
      error: ready ? null : `HTTP ${response.status}`,
      metadata,
    };
  } catch (error) {
    return {
      id,
      label,
      configured: true,
      status: "blocked",
      url,
      healthPath,
      ok: false,
      responseMs: Date.now() - started,
      detail: `${label} is configured but unreachable.`,
      error: error instanceof Error ? error.message : String(error),
      metadata: {},
    };
  } finally {
    clearTimeout(timeout);
  }
}

function pipecatVoiceProbe(pipecatVoiceUrl?: string): ClueConSidecarProbe {
  if (!pipecatVoiceUrl) {
    return {
      id: "pipecat_voice",
      label: "Pipecat voice bridge",
      configured: false,
      status: "fixture",
      url: null,
      healthPath: null,
      ok: false,
      responseMs: null,
      detail: "Browser voice bridge URL is not configured; scripted mode remains valid.",
      error: null,
      metadata: {},
    };
  }
  return {
    id: "pipecat_voice",
    label: "Pipecat voice bridge",
    configured: true,
    status: "configured",
    url: pipecatVoiceUrl,
    healthPath: null,
    ok: true,
    responseMs: null,
    detail: "Browser voice bridge URL is configured; websocket liveness is verified by the browser voice flow.",
    error: null,
    metadata: { transport: "websocket" },
  };
}

function buildBasePayload(
  config: PocConfig,
  liveProbes: ClueConSidecarProbe[] = [],
  brainBlocks: ClueConBrainBlock[] = defaultClueConBrainBlocks(),
) {
  const pipecat = getPipecatPrototypeHealth();
  const probeById = new Map(liveProbes.map((probe) => [probe.id, probe]));
  const rtcAsrProbe = probeById.get("rtc_asr");
  const kokoroProbe = probeById.get("kokoro");
  const pipecatVoice = probeById.get("pipecat_voice");

  return {
    ok: true,
    route: "/api/cluecon",
    issue: "agonza1/agentic-contact-center#177",
    sourceRepos: {
      agenticContactCenter: "https://github.com/agonza1/agentic-contact-center",
      rtcAsr: "https://github.com/agonza1/rtc-asr",
    },
    workboardCard: "85ea5a1a-3a68-4e5d-ac1d-10d5851017ae",
    activeWorkboardCard: clueConProofEvalCard,
    title: "Shared Realtime Pipeline: Browser, Fixtures, and SIP as Adapters",
    thesis:
      "Issue #222 is the center: one Pipecat Pipeline should run rtc-asr, ACC policy/tool control, and Kokoro, while browser WebRTC, fixture/tester injection, and SIP/FreeSWITCH enter as adapters. The current demo proves contracts, not the finished shared-media architecture.",
    architectureCenter: {
      issue: "agonza1/agentic-contact-center#222",
      target: "transport.input -> rtc-asr STT -> ACC caller-turn adapter -> Kokoro TTS -> transport.output",
      adapterRule: "Browser, fixture/tester, and SIP must feed the same Pipeline processors instead of growing separate demo paths.",
      currentGaps: [
        "browser ASR -> ACC -> TTS remains turn-buffered",
        "browser and SIP media implementations are still separate",
        "SIP caller-audible playback proof is not complete",
        "audio fixture injection and tester agent are not implemented",
      ],
    },
    demoGoal: {
      issue: "agonza1/agentic-contact-center#222",
      statement: "Show the cancellation-rescue proof as a contract slice on the path to one shared realtime Pipeline, not as another standalone demo path.",
      chain: ["adapter", "pipecat_pipeline_target", "rtc_asr", "acc_policy_tools", "kokoro_tts", "evidence"],
      successSignal: "The scorecard passes and the runtime copy names the remaining #222 gaps instead of implying browser/SIP parity is complete.",
    },
    turnTiming: {
      ...clueConVadTiming,
      rule: "VAD acoustic stop is only an end-of-turn candidate; agent audio stays blocked until the post-speech silence gate elapses.",
    },
    callFlow: {
      workboardCard: "c9455e37-8b08-4351-8079-9e8f82899ab6",
      issue: "agonza1/agentic-contact-center#217",
      cadenceMs: 1000,
      mode: "deterministic_local_fixture",
      credentialRequirement: "none",
      stages: [
        {
          id: "audio_in",
          label: "Caller audio in",
          detail: "Browser, fixture/tester, or SIP adapters should feed the same Pipeline input",
          packet: "WebRTC Opus · fixture PCM16 · SIP PCMU/PCMA",
        },
        {
          id: "transport",
          label: "Transport + codec normalize",
          detail: "Pipecat transport adapter normalizes wire codecs into Pipeline frames",
          packet: "codec → PCM16 16 kHz",
        },
        {
          id: "stt",
          label: "Audio → text / tokens",
          detail: "rtc-asr turns waveform into transcript events the agent can reason over",
          packet: "waveform → tokens",
        },
        {
          id: "agent",
          label: "Tokens + policy",
          detail: "Intent, tools, and operator hold stay explicit in the token domain",
          packet: "intent · action",
        },
        {
          id: "tts",
          label: "Text → audio out",
          detail: "TTS synthesizes speech, then each adapter returns audio through its transport",
          packet: "tokens → waveform → adapter output",
        },
      ],
    },
    routes: {
      scrollable: "/cluecon",
      present: "/cluecon/present",
      scriptedDemo: "/api/demo/run-end-to-end",
      operatorConsole: "/operator/console",
      proofViewer: "/assert",
      assertSpec: "/assert/spec",
      browserWebrtcReadiness: "/api/browser-webrtc/readiness",
      pipecatMediaReadiness: "/api/pipecat-media-engine/readiness",
      operatorDrill: "/api/cluecon/operator/drill",
      evalPreview: "/api/cluecon/eval/preview",
      evalRun: "/api/cluecon/eval/run",
    },
    liveProbes,
    readiness: [
      {
        id: "acc",
        label: "ACC app",
        repoUrl: "https://github.com/agonza1/agentic-contact-center",
        status: "ready",
        detail: `${config.demoName} HTTP runtime is serving local demo and proof routes.`,
        caveat: "Local process only; not a hosted production deployment.",
      },
      {
        id: "pipecat",
        label: "Pipecat transport",
        status: pipecatVoice?.status === "configured" ? "configured" : pipecat.ready ? "ready" : "blocked",
        detail: pipecatVoice?.configured
          ? `${pipecat.runtimeEngine} via ${pipecat.transport}; browser bridge configured at ${pipecatVoice.url}.`
          : `${pipecat.runtimeEngine} via ${pipecat.transport}; verify with ${pipecat.runtimeCheck.command}.`,
        caveat: pipecatVoice?.configured
          ? "Websocket liveness is exercised by browser voice mode; scripted mode remains valid without it."
          : "Browser voice needs the local Pipecat bridge; scripted mode remains valid without it.",
      },
      {
        id: "rtc_asr",
        label: "rtc-asr Local STT v1",
        repoUrl: "https://github.com/agonza1/rtc-asr",
        status: rtcAsrProbe?.status ?? "fixture",
        detail: rtcAsrProbe?.detail ?? "Fixture ASR events are shown for the talk path until a local rtc-asr sidecar is configured.",
        caveat: rtcAsrProbe?.configured
          ? `Probe ${rtcAsrProbe.ok ? "passed" : "failed"} at ${rtcAsrProbe.url}.`
          : "Optional for this scripted presentation: set RTC_ASR_BASE_URL to upgrade from fixture to live readiness.",
      },
      {
        id: "kokoro",
        label: "Kokoro TTS",
        status: kokoroProbe?.status ?? "fixture",
        detail: kokoroProbe?.detail ?? "Fixture talk path keeps text evidence when Kokoro is not configured locally.",
        caveat: kokoroProbe?.configured
          ? `Probe ${kokoroProbe.ok ? "passed" : "failed"} at ${kokoroProbe.url}.`
          : "Optional for this scripted presentation: set KOKORO_BASE_URL for live TTS readiness.",
      },
      {
        id: "eval",
        label: "ConversationAgentEvals / ASSERT",
        status: "ready",
        detail: "The scripted run exposes a proof bundle preview and ASSERT-compatible request handoff.",
        caveat: "Local ASSERT viewer export is separate from importing into ConversationAgentEvals.",
      },
    ],
    scenario: {
      name: "cancellation_rescue_seeded_script",
      callerTurns: [...SCRIPTED_CALLER_TURNS],
      operatorMoment: "renewal_increase_requires_safe_offer_review",
      failureDrills: ["tool_timeout", "runtime_failure", "rtc_asr_unavailable", "tts_unavailable"],
    },
    asrPanel: {
      provider: "rtc-asr Local STT v1",
      contract: "PCM16 16 kHz mono in; transcript events out",
      status: rtcAsrProbe?.ok ? "live_ready" : "fixture",
      endpointHints: ["GET /health", "GET /api/models", "WS /v1/stt/stream"],
      modelsRoute: "/api/cluecon/asr/models",
      transcribeRoute: "/api/cluecon/asr/transcribe",
      benchmarkUrl: "https://agonza1.github.io/rtc-asr/docs/",
      pipecatDemoUrl: process.env.RTC_ASR_BROWSER_DEMO_URL ?? "https://github.com/agonza1/rtc-asr/tree/main/examples/browser_pipecat_demo",
      liveProbe: rtcAsrProbe ?? null,
      streamStates: ["connected", "ready", "partial", "final", "canceled", "error"],
      fixtureEvents: [
        { state: "connected", text: "local Pipecat bridge opened an ASR stream", latencyMs: 34 },
        { state: "partial", text: "i need to cancel", latencyMs: 238 },
        { state: "final", text: "I need to cancel because the renewal increase is too high.", latencyMs: 812 },
        { state: "error", text: "rtc-asr sidecar unavailable: keep blocker visible", latencyMs: null },
      ],
      benchmarks: [
        { label: "first partial", value: "250.7 ms", caveat: "Published Parakeet MLX 110M mean; P95 255.1 ms" },
        { label: "finalization", value: "251.8 ms", caveat: "Published Parakeet MLX 110M mean; P95 268.0 ms" },
        { label: "RTF", value: "0.021x", caveat: "Published Parakeet MLX 110M REST throughput context" },
      ],
      benchmarkProfiles: {
        "parakeet-mlx|mlx-community/parakeet-tdt_ctc-110m": {
          label: "Parakeet 110M NeMo MLX",
          firstPartial: "250.7 ms",
          firstPartialDetail: "P95 255.1 ms",
          finalization: "251.8 ms",
          finalizationDetail: "P95 268.0 ms",
          rtf: "0.021x",
          rtfDetail: "REST mean 150.1 ms · P95 197.6 ms",
          measuredAt: "2026-06-21",
          detailUrl: "https://agonza1.github.io/rtc-asr/docs/benchmark-results/pages/parakeet-mlx-110m-service-2026-06-21.html",
        },
        "faster-whisper|base.en": {
          label: "Faster-Whisper Base",
          firstPartial: "676.5 ms",
          firstPartialDetail: "P95 686.9 ms",
          finalization: "768.8 ms",
          finalizationDetail: "P95 957.0 ms",
          rtf: "0.066x",
          rtfDetail: "REST mean 479.9 ms · P95 587.3 ms",
          measuredAt: "2026-06-20",
          detailUrl: "https://agonza1.github.io/rtc-asr/docs/benchmark-results/pages/faster-whisper-base.en-int8-2026-06-20.html",
        },
      },
    },
    brainBlocks,
    brainPanel: {
      previewRoute: "/api/cluecon/brain/preview",
      applyRoute: "/api/cluecon/brain/apply",
      resetRoute: "/api/cluecon/brain/reset",
      safeMutation: "session_scoped_in_memory",
      activeFiles: brainBlocks.map((block) => block.file),
    },
    operatorCockpit: {
      workboardCard: clueConOperatorCockpitCard,
      drillRoute: "/api/cluecon/operator/drill",
      modes: ["scripted_sequence", "operator_click_simulation", "browser_voice_fallback"],
      simulatedEvents: ["call.started", "media.transcript", "operator.action", "call.ended", "call.error"],
      drillKinds: ["scripted_approve", "tool_timeout", "runtime_failure", "transfer", "takeover", "end_call"],
      actions: ["pause", "resume", "approve_offer", "ask_operator", "escalate_to_human", "fallback", "transfer", "takeover", "end_call"],
      telephonyControlBoundary: {
        command: "structured JSON from ACC",
        adapters: ["FreeSWITCH ESL", "SIP media server", "CPaaS call-control API"],
        standardPatterns: ["SIP REFER", "B2BUA outbound INVITE + bridge", "SIP BYE"],
        responsibility: "The adapter/media server owns SIP dialogs and RTP; ACC owns the policy decision and auditable command.",
      },
      proofLinks: ["/api/operator/console", "/api/queue?attentionRequired=true", "/api/demo/run-end-to-end"],
      caveat: "Cockpit drills reuse the local call/session APIs; #222 still needs fixture/tester and SIP adapters sharing the same Pipeline processors.",
    },
    proofPreview: {
      workboardCard: clueConProofEvalCard,
      previewRoute: "/api/cluecon/eval/preview",
      runRoute: "/api/cluecon/eval/run",
      includes: ["transcript", "events", "action trace", "latency marks", "final state", "fallback state", "media evidence", "ASR/TTS caveats"],
      compatibleRequest: "conversation-agent-evals-assert-request.json",
      primaryClaim: "The demo is complete when the evidence proves the workflow completed safely.",
      scorecardChecks: ["task_completion", "policy_hold", "operator_approval", "final_state", "latency_evidence", "fallback_caveats"],
    },
  };
}

export function buildClueConPayload(config: PocConfig, brainBlocks?: ClueConBrainBlock[]) {
  return buildBasePayload(config, [], brainBlocks);
}

export async function buildClueConPayloadWithLiveProbes(
  config: PocConfig,
  options: ClueConProbeOptions = {},
  brainBlocks?: ClueConBrainBlock[],
) {
  const env = process.env;
  const timeoutMs = options.timeoutMs ?? defaultProbeTimeoutMs;
  const fetchImpl = options.fetchImpl ?? fetch;
  const rtcAsrBaseUrl = options.rtcAsrBaseUrl ?? trimEnv(env.RTC_ASR_BASE_URL);
  const kokoroBaseUrl = options.kokoroBaseUrl ?? trimEnv(env.KOKORO_BASE_URL);
  const pipecatVoiceUrl = options.pipecatVoiceUrl ?? trimEnv(env.PIPECAT_VOICE_WS_URL) ?? trimEnv(env.ACC_PIPECAT_VOICE_WS_URL);

  const liveProbes = await Promise.all([
    probeHttpSidecar({
      id: "rtc_asr",
      label: "rtc-asr Local STT v1",
      baseUrl: rtcAsrBaseUrl,
      healthPath: normalizeHealthPath(options.rtcAsrHealthPath ?? env.RTC_ASR_HEALTH_PATH, "/health"),
      configuredDetail: "rtc-asr health probe is reachable for live ASR readiness.",
      missingDetail: "RTC_ASR_BASE_URL is not set; presentation uses fixture ASR evidence until the local sidecar is configured.",
      timeoutMs,
      fetchImpl,
    }),
    probeHttpSidecar({
      id: "kokoro",
      label: "Kokoro TTS",
      baseUrl: kokoroBaseUrl,
      healthPath: normalizeHealthPath(options.kokoroHealthPath ?? env.KOKORO_HEALTH_PATH, "/health"),
      configuredDetail: "Kokoro health probe is reachable for local TTS readiness.",
      missingDetail: "KOKORO_BASE_URL is not set; TTS panel stays in text/local fallback mode.",
      timeoutMs,
      fetchImpl,
    }),
    Promise.resolve(pipecatVoiceProbe(pipecatVoiceUrl)),
  ]);

  return buildBasePayload(config, liveProbes, brainBlocks);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}

const WAVEFORM_BARS = [8, 18, 12, 24, 10, 20, 14, 22, 9, 16, 11, 19];
const TOKEN_CHIPS = ["I", "need", "to", "cancel", "…"];

function waveformMarkup(className = ""): string {
  const bars = WAVEFORM_BARS.map(
    (height, index) =>
      `<span class="media-wave__bar" style="--bar-h:${height}px;--bar-i:${index}"></span>`,
  ).join("");
  return `<div class="media-wave ${className}" aria-hidden="true">${bars}</div>`;
}

function tokenStreamMarkup(className = ""): string {
  const chips = TOKEN_CHIPS.map(
    (token, index) => `<span class="media-tokens__chip" style="--chip-i:${index}">${escapeHtml(token)}</span>`,
  ).join("");
  return `<div class="media-tokens ${className}" aria-hidden="true">${chips}</div>`;
}

function buildCallFlowMarkup(callFlow: {
  cadenceMs: number;
  mode: string;
  credentialRequirement: string;
  stages: Array<{ id: string; label: string; detail: string; packet: string }>;
}): string {
  const stageById = new Map(callFlow.stages.map((stage) => [stage.id, stage]));
  const ingress = stageById.get("audio_in");
  const transport = stageById.get("transport");
  const stt = stageById.get("stt");
  const agent = stageById.get("agent");
  const tts = stageById.get("tts");

  return `<div class="realtime-flow" aria-label="Realtime call flow visualization"><section class="voice-pipeline">
  <div class="voice-pipeline__chrome">
    <div class="voice-pipeline__title">
      <span class="voice-pipeline__eyebrow">Media transformation path</span>
      <strong>Adapters → shared Pipeline frames → tokens → speech out</strong>
    </div>
    <div class="voice-pipeline__meta">
      <span>${callFlow.cadenceMs / 1000}s cadence</span>
      <span>${escapeHtml(callFlow.mode.replace(/_/g, " "))}</span>
      <span>${escapeHtml(callFlow.credentialRequirement)} credentials</span>
    </div>
  </div>
  <div class="voice-pipeline__canvas">
    <div class="xform-rail" aria-hidden="true">
      <div class="xform-carrier">
        <div class="xform-form xform-form--wave">${waveformMarkup("media-wave--carrier")}</div>
        <div class="xform-form xform-form--pcm"><span>PCM16</span></div>
        <div class="xform-form xform-form--tokens">${tokenStreamMarkup("media-tokens--carrier")}</div>
        <div class="xform-form xform-form--out">${waveformMarkup("media-wave--carrier media-wave--out")}</div>
      </div>
    </div>
    <ol class="voice-pipeline__stages">
      <li class="voice-pipeline__stage voice-pipeline__stage--audio_in" style="--stage-index:0">
        <div class="voice-pipeline__stage-head"><span class="voice-pipeline__step">01</span><span class="voice-pipeline__layer">INGRESS</span></div>
        <strong class="voice-pipeline__label">${escapeHtml(ingress?.label ?? "Caller audio in")}</strong>
        <span class="voice-pipeline__detail">${escapeHtml(ingress?.detail ?? "")}</span>
        <div class="ingress-fork">
          <div class="ingress-lane ingress-lane--sip">
            <span class="ingress-lane__name">SIP adapter</span>
            <span class="ingress-lane__codec">RTP · PCMU / PCMA</span>
            ${waveformMarkup("media-wave--sip")}
          </div>
          <div class="ingress-or">or</div>
          <div class="ingress-lane ingress-lane--webrtc">
            <span class="ingress-lane__name">Browser / fixture adapter</span>
            <span class="ingress-lane__codec">Opus / PCM16 test frames</span>
            ${waveformMarkup("media-wave--webrtc")}
          </div>
        </div>
        <code class="voice-pipeline__metric">${escapeHtml(ingress?.packet ?? "")}</code>
      </li>
      <li class="voice-pipeline__stage voice-pipeline__stage--transport" style="--stage-index:1">
        <div class="voice-pipeline__stage-head"><span class="voice-pipeline__step">02</span><span class="voice-pipeline__layer">TRANSPORT</span></div>
        <strong class="voice-pipeline__label">${escapeHtml(transport?.label ?? "Transport + codec normalize")}</strong>
        <span class="voice-pipeline__detail">${escapeHtml(transport?.detail ?? "")}</span>
        <div class="codec-bridge" aria-hidden="true">
          <span class="codec-chip">PCMU</span>
          <span class="codec-chip">Opus</span>
          <span class="codec-arrow">⟶</span>
          <span class="codec-chip codec-chip--target">PCM16</span>
        </div>
        <div class="transport-tag">Pipecat Pipeline target</div>
        <code class="voice-pipeline__metric">${escapeHtml(transport?.packet ?? "")}</code>
      </li>
      <li class="voice-pipeline__stage voice-pipeline__stage--stt" style="--stage-index:2">
        <div class="voice-pipeline__stage-head"><span class="voice-pipeline__step">03</span><span class="voice-pipeline__layer">STT</span></div>
        <strong class="voice-pipeline__label">${escapeHtml(stt?.label ?? "Audio → text / tokens")}</strong>
        <span class="voice-pipeline__detail">${escapeHtml(stt?.detail ?? "")}</span>
        <div class="media-morph media-morph--to-tokens" aria-hidden="true">
          ${waveformMarkup()}
          <span class="media-morph__arrow">→</span>
          ${tokenStreamMarkup()}
        </div>
        <code class="voice-pipeline__metric">${escapeHtml(stt?.packet ?? "")}</code>
      </li>
      <li class="voice-pipeline__stage voice-pipeline__stage--agent" style="--stage-index:3">
        <div class="voice-pipeline__stage-head"><span class="voice-pipeline__step">04</span><span class="voice-pipeline__layer">REASON</span></div>
        <strong class="voice-pipeline__label">${escapeHtml(agent?.label ?? "Tokens + policy")}</strong>
        <span class="voice-pipeline__detail">${escapeHtml(agent?.detail ?? "")}</span>
        <div class="token-policy" aria-hidden="true">
          ${tokenStreamMarkup("media-tokens--policy")}
          <span class="token-policy__hold">policy hold</span>
        </div>
        <code class="voice-pipeline__metric">${escapeHtml(agent?.packet ?? "")}</code>
      </li>
      <li class="voice-pipeline__stage voice-pipeline__stage--tts" style="--stage-index:4">
        <div class="voice-pipeline__stage-head"><span class="voice-pipeline__step">05</span><span class="voice-pipeline__layer">EGRESS</span></div>
        <strong class="voice-pipeline__label">${escapeHtml(tts?.label ?? "Text → audio out")}</strong>
        <span class="voice-pipeline__detail">${escapeHtml(tts?.detail ?? "")}</span>
        <div class="media-morph media-morph--to-audio" aria-hidden="true">
          ${tokenStreamMarkup()}
          <span class="media-morph__arrow">→</span>
          ${waveformMarkup("media-wave--out")}
        </div>
        <div class="egress-fork">
          <span class="egress-chip">SIP RTP adapter</span>
          <span class="egress-chip">WebRTC / fixture proof</span>
        </div>
        <code class="voice-pipeline__metric">${escapeHtml(tts?.packet ?? "")}</code>
      </li>
    </ol>
  </div>
</section></div>`;
}

export function buildClueConHtml(config: PocConfig, mode: "scroll" | "present", brainBlocks?: ClueConBrainBlock[]): string {
  const payload = buildClueConPayload(config, brainBlocks);
  const data = JSON.stringify(payload);
  const bodyClass = mode === "present" ? "present" : "scroll";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(payload.title)}</title>
  <style>
    :root { --bg: #f5f7f8; --panel: #fff; --ink: #17202a; --muted: #5d6b78; --line: #d8e0e7; --teal: #0f766e; --blue: #2457a6; --red: #b42318; --amber: #9a5b04; --green: #167247; --shadow: 0 14px 34px rgba(20, 34, 46, 0.09); }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    a { color: var(--blue); font-weight: 750; text-decoration: none; }
    button, textarea { font: inherit; }
    button { min-height: 38px; border: 1px solid #b9c6d2; border-radius: 6px; background: #fff; color: var(--ink); font-weight: 760; cursor: pointer; }
    button.primary { background: var(--teal); border-color: var(--teal); color: #fff; }
    button.danger { color: var(--red); border-color: #efb4ac; background: #fff4f2; }
    button:disabled { opacity: 0.52; cursor: wait; }
    .topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 22px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.96); backdrop-filter: blur(12px); }
    .brand { display: grid; gap: 2px; min-width: 240px; }
    .kicker { color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
    h1, h2, h3, p { margin-top: 0; letter-spacing: 0; }
    h1, h2 { text-wrap: balance; }
    h1 { max-width: 980px; font-size: clamp(36px, 7vw, 78px); line-height: .96; margin-bottom: 14px; }
    h2 { max-width: 920px; font-size: clamp(28px, 4vw, 48px); line-height: 1.02; margin-bottom: 6px; }
    h3 { font-size: 15px; margin-bottom: 8px; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: flex-end; }
    .toolbar a, .mode-link { display: inline-flex; align-items: center; min-height: 36px; padding: 0 10px; border: 1px solid #b9c6d2; border-radius: 6px; background: #fff; color: var(--ink); font-size: 13px; }
    .hero, .slide { min-height: calc(100vh - 62px); padding: 48px clamp(18px, 5vw, 72px); display: grid; align-content: center; gap: 16px; border-bottom: 1px solid var(--line); }
    .hero { background: linear-gradient(180deg, #ffffff 0%, #eef4f4 100%); }
    .subhead { max-width: 760px; margin-bottom: 2px; color: #334155; font-size: clamp(17px, 1.8vw, 22px); line-height: 1.34; }
    .section-band { padding: 36px clamp(18px, 5vw, 72px); border-bottom: 1px solid var(--line); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, .8fr); gap: 18px; align-items: start; }
    .card { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: var(--panel); box-shadow: var(--shadow); min-width: 0; }
    .plain { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: #fff; min-width: 0; }
    .metric { display: grid; gap: 5px; }
    .metric strong { font-size: 20px; overflow-wrap: anywhere; }
    .muted { color: var(--muted); font-size: 13px; line-height: 1.42; }
    code, pre, textarea { font-variant-ligatures: none; }
    .badge { display: inline-flex; min-height: 24px; align-items: center; width: fit-content; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; font-weight: 800; }
    .ready { color: var(--green); background: #ecfdf3; border-color: #a8ddb8; }
    .fixture { color: var(--amber); background: #fff8e8; border-color: #f2c879; }
    .blocked { color: var(--red); background: #fff2f0; border-color: #f0b8b2; }
    .arch { width: 100%; min-height: 300px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
    .node { fill: #fff; stroke: #bac6d1; stroke-width: 2; }
    .nodeAccent { fill: #e8f5f2; stroke: #0f766e; stroke-width: 2; }
    .nodeWarn { fill: #fff8e8; stroke: #9a5b04; stroke-width: 2; }
    .label { font: 800 15px system-ui,sans-serif; fill: #17202a; }
    .small { font: 650 12px system-ui,sans-serif; fill: #5d6b78; }
    .line { stroke: #2457a6; stroke-width: 2.8; fill: none; marker-end: url(#arrow); }
    .flow-hero { align-content: start; min-height: calc(100vh - 62px); gap: 20px; }
    .flow-header { display: grid; gap: 8px; max-width: 920px; }
    .flow-header h1 { font-size: clamp(32px, 5vw, 58px); line-height: 1; margin-bottom: 0; }
    .flow-header .subhead { max-width: 720px; font-size: clamp(16px, 1.5vw, 20px); }
    .realtime-flow { display: grid; gap: 14px; width: 100%; }
    .voice-pipeline { position: relative; overflow: hidden; border: 1px solid rgba(34, 211, 238, 0.28); border-radius: 18px; background: radial-gradient(circle at 12% 0%, rgba(34, 211, 238, 0.14), transparent 34%), radial-gradient(circle at 88% 100%, rgba(168, 85, 247, 0.16), transparent 32%), linear-gradient(180deg, #07111f 0%, #0a1628 52%, #060d18 100%); box-shadow: 0 28px 70px rgba(8, 20, 40, 0.28), inset 0 1px 0 rgba(148, 163, 184, 0.08); color: #e8f4ff; }
    .voice-pipeline::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: 0.22; background-image: linear-gradient(rgba(148, 163, 184, 0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(148, 163, 184, 0.12) 1px, transparent 1px); background-size: 34px 34px; mask-image: linear-gradient(to bottom, black, transparent 88%); }
    .voice-pipeline__chrome { position: relative; z-index: 1; display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 12px 18px; padding: 18px 20px 12px; border-bottom: 1px solid rgba(125, 211, 252, 0.14); }
    .voice-pipeline__title { display: grid; gap: 4px; max-width: 820px; }
    .voice-pipeline__eyebrow { color: #67e8f9; font-size: 11px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
    .voice-pipeline__title strong { font-size: clamp(17px, 2.1vw, 23px); line-height: 1.2; letter-spacing: -0.02em; }
    .voice-pipeline__meta { display: flex; flex-wrap: wrap; gap: 8px; }
    .voice-pipeline__meta span { display: inline-flex; align-items: center; min-height: 28px; padding: 0 10px; border: 1px solid rgba(125, 211, 252, 0.22); border-radius: 999px; background: rgba(8, 31, 53, 0.72); color: #bfdbfe; font-size: 12px; font-weight: 760; }
    .voice-pipeline__canvas { position: relative; z-index: 1; padding: 10px 14px 18px; }
    .xform-rail { position: absolute; left: 18px; right: 18px; top: 18px; height: 42px; border-radius: 999px; background: linear-gradient(90deg, rgba(34, 211, 238, 0.12), rgba(129, 140, 248, 0.16), rgba(251, 191, 36, 0.14), rgba(52, 211, 153, 0.16)); border: 1px solid rgba(148, 163, 184, 0.14); overflow: hidden; pointer-events: none; }
    .xform-carrier { position: absolute; top: 5px; left: 10px; width: 118px; height: 30px; display: grid; place-items: center; animation: carrierTravel 7.5s cubic-bezier(.45,.05,.55,.95) infinite; }
    .xform-form { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0; transform: scale(.92); }
    .xform-form--wave { animation: formWave 7.5s linear infinite; }
    .xform-form--pcm { animation: formPcm 7.5s linear infinite; color: #67e8f9; font: 800 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .08em; }
    .xform-form--tokens { animation: formTokens 7.5s linear infinite; }
    .xform-form--out { animation: formOut 7.5s linear infinite; }
    .voice-pipeline__stages { position: relative; z-index: 2; display: grid; grid-template-columns: 1.25fr 1fr 1fr 0.95fr 1.15fr; gap: 10px; list-style: none; margin: 0; padding: 58px 4px 0; }
    .voice-pipeline__stage { position: relative; display: grid; gap: 9px; align-content: start; min-height: 220px; padding: 15px; border: 1px solid rgba(148, 163, 184, 0.18); border-radius: 14px; background: linear-gradient(180deg, rgba(15, 27, 50, 0.94), rgba(8, 17, 33, 0.96)); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 16px 34px rgba(0, 0, 0, 0.22); overflow: hidden; }
    .voice-pipeline__stage::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; background: var(--stage-accent, #22d3ee); }
    .voice-pipeline__stage--audio_in { --stage-accent: #22d3ee; }
    .voice-pipeline__stage--transport { --stage-accent: #38bdf8; }
    .voice-pipeline__stage--stt { --stage-accent: #818cf8; }
    .voice-pipeline__stage--agent { --stage-accent: #fbbf24; }
    .voice-pipeline__stage--tts { --stage-accent: #34d399; }
    .voice-pipeline__stage-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .voice-pipeline__step { color: #94a3b8; font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0.08em; }
    .voice-pipeline__layer { display: inline-flex; align-items: center; min-height: 22px; padding: 0 8px; border-radius: 999px; border: 1px solid rgba(125, 211, 252, 0.18); background: rgba(3, 10, 24, 0.72); color: #cbd5e1; font-size: 10px; font-weight: 800; letter-spacing: 0.12em; }
    .voice-pipeline__label { font-size: 16px; line-height: 1.2; color: #f8fafc; }
    .voice-pipeline__detail { display: none; }
    .voice-pipeline__metric { margin-top: auto; display: inline-flex; align-items: center; width: fit-content; max-width: 100%; padding: 6px 9px; border-radius: 8px; background: rgba(2, 6, 23, 0.82); border: 1px solid rgba(125, 211, 252, 0.16); color: #7dd3fc; font: 750 11.5px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .ingress-fork { display: grid; gap: 6px; }
    .ingress-lane { display: grid; gap: 3px; padding: 8px; border-radius: 10px; border: 1px solid rgba(125, 211, 252, 0.16); background: rgba(2, 8, 20, 0.72); }
    .ingress-lane--sip { border-color: rgba(34, 211, 238, 0.28); }
    .ingress-lane--webrtc { border-color: rgba(129, 140, 248, 0.3); }
    .ingress-lane__name { color: #e2e8f0; font-size: 11px; font-weight: 800; }
    .ingress-lane__codec { color: #94a3b8; font: 650 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .ingress-or { color: #64748b; font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; text-align: center; }
    .codec-bridge { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .codec-chip { display: inline-flex; min-height: 24px; align-items: center; padding: 0 8px; border-radius: 999px; border: 1px solid rgba(148, 163, 184, 0.24); background: rgba(15, 23, 42, 0.8); color: #cbd5e1; font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .codec-chip--target { color: #67e8f9; border-color: rgba(34, 211, 238, 0.45); box-shadow: 0 0 16px rgba(34, 211, 238, 0.18); }
    .codec-arrow { color: #64748b; font-weight: 800; }
    .transport-tag { display: inline-flex; width: fit-content; min-height: 24px; align-items: center; padding: 0 9px; border-radius: 8px; background: rgba(14, 116, 144, 0.28); border: 1px solid rgba(34, 211, 238, 0.28); color: #a5f3fc; font-size: 11px; font-weight: 760; }
    .media-wave { display: flex; align-items: end; gap: 2px; height: 28px; }
    .media-wave__bar { width: 3px; height: var(--bar-h, 12px); border-radius: 99px; background: currentColor; opacity: .85; transform-origin: bottom; animation: waveBeat 1.1s ease-in-out infinite; animation-delay: calc(var(--bar-i, 0) * 0.07s); }
    .media-wave--sip { color: #22d3ee; }
    .media-wave--webrtc { color: #818cf8; }
    .media-wave--out { color: #34d399; }
    .media-wave--carrier { color: #67e8f9; height: 22px; }
    .media-tokens { display: flex; flex-wrap: wrap; gap: 4px; }
    .media-tokens__chip { display: inline-flex; align-items: center; min-height: 20px; padding: 0 6px; border-radius: 6px; background: rgba(129, 140, 248, 0.18); border: 1px solid rgba(165, 180, 252, 0.28); color: #ddd6fe; font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; animation: chipPulse 1.8s ease-in-out infinite; animation-delay: calc(var(--chip-i, 0) * 0.12s); }
    .media-tokens--policy .media-tokens__chip { background: rgba(251, 191, 36, 0.14); border-color: rgba(251, 191, 36, 0.3); color: #fde68a; }
    .media-tokens--carrier .media-tokens__chip { min-height: 18px; font-size: 9px; }
    .media-morph { display: grid; grid-template-columns: 1fr auto 1fr; gap: 6px; align-items: center; padding: 8px; border-radius: 10px; background: rgba(2, 8, 20, 0.66); border: 1px solid rgba(148, 163, 184, 0.14); }
    .media-morph__arrow { color: #94a3b8; font-weight: 800; }
    .token-policy { display: grid; gap: 6px; padding: 8px; border-radius: 10px; background: rgba(2, 8, 20, 0.66); border: 1px solid rgba(251, 191, 36, 0.2); }
    .token-policy__hold { display: inline-flex; width: fit-content; min-height: 22px; align-items: center; padding: 0 8px; border-radius: 999px; background: rgba(251, 191, 36, 0.14); border: 1px solid rgba(251, 191, 36, 0.35); color: #fde68a; font-size: 10px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
    .egress-fork { display: flex; flex-wrap: wrap; gap: 6px; }
    .egress-chip { display: inline-flex; min-height: 22px; align-items: center; padding: 0 8px; border-radius: 999px; border: 1px solid rgba(52, 211, 153, 0.3); background: rgba(6, 78, 59, 0.28); color: #a7f3d0; font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    @keyframes carrierTravel { 0% { left: 2%; } 100% { left: calc(100% - 130px); } }
    @keyframes formWave { 0%, 18% { opacity: 1; transform: scale(1); } 24%, 100% { opacity: 0; transform: scale(.9); } }
    @keyframes formPcm { 0%, 20% { opacity: 0; transform: scale(.9); } 26%, 40% { opacity: 1; transform: scale(1); } 46%, 100% { opacity: 0; transform: scale(.9); } }
    @keyframes formTokens { 0%, 42% { opacity: 0; transform: scale(.9); } 48%, 72% { opacity: 1; transform: scale(1); } 78%, 100% { opacity: 0; transform: scale(.9); } }
    @keyframes formOut { 0%, 74% { opacity: 0; transform: scale(.9); } 80%, 100% { opacity: 1; transform: scale(1); } }
    @keyframes waveBeat { 0%, 100% { transform: scaleY(.55); } 50% { transform: scaleY(1); } }
    @keyframes chipPulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
    .contrast-grid { display: grid; grid-template-columns: minmax(0,1fr) auto minmax(0,1fr); gap: 16px; align-items: stretch; }
    .contrast-card { position: relative; display: grid; gap: 12px; align-content: start; min-height: 300px; padding: 20px; overflow: hidden; border: 1px solid var(--line); border-radius: 18px; background: var(--panel); box-shadow: var(--shadow); }
    .contrast-card::before { content: ""; position: absolute; inset: 0 0 auto; height: 4px; background: var(--contrast, var(--blue)); }
    .contrast-card--telephony { --contrast: #22d3ee; }
    .contrast-card--ai { --contrast: #a855f7; }
    .contrast-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .contrast-head strong { font-size: clamp(20px,2.2vw,30px); }
    .certainty { font: 750 12px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color: var(--muted); }
    .contrast-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
    .contrast-list li { display: grid; grid-template-columns: 82px minmax(0,1fr); gap: 12px; padding: 13px 0; border-top: 1px solid var(--line); }
    .contrast-list strong { color: var(--ink); font-size: 14px; }
    .contrast-list span { color: var(--muted); font-size: 14px; line-height: 1.35; }
    .versus { align-self: center; display: grid; place-items: center; width: 54px; height: 54px; border: 1px solid var(--line); border-radius: 50%; background: var(--bg); color: var(--muted); font: 850 12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .takeaway { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 1px solid rgba(15,118,110,.3); border-radius: 12px; background: rgba(15,118,110,.08); color: var(--ink); font-size: clamp(15px,1.6vw,20px); font-weight: 760; }
    .takeaway::before { content: "→"; color: var(--teal); font-size: 25px; }
    .machine-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; }
    .machine { display: grid; gap: 12px; padding: 18px; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); box-shadow: var(--shadow); }
    .machine-head { display: flex; align-items: start; justify-content: space-between; gap: 10px; }
    .machine-head strong { display: block; font-size: clamp(20px,2.2vw,29px); }
    .machine-head span { color: var(--muted); font-size: 13px; }
    .machine-clock { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 6px; }
    .clock-tick { display: grid; gap: 4px; min-width: 0; padding: 9px 7px; border: 1px solid var(--line); border-radius: 9px; background: rgba(36,87,166,.05); text-align: center; }
    .clock-tick strong { color: var(--blue); font: 800 13px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .clock-tick span { color: var(--muted); font: 650 11px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow-wrap: anywhere; }
    .machine--ai .clock-tick { background: rgba(168,85,247,.06); }
    .machine--ai .clock-tick strong { color: #9333ea; }
    .machine-rules { display: grid; gap: 8px; }
    .machine-rule { display: flex; justify-content: space-between; gap: 14px; padding: 9px 0; border-top: 1px solid var(--line); font-size: 13px; }
    .machine-rule span { color: var(--muted); text-align: right; }
    .boundary-strip { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center; }
    .boundary-side { padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); font-size: 13px; text-align: center; }
    .boundary-side strong { display: block; margin-bottom: 3px; font-size: 15px; }
    .boundary-gate { padding: 7px 10px; border-radius: 999px; background: var(--amber); color: #fff; font-size: 11px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    .vad-layout { display: grid; grid-template-columns: minmax(320px,.82fr) minmax(0,1.4fr); gap: 16px; align-items: stretch; }
    .vad-console { display: grid; gap: 12px; align-content: start; padding: 18px; border: 1px solid rgba(34,211,238,.26); border-radius: 16px; background: linear-gradient(180deg,#081526,#050b16); color: #e8f4ff; box-shadow: 0 24px 56px rgba(8,20,40,.25); }
    .vad-console-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .vad-console-head strong { font-size: 18px; }
    .vad-meter { position: relative; height: 70px; overflow: hidden; border: 1px solid rgba(125,211,252,.2); border-radius: 12px; background: linear-gradient(90deg,rgba(52,211,153,.08),rgba(251,191,36,.12),rgba(251,113,133,.12)); }
    .vad-meter-fill { position: absolute; inset: 0 auto 0 0; width: 0%; background: linear-gradient(90deg,rgba(34,211,238,.28),rgba(52,211,153,.62)); transition: width 60ms linear; }
    .vad-threshold { position: absolute; top: 0; bottom: 0; left: 56%; width: 2px; background: #fbbf24; box-shadow: 0 0 14px rgba(251,191,36,.7); }
    .vad-meter-label { position: absolute; inset: 0; display: grid; place-items: center; color: #f8fafc; font: 800 18px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; text-shadow: 0 2px 8px #000; }
    .vad-slider { display: grid; gap: 5px; }
    .vad-slider label { display: flex; justify-content: space-between; gap: 10px; color: #9db0c5; font-size: 12px; }
    .vad-slider input { width: 100%; accent-color: #22d3ee; }
    .vad-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .vad-actions button { min-height: 44px; }
    .vad-note { color: #94a3b8; font-size: 12px; line-height: 1.4; }
    .vad-events { display: grid; gap: 6px; min-height: 150px; max-height: 230px; overflow: auto; padding-right: 2px; }
    .vad-event { display: grid; grid-template-columns: 72px minmax(0,1fr); gap: 8px; padding: 8px; border: 1px solid rgba(148,163,184,.16); border-radius: 8px; background: rgba(15,23,42,.58); }
    .vad-event code { color: #67e8f9; font-size: 11px; }
    .vad-event span { color: #cbd5e1; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
    .pipeline-panel { display: grid; gap: 12px; align-content: start; padding: 18px; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); box-shadow: var(--shadow); }
    .pipeline-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .pipeline-panel-head strong { font-size: 18px; }
    .pipecat-flow { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 8px; }
    .pipecat-node { position: relative; display: grid; gap: 8px; align-content: start; min-height: 145px; padding: 13px; border: 1px solid var(--line); border-radius: 12px; background: rgba(36,87,166,.04); transition: border-color .14s,background .14s,transform .14s,box-shadow .14s; }
    .pipecat-node:not(:last-child)::after { content: "→"; position: absolute; z-index: 2; top: 50%; right: -13px; transform: translateY(-50%); color: var(--muted); font-weight: 900; }
    .pipecat-node small { color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .pipecat-node strong { font-size: 14px; }
    .pipecat-node code { color: var(--blue); font-size: 11.5px; line-height: 1.5; overflow-wrap: anywhere; }
    .pipecat-node.active { border-color: #22d3ee; background: rgba(34,211,238,.1); transform: translateY(-2px); box-shadow: 0 12px 28px rgba(34,211,238,.14); }
    .pipecat-node.speaking { border-color: #34d399; background: rgba(52,211,153,.1); }
    .pipecat-node.interrupted { border-color: #fb7185; background: rgba(251,113,133,.12); animation: interruptFlash .55s ease 2; }
    .pipeline-truths { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 8px; }
    .pipeline-truth { padding: 11px; border: 1px solid var(--line); border-radius: 9px; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .pipeline-truth strong { display: block; margin-bottom: 4px; color: var(--ink); font-size: 13px; }
    .turn-diagram { padding: 10px; border: 1px solid var(--line); border-radius: 9px; background: #fff; }
    .turn-diagram svg { display: block; width: 100%; height: auto; min-height: 126px; }
    .turn-diagram .axis { stroke: #94a3b8; stroke-width: 2; }
    .turn-diagram .speech { fill: rgba(34,211,238,.22); stroke: #0891b2; stroke-width: 2; }
    .turn-diagram .silence { fill: rgba(251,191,36,.18); stroke: #9a5b04; stroke-width: 2; stroke-dasharray: 5 5; }
    .turn-diagram .output { fill: rgba(52,211,153,.2); stroke: #167247; stroke-width: 2; }
    .turn-diagram .eot { stroke: #b42318; stroke-width: 3; }
    .turn-diagram text { fill: var(--muted); font: 700 12px system-ui,sans-serif; }
    .turn-diagram .label-strong { fill: var(--ink); font-weight: 850; }
    .turn-references { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
    .turn-reference { padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: rgba(36,87,166,.04); color: var(--muted); font-size: 12px; line-height: 1.38; }
    .turn-reference strong { display: block; margin-bottom: 3px; color: var(--ink); font-size: 12px; }
    .turn-reference a { color: var(--blue); overflow-wrap: anywhere; }
    @keyframes interruptFlash { 50% { transform: translateY(-3px) scale(1.01); box-shadow: 0 0 28px rgba(251,113,133,.34); } }
    .demo-shell { display: grid; gap: 12px; min-width: 0; }
    .screen { min-height: 360px; border: 1px solid var(--line); border-radius: 8px; background: #101820; color: #dbeafe; padding: 16px; overflow: auto; overflow-wrap: anywhere; font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .timeline { display: grid; gap: 8px; }
    .event { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 12px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
    .event > strong { color: var(--blue); font: 750 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .readiness-card { gap: 9px; box-shadow: none; }
    .readiness-card__head { display: flex; align-items: center; gap: 9px; }
    .readiness-card__head strong { font-size: 16px; }
    .readiness-more summary { width: fit-content; color: var(--blue); font-size: 12px; font-weight: 750; cursor: pointer; }
    .readiness-more .muted { display: block; margin-top: 7px; }
    .proof-field { min-height: 54px; display: grid; place-items: center start; padding: 12px 14px; box-shadow: none; }
    .proof-field strong { font-size: 15px; }
    #demo { align-content: start; }
    #demo .two, #demo .two > *, #demo .timeline, #demo .event, #demo .event > * { min-width: 0; }
    #demo .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(138px, 1fr)); }
    #demo .actions button { width: 100%; padding-inline: 10px; }
    #demo .screen { min-height: clamp(220px, 34vh, 360px); max-height: min(42vh, 440px); white-space: pre-wrap; }
    #demo .screen.has-transcript { display: grid; align-content: start; gap: 10px; white-space: normal; }
    #demo .screen.has-drill { display: grid; align-content: start; gap: 12px; white-space: normal; }
    .drill-summary { color: #f8fafc; font: 800 15px/1.45 system-ui,sans-serif; }
    .drill-boundary { display: grid; gap: 8px; padding: 11px 12px; border: 1px solid rgba(125,211,252,.24); border-radius: 8px; background: rgba(14,116,144,.12); }
    .drill-boundary strong { color: #7dd3fc; font: 800 12px/1.3 system-ui,sans-serif; text-transform: uppercase; letter-spacing: .05em; }
    .drill-boundary span, .drill-patterns { color: #dbeafe; font: 13px/1.48 system-ui,sans-serif; }
    .drill-command { margin: 0; padding: 10px; border-radius: 7px; background: rgba(2,6,18,.86); color: #a7f3d0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .drill-patterns { display: grid; gap: 6px; margin: 0; padding-left: 20px; }
    .drill-hint { margin: -2px 0 0; color: var(--muted); font-size: 12px; line-height: 1.42; }
    .transcript-turn { display: grid; grid-template-columns: minmax(72px, 92px) minmax(0, 1fr); gap: 12px; padding: 11px 12px; border: 1px solid rgba(148,163,184,.24); border-radius: 8px; background: rgba(15,23,42,.72); }
    .transcript-turn__speaker { color: #7dd3fc; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
    .transcript-turn--agent .transcript-turn__speaker { color: #6ee7b7; }
    .transcript-turn__text { color: #e2e8f0; overflow-wrap: anywhere; }
    #demo .timeline { align-content: start; max-height: min(42vh, 440px); overflow: auto; overscroll-behavior: contain; padding-right: 3px; }
    #demo .event { grid-template-columns: minmax(110px, 140px) minmax(0, 1fr); }
    #demo .event strong, #demo .event .muted { overflow-wrap: anywhere; word-break: break-word; }
    .asr-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
    .asr-heading h2 { margin-bottom: 0; }
    .asr-live-lab { position: relative; display: grid; gap: 10px; padding: 14px; border: 1px solid rgba(125,211,252,.18); border-radius: 10px; background: #0b1624; color: #e7f5ff; box-shadow: 0 12px 28px rgba(8,20,40,.16); overflow: hidden; }
    .asr-live-lab::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .06; background-image: linear-gradient(rgba(125,211,252,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(125,211,252,.18) 1px, transparent 1px); background-size: 32px 32px; }
    .asr-live-lab > * { position: relative; z-index: 1; }
    .asr-live-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
    .asr-live-head strong { font-size: 15px; }
    .asr-live-controls { display: grid; grid-template-columns: minmax(180px, 1fr) auto auto; gap: 7px; align-items: end; }
    .asr-live-controls label { display: grid; gap: 3px; }
    .asr-live-controls select { min-width: 0; min-height: 36px; padding: 0 9px; border: 1px solid rgba(125,211,252,.24); border-radius: 7px; background: rgba(2,8,20,.66); color: #e7f5ff; font: 700 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .asr-live-controls button { min-height: 34px; padding: 0 11px; border-radius: 7px; font-size: 12px; }
    .asr-live-wave { height: 42px; display: flex; align-items: center; justify-content: center; gap: 3px; border: 1px solid rgba(125,211,252,.14); border-radius: 8px; background: rgba(2,8,20,.5); color: #38bdf8; }
    .asr-live-wave span { width: 3px; max-height: 30px; border-radius: 99px; background: currentColor; opacity: .4; transform: scaleY(.5); transform-origin: center; }
    .asr-live-wave.recording { color: #34d399; box-shadow: inset 0 0 32px rgba(52,211,153,.1); }
    .asr-live-wave.recording span { opacity: .9; animation: liveAsrWave .72s ease-in-out infinite alternate; animation-delay: calc(var(--wave-i) * 45ms); }
    .asr-live-result { min-height: 88px; margin: 0; padding: 11px; border: 1px solid rgba(125,211,252,.14); border-radius: 8px; background: rgba(2,6,18,.76); color: #d9f7ff; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .asr-live-result.partial { border-color: rgba(52,211,153,.52); box-shadow: inset 0 0 30px rgba(52,211,153,.07); }
    .asr-live-status { color: #9db0c5; font-size: 11px; line-height: 1.35; }
    .asr-events { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .asr-event-pill { display: inline-flex; align-items: center; gap: 6px; min-height: 27px; padding: 3px 9px; border: 1px solid var(--line); border-radius: 999px; background: #fff; color: var(--muted); font-size: 11px; }
    .asr-event-pill strong { color: var(--ink); font-size: 11px; text-transform: uppercase; }
    #asr-benchmarks { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .asr-benchmark-source { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 12px; }
    .asr-benchmark-source > span { display: grid; gap: 2px; }
    .asr-benchmark-source strong { font-size: 14px; }
    .asr-metric-card { padding: 11px; box-shadow: none; }
    .asr-metric-card strong { font-size: clamp(17px, 2vw, 23px); }
    .asr-metric-card .muted { font-size: 11px; }
    .asr-rtf-note { margin: 0 0 10px; font-size: 11px; line-height: 1.4; }
    #asr-benchmarks .asr-rtf-note { grid-column: 1 / -1; margin-bottom: 0; }
    @keyframes liveAsrWave { from { transform: scaleY(.35); } to { transform: scaleY(1.25); } }
    .brain { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
    textarea { width: 100%; min-height: 88px; resize: vertical; border: 1px solid var(--line); border-radius: 7px; padding: 11px; color: var(--ink); font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .proof-pre { margin: 0; min-height: 260px; max-height: 460px; overflow: auto; border-radius: 8px; padding: 15px; background: #0d1117; color: #e6edf3; font: 13px/1.58 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .talk-attribution { margin: 0; color: var(--muted); font-size: 13px; font-weight: 650; letter-spacing: .01em; }
    .slide-status { min-width: 76px; text-align: center; color: var(--muted); font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .present .topbar { position: fixed; width: 100%; }
    .present main { padding-top: 62px; }
    .present .slide, .present .hero { min-height: calc(100vh - 62px); }
    .present #demo { height: calc(100vh - 62px); min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    .present .section-band:not(.active), .present .hero:not(.active) { display: none; }
    @media (max-width: 1100px) { #demo .two { grid-template-columns: minmax(0, 1fr); } .present #demo .screen, .present #demo .timeline { max-height: 360px; } }
    @media (max-width: 920px) { .two, .machine-grid, .vad-layout { grid-template-columns: 1fr; } .contrast-grid { grid-template-columns: 1fr; } .versus { width: auto; height: 34px; border-radius: 999px; } .contrast-card { min-height: 0; } .boundary-strip { grid-template-columns: 1fr; } .boundary-gate { justify-self: center; } .pipecat-flow { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; padding: 2px 2px 8px; } .pipecat-node { flex: 0 0 min(70vw,220px); scroll-snap-align: start; } .pipeline-truths, .turn-references { grid-template-columns: 1fr; } .present .topbar { position: static; width: auto; } .present main { padding-top: 0; } .present .slide, .present .hero { min-height: calc(100vh - 62px); } .present #demo { height: auto; min-height: calc(100vh - 62px); overflow: visible; } .topbar { align-items: stretch; flex-direction: column; } .toolbar { justify-content: flex-start; } .hero, .slide, .section-band { padding: 28px 14px; } h1 { font-size: 38px; } .event, #demo .event { grid-template-columns: minmax(0, 1fr); } #demo .actions { grid-template-columns: repeat(2, minmax(0, 1fr)); } #demo .screen, #demo .timeline, .present #demo .screen, .present #demo .timeline { max-height: min(48vh, 380px); } .asr-live-controls { grid-template-columns: minmax(0, 1fr); } .voice-pipeline__chrome { padding: 16px 14px 10px; } .voice-pipeline__canvas { padding: 8px 8px 14px; } .xform-rail { display: none; } .voice-pipeline__stages { display: flex; gap: 12px; overflow-x: auto; scroll-snap-type: x mandatory; padding: 12px 4px 4px; -webkit-overflow-scrolling: touch; } .voice-pipeline__stage { flex: 0 0 min(82vw, 300px); scroll-snap-align: start; min-height: 260px; } }
    @media (max-width: 520px) { #demo .actions { grid-template-columns: minmax(0, 1fr); } #demo .screen { min-height: 240px; } .transcript-turn { grid-template-columns: minmax(0, 1fr); gap: 4px; } #asr-benchmarks { grid-template-columns: minmax(0, 1fr); } .asr-benchmark-source { grid-column: auto; align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body class="${bodyClass}">
  <header class="topbar"><div class="brand"><span class="kicker">ClueCon 2026 presentation</span><strong>Agentic Contact Center</strong></div><nav class="toolbar" aria-label="ClueCon sections"><a href="/cluecon">Narrative</a><a href="/cluecon/present">Present</a><a href="/operator/console">Operator</a><a href="/assert">Proof</a><button id="prev" type="button" aria-label="Previous slide">Prev</button><span class="slide-status" id="slide-status" aria-live="polite">1 / 9</span><button id="next" type="button" class="primary" aria-label="Next slide">Next</button></nav></header>
  <main>
    <section class="hero flow-hero active" data-slide="0" id="flow"><div class="flow-header"><span class="kicker">Opening</span><h1>One realtime pipeline.</h1><p class="subhead">Browser, fixtures, and SIP enter one Pipecat Pipeline. Policy and proof stay visible.</p><p class="talk-attribution">Alberto Gonzalez CTO @ WebRTC.ventures</p></div>${buildCallFlowMarkup(payload.callFlow)}<div class="actions"><button class="primary" id="run-demo-top" type="button">Run proof</button><button id="open-demo-slide" type="button">Open demo</button></div></section>
    <section class="section-band slide" data-slide="1" id="realtime-problem"><span class="kicker">The realtime systems problem</span><h2>Deterministic telephony meets probabilistic inference.</h2><p class="subhead">Calls require exact state. AI estimates timing and meaning.</p><div class="contrast-grid"><article class="contrast-card contrast-card--telephony"><div class="contrast-head"><strong>Telephony</strong><span class="certainty">STATE IS OBSERVED</span></div><ul class="contrast-list"><li><strong>Protocol</strong><span>INVITE → 200 → ACK → BYE</span></li><li><strong>Media</strong><span>Ordered RTP at a fixed cadence</span></li><li><strong>Failure</strong><span>Timeout, transfer, or hang up</span></li></ul></article><div class="versus">VS</div><article class="contrast-card contrast-card--ai"><div class="contrast-head"><strong>Inference</strong><span class="certainty">MEANING IS ESTIMATED</span></div><ul class="contrast-list"><li><strong>Listen</strong><span>VAD and end-of-turn confidence</span></li><li><strong>Meaning</strong><span>ASR revisions and ambiguous intent</span></li><li><strong>Output</strong><span>Variable latency; plausible can be wrong</span></li></ul></article></div><div class="takeaway">Keep call state deterministic. Bound and expose inference.</div></section>
    <section class="section-band slide" data-slide="2" id="two-machines"><span class="kicker">Two different machines</span><h2>One runs on clocks. One runs on confidence.</h2><p class="subhead">Protect the media clock while AI listens, reasons, and speaks.</p><div class="machine-grid"><article class="machine machine--telephony"><div class="machine-head"><div><strong>SIP / RTP</strong><span>State + packet cadence</span></div><span class="badge ready">bounded</span></div><div class="machine-clock"><div class="clock-tick"><strong>0 ms</strong><span>seq 8041</span></div><div class="clock-tick"><strong>20 ms</strong><span>seq 8042</span></div><div class="clock-tick"><strong>40 ms</strong><span>seq 8043</span></div><div class="clock-tick"><strong>60 ms</strong><span>seq 8044</span></div><div class="clock-tick"><strong>80 ms</strong><span>seq 8045</span></div></div><div class="machine-rules"><div class="machine-rule"><strong>Call</strong><span>explicit state</span></div><div class="machine-rule"><strong>Audio</strong><span>ordered + deadline-driven</span></div><div class="machine-rule"><strong>Recover</strong><span>retransmit · reroute · end</span></div></div></article><article class="machine machine--ai"><div class="machine-head"><div><strong>AI</strong><span>Latency + uncertainty</span></div><span class="badge fixture">variable</span></div><div class="machine-clock"><div class="clock-tick"><strong>~90 ms</strong><span>VAD</span></div><div class="clock-tick"><strong>~250 ms</strong><span>partial</span></div><div class="clock-tick"><strong>~800 ms</strong><span>final</span></div><div class="clock-tick"><strong>~400 ms</strong><span>first token</span></div><div class="clock-tick"><strong>~250 ms</strong><span>audio</span></div></div><div class="machine-rules"><div class="machine-rule"><strong>Turn</strong><span>detected + revised</span></div><div class="machine-rule"><strong>Meaning</strong><span>context-dependent</span></div><div class="machine-rule"><strong>Recover</strong><span>cancel · constrain · hand off</span></div></div></article></div><div class="boundary-strip"><div class="boundary-side"><strong>Never block media</strong>Run call control independently.</div><div class="boundary-gate">contract boundary</div><div class="boundary-side"><strong>Never hide uncertainty</strong>Expose partial, timeout, cancel, and fallback.</div></div></section>
    <section class="section-band slide" data-slide="3" id="vad-interruption"><span class="kicker">VAD, turns, and interruption</span><h2>The smallest signal changes the whole pipeline.</h2><p class="subhead">Start the mic, speak, pause, then interrupt the agent.</p><div class="vad-layout"><div class="vad-console"><div class="vad-console-head"><strong>Browser microphone VAD</strong><span class="badge fixture" id="vad-state">mic off</span></div><div class="vad-meter" aria-label="Live microphone level"><span class="vad-meter-fill" id="vad-meter-fill"></span><span class="vad-threshold" id="vad-threshold-line"></span><span class="vad-meter-label" id="vad-level">−∞ dBFS</span></div><div class="vad-slider"><label for="vad-threshold"><span>Speech threshold</span><strong id="vad-threshold-value">−42 dBFS</strong></label><input id="vad-threshold" type="range" min="-60" max="-20" value="-42" step="1"></div><div class="vad-actions"><button class="primary" id="vad-mic" type="button">Start microphone</button><button id="vad-agent" type="button">Play agent → interrupt</button><button id="vad-simulate" type="button">Simulate barge-in</button><button id="vad-reset" type="button">Reset</button></div><div class="vad-note">80 ms start · 350 ms acoustic stop · 2 s end-of-turn window. VAD hears activity; turn detection decides “done.”</div><div class="vad-events" id="vad-events" aria-live="polite"><div class="vad-event"><code>READY</code><span>Start the mic or simulate barge-in.</span></div></div></div><div class="pipeline-panel"><div class="pipeline-panel-head"><strong>Pipecat control path</strong><span class="badge ready">interruptions on</span></div><div class="pipecat-flow"><div class="pipecat-node" id="vad-node-input"><small>Transport</small><strong>Audio input</strong><code>InputAudioRawFrame</code></div><div class="pipecat-node" id="vad-node-turn"><small>User aggregator</small><strong>VAD + turn</strong><code>VADUserStartedSpeakingFrame<br>UserStartedSpeakingFrame</code></div><div class="pipecat-node" id="vad-node-stt"><small>rtc-asr</small><strong>Speech → text</strong><code>InterimTranscriptionFrame<br>TranscriptionFrame</code></div><div class="pipecat-node" id="vad-node-agent"><small>ACC</small><strong>Policy + tools</strong><code>LLM / tools / operator hold</code></div><div class="pipecat-node" id="vad-node-output"><small>Kokoro + transport</small><strong>Audio output</strong><code>TTSAudioRawFrame<br>InterruptionFrame clears queue</code></div></div><div class="turn-diagram" aria-label="End-of-turn timing diagram"><svg viewBox="0 0 760 156" role="img" aria-label="Speech activity, two second silence window, ACC policy processing, then audio output"><line class="axis" x1="34" y1="84" x2="722" y2="84"/><rect class="speech" x="62" y="50" width="218" height="68" rx="7"/><rect class="silence" x="280" y="50" width="292" height="68" rx="7"/><line class="eot" x1="572" y1="36" x2="572" y2="128"/><rect class="output" x="604" y="50" width="104" height="68" rx="7"/><text class="label-strong" x="171" y="41" text-anchor="middle">user speech</text><text x="426" y="41" text-anchor="middle">ACC policy + turn wait: 2 s</text><text class="label-strong" x="572" y="144" text-anchor="middle">end-of-turn</text><text class="label-strong" x="656" y="41" text-anchor="middle">audio out</text><text x="78" y="102">VAD start</text><text x="302" y="102">policy can run</text><text x="617" y="102">TTS eligible</text></svg></div><div class="pipeline-truths"><div class="pipeline-truth"><strong>Start is urgent</strong>Speech cancels queued bot output.</div><div class="pipeline-truth"><strong>Policy runs early</strong>ACC policy + tools can highlight while output waits.</div><div class="pipeline-truth"><strong>End is guarded</strong>Audio output waits for 2 s of silence.</div></div><div class="turn-references"><div class="turn-reference"><strong>Pipecat turn starts</strong><a href="https://docs.pipecat.ai/api-reference/server/utilities/turn-management/user-turn-strategies#minwordsuserturnstartstrategy" target="_blank" rel="noreferrer">MinWordsUserTurnStartStrategy</a> can avoid tiny backchannels triggering interruption.</div><div class="turn-reference"><strong>Pipecat smart-turn</strong><a href="https://github.com/pipecat-ai/smart-turn" target="_blank" rel="noreferrer">smart-turn</a> models semantic turn completion instead of treating every pause as done.</div><div class="turn-reference"><strong>VAD alternatives</strong><a href="https://github.com/TEN-framework/ten-vad" target="_blank" rel="noreferrer">TEN-vad</a>, <a href="https://github.com/snakers4/silero-vad" target="_blank" rel="noreferrer">Silero VAD</a>, and <a href="https://github.com/livekit/agents/tree/main/livekit-plugins/livekit-plugins-turn-detector" target="_blank" rel="noreferrer">livekit-turn-detector</a> are swappable turn-detection inputs.</div><div class="turn-reference"><strong>Latency budget</strong>End-of-turn quality matters because waiting too long feels slow, but replying too early causes interruptions.</div></div></div></div></section>
    <section class="section-band slide" data-slide="4" id="map"><div class="two"><div><span class="kicker">System map</span><h2>#222 is the architecture.</h2><p class="subhead">Browser, fixtures, and SIP are adapters around the same Pipecat Pipeline.</p><svg class="arch" viewBox="0 0 980 380" role="img" aria-label="Shared voice pipeline architecture"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#2457a6"/></marker></defs><rect class="nodeAccent" x="24" y="74" width="130" height="74" rx="8"/><text class="label" x="89" y="105" text-anchor="middle">Caller</text><text class="small" x="89" y="126" text-anchor="middle">SIP / browser</text><rect class="node" x="194" y="74" width="132" height="74" rx="8"/><text class="label" x="260" y="105" text-anchor="middle">Pipecat</text><text class="small" x="260" y="126" text-anchor="middle">Pipeline</text><rect class="nodeWarn" x="366" y="74" width="132" height="74" rx="8"/><text class="label" x="432" y="105" text-anchor="middle">rtc-asr</text><text class="small" x="432" y="126" text-anchor="middle">Local STT v1</text><rect class="nodeAccent" x="538" y="74" width="144" height="74" rx="8"/><text class="label" x="610" y="105" text-anchor="middle">Agent</text><text class="small" x="610" y="126" text-anchor="middle">policy + tools</text><rect class="nodeWarn" x="722" y="74" width="112" height="74" rx="8"/><text class="label" x="778" y="105" text-anchor="middle">Kokoro</text><text class="small" x="778" y="126" text-anchor="middle">TTS</text><rect class="node" x="298" y="236" width="160" height="78" rx="8"/><text class="label" x="378" y="267" text-anchor="middle">Operator</text><text class="small" x="378" y="288" text-anchor="middle">approve / handoff</text><rect class="nodeAccent" x="536" y="236" width="158" height="78" rx="8"/><text class="label" x="615" y="267" text-anchor="middle">Proof bundle</text><text class="small" x="615" y="288" text-anchor="middle">events + latency</text><rect class="nodeAccent" x="748" y="236" width="160" height="78" rx="8"/><text class="label" x="828" y="267" text-anchor="middle">ASSERT eval</text><text class="small" x="828" y="288" text-anchor="middle">scorecard</text><path class="line" d="M154 111 H194"/><path class="line" d="M326 111 H366"/><path class="line" d="M498 111 H538"/><path class="line" d="M682 111 H722"/><path class="line" d="M610 148 V236"/><path class="line" d="M694 275 H748"/><path class="line" d="M458 275 H536"/><path class="line" d="M378 236 C412 184 496 154 538 126"/></svg></div><div class="grid" id="readiness"></div></div></section>
    <section class="section-band slide" data-slide="5" id="demo"><span class="kicker">Live demo</span><h2>Cancellation rescue, end to end.</h2><p class="subhead">Policy hold → operator approval → wrap → evidence.</p><div class="two"><div class="demo-shell"><div class="actions"><button class="primary" id="run-demo" type="button">Run scripted demo</button><button id="drill-tool" type="button" class="danger">Tool timeout</button><button id="drill-runtime" type="button" class="danger">Runtime failure</button><button id="drill-transfer" type="button">Transfer</button><button id="drill-takeover" type="button">Takeover</button><button id="drill-end" type="button">End call</button><button id="drill-asr" type="button">ASR unavailable</button><button id="drill-tts" type="button">TTS unavailable</button></div><p class="drill-hint">Operator actions cross a control boundary: ACC emits auditable JSON; FreeSWITCH or another SIP/media server executes transfer, bridge, takeover, or BYE using established telephony patterns.</p><div class="screen" id="demo-screen">Ready. No external credentials required.</div></div><div class="timeline" id="timeline"></div></div></section>
    <section class="section-band slide" data-slide="6" id="asr"><span class="kicker">Live ASR lab</span><div class="asr-heading"><h2>rtc-asr is measurable and swappable.</h2><div class="actions"><a class="mode-link" href="${payload.asrPanel.pipecatDemoUrl}" target="_blank" rel="noreferrer">Source ↗</a><a class="mode-link" href="${payload.asrPanel.benchmarkUrl}" target="_blank" rel="noreferrer">Benchmarks ↗</a></div></div><p class="subhead">Watch partials evolve or record a six-second batch.</p><p class="asr-rtf-note muted">RTF = processing time ÷ audio duration. Lower is better; &lt;1× is faster than realtime.</p><div class="two"><div><div class="asr-live-lab"><div class="asr-live-head"><strong>Mic → Local STT → transcript</strong><span class="badge fixture" id="asr-live-badge">checking sidecar</span></div><div class="asr-live-controls"><label><span class="muted">Model</span><select id="asr-model-select" aria-label="rtc-asr model target" disabled><option>Loading models…</option></select></label><button class="primary" id="asr-realtime" type="button" disabled>Start realtime</button><button id="asr-record" type="button" disabled>Batch 6 seconds</button></div><div class="asr-live-wave" id="asr-live-wave" aria-hidden="true"><span style="--wave-i:0;height:12px"></span><span style="--wave-i:1;height:28px"></span><span style="--wave-i:2;height:18px"></span><span style="--wave-i:3;height:42px"></span><span style="--wave-i:4;height:22px"></span><span style="--wave-i:5;height:34px"></span><span style="--wave-i:6;height:16px"></span><span style="--wave-i:7;height:38px"></span><span style="--wave-i:8;height:24px"></span><span style="--wave-i:9;height:46px"></span><span style="--wave-i:10;height:20px"></span><span style="--wave-i:11;height:32px"></span><span style="--wave-i:12;height:14px"></span><span style="--wave-i:13;height:36px"></span><span style="--wave-i:14;height:26px"></span><span style="--wave-i:15;height:40px"></span></div><span class="asr-live-status" id="asr-live-status" aria-live="polite">Waiting for rtc-asr.</span><pre class="asr-live-result" id="asr-live-result">Partial and final transcripts appear here.</pre></div><div class="asr-events" id="asr-events"></div></div><div class="grid" id="asr-benchmarks"></div></div></section>
    <section class="section-band slide" data-slide="7" id="agent"><span class="kicker">Agent harness</span><h2>Policy stays inspectable.</h2><p class="subhead">Mission, tools, fallback, and eval rules remain explicit.</p><div class="plain" id="brain-state"></div><div class="brain" id="brain"></div><div class="actions"><button id="preview-brain" type="button">Preview</button><button id="apply-brain" type="button" class="primary">Apply</button><button id="reset-brain" type="button">Reset</button></div></section>
    <section class="section-band slide" data-slide="8" id="proof"><span class="kicker">Close</span><h2>The talk ends at proof.</h2><p class="subhead">Transcript + actions + latency + fallback + final state.</p><div class="actions"><button id="run-eval" type="button" class="primary">Run eval</button><a class="mode-link" href="/assert">ASSERT viewer ↗</a></div><div class="two"><div><div class="grid" id="proof-cards"></div><div class="timeline" id="eval-scorecard"></div></div><pre class="proof-pre" id="proof-json">Run the demo to generate proof.</pre></div></section>
  </main>
  <script>window.__CLUECON__ = ${data};</script>
  <script>
    let data = window.__CLUECON__;
    const state = { slide: 0, slideCount: 9, isPresent: document.body.classList.contains("present"), proof: null, brain: JSON.parse(JSON.stringify(data.brainBlocks)), brainSession: null, asrCapture: null, asrStopping: false, asrModels: [], asrLive: null, vad: null, vadStarting: false, vadStartToken: 0, vadPendingStream: null, vadBotSpeaking: false, vadBotTimer: null, vadTurnTimer: null, vadOutputTimer: null, vadOutputCleanupTimer: null, vadSimulationTimers: [] };
    const VAD_END_OF_TURN_MS = Number(data.turnTiming?.endOfTurnSilenceMs) || 2000;
    function esc(value) { return String(value).replace(/[&<>\"]/g, c => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"); }
    function vadLog(type, detail) { const events = document.getElementById("vad-events"); const row = document.createElement("div"); row.className = "vad-event"; const now = new Date(); const stamp = now.toLocaleTimeString([], { minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }); row.innerHTML = '<code>' + esc(stamp) + '</code><span><strong>' + esc(type) + '</strong><br>' + esc(detail) + '</span>'; events.prepend(row); while (events.children.length > 8) events.lastElementChild.remove(); }
    function vadStatus(label, tone) { const badge = document.getElementById("vad-state"); badge.textContent = label; badge.className = "badge " + (tone || "fixture"); }
    function vadNodes(active, speaking, interrupted) { document.querySelectorAll(".pipecat-node").forEach(node => { node.classList.toggle("active", active.includes(node.id)); node.classList.toggle("speaking", speaking === node.id); node.classList.toggle("interrupted", interrupted === node.id); }); }
    function clearVadTurnTimers() { clearTimeout(state.vadTurnTimer); clearTimeout(state.vadOutputTimer); clearTimeout(state.vadOutputCleanupTimer); state.vadTurnTimer = null; state.vadOutputTimer = null; state.vadOutputCleanupTimer = null; }
    function clearVadSimulationTimers() { state.vadSimulationTimers.forEach(timer => clearTimeout(timer)); state.vadSimulationTimers = []; }
    function updateVadThreshold() { const input = document.getElementById("vad-threshold"); const threshold = Number(input.value); document.getElementById("vad-threshold-value").textContent = threshold + " dBFS"; document.getElementById("vad-threshold-line").style.left = Math.max(0, Math.min(100, (threshold + 70) / 60 * 100)) + "%"; return threshold; }
    function stopVadBot(interrupted) { if (!state.vadBotSpeaking) return; state.vadBotSpeaking = false; clearTimeout(state.vadBotTimer); state.vadBotTimer = null; if ("speechSynthesis" in window) window.speechSynthesis.cancel(); document.getElementById("vad-agent").textContent = "Play agent → interrupt"; if (interrupted) { vadLog("InterruptionFrame", "User speech cancels queued text and bot audio immediately."); vadNodes(["vad-node-input", "vad-node-turn"], null, "vad-node-output"); setTimeout(() => { if (!state.vadTurnTimer) vadNodes(state.vad ? ["vad-node-input", "vad-node-turn"] : [], null, null); }, 900); } else { vadLog("TTSStoppedFrame", "Agent output queue completed."); vadNodes(state.vad ? ["vad-node-input"] : [], null, null); } }
    function startVadBot() { if (state.vadBotSpeaking) { stopVadBot(false); return; } if (state.vadTurnTimer) { vadLog("OUTPUT_BLOCKED", "Agent audio cannot start while the 2 s end-of-turn gate is still pending."); vadStatus("turn wait: 2.0 s", "fixture"); return; } state.vadBotSpeaking = true; document.getElementById("vad-agent").textContent = "Stop agent speech"; vadStatus("agent speaking", "ready"); vadNodes(state.vad ? ["vad-node-input"] : [], "vad-node-output", null); vadLog("TTSStartedFrame", "Agent audio is flowing. Speak now to demonstrate barge-in."); const finish = () => stopVadBot(false); if ("speechSynthesis" in window && window.SpeechSynthesisUtterance) { window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance("I can review the available account options with you. First, let me confirm a few details before we continue."); utterance.rate = 0.82; utterance.onend = finish; utterance.onerror = finish; window.speechSynthesis.speak(utterance); state.vadBotTimer = setTimeout(finish, 12000); } else { state.vadBotTimer = setTimeout(finish, 8000); } }
    function vadSpeechStart(now) { const vad = state.vad; if (vad && vad.speaking) return; const wasWaitingForTurnEnd = Boolean(state.vadTurnTimer || state.vadOutputTimer || state.vadOutputCleanupTimer); clearVadTurnTimers(); if (vad) { vad.speaking = true; vad.speechStartedAt = now; vad.aboveSince = null; vad.belowSince = null; } vadStatus("user speaking", "ready"); if (wasWaitingForTurnEnd) vadLog("TURN_WAIT_CANCELLED", "Caller resumed before the 2 s end-of-turn gate; audio output remains blocked."); vadLog("VADUserStartedSpeakingFrame", "Acoustic speech onset confirmed after 80 ms."); vadLog("UserStartedSpeakingFrame", "User turn start strategy opens the turn and enables interruption."); if (state.vadBotSpeaking) stopVadBot(true); else vadNodes(["vad-node-input", "vad-node-turn"], null, null); }
    function vadSpeechStop(now) { const vad = state.vad; if (vad && !vad.speaking && !state.vadTurnTimer) return; const duration = vad && vad.speechStartedAt ? Math.max(0, Math.round(now - vad.speechStartedAt)) : 780; clearVadTurnTimers(); if (vad) { vad.speaking = false; vad.aboveSince = null; vad.belowSince = null; } vadStatus("turn wait: 2.0 s", "fixture"); vadLog("VADUserStoppedSpeakingFrame", "Acoustic silence held for 350 ms; segment was " + duration + " ms."); vadLog("EndOfTurnCandidate", "ACC policy + tools can process now; only audio output waits for 2.0 s of post-speech silence."); vadNodes(state.vad ? ["vad-node-input", "vad-node-turn", "vad-node-stt", "vad-node-agent"] : ["vad-node-turn", "vad-node-stt", "vad-node-agent"], null, null); state.vadTurnTimer = setTimeout(() => { state.vadTurnTimer = null; vadLog("UserStoppedSpeakingFrame", "2.0 s silence gate elapsed; user turn is now closed."); vadLog("EndOfTurnDetected", "Audio output can now join the highlighted ACC policy/tool path."); vadStatus("agent response", "ready"); vadLog("TTSStartedFrame", "Audio output starts after the 2 s end-of-turn gate."); vadNodes(state.vad ? ["vad-node-input", "vad-node-agent"] : ["vad-node-agent"], "vad-node-output", null); state.vadOutputCleanupTimer = setTimeout(() => { state.vadOutputCleanupTimer = null; if (!state.vadBotSpeaking && !state.vad?.speaking) { vadNodes(state.vad ? ["vad-node-input"] : [], null, null); vadStatus(state.vad ? "listening" : "mic off", state.vad ? "ready" : "fixture"); } }, 1200); }, VAD_END_OF_TURN_MS); }
    function renderVadLevel(db) { const width = Math.max(0, Math.min(100, (db + 70) / 60 * 100)); document.getElementById("vad-meter-fill").style.width = width + "%"; document.getElementById("vad-level").textContent = Number.isFinite(db) ? db.toFixed(1) + " dBFS" : "−∞ dBFS"; }
    function vadLoop() { const vad = state.vad; if (!vad) return; vad.analyser.getFloatTimeDomainData(vad.samples); let energy = 0; for (const sample of vad.samples) energy += sample * sample; const rms = Math.sqrt(energy / vad.samples.length); const db = 20 * Math.log10(Math.max(rms, 0.0000001)); renderVadLevel(db); const threshold = updateVadThreshold(); const now = performance.now(); if (!vad.speaking) { if (db >= threshold) { vad.aboveSince = vad.aboveSince || now; if (now - vad.aboveSince >= 80) vadSpeechStart(now); } else vad.aboveSince = null; } else if (db < threshold - 4) { vad.belowSince = vad.belowSince || now; if (now - vad.belowSince >= 350) vadSpeechStop(now); } else vad.belowSince = null; vad.raf = requestAnimationFrame(vadLoop); }
    function stopVadMic(silent) { clearVadTurnTimers(); clearVadSimulationTimers(); const button = document.getElementById("vad-mic"); const canceledStart = state.vadStarting; if (canceledStart) { state.vadStartToken += 1; state.vadStarting = false; if (state.vadPendingStream) state.vadPendingStream.getTracks().forEach(track => track.stop()); state.vadPendingStream = null; button.disabled = false; } const vad = state.vad; if (vad) { cancelAnimationFrame(vad.raf); vad.stream.getTracks().forEach(track => track.stop()); vad.source.disconnect(); vad.analyser.disconnect(); vad.context.close().catch(() => undefined); state.vad = null; } if (!vad && !canceledStart) return; button.textContent = "Start microphone"; renderVadLevel(-Infinity); vadNodes([], state.vadBotSpeaking ? "vad-node-output" : null, null); vadStatus(state.vadBotSpeaking ? "agent speaking" : "mic off", state.vadBotSpeaking ? "ready" : "fixture"); if (!silent) vadLog(canceledStart && !vad ? "MIC_START_CANCELLED" : "MIC_STOPPED", canceledStart && !vad ? "Microphone startup canceled and partial resources released." : "Browser audio capture released."); }
    async function toggleVadMic() { if (state.vadStarting) return; if (state.vad) { stopVadMic(false); return; } if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Microphone capture requires HTTPS or localhost."); const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (!AudioContextClass) throw new Error("Web Audio is unavailable in this browser."); const button = document.getElementById("vad-mic"); const startToken = state.vadStartToken + 1; state.vadStartToken = startToken; state.vadStarting = true; button.disabled = true; button.textContent = "Starting microphone…"; vadStatus("requesting mic", "fixture"); let stream = null; let context = null; let source = null; let analyser = null; let installed = false; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false }); if (state.vadStartToken !== startToken) return; state.vadPendingStream = stream; context = new AudioContextClass(); await context.resume(); if (state.vadStartToken !== startToken) return; source = context.createMediaStreamSource(stream); analyser = context.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.35; source.connect(analyser); state.vad = { stream, context, source, analyser, samples: new Float32Array(analyser.fftSize), raf: 0, speaking: false, speechStartedAt: null, aboveSince: null, belowSince: null }; state.vadPendingStream = null; installed = true; button.textContent = "Stop microphone"; vadStatus("listening", "ready"); vadNodes(["vad-node-input"], state.vadBotSpeaking ? "vad-node-output" : null, null); vadLog("MIC_READY", "Web Audio is measuring RMS locally; no audio leaves the browser."); vadLoop(); } finally { if (!installed) { if (source) source.disconnect(); if (analyser) analyser.disconnect(); if (stream) stream.getTracks().forEach(track => track.stop()); if (context) context.close().catch(() => undefined); } if (state.vadStartToken === startToken) { state.vadPendingStream = null; state.vadStarting = false; button.disabled = false; if (!state.vad) button.textContent = "Start microphone"; } } }
    function simulateVadBargeIn() { clearVadSimulationTimers(); if (state.vadBotSpeaking) stopVadBot(false); startVadBot(); state.vadSimulationTimers = [setTimeout(() => vadSpeechStart(performance.now()), 850), setTimeout(() => { state.vadSimulationTimers = []; vadSpeechStop(performance.now()); }, 1750)]; }
    function resetVadDemo() { stopVadMic(true); stopVadBot(false); clearVadTurnTimers(); clearVadSimulationTimers(); clearTimeout(state.vadBotTimer); state.vadBotTimer = null; document.getElementById("vad-events").innerHTML = '<div class="vad-event"><code>READY</code><span>Start the mic or simulate barge-in.</span></div>'; document.getElementById("vad-threshold").value = "-42"; updateVadThreshold(); renderVadLevel(-Infinity); vadNodes([], null, null); vadStatus("mic off", "fixture"); }
    function renderReadiness() { document.getElementById("readiness").innerHTML = data.readiness.map(item => '<article class="card metric readiness-card"><div class="readiness-card__head"><span class="badge ' + esc(item.status) + '">' + esc(item.status) + '</span><strong>' + esc(item.label) + '</strong></div><span class="muted">' + esc(item.detail) + '</span>' + (item.repoUrl ? '<a class="muted" href="' + esc(item.repoUrl) + '" target="_blank" rel="noreferrer">Source ↗</a>' : '') + '<details class="readiness-more"><summary>Notes</summary><span class="muted">' + esc(item.caveat) + '</span></details></article>').join(""); }
    function renderBrain() { const session = state.brainSession ? state.brainSession.session : { id: "cluecon-agent-brain-demo", activeTool: "operator.approve_offer", policyState: "policy_hold_requires_operator_approval" }; document.getElementById("brain-state").innerHTML = '<span class="badge ready">session scoped</span><h3>' + esc(session.id) + '</h3><span class="muted">Tool: ' + esc(session.activeTool) + ' / Policy: ' + esc(session.policyState) + '</span>'; document.getElementById("brain").innerHTML = state.brain.map((block, index) => '<article class="plain"><h3>' + esc(block.file) + '</h3><textarea data-brain="' + index + '">' + esc(block.summary) + '</textarea><span class="muted">Affects: ' + esc(block.affects.join(", ")) + '</span></article>').join(""); document.querySelectorAll("textarea[data-brain]").forEach(input => input.addEventListener("change", () => { state.brain[Number(input.dataset.brain)].summary = input.value; })); }
    function asrBenchmarkFor(model) { const profiles = data.asrPanel.benchmarkProfiles || {}; const key = model ? model.backend + "|" + model.model : ""; const targetId = String(model && model.targetId || "").toLowerCase(); const targetFallback = targetId.includes("faster-whisper") ? profiles["faster-whisper|base.en"] : targetId.includes("parakeet") ? profiles["parakeet-mlx|mlx-community/parakeet-tdt_ctc-110m"] : null; return profiles[key] || targetFallback || profiles["parakeet-mlx|mlx-community/parakeet-tdt_ctc-110m"] || Object.values(profiles)[0] || null; }
    function renderAsrBenchmarks(model) { const profile = asrBenchmarkFor(model); const container = document.getElementById("asr-benchmarks"); if (!profile) { container.innerHTML = '<article class="card metric asr-benchmark-source"><strong>No published benchmark mapped to this model.</strong><a href="' + esc(data.asrPanel.benchmarkUrl) + '" target="_blank" rel="noreferrer">Open benchmarks ↗</a></article>'; return; } container.innerHTML = '<article class="card asr-benchmark-source"><span><strong>' + esc(profile.label) + '</strong><span class="muted">Published ' + esc(profile.measuredAt) + ' · model-specific artifact</span></span><a href="' + esc(profile.detailUrl) + '" target="_blank" rel="noreferrer">View artifact ↗</a></article>' + '<article class="card metric asr-metric-card"><span class="muted">First partial</span><strong>' + esc(profile.firstPartial) + '</strong><span class="muted">' + esc(profile.firstPartialDetail) + '</span></article>' + '<article class="card metric asr-metric-card"><span class="muted">Finalization</span><strong>' + esc(profile.finalization) + '</strong><span class="muted">' + esc(profile.finalizationDetail) + '</span></article>' + '<article class="card metric asr-metric-card"><span class="muted">RTF</span><strong>' + esc(profile.rtf) + '</strong><span class="muted">' + esc(profile.rtfDetail) + '</span></article>'; }
    function renderAsrPanel() { const events = data.asrPanel.status === "live_ready" ? data.asrPanel.fixtureEvents.filter(event => event.state !== "error") : data.asrPanel.fixtureEvents; document.getElementById("asr-events").innerHTML = events.map(event => '<span class="asr-event-pill"><strong>' + esc(event.state) + '</strong>' + esc(event.latencyMs === null ? event.text : event.latencyMs + " ms") + '</span>').join(""); renderAsrBenchmarks(selectedAsrModel()); }
    function setAsrLiveStatus(message, stateName) { const status = document.getElementById("asr-live-status"); const badge = document.getElementById("asr-live-badge"); status.textContent = message; badge.textContent = stateName; badge.className = "badge " + (stateName === "ready" || stateName === "transcribed" ? "ready" : stateName === "error" ? "blocked" : "fixture"); }
    async function loadAsrModels() { const select = document.getElementById("asr-model-select"); const batchButton = document.getElementById("asr-record"); const realtimeButton = document.getElementById("asr-realtime"); try { const response = await fetch(data.asrPanel.modelsRoute); const payload = await response.json(); if (!response.ok || !Array.isArray(payload.models)) throw new Error(payload.nextStep || payload.error || "model discovery failed"); state.asrModels = payload.models; select.innerHTML = payload.models.map(model => '<option value="' + esc(model.targetId) + '"' + (model.ready ? '' : ' disabled') + '>' + esc(model.targetLabel + " · " + model.backend + " · " + model.model + (model.ready ? "" : " (unavailable)")) + '</option>').join(""); const active = payload.models.find(model => model.targetId === payload.activeTargetId && model.ready) || payload.models.find(model => model.ready); if (!active) throw new Error("No warmed rtc-asr model target is ready."); select.value = active.targetId; select.disabled = false; batchButton.disabled = false; realtimeButton.disabled = !active.websocketUrl; renderAsrBenchmarks(active); setAsrLiveStatus("Ready: " + active.backend + " / " + active.model + " (" + active.responseMs + " ms probe).", "ready"); } catch (error) { state.asrModels = []; select.innerHTML = '<option>rtc-asr unavailable</option>'; select.disabled = true; batchButton.disabled = true; realtimeButton.disabled = true; setAsrLiveStatus("Live transcription unavailable: " + String(error.message || error), "error"); } }
    function encodeAsrWav(chunks, sampleRate) { const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0); const buffer = new ArrayBuffer(44 + sampleCount * 2); const view = new DataView(buffer); function text(offset, value) { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); } text(0, "RIFF"); view.setUint32(4, 36 + sampleCount * 2, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, sampleCount * 2, true); let offset = 44; chunks.forEach(chunk => chunk.forEach(value => { const sample = Math.max(-1, Math.min(1, value)); view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true); offset += 2; })); return new Uint8Array(buffer); }
    function asrBytesToBase64(bytes) { let binary = ""; const batch = 0x8000; for (let offset = 0; offset < bytes.length; offset += batch) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + batch)); return btoa(binary); }
    async function startAsrRecording() { if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Microphone capture requires localhost or HTTPS."); const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (!AudioContextClass) { stream.getTracks().forEach(track => track.stop()); throw new Error("Web Audio is unavailable in this browser."); } const context = new AudioContextClass(); const source = context.createMediaStreamSource(stream); const processor = context.createScriptProcessor(4096, 1, 1); const mute = context.createGain(); mute.gain.value = 0; const chunks = []; processor.onaudioprocess = event => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); source.connect(processor); processor.connect(mute); mute.connect(context.destination); const timer = setTimeout(() => stopAsrRecording().catch(error => setAsrLiveStatus(String(error.message || error), "error")), 6000); state.asrCapture = { stream, context, source, processor, mute, chunks, sampleRate: context.sampleRate, timer }; document.getElementById("asr-record").textContent = "Stop + transcribe"; document.getElementById("asr-live-wave").classList.add("recording"); document.getElementById("asr-live-result").textContent = "Listening… say a short sentence."; setAsrLiveStatus("Capturing microphone audio locally for up to 6 seconds.", "recording"); }
    async function stopAsrRecording() { if (!state.asrCapture || state.asrStopping) return; state.asrStopping = true; const button = document.getElementById("asr-record"); button.disabled = true; const capture = state.asrCapture; state.asrCapture = null; clearTimeout(capture.timer); capture.processor.onaudioprocess = null; capture.source.disconnect(); capture.processor.disconnect(); capture.mute.disconnect(); capture.stream.getTracks().forEach(track => track.stop()); await capture.context.close(); button.textContent = "Batch 6 seconds"; document.getElementById("asr-live-wave").classList.remove("recording"); try { if (!capture.chunks.length) throw new Error("No microphone samples were captured."); setAsrLiveStatus("Transcribing with the selected warmed model…", "transcribing"); const response = await fetch(data.asrPanel.transcribeRoute, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetId: document.getElementById("asr-model-select").value, audioData: asrBytesToBase64(encodeAsrWav(capture.chunks, capture.sampleRate)), sampleRate: capture.sampleRate, language: "en" }) }); const payload = await response.json(); if (!response.ok || !payload.ok) throw new Error(payload.error || payload.nextStep || "transcription failed"); const result = payload.transcription || {}; const transcript = typeof result.text === "string" ? result.text : typeof result.transcript === "string" ? result.transcript : result.transcription && typeof result.transcription.text === "string" ? result.transcription.text : JSON.stringify(result); document.getElementById("asr-live-result").textContent = transcript.trim() || "(No speech detected.)"; setAsrLiveStatus("Transcribed by " + payload.targetLabel + " in " + payload.responseMs + " ms.", "transcribed"); } finally { state.asrStopping = false; button.disabled = false; } }
    async function toggleAsrRecording() { const button = document.getElementById("asr-record"); button.disabled = true; try { if (state.asrCapture) await stopAsrRecording(); else await startAsrRecording(); } catch (error) { state.asrStopping = false; document.getElementById("asr-live-wave").classList.remove("recording"); document.getElementById("asr-live-result").textContent = "Live transcription failed: " + String(error.message || error); setAsrLiveStatus(String(error.message || error), "error"); } finally { button.disabled = false; } }
    function selectedAsrModel() { const targetId = document.getElementById("asr-model-select").value; return state.asrModels.find(model => model.targetId === targetId); }
    function resampleAsrPcm16(input, inputRate) { const ratio = inputRate / 16000; const sampleCount = Math.max(1, Math.floor(input.length / ratio)); const output = new Int16Array(sampleCount); for (let index = 0; index < sampleCount; index += 1) { const sample = Math.max(-1, Math.min(1, input[Math.min(input.length - 1, Math.floor(index * ratio))])); output[index] = sample < 0 ? sample * 32768 : sample * 32767; } return output; }
    function setAsrRealtimeControls(running) { const select = document.getElementById("asr-model-select"); const batchButton = document.getElementById("asr-record"); const realtimeButton = document.getElementById("asr-realtime"); select.disabled = running; batchButton.disabled = running; realtimeButton.disabled = false; realtimeButton.textContent = running ? "Stop + finalize" : "Start realtime"; }
    function closeAsrRealtime() { const live = state.asrLive; if (!live) return; live.intentionalClose = true; clearTimeout(live.timer); if (live.processor) live.processor.onaudioprocess = null; if (live.source) live.source.disconnect(); if (live.processor) live.processor.disconnect(); if (live.mute) live.mute.disconnect(); if (live.stream) live.stream.getTracks().forEach(track => track.stop()); if (live.context) live.context.close().catch(() => undefined); if (live.socket && live.socket.readyState < WebSocket.CLOSING) live.socket.close(); state.asrLive = null; document.getElementById("asr-live-wave").classList.remove("recording"); setAsrRealtimeControls(false); }
    function handleAsrRealtimeMessage(event) { const live = state.asrLive; if (!live) return; let message; try { message = JSON.parse(event.data); } catch { return; } if (message.type === "ready") { live.readyResolve(); setAsrLiveStatus("Local STT stream ready. Speak now; partials update as the model revises them.", "streaming"); return; } if (message.type === "transcript") { const result = document.getElementById("asr-live-result"); const text = String(message.text || "").trim(); result.textContent = (message.is_final ? "FINAL" : "PARTIAL r" + message.revision) + "\\n" + (text || "(No speech detected yet.)"); result.classList.toggle("partial", !message.is_final); setAsrLiveStatus((message.is_final ? "Final transcript" : "Live partial") + " · " + message.audio_transcribed_ms + " / " + message.audio_received_ms + " ms audio", message.is_final ? "transcribed" : "streaming"); if (message.is_final && live.finalResolve) live.finalResolve(); return; } if (message.type === "warning") { setAsrLiveStatus("rtc-asr warning: " + message.message, "streaming"); return; } if (message.type === "error") { const error = new Error(message.message || message.code || "rtc-asr stream failed"); if (live.readyReject) live.readyReject(error); if (live.finalReject) live.finalReject(error); document.getElementById("asr-live-result").textContent = "Realtime transcription failed: " + error.message; setAsrLiveStatus(error.message, "error"); } }
    async function startAsrRealtime() { if (state.asrLive) return; const model = selectedAsrModel(); if (!model || !model.websocketUrl) throw new Error("The selected model does not expose a Local STT websocket."); if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Microphone capture requires localhost or HTTPS."); const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (!AudioContextClass) throw new Error("Web Audio is unavailable in this browser."); const socket = new WebSocket(model.websocketUrl); const live = { socket, model, pending: [], stream: null, context: null, source: null, processor: null, mute: null, timer: null, readyResolve: null, readyReject: null, finalResolve: null, finalReject: null, intentionalClose: false }; state.asrLive = live; const ready = new Promise((resolve, reject) => { live.readyResolve = resolve; live.readyReject = reject; }); socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "start", version: "local-stt.v1", audio: { sample_rate: 16000, channels: 1, format: "pcm_s16le", frame_ms: 20, bytes_per_frame: 640 }, language: "en", interim_results: true, partial_interval_ms: 200, partial_window_seconds: 2, max_buffer_seconds: 12, client_stream_id: "cluecon-live-" + Date.now(), metadata: { presentation: "cluecon-2026", model_target: model.targetId } }))); socket.addEventListener("message", handleAsrRealtimeMessage); socket.addEventListener("error", () => { if (live.readyReject) live.readyReject(new Error("Could not connect to the rtc-asr websocket.")); }); socket.addEventListener("close", () => { if (!live.intentionalClose && state.asrLive === live) { document.getElementById("asr-live-result").textContent = "rtc-asr realtime stream closed unexpectedly."; setAsrLiveStatus("Realtime websocket closed.", "error"); closeAsrRealtime(); } }); setAsrRealtimeControls(true); document.getElementById("asr-live-result").textContent = "Connecting to " + model.backend + " / " + model.model + "…"; setAsrLiveStatus("Opening Local STT v1 websocket…", "connecting"); await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("rtc-asr websocket readiness timed out.")), 5000))]); live.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }); live.context = new AudioContextClass(); live.source = live.context.createMediaStreamSource(live.stream); live.processor = live.context.createScriptProcessor(4096, 1, 1); live.mute = live.context.createGain(); live.mute.gain.value = 0; live.processor.onaudioprocess = event => { if (socket.readyState !== WebSocket.OPEN) return; const pcm = resampleAsrPcm16(event.inputBuffer.getChannelData(0), live.context.sampleRate); for (const sample of pcm) live.pending.push(sample); while (live.pending.length >= 1600) socket.send(new Int16Array(live.pending.splice(0, 1600)).buffer); }; live.source.connect(live.processor); live.processor.connect(live.mute); live.mute.connect(live.context.destination); live.timer = setTimeout(() => stopAsrRealtime().catch(error => { setAsrLiveStatus(String(error.message || error), "error"); closeAsrRealtime(); }), 10000); document.getElementById("asr-live-wave").classList.add("recording"); document.getElementById("asr-live-result").classList.add("partial"); document.getElementById("asr-live-result").textContent = "PARTIAL\\nListening…"; setAsrLiveStatus("Streaming 16 kHz PCM16 to " + model.targetLabel + " for up to 10 seconds.", "streaming"); }
    async function stopAsrRealtime() { const live = state.asrLive; if (!live) return; clearTimeout(live.timer); if (live.processor) live.processor.onaudioprocess = null; if (live.source) live.source.disconnect(); if (live.processor) live.processor.disconnect(); if (live.mute) live.mute.disconnect(); if (live.stream) live.stream.getTracks().forEach(track => track.stop()); if (live.context) await live.context.close(); if (live.pending.length && live.socket.readyState === WebSocket.OPEN) live.socket.send(new Int16Array(live.pending.splice(0)).buffer); setAsrLiveStatus("Finalizing the live rtc-asr stream…", "transcribing"); const finalized = new Promise((resolve, reject) => { live.finalResolve = resolve; live.finalReject = reject; }); live.socket.send(JSON.stringify({ type: "finalize" })); await Promise.race([finalized, new Promise((_, reject) => setTimeout(() => reject(new Error("rtc-asr final transcript timed out.")), 12000))]); closeAsrRealtime(); }
    async function toggleAsrRealtime() { try { if (state.asrLive && state.asrLive.processor) await stopAsrRealtime(); else if (state.asrLive) closeAsrRealtime(); else await startAsrRealtime(); } catch (error) { document.getElementById("asr-live-result").textContent = "Realtime transcription failed: " + String(error.message || error); document.getElementById("asr-live-result").classList.remove("partial"); setAsrLiveStatus(String(error.message || error), "error"); closeAsrRealtime(); } }
    function renderProofCards() { document.getElementById("proof-cards").innerHTML = data.proofPreview.includes.map(item => '<article class="card proof-field"><strong>' + esc(item) + '</strong></article>').join(""); document.getElementById("eval-scorecard").innerHTML = data.proofPreview.scorecardChecks.map(item => '<div class="event"><strong>' + esc(item) + '</strong><span class="badge fixture">pending</span></div>').join(""); }
    function renderTimeline(call) { const events = call ? call.events.slice(-8) : []; document.getElementById("timeline").innerHTML = events.map(event => '<div class="event"><strong>' + esc(event.type) + '</strong><span class="muted">' + esc(JSON.stringify(event.detail)) + '</span></div>').join("") || '<div class="plain muted">Timeline will populate from the scripted call events.</div>'; }
    function renderDemoTranscript(turns) { const screen = document.getElementById("demo-screen"); screen.classList.remove("has-drill"); screen.classList.add("has-transcript"); screen.innerHTML = turns.map(turn => { const speaker = String(turn.speaker || "agent"); const tone = speaker.toLowerCase() === "caller" ? "caller" : "agent"; return '<div class="transcript-turn transcript-turn--' + tone + '"><span class="transcript-turn__speaker">' + esc(speaker) + '</span><span class="transcript-turn__text">' + esc(turn.text) + '</span></div>'; }).join(""); }
    function renderOperatorDrill(payload) { const screen = document.getElementById("demo-screen"); const integration = payload.integration || {}; const patterns = Array.isArray(integration.executionPatterns) ? integration.executionPatterns : []; screen.classList.remove("has-transcript"); screen.classList.add("has-drill"); screen.innerHTML = '<div class="drill-summary">' + esc(payload.summary) + '</div><div class="drill-boundary"><strong>Control plane → media plane</strong><span>' + esc(integration.controlPlane || "ACC records a bounded operator action.") + '</span><span>' + esc(integration.mediaPlane || "The configured telephony adapter executes it.") + '</span></div>' + (integration.controlMessage ? '<pre class="drill-command">' + esc(JSON.stringify(integration.controlMessage, null, 2)) + '</pre>' : '') + (patterns.length ? '<ul class="drill-patterns">' + patterns.map(pattern => '<li>' + esc(pattern) + '</li>').join("") + '</ul>' : '') + (integration.demoCaveat ? '<span class="muted">' + esc(integration.demoCaveat) + '</span>' : ''); }
    function renderSlides() { document.querySelectorAll("[data-slide]").forEach(el => el.classList.toggle("active", Number(el.dataset.slide) === state.slide)); const prev = document.getElementById("prev"); const next = document.getElementById("next"); const status = document.getElementById("slide-status"); if (prev) prev.disabled = state.slide <= 0; if (next) next.disabled = state.slide >= state.slideCount - 1; if (status) status.textContent = String(state.slide + 1) + " / " + String(state.slideCount); }
    function goToSlide(index) { const nextSlide = Math.max(0, Math.min(state.slideCount - 1, index)); if (state.slide === 3 && nextSlide !== 3) { stopVadMic(true); stopVadBot(false); } state.slide = nextSlide; renderSlides(); const target = document.querySelector('[data-slide="' + state.slide + '"]'); if (!state.isPresent && target) target.scrollIntoView({ behavior: "smooth", block: "start" }); }
    function summarizeProof(proof) { return { compatibleRequest: data.proofPreview.compatibleRequest, callId: proof.callId, outcome: proof.outcome, summary: proof.summary, transcriptTurns: Array.isArray(proof.transcript) ? proof.transcript.length : 0, eventCount: Array.isArray(proof.events) ? proof.events.length : 0, latencyMarks: Array.isArray(proof.latencyMarks) ? proof.latencyMarks.length : 0, fallback: proof.demoFallback, caveats: proof.pii, artifactLinks: proof.artifacts }; }
    function renderScorecard(scorecard) { document.getElementById("eval-scorecard").innerHTML = scorecard.checks.map(check => '<div class="event"><strong>' + esc(check.label) + '</strong><span class="muted"><span class="badge ' + (check.passed ? 'ready' : 'blocked') + '">' + (check.passed ? 'pass' : 'fail') + '</span> ' + esc(check.evidence) + '</span></div>').join(""); }
    async function runEvalProof() { const buttons = document.querySelectorAll("button"); buttons.forEach(button => button.disabled = true); document.getElementById("proof-json").textContent = "Running ClueCon ASSERT-style eval proof..."; try { const response = await fetch(data.proofPreview.runRoute, { method: "POST" }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "eval proof failed"); renderScorecard(payload.scorecard); document.getElementById("proof-json").textContent = JSON.stringify({ compatibleRequest: payload.compatibleRequest, summary: payload.summary, scorecard: payload.scorecard, assertRequestPreview: payload.assertRequestPreview, proofLinks: payload.proofLinks }, null, 2); goToSlide(8); } catch (error) { document.getElementById("proof-json").textContent = "Eval proof failed: " + String(error.message || error); goToSlide(8); } finally { buttons.forEach(button => button.disabled = false); renderSlides(); } }
    async function refreshLiveProbes() { try { const response = await fetch("/api/cluecon"); if (!response.ok) return; data = await response.json(); window.__CLUECON__ = data; renderReadiness(); renderAsrPanel(); await loadAsrModels(); } catch (error) { console.warn("ClueCon live probe refresh failed", error); } }
    async function runDemo() { const buttons = document.querySelectorAll("button"); buttons.forEach(button => button.disabled = true); goToSlide(5); const screen = document.getElementById("demo-screen"); screen.classList.remove("has-transcript", "has-drill"); screen.textContent = "Running scripted cancellation-rescue proof..."; document.getElementById("proof-json").textContent = "Waiting for scripted proof..."; try { const response = await fetch(data.routes.scriptedDemo, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openclawSessionLabel: "cluecon/2026-presentation" }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "demo failed"); state.proof = payload.proof; renderDemoTranscript(payload.call.transcript); document.getElementById("proof-json").textContent = JSON.stringify({ status: "scripted_proof_ok", ...summarizeProof(payload.proof) }, null, 2); renderTimeline(payload.call); } catch (error) { const message = String(error.message || error); screen.classList.remove("has-transcript", "has-drill"); screen.textContent = "Scripted demo failed: " + message; document.getElementById("proof-json").textContent = JSON.stringify({ status: "scripted_proof_failed", error: message, nextStep: "Confirm npm start is serving /api/demo/run-end-to-end, then retry Run scripted demo." }, null, 2); } finally { buttons.forEach(button => button.disabled = false); renderSlides(); } }
    async function previewBrain() { const response = await fetch(data.brainPanel.previewRoute, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocks: state.brain }) }); const payload = await response.json(); document.getElementById("proof-json").textContent = JSON.stringify(payload, null, 2); goToSlide(8); }
    async function applyBrain() { const response = await fetch(data.brainPanel.applyRoute, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocks: state.brain }) }); const payload = await response.json(); document.getElementById("proof-json").textContent = JSON.stringify(payload, null, 2); if (!response.ok) return; data.brainBlocks = payload.activeBrainBlocks; data.brainPanel = payload.brainPanel; state.brain = JSON.parse(JSON.stringify(payload.activeBrainBlocks)); renderBrain(); }
    async function resetBrain() { const response = await fetch(data.brainPanel.resetRoute, { method: "POST" }); const payload = await response.json(); document.getElementById("proof-json").textContent = JSON.stringify(payload, null, 2); data.brainBlocks = payload.activeBrainBlocks; data.brainPanel = payload.brainPanel; state.brain = JSON.parse(JSON.stringify(payload.activeBrainBlocks)); renderBrain(); }
    async function runOperatorDrill(kind) { const buttons = document.querySelectorAll("button"); buttons.forEach(button => button.disabled = true); goToSlide(5); try { const response = await fetch(data.operatorCockpit.drillRoute, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "operator drill failed"); renderOperatorDrill(payload); document.getElementById("proof-json").textContent = JSON.stringify({ drill: payload.kind, outcome: payload.outcome, integration: payload.integration, workboardCard: payload.workboardCard, proofLinks: payload.proofLinks, finalState: payload.call.flowState, fallback: payload.call.demoFallback }, null, 2); renderTimeline(payload.call); } catch (error) { const screen = document.getElementById("demo-screen"); screen.classList.remove("has-transcript", "has-drill"); screen.textContent = "Operator drill failed: " + String(error.message || error); } finally { buttons.forEach(button => button.disabled = false); renderSlides(); } }
    async function runFallbackDrill(mode) { const buttons = document.querySelectorAll("button"); buttons.forEach(button => button.disabled = true); try { const start = await fetch("/api/demo/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openclawSessionLabel: "cluecon/" + mode + "-drill" }) }); const started = await start.json(); if (!start.ok) throw new Error(started.error || "start failed"); const fallback = await fetch("/api/calls/" + encodeURIComponent(started.session.callId) + "/fallback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, reason: mode + " ClueCon drill" }) }); const call = await fallback.json(); if (!fallback.ok) throw new Error(call.error || "fallback failed"); const proofResponse = await fetch("/api/calls/" + encodeURIComponent(started.session.callId) + "/proof"); const proof = await proofResponse.json(); document.getElementById("demo-screen").textContent = mode + " -> fail-closed human handoff; no improvised offer."; document.getElementById("proof-json").textContent = JSON.stringify(summarizeProof(proof), null, 2); renderTimeline(call); } finally { buttons.forEach(button => button.disabled = false); renderSlides(); } }
    function drill(kind) { const messages = { asr: "rtc_asr unavailable -> show fixture/blocker state; scripted demo remains available and never invents a live transcript.", tts: "tts unavailable -> keep text evidence and mark TTS fallback; Kokoro stays optional for the talk path." }; const message = messages[kind] || "unavailable drill"; goToSlide(5); document.getElementById("demo-screen").textContent = message; document.getElementById("proof-json").textContent = JSON.stringify({ failureDrill: kind, honestState: message, caveat: "Preview blocker only; scripted path is still available for talk continuity." }, null, 2); }
    document.getElementById("asr-model-select").addEventListener("change", event => { const model = selectedAsrModel(); document.getElementById("asr-realtime").disabled = !model || !model.websocketUrl; renderAsrBenchmarks(model); setAsrLiveStatus("Selected: " + event.target.selectedOptions[0].textContent + ". Realtime and batch modes use this warmed endpoint.", "ready"); });
    document.getElementById("run-eval").addEventListener("click", () => runEvalProof().catch(error => { document.getElementById("proof-json").textContent = String(error.message || error); })); document.getElementById("run-demo").addEventListener("click", () => runDemo().catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); })); document.getElementById("run-demo-top").addEventListener("click", () => runDemo().catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); })); document.getElementById("open-demo-slide").addEventListener("click", () => goToSlide(5)); document.getElementById("vad-mic").addEventListener("click", () => toggleVadMic().catch(error => { vadStatus("mic error", "blocked"); vadLog("MIC_ERROR", String(error.message || error)); })); document.getElementById("vad-agent").addEventListener("click", startVadBot); document.getElementById("vad-simulate").addEventListener("click", simulateVadBargeIn); document.getElementById("vad-reset").addEventListener("click", resetVadDemo); document.getElementById("vad-threshold").addEventListener("input", updateVadThreshold); document.getElementById("asr-realtime").addEventListener("click", toggleAsrRealtime); document.getElementById("asr-record").addEventListener("click", toggleAsrRecording); document.getElementById("drill-tool").addEventListener("click", () => runOperatorDrill("tool_timeout").catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); })); document.getElementById("drill-runtime").addEventListener("click", () => runOperatorDrill("runtime_failure").catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); })); document.getElementById("drill-transfer").addEventListener("click", () => runOperatorDrill("transfer").catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); })); document.getElementById("drill-takeover").addEventListener("click", () => runOperatorDrill("takeover").catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); })); document.getElementById("drill-end").addEventListener("click", () => runOperatorDrill("end_call").catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); })); document.getElementById("drill-asr").addEventListener("click", () => drill("asr")); document.getElementById("drill-tts").addEventListener("click", () => drill("tts")); document.getElementById("preview-brain").addEventListener("click", () => previewBrain().catch(error => { document.getElementById("proof-json").textContent = String(error.message || error); })); document.getElementById("apply-brain").addEventListener("click", () => applyBrain().catch(error => { document.getElementById("proof-json").textContent = String(error.message || error); })); document.getElementById("reset-brain").addEventListener("click", () => resetBrain().catch(error => { document.getElementById("proof-json").textContent = String(error.message || error); })); document.getElementById("next").addEventListener("click", () => goToSlide(state.slide + 1)); document.getElementById("prev").addEventListener("click", () => goToSlide(state.slide - 1)); document.addEventListener("keydown", event => { if (event.key === "ArrowRight" || event.key === "PageDown") goToSlide(state.slide + 1); if (event.key === "ArrowLeft" || event.key === "PageUp") goToSlide(state.slide - 1); }); window.addEventListener("pagehide", () => { stopVadMic(true); stopVadBot(false); });
    updateVadThreshold(); renderReadiness(); renderAsrPanel(); renderBrain(); renderProofCards(); renderTimeline(null); goToSlide(0); refreshLiveProbes();
  </script>
</body>
</html>`;
}
