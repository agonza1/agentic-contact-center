import { CLUECON_CANCELLATION_CALLER_TURNS, getPipecatPrototypeHealth } from "../core/pipecatFlowPrototype";
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
  pocketTtsBaseUrl?: string;
  pocketTtsHealthPath?: string;
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

function getClueConTtsProvider(): "pocket" | "kokoro" {
  const configured = trimEnv(process.env.ACC_TTS_PROVIDER)?.toLowerCase();
  if (configured === "pocket" || configured === "kokoro") return configured;
  return trimEnv(process.env.POCKET_TTS_BASE_URL) ? "pocket" : "kokoro";
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
  const pocketTtsProbe = probeById.get("pocket_tts");
  const pipecatVoice = probeById.get("pipecat_voice");
  const ttsProvider = getClueConTtsProvider();
  const activeTtsProbe = ttsProvider === "pocket" ? pocketTtsProbe : kokoroProbe;
  const activeTtsLabel = ttsProvider === "pocket" ? "Pocket TTS" : "Kokoro TTS";
  const selectedPocketWithoutBaseUrl = ttsProvider === "pocket" && pocketTtsProbe?.configured === false;
  const pocketTtsReadinessStatus: ClueConReadinessStatus = selectedPocketWithoutBaseUrl
    ? "blocked"
    : pocketTtsProbe?.status ?? (ttsProvider === "pocket" ? "blocked" : "fixture");
  const pocketTtsReadinessDetail = selectedPocketWithoutBaseUrl
    ? "ACC_TTS_PROVIDER is pocket, but POCKET_TTS_BASE_URL is not ready for local streaming TTS."
    : pocketTtsProbe?.detail ?? (ttsProvider === "pocket"
      ? "ACC_TTS_PROVIDER is pocket, but POCKET_TTS_BASE_URL is not ready for local streaming TTS."
      : "Pocket is the preferred Pipecat TTS lane when POCKET_TTS_BASE_URL is configured.");

  return {
    ok: true,
    route: "/api/cluecon",
    issue: "agonza1/agentic-contact-center#177",
    sourceRepos: {
      agenticContactCenter: "https://github.com/agonza1/agentic-contact-center",
      rtcAsr: "https://github.com/agonza1/rtc-asr",
      conversationAgentEvals: "https://github.com/agonza1/ConversationAgentEvals",
      assert: "https://github.com/responsibleai/ASSERT",
      realtimeVoiceAiGuardrails: "https://github.com/WebRTCventures/realtime-voice-ai-guardrails",
    },
    workboardCard: "85ea5a1a-3a68-4e5d-ac1d-10d5851017ae",
    activeWorkboardCard: clueConProofEvalCard,
    title: "From SIP to Tokens: Deterministic Telephony Meets Real-Time Voice AI",
    thesis:
      "FreeSWITCH keeps SIP dialogs and RTP media bounded while Pipecat coordinates rtc-asr, explicit agent policy, and Kokoro through one observable realtime pipeline.",
    architectureCenter: {
      issue: "agonza1/agentic-contact-center#307",
      target: "transport.input -> rtc-asr STT -> ACC caller-turn adapter -> Kokoro TTS -> transport.output",
      adapterRule: "FreeSWITCH owns the SIP/RTP boundary; decoded audio enters the same Pipecat processors used by other transports.",
      currentGaps: [
        "reliability-lab profile still needs explicit ConversationAgentEvals/ASSERT endpoint wiring",
        "guided /reliability workflow is a future #307 slice",
        "default demo remains fixture-backed and must not be described as live media proof",
        "strict local SIP/Verto proof is accepted; do not reopen it for documentation work",
      ],
    },
    demoGoal: {
      issue: "agonza1/agentic-contact-center#307",
      statement: "Show deterministic telephony governing a measurable, interruptible, and fail-closed AI media path.",
      chain: ["caller", "freeswitch", "pipecat_pipeline", "rtc_asr", "acc_policy_tools", `${ttsProvider}_tts`, "evidence"],
      successSignal: "The scorecard passes and the runtime copy separates fixture, optional live media, accepted SIP/Verto proof, and Phase 2 reliability-lab blockers.",
    },
    turnTiming: {
      ...clueConVadTiming,
      rule: "VAD acoustic stop is only an end-of-turn candidate; agent audio stays blocked until the post-speech silence gate elapses.",
    },
    callFlow: {
      workboardCard: "c9455e37-8b08-4351-8079-9e8f82899ab6",
      issue: "agonza1/agentic-contact-center#217",
      cadenceMs: 1000,
      mode: "live_sip_freeswitch_path",
      credentialRequirement: "local",
      stages: [
        {
          id: "audio_in",
          label: "Caller → SIP/RTP",
          detail: "The caller establishes a SIP dialog and sends sequence-numbered RTP audio",
          packet: "INVITE · RTP PCMU/PCMA",
        },
        {
          id: "transport",
          label: "FreeSWITCH boundary",
          detail: "FreeSWITCH owns the dialog, codec negotiation, media clock, and decoded audio bridge",
          packet: "SIP/RTP → PCM16 frames",
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
          label: "Speech → caller",
          detail: `${activeTtsLabel} streams audio back through Pipecat and FreeSWITCH to the live RTP leg`,
          packet: "tokens → PCM → RTP",
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
      ttsSynthesize: "/api/cluecon/tts/synthesize",
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
        id: "pocket_tts",
        label: "Pocket streaming TTS",
        status: pocketTtsReadinessStatus,
        detail: pocketTtsReadinessDetail,
        caveat: pocketTtsProbe?.configured
          ? `Probe ${pocketTtsProbe.ok ? "passed" : "failed"} at ${pocketTtsProbe.url}.`
          : "Set POCKET_TTS_BASE_URL for Pocket auto-selection; ACC_TTS_PROVIDER=pocket remains available as an explicit override.",
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
      callerTurns: [...CLUECON_CANCELLATION_CALLER_TURNS],
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
        { label: "Reference WER", value: "2.4% / 5.2%", caveat: "Upstream LibriSpeech test-clean / test-other; not an rtc-asr measurement" },
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
          referenceWer: "2.4% / 5.2%",
          referenceWerDetail: "LibriSpeech clean / other · upstream model card",
          referenceWerUrl: "https://huggingface.co/nvidia/parakeet-tdt_ctc-110m",
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
          referenceWer: "4.25% / 10.35%",
          referenceWerDetail: "LibriSpeech clean / other · upstream model results",
          referenceWerUrl: "https://huggingface.co/openai/whisper-base.en/discussions/18/files",
          measuredAt: "2026-06-20",
          detailUrl: "https://agonza1.github.io/rtc-asr/docs/benchmark-results/pages/faster-whisper-base.en-int8-2026-06-20.html",
        },
      },
      noiseGuidance: {
        sourceUrl: "https://agonza1.github.io/rtc-asr/docs/",
        sourceLabel: "rtc-asr benchmark methodology",
        findings: [
          "Measure recognition, false interruptions, backchannels, and end-of-turn errors under the same noise profile.",
          "Tune turn detection separately from transcription when non-speech noise triggers an interruption.",
          "Keep domain hints explicit and replay identical audio fixtures after every ASR, VAD, or turn-detection change.",
        ],
        caveat: "The reliability target is the complete turn—not WER in isolation.",
      },
    },
    ttsPanel: {
      provider: ttsProvider === "pocket" ? "Pocket TTS" : "Kokoro-82M",
      engine: ttsProvider,
      model: ttsProvider === "pocket" ? process.env.POCKET_TTS_MODEL ?? "pocket-tts" : process.env.KOKORO_MODEL ?? "kokoro",
      voice: ttsProvider === "pocket" ? process.env.POCKET_TTS_VOICE ?? "alloy" : process.env.KOKORO_VOICE ?? "af_heart",
      defaultProvider: ttsProvider,
      providers: [
        {
          id: "kokoro",
          label: "Kokoro-82M",
          shortLabel: "Kokoro",
          model: process.env.KOKORO_MODEL ?? "kokoro",
          voice: process.env.KOKORO_VOICE ?? "af_heart",
          status: kokoroProbe?.ok ? "live_ready" : "local_sidecar_required",
          setup: "Set KOKORO_BASE_URL and start the local Kokoro sidecar.",
          liveProbe: kokoroProbe ?? null,
        },
        {
          id: "pocket",
          label: "Pocket TTS",
          shortLabel: "Pocket",
          model: process.env.POCKET_TTS_MODEL ?? "pocket-tts",
          voice: process.env.POCKET_TTS_VOICE ?? "alloy",
          status: pocketTtsProbe?.ok ? "live_ready" : "local_sidecar_required",
          setup: "Set POCKET_TTS_BASE_URL and start the local Pocket OpenAI-compatible speech service.",
          liveProbe: pocketTtsProbe ?? null,
        },
      ],
      synthesizeRoute: "/api/cluecon/tts/synthesize",
      status: activeTtsProbe?.ok ? "streaming_ready" : "local_sidecar_required",
      liveProbe: activeTtsProbe ?? null,
      pipecatStreaming: {
        enabled: ttsProvider === "pocket",
        provider: "pocket",
        route: "/api/cluecon/tts/synthesize",
        requiredEnv: ["POCKET_TTS_BASE_URL", "POCKET_TTS_VOICE", "ACC_TTS_PROVIDER=pocket optional override"],
        preservesAgentBrain: true,
        sttContract: "rtc-asr Local STT v1 remains the browser/WebRTC input contract",
        outputContract: "provider stream -> Pipecat TTSStartedFrame/TTSAudioRawFrame/TTSStoppedFrame -> browser or FreeSWITCH playback",
      },
      metricDefinition: "First audio measures the first provider bytes; playback measures when the browser starts the first playable segment.",
      candidates: [
        {
          name: "Kokoro 82M",
          latency: "~300 ms first chunk",
          condition: "Kokoro-FastAPI GPU serving benchmark; chunk size 400",
          sourceLabel: "Serving benchmark",
          sourceUrl: "https://github.com/remsky/Kokoro-FastAPI#streaming-support",
        },
        {
          name: "Pocket TTS",
          latency: "~200 ms first chunk",
          condition: "MacBook Air M4 CPU; 2 CPU cores",
          sourceLabel: "Project benchmark",
          sourceUrl: "https://github.com/kyutai-labs/pocket-tts",
        },
        {
          name: "VoXtream2",
          latency: "63 ms first packet",
          condition: "RTX 3090 with compiled model; RTF 0.173",
          sourceLabel: "Reproducible benchmark",
          sourceUrl: "https://github.com/herimor/voxtream#benchmark",
        },
        {
          name: "Qwen3-TTS 0.6B",
          latency: "97 ms first packet",
          condition: "12 Hz model; concurrency 1; paper runtime, hardware undisclosed",
          sourceLabel: "Technical report",
          sourceUrl: "https://arxiv.org/html/2601.15621v1#S3.SS4",
        },
      ],
      comparisonCaveat: "These are main self-hosted starting points, not a universal ranking. Hardware, serving stack, voices, chunk sizes, and benchmark definitions differ; rerun one warmed workload before choosing.",
    },
    brainBlocks,
    brainPanel: {
      previewRoute: "/api/cluecon/brain/preview",
      applyRoute: "/api/cluecon/brain/apply",
      resetRoute: "/api/cluecon/brain/reset",
      safeMutation: "session_scoped_in_memory",
      activeFiles: brainBlocks.map((block) => block.file),
    },
    securityPanel: {
      articleUrl: "https://webrtc.ventures/2026/06/slug-voice-ai-security-webrtc-livekit-guardrails/",
      referenceRepoUrl: "https://github.com/WebRTCventures/realtime-voice-ai-guardrails",
      trustBoundary: "Minimize sensitive data crossing the LLM boundary; classify and redact locally unless raw data is explicitly required and governed.",
      controls: ["input guardrail", "minimum context", "tool authorization", "pre-TTS response policy", "privacy-safe audit"],
      scenarios: [
        {
          id: "safe",
          label: "Safe turn",
          input: "I need help understanding my renewal options.",
          action: "allow",
          llmInput: "I need help understanding my renewal options.",
          note: "No sensitive data detected; the minimum required text crosses the provider boundary.",
        },
        {
          id: "pii",
          label: "PII redaction",
          input: "Email the confirmation to alberto@example.com or call 305-555-0142.",
          action: "redact",
          llmInput: "Email the confirmation to [REDACTED_EMAIL] or call [REDACTED_PHONE].",
          note: "A local classifier plus deterministic recognizers remove sensitive spans before the LLM sees the turn.",
        },
        {
          id: "pci",
          label: "PCI blocked",
          input: "Use card 4111 1111 1111 1111 and security code 123.",
          action: "block_llm",
          llmInput: null,
          note: "Collect payment through an authorized application flow; send only payment_method_collected to the model.",
        },
      ],
    },
    operatorCockpit: {
      workboardCard: clueConOperatorCockpitCard,
      drillRoute: "/api/cluecon/operator/drill",
      modes: ["scripted_sequence", "operator_click_simulation", "browser_voice_fallback"],
      simulatedEvents: ["call.started", "media.transcript", "operator.action", "call.ended", "call.error"],
      drillKinds: ["scripted_approve", "tool_timeout", "runtime_failure", "rtc_asr_unavailable", "tts_unavailable", "transfer", "takeover", "end_call"],
      actions: ["pause", "resume", "approve_offer", "approve_retention_review", "ask_operator", "escalate_to_human", "fallback", "transfer", "takeover", "end_call"],
      telephonyControlBoundary: {
        command: "structured JSON from ACC",
        adapters: ["FreeSWITCH mod_event_socket / ESL", "SIP media server", "CPaaS call-control API"],
        standardPatterns: ["ESL uuid_transfer → dialplan / mod_callcenter", "ESL bgapi originate + uuid_bridge", "SIP REFER via deflect", "SIP BYE"],
        responsibility: "ACC owns the policy decision and audit record; the adapter maps callId to FreeSWITCH Unique-ID, and FreeSWITCH owns SIP/RTP execution.",
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
    caePanel: {
      webBaseUrl: trimEnv(process.env.CAE_WEB_URL) ?? "http://127.0.0.1:3012",
      scenariosPath: "/scenarios",
      runsPath: "/runs",
      repoUrl: "https://github.com/agonza1/ConversationAgentEvals",
      relationship: "ACC runs the local scorecard and emits a CAE-compatible handoff; ConversationAgentEvals owns imported runs, reports, and comparisons.",
    },
    contactPanel: {
      name: "Alberto Gonzalez",
      role: "CTO · WebRTC.ventures",
      email: "alberto@webrtc.ventures",
      linkedinUrl: "https://www.linkedin.com/in/albertogonzaleztrastoy/",
      websiteUrl: "https://webrtc.ventures/",
      logoUrl: "https://webrtcventures.b-cdn.net/wp-content/uploads/2022/12/logo-main-light.svg",
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
  const pocketTtsBaseUrl = options.pocketTtsBaseUrl ?? trimEnv(env.POCKET_TTS_BASE_URL);
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
    probeHttpSidecar({
      id: "pocket_tts",
      label: "Pocket streaming TTS",
      baseUrl: pocketTtsBaseUrl,
      healthPath: normalizeHealthPath(options.pocketTtsHealthPath ?? env.POCKET_TTS_HEALTH_PATH, "/health"),
      configuredDetail: "Pocket TTS health probe is reachable for the live latency lab and Pipecat streaming readiness.",
      missingDetail: "POCKET_TTS_BASE_URL is not set; Pocket remains selectable with a visible setup blocker.",
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
}, contactPanel: { websiteUrl: string; logoUrl: string }): string {
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
      <strong>SIP/RTP → FreeSWITCH → Pipecat → tokens → speech back</strong>
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
            <span class="ingress-lane__name">Live SIP caller</span>
            <span class="ingress-lane__codec">INVITE + RTP · PCMU / PCMA</span>
            ${waveformMarkup("media-wave--sip")}
          </div>
        </div>
        <code class="voice-pipeline__metric">${escapeHtml(ingress?.packet ?? "")}</code>
      </li>
      <li class="voice-pipeline__stage voice-pipeline__stage--transport" style="--stage-index:1">
        <div class="voice-pipeline__stage-head"><span class="voice-pipeline__step">02</span><span class="voice-pipeline__layer">TRANSPORT</span></div>
        <strong class="voice-pipeline__label">${escapeHtml(transport?.label ?? "Transport + codec normalize")}</strong>
        <span class="voice-pipeline__detail">${escapeHtml(transport?.detail ?? "")}</span>
        <div class="codec-bridge" aria-hidden="true">
          <span class="codec-chip">FreeSWITCH</span>
          <span class="codec-chip">PCMU</span>
          <span class="codec-arrow">⟶</span>
          <span class="codec-chip codec-chip--target">PCM16</span>
        </div>
        <div class="transport-tag">decoded frames → Pipecat</div>
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
          <span class="egress-chip">Pipecat → FreeSWITCH</span>
          <span class="egress-chip">RTP → caller</span>
        </div>
        <code class="voice-pipeline__metric">${escapeHtml(tts?.packet ?? "")}</code>
      </li>
    </ol>
  </div>
  <a class="flow-brand" href="${contactPanel.websiteUrl}" target="_blank" rel="noreferrer" aria-label="Visit WebRTC.ventures">
    <img src="${contactPanel.logoUrl}" alt="WebRTC.ventures">
  </a>
</section></div>`;
}

export function buildClueConHtml(config: PocConfig, mode: "scroll" | "present", brainBlocks?: ClueConBrainBlock[]): string {
  const payload = buildClueConPayload(config, brainBlocks);
  const data = JSON.stringify(payload);
  const bodyClass = mode === "present" ? "present" : "scroll";
  const linkedinQrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(payload.contactPanel.linkedinUrl)}&size=260&margin=2&ecLevel=H`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(payload.title)}</title>
  <style>
    :root { --bg: #f5f7f8; --panel: #fff; --ink: #17202a; --muted: #5d6b78; --line: #d8e0e7; --teal: #0f766e; --blue: #2457a6; --red: #b42318; --amber: #9a5b04; --green: #167247; --shadow: 0 14px 34px rgba(20, 34, 46, 0.09); --topbar-height: 48px; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    a { color: var(--blue); font-weight: 750; text-decoration: none; }
    button, textarea { font: inherit; }
    button { min-height: 38px; border: 1px solid #b9c6d2; border-radius: 6px; background: #fff; color: var(--ink); font-weight: 760; cursor: pointer; }
    button.primary { background: var(--teal); border-color: var(--teal); color: #fff; }
    button.danger { color: var(--red); border-color: #efb4ac; background: #fff4f2; }
    button:disabled { opacity: 0.52; cursor: wait; }
    .topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: var(--topbar-height); padding: 6px 14px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.96); backdrop-filter: blur(12px); }
    .brand { display: flex; align-items: baseline; gap: 8px; min-width: 0; white-space: nowrap; }
    .brand .kicker { font-size: 10px; }
    .brand strong { font-size: 14px; }
    .kicker { color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
    h1, h2, h3, p { margin-top: 0; letter-spacing: 0; }
    h1, h2 { text-wrap: balance; }
    h1 { max-width: 980px; font-size: clamp(36px, 7vw, 78px); line-height: .96; margin-bottom: 14px; }
    h2 { max-width: 920px; font-size: clamp(28px, 4vw, 48px); line-height: 1.02; margin-bottom: 6px; }
    h3 { font-size: 15px; margin-bottom: 8px; }
    .toolbar { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; justify-content: flex-end; }
    .toolbar a, .mode-link { display: inline-flex; align-items: center; min-height: 30px; padding: 0 8px; border: 1px solid #b9c6d2; border-radius: 6px; background: #fff; color: var(--ink); font-size: 12px; }
    .toolbar button { min-height: 30px; padding: 0 9px; font-size: 12px; }
    .hero, .slide { min-height: calc(100vh - var(--topbar-height)); padding: 48px clamp(18px, 5vw, 72px); display: grid; align-content: center; gap: 16px; border-bottom: 1px solid var(--line); }
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
    .arch-boundary { fill: #f7fafc; stroke: #9fb3c8; stroke-width: 1.5; stroke-dasharray: 5 4; }
    .arch-boundary-label { font: 850 12px system-ui,sans-serif; fill: #334155; letter-spacing: .08em; text-transform: uppercase; }
    .node { fill: #fff; stroke: #bac6d1; stroke-width: 2; }
    .nodeAccent { fill: #e8f5f2; stroke: #0f766e; stroke-width: 2; }
    .nodeWarn { fill: #fff8e8; stroke: #9a5b04; stroke-width: 2; }
    .label { font: 800 15px system-ui,sans-serif; fill: #17202a; }
    .small { font: 650 12px system-ui,sans-serif; fill: #5d6b78; }
    .line { stroke-width: 2.35; fill: none; }
    .line--media { stroke: #2457a6; }
    .line--control { stroke: #9a5b04; stroke-width: 2.15; stroke-dasharray: 7 5; }
    .line--media.line--forward { marker-end: url(#arrow-media); }
    .line--media.line--bidirectional { marker-start: url(#arrow-media); marker-end: url(#arrow-media); }
    .line--control.line--forward { marker-end: url(#arrow-control); }
    .line--control.line--bidirectional { marker-start: url(#arrow-control); marker-end: url(#arrow-control); }
    .arch-legend { font: 750 11px system-ui,sans-serif; fill: #5d6b78; }
    .flow-hero { align-content: start; min-height: calc(100vh - var(--topbar-height)); gap: 20px; }
    .flow-header { display: grid; gap: 8px; max-width: 920px; }
    .flow-header h1 { font-size: clamp(32px, 5vw, 58px); line-height: 1; margin-bottom: 0; }
    .flow-header .subhead { max-width: 720px; font-size: clamp(16px, 1.5vw, 20px); }
    .realtime-flow { display: grid; gap: 14px; width: 100%; }
    .flow-brand { position: relative; z-index: 1; display: flex; width: 100%; align-items: center; justify-content: flex-end; padding: 12px 20px 16px; border-top: 1px solid rgba(125, 211, 252, .14); }
    .flow-brand img { display: block; width: min(250px, 62vw); max-height: 52px; object-fit: contain; }
    .voice-pipeline { position: relative; overflow: hidden; border: 1px solid rgba(34, 211, 238, 0.28); border-radius: 18px; background: radial-gradient(circle at 12% 0%, rgba(34, 211, 238, 0.14), transparent 34%), radial-gradient(circle at 88% 100%, rgba(168, 85, 247, 0.16), transparent 32%), linear-gradient(180deg, #07111f 0%, #0a1628 52%, #060d18 100%); box-shadow: 0 28px 70px rgba(8, 20, 40, 0.28), inset 0 1px 0 rgba(148, 163, 184, 0.08); color: #e8f4ff; }
    .voice-pipeline::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: 0.22; background-image: linear-gradient(rgba(148, 163, 184, 0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(148, 163, 184, 0.12) 1px, transparent 1px); background-size: 34px 34px; mask-image: linear-gradient(to bottom, black, transparent 88%); }
    .voice-pipeline__chrome { position: relative; z-index: 1; display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 12px 18px; padding: 18px 20px 12px; border-bottom: 1px solid rgba(125, 211, 252, 0.14); }
    .voice-pipeline__title { display: grid; gap: 4px; max-width: 820px; }
    .voice-pipeline__eyebrow { color: #67e8f9; font-size: 11px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
    .voice-pipeline__title strong { font-size: clamp(17px, 2.1vw, 23px); line-height: 1.2; letter-spacing: -0.02em; }
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
    .contrast-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 36px; }
    .contrast-head strong { font-size: clamp(20px,2.2vw,30px); }
    .contrast-card--telephony .contrast-head > strong { white-space: nowrap; font-size: clamp(18px,1.9vw,27px); }
    .certainty { font: 750 12px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color: var(--muted); }
    .contrast-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
    .contrast-list li { display: grid; grid-template-columns: 82px minmax(0,1fr); gap: 12px; padding: 13px 0; border-top: 1px solid var(--line); }
    .contrast-list strong { color: var(--ink); font-size: 14px; }
    .contrast-list span { color: var(--muted); font-size: 14px; line-height: 1.35; }
    .versus { align-self: center; display: grid; place-items: center; width: 54px; height: 54px; border: 1px solid var(--line); border-radius: 50%; background: var(--bg); color: var(--muted); font: 850 12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .rtp-cadence { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 6px; padding: 11px 0 2px; border-top: 1px solid var(--line); }
    .rtp-packet { position: relative; z-index: 0; display: grid; gap: 5px; min-width: 0; text-align: center; }
    .rtp-packet:not(:last-child)::after { content: ""; position: absolute; z-index: -1; top: 22px; left: calc(50% + 10px); width: calc(100% - 14px); border-top: 2px solid rgba(34,211,238,.38); }
    .rtp-packet i { justify-self: center; width: 13px; height: 13px; border: 3px solid #cffafe; border-radius: 50%; background: #0891b2; box-shadow: 0 0 0 2px rgba(8,145,178,.18); }
    .rtp-packet strong { color: #0e7490; font: 800 12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .rtp-packet span { color: var(--muted); font: 650 10px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow-wrap: anywhere; }
    .probability-visual { display: grid; gap: 5px; padding: 8px 10px 6px; border-top: 1px solid var(--line); background: linear-gradient(180deg,rgba(168,85,247,.035),transparent); }
    .rtp-cadence, .probability-visual { min-height: 148px; align-content: center; }
    .probability-visual svg { width: 100%; height: 108px; overflow: visible; }
    .probability-axis { fill: none; stroke: #cbd5e1; stroke-width: 1.5; }
    .probability-guide { fill: none; stroke: #cbd5e1; stroke-width: 1; stroke-dasharray: 4 5; }
    .probability-curve { fill: none; stroke-width: 4; stroke-linecap: round; }
    .probability-curve--asr { stroke: #0891b2; }
    .probability-curve--llm { stroke: #9333ea; }
    .probability-dot--asr { fill: #0891b2; }
    .probability-dot--llm { fill: #9333ea; }
    .probability-visual text { fill: #64748b; font: 650 10px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .probability-legend { display: flex; justify-content: center; gap: 18px; color: var(--muted); font-size: 10px; }
    .probability-legend span::before { content: ""; display: inline-block; width: 18px; margin-right: 6px; border-top: 3px solid var(--legend); vertical-align: middle; }
    .probability-legend span:first-child { --legend: #0891b2; }
    .probability-legend span:last-child { --legend: #9333ea; }
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
    .demo-shell { display: grid; gap: 10px; min-width: 0; }
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
    #demo { align-content: start; gap: 8px; }
    #demo .subhead { max-width: none; }
    .demo-commandbar { display: grid; grid-template-columns: auto minmax(360px,1fr); gap: 12px; align-items: end; padding: 11px 13px; border: 1px solid var(--line); border-radius: 11px; background: #fff; box-shadow: var(--shadow); }
    .demo-commandbar > .primary { min-height: 42px; padding-inline: 18px; font-size: 13px; }
    .demo-drill-picker { display: grid; grid-template-columns: minmax(220px,1fr) auto; gap: 7px; align-items: end; }
    .demo-drill-picker label { grid-column: 1 / -1; color: var(--muted); font-size: 10px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    .demo-drill-picker select { min-width: 0; min-height: 36px; padding: 0 10px; border: 1px solid #b9c6d2; border-radius: 7px; background: #f8fafc; color: var(--ink); font: 700 12px/1.2 system-ui,sans-serif; }
    .demo-drill-picker button { min-height: 36px; }
    .demo-control-story { position: relative; display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 24px; }
    .demo-control-story::before { content: ""; position: absolute; z-index: 0; top: 50%; left: 12.5%; right: 12.5%; height: 2px; background: linear-gradient(90deg,rgba(100,116,139,.18),rgba(36,87,166,.42),rgba(15,118,110,.32)); transform: translateY(-50%); }
    .demo-control-step { position: relative; z-index: 1; display: grid; align-content: center; gap: 4px; min-height: 104px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 13px; background: #fff; box-shadow: 0 8px 20px rgba(15,23,42,.07); }
    .demo-control-step:not(:last-child)::after { content: ""; position: absolute; z-index: 2; top: 50%; right: -15px; width: 9px; height: 9px; border-top: 2px solid #5072a7; border-right: 2px solid #5072a7; transform: translate(50%,-50%) rotate(45deg); }
    .demo-control-step small { color: var(--muted); font-size: 9px; font-weight: 850; letter-spacing: .09em; text-transform: uppercase; }
    .demo-control-step strong { font-size: 16px; line-height: 1.12; }
    .demo-control-step span { color: var(--muted); font-size: 11px; line-height: 1.3; }
    .demo-control-step::before { content: attr(data-step); position: absolute; top: 11px; right: 12px; display: grid; place-items: center; width: 23px; height: 23px; border-radius: 50%; background: rgba(36,87,166,.09); color: var(--blue); font: 850 10px/1 system-ui,sans-serif; }
    .demo-control-step.complete { border-color: rgba(15,118,110,.28); background: linear-gradient(145deg,rgba(15,118,110,.08),rgba(255,255,255,.96)); }
    .demo-control-step.complete:not(:last-child)::after { border-color: var(--teal); }
    .demo-control-step.complete::before { content: "✓"; background: var(--teal); color: #fff; }
    #demo .screen { display: grid; align-content: center; gap: 9px; min-height: 114px; max-height: none; padding: 15px 18px; border-radius: 13px; background: linear-gradient(145deg,#081526,#0b2038); white-space: normal; }
    #demo .screen.has-transcript, #demo .screen.has-drill { display: grid; align-content: center; gap: 9px; white-space: normal; }
    .demo-result-head { display: grid; gap: 3px; }
    .demo-result-head small { color: #67e8f9; font-size: 9px; font-weight: 850; letter-spacing: .1em; text-transform: uppercase; }
    .demo-result-head strong { color: #f8fafc; font: 850 clamp(18px,2vw,25px)/1.08 system-ui,sans-serif; }
    .demo-result-head p { max-width: 900px; margin: 0; color: #a9bbcf; font: 12px/1.4 system-ui,sans-serif; }
    .demo-result-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); border-top: 1px solid rgba(125,211,252,.18); }
    .demo-result-item { display: grid; gap: 3px; padding: 9px 12px 0 0; }
    .demo-result-item:not(:last-child) { margin-right: 12px; border-right: 1px solid rgba(125,211,252,.18); }
    .demo-result-item small { color: #67e8f9; font-size: 9px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    .demo-result-item span { color: #dbeafe; font: 11.5px/1.35 system-ui,sans-serif; }
    .demo-failure-audio { display: flex; align-items: center; gap: 10px; padding-top: 8px; border-top: 1px solid rgba(125,211,252,.18); color: #dbeafe; }
    .demo-failure-audio > span { display: grid; gap: 1px; min-width: 180px; font-size: 11px; }
    .demo-failure-audio small { color: #67e8f9; font-size: 9px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    .demo-failure-audio audio { width: min(100%, 420px); height: 34px; }
    .demo-evidence { border: 1px solid var(--line); border-radius: 10px; background: #fff; box-shadow: var(--shadow); }
    .demo-evidence summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 42px; padding: 9px 13px; cursor: pointer; list-style: none; }
    .demo-evidence summary::-webkit-details-marker { display: none; }
    .demo-evidence summary > span { display: grid; gap: 1px; }
    .demo-evidence summary strong { font-size: 12px; }
    .demo-evidence summary small { color: var(--muted); font-size: 10px; }
    .demo-evidence summary b { color: var(--blue); font-size: 11px; }
    .demo-evidence[open] summary { border-bottom: 1px solid var(--line); }
    .demo-evidence-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 12px; padding: 12px; }
    .demo-evidence-grid > div { min-width: 0; }
    .demo-evidence-grid h3 { margin: 0 0 7px; font-size: 12px; }
    .demo-transcript-detail, #demo .timeline { display: grid; align-content: start; gap: 7px; max-height: 300px; overflow: auto; overscroll-behavior: contain; padding-right: 3px; }
    .drill-command { margin: 0; padding: 10px; border-radius: 7px; background: #081526; color: #a7f3d0; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .drill-patterns { display: grid; gap: 5px; margin: 0; padding-left: 18px; color: var(--muted); font-size: 11px; line-height: 1.4; }
    .transcript-turn { display: grid; grid-template-columns: minmax(72px, 92px) minmax(0, 1fr); gap: 12px; padding: 11px 12px; border: 1px solid rgba(148,163,184,.24); border-radius: 8px; background: rgba(15,23,42,.72); }
    .transcript-turn__speaker { color: #7dd3fc; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
    .transcript-turn--agent .transcript-turn__speaker { color: #6ee7b7; }
    .transcript-turn__text { color: #e2e8f0; overflow-wrap: anywhere; }
    #demo .event { grid-template-columns: minmax(110px, 140px) minmax(0, 1fr); }
    #demo .event strong, #demo .event .muted { overflow-wrap: anywhere; word-break: break-word; }
    #asr-architecture { gap: 12px; }
    #asr-architecture > .kicker { font-size: 14px; }
    .asr-app-flow { display: grid; grid-template-columns: minmax(190px,.72fr) minmax(110px,.35fr) minmax(250px,.94fr) minmax(190px,.66fr) minmax(205px,.76fr); align-items: stretch; gap: 10px; padding: 18px; border: 1px solid rgba(125,211,252,.2); border-radius: 18px; background: radial-gradient(circle at 50% 0%,rgba(34,211,238,.13),transparent 34%),linear-gradient(145deg,#07111f,#0b1b2e); color: #e8f4ff; box-shadow: 0 24px 56px rgba(8,20,40,.24); }
    .asr-app-node { display: grid; align-content: center; gap: 7px; min-width: 0; min-height: 225px; padding: 18px; border: 1px solid rgba(148,163,184,.2); border-radius: 14px; background: rgba(9,24,43,.84); }
    .asr-app-node small { color: #7dd3fc; font-size: 12px; font-weight: 850; letter-spacing: .1em; text-transform: uppercase; }
    .asr-app-node strong { color: #f8fafc; font-size: clamp(20px,2.1vw,28px); line-height: 1.08; }
    .asr-app-node span { color: #b9c9da; font-size: 14px; line-height: 1.4; }
    .asr-app-node code { width: fit-content; padding: 6px 8px; border: 1px solid rgba(125,211,252,.2); border-radius: 7px; background: rgba(2,8,20,.62); color: #cffafe; font-size: 13px; }
    .asr-app-node--service { border-color: rgba(34,211,238,.46); background: linear-gradient(145deg,rgba(8,47,73,.92),rgba(8,26,48,.95)); box-shadow: inset 0 1px 0 rgba(255,255,255,.05),0 16px 36px rgba(8,145,178,.12); }
    .asr-service-contract { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 6px; margin-top: 3px; }
    .asr-service-contract span { display: grid; place-items: center; min-height: 42px; padding: 5px; border: 1px solid rgba(103,232,249,.18); border-radius: 8px; background: rgba(2,8,20,.36); color: #d9f7ff; font-size: 12px; font-weight: 800; text-align: center; }
    .asr-app-link { display: grid; align-content: center; justify-items: center; gap: 5px; min-width: 0; text-align: center; }
    .asr-app-link b { color: #67e8f9; font-size: 30px; line-height: .8; }
    .asr-app-link span, .asr-app-link em { color: #9db0c5; font-size: 13px; font-style: normal; line-height: 1.3; }
    .asr-app-link em { color: #6ee7b7; }
    .asr-app-link code { max-width: 100%; padding: 5px 7px; border: 1px solid rgba(125,211,252,.18); border-radius: 7px; background: rgba(2,8,20,.56); color: #dbeafe; overflow-wrap: anywhere; font: 12px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .asr-app-link--runtime span { color: #fcd34d; font-weight: 800; }
    .asr-benefits { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 18px; padding: 6px 4px 0; }
    .asr-benefit { display: grid; grid-template-columns: 46px minmax(0,1fr); gap: 13px; align-items: start; padding-top: 15px; border-top: 4px solid var(--benefit-color,#0f766e); }
    .asr-benefit b { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: #e6fffb; color: var(--benefit-color,#0f766e); font-size: 20px; }
    .asr-benefit span { display: grid; gap: 4px; }
    .asr-benefit strong { font-size: 20px; line-height: 1.1; }
    .asr-benefit small { color: var(--muted); font-size: 16px; line-height: 1.35; }
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
    .asr-live-label { display: block; margin-bottom: 5px; color: #7dd3fc; font-size: 10px; font-weight: 850; letter-spacing: .08em; }
    .asr-live-stable { color: #ecfeff; font-weight: 750; }
    .asr-live-provisional { color: #67e8f9; opacity: .72; }
    .asr-live-note { display: block; margin-top: 7px; color: #7c91a8; font-size: 10px; }
    .asr-live-status { color: #9db0c5; font-size: 11px; line-height: 1.35; }
    .asr-events { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .asr-event-pill { display: inline-flex; align-items: center; gap: 6px; min-height: 27px; padding: 3px 9px; border: 1px solid var(--line); border-radius: 999px; background: #fff; color: var(--muted); font-size: 11px; }
    .asr-event-pill strong { color: var(--ink); font-size: 11px; text-transform: uppercase; }
    #asr-benchmarks { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
    .asr-benchmark-source { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 12px; }
    .asr-benchmark-source > span { display: grid; gap: 2px; }
    .asr-benchmark-source strong { font-size: 14px; }
    .asr-metric-card { padding: 11px; box-shadow: none; }
    .asr-metric-card strong { font-size: clamp(17px, 2vw, 23px); }
    .asr-metric-card .muted { font-size: 11px; }
    .asr-metric-card a.muted { text-decoration-color: rgba(13,148,136,.42); }
    .asr-rtf-note { margin: 0 0 10px; font-size: 11px; line-height: 1.4; }
    #asr-benchmarks .asr-rtf-note { grid-column: 1 / -1; margin-bottom: 0; }
    #asr { align-content: start; gap: 8px; }
    .asr-noise-guidance { display: grid; grid-template-columns: minmax(170px,.65fr) minmax(0,1.7fr); gap: 8px 16px; padding: 11px 13px; border: 1px solid rgba(154,91,4,.28); border-radius: 10px; background: #fff8e8; }
    .asr-noise-guidance > div:first-child { display: grid; align-content: start; gap: 3px; }
    .asr-noise-guidance strong { font-size: 14px; }
    .asr-noise-guidance span, .asr-noise-guidance li { color: var(--muted); font-size: 11px; line-height: 1.35; }
    .asr-noise-guidance ul { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 10px; margin: 0; padding-left: 18px; }
    .asr-noise-foot { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 7px; border-top: 1px solid rgba(154,91,4,.18); }
    .asr-noise-foot a { flex: 0 0 auto; font-size: 11px; }
    .architecture-note { display: flex; gap: 7px; padding: 10px 12px; border: 1px solid rgba(15,118,110,.25); border-radius: 8px; background: rgba(15,118,110,.07); color: var(--muted); font-size: 12px; }
    .architecture-note strong { color: var(--ink); }
    .transport-integration { display: grid; gap: 14px; }
    .transport-paths { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; }
    .transport-path { position: relative; display: grid; grid-template-columns: minmax(0,.9fr) auto minmax(0,1.1fr); align-items: stretch; gap: 10px; min-height: 180px; padding: 16px; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); box-shadow: var(--shadow); }
    .transport-path--webrtc { border-top: 4px solid #818cf8; }
    .transport-path--sip { border-top: 4px solid #22d3ee; }
    .transport-node { display: grid; align-content: center; gap: 5px; min-width: 0; padding: 13px; border: 1px solid var(--line); border-radius: 11px; background: #f8fafc; }
    .transport-node small { color: var(--muted); font-size: 10px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    .transport-node strong { font-size: clamp(16px,1.8vw,22px); line-height: 1.12; }
    .transport-node code { color: var(--blue); font-size: clamp(13px,1vw,14px); line-height: 1.4; overflow-wrap: anywhere; }
    .transport-arrow { display: grid; place-items: center; color: var(--blue); font-size: 24px; font-weight: 900; }
    .integration-truths { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 0; padding-top: 10px; border-top: 1px solid var(--line); }
    .integration-truth { padding: 4px 12px; color: var(--ink); text-align: center; }
    .integration-truth:not(:last-child) { border-right: 1px solid var(--line); }
    .integration-truth strong { display: block; margin: 0; font-size: 13px; }
    #tts { align-content: start; gap: 9px; }
    .tts-layout { display: grid; grid-template-columns: minmax(0,1.08fr) minmax(320px,.92fr); gap: 14px; align-items: stretch; }
    .tts-lab { display: grid; align-content: start; gap: 10px; padding: 16px; border: 1px solid rgba(52,211,153,.28); border-radius: 14px; background: linear-gradient(180deg,#081a1b,#071019); color: #e8fdf4; box-shadow: 0 20px 48px rgba(8,20,40,.2); }
    .tts-lab-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    .tts-lab-head > div { display: grid; gap: 3px; }
    .tts-lab-head strong { font-size: 18px; }
    .tts-lab-head span:not(.badge), .tts-lab label { color: #9dbab4; font-size: 11px; }
    .tts-provider-choice label { color: #6ee7b7; font-size: 9px; font-weight: 850; letter-spacing: .09em; text-transform: uppercase; }
    .tts-provider-choice select { min-width: 190px; padding: 2px 28px 2px 0; border: 0; background: transparent; color: #f0fdfa; font: 850 18px/1.25 system-ui,sans-serif; }
    .tts-provider-choice select:focus-visible { outline: 2px solid #5eead4; outline-offset: 3px; }
    .tts-lab textarea { min-height: 92px; resize: none; border-color: rgba(110,231,183,.25); background: rgba(2,8,20,.62); color: #e8fdf4; }
    .tts-text-label { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .tts-text-label small { color: #6ee7b7; font-size: 10px; font-weight: 750; }
    .tts-text-progress { display: flex; flex-wrap: wrap; gap: 6px; min-height: 45px; padding: 9px 10px; border: 1px solid rgba(110,231,183,.18); border-radius: 9px; background: rgba(2,8,20,.42); }
    .tts-text-chunk { display: inline-flex; align-items: center; min-height: 25px; padding: 3px 7px; border: 1px solid rgba(148,163,184,.18); border-radius: 6px; background: rgba(15,23,42,.62); color: #8ca8a2; font: 700 10.5px/1.3 system-ui,sans-serif; transition: background .16s ease,color .16s ease,border-color .16s ease; }
    .tts-text-chunk.is-buffered { border-color: rgba(94,234,212,.34); color: #ccfbf1; }
    .tts-text-chunk.is-playing { border-color: #5eead4; background: #0f766e; color: #fff; box-shadow: 0 0 0 2px rgba(94,234,212,.16); }
    .tts-text-chunk.is-played { border-color: rgba(52,211,153,.22); background: rgba(6,78,59,.42); color: #a7f3d0; }
    .tts-lab .actions { align-items: center; }
    .tts-lab .actions .muted { flex: 1; color: #9dbab4; }
    .tts-lab audio { width: 100%; height: 34px; }
    .tts-metrics { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 8px; }
    .tts-metrics .plain { min-height: 72px; padding: 10px; background: rgba(2,8,20,.62); border-color: rgba(110,231,183,.18); }
    .tts-metrics strong { color: #6ee7b7; }
    .tts-candidates { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); align-content: start; gap: 8px; }
    .tts-candidates-head { grid-column: 1 / -1; display: flex; align-items: end; justify-content: space-between; gap: 10px; }
    .tts-candidates-head strong { font-size: 16px; }
    .tts-candidates-head span, .tts-candidates > p { margin: 0; color: var(--muted); font-size: 10.5px; line-height: 1.35; }
    .tts-candidates > p { grid-column: 1 / -1; }
    .tts-candidate { display: grid; align-content: start; gap: 5px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); box-shadow: var(--shadow); }
    .tts-candidate > span { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .tts-candidate strong { color: var(--ink); font-size: 14px; }
    .tts-candidate b { color: var(--teal); font: 800 13px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .tts-candidate small { color: var(--muted); font-size: 10.5px; }
    .tts-candidate a { width: fit-content; font-size: 10.5px; }
    @keyframes liveAsrWave { from { transform: scaleY(.35); } to { transform: scaleY(1.25); } }
    .brain { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
    .voice-origin { position: relative; isolation: isolate; overflow: hidden; min-height: calc(100vh - var(--topbar-height)); padding: 0; border-bottom: 0; background: #071019; color: #f8fafc; }
    .voice-origin__photo { position: absolute; z-index: -4; inset: -2%; width: 104%; height: 104%; object-fit: cover; object-position: 50% 38%; filter: saturate(.82) contrast(1.06) brightness(.82); transform: scale(1.015); }
    .voice-origin::before { content: ""; position: absolute; z-index: -3; inset: 0; background: radial-gradient(ellipse 72% 66% at 15% 23%,rgba(3,7,12,.94) 0%,rgba(3,7,12,.78) 44%,rgba(3,7,12,.18) 79%,transparent 100%),linear-gradient(90deg,rgba(3,7,12,.64) 0%,rgba(3,7,12,.38) 48%,rgba(3,7,12,.08) 78%,rgba(3,7,12,.03) 100%),linear-gradient(0deg,rgba(3,7,12,.38),transparent 52%); }
    .voice-origin::after { content: ""; position: absolute; z-index: -2; inset: 0; pointer-events: none; opacity: .48; background: radial-gradient(circle at 24% 72%,rgba(103,232,249,.16),transparent 10%),linear-gradient(105deg,transparent 0 43%,rgba(255,255,255,.055) 49%,transparent 55%); mix-blend-mode: screen; }
    .voice-origin__content { position: relative; display: grid; align-content: start; gap: clamp(10px,1.55vh,17px); width: min(74vw,1180px); min-height: calc(100vh - var(--topbar-height)); padding: clamp(38px,4.8vh,58px) clamp(24px,2.6vw,46px) clamp(34px,4vh,52px) clamp(46px,6vw,96px); }
    @media (min-width: 921px) { .present .voice-origin__content { padding-top: clamp(60px,7.5vh,84px); padding-bottom: clamp(150px,18vh,190px); } .present .voice-origin__turn { position: absolute; right: clamp(24px,2.6vw,46px); bottom: clamp(42px,5vh,64px); left: clamp(46px,6vw,96px); } }
    .voice-origin__eyebrow { display: flex; align-items: center; gap: 11px; color: #a5f3fc; font-size: clamp(10px,1vw,13px); font-weight: 850; letter-spacing: .16em; text-transform: uppercase; opacity: 0; transform: translateY(12px); }
    .voice-origin__eyebrow::before { content: ""; width: clamp(34px,4vw,62px); border-top: 2px solid #67e8f9; box-shadow: 0 0 18px rgba(103,232,249,.48); }
    .voice-origin__eyebrow b { display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid rgba(165,243,252,.7); border-radius: 50%; color: #ecfeff; font-size: 13px; letter-spacing: 0; }
    .voice-origin__title { display: grid; gap: 1px; max-width: 980px; margin: 0; color: #f8fafc; font-family: "Arial Narrow", "Aptos Narrow", Inter, ui-sans-serif, system-ui, sans-serif; font-size: clamp(38px,4.25vw,62px); font-stretch: condensed; font-weight: 850; line-height: .91; letter-spacing: -.035em; text-transform: uppercase; text-wrap: initial; }
    .voice-origin__title span { display: block; width: fit-content; max-width: 100%; opacity: 0; transform: translateY(28px); text-shadow: 0 3px 28px rgba(0,0,0,.52); }
    .voice-origin__title .voice-origin__accent { position: relative; color: #ecfeff; }
    .voice-origin__title .voice-origin__accent::after { content: ""; position: absolute; left: 0; right: 0; bottom: -.12em; height: .065em; background: linear-gradient(90deg,#67e8f9,rgba(103,232,249,0)); transform: scaleX(0); transform-origin: left; box-shadow: 0 0 20px rgba(103,232,249,.45); }
    .voice-origin__aftermath { max-width: 1180px; margin-top: clamp(5px,1.2vh,14px); }
    .voice-origin__fallback { position: relative; max-width: 700px; margin: 0; padding: 8px 0 9px 23px; border-left: 3px solid #fb7185; opacity: 0; transform: translateY(18px); }
    .voice-origin__fallback::before { content: ""; position: absolute; left: -3px; top: 0; width: 3px; height: 100%; background: #fb7185; box-shadow: 0 0 22px rgba(251,113,133,.62); }
    .voice-origin__fallback p { margin: 0; color: rgba(255,255,255,.86); font-family: Georgia, "Times New Roman", serif; font-size: clamp(21px,2.05vw,32px); font-style: italic; line-height: 1.16; text-shadow: 0 2px 18px rgba(0,0,0,.54); }
    .voice-origin__turn { display: grid; grid-template-columns: minmax(220px,.8fr) minmax(360px,1.25fr); gap: clamp(24px,3vw,46px); max-width: 980px; opacity: 0; transform: translateY(16px); }
    .voice-origin__beat { display: grid; grid-template-columns: 38px minmax(0,1fr); gap: 12px; align-items: start; }
    .voice-origin__beat > b { display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid rgba(165,243,252,.72); border-radius: 50%; color: #ecfeff; background: rgba(3,7,12,.32); font-size: 17px; line-height: 1; box-shadow: 0 0 18px rgba(103,232,249,.16); }
    .voice-origin__beat > span { padding-top: 5px; color: #a5f3fc; font-size: clamp(11px,.95vw,14px); font-weight: 850; letter-spacing: .14em; line-height: 1.3; text-transform: uppercase; text-shadow: 0 2px 16px rgba(0,0,0,.6); }
    .voice-origin__beat > strong { display: block; color: #fff; font-family: "Arial Narrow", "Aptos Narrow", Inter, ui-sans-serif, system-ui, sans-serif; font-size: clamp(25px,2.45vw,38px); font-weight: 800; line-height: 1.02; letter-spacing: -.03em; text-shadow: 0 3px 24px rgba(0,0,0,.72); }
    .voice-origin__turn em { color: #cffafe; font-style: normal; }
    .voice-origin.active .voice-origin__photo { animation: voiceOriginDrift 15s ease-out both; }
    .voice-origin.active .voice-origin__eyebrow { animation: voiceOriginReveal .72s .12s cubic-bezier(.2,.7,.2,1) forwards; }
    .voice-origin.active .voice-origin__title span:nth-child(1) { animation: voiceOriginReveal .78s .28s cubic-bezier(.2,.7,.2,1) forwards; }
    .voice-origin.active .voice-origin__title span:nth-child(2) { animation: voiceOriginReveal .78s .44s cubic-bezier(.2,.7,.2,1) forwards; }
    .voice-origin.active .voice-origin__title span:nth-child(3) { animation: voiceOriginReveal .78s .60s cubic-bezier(.2,.7,.2,1) forwards; }
    .voice-origin.active .voice-origin__title span:nth-child(4) { animation: voiceOriginReveal .78s .76s cubic-bezier(.2,.7,.2,1) forwards; }
    .voice-origin.active .voice-origin__title .voice-origin__accent::after { animation: voiceOriginUnderline .9s 1.02s cubic-bezier(.2,.7,.2,1) forwards; }
    .voice-origin.active .voice-origin__fallback { animation: voiceOriginFallback .8s 1.22s cubic-bezier(.2,.7,.2,1) forwards; }
    .voice-origin.active .voice-origin__turn { animation: voiceOriginReveal .8s 2.05s cubic-bezier(.2,.7,.2,1) forwards; }
    .scroll .voice-origin__eyebrow, .scroll .voice-origin__title span, .scroll .voice-origin__fallback, .scroll .voice-origin__turn { opacity: 1; transform: none; filter: none; }
    .scroll .voice-origin__title .voice-origin__accent::after { transform: scaleX(1); }
    @keyframes voiceOriginReveal { to { opacity: 1; transform: none; } }
    @keyframes voiceOriginUnderline { to { transform: scaleX(1); } }
    @keyframes voiceOriginFallback { 0% { opacity: 0; transform: translateY(18px); filter: blur(5px); } 72% { opacity: 1; filter: blur(0); } 100% { opacity: 1; transform: none; filter: none; } }
    @keyframes voiceOriginDrift { from { transform: scale(1.015) translate3d(0,0,0); } to { transform: scale(1.065) translate3d(-.35%,.2%,0); } }
    .present.voice-story-active main { padding-top: 0; }
    .present.voice-story-active .voice-origin, .present.voice-story-active .voice-origin__content { min-height: 100vh; }
    .present.voice-story-active .topbar { border-bottom: 0; padding: 15px 22px 27px; background: linear-gradient(180deg,rgba(3,7,12,.76) 0%,rgba(3,7,12,.34) 54%,transparent 100%); color: #f8fafc; box-shadow: none; backdrop-filter: none; }
    .present.voice-story-active .brand { opacity: .78; }
    .present.voice-story-active .brand .kicker, .present.voice-story-active .slide-status { color: rgba(207,250,254,.76); }
    .present.voice-story-active .toolbar > a { display: none; }
    .present.voice-story-active .toolbar button { border-color: rgba(207,250,254,.38); background: rgba(3,7,12,.4); color: #f8fafc; backdrop-filter: blur(8px); }
    .present.voice-story-active .toolbar button.primary { border-color: rgba(103,232,249,.72); background: rgba(15,118,110,.78); box-shadow: 0 0 0 1px rgba(103,232,249,.18),0 0 22px rgba(103,232,249,.14); }
    #agent { position: relative; align-content: start; gap: 8px; }
    #agent .subhead { max-width: none; font-size: clamp(15px,1.45vw,18px); }
    .agent-state-head { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
    .agent-state-legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px 14px; color: var(--muted); font-size: 10.5px; font-weight: 750; }
    .agent-state-legend span { display: inline-flex; align-items: center; gap: 6px; }
    .agent-state-legend i { width: 10px; height: 10px; border-radius: 50%; background: var(--legend); box-shadow: 0 0 0 3px color-mix(in srgb,var(--legend) 18%,transparent); }
    .agent-authority-map { display: grid; gap: 7px; padding: 14px 16px; border: 1px solid rgba(125,211,252,.2); border-radius: 16px; background: radial-gradient(circle at 22% 0%,rgba(34,211,238,.1),transparent 28%),linear-gradient(145deg,#07111f,#0b1b2e); color: #e8f4ff; box-shadow: 0 22px 48px rgba(8,20,40,.2); }
    .agent-flow-row, .agent-proposal-row { display: grid; grid-template-columns: 132px minmax(0,1fr) 22px minmax(0,1fr) 22px minmax(0,1fr) 22px minmax(0,1fr); gap: 6px; align-items: stretch; }
    .agent-lane-label { display: grid; align-content: center; gap: 4px; padding: 10px 12px; border-left: 4px solid var(--lane-color); color: #f8fafc; }
    .agent-lane-label small { color: var(--lane-color); font-size: 9px; font-weight: 900; letter-spacing: .09em; text-transform: uppercase; }
    .agent-lane-label strong { font-size: 14px; line-height: 1.14; }
    .agent-flow-node { position: relative; display: grid; align-content: center; gap: 4px; min-width: 0; min-height: 78px; padding: 10px 12px; border: 1px solid var(--node-border); border-radius: 10px; background: var(--node-background); color: #f8fafc; text-align: left; }
    button.agent-flow-node { width: 100%; font: inherit; cursor: pointer; }
    button.agent-flow-node:hover, button.agent-flow-node:focus-visible { border-color: #67e8f9; box-shadow: 0 0 0 2px rgba(103,232,249,.2),0 12px 24px rgba(8,145,178,.13); transform: translateY(-1px); }
    button.agent-flow-node::after { content: "</>"; position: absolute; top: 7px; right: 8px; color: var(--node-accent); font: 800 8px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; opacity: .78; }
    .agent-flow-node small { color: var(--node-accent); font-size: 9px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    .agent-flow-node strong { color: #f8fafc; font-size: 15px; line-height: 1.12; }
    .agent-flow-node code, .agent-flow-node span { color: #b7c8da; font-size: 10px; line-height: 1.3; overflow-wrap: anywhere; }
    .agent-flow-node--conversation { --node-border: rgba(34,211,238,.32); --node-background: rgba(8,47,73,.62); --node-accent: #67e8f9; }
    .agent-flow-node--business { --node-border: rgba(167,139,250,.34); --node-background: rgba(46,32,87,.55); --node-accent: #c4b5fd; }
    .agent-flow-node--approval { --node-border: rgba(251,191,36,.46); --node-background: rgba(92,55,10,.58); --node-accent: #fcd34d; }
    .agent-flow-node--execute { --node-border: rgba(167,139,250,.42); --node-background: rgba(46,32,87,.72); --node-accent: #ddd6fe; }
    .agent-flow-arrow { display: grid; place-items: center; color: #7dd3fc; font-size: 22px; }
    .agent-flow-row--application .agent-flow-arrow { color: #c4b5fd; }
    .agent-proposal-row { min-height: 38px; }
    .agent-proposal { display: grid; grid-template-columns: 1fr; place-items: center; color: #94a3b8; font: 750 9px/1.15 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; text-align: center; }
    .agent-proposal::before { content: ""; width: 0; height: 15px; border-left: 2px dashed #22d3ee; }
    .agent-proposal--result::before { border-color: #a78bfa; }
    .agent-proposal--result { color: #c4b5fd; }
    .agent-approval-outcomes { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 7px; padding: 1px 4px 0; color: #a9bbcf; font-size: 10px; }
    .agent-approval-outcomes strong { color: #fcd34d; }
    .agent-approval-outcomes span { padding: 4px 7px; border: 1px solid rgba(251,191,36,.2); border-radius: 999px; background: rgba(92,55,10,.28); }
    .agent-approval-outcomes span:last-child { border-color: rgba(248,113,113,.2); background: rgba(127,29,29,.2); color: #fecaca; }
    .agent-state-principle { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 9px 14px; border-left: 5px solid var(--blue); background: linear-gradient(90deg,rgba(36,87,166,.08),transparent); color: var(--muted); font-size: 11.5px; }
    .agent-state-principle strong { color: var(--ink); font-size: 14px; }
    .agent-code-modal { position: absolute; z-index: 40; inset: 0; display: grid; place-items: center; padding: 74px 44px 28px; background: rgba(3,7,18,.72); backdrop-filter: blur(7px); }
    .agent-code-modal[hidden] { display: none; }
    .agent-code-panel { display: grid; grid-template-rows: auto minmax(0,1fr); width: min(900px,100%); max-height: min(560px,calc(100vh - 120px)); overflow: hidden; border: 1px solid rgba(103,232,249,.35); border-radius: 16px; background: #07111f; color: #e8f4ff; box-shadow: 0 30px 80px rgba(0,0,0,.42); }
    .agent-code-head { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 18px; border-bottom: 1px solid rgba(125,211,252,.17); }
    .agent-code-head > div { display: grid; gap: 3px; }
    .agent-code-head small { color: #67e8f9; font-size: 9px; font-weight: 850; letter-spacing: .09em; text-transform: uppercase; }
    .agent-code-head strong { color: #f8fafc; font-size: 20px; }
    .agent-code-head button { flex: 0 0 auto; border-color: rgba(125,211,252,.32); background: rgba(15,23,42,.68); color: #e8f4ff; }
    .agent-code-panel pre { margin: 0; padding: 17px 20px 20px; overflow: auto; background: #050d18; color: #dbeafe; font: 12.5px/1.48 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space: pre; tab-size: 4; }
    textarea { width: 100%; min-height: 88px; resize: vertical; border: 1px solid var(--line); border-radius: 7px; padding: 11px; color: var(--ink); font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .proof-pre { margin: 0; min-height: 260px; max-height: 460px; overflow: auto; border-radius: 8px; padding: 15px; background: #0d1117; color: #e6edf3; font: 13px/1.58 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .talk-attribution { margin: 0; color: var(--muted); font-size: 13px; font-weight: 650; letter-spacing: .01em; }
    .slide-status { min-width: 58px; text-align: center; color: var(--muted); font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .present .topbar { position: fixed; width: 100%; }
    .present main { padding-top: var(--topbar-height); }
    .present .slide, .present .hero { min-height: calc(100vh - var(--topbar-height)); }
    .present #asr { align-content: center; }
    .present #demo, .present #tts { align-content: start; padding-top: clamp(16px, 2.4vh, 24px); }
    .present #demo { height: calc(100vh - var(--topbar-height)); min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    .present .section-band:not(.active), .present .hero:not(.active) { display: none; }

    .security-layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(300px, .75fr); gap: 16px; align-items: stretch; }
    .security-boundary { display: grid; gap: 12px; padding: 18px; border: 1px solid rgba(45,212,191,.34); border-radius: 16px; background: linear-gradient(145deg,rgba(6,78,59,.18),rgba(8,20,40,.92)); color: #e8f4ff; box-shadow: var(--shadow); }
    .security-flow { display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); gap: 7px; align-items: stretch; }
    .security-node { position: relative; display: grid; align-content: center; gap: 5px; min-height: 112px; padding: 10px; border: 1px solid var(--line); border-radius: 10px; background: rgba(2,8,20,.7); text-align: center; }
    .security-node:not(:last-child)::after { content: "→"; position: absolute; z-index: 2; right: -11px; top: 50%; transform: translateY(-50%); color: #7dd3fc; font-weight: 900; }
    .security-node small { color: #a5f3fc; font-size: 9px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    .security-node strong, .security-pane > strong { color: #f8fafc; }
    .security-node strong { font-size: 12px; line-height: 1.3; }
    .security-node--guard { border-color: rgba(52,211,153,.66); background: rgba(4,52,40,.78); }
    .security-node--provider { border-color: rgba(192,132,252,.58); background: rgba(55,18,92,.72); }
    .security-node--guard small, .security-node--provider small { font-size: 10px; }
    .security-node--guard strong, .security-node--provider strong { font-size: 13px; }
    .security-gate { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 10px; }
    .security-pane { display: grid; align-content: start; gap: 8px; min-height: 190px; padding: 13px; border: 1px solid var(--line); border-radius: 10px; background: rgba(2,6,18,.7); }
    .security-pane pre { margin: 0; color: #dbeafe; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .security-result { display: grid; align-content: start; gap: 12px; padding: 18px; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); box-shadow: var(--shadow); }
    .security-result .actions { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); }
    .security-controls { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
    .security-controls li { padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); font-size: 12px; }
    .security-controls li::before { content: "✓"; margin-right: 8px; color: var(--green); font-weight: 900; }
    .security-links { display: flex; flex-wrap: wrap; gap: 8px; }
    @media (max-width: 920px) { .security-layout { grid-template-columns: 1fr; } .security-flow { display: flex; overflow-x: auto; } .security-node { flex: 0 0 150px; } .security-gate { grid-template-columns: 1fr; } }
    .ecosystem-diagram { display: grid; grid-template-columns: minmax(0, 1fr) minmax(140px, .38fr) minmax(0, 1fr); gap: 18px; align-items: start; }
    .ecosystem-lane { display: grid; gap: 10px; align-items: start; }
    .ecosystem-card { position: relative; min-height: 150px; display: grid; align-content: center; gap: 7px; padding: 22px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); color: inherit; text-decoration: none; box-shadow: var(--shadow); transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease; }
    .ecosystem-card::after { content: "↗"; position: absolute; top: 14px; right: 16px; color: var(--blue); font-size: 16px; font-weight: 900; }
    .ecosystem-card:hover { transform: translateY(-2px); border-color: rgba(36,87,166,.52); box-shadow: 0 14px 32px rgba(15,23,42,.14); }
    .ecosystem-card:focus-visible { outline: 3px solid rgba(14,116,144,.4); outline-offset: 3px; }
    .ecosystem-card--primary { border-color: rgba(45, 212, 191, .54); background: linear-gradient(145deg, rgba(13, 45, 50, .92), rgba(8, 24, 42, .96)); }
    .ecosystem-card--target { border-color: rgba(56, 189, 248, .48); background: linear-gradient(145deg, rgba(8, 47, 73, .9), rgba(9, 24, 45, .96)); }
    .ecosystem-card small { color: #526273; font-size: 11px; font-weight: 850; letter-spacing: .1em; text-transform: uppercase; }
    .ecosystem-card strong { font-size: clamp(21px, 2.5vw, 30px); line-height: 1.04; }
    .ecosystem-card span { color: #425466; line-height: 1.4; }
    .ecosystem-card--primary small, .ecosystem-card--target small { color: #93c5fd; }
    .ecosystem-card--primary strong, .ecosystem-card--target strong { color: #f8fafc; }
    .ecosystem-card--primary span, .ecosystem-card--target span { color: #dbeafe; }
    .ecosystem-arrow-down { display: grid; justify-items: center; gap: 3px; color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
    .ecosystem-arrow-down b { color: var(--blue); font-size: 24px; line-height: 1; }
    .ecosystem-handoff { min-height: 150px; display: grid; align-content: center; justify-items: center; gap: 12px; text-align: center; }
    .ecosystem-handoff span { display: inline-flex; width: 100%; justify-content: center; padding: 8px 10px; border: 1px solid rgba(125, 162, 201, .3); border-radius: 999px; background: rgba(15, 27, 50, .78); color: #d9f7ff; font-size: 12px; font-weight: 800; }
    .ecosystem-foot { display: flex; justify-content: center; margin-top: 2px; color: var(--muted); font-size: 13px; }
    .slo-layout { display: grid; grid-template-columns: minmax(0,1fr) auto minmax(0,1fr); gap: 20px; align-items: stretch; }
    .slo-column { display: grid; gap: 15px; padding: 22px 24px; border: 1px solid var(--line); border-radius: 16px; background: #fff; box-shadow: var(--shadow); }
    .slo-column--conversation { border-color: rgba(36,87,166,.32); background: linear-gradient(145deg,rgba(36,87,166,.08),#fff); }
    .slo-column small { color: var(--muted); font-size: 11px; font-weight: 850; letter-spacing: .09em; text-transform: uppercase; }
    .slo-column strong { font-size: clamp(24px,2.7vw,34px); line-height: 1.08; }
    .slo-column ul { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; color: var(--muted); font-size: 16px; line-height: 1.35; }
    .slo-column li { position: relative; padding-left: 20px; }
    .slo-column li::before { content: "✓"; position: absolute; left: 0; color: var(--teal); font-weight: 900; }
    .slo-bridge { display: grid; align-content: center; justify-items: center; gap: 6px; color: var(--blue); }
    .slo-bridge b { font-size: 32px; line-height: 1; }
    .slo-bridge span { max-width: 100px; color: var(--muted); font-size: 11px; font-weight: 800; line-height: 1.25; text-align: center; text-transform: uppercase; }
    .slo-measures { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 14px; padding: 15px 18px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .slo-measure { display: grid; gap: 3px; }
    .slo-measure strong { font-size: 15px; }
    .slo-measure span { color: var(--muted); font-size: 12px; line-height: 1.35; }
    .slo-foot { display: flex; justify-content: space-between; align-items: center; gap: 18px; color: var(--muted); font-size: 12px; }
    .slo-foot strong { color: var(--ink); }
    .slo-sources { display: flex; gap: 12px; }
    .slo-sources a { color: var(--blue); font-weight: 750; }
    .finale { color: #e8f4ff; background: radial-gradient(circle at 10% 10%,rgba(34,211,238,.18),transparent 34%),radial-gradient(circle at 92% 84%,rgba(168,85,247,.18),transparent 32%),linear-gradient(145deg,#06111f,#0a1830 58%,#07101d); }
    .finale .kicker { color: #67e8f9; }
    .finale h2 { max-width: 1080px; color: #f8fafc; font-size: clamp(34px,4.6vw,60px); }
    .finale .subhead { display: flex; flex-wrap: wrap; gap: 6px; max-width: 980px; color: #bfdbfe; }
    .finale .subhead strong { color: #f8fafc; }
    .finale-callback { display: flex; align-items: center; gap: 16px; width: fit-content; color: #a9bfd8; font-size: 18px; }
    .finale-callback b { color: #67e8f9; font-size: 28px; line-height: 1; }
    .finale-callback strong { color: #f8fafc; font-size: 22px; }
    .finale-invitation { display: flex; align-items: baseline; gap: 12px; color: #9db7d3; }
    .finale-invitation strong { color: #67e8f9; font-size: 21px; }
    .finale-invitation span { font-size: 13px; }
    .finale-layout { display: grid; grid-template-columns: minmax(0,1.2fr) minmax(300px,.8fr); gap: 20px; align-items: stretch; }
    .project-links { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 10px; }
    .project-link { display: grid; align-content: center; gap: 5px; min-height: 108px; padding: 14px; border: 1px solid rgba(125,211,252,.24); border-radius: 13px; background: rgba(8,31,53,.72); color: #e0f2fe; }
    .project-link small { color: #7dd3fc; font-size: 10px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    .project-link strong { color: #f8fafc; font-size: 16px; }
    .project-link span { color: #9db7d3; font-size: 11px; line-height: 1.4; }
    .finale-contact { display: grid; grid-template-columns: minmax(0,1fr) 138px; align-items: center; gap: 18px; padding: 20px; border: 1px solid rgba(125,211,252,.24); border-radius: 16px; background: rgba(2,8,20,.62); }
    .finale-contact__details { display: grid; align-content: center; gap: 10px; min-width: 0; }
    .finale-logo { width: min(320px,100%); max-height: 92px; object-fit: contain; object-position: left center; }
    .finale-contact strong { color: #f8fafc; font-size: 20px; }
    .finale-contact a { width: fit-content; color: #67e8f9; }
    .finale-linkedin { display: grid; justify-items: center; gap: 7px; text-align: center; text-decoration: none; }
    .finale-linkedin img { width: 132px; aspect-ratio: 1; padding: 5px; border-radius: 10px; background: #fff; box-shadow: 0 10px 26px rgba(0,0,0,.28); }
    .finale-linkedin span { color: #f8fafc; font-size: 12px; font-weight: 850; line-height: 1.2; }
    @media (max-width: 1100px) { .demo-control-step { padding-inline: 12px; } .demo-result-item span { font-size: 11px; } }
    @media (max-width: 920px) {
      .voice-origin { min-height: calc(100svh - 116px); }
      .voice-origin__photo { object-position: 57% 38%; }
      .voice-origin::before { background: linear-gradient(0deg,rgba(3,7,12,.96) 0%,rgba(3,7,12,.78) 48%,rgba(3,7,12,.24) 78%,rgba(3,7,12,.16) 100%); }
      .voice-origin__content { align-content: end; gap: 10px; width: 100%; min-height: calc(100svh - 116px); padding: 24px 24px 30px; }
      .voice-origin__title { max-width: 760px; font-size: clamp(30px,5.8vw,40px); }
      .voice-origin__aftermath { margin-top: 2px; }
      .voice-origin__fallback { max-width: 620px; }
      .voice-origin__turn { grid-template-columns: 1fr; gap: 10px; }
      .voice-origin__beat > strong { font-size: clamp(18px,3.5vw,24px); }
      .present.voice-story-active .topbar { position: fixed; align-items: center; flex-direction: row; padding: 12px 16px 24px; }
      .present.voice-story-active .brand { min-width: 0; }
      .present.voice-story-active .toolbar { flex-wrap: nowrap; }
      .agent-state-head, .agent-state-principle { align-items: flex-start; flex-direction: column; gap: 7px; }
      .agent-state-legend { justify-content: flex-start; }
      .agent-authority-map { overflow-x: auto; }
      .agent-flow-row, .agent-proposal-row { min-width: 930px; }
      .agent-code-modal { position: fixed; padding: 72px 18px 22px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .voice-origin__photo, .voice-origin__eyebrow, .voice-origin__title span, .voice-origin__title .voice-origin__accent::after, .voice-origin__fallback, .voice-origin__turn { animation: none !important; }
      .voice-origin__photo { transform: scale(1.015); }
      .voice-origin__eyebrow, .voice-origin__title span, .voice-origin__fallback, .voice-origin__turn { opacity: 1; transform: none; filter: none; }
      .voice-origin__title .voice-origin__accent::after { transform: scaleX(1); }
    }
    @media (max-width: 920px) { .ecosystem-diagram { grid-template-columns: minmax(0, 1fr); } .ecosystem-handoff { min-height: auto; grid-template-columns: 1fr 1fr; } .ecosystem-card { min-height: 132px; } .two, .vad-layout, .transport-paths, .finale-layout { grid-template-columns: 1fr; } .integration-truths, .control-stack, .contract-evidence, .agent-max-impact, .project-links { grid-template-columns: 1fr; } .finale-callback, .finale-invitation { align-items: flex-start; flex-direction: column; gap: 5px; } .finale-callback b { transform: rotate(90deg); } .control-layer:not(:last-child)::after { content: "↓"; right: auto; left: 50%; top: auto; bottom: -21px; transform: translateX(-50%); } .contrast-grid { grid-template-columns: 1fr; } .versus { width: auto; height: 34px; border-radius: 999px; } .contrast-card { min-height: 0; } .boundary-strip { grid-template-columns: 1fr; } .boundary-gate { justify-self: center; } .pipecat-flow { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; padding: 2px 2px 8px; } .pipecat-node { flex: 0 0 min(70vw,220px); scroll-snap-align: start; } .turn-references { grid-template-columns: 1fr; } .present .topbar { position: static; width: auto; } .present main { padding-top: 0; } .present .slide, .present .hero { min-height: calc(100vh - var(--topbar-height)); } .present #demo { height: auto; min-height: calc(100vh - var(--topbar-height)); overflow: visible; } .topbar { align-items: stretch; flex-direction: column; } .toolbar { justify-content: flex-start; } .hero, .slide, .section-band { padding: 28px 14px; } h1 { font-size: 38px; } .event, #demo .event { grid-template-columns: minmax(0, 1fr); } #demo .actions { grid-template-columns: repeat(2, minmax(0, 1fr)); } #demo .screen, #demo .timeline, .present #demo .screen, .present #demo .timeline { max-height: min(48vh, 380px); } .asr-live-controls { grid-template-columns: minmax(0, 1fr); } .voice-pipeline__chrome { padding: 16px 14px 10px; } .voice-pipeline__canvas { padding: 8px 8px 14px; } .xform-rail { display: none; } .voice-pipeline__stages { display: flex; gap: 12px; overflow-x: auto; scroll-snap-type: x mandatory; padding: 12px 4px 4px; -webkit-overflow-scrolling: touch; } .voice-pipeline__stage { flex: 0 0 min(82vw, 300px); scroll-snap-align: start; min-height: 260px; } }
    @media (max-width: 920px) { .tts-layout, .asr-noise-guidance { grid-template-columns: minmax(0,1fr); } .asr-noise-guidance ul { grid-template-columns: minmax(0,1fr); } .asr-noise-foot { grid-column: auto; align-items: flex-start; flex-direction: column; } }
    @media (max-width: 920px) { .asr-app-flow { display: flex; overflow-x: auto; } .asr-app-node { flex: 0 0 min(70vw,260px); min-height: 210px; } .asr-app-link { flex: 0 0 105px; } .asr-benefits { grid-template-columns: repeat(2,minmax(0,1fr)); } }
    @media (max-width: 920px) { .demo-commandbar { grid-template-columns: 1fr; } .demo-control-story { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; } .demo-control-story::before, .demo-control-step:not(:last-child)::after { display: none; } .demo-result-grid, .demo-evidence-grid { grid-template-columns: 1fr; } .demo-result-item:not(:last-child) { margin-right: 0; padding-bottom: 8px; border-right: 0; border-bottom: 1px solid rgba(125,211,252,.18); } }
    @media (max-width: 920px) { .slo-layout { grid-template-columns: 1fr; } .slo-bridge { min-height: 46px; } .slo-bridge b { transform: rotate(90deg); } .slo-measures { grid-template-columns: repeat(2,minmax(0,1fr)); } .slo-foot { align-items: flex-start; flex-direction: column; } }
    @media (max-width: 520px) { #demo .actions { grid-template-columns: minmax(0, 1fr); } #demo .screen { min-height: 240px; } .transcript-turn { grid-template-columns: minmax(0, 1fr); gap: 4px; } #asr-benchmarks { grid-template-columns: minmax(0, 1fr); } .asr-benchmark-source { grid-column: auto; align-items: flex-start; flex-direction: column; } }
    @media (max-width: 520px) { .demo-drill-picker, .demo-control-story { grid-template-columns: 1fr; } .demo-drill-picker label { grid-column: auto; } .demo-control-step:not(:last-child)::after { display: none; } #demo .screen { min-height: 0; } }
    @media (max-width: 520px) { .present.voice-story-active .brand { display: none; } .present.voice-story-active .topbar { justify-content: flex-end; } }
    @media (max-width: 520px) { .tts-metrics, .tts-candidates { grid-template-columns: minmax(0,1fr); } .tts-candidate > span, .tts-candidates-head { align-items: flex-start; flex-direction: column; } }
    @media (min-width: 921px) and (max-height: 820px) {
      .present .hero, .present .slide { padding-block: 22px; gap: 8px; }
      .present h2 { font-size: clamp(28px, 3.25vw, 42px); }
      .present .subhead { font-size: 18px; line-height: 1.25; }
      .present #vad-interruption .turn-references { display: none; }
      .present #vad-interruption .vad-layout { gap: 12px; }
      .present #vad-interruption .vad-console,
      .present #vad-interruption .pipeline-panel { gap: 8px; padding: 13px; }
      .present #vad-interruption .vad-meter { height: 52px; }
      .present #vad-interruption .vad-actions button { min-height: 38px; }
      .present #vad-interruption .vad-events { min-height: 86px; max-height: 86px; }
      .present #vad-interruption .pipecat-node { min-height: 118px; padding: 10px; gap: 5px; }
      .present #vad-interruption .turn-diagram { padding: 5px; }
      .present #vad-interruption .turn-diagram svg { min-height: 100px; max-height: 112px; }
      .present #map .arch { min-height: 0; max-height: 372px; }
      .present #agent, .present #slo, .present #proof { height: calc(100vh - var(--topbar-height)); min-height: 0; overflow-y: auto; align-content: start; }
    }
  </style>
</head>
<body class="${bodyClass}">
  <header class="topbar"><div class="brand"><span class="kicker">ClueCon 2026 presentation</span><strong>From SIP to Tokens</strong></div><nav class="toolbar" aria-label="ClueCon sections"><a href="/cluecon">Narrative</a><a href="/cluecon/present">Present</a><a href="/operator/console">Operator</a><a href="/assert">Proof</a><button id="prev" type="button" aria-label="Previous slide">Prev</button><span class="slide-status" id="slide-status" aria-live="polite">1 / 15</span><button id="next" type="button" class="primary" aria-label="Next slide">Next</button></nav></header>
  <main>
    <section class="hero flow-hero active" data-slide="0" id="flow"><div class="flow-header"><span class="kicker">ClueCon 2026</span><h1>From SIP to Tokens.</h1><p class="subhead">Deterministic Telephony Meets Real-Time Voice AI.</p><p class="talk-attribution">Alberto Gonzalez CTO @ WebRTC.ventures</p></div>${buildCallFlowMarkup(payload.callFlow, payload.contactPanel)}</section>
    <section class="section-band slide voice-origin" data-slide="1" id="voice-evolution" aria-labelledby="voice-origin-title"><img class="voice-origin__photo" src="/cluecon/alberto-echo-show-prototype.jpg" alt="Alberto Gonzalez testing a voice-controlled video prototype on an Amazon Echo Show."><div class="voice-origin__content"><span class="voice-origin__eyebrow"><b>1</b>January 2017 · My first voice prototype</span><h2 class="voice-origin__title" id="voice-origin-title"><span>My first voice AI</span><span>could do anything—</span><span>as long as you said</span><span class="voice-origin__accent">exactly what I expected.</span></h2><div class="voice-origin__aftermath"><blockquote class="voice-origin__fallback"><p>“I’m sorry. I didn’t understand.”</p></blockquote></div><div class="voice-origin__turn" aria-label="Voice AI story sequence"><div class="voice-origin__beat"><b>2</b><span>Six years later, GPT-4 arrived.</span></div><div class="voice-origin__beat"><b>3</b><strong>So we put <em>GPT-4</em><br>on a <em>WebRTC call.</em></strong></div></div></div></section>
    <section class="section-band slide" data-slide="2" id="realtime-problem"><span class="kicker">The realtime systems problem</span><h2>Deterministic telephony meets probabilistic inference.</h2><p class="subhead">Calls require exact state. AI estimates timing and meaning.</p><div class="contrast-grid"><article class="contrast-card contrast-card--telephony"><div class="contrast-head"><strong>Telephony / WebRTC</strong><span class="certainty">STATE IS OBSERVED</span></div><div class="rtp-cadence" aria-label="Sequence-numbered RTP packets arriving every 20 milliseconds"><div class="rtp-packet"><strong>0 ms</strong><i></i><span>seq 8041</span></div><div class="rtp-packet"><strong>20 ms</strong><i></i><span>seq 8042</span></div><div class="rtp-packet"><strong>40 ms</strong><i></i><span>seq 8043</span></div><div class="rtp-packet"><strong>60 ms</strong><i></i><span>seq 8044</span></div><div class="rtp-packet"><strong>80 ms</strong><i></i><span>seq 8045</span></div></div><ul class="contrast-list"><li><strong>Protocol</strong><span>INVITE → 18x → 200 → ACK … BYE → 200</span></li><li><strong>Media</strong><span>Sequence-numbered RTP on a media deadline</span></li><li><strong>Failure</strong><span>Timeout, transfer, or hang up</span></li></ul></article><div class="versus">VS</div><article class="contrast-card contrast-card--ai"><div class="contrast-head"><strong>Inference</strong><span class="certainty">MEANING IS ESTIMATED</span></div><div class="probability-visual"><svg viewBox="0 0 420 118" role="img" aria-label="Illustrative overlapping probability distributions for ASR hypotheses and LLM token choices"><path class="probability-axis" d="M24 96 H402"/><path class="probability-guide" d="M148 18 V96 M278 18 V96"/><path class="probability-curve probability-curve--asr" d="M24 96 C72 96 93 91 116 58 C135 31 151 23 170 58 C193 91 216 96 267 96"/><path class="probability-curve probability-curve--llm" d="M111 96 C166 96 193 92 220 60 C244 31 266 23 291 60 C319 92 346 96 402 96"/><circle class="probability-dot--asr" cx="148" cy="31" r="5"/><circle class="probability-dot--llm" cx="278" cy="34" r="5"/><text x="148" y="14" text-anchor="middle">ASR</text><text x="278" y="14" text-anchor="middle">LLM</text><text x="213" y="114" text-anchor="middle">candidate interpretation / output</text></svg><div class="probability-legend"><span>speech hypotheses</span><span>token choices</span></div></div><ul class="contrast-list"><li><strong>Listen</strong><span>VAD and end-of-turn confidence</span></li><li><strong>Meaning</strong><span>ASR revisions and ambiguous intent</span></li><li><strong>Output</strong><span>Variable latency; plausible can be wrong</span></li></ul></article></div><div class="boundary-strip"><div class="boundary-side"><strong>Never block media</strong>Run call control independently.</div><div class="boundary-gate">contract boundary</div><div class="boundary-side"><strong>Never hide uncertainty</strong>Expose partial, timeout, cancel, and fallback.</div></div></section>
    <section class="section-band slide" data-slide="3" id="vad-interruption"><span class="kicker">VAD, turns, and interruption</span><h2>The smallest signal changes the whole pipeline.</h2><p class="subhead">Start the mic, speak, pause, then interrupt the agent.</p><div class="vad-layout"><div class="vad-console"><div class="vad-console-head"><strong>Browser microphone VAD</strong><span class="badge fixture" id="vad-state">mic off</span></div><div class="vad-meter" aria-label="Live microphone level"><span class="vad-meter-fill" id="vad-meter-fill"></span><span class="vad-threshold" id="vad-threshold-line"></span><span class="vad-meter-label" id="vad-level">−∞ dBFS</span></div><div class="vad-slider"><label for="vad-threshold"><span>Speech threshold</span><strong id="vad-threshold-value">−42 dBFS</strong></label><input id="vad-threshold" type="range" min="-60" max="-20" value="-42" step="1"></div><div class="vad-actions"><button class="primary" id="vad-mic" type="button">Start microphone</button><button id="vad-agent" type="button">Play agent → interrupt</button><button id="vad-simulate" type="button">Simulate barge-in</button><button id="vad-reset" type="button">Reset</button></div><div class="vad-note">80 ms start · 350 ms acoustic stop · 2 s end-of-turn window. VAD hears activity; turn detection decides “done.”</div><div class="vad-events" id="vad-events" aria-live="polite"><div class="vad-event"><code>READY</code><span>Start the mic or simulate barge-in.</span></div></div></div><div class="pipeline-panel"><div class="pipeline-panel-head"><strong>Pipecat control path</strong><span class="badge ready">interruptions on</span></div><div class="pipecat-flow"><div class="pipecat-node" id="vad-node-input"><small>Transport</small><strong>Audio input</strong><code>InputAudioRawFrame</code></div><div class="pipecat-node" id="vad-node-turn"><small>User aggregator</small><strong>VAD + turn</strong><code>VADUserStartedSpeakingFrame<br>UserStartedSpeakingFrame</code></div><div class="pipecat-node" id="vad-node-stt"><small>rtc-asr</small><strong>Speech → text</strong><code>InterimTranscriptionFrame<br>TranscriptionFrame</code></div><div class="pipecat-node" id="vad-node-agent"><small>ACC</small><strong>Policy + tools</strong><code>LLM / tools / operator hold</code></div><div class="pipecat-node" id="vad-node-output"><small>Kokoro + transport</small><strong>Audio output</strong><code>TTSAudioRawFrame<br>InterruptionFrame clears queue</code></div></div><div class="turn-diagram" aria-label="End-of-turn timing diagram"><svg viewBox="0 0 760 156" role="img" aria-label="Speech activity, a 0.5 to 2 second turn window, LLM and policy processing, then audio output"><line class="axis" x1="34" y1="84" x2="722" y2="84"/><rect class="speech" x="62" y="50" width="218" height="68" rx="7"/><rect class="silence" x="280" y="50" width="292" height="68" rx="7"/><line class="eot" x1="572" y1="36" x2="572" y2="128"/><rect class="output" x="604" y="50" width="104" height="68" rx="7"/><text class="label-strong" x="171" y="41" text-anchor="middle">user speech</text><text x="426" y="41" text-anchor="middle">turn wait: 0.5–2 s</text><text class="label-strong" x="572" y="144" text-anchor="middle">end-of-turn</text><text class="label-strong" x="656" y="41" text-anchor="middle">audio out</text><text x="78" y="102">VAD start</text><text x="302" y="102">LLM + policy can run</text><text x="617" y="102">TTS eligible</text></svg></div><div class="turn-references"><div class="turn-reference"><strong>Pipecat turn starts</strong><a href="https://docs.pipecat.ai/api-reference/server/utilities/turn-management/user-turn-strategies#minwordsuserturnstartstrategy" target="_blank" rel="noreferrer">MinWordsUserTurnStartStrategy</a> can avoid tiny backchannels triggering interruption.</div><div class="turn-reference"><strong>Pipecat smart-turn</strong><a href="https://github.com/pipecat-ai/smart-turn" target="_blank" rel="noreferrer">smart-turn</a> models semantic turn completion instead of treating every pause as done.</div><div class="turn-reference"><strong>VAD alternatives</strong><a href="https://github.com/TEN-framework/ten-vad" target="_blank" rel="noreferrer">TEN-vad</a>, <a href="https://github.com/snakers4/silero-vad" target="_blank" rel="noreferrer">Silero VAD</a>, and <a href="https://github.com/livekit/agents/tree/main/livekit-plugins/livekit-plugins-turn-detector" target="_blank" rel="noreferrer">livekit-turn-detector</a> are swappable turn-detection inputs.</div><div class="turn-reference"><strong>Latency budget</strong>End-of-turn quality matters because waiting too long feels slow, but replying too early causes interruptions.</div></div></div></div></section>
    <section class="section-band slide" data-slide="4" id="map">
      <span class="kicker">System map</span>
      <h2>Open Source Self-Hosted Agentic Call Center Architecture.</h2>
      <p class="subhead">Pipecat coordinates the realtime media and LLM loop. The Agentic Call Center app authorizes tools and telephony actions; FreeSWITCH keeps SIP and RTP deterministic.</p>
      <svg class="arch" viewBox="0 0 1120 420" role="img" aria-label="Open source self-hosted agentic call center architecture separating realtime media and inference from signaling, policy, tools, and evidence">
        <defs><marker id="arrow-media" viewBox="0 0 8 8" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8 z" fill="#2457a6"/></marker><marker id="arrow-control" viewBox="0 0 8 8" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8 z" fill="#9a5b04"/></marker></defs>
        <rect class="arch-boundary" x="340" y="34" width="750" height="220" rx="14"/>
        <text class="arch-boundary-label" x="365" y="59">Pipecat-coordinated runtime</text>
        <path class="line line--media line--bidirectional" d="M130 110 H165"/>
        <path class="line line--control line--bidirectional" d="M130 145 H165"/>
        <path class="line line--media line--bidirectional" d="M305 110 H365"/>
        <path class="line line--control line--bidirectional" d="M305 145 H365"/>
        <path class="line line--media line--bidirectional" d="M495 126 H535"/>
        <path class="line line--media line--forward" d="M655 126 H695"/>
        <path class="line line--media line--forward" d="M845 126 H885"/>
        <path class="line line--media line--forward" d="M960 168 C960 222 478 222 430 174"/>
        <path class="line line--control line--bidirectional" d="M770 174 V190"/>
        <path class="line line--control line--bidirectional" d="M235 172 C235 252 500 260 570 300"/>
        <path class="line line--control line--bidirectional" d="M720 174 C676 218 650 262 630 300"/>
        <path class="line line--control line--bidirectional" d="M490 341 H530"/>
        <path class="line line--control line--forward" d="M770 341 H810"/>
        <path class="line line--control line--forward" d="M940 341 H980"/>
        <line class="line line--media" x1="24" y1="24" x2="56" y2="24"/><text class="arch-legend" x="64" y="28">realtime media / transcript</text>
        <line class="line line--control" x1="234" y1="24" x2="266" y2="24"/><text class="arch-legend" x="274" y="28">signaling / control / evidence</text>
        <rect class="nodeAccent" x="20" y="92" width="110" height="70" rx="8"/>
        <text class="label" x="75" y="122" text-anchor="middle">Caller</text><text class="small" x="75" y="144" text-anchor="middle">SIP + RTP</text>
        <rect class="node" x="165" y="82" width="140" height="90" rx="8"/>
        <text class="label" x="235" y="112" text-anchor="middle">FreeSWITCH</text><text class="small" x="235" y="134" text-anchor="middle">dialog + codec</text><text class="small" x="235" y="153" text-anchor="middle">media clock</text>
        <rect class="nodeAccent" x="365" y="86" width="130" height="88" rx="8"/>
        <text class="label" x="430" y="114" text-anchor="middle">Media pipeline</text><text class="small" x="430" y="136" text-anchor="middle">transport + turns</text><text class="small" x="430" y="155" text-anchor="middle">decoded PCM</text>
        <rect class="nodeWarn" x="535" y="92" width="120" height="76" rx="8"/>
        <text class="label" x="595" y="122" text-anchor="middle">rtc-asr</text><text class="small" x="595" y="144" text-anchor="middle">streaming STT</text>
        <rect class="nodeAccent" x="695" y="78" width="150" height="96" rx="8"/>
        <text class="label" x="770" y="107" text-anchor="middle">Flows / FlowManager</text><text class="small" x="770" y="130" text-anchor="middle">node graph</text><text class="small" x="770" y="149" text-anchor="middle">context + functions</text>
        <rect class="nodeWarn" x="695" y="190" width="150" height="50" rx="8"/>
        <text class="label" x="770" y="211" text-anchor="middle">LLM service</text><text class="small" x="770" y="230" text-anchor="middle">pluggable · reason + propose</text>
        <rect class="nodeWarn" x="885" y="92" width="150" height="76" rx="8"/>
        <text class="label" x="960" y="122" text-anchor="middle">TTS model</text><text class="small" x="960" y="144" text-anchor="middle">streaming audio</text>
        <rect class="node" x="340" y="300" width="150" height="82" rx="8"/>
        <text class="label" x="415" y="333" text-anchor="middle">Operator</text><text class="small" x="415" y="356" text-anchor="middle">approve / handoff</text>
        <rect class="nodeAccent" x="530" y="300" width="240" height="82" rx="8"/>
        <text class="label" x="650" y="328" text-anchor="middle">Agentic Call Center App</text><text class="small" x="650" y="350" text-anchor="middle">business state + policy + tools</text><text class="small" x="650" y="369" text-anchor="middle">telephony actions</text>
        <rect class="nodeAccent" x="810" y="300" width="130" height="82" rx="8"/>
        <text class="label" x="875" y="333" text-anchor="middle">Proof bundle</text><text class="small" x="875" y="356" text-anchor="middle">events + latency</text>
        <rect class="nodeAccent" x="980" y="300" width="115" height="82" rx="8"/>
        <text class="label" x="1037" y="333" text-anchor="middle">ASSERT</text><text class="small" x="1037" y="356" text-anchor="middle">evaluation</text>
      </svg>
      <div class="architecture-note"><strong>Failure boundary:</strong> ASR, LLM, application, or TTS can fail while FreeSWITCH keeps the call alive for prerecorded playback, transfer, or a controlled BYE.</div>
    </section>
    <section class="section-band slide" data-slide="5" id="integration">
      <span class="kicker">Voice AI integration</span>
      <h2>Two realtime ingress paths. One streaming Pipecat runtime.</h2>
      <p class="subhead">Browser and telephony audio converge on direct WebRTC peers, then share streaming STT, structured flow control, bounded actions, and incremental TTS.</p>
      <div class="transport-integration">
        <div class="transport-paths">
          <article class="transport-path transport-path--webrtc">
            <div class="transport-node"><small>Browser or app</small><strong>WebRTC P2P</strong><code>Opus · DTLS-SRTP</code></div>
            <div class="transport-arrow" aria-label="bidirectional">↔</div>
            <div class="transport-node"><small>Pipecat media peer</small><strong>SmallWebRTC / aiortc</strong><code>signaling: SDP offer/answer · HTTP<br>media: ICE · DTLS-SRTP · RTP/RTCP</code></div>
          </article>
          <article class="transport-path transport-path--sip">
            <div class="transport-node"><small>Phone network</small><strong>SIP/RTP ↔ FreeSWITCH</strong><code>dialog · codec · transfer · BYE</code></div>
            <div class="transport-arrow" aria-label="bidirectional">↔</div>
            <div class="transport-node"><small>FreeSWITCH ↔ Pipecat</small><strong>SmallWebRTC / aiortc</strong><code>signaling: Verto JSON-RPC · WebSocket<br>media: ICE · DTLS-SRTP · RTP/RTCP</code></div>
          </article>
        </div>
        <div class="integration-truths">
          <div class="integration-truth"><strong>Transcribe while speech arrives</strong></div>
          <div class="integration-truth"><strong>Keep authority outside the model</strong></div>
          <div class="integration-truth"><strong>Commit after delivery</strong></div>
        </div>
      </div>
    </section>
    <section class="section-band slide" data-slide="5" id="demo"><span class="kicker">Policy-control example</span><h2>A cancellation request, resolved on the call.</h2><p class="subhead">Validate the account → check the price → confirm cancellation → preserve an undo window.</p><div class="demo-shell"><div class="demo-commandbar"><button class="primary" id="run-demo" type="button">Run cancellation scenario</button><div class="demo-drill-picker"><label for="demo-drill-select">Try another control</label><select id="demo-drill-select"><optgroup label="Fail closed"><option value="tool_timeout">Tool timeout</option><option value="runtime_failure">Runtime failure</option><option value="rtc_asr_unavailable">ASR unavailable</option><option value="tts_unavailable">TTS unavailable</option></optgroup><optgroup label="Call control"><option value="transfer">Transfer</option><option value="takeover">Takeover</option><option value="end_call">End call</option></optgroup></select><button id="run-demo-drill" type="button">Run selected drill</button></div></div><div class="demo-control-story" id="demo-control-story" aria-label="Cancellation request control sequence"><div class="demo-control-step" data-step="1"><small>Validate</small><strong>Account ····4821</strong><span>Match the requested plan.</span></div><div class="demo-control-step" data-step="2"><small>Review</small><strong>Quick price check</strong><span>One optional save attempt.</span></div><div class="demo-control-step" data-step="3"><small>Confirm</small><strong>No lower price</strong><span>The caller chooses cancellation.</span></div><div class="demo-control-step" data-step="4"><small>Schedule</small><strong>Ends August 31</strong><span>Reversible until the end date.</span></div></div><div class="screen" id="demo-screen"><div class="demo-result-head"><small>Ready</small><strong>Simple for the caller. Controlled underneath.</strong><p>Run the scenario to see account validation, a same-call price review, and a reversible cancellation.</p></div></div><details class="demo-evidence" id="demo-evidence"><summary><span><strong>Conversation + audit evidence</strong><small id="demo-evidence-count">Available after the run</small></span><b id="demo-evidence-toggle">Expand</b></summary><div class="demo-evidence-grid"><div><h3>Customer conversation</h3><div class="demo-transcript-detail" id="demo-transcript-detail"></div></div><div><h3>Authoritative events</h3><div class="timeline" id="timeline"></div></div></div></details></div></section>
    <section class="section-band slide" data-slide="6" id="asr-architecture">
      <span class="kicker">Live ASR · app flow</span><h2>Audio in. Transcript events out.</h2>
      <div class="asr-app-flow" aria-label="Pipecat, FreeSWITCH, or another WebRTC media server sends PCM audio over a persistent Local STT v1 WebSocket to rtc-asr. rtc-asr normalizes PCM16 to an in-memory float32 array and dispatches it to a preloaded model on a worker thread.">
        <div class="asr-app-node"><small>Media edge</small><strong>Pipecat</strong><span>FreeSWITCH · any WebRTC media server</span><code>PCM → WebSocket</code></div>
        <div class="asr-app-link"><span>80–160 ms PCM16</span><b>→</b><em>partial · final · cancel</em><b>←</b></div>
        <div class="asr-app-node asr-app-node--service"><small>Local STT v1</small><strong>rtc-asr</strong><span>persistent WebSocket</span><div class="asr-service-contract"><span>normalize</span><span>route</span><span>measure</span></div></div>
        <div class="asr-app-link asr-app-link--runtime"><span>in-process · worker thread</span><b>→</b><em>PCM16 → normalized float32 array</em><code>model.transcribe([audio])</code></div>
        <div class="asr-app-node"><small>Active Python adapter</small><strong>Parakeet / NeMo</strong><span>Whisper · Qwen · Voxtral are swappable</span><code>preloaded · same process</code></div>
      </div>
      <div class="asr-benefits" aria-label="rtc-asr benefits"><div class="asr-benefit"><b>1</b><span><strong>Local</strong><small>no provider hop</small></span></div><div class="asr-benefit" style="--benefit-color:#2457a6"><b>2</b><span><strong>Swappable</strong><small>one contract</small></span></div><div class="asr-benefit" style="--benefit-color:#7c3aed"><b>3</b><span><strong>Realtime</strong><small>partial + final</small></span></div><div class="asr-benefit" style="--benefit-color:#9a5b04"><b>4</b><span><strong>Measurable</strong><small>latency + RTF</small></span></div></div>
    </section>
    <section class="section-band slide" data-slide="7" id="asr"><span class="kicker">Live ASR lab</span><div class="asr-heading"><h2>rtc-asr is measurable and swappable.</h2><div class="actions"><a class="mode-link" href="${payload.asrPanel.pipecatDemoUrl}" target="_blank" rel="noreferrer">Source ↗</a><a class="mode-link" href="${payload.asrPanel.benchmarkUrl}" target="_blank" rel="noreferrer">Benchmarks ↗</a></div></div><p class="subhead">Watch partials evolve or record a six-second batch.</p><p class="asr-rtf-note muted">RTF = processing time ÷ audio duration. Lower is better; &lt;1× is faster than realtime.</p><div class="two"><div><div class="asr-live-lab"><div class="asr-live-head"><strong>Mic → Local STT → transcript</strong><span class="badge fixture" id="asr-live-badge">checking sidecar</span></div><div class="asr-live-controls"><label><span class="muted">Model</span><select id="asr-model-select" aria-label="rtc-asr model target" disabled><option>Loading models…</option></select></label><button class="primary" id="asr-realtime" type="button" disabled>Start realtime</button><button id="asr-record" type="button" disabled>Batch 6 seconds</button></div><div class="asr-live-wave" id="asr-live-wave" aria-hidden="true"><span style="--wave-i:0;height:12px"></span><span style="--wave-i:1;height:28px"></span><span style="--wave-i:2;height:18px"></span><span style="--wave-i:3;height:42px"></span><span style="--wave-i:4;height:22px"></span><span style="--wave-i:5;height:34px"></span><span style="--wave-i:6;height:16px"></span><span style="--wave-i:7;height:38px"></span><span style="--wave-i:8;height:24px"></span><span style="--wave-i:9;height:46px"></span><span style="--wave-i:10;height:20px"></span><span style="--wave-i:11;height:32px"></span><span style="--wave-i:12;height:14px"></span><span style="--wave-i:13;height:36px"></span><span style="--wave-i:14;height:26px"></span><span style="--wave-i:15;height:40px"></span></div><span class="asr-live-status" id="asr-live-status" aria-live="polite">Waiting for rtc-asr.</span><pre class="asr-live-result" id="asr-live-result">Partial and final transcripts appear here.</pre></div><div class="asr-events" id="asr-events"></div></div><div class="grid" id="asr-benchmarks"></div></div><aside class="asr-noise-guidance"><div><strong>Noise changes more than WER.</strong><span>Test recognition, false interruption, backchannels, and end-of-turn together.</span></div><ul>${payload.asrPanel.noiseGuidance.findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join("")}</ul><div class="asr-noise-foot"><span>${escapeHtml(payload.asrPanel.noiseGuidance.caveat)}</span><a href="${payload.asrPanel.noiseGuidance.sourceUrl}" target="_blank" rel="noreferrer">${escapeHtml(payload.asrPanel.noiseGuidance.sourceLabel)} ↗</a></div></aside></section>
    <section class="section-band slide" data-slide="7" id="tts"><span class="kicker">Live TTS latency lab</span><h2>Measure playback start—not request completion.</h2><p class="subhead">Synthesize short text segments, play the first immediately, and queue the rest while speech is already audible.</p><div class="tts-layout"><div class="tts-lab"><div class="tts-lab-head"><div class="tts-provider-choice"><label for="tts-provider">Local engine</label><select id="tts-provider">${payload.ttsPanel.providers.map((provider) => `<option value="${escapeHtml(provider.id)}"${provider.id === payload.ttsPanel.defaultProvider ? " selected" : ""}>${escapeHtml(provider.label)}</option>`).join("")}</select><span id="tts-provider-meta">${escapeHtml(payload.ttsPanel.model)} · ${escapeHtml(payload.ttsPanel.voice)}</span></div><span class="badge ${payload.ttsPanel.status === "live_ready" ? "ready" : "fixture"}" id="tts-badge">${payload.ttsPanel.status === "live_ready" ? "sidecar ready" : "local sidecar required"}</span></div><label class="tts-text-label" for="tts-text"><span>Text to synthesize</span><small>natural-boundary chunks</small></label><textarea id="tts-text" rows="4">Here is the key. AI may be probabilistic, but the system around it does not have to be.</textarea><div class="tts-text-progress" id="tts-text-progress" aria-label="Incremental synthesis chunks" aria-live="polite"></div><div class="actions"><button class="primary" id="tts-run" type="button">Run Kokoro</button><span class="muted" id="tts-status">${escapeHtml(payload.ttsPanel.metricDefinition)}</span></div><div class="tts-metrics"><div class="plain metric"><span class="kicker">First audio</span><strong id="tts-ttfb">—</strong></div><div class="plain metric"><span class="kicker">Playback</span><strong id="tts-playback">—</strong></div><div class="plain metric"><span class="kicker">Total stream</span><strong id="tts-total">—</strong></div><div class="plain metric"><span class="kicker">Chunks</span><strong id="tts-bytes">—</strong></div></div></div><div class="tts-candidates"><div class="tts-candidates-head"><strong>Main OSS recommendations</strong><span>Published conditions—not a universal ranking</span></div>${payload.ttsPanel.candidates.map((candidate) => `<article class="tts-candidate"><span><strong>${escapeHtml(candidate.name)}</strong><b>${escapeHtml(candidate.latency)}</b></span><small>${escapeHtml(candidate.condition)}</small><a href="${candidate.sourceUrl}" target="_blank" rel="noreferrer">${escapeHtml(candidate.sourceLabel)} ↗</a></article>`).join("")}<p>${escapeHtml(payload.ttsPanel.comparisonCaveat)}</p></div></div></section>
    <section class="section-band slide" data-slide="8" id="agent">
      <span class="kicker">Agent control stack</span>
      <div class="agent-state-head">
        <h2>Conversation state guides. Application state authorizes.</h2>
        <div class="agent-state-legend" aria-label="Authority legend"><span><i style="--legend:#22d3ee"></i>Conversation · guidance</span><span><i style="--legend:#a78bfa"></i>Business · authority</span><span><i style="--legend:#fbbf24"></i>Approval · authority</span></div>
      </div>
      <p class="subhead">FlowManager controls the model’s current task—not business truth. Click any <code>&lt;/&gt;</code> block to compare a <a href="https://docs.pipecat.ai/pipecat-flows/guides/nodes-and-messages" target="_blank" rel="noreferrer">NodeConfig ↗</a> with authoritative application handlers.</p>
      <div class="agent-authority-map" aria-label="Pipecat conversation flow sends untrusted proposals to the authoritative application flow. Only business and approval state can enable execution.">
        <div class="agent-flow-row agent-flow-row--conversation">
          <div class="agent-lane-label" style="--lane-color:#22d3ee"><small>Pipecat Flows + LLM</small><strong>Conversation flow graph</strong></div>
          <button class="agent-flow-node agent-flow-node--conversation" type="button" data-agent-code="agent-code-identity" data-agent-code-title="Identity collection" aria-controls="agent-code-modal" aria-expanded="false"><small>1 · identity gate</small><strong>Collect identity</strong><code>submit_identity</code></button>
          <b class="agent-flow-arrow" aria-hidden="true">→</b>
          <button class="agent-flow-node agent-flow-node--conversation" type="button" data-agent-code="agent-code-request" data-agent-code-title="Request classification" aria-controls="agent-code-modal" aria-expanded="false"><small>2 · request intent</small><strong>Understand request</strong><code>route_request</code></button>
          <b class="agent-flow-arrow" aria-hidden="true">→</b>
          <div class="agent-flow-node agent-flow-node--conversation"><small>3 · operating envelope</small><strong>Confirm operation</strong><code>confirm_operation</code></div>
          <b class="agent-flow-arrow" aria-hidden="true">→</b>
          <div class="agent-flow-node agent-flow-node--conversation"><small>4 · next response</small><strong>Explain or hand off</strong><code>result · transfer</code></div>
        </div>
        <div class="agent-proposal-row" aria-label="Proposal and result boundary">
          <span></span><span class="agent-proposal">identifiers + evidence</span><span></span><span class="agent-proposal">requested intent</span><span></span><span class="agent-proposal">customer confirms</span><span></span><span class="agent-proposal agent-proposal--result">recorded result</span>
        </div>
        <div class="agent-flow-row agent-flow-row--application">
          <div class="agent-lane-label" style="--lane-color:#a78bfa"><small>Application / DB</small><strong>Enforcement</strong></div>
          <button class="agent-flow-node agent-flow-node--business" type="button" data-agent-code="agent-code-verify" data-agent-code-title="Identity verification handler" data-agent-code-kicker="Application / DB · authoritative handler" aria-controls="agent-code-modal" aria-expanded="false"><small>Verify</small><strong>Validate + lookup</strong><code>customer_id · identity_verified</code></button>
          <b class="agent-flow-arrow" aria-hidden="true">→</b>
          <div class="agent-flow-node agent-flow-node--business"><small>Prepare</small><strong>Load current state</strong><code>pending_operation · version</code></div>
          <b class="agent-flow-arrow" aria-hidden="true">→</b>
          <button class="agent-flow-node agent-flow-node--approval" type="button" data-agent-code="agent-code-approval" data-agent-code-title="Approval binding" data-agent-code-kicker="Application / DB · authoritative handler" aria-controls="agent-code-modal" aria-expanded="false"><small>Authorize</small><strong>Policy + approval</strong><code>requested → approved | denied | expired</code></button>
          <b class="agent-flow-arrow" aria-hidden="true">→</b>
          <button class="agent-flow-node agent-flow-node--execute" type="button" data-agent-code="agent-code-execute" data-agent-code-title="Idempotent execution" data-agent-code-kicker="Application / DB · authoritative handler" aria-controls="agent-code-modal" aria-expanded="false"><small>Execute</small><strong>Recheck + execute once</strong><code>idempotency · recorded event</code></button>
        </div>
        <div class="agent-approval-outcomes"><strong>Approval outcomes</strong><span>policy auto-approval → execute</span><span>operator approval → execute</span><span>denied · expired · unavailable → explain or warm handoff</span></div>
      </div>
      <div class="agent-state-principle"><strong>A node defines what the model may discuss and propose.</strong><span>It does not prove identity or authorize execution.</span></div>
      <div class="agent-code-modal" id="agent-code-modal" role="dialog" aria-modal="true" aria-labelledby="agent-code-title" aria-hidden="true" hidden>
        <div class="agent-code-panel">
          <div class="agent-code-head"><div><small id="agent-code-kicker">Pipecat Flows · illustrative node</small><strong id="agent-code-title">NodeConfig</strong></div><button id="agent-code-close" type="button">Close</button></div>
          <pre><code id="agent-code-content"></code></pre>
        </div>
      </div>
      <template id="agent-code-identity">from pipecat.flows import ConsolidatedFunctionResult, FlowManager, NodeConfig

def collect_identity_node() -> NodeConfig:
    return NodeConfig(
        name="collect_identity",
        role_message=(
            "You are a concise voice support agent. "
            "Never reveal account data before verification."
        ),
        task_messages=[{
            "role": "developer",
            "content": (
                "Collect full name and billing ZIP as lookup inputs—not proof. "
                "Confirm both, then call submit_identity; if declined, "
                "offer a human handoff."
            ),
        }],
        functions=[submit_identity, transfer_to_human],
    )</template>
      <template id="agent-code-request">def understand_request_node() -> NodeConfig:
    return NodeConfig(
        name="understand_request",
        task_messages=[{
            "role": "developer",
            "content": (
                "Ask how you can help. Classify as account_information, "
                "change_plan, cancellation, or other; then call route_request."
            ),
        }],
        functions=[route_request, transfer_to_human],
    )</template>
      <template id="agent-code-verify">async def submit_identity(
    flow_manager: FlowManager,
    full_name: str,
    zip_code: str,
) -> ConsolidatedFunctionResult:
    """Verify caller-provided lookup inputs.

    Args:
        full_name: Caller name.
        zip_code: Billing ZIP.
    """
    call_id = flow_manager.state["call_id"]  # Seeded before initialize().
    candidate = await customers.lookup(
        full_name=normalize_name(full_name),
        zip_code=normalize_zip(zip_code),
    )
    verification = await identity_service.verify(
        call_id=call_id,
        candidate=candidate,
    )

    if not verification.verified:
        return {"status": "not_verified"}, identity_retry_or_handoff()

    state = await call_state.reload(call_id)
    await call_state.bind_verified_customer(
        call_id=call_id,
        customer_id=verification.customer_id,
        expected_version=state.version,
    )
    return {"status": "verified"}, understand_request_node()</template>
      <template id="agent-code-approval">async def authorize_operation(call_id, operation_id):
    state = await call_state.reload(call_id)
    operation = await operations.get_confirmed(call_id, operation_id)
    return await approvals.resolve(
        customer_id=state.customer_id,
        operation_id=operation.id,
        operation_digest=operation.digest,
        state_version=state.version,
    )
</template>
      <template id="agent-code-execute">async def execute_approved_operation(call_id, approval_id):
    async with db.transaction():
        state, approval = await reload_authoritative_inputs(call_id, approval_id)
        operation = await operations.get_confirmed(call_id, approval.operation_id)
        approval.require_valid_for(
            customer_id=state.customer_id,
            operation=operation,
            state_version=state.version,
        )  # Checks binding, status, expiry, and prior use.
        result = await operations.execute_once(
            operation,
            idempotency_key=approval.id,
        )
        await events.record_in_transaction("operation_completed", result)
        return result</template>
    </section>
    <section class="section-band slide" data-slide="11" id="ecosystem"><span class="kicker">WebRTC.ventures open source</span><h2>Three projects. One reliability loop.</h2><p class="subhead">Start the demo from either side: click ConversationAgentEvals for scenarios, or Agentic Contact Center for the live operator view.</p><div class="ecosystem-diagram"><div class="ecosystem-lane"><a class="ecosystem-card ecosystem-card--primary" href="${payload.caePanel.webBaseUrl}${payload.caePanel.scenariosPath}" target="_blank" rel="noreferrer" aria-label="Start the demo in ConversationAgentEvals scenarios"><small>Demo entry · scenarios</small><strong>ConversationAgentEvals</strong><span>Runs scenarios, normalizes proof, and compares regressions.</span></a><div class="ecosystem-arrow-down"><span>canonical evaluation</span><b>↓</b></div><a class="ecosystem-card" href="${payload.sourceRepos.assert}" target="_blank" rel="noreferrer" aria-label="Open the ASSERT repository"><small>Upstream engine</small><strong>ASSERT</strong><span>Generates and judges requirement-driven evaluations.</span></a></div><div class="ecosystem-handoff" aria-label="Bidirectional test and evidence handoff"><span>test scenarios →</span><span>← proof bundle</span></div><div class="ecosystem-lane"><a class="ecosystem-card ecosystem-card--target" href="http://127.0.0.1:8026/operator/console" target="_blank" rel="noreferrer" aria-label="Start the demo in the Agentic Contact Center operator view"><small>Demo entry · operator</small><strong>Agentic Contact Center</strong><span>Demonstrates the realtime voice-agent path and deterministic failure controls.</span></a><div class="ecosystem-arrow-down"><span>optional local STT</span><b>↓</b></div><a class="ecosystem-card" href="http://127.0.0.1:8090/rtc-asr" target="_blank" rel="noreferrer" aria-label="Open the local rtc-asr browser app"><small>Speech sidecar</small><strong>rtc-asr</strong><span>Streams transcripts and publishes reproducible ASR benchmarks.</span></a></div></div><div class="ecosystem-foot">Open components connected by explicit adapters and reviewable evidence.</div></section>
    <section class="section-band slide" data-slide="12" id="slo"><span class="kicker">Reliability targets</span><h2>Reliable audio is necessary. Reliable conversation is the outcome.</h2><p class="subhead">Traditional SLOs tell us whether the service answered. Conversational SLOs tell us whether the agent understood, acted correctly, and recovered safely.</p><div class="slo-layout"><article class="slo-column"><small>Traditional service SLO</small><strong>Did the system answer reliably?</strong><ul><li>Call connected</li><li>Two-way audio stayed available</li><li>Latency met its target</li><li>Infrastructure stayed healthy</li></ul></article><div class="slo-bridge"><b aria-hidden="true">→</b><span>same call · wider outcome</span></div><article class="slo-column slo-column--conversation"><small>Conversational SLO</small><strong>Did the agent do the right thing?</strong><ul><li>Understood the caller</li><li>Responded at the right time</li><li>Changed the correct business state</li><li>Clarified, recovered, or handed off safely</li></ul></article></div><div class="slo-measures"><div class="slo-measure"><strong>Response onset</strong><span>First audible response within target</span></div><div class="slo-measure"><strong>Task outcome</strong><span>Correct state or correct handoff</span></div><div class="slo-measure"><strong>Floor control</strong><span>Fast barge-in; few false interruptions</span></div><div class="slo-measure"><strong>Policy integrity</strong><span>Zero unauthorized consequential actions</span></div></div><div class="slo-foot"><span><strong>Evals gate a release.</strong> Conversational SLOs show whether it stays good in production.</span><span class="slo-sources"><a href="https://sre.google/workbook/implementing-slos/" target="_blank" rel="noreferrer">Google SRE Workbook ↗</a><a href="https://www.itu.int/rec/T-REC-P.851-200311-I/en" target="_blank" rel="noreferrer">ITU-T P.851 ↗</a></span></div></section>
    <section class="section-band slide" data-slide="10" id="security"><span class="kicker">Security boundary</span><h2>Minimize sensitive data crossing the LLM boundary.</h2><p class="subhead">Screen locally, minimize context, authorize tools outside the model, and govern any raw data that is explicitly required.</p><div class="security-layout"><div class="security-boundary"><div class="security-flow"><div class="security-node"><small>Controlled media</small><strong>Caller audio</strong></div><div class="security-node"><small>Inside boundary</small><strong>STT transcript</strong></div><div class="security-node security-node--guard"><small>Local enforcement</small><strong>PII / PHI / PCI guardrail</strong></div><div class="security-node security-node--provider"><small>Third party</small><strong>Minimum LLM context</strong></div><div class="security-node security-node--guard"><small>Before TTS</small><strong>Response policy gate</strong></div><div class="security-node"><small>Realtime media</small><strong>TTS / caller</strong></div></div><div class="security-gate"><div class="security-pane"><strong>Final transcript inside our boundary</strong><pre id="security-input">I need help understanding my renewal options.</pre></div><div class="security-pane"><strong>What crosses the LLM boundary</strong><span class="badge ready" id="security-action">allow</span><pre id="security-output">I need help understanding my renewal options.</pre><span class="muted" id="security-note">No sensitive data detected; the minimum required text crosses the provider boundary.</span></div></div></div><aside class="security-result"><strong>Try the policy boundary</strong><div class="actions" id="security-actions"></div><ul class="security-controls" id="security-controls"></ul><div class="security-links"><a class="mode-link" href="${payload.securityPanel.articleUrl}" target="_blank" rel="noreferrer">Architecture article ↗</a><a class="mode-link" href="${payload.securityPanel.referenceRepoUrl}" target="_blank" rel="noreferrer">Guardrails demo ↗</a></div><span class="muted">Sensitive values that must be collected belong in an authorized application flow. The LLM receives only state such as <code>payment_method_collected</code>.</span></aside></div></section>
    <section class="section-band slide finale" data-slide="13" id="finale"><span class="kicker">Open source, open invitation</span><h2>Every enterprise workflow can now begin with a conversation.</h2><div class="finale-callback" aria-label="The evolution from rigid systems to conversational interfaces"><span>2017 · People adapted to systems.</span><b aria-hidden="true">→</b><strong>Now · Systems can adapt to people.</strong></div><div class="finale-invitation"><strong>Run it. Break it. Make it better.</strong><span>Open source projects to try below:</span></div><div class="finale-layout"><div class="project-links"><a class="project-link" href="${payload.sourceRepos.agenticContactCenter}" target="_blank" rel="noreferrer"><small>Reference target</small><strong>Agentic Contact Center ↗</strong><span>SIP/WebRTC voice-agent architecture, failure controls, and proof.</span></a><a class="project-link" href="${payload.sourceRepos.rtcAsr}" target="_blank" rel="noreferrer"><small>Local speech</small><strong>rtc-asr ↗</strong><span>Streaming STT boundary and reproducible benchmark lab.</span></a><a class="project-link" href="${payload.sourceRepos.conversationAgentEvals}" target="_blank" rel="noreferrer"><small>Evaluation</small><strong>ConversationAgentEvals ↗</strong><span>Scenarios, simulated calls, runs, evidence, and regression reports.</span></a></div><aside class="finale-contact"><div class="finale-contact__details"><a href="${payload.contactPanel.websiteUrl}" target="_blank" rel="noreferrer"><img class="finale-logo" src="${payload.contactPanel.logoUrl}" alt="WebRTC.ventures"></a><strong>${escapeHtml(payload.contactPanel.name)} · ${escapeHtml(payload.contactPanel.role)}</strong><a href="mailto:${escapeHtml(payload.contactPanel.email)}">${escapeHtml(payload.contactPanel.email)}</a><a href="${payload.contactPanel.websiteUrl}" target="_blank" rel="noreferrer">webrtc.ventures ↗</a></div><a class="finale-linkedin" href="${payload.contactPanel.linkedinUrl}" target="_blank" rel="noreferrer" aria-label="Connect with Alberto Gonzalez on LinkedIn"><img src="${escapeHtml(linkedinQrUrl)}" alt="QR code linking to Alberto Gonzalez on LinkedIn"><span>Connect on LinkedIn</span></a></aside></div></section>
    <pre id="proof-json" hidden aria-hidden="true"></pre>
  </main>
  <script>window.__CLUECON__ = ${data};</script>
  <script>
    let data = window.__CLUECON__;
    const slideOrder = ["flow", "voice-evolution", "realtime-problem", "map", "integration", "vad-interruption", "asr-architecture", "asr", "security", "agent", "demo", "tts", "ecosystem", "slo", "finale"];
    const main = document.querySelector("main");
    slideOrder.forEach((id, index) => { const slide = document.getElementById(id); if (slide) { slide.dataset.slide = String(index); main?.appendChild(slide); } });
    const state = { slide: 0, slideCount: slideOrder.length, isPresent: document.body.classList.contains("present"), proof: null, brain: JSON.parse(JSON.stringify(data.brainBlocks)), brainSession: null, asrCapture: null, asrStopping: false, asrModels: [], asrLive: null, ttsStream: null, ttsStreamToken: 0, failureAudio: null, failureAudioUrl: null, vad: null, vadStarting: false, vadStartToken: 0, vadPendingStream: null, vadBotSpeaking: false, vadBotTimer: null, vadTurnTimer: null, vadOutputTimer: null, vadOutputCleanupTimer: null, vadSimulationTimers: [] };
    const VAD_END_OF_TURN_MS = Number(data.turnTiming?.endOfTurnSilenceMs) || 2000;
    const LIVE_TTS_FAST_FETCH_TIMEOUT_MS = 12_000;
    const LIVE_TTS_KOKORO_FETCH_TIMEOUT_MS = 45_000;
    const LIVE_TTS_FAST_READ_TIMEOUT_MS = 10_000;
    const LIVE_TTS_KOKORO_READ_TIMEOUT_MS = 45_000;
    function esc(value) { return String(value).replace(/[&<>\"]/g, c => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"); }
    let agentCodeTrigger = null;
    function closeAgentCode() { const modal = document.getElementById("agent-code-modal"); if (!modal || modal.hidden) return; modal.hidden = true; modal.setAttribute("aria-hidden", "true"); document.querySelectorAll("[data-agent-code]").forEach(button => button.setAttribute("aria-expanded", "false")); if (agentCodeTrigger) agentCodeTrigger.focus(); agentCodeTrigger = null; }
    function openAgentCode(button) { const template = document.getElementById(button.dataset.agentCode); const modal = document.getElementById("agent-code-modal"); if (!template || !modal) return; agentCodeTrigger = button; document.getElementById("agent-code-kicker").textContent = button.dataset.agentCodeKicker || "Pipecat Flows · illustrative node"; document.getElementById("agent-code-title").textContent = button.dataset.agentCodeTitle || "NodeConfig"; document.getElementById("agent-code-content").textContent = template.content.textContent.trim(); document.querySelectorAll("[data-agent-code]").forEach(item => item.setAttribute("aria-expanded", String(item === button))); modal.hidden = false; modal.setAttribute("aria-hidden", "false"); document.getElementById("agent-code-close").focus(); }
    function setupAgentCode() { const modal = document.getElementById("agent-code-modal"); document.querySelectorAll("[data-agent-code]").forEach(button => button.addEventListener("click", () => openAgentCode(button))); document.getElementById("agent-code-close").addEventListener("click", closeAgentCode); modal.addEventListener("click", event => { if (event.target === modal) closeAgentCode(); }); document.addEventListener("keydown", event => { if (event.key === "Escape") closeAgentCode(); }); }
    function renderSecurityScenario(id) { const scenario = data.securityPanel.scenarios.find(item => item.id === id) || data.securityPanel.scenarios[0]; const action = document.getElementById("security-action"); document.getElementById("security-input").textContent = scenario.input; document.getElementById("security-output").textContent = scenario.llmInput || "NOT SENT TO LLM\\nRoute the caller to an authorized application or human workflow."; document.getElementById("security-note").textContent = scenario.note; action.textContent = scenario.action; action.className = "badge " + (scenario.action === "allow" ? "ready" : scenario.action === "redact" ? "fixture" : "blocked"); document.querySelectorAll("[data-security-scenario]").forEach(button => button.classList.toggle("primary", button.dataset.securityScenario === scenario.id)); }
    function renderSecurityPanel() { document.getElementById("security-actions").innerHTML = data.securityPanel.scenarios.map(scenario => '<button type="button" data-security-scenario="' + esc(scenario.id) + '">' + esc(scenario.label) + '</button>').join(""); document.getElementById("security-controls").innerHTML = data.securityPanel.controls.map(control => '<li>' + esc(control) + '</li>').join(""); document.querySelectorAll("[data-security-scenario]").forEach(button => button.addEventListener("click", () => renderSecurityScenario(button.dataset.securityScenario))); renderSecurityScenario("safe"); }
    function stopFailureAudio() { if (state.failureAudio) { state.failureAudio.pause(); state.failureAudio.removeAttribute("src"); state.failureAudio.load(); state.failureAudio = null; } if (state.failureAudioUrl) { URL.revokeObjectURL(state.failureAudioUrl); state.failureAudioUrl = null; } }
    function prerecordedFailureAudio() { const audio = new Audio("/cluecon/system-unavailable.mp3"); state.failureAudio = audio; return { audio, source: "Prerecorded failover prompt" }; }
    function buildTtsSynthesisRequest(provider, text) {
      const request = { provider: provider.id, text, voice: provider.voice };
      if (provider.id !== "pocket" && provider.model) request.model = provider.model;
      return request;
    }
    async function synthesizedAsrFailureAudio() { const provider = selectedTtsProvider(); const response = await fetch(data.ttsPanel.synthesizeRoute, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildTtsSynthesisRequest(provider, "We are sorry. I cannot hear you right now. Please hold while I connect you with a human agent.")) }); if (!response.ok) { const failure = await response.json().catch(() => ({ error: "HTTP " + response.status })); throw new Error(failure.detail || failure.nextStep || failure.error || provider.label + " synthesis failed."); } const contentType = (response.headers.get("content-type") || "audio/mpeg").split(";")[0]; const bytes = await readTtsAudioResponse(response, () => undefined); state.failureAudioUrl = URL.createObjectURL(new Blob([bytes], { type: contentType })); const audio = new Audio(state.failureAudioUrl); state.failureAudio = audio; return { audio, source: provider.label + " · " + provider.model + " live TTS" }; }
    async function playFailureAudio(kind) { stopFailureAudio(); let playback; if (kind === "rtc_asr_unavailable") { try { playback = await synthesizedAsrFailureAudio(); } catch { playback = prerecordedFailureAudio(); playback.source += " · live TTS unavailable"; } } else { playback = prerecordedFailureAudio(); } let autoplayBlocked = false; try { await playback.audio.play(); } catch { autoplayBlocked = true; } return { ...playback, autoplayBlocked }; }
    function attachFailureAudio(playback) { const screen = document.getElementById("demo-screen"); const panel = document.createElement("div"); panel.className = "demo-failure-audio"; const label = document.createElement("span"); label.innerHTML = '<small>Audible caller prompt</small><strong>' + esc(playback.source) + (playback.autoplayBlocked ? " · press play" : " · playing") + '</strong>'; playback.audio.controls = true; playback.audio.preload = "auto"; panel.append(label, playback.audio); screen.appendChild(panel); }
    async function runMediaFailureDrill(kind) { const playbackPromise = playFailureAudio(kind); const drillPromise = runOperatorDrill(kind); const [playback] = await Promise.all([playbackPromise, drillPromise]); attachFailureAudio(playback); }
    function vadLog(type, detail) { const events = document.getElementById("vad-events"); const row = document.createElement("div"); row.className = "vad-event"; const now = new Date(); const stamp = now.toLocaleTimeString([], { minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }); row.innerHTML = '<code>' + esc(stamp) + '</code><span><strong>' + esc(type) + '</strong><br>' + esc(detail) + '</span>'; events.prepend(row); while (events.children.length > 8) events.lastElementChild.remove(); }
    function vadStatus(label, tone) { const badge = document.getElementById("vad-state"); badge.textContent = label; badge.className = "badge " + (tone || "fixture"); }
    function vadNodes(active, speaking, interrupted) { document.querySelectorAll(".pipecat-node").forEach(node => { node.classList.toggle("active", active.includes(node.id)); node.classList.toggle("speaking", speaking === node.id); node.classList.toggle("interrupted", interrupted === node.id); }); }
    function clearVadTurnTimers() { clearTimeout(state.vadTurnTimer); clearTimeout(state.vadOutputTimer); clearTimeout(state.vadOutputCleanupTimer); state.vadTurnTimer = null; state.vadOutputTimer = null; state.vadOutputCleanupTimer = null; }
    function clearVadSimulationTimers() { state.vadSimulationTimers.forEach(timer => clearTimeout(timer)); state.vadSimulationTimers = []; }
    function updateVadThreshold() { const input = document.getElementById("vad-threshold"); const threshold = Number(input.value); document.getElementById("vad-threshold-value").textContent = threshold + " dBFS"; document.getElementById("vad-threshold-line").style.left = Math.max(0, Math.min(100, (threshold + 70) / 60 * 100)) + "%"; return threshold; }
    function stopVadBot(interrupted) { if (!state.vadBotSpeaking) return; state.vadBotSpeaking = false; clearTimeout(state.vadBotTimer); state.vadBotTimer = null; if ("speechSynthesis" in window) window.speechSynthesis.cancel(); document.getElementById("vad-agent").textContent = "Play agent → interrupt"; if (interrupted) { vadLog("InterruptionFrame", "User speech cancels queued text and bot audio immediately."); vadNodes(["vad-node-input", "vad-node-turn"], null, "vad-node-output"); setTimeout(() => { if (!state.vadTurnTimer) vadNodes(state.vad ? ["vad-node-input", "vad-node-turn"] : [], null, null); }, 900); } else { vadLog("TTSStoppedFrame", "Agent output queue completed."); vadNodes(state.vad ? ["vad-node-input"] : [], null, null); } }
    function startVadBot() { if (state.vadBotSpeaking) { stopVadBot(false); return; } if (state.vadTurnTimer) { vadLog("OUTPUT_BLOCKED", "Agent audio cannot start while the 2 s end-of-turn gate is still pending."); vadStatus("turn wait: 2.0 s", "fixture"); return; } state.vadBotSpeaking = true; document.getElementById("vad-agent").textContent = "Stop agent speech"; vadStatus("agent speaking", "ready"); vadNodes(state.vad ? ["vad-node-input"] : [], "vad-node-output", null); vadLog("TTSStartedFrame", "Agent audio is flowing. Speak now to demonstrate barge-in."); const finish = () => stopVadBot(false); if ("speechSynthesis" in window && window.SpeechSynthesisUtterance) { window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance("I can review the available account options with you. First, let me confirm a few details before we continue."); utterance.rate = 0.82; utterance.onend = finish; utterance.onerror = finish; window.speechSynthesis.speak(utterance); state.vadBotTimer = setTimeout(finish, 12000); } else { state.vadBotTimer = setTimeout(finish, 8000); } }
    function vadSpeechStart(now) { const vad = state.vad; if (vad && vad.speaking) return; const wasWaitingForTurnEnd = Boolean(state.vadTurnTimer || state.vadOutputTimer || state.vadOutputCleanupTimer); clearVadTurnTimers(); if (vad) { vad.speaking = true; vad.speechStartedAt = now; vad.aboveSince = null; vad.belowSince = null; } vadStatus("user speaking", "ready"); if (wasWaitingForTurnEnd) vadLog("TURN_WAIT_CANCELLED", "Caller resumed before the 2 s end-of-turn gate; audio output remains blocked."); vadLog("VADUserStartedSpeakingFrame", "Acoustic speech onset confirmed after 80 ms."); vadLog("UserStartedSpeakingFrame", "User turn start strategy opens the turn and enables interruption."); if (state.vadBotSpeaking) stopVadBot(true); else vadNodes(["vad-node-input", "vad-node-turn"], null, null); }
    function vadSpeechStop(now) { const vad = state.vad; if (vad && !vad.speaking && !state.vadTurnTimer) return; const duration = vad && vad.speechStartedAt ? Math.max(0, Math.round(now - vad.speechStartedAt)) : 780; clearVadTurnTimers(); if (vad) { vad.speaking = false; vad.aboveSince = null; vad.belowSince = null; } vadStatus("turn wait: 2.0 s", "fixture"); vadLog("VADUserStoppedSpeakingFrame", "Acoustic silence held for 350 ms; segment was " + duration + " ms."); vadLog("EndOfTurnCandidate", "LLM, policy, and tools can process now; only audio output waits for 2.0 s of post-speech silence."); vadNodes(state.vad ? ["vad-node-input", "vad-node-turn", "vad-node-stt", "vad-node-agent"] : ["vad-node-turn", "vad-node-stt", "vad-node-agent"], null, null); state.vadTurnTimer = setTimeout(() => { state.vadTurnTimer = null; vadLog("UserStoppedSpeakingFrame", "2.0 s silence gate elapsed; user turn is now closed."); vadLog("EndOfTurnDetected", "Audio output can now join the highlighted LLM/policy/tool path."); vadStatus("agent response", "ready"); vadLog("TTSStartedFrame", "Audio output starts after the 2 s end-of-turn gate."); vadNodes(state.vad ? ["vad-node-input", "vad-node-agent"] : ["vad-node-agent"], "vad-node-output", null); state.vadOutputCleanupTimer = setTimeout(() => { state.vadOutputCleanupTimer = null; if (!state.vadBotSpeaking && !state.vad?.speaking) { vadNodes(state.vad ? ["vad-node-input"] : [], null, null); vadStatus(state.vad ? "listening" : "mic off", state.vad ? "ready" : "fixture"); } }, 1200); }, VAD_END_OF_TURN_MS); }
    function renderVadLevel(db) { const width = Math.max(0, Math.min(100, (db + 70) / 60 * 100)); document.getElementById("vad-meter-fill").style.width = width + "%"; document.getElementById("vad-level").textContent = Number.isFinite(db) ? db.toFixed(1) + " dBFS" : "−∞ dBFS"; }
    function vadLoop() { const vad = state.vad; if (!vad) return; vad.analyser.getFloatTimeDomainData(vad.samples); let energy = 0; for (const sample of vad.samples) energy += sample * sample; const rms = Math.sqrt(energy / vad.samples.length); const db = 20 * Math.log10(Math.max(rms, 0.0000001)); renderVadLevel(db); const threshold = updateVadThreshold(); const now = performance.now(); if (!vad.speaking) { if (db >= threshold) { vad.aboveSince = vad.aboveSince || now; if (now - vad.aboveSince >= 80) vadSpeechStart(now); } else vad.aboveSince = null; } else if (db < threshold - 4) { vad.belowSince = vad.belowSince || now; if (now - vad.belowSince >= 350) vadSpeechStop(now); } else vad.belowSince = null; vad.raf = requestAnimationFrame(vadLoop); }
    function stopVadMic(silent) { clearVadTurnTimers(); clearVadSimulationTimers(); const button = document.getElementById("vad-mic"); const canceledStart = state.vadStarting; if (canceledStart) { state.vadStartToken += 1; state.vadStarting = false; if (state.vadPendingStream) state.vadPendingStream.getTracks().forEach(track => track.stop()); state.vadPendingStream = null; button.disabled = false; } const vad = state.vad; if (vad) { cancelAnimationFrame(vad.raf); vad.stream.getTracks().forEach(track => track.stop()); vad.source.disconnect(); vad.analyser.disconnect(); vad.context.close().catch(() => undefined); state.vad = null; } if (!vad && !canceledStart) return; button.textContent = "Start microphone"; renderVadLevel(-Infinity); vadNodes([], state.vadBotSpeaking ? "vad-node-output" : null, null); vadStatus(state.vadBotSpeaking ? "agent speaking" : "mic off", state.vadBotSpeaking ? "ready" : "fixture"); if (!silent) vadLog(canceledStart && !vad ? "MIC_START_CANCELLED" : "MIC_STOPPED", canceledStart && !vad ? "Microphone startup canceled and partial resources released." : "Browser audio capture released."); }
    async function toggleVadMic() { if (state.vadStarting) return; if (state.vad) { stopVadMic(false); return; } if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Microphone capture requires HTTPS or localhost."); const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (!AudioContextClass) throw new Error("Web Audio is unavailable in this browser."); const button = document.getElementById("vad-mic"); const startToken = state.vadStartToken + 1; state.vadStartToken = startToken; state.vadStarting = true; button.disabled = true; button.textContent = "Starting microphone…"; vadStatus("requesting mic", "fixture"); let stream = null; let context = null; let source = null; let analyser = null; let installed = false; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false }); if (state.vadStartToken !== startToken) return; state.vadPendingStream = stream; context = new AudioContextClass(); await context.resume(); if (state.vadStartToken !== startToken) return; source = context.createMediaStreamSource(stream); analyser = context.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.35; source.connect(analyser); state.vad = { stream, context, source, analyser, samples: new Float32Array(analyser.fftSize), raf: 0, speaking: false, speechStartedAt: null, aboveSince: null, belowSince: null }; state.vadPendingStream = null; installed = true; button.textContent = "Stop microphone"; vadStatus("listening", "ready"); vadNodes(["vad-node-input"], state.vadBotSpeaking ? "vad-node-output" : null, null); vadLog("MIC_READY", "Web Audio is measuring RMS locally; no audio leaves the browser."); vadLoop(); } finally { if (!installed) { if (source) source.disconnect(); if (analyser) analyser.disconnect(); if (stream) stream.getTracks().forEach(track => track.stop()); if (context) context.close().catch(() => undefined); } if (state.vadStartToken === startToken) { state.vadPendingStream = null; state.vadStarting = false; button.disabled = false; if (!state.vad) button.textContent = "Start microphone"; } } }
    function simulateVadBargeIn() { clearVadSimulationTimers(); if (state.vadBotSpeaking) stopVadBot(false); startVadBot(); state.vadSimulationTimers = [setTimeout(() => vadSpeechStart(performance.now()), 850), setTimeout(() => { state.vadSimulationTimers = []; vadSpeechStop(performance.now()); }, 1750)]; }
    function resetVadDemo() { stopVadMic(true); stopVadBot(false); clearVadTurnTimers(); clearVadSimulationTimers(); clearTimeout(state.vadBotTimer); state.vadBotTimer = null; document.getElementById("vad-events").innerHTML = '<div class="vad-event"><code>READY</code><span>Start the mic or simulate barge-in.</span></div>'; document.getElementById("vad-threshold").value = "-42"; updateVadThreshold(); renderVadLevel(-Infinity); vadNodes([], null, null); vadStatus("mic off", "fixture"); }
    function renderReadiness() { const target = document.getElementById("readiness"); if (!target) return; target.innerHTML = data.readiness.map(item => '<article class="card metric readiness-card"><div class="readiness-card__head"><span class="badge ' + esc(item.status) + '">' + esc(item.status) + '</span><strong>' + esc(item.label) + '</strong></div><span class="muted">' + esc(item.detail) + '</span>' + (item.repoUrl ? '<a class="muted" href="' + esc(item.repoUrl) + '" target="_blank" rel="noreferrer">Source ↗</a>' : '') + '<details class="readiness-more"><summary>Notes</summary><span class="muted">' + esc(item.caveat) + '</span></details></article>').join(""); }
    function renderBrain() { const brainState = document.getElementById("brain-state"); const brain = document.getElementById("brain"); if (!brainState || !brain) return; const session = state.brainSession ? state.brainSession.session : { id: "cluecon-agent-brain-demo", activeTool: "operator.request_approval", policyState: "policy_hold_requires_operator_approval" }; brainState.innerHTML = '<span class="badge ready">session scoped</span><h3>' + esc(session.id) + '</h3><span class="muted">Tool: ' + esc(session.activeTool) + ' / Policy: ' + esc(session.policyState) + '</span>'; brain.innerHTML = state.brain.map((block, index) => '<article class="plain"><h3>' + esc(block.file) + '</h3><textarea data-brain="' + index + '">' + esc(block.summary) + '</textarea><span class="muted">Affects: ' + esc(block.affects.join(", ")) + '</span></article>').join(""); document.querySelectorAll("textarea[data-brain]").forEach(input => input.addEventListener("change", () => { state.brain[Number(input.dataset.brain)].summary = input.value; })); }
    function asrBenchmarkFor(model) { const profiles = data.asrPanel.benchmarkProfiles || {}; if (!model) return profiles["parakeet-mlx|mlx-community/parakeet-tdt_ctc-110m"] || Object.values(profiles)[0] || null; const key = model.backend + "|" + model.model; const normalizedBackend = String(model.backend || "").toLowerCase(); const normalizedModel = String(model.model || "").toLowerCase(); const identity = [model.targetId, normalizedBackend, normalizedModel].map(value => String(value || "").toLowerCase()).join("|"); const compatibleFallback = identity.includes("parakeet") && identity.includes("110m") ? profiles["parakeet-mlx|mlx-community/parakeet-tdt_ctc-110m"] : normalizedBackend.includes("whisper") && normalizedModel === "base.en" ? profiles["faster-whisper|base.en"] : null; return profiles[key] || compatibleFallback || null; }
    function renderAsrBenchmarks(model) { const profile = asrBenchmarkFor(model); const container = document.getElementById("asr-benchmarks"); if (!profile) { container.innerHTML = '<article class="card metric asr-benchmark-source"><strong>No published benchmark mapped to this model.</strong><a href="' + esc(data.asrPanel.benchmarkUrl) + '" target="_blank" rel="noreferrer">Open benchmarks ↗</a></article>'; return; } container.innerHTML = '<article class="card asr-benchmark-source"><span><strong>' + esc(profile.label) + '</strong><span class="muted">Published ' + esc(profile.measuredAt) + ' · model-specific artifact</span></span><a href="' + esc(profile.detailUrl) + '" target="_blank" rel="noreferrer">View artifact ↗</a></article>' + '<article class="card metric asr-metric-card"><span class="muted">First partial</span><strong>' + esc(profile.firstPartial) + '</strong><span class="muted">' + esc(profile.firstPartialDetail) + '</span></article>' + '<article class="card metric asr-metric-card"><span class="muted">Finalization</span><strong>' + esc(profile.finalization) + '</strong><span class="muted">' + esc(profile.finalizationDetail) + '</span></article>' + '<article class="card metric asr-metric-card"><span class="muted">RTF</span><strong>' + esc(profile.rtf) + '</strong><span class="muted">' + esc(profile.rtfDetail) + '</span></article>' + '<article class="card metric asr-metric-card"><a class="muted" href="' + esc(profile.referenceWerUrl) + '" target="_blank" rel="noreferrer">Reference WER ↗</a><strong>' + esc(profile.referenceWer) + '</strong><span class="muted">' + esc(profile.referenceWerDetail) + '</span></article>'; }
    function renderAsrPanel() { const events = data.asrPanel.status === "live_ready" ? data.asrPanel.fixtureEvents.filter(event => event.state !== "error") : data.asrPanel.fixtureEvents; document.getElementById("asr-events").innerHTML = events.map(event => '<span class="asr-event-pill"><strong>' + esc(event.state) + '</strong>' + esc(event.latencyMs === null ? event.text : event.latencyMs + " ms") + '</span>').join(""); renderAsrBenchmarks(selectedAsrModel()); }
    function setAsrLiveStatus(message, stateName) { const status = document.getElementById("asr-live-status"); const badge = document.getElementById("asr-live-badge"); status.textContent = message; badge.textContent = stateName; badge.className = "badge " + (stateName === "ready" || stateName === "transcribed" ? "ready" : stateName === "error" ? "blocked" : "fixture"); }
    async function loadAsrModels() { const select = document.getElementById("asr-model-select"); const batchButton = document.getElementById("asr-record"); const realtimeButton = document.getElementById("asr-realtime"); try { const response = await fetch(data.asrPanel.modelsRoute); const payload = await response.json(); if (!response.ok || !Array.isArray(payload.models)) throw new Error(payload.nextStep || payload.error || "model discovery failed"); state.asrModels = payload.models; select.innerHTML = payload.models.map(model => '<option value="' + esc(model.targetId) + '"' + (model.ready ? '' : ' disabled') + '>' + esc(model.targetLabel + " · " + model.backend + " · " + model.model + (model.ready ? "" : " (unavailable)")) + '</option>').join(""); const active = payload.models.find(model => model.targetId === payload.activeTargetId && model.ready) || payload.models.find(model => model.ready); if (!active) throw new Error("No warmed rtc-asr model target is ready."); select.value = active.targetId; select.disabled = false; batchButton.disabled = Boolean(state.asrLive); realtimeButton.disabled = Boolean(state.asrCapture || state.asrStopping) || !active.websocketUrl; renderAsrBenchmarks(active); setAsrLiveStatus("Ready: " + active.backend + " / " + active.model + " (" + active.responseMs + " ms probe).", "ready"); } catch (error) { state.asrModels = []; select.innerHTML = '<option>rtc-asr unavailable</option>'; select.disabled = true; batchButton.disabled = true; realtimeButton.disabled = true; setAsrLiveStatus("Live transcription unavailable: " + String(error.message || error), "error"); } }
    function encodeAsrWav(chunks, sampleRate) { const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0); const buffer = new ArrayBuffer(44 + sampleCount * 2); const view = new DataView(buffer); function text(offset, value) { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); } text(0, "RIFF"); view.setUint32(4, 36 + sampleCount * 2, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, sampleCount * 2, true); let offset = 44; chunks.forEach(chunk => chunk.forEach(value => { const sample = Math.max(-1, Math.min(1, value)); view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true); offset += 2; })); return new Uint8Array(buffer); }
    function asrBytesToBase64(bytes) { let binary = ""; const batch = 0x8000; for (let offset = 0; offset < bytes.length; offset += batch) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + batch)); return btoa(binary); }
    async function releaseAsrRecordingResources(capture) { if (!capture) return; if (capture.timer) clearTimeout(capture.timer); if (capture.processor) capture.processor.onaudioprocess = null; try { if (capture.source) capture.source.disconnect(); } catch {} try { if (capture.processor) capture.processor.disconnect(); } catch {} try { if (capture.mute) capture.mute.disconnect(); } catch {} if (capture.stream) capture.stream.getTracks().forEach(track => track.stop()); if (capture.context && capture.context.state !== "closed") await capture.context.close().catch(() => undefined); }
    async function startAsrRecording() { if (state.asrLive) throw new Error("Stop realtime transcription before starting a batch recording."); if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Microphone capture requires localhost or HTTPS."); document.getElementById("asr-realtime").disabled = true; const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); const capture = { stream, context: null, source: null, processor: null, mute: null, chunks: [], sampleRate: 0, timer: null }; try { const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (!AudioContextClass) throw new Error("Web Audio is unavailable in this browser."); capture.context = new AudioContextClass(); capture.source = capture.context.createMediaStreamSource(stream); capture.processor = capture.context.createScriptProcessor(4096, 1, 1); capture.mute = capture.context.createGain(); capture.mute.gain.value = 0; capture.sampleRate = capture.context.sampleRate; capture.processor.onaudioprocess = event => capture.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); capture.source.connect(capture.processor); capture.processor.connect(capture.mute); capture.mute.connect(capture.context.destination); capture.timer = setTimeout(() => stopAsrRecording().catch(error => setAsrLiveStatus(String(error.message || error), "error")), 6000); state.asrCapture = capture; document.getElementById("asr-record").textContent = "Stop + transcribe"; document.getElementById("asr-live-wave").classList.add("recording"); document.getElementById("asr-live-result").textContent = "Listening… say a short sentence."; setAsrLiveStatus("Capturing microphone audio locally for up to 6 seconds.", "recording"); } catch (error) { await releaseAsrRecordingResources(capture); throw error; } }
    async function stopAsrRecording() { if (!state.asrCapture || state.asrStopping) return; state.asrStopping = true; const button = document.getElementById("asr-record"); const realtimeButton = document.getElementById("asr-realtime"); button.disabled = true; realtimeButton.disabled = true; const capture = state.asrCapture; state.asrCapture = null; await releaseAsrRecordingResources(capture); button.textContent = "Batch 6 seconds"; document.getElementById("asr-live-wave").classList.remove("recording"); try { if (!capture.chunks.length) throw new Error("No microphone samples were captured."); setAsrLiveStatus("Transcribing with the selected warmed model…", "transcribing"); const response = await fetch(data.asrPanel.transcribeRoute, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetId: document.getElementById("asr-model-select").value, audioData: asrBytesToBase64(encodeAsrWav(capture.chunks, capture.sampleRate)), sampleRate: capture.sampleRate, language: "en" }) }); const payload = await response.json(); if (!response.ok || !payload.ok) throw new Error(payload.error || payload.nextStep || "transcription failed"); const result = payload.transcription || {}; const transcript = typeof result.text === "string" ? result.text : typeof result.transcript === "string" ? result.transcript : result.transcription && typeof result.transcription.text === "string" ? result.transcription.text : JSON.stringify(result); document.getElementById("asr-live-result").textContent = transcript.trim() || "(No speech detected.)"; setAsrLiveStatus("Transcribed by " + payload.targetLabel + " in " + payload.responseMs + " ms.", "transcribed"); } finally { state.asrStopping = false; button.disabled = false; realtimeButton.disabled = !selectedAsrModel()?.websocketUrl; } }
    async function toggleAsrRecording() { const button = document.getElementById("asr-record"); const realtimeButton = document.getElementById("asr-realtime"); button.disabled = true; realtimeButton.disabled = true; try { if (state.asrCapture) await stopAsrRecording(); else await startAsrRecording(); } catch (error) { state.asrStopping = false; document.getElementById("asr-live-wave").classList.remove("recording"); document.getElementById("asr-live-result").textContent = "Live transcription failed: " + String(error.message || error); setAsrLiveStatus(String(error.message || error), "error"); } finally { button.disabled = false; realtimeButton.disabled = Boolean(state.asrCapture || state.asrStopping || state.asrLive) || !selectedAsrModel()?.websocketUrl; } }
    function selectedAsrModel() { const targetId = document.getElementById("asr-model-select").value; return state.asrModels.find(model => model.targetId === targetId); }
    function resampleAsrPcm16(input, inputRate) { const ratio = inputRate / 16000; const sampleCount = Math.max(1, Math.floor(input.length / ratio)); const output = new Int16Array(sampleCount); for (let index = 0; index < sampleCount; index += 1) { const sample = Math.max(-1, Math.min(1, input[Math.min(input.length - 1, Math.floor(index * ratio))])); output[index] = sample < 0 ? sample * 32768 : sample * 32767; } return output; }
    function setAsrRealtimeControls(running, stopping = false) { const select = document.getElementById("asr-model-select"); const batchButton = document.getElementById("asr-record"); const realtimeButton = document.getElementById("asr-realtime"); select.disabled = running; batchButton.disabled = running; realtimeButton.disabled = stopping; realtimeButton.textContent = stopping ? "Finalizing…" : running ? "Stop + finalize" : "Start realtime"; }
    function asrRealtimeTokens(value) { return String(value || "").trim().split(/\\s+/).filter(Boolean); }
    function asrRealtimeTokenKey(value) { return String(value || "").toLocaleLowerCase().replace(/^[^\\p{L}\\p{N}]+|[^\\p{L}\\p{N}]+$/gu, ""); }
    function asrStablePrefixCount(history) { if (history.length < 3) return 0; const revisions = history.slice(-3).map(asrRealtimeTokens); const limit = Math.min(...revisions.map(tokens => tokens.length)); let count = 0; while (count < limit && revisions.every(tokens => asrRealtimeTokenKey(tokens[count]) === asrRealtimeTokenKey(revisions[0][count]))) count += 1; return Math.max(0, count - 2); }
    function updateAsrRealtimeTranscript(live, text, message) { const nextText = String(text || "").trim(); if (message.is_final) { live.finalText = nextText; live.displayText = nextText; live.partialHistory = []; return { text: nextText, stableText: nextText, provisionalText: "", stableCount: asrRealtimeTokens(nextText).length }; } if (nextText) { live.displayText = nextText; live.partialHistory.push(nextText); live.partialHistory = live.partialHistory.slice(-3); } const tokens = asrRealtimeTokens(live.displayText); const stableCount = asrStablePrefixCount(live.partialHistory); return { text: live.displayText, stableText: tokens.slice(0, stableCount).join(" "), provisionalText: tokens.slice(stableCount).join(" "), stableCount }; }
    function renderAsrRealtimeError(error, live = state.asrLive) { const message = String(error && error.message ? error.message : error); const transcript = live && live.displayText ? live.displayText : ""; const result = document.getElementById("asr-live-result"); result.textContent = transcript ? "TRANSCRIPT\\n" + transcript + "\\n\\nERROR\\n" + message : "Realtime transcription failed: " + message; result.classList.remove("partial"); setAsrLiveStatus(message, "error"); }
    function stopAsrRealtimeCapture(live) { if (!live) return Promise.resolve(); if (live.captureClosePromise) return live.captureClosePromise; live.captureClosePromise = (async () => { if (live.processor) live.processor.onaudioprocess = null; try { if (live.source) live.source.disconnect(); } catch {} try { if (live.processor) live.processor.disconnect(); } catch {} try { if (live.mute) live.mute.disconnect(); } catch {} if (live.stream) live.stream.getTracks().forEach(track => track.stop()); if (live.context && live.context.state !== "closed") await live.context.close().catch(() => undefined); })(); return live.captureClosePromise; }
    function closeAsrRealtime(target = state.asrLive) { const live = target; if (!live) return; live.intentionalClose = true; clearTimeout(live.timer); stopAsrRealtimeCapture(live).catch(() => undefined); if (live.socket && live.socket.readyState < WebSocket.CLOSING) live.socket.close(); if (state.asrLive === live) state.asrLive = null; document.getElementById("asr-live-wave").classList.remove("recording"); setAsrRealtimeControls(false); }
    function handleAsrRealtimeMessage(event, live) { if (!live || state.asrLive !== live) return; let message; try { message = JSON.parse(event.data); } catch { return; } if (message.type === "ready") { if (live.readyResolve) live.readyResolve(); setAsrLiveStatus("Ready · full-buffer partials keep earlier words visible; finalization remains authoritative.", "streaming"); return; } if (message.type === "transcript") { const result = document.getElementById("asr-live-result"); const text = String(message.text || "").trim(); const transcript = updateAsrRealtimeTranscript(live, text, message); const capturedSeconds = (Number(message.audio_received_ms || 0) / 1000).toFixed(1); if (message.is_final) { result.textContent = "FINAL · FULL UTTERANCE\\n" + (transcript.text || "(No speech detected.)"); } else { const stable = transcript.stableText ? '<span class="asr-live-stable">' + esc(transcript.stableText) + '</span>' : ""; const provisional = transcript.provisionalText ? '<span class="asr-live-provisional">' + esc(transcript.provisionalText) + '</span>' : "(Listening…)"; result.innerHTML = '<span class="asr-live-label">LIVE · GROWING TRANSCRIPT</span>' + stable + (stable && provisional ? " " : "") + provisional + '<span class="asr-live-note">Bright = stable across 3 revisions · cyan = may change</span>'; } result.classList.toggle("partial", !message.is_final); setAsrLiveStatus(message.is_final ? "Final transcript · " + capturedSeconds + " s captured" : "Listening · " + capturedSeconds + " s captured · " + transcript.stableCount + " stable words", message.is_final ? "transcribed" : "streaming"); if (message.is_final && live.finalResolve) { const resolve = live.finalResolve; live.finalResolve = null; live.finalReject = null; resolve(); } return; } if (message.type === "warning") { setAsrLiveStatus("rtc-asr warning: " + message.message, "streaming"); return; } if (message.type === "error") { const error = new Error(message.message || message.code || "rtc-asr stream failed"); if (live.readyReject) live.readyReject(error); if (live.finalReject) live.finalReject(error); renderAsrRealtimeError(error, live); } }
    async function startAsrRealtime() {
      if (state.asrLive) return;
      if (state.asrCapture || state.asrStopping) throw new Error("Stop the batch recording before starting realtime transcription.");
      const model = selectedAsrModel();
      if (!model || !model.websocketUrl) throw new Error("The selected model does not expose a Local STT websocket.");
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Microphone capture requires localhost or HTTPS.");
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Web Audio is unavailable in this browser.");
      const socket = new WebSocket(model.websocketUrl);
      const live = { socket, model, pending: [], partialHistory: [], stream: null, context: null, source: null, processor: null, mute: null, timer: null, readyResolve: null, readyReject: null, finalResolve: null, finalReject: null, stopPromise: null, captureClosePromise: null, finalText: "", displayText: "", intentionalClose: false };
      state.asrLive = live;
      const ready = new Promise((resolve, reject) => { live.readyResolve = resolve; live.readyReject = reject; });
      socket.addEventListener("open", () => { if (state.asrLive !== live || live.intentionalClose) return; socket.send(JSON.stringify({
        type: "start",
        version: "local-stt.v1",
        audio: { sample_rate: 16000, channels: 1, format: "pcm_s16le", frame_ms: 20, bytes_per_frame: 640 },
        language: "en",
        interim_results: true,
        partial_interval_ms: 200,
        max_buffer_seconds: 12,
        client_stream_id: "cluecon-live-" + Date.now(),
        metadata: { presentation: "cluecon-2026", model_target: model.targetId, partial_strategy: "full_buffer_stability" },
      })); });
      socket.addEventListener("message", event => handleAsrRealtimeMessage(event, live));
      socket.addEventListener("error", () => { if (live.readyReject) live.readyReject(new Error("Could not connect to the rtc-asr websocket.")); });
      socket.addEventListener("close", () => { if (!live.intentionalClose && state.asrLive === live) { renderAsrRealtimeError(new Error("rtc-asr realtime stream closed unexpectedly."), live); closeAsrRealtime(live); } });
      setAsrRealtimeControls(true);
      document.getElementById("asr-live-result").textContent = "Connecting to " + model.backend + " / " + model.model + "…";
      setAsrLiveStatus("Opening Local STT v1 websocket…", "connecting");
      await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("rtc-asr websocket readiness timed out.")), 5000))]);
      live.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      live.context = new AudioContextClass();
      live.source = live.context.createMediaStreamSource(live.stream);
      live.processor = live.context.createScriptProcessor(4096, 1, 1);
      live.mute = live.context.createGain();
      live.mute.gain.value = 0;
      live.processor.onaudioprocess = event => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const pcm = resampleAsrPcm16(event.inputBuffer.getChannelData(0), live.context.sampleRate);
        for (const sample of pcm) live.pending.push(sample);
        while (live.pending.length >= 1600) socket.send(new Int16Array(live.pending.splice(0, 1600)).buffer);
      };
      live.source.connect(live.processor);
      live.processor.connect(live.mute);
      live.mute.connect(live.context.destination);
      live.timer = setTimeout(() => stopAsrRealtime(live).catch(error => { renderAsrRealtimeError(error, live); closeAsrRealtime(live); }), 10000);
      document.getElementById("asr-live-wave").classList.add("recording");
      document.getElementById("asr-live-result").classList.add("partial");
      document.getElementById("asr-live-result").textContent = "LIVE · BUILDING TRANSCRIPT\\nListening…";
      setAsrLiveStatus("Streaming full-buffer 16 kHz PCM16 partials to " + model.targetLabel + " for up to 10 seconds.", "streaming");
    }
    async function stopAsrRealtime(target = state.asrLive) { const live = target; if (!live) return; if (live.stopPromise) return live.stopPromise; live.stopPromise = (async () => { clearTimeout(live.timer); setAsrRealtimeControls(true, true); await stopAsrRealtimeCapture(live); if (live.pending.length && live.socket.readyState === WebSocket.OPEN) live.socket.send(new Int16Array(live.pending.splice(0)).buffer); if (live.socket.readyState !== WebSocket.OPEN) throw new Error("rtc-asr realtime stream closed before finalization."); setAsrLiveStatus("Finalizing the live rtc-asr stream…", "transcribing"); const finalized = new Promise((resolve, reject) => { live.finalResolve = resolve; live.finalReject = reject; }); live.socket.send(JSON.stringify({ type: "finalize" })); await Promise.race([finalized, new Promise((_, reject) => setTimeout(() => reject(new Error("rtc-asr final transcript timed out.")), 12000))]); closeAsrRealtime(live); })(); return live.stopPromise; }
    async function toggleAsrRealtime() { const live = state.asrLive; try { if (live && live.processor) await stopAsrRealtime(live); else if (live) closeAsrRealtime(live); else await startAsrRealtime(); } catch (error) { const failedLive = state.asrLive || live; renderAsrRealtimeError(error, failedLive); closeAsrRealtime(failedLive); } }
    function segmentTtsText(text) {
      const rough = String(text || "").trim().match(/[^.!?;:]+[.!?;:]*/g) || [];
      const segments = [];
      rough.forEach(part => {
        const clean = part.trim();
        if (!clean) return;
        if (clean.length <= 88) { segments.push(clean); return; }
        const words = clean.split(/\\s+/);
        let current = "";
        words.forEach(word => {
          if (current && (current + " " + word).length > 72) { segments.push(current); current = word; }
          else current = current ? current + " " + word : word;
        });
        if (current) segments.push(current);
      });
      return segments;
    }
    function renderTtsTextProgress(segments = segmentTtsText(document.getElementById("tts-text").value)) {
      const progress = document.getElementById("tts-text-progress");
      progress.innerHTML = segments.map((segment, index) => '<span class="tts-text-chunk" data-tts-chunk="' + index + '">' + esc(segment) + '</span>').join("");
      return segments;
    }
    function setTtsChunkState(index, nextState) {
      const chunk = document.querySelector('[data-tts-chunk="' + index + '"]');
      if (!chunk) return;
      chunk.classList.remove("is-buffered", "is-playing", "is-played");
      if (nextState) chunk.classList.add("is-" + nextState);
    }
    function stopTtsStream() {
      state.ttsStreamToken += 1;
      const stream = state.ttsStream;
      state.ttsStream = null;
      if (!stream) return;
      if (stream.controller) stream.controller.abort();
      stream.timers.forEach(timer => clearTimeout(timer));
      stream.sources.forEach(source => { try { source.stop(); } catch {} });
      if (stream.context && stream.context.state !== "closed") stream.context.close().catch(() => undefined);
      document.getElementById("tts-run").disabled = false;
      document.getElementById("tts-provider").disabled = false;
    }
    async function readTtsChunk(reader, timeoutMs, context) {
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(context + " did not return data within " + timeoutMs + " ms.")), timeoutMs);
      });
      try {
        return await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timeoutId);
      }
    }
    function liveTtsTimeouts(provider) {
      return provider.id === "kokoro"
        ? { fetchMs: LIVE_TTS_KOKORO_FETCH_TIMEOUT_MS, readMs: LIVE_TTS_KOKORO_READ_TIMEOUT_MS }
        : { fetchMs: LIVE_TTS_FAST_FETCH_TIMEOUT_MS, readMs: LIVE_TTS_FAST_READ_TIMEOUT_MS };
    }
    async function readTtsAudioResponse(response, onChunk, readTimeoutMs = LIVE_TTS_FAST_READ_TIMEOUT_MS) {
      if (!response.body) throw new Error("The browser did not expose the streaming response body.");
      const reader = response.body.getReader();
      const parts = [];
      let total = 0;
      while (true) {
        const chunk = await readTtsChunk(reader, readTimeoutMs, "The live TTS audio stream");
        if (chunk.done) break;
        if (!chunk.value?.byteLength) continue;
        parts.push(chunk.value);
        total += chunk.value.byteLength;
        onChunk(chunk.value.byteLength);
      }
      if (!total) throw new Error("The local TTS engine returned no audio bytes.");
      const merged = new Uint8Array(total);
      let offset = 0;
      parts.forEach(part => { merged.set(part, offset); offset += part.byteLength; });
      return merged.buffer;
    }
    function selectedTtsProvider() { const id = document.getElementById("tts-provider").value; return data.ttsPanel.providers.find(provider => provider.id === id) || data.ttsPanel.providers[0]; }
    function renderTtsProviderSelection() { const provider = selectedTtsProvider(); const badge = document.getElementById("tts-badge"); document.getElementById("tts-provider-meta").textContent = provider.model + " · " + provider.voice; document.getElementById("tts-run").textContent = "Run " + provider.shortLabel; badge.textContent = provider.status === "live_ready" ? "sidecar ready" : "local sidecar required"; badge.className = "badge " + (provider.status === "live_ready" ? "ready" : "fixture"); document.getElementById("tts-status").textContent = provider.status === "live_ready" ? data.ttsPanel.metricDefinition : provider.setup; }
    function resetTtsMeasurements() { document.getElementById("tts-ttfb").textContent = "—"; document.getElementById("tts-playback").textContent = "—"; document.getElementById("tts-total").textContent = "—"; document.getElementById("tts-bytes").textContent = "—"; renderTtsTextProgress(); }
    async function runTtsLabBuffered() {
      const button = document.getElementById("tts-run");
      const badge = document.getElementById("tts-badge");
      const status = document.getElementById("tts-status");
      const audio = document.getElementById("tts-audio");
      const provider = selectedTtsProvider();
      const text = document.getElementById("tts-text").value.trim();
      if (!text) { status.textContent = "Enter text before running " + provider.label + "."; return; }
      if (state.ttsPlayingHandler) {
        audio.removeEventListener("playing", state.ttsPlayingHandler);
        state.ttsPlayingHandler = null;
      }
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (state.ttsAudioUrl) {
        URL.revokeObjectURL(state.ttsAudioUrl);
        state.ttsAudioUrl = null;
      }
      button.disabled = true;
      badge.textContent = "streaming";
      badge.className = "badge fixture";
      status.textContent = "Waiting for first audio bytes and actual playback…";
      document.getElementById("tts-ttfb").textContent = "—";
      document.getElementById("tts-playback").textContent = "—";
      document.getElementById("tts-total").textContent = "—";
      document.getElementById("tts-bytes").textContent = "—";
      const started = performance.now();
      try {
        const response = await fetch(data.ttsPanel.synthesizeRoute, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildTtsSynthesisRequest(provider, text)),
        });
        if (!response.ok) {
          const failure = await response.json().catch(() => ({ error: "HTTP " + response.status }));
          throw new Error(failure.detail || failure.nextStep || failure.error || provider.label + " synthesis failed.");
        }
        if (!response.body) throw new Error("The browser did not expose the streaming response body.");
        const contentType = (response.headers.get("content-type") || "audio/mpeg").split(";")[0];
        const canAppendLive = typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(contentType);
        const mediaSource = canAppendLive ? new MediaSource() : null;
        let sourceBuffer = null;
        const chunks = [];
        if (mediaSource) {
          state.ttsAudioUrl = URL.createObjectURL(mediaSource);
          audio.src = state.ttsAudioUrl;
          audio.hidden = false;
          await waitForTtsMediaSource(mediaSource);
          sourceBuffer = mediaSource.addSourceBuffer(contentType);
        }
        const reader = response.body.getReader();
        let bytes = 0;
        let firstByteMs = null;
        let playbackMs = null;
        let playPending = false;
        const upstreamTtfb = response.headers.get("x-acc-upstream-ttfb-ms");
        state.ttsPlayingHandler = () => {
          playbackMs = performance.now() - started;
          document.getElementById("tts-playback").textContent = Math.round(playbackMs) + " ms";
          badge.textContent = "playing";
          badge.className = "badge ready";
          status.textContent = provider.label + " playback started after " + Math.round(playbackMs) + " ms" + (firstByteMs === null ? "." : "; HTTP first bytes arrived after " + Math.round(firstByteMs) + " ms.");
          state.ttsPlayingHandler = null;
        };
        audio.addEventListener("playing", state.ttsPlayingHandler, { once: true });
        const responseProvider = response.headers.get("x-acc-tts-provider") || provider.label;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!chunk.value?.byteLength) continue;
          if (firstByteMs === null) {
            firstByteMs = performance.now() - started;
            document.getElementById("tts-ttfb").textContent = Math.round(firstByteMs) + " ms";
          }
          bytes += chunk.value.byteLength;
          if (sourceBuffer) await appendTtsMediaChunk(sourceBuffer, chunk.value);
          else chunks.push(chunk.value);
          if (sourceBuffer && playbackMs === null && !playPending) {
            playPending = true;
            audio.play().catch(() => {
              playPending = false;
              status.textContent = "Audio is streaming, but autoplay was blocked. Press play to record the actual playback-start event.";
            });
          }
        }
        if (!bytes || firstByteMs === null) throw new Error(provider.label + " returned no audio bytes.");
        if (mediaSource && sourceBuffer && mediaSource.readyState === "open" && !sourceBuffer.updating) mediaSource.endOfStream();
        if (!sourceBuffer) {
          state.ttsAudioUrl = URL.createObjectURL(new Blob(chunks, { type: contentType }));
          audio.src = state.ttsAudioUrl;
          audio.hidden = false;
          audio.load();
          status.textContent = provider.label + " streamed " + new Intl.NumberFormat().format(bytes) + " bytes. This browser buffered " + contentType + " before playback.";
          audio.play().catch(() => { status.textContent = provider.label + " audio is ready. Press play to record the actual playback-start event."; });
        }
        const totalMs = performance.now() - started;
        document.getElementById("tts-total").textContent = Math.round(totalMs) + " ms";
        document.getElementById("tts-bytes").textContent = new Intl.NumberFormat().format(bytes) + " B";
        if (playbackMs === null) {
          if (sourceBuffer) status.textContent = "HTTP first-byte includes ACC proxy overhead" + (upstreamTtfb ? "; " + provider.label + "-side first bytes took " + upstreamTtfb + " ms." : ".") + " Waiting for the browser playing event.";
          badge.textContent = "audio ready";
          badge.className = "badge ready";
        }
      } catch (error) {
        if (state.ttsPlayingHandler) {
          audio.removeEventListener("playing", state.ttsPlayingHandler);
          state.ttsPlayingHandler = null;
        }
        badge.textContent = "blocked";
        badge.className = "badge blocked";
        status.textContent = String(error.message || error);
      } finally {
        button.disabled = false;
      }
    }
    async function runTtsLab() {
      const button = document.getElementById("tts-run");
      const providerSelect = document.getElementById("tts-provider");
      const badge = document.getElementById("tts-badge");
      const status = document.getElementById("tts-status");
      const provider = selectedTtsProvider();
      const timeouts = liveTtsTimeouts(provider);
      const text = document.getElementById("tts-text").value.trim();
      if (!text) { status.textContent = "Enter text before running " + provider.label + "."; return; }
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) { status.textContent = "Web Audio is unavailable in this browser."; return; }
      stopFailureAudio();
      stopTtsStream();
      const segments = renderTtsTextProgress();
      const token = state.ttsStreamToken;
      const context = new AudioContextClass();
      const stream = { context, controller: new AbortController(), sources: [], timers: [] };
      state.ttsStream = stream;
      await context.resume();
      if (token !== state.ttsStreamToken) return;
      button.disabled = true;
      providerSelect.disabled = true;
      badge.textContent = "streaming";
      badge.className = "badge fixture";
      status.textContent = "Synthesizing chunk 1 of " + segments.length + "…";
      document.getElementById("tts-ttfb").textContent = "—";
      document.getElementById("tts-playback").textContent = "—";
      document.getElementById("tts-total").textContent = "—";
      document.getElementById("tts-bytes").textContent = "0 / " + segments.length;
      const started = performance.now();
      let firstByteMs = null;
      let playbackMs = null;
      let bytes = 0;
      let completedSegments = 0;
      let scheduledUntil = context.currentTime;
      try {
      for (let index = 0; index < segments.length; index += 1) {
        if (token !== state.ttsStreamToken) return;
        status.textContent = (playbackMs === null ? "Synthesizing" : "Playing queued audio while synthesizing") + " chunk " + (index + 1) + " of " + segments.length + "…";
        stream.controller = new AbortController();
        const requestController = stream.controller;
        const requestTimeout = setTimeout(() => requestController.abort(), timeouts.fetchMs);
        const response = await fetch(data.ttsPanel.synthesizeRoute, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildTtsSynthesisRequest(provider, segments[index])),
          signal: requestController.signal,
        }).finally(() => clearTimeout(requestTimeout));
        if (token !== state.ttsStreamToken) return;
        if (!response.ok) {
          const failure = await response.json().catch(() => ({ error: "HTTP " + response.status }));
          throw new Error(failure.detail || failure.nextStep || failure.error || provider.label + " synthesis failed.");
        }
        const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
        if (contentType && !contentType.startsWith("audio/")) {
          throw new Error(provider.label + " returned non-audio content (" + contentType + "); check POCKET_TTS_SPEECH_PATH and provider compatibility.");
        }
        const audioBytes = await readTtsAudioResponse(response, byteLength => {
          if (token !== state.ttsStreamToken) return;
          if (firstByteMs === null) {
            firstByteMs = performance.now() - started;
            document.getElementById("tts-ttfb").textContent = Math.round(firstByteMs) + " ms";
          }
            bytes += byteLength;
            document.getElementById("tts-bytes").textContent = completedSegments + " / " + segments.length + " · " + new Intl.NumberFormat().format(bytes) + " B";
          }, timeouts.readMs);
          if (token !== state.ttsStreamToken) return;
          const buffer = await context.decodeAudioData(audioBytes.slice(0));
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          stream.sources.push(source);
          const scheduledAt = Math.max(context.currentTime + 0.035, scheduledUntil);
          const startDelayMs = Math.max(0, (scheduledAt - context.currentTime) * 1000);
          scheduledUntil = scheduledAt + buffer.duration;
          setTtsChunkState(index, "buffered");
          const startTimer = setTimeout(() => {
            if (token !== state.ttsStreamToken) return;
            setTtsChunkState(index, "playing");
            if (playbackMs === null) {
              playbackMs = performance.now() - started;
              document.getElementById("tts-playback").textContent = Math.round(playbackMs) + " ms";
            }
            badge.textContent = "playing";
            badge.className = "badge ready";
          }, startDelayMs);
          stream.timers.push(startTimer);
          source.addEventListener("ended", () => {
            if (token !== state.ttsStreamToken) return;
            setTtsChunkState(index, "played");
            if (index === segments.length - 1) {
              badge.textContent = "complete";
              badge.className = "badge ready";
              status.textContent = provider.label + " played " + segments.length + " ordered chunks; synthesis and playback overlapped.";
            }
          }, { once: true });
          source.start(scheduledAt);
          completedSegments += 1;
          document.getElementById("tts-bytes").textContent = completedSegments + " / " + segments.length + " · " + new Intl.NumberFormat().format(bytes) + " B";
          if (index + 1 < segments.length) status.textContent = "Chunk " + (index + 1) + " queued; synthesizing chunk " + (index + 2) + " while playback continues.";
        }
        if (token !== state.ttsStreamToken) return;
        const totalMs = performance.now() - started;
        document.getElementById("tts-total").textContent = Math.round(totalMs) + " ms";
        status.textContent = "All " + segments.length + " chunks received in " + Math.round(totalMs) + " ms; queued audio is still playing.";
      } catch (error) {
        if (token !== state.ttsStreamToken) return;
        stopTtsStream();
        badge.textContent = "blocked";
        badge.className = "badge blocked";
        if (error?.name === "AbortError") {
          const providerBaseUrlEnv = provider.id === "pocket" ? "POCKET_TTS_BASE_URL" : "KOKORO_BASE_URL";
          status.textContent = provider.label + " request timed out. Confirm " + providerBaseUrlEnv + " is a real reachable endpoint and retry.";
        } else {
          status.textContent = String(error.message || error);
        }
      } finally {
        if (token === state.ttsStreamToken) {
          button.disabled = false;
          providerSelect.disabled = false;
        }
      }
    }
    function updateDemoEvidenceCount() { const transcript = document.getElementById("demo-transcript-detail"); const timeline = document.getElementById("timeline"); const turns = Number(transcript.dataset.turns || 0); const events = Number(timeline.dataset.events || 0); document.getElementById("demo-evidence-count").textContent = turns || events ? String(turns) + " turns · " + String(events) + " recent events" : "Available after the run"; }
    function setDemoStages(completedStages) { const count = completedStages === true ? 4 : completedStages === false ? 0 : Math.max(0, Number(completedStages) || 0); document.querySelectorAll(".demo-control-step").forEach(step => step.classList.toggle("complete", Number(step.dataset.step) <= count)); }
    function demoTurn(turns, speaker, needles, fallbackIndex) { const normalizedSpeaker = String(speaker).toLowerCase(); const match = turns.find(turn => String(turn.speaker || "").toLowerCase() === normalizedSpeaker && needles.some(needle => String(turn.text || "").toLowerCase().includes(needle))); return String(match?.text || turns[fallbackIndex]?.text || "Captured in the transcript."); }
    function renderTimeline(call) { const timeline = document.getElementById("timeline"); const auditLabels = { account_validated: "Account validated", cancellation_concern_captured: "Cancellation requested", customer_consent_recorded: "Price review accepted", operator_steer_requested: "Review approval requested", price_review_completed: "Price review completed", customer_final_path_selected: "Cancellation confirmed", cancellation_scheduled: "Cancellation scheduled", final_policy_state_recorded: "Final plan state recorded" }; const allEvents = call && Array.isArray(call.events) ? call.events : []; const hasScenarioOutcome = allEvents.some(event => event.type === "final_policy_state_recorded"); const events = hasScenarioOutcome ? allEvents.filter(event => auditLabels[event.type]).slice(-8) : allEvents.slice(-8); timeline.dataset.events = String(events.length); timeline.innerHTML = events.map(event => '<div class="event"><strong>' + esc(auditLabels[event.type] || event.type) + '</strong><span class="muted">' + esc(JSON.stringify(event.detail)) + '</span></div>').join("") || '<div class="plain muted">Run the scenario or a drill to populate audit evidence.</div>'; updateDemoEvidenceCount(); }
    function renderDemoTranscript(turns) { const screen = document.getElementById("demo-screen"); const transcript = document.getElementById("demo-transcript-detail"); const evidence = document.getElementById("demo-evidence"); const safeTurns = Array.isArray(turns) ? turns : []; const visibleTurns = safeTurns.filter(turn => String(turn.speaker || "").toLowerCase() !== "operator"); const concern = demoTurn(visibleTurns, "caller", ["4821", "cancel my plan"], 0); const choice = demoTurn(visibleTurns, "caller", ["please cancel"], 5); const finalResponse = demoTurn(visibleTurns, "agent", ["august 31"], 6); screen.classList.remove("has-drill"); screen.classList.add("has-transcript"); screen.innerHTML = '<div class="demo-result-head"><small>Scenario complete</small><strong>Cancellation scheduled for August 31.</strong><p>The price review found no lower price, and the caller chose to cancel.</p></div><div class="demo-result-grid"><div class="demo-result-item"><small>Account</small><span>' + esc(concern) + '</span></div><div class="demo-result-item"><small>Customer choice</small><span>' + esc(choice) + '</span></div><div class="demo-result-item"><small>Final state</small><span>' + esc(finalResponse.toLowerCase().includes("august 31") ? "Active through August 31 · will not renew · can undo" : finalResponse) + '</span></div></div>'; transcript.dataset.turns = String(visibleTurns.length); transcript.innerHTML = visibleTurns.map(turn => { const speaker = String(turn.speaker || "agent"); const tone = speaker.toLowerCase() === "caller" ? "caller" : "agent"; return '<div class="transcript-turn transcript-turn--' + tone + '"><span class="transcript-turn__speaker">' + esc(speaker) + '</span><span class="transcript-turn__text">' + esc(turn.text) + '</span></div>'; }).join(""); evidence.open = true; setDemoStages(true); updateDemoEvidenceCount(); }
    function renderOperatorDrill(payload) { const screen = document.getElementById("demo-screen"); const transcript = document.getElementById("demo-transcript-detail"); const evidence = document.getElementById("demo-evidence"); const integration = payload.integration || {}; const patterns = Array.isArray(integration.executionPatterns) ? integration.executionPatterns : []; const command = integration.controlSequence || integration.controlMessage; const summary = String(payload.summary || "Control drill completed.").replace(/_/g, " ").replace(/ -> /g, " → "); const outcome = String(payload.outcome || "Recorded for review").replace(/_/g, " "); screen.classList.remove("has-transcript"); screen.classList.add("has-drill"); screen.innerHTML = '<div class="demo-result-head"><small>Control drill complete</small><strong>' + esc(summary) + '</strong><p>The application bounded the decision before the media adapter executed it.</p></div><div class="demo-result-grid"><div class="demo-result-item"><small>Control plane</small><span>' + esc(integration.controlPlane || "ACC records a bounded operator action.") + '</span></div><div class="demo-result-item"><small>Media plane</small><span>' + esc(integration.mediaPlane || "The configured telephony adapter executes it.") + '</span></div><div class="demo-result-item"><small>Outcome</small><span>' + esc(outcome) + '</span></div></div>'; transcript.dataset.turns = "0"; transcript.innerHTML = (command ? '<pre class="drill-command">' + esc(JSON.stringify(command, null, 2)) + '</pre>' : '') + (patterns.length ? '<ul class="drill-patterns">' + patterns.map(pattern => '<li>' + esc(pattern) + '</li>').join("") + '</ul>' : '') + (integration.demoCaveat ? '<span class="muted">' + esc(integration.demoCaveat) + '</span>' : ''); evidence.open = true; setDemoStages(Array.isArray(payload.completedControlStages) ? payload.completedControlStages.length : 0); updateDemoEvidenceCount(); }
    function renderSlides() { document.querySelectorAll("[data-slide]").forEach(el => el.classList.toggle("active", Number(el.dataset.slide) === state.slide)); document.body.classList.toggle("voice-story-active", state.isPresent && slideOrder[state.slide] === "voice-evolution"); const prev = document.getElementById("prev"); const next = document.getElementById("next"); const status = document.getElementById("slide-status"); if (prev) prev.disabled = state.slide <= 0; if (next) next.disabled = state.slide >= state.slideCount - 1; if (status) status.textContent = String(state.slide + 1) + " / " + String(state.slideCount); }
    function goToSlide(index) { const nextSlide = Math.max(0, Math.min(state.slideCount - 1, index)); if (slideOrder[state.slide] === "vad-interruption" && slideOrder[nextSlide] !== "vad-interruption") { stopVadMic(true); stopVadBot(false); } if (slideOrder[state.slide] === "tts" && slideOrder[nextSlide] !== "tts") stopTtsStream(); state.slide = nextSlide; renderSlides(); const target = document.querySelector('[data-slide="' + state.slide + '"]'); if (!state.isPresent && target) target.scrollIntoView({ behavior: "smooth", block: "start" }); }
    function goToNamedSlide(id) { const index = slideOrder.indexOf(id); if (index >= 0) goToSlide(index); }
    function summarizeProof(proof) { return { compatibleRequest: data.proofPreview.compatibleRequest, callId: proof.callId, outcome: proof.outcome, summary: proof.summary, transcriptTurns: Array.isArray(proof.transcript) ? proof.transcript.length : 0, eventCount: Array.isArray(proof.events) ? proof.events.length : 0, latencyMarks: Array.isArray(proof.latencyMarks) ? proof.latencyMarks.length : 0, fallback: proof.demoFallback, caveats: proof.pii, artifactLinks: proof.artifacts }; }
    async function refreshLiveProbes() { try { const response = await fetch("/api/cluecon"); if (!response.ok) return; data = await response.json(); window.__CLUECON__ = data; renderReadiness(); renderAsrPanel(); renderTtsProviderSelection(); await loadAsrModels(); } catch (error) { console.warn("ClueCon live probe refresh failed", error); } }
    async function runDemo() { const buttons = document.querySelectorAll("button"); buttons.forEach(button => button.disabled = true); goToNamedSlide("demo"); const screen = document.getElementById("demo-screen"); const evidence = document.getElementById("demo-evidence"); const transcript = document.getElementById("demo-transcript-detail"); screen.classList.remove("has-transcript", "has-drill"); screen.innerHTML = '<div class="demo-result-head"><small>Running</small><strong>Handling the cancellation request…</strong><p>Validating the account, running the price review, and scheduling the caller’s confirmed cancellation.</p></div>'; evidence.open = false; transcript.dataset.turns = "0"; transcript.innerHTML = ""; setDemoStages(false); renderTimeline(null); document.getElementById("proof-json").textContent = "Waiting for scenario proof..."; try { const response = await fetch(data.routes.scriptedDemo, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openclawSessionLabel: "cluecon/2026-presentation" }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "demo failed"); state.proof = payload.proof; renderDemoTranscript(payload.call.transcript); document.getElementById("proof-json").textContent = JSON.stringify({ status: "control_scenario_ok", ...summarizeProof(payload.proof) }, null, 2); renderTimeline(payload.call); } catch (error) { const message = String(error.message || error); screen.classList.remove("has-transcript", "has-drill"); screen.innerHTML = '<div class="demo-result-head"><small>Scenario blocked</small><strong>Control scenario could not complete.</strong><p>' + esc(message) + '</p></div>'; setDemoStages(false); document.getElementById("proof-json").textContent = JSON.stringify({ status: "control_scenario_failed", error: message, nextStep: "Confirm npm start is serving /api/demo/run-end-to-end, then retry Run cancellation scenario." }, null, 2); } finally { buttons.forEach(button => button.disabled = false); renderSlides(); } }
    async function previewBrain() { const response = await fetch(data.brainPanel.previewRoute, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocks: state.brain }) }); const payload = await response.json(); document.getElementById("proof-json").textContent = JSON.stringify(payload, null, 2); goToNamedSlide("proof"); }
    async function applyBrain() { const response = await fetch(data.brainPanel.applyRoute, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocks: state.brain }) }); const payload = await response.json(); document.getElementById("proof-json").textContent = JSON.stringify(payload, null, 2); if (!response.ok) return; data.brainBlocks = payload.activeBrainBlocks; data.brainPanel = payload.brainPanel; state.brain = JSON.parse(JSON.stringify(payload.activeBrainBlocks)); renderBrain(); }
    async function resetBrain() { const response = await fetch(data.brainPanel.resetRoute, { method: "POST" }); const payload = await response.json(); document.getElementById("proof-json").textContent = JSON.stringify(payload, null, 2); data.brainBlocks = payload.activeBrainBlocks; data.brainPanel = payload.brainPanel; state.brain = JSON.parse(JSON.stringify(payload.activeBrainBlocks)); renderBrain(); }
    async function runOperatorDrill(kind) { const buttons = document.querySelectorAll("button"); buttons.forEach(button => button.disabled = true); goToNamedSlide("demo"); try { const response = await fetch(data.operatorCockpit.drillRoute, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "operator drill failed"); renderOperatorDrill(payload); document.getElementById("proof-json").textContent = JSON.stringify({ drill: payload.kind, outcome: payload.outcome, integration: payload.integration, workboardCard: payload.workboardCard, proofLinks: payload.proofLinks, finalState: payload.call.flowState, fallback: payload.call.demoFallback }, null, 2); renderTimeline(payload.call); } catch (error) { const screen = document.getElementById("demo-screen"); screen.classList.remove("has-transcript", "has-drill"); screen.textContent = "Operator drill failed: " + String(error.message || error); } finally { buttons.forEach(button => button.disabled = false); renderSlides(); } }
    async function runFallbackDrill(mode) { const buttons = document.querySelectorAll("button"); buttons.forEach(button => button.disabled = true); try { const start = await fetch("/api/demo/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openclawSessionLabel: "cluecon/" + mode + "-drill" }) }); const started = await start.json(); if (!start.ok) throw new Error(started.error || "start failed"); const fallback = await fetch("/api/calls/" + encodeURIComponent(started.session.callId) + "/fallback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, reason: mode + " ClueCon drill" }) }); const call = await fallback.json(); if (!fallback.ok) throw new Error(call.error || "fallback failed"); const proofResponse = await fetch("/api/calls/" + encodeURIComponent(started.session.callId) + "/proof"); const proof = await proofResponse.json(); document.getElementById("demo-screen").textContent = mode + " -> fail-closed human handoff; no improvised offer."; document.getElementById("proof-json").textContent = JSON.stringify(summarizeProof(proof), null, 2); renderTimeline(call); } finally { buttons.forEach(button => button.disabled = false); renderSlides(); } }
    document.getElementById("asr-model-select").addEventListener("change", event => { const model = selectedAsrModel(); document.getElementById("asr-realtime").disabled = !model || !model.websocketUrl; renderAsrBenchmarks(model); setAsrLiveStatus("Selected: " + event.target.selectedOptions[0].textContent + ". Realtime and batch modes use this warmed endpoint.", "ready"); });
    document.getElementById("run-demo").addEventListener("click", () => runDemo().catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); }));
    document.getElementById("demo-evidence").addEventListener("toggle", event => { document.getElementById("demo-evidence-toggle").textContent = event.currentTarget.open ? "Collapse" : "Expand"; });
    document.getElementById("tts-provider").addEventListener("change", () => { stopTtsStream(); renderTtsProviderSelection(); resetTtsMeasurements(); });
    document.getElementById("tts-text").addEventListener("input", () => { stopTtsStream(); renderTtsProviderSelection(); resetTtsMeasurements(); });
    document.getElementById("tts-run").addEventListener("click", runTtsLab);
    document.getElementById("vad-mic").addEventListener("click", () => toggleVadMic().catch(error => { vadStatus("mic error", "blocked"); vadLog("MIC_ERROR", String(error.message || error)); }));
    document.getElementById("vad-agent").addEventListener("click", startVadBot);
    document.getElementById("vad-simulate").addEventListener("click", simulateVadBargeIn);
    document.getElementById("vad-reset").addEventListener("click", resetVadDemo);
    document.getElementById("vad-threshold").addEventListener("input", updateVadThreshold);
    document.getElementById("asr-realtime").addEventListener("click", toggleAsrRealtime);
    document.getElementById("asr-record").addEventListener("click", toggleAsrRecording);
    document.getElementById("run-demo-drill").addEventListener("click", () => { const kind = document.getElementById("demo-drill-select").value; const runner = kind === "rtc_asr_unavailable" || kind === "tts_unavailable" ? runMediaFailureDrill : runOperatorDrill; runner(kind).catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); }); });
    document.getElementById("next").addEventListener("click", () => goToSlide(state.slide + 1));
    document.getElementById("prev").addEventListener("click", () => goToSlide(state.slide - 1));
    document.addEventListener("keydown", event => { if (event.key === "ArrowRight" || event.key === "PageDown") goToSlide(state.slide + 1); if (event.key === "ArrowLeft" || event.key === "PageUp") goToSlide(state.slide - 1); });
    window.addEventListener("pagehide", () => { stopVadMic(true); stopVadBot(false); stopTtsStream(); stopFailureAudio(); });
    updateVadThreshold(); renderReadiness(); renderAsrPanel(); renderTtsProviderSelection(); renderTtsTextProgress(); renderBrain(); renderSecurityPanel(); setupAgentCode(); renderTimeline(null); goToSlide(0); refreshLiveProbes();
  </script>
</body>
</html>`;

  const correctedVadReferences =
    '<div class="turn-reference"><strong>Speech activity</strong><a href="https://github.com/TEN-framework/ten-vad" target="_blank" rel="noreferrer">TEN VAD</a> and <a href="https://github.com/snakers4/silero-vad" target="_blank" rel="noreferrer">Silero VAD</a> detect acoustic speech boundaries.</div>' +
    '<div class="turn-reference"><strong>Turn completion</strong><a href="https://github.com/pipecat-ai/smart-turn" target="_blank" rel="noreferrer">Pipecat Smart Turn</a> and the <a href="https://github.com/livekit/agents/tree/main/livekit-plugins/livekit-plugins-turn-detector" target="_blank" rel="noreferrer">LiveKit turn detector</a> estimate whether the user is actually done.</div>';
  return html.replace(
    /<div class="turn-reference"><strong>Pipecat smart-turn<\/strong>.*?<\/div><div class="turn-reference"><strong>VAD alternatives<\/strong>.*?<\/div>/,
    correctedVadReferences,
  );
}
