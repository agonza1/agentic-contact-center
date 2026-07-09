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
    workboardCard: "85ea5a1a-3a68-4e5d-ac1d-10d5851017ae",
    activeWorkboardCard: clueConProofEvalCard,
    title: "From SIP to Tokens: Deterministic Telephony Meets Real-Time Voice AI",
    thesis:
      "SIP gives deterministic call state. Pipecat gives the media runtime. rtc-asr gives the local STT boundary. OpenClaw-style harnessing controls the agent. Kokoro speaks locally. ConversationAgentEvals / ASSERT proves whether the workflow completed safely.",
    demoGoal: {
      issue: "agonza1/agentic-contact-center#177",
      statement: "Run one inspectable local cancellation-rescue call from SIP ingress through Pipecat, rtc-asr, OpenClaw agent control, Kokoro/local TTS, and ASSERT proof.",
      chain: ["sip", "pipecat", "rtc_asr", "openclaw_agent", "kokoro_tts", "conversation_agent_evals"],
      successSignal: "The scorecard passes with transcript, operator action, latency, fallback caveat, and proof-bundle evidence attached.",
    },
    routes: {
      scrollable: "/cluecon",
      present: "/cluecon/present",
      scriptedDemo: "/api/demo/run-end-to-end",
      operatorConsole: "/operator/console",
      proofViewer: "/assert",
      assertSpec: "/assert/spec",
      realtimeShimReadiness: "/api/realtime-shim/readiness",
      realtimeShimProof: "/api/realtime-shim/proof",
      operatorDrill: "/api/cluecon/operator/drill",
      evalPreview: "/api/cluecon/eval/preview",
      evalRun: "/api/cluecon/eval/run",
    },
    liveProbes,
    readiness: [
      {
        id: "acc",
        label: "ACC app",
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
        status: rtcAsrProbe?.status ?? "fixture",
        detail: rtcAsrProbe?.detail ?? "Readiness and stream events are shown from fixture mode unless rtc-asr is reachable locally.",
        caveat: rtcAsrProbe?.configured
          ? `Probe ${rtcAsrProbe.ok ? "passed" : "failed"} at ${rtcAsrProbe.url}.`
          : "Unavailable rtc-asr is a blocker state, not a fake transcript.",
      },
      {
        id: "kokoro",
        label: "Kokoro TTS",
        status: kokoroProbe?.status ?? "fixture",
        detail: kokoroProbe?.detail ?? "Kokoro is marked unavailable for this slice and falls back to text/local TTS.",
        caveat: kokoroProbe?.configured
          ? `Probe ${kokoroProbe.ok ? "passed" : "failed"} at ${kokoroProbe.url}.`
          : "The UI is honest about TTS fallback during the talk path.",
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
      status: rtcAsrProbe?.ok ? "live_ready" : "fixture_blocker",
      endpointHints: ["GET /health", "GET /v1/models", "WS /v1/stt/stream"],
      liveProbe: rtcAsrProbe ?? null,
      streamStates: ["connected", "ready", "partial", "final", "canceled", "error"],
      fixtureEvents: [
        { state: "connected", text: "local Pipecat bridge opened an ASR stream", latencyMs: 34 },
        { state: "partial", text: "i need to cancel", latencyMs: 238 },
        { state: "final", text: "I need to cancel because the renewal increase is too high.", latencyMs: 812 },
        { state: "error", text: "rtc-asr sidecar unavailable: keep blocker visible", latencyMs: null },
      ],
      benchmarks: [
        { label: "first partial", value: "238 ms", caveat: "fixture until benchmark artifact is present" },
        { label: "finalization", value: "812 ms", caveat: "fixture until rtc-asr health is reachable" },
        { label: "RTF", value: "0.41x", caveat: "example Local STT v1 target" },
      ],
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
      proofLinks: ["/api/operator/console", "/api/queue?attentionRequired=true", "/api/demo/run-end-to-end"],
      caveat: "Cockpit drills reuse the local call/session APIs; browser voice remains optional when Pipecat and rtc-asr are configured.",
    },
    proofPreview: {
      workboardCard: clueConProofEvalCard,
      previewRoute: "/api/cluecon/eval/preview",
      runRoute: "/api/cluecon/eval/run",
      includes: ["transcript", "events", "action trace", "latency marks", "final state", "fallback state", "OpenClaw artifact links", "ASR/TTS caveats"],
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
      missingDetail: "RTC_ASR_BASE_URL is not set; ASR panel stays in fixture/blocker mode.",
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
    h1 { max-width: 980px; font-size: clamp(36px, 7vw, 78px); line-height: .96; margin-bottom: 18px; }
    h2 { font-size: clamp(26px, 4vw, 46px); line-height: 1.02; margin-bottom: 10px; }
    h3 { font-size: 15px; margin-bottom: 8px; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: flex-end; }
    .toolbar a, .mode-link { display: inline-flex; align-items: center; min-height: 36px; padding: 0 10px; border: 1px solid #b9c6d2; border-radius: 6px; background: #fff; color: var(--ink); font-size: 13px; }
    .hero, .slide { min-height: calc(100vh - 62px); padding: 54px clamp(18px, 5vw, 72px); display: grid; align-content: center; gap: 22px; border-bottom: 1px solid var(--line); }
    .hero { background: linear-gradient(180deg, #ffffff 0%, #eef4f4 100%); }
    .subhead { max-width: 850px; color: #334155; font-size: clamp(18px, 2.2vw, 25px); line-height: 1.38; }
    .section-band { padding: 42px clamp(18px, 5vw, 72px); border-bottom: 1px solid var(--line); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, .8fr); gap: 18px; align-items: start; }
    .card { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: var(--panel); box-shadow: var(--shadow); min-width: 0; }
    .plain { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: #fff; min-width: 0; }
    .metric { display: grid; gap: 5px; }
    .metric strong { font-size: 20px; overflow-wrap: anywhere; }
    .muted { color: var(--muted); font-size: 13px; line-height: 1.45; }
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
    .demo-shell { display: grid; gap: 12px; }
    .screen { min-height: 360px; border: 1px solid var(--line); border-radius: 8px; background: #101820; color: #dbeafe; padding: 14px; overflow: auto; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .timeline { display: grid; gap: 8px; }
    .event { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 10px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
    .brain, .asr-events { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
    textarea { width: 100%; min-height: 108px; resize: vertical; border: 1px solid var(--line); border-radius: 6px; padding: 9px; color: var(--ink); }
    .proof-pre { margin: 0; min-height: 260px; max-height: 460px; overflow: auto; border-radius: 8px; padding: 12px; background: #0d1117; color: #e6edf3; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .present .topbar { position: fixed; width: 100%; }
    .present main { padding-top: 62px; }
    .present .slide, .present .hero { min-height: calc(100vh - 62px); }
    .present .section-band:not(.active), .present .hero:not(.active) { display: none; }
    @media (max-width: 920px) { .two { grid-template-columns: 1fr; } .topbar { position: static; align-items: stretch; flex-direction: column; } .toolbar { justify-content: flex-start; } .hero, .slide, .section-band { padding: 28px 14px; } h1 { font-size: 38px; } .event { grid-template-columns: 1fr; } }
  </style>
</head>
<body class="${bodyClass}">
  <header class="topbar"><div class="brand"><span class="kicker">ClueCon vertical slice</span><strong>Agentic Contact Center</strong></div><nav class="toolbar" aria-label="ClueCon sections"><a href="/cluecon">Narrative</a><a href="/cluecon/present">Present</a><a href="/operator/console">Operator</a><a href="/assert">Proof</a><button id="prev" type="button">Prev</button><button id="next" type="button" class="primary">Next</button></nav></header>
  <main>
    <section class="hero active" data-slide="0"><span class="kicker">From SIP to Tokens</span><h1>${escapeHtml(payload.title)}</h1><p class="subhead">${escapeHtml(payload.thesis)}</p><div class="actions"><button class="primary" id="run-demo-top" type="button">Run scripted proof</button><a class="mode-link" href="#demo">Open cockpit slice</a></div></section>
    <section class="section-band slide" data-slide="1" id="map"><div class="two"><div><span class="kicker">System map</span><h2>Every boundary is visible.</h2><p class="subhead">Deterministic telephony state, Pipecat media transport, local ASR, agent policy/tool control, operator steer, TTS fallback, and evaluation evidence are separate contracts.</p><svg class="arch" viewBox="0 0 980 380" role="img" aria-label="On-prem voice agent architecture"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#2457a6"/></marker></defs><rect class="nodeAccent" x="24" y="74" width="130" height="74" rx="8"/><text class="label" x="89" y="105" text-anchor="middle">Caller</text><text class="small" x="89" y="126" text-anchor="middle">SIP / browser</text><rect class="node" x="194" y="74" width="132" height="74" rx="8"/><text class="label" x="260" y="105" text-anchor="middle">Pipecat</text><text class="small" x="260" y="126" text-anchor="middle">transport</text><rect class="nodeWarn" x="366" y="74" width="132" height="74" rx="8"/><text class="label" x="432" y="105" text-anchor="middle">rtc-asr</text><text class="small" x="432" y="126" text-anchor="middle">Local STT v1</text><rect class="nodeAccent" x="538" y="74" width="144" height="74" rx="8"/><text class="label" x="610" y="105" text-anchor="middle">OpenClaw</text><text class="small" x="610" y="126" text-anchor="middle">agent harness</text><rect class="nodeWarn" x="722" y="74" width="112" height="74" rx="8"/><text class="label" x="778" y="105" text-anchor="middle">Kokoro</text><text class="small" x="778" y="126" text-anchor="middle">TTS</text><rect class="node" x="298" y="236" width="160" height="78" rx="8"/><text class="label" x="378" y="267" text-anchor="middle">Operator</text><text class="small" x="378" y="288" text-anchor="middle">approve / handoff</text><rect class="nodeAccent" x="536" y="236" width="158" height="78" rx="8"/><text class="label" x="615" y="267" text-anchor="middle">Proof bundle</text><text class="small" x="615" y="288" text-anchor="middle">events + latency</text><rect class="nodeAccent" x="748" y="236" width="160" height="78" rx="8"/><text class="label" x="828" y="267" text-anchor="middle">ASSERT eval</text><text class="small" x="828" y="288" text-anchor="middle">scorecard</text><path class="line" d="M154 111 H194"/><path class="line" d="M326 111 H366"/><path class="line" d="M498 111 H538"/><path class="line" d="M682 111 H722"/><path class="line" d="M610 148 V236"/><path class="line" d="M694 275 H748"/><path class="line" d="M458 275 H536"/><path class="line" d="M378 236 C412 184 496 154 538 126"/></svg></div><div class="grid" id="readiness"></div></div></section>
    <section class="section-band slide" data-slide="2" id="demo"><span class="kicker">Scripted cancellation rescue</span><h2>Run the operator-safe story end to end.</h2><div class="two"><div class="demo-shell"><div class="actions"><button class="primary" id="run-demo" type="button">Run scripted demo</button><button id="drill-tool" type="button" class="danger">Tool timeout drill</button><button id="drill-runtime" type="button" class="danger">Runtime failure drill</button><button id="drill-transfer" type="button">Transfer</button><button id="drill-takeover" type="button">Takeover</button><button id="drill-end" type="button">End call</button><button id="drill-asr" type="button">rtc-asr unavailable</button><button id="drill-tts" type="button">TTS unavailable</button></div><div class="screen" id="demo-screen">Ready. Scripted mode needs no external credentials.</div></div><div class="timeline" id="timeline"></div></div></section>
    <section class="section-band slide" data-slide="3" id="asr"><span class="kicker">ASR boundary</span><h2>rtc-asr is measurable and swappable.</h2><div class="two"><div><p class="subhead">The ClueCon path treats speech recognition as a provider contract, not agent magic: normalized PCM16 enters the sidecar and timestamped transcript events leave it.</p><div class="asr-events" id="asr-events"></div></div><div class="grid" id="asr-benchmarks"></div></div></section>
    <section class="section-band slide" data-slide="4" id="agent"><span class="kicker">Agent harness</span><h2>Markdown brain blocks are part of the runtime story.</h2><div class="plain" id="brain-state"></div><div class="brain" id="brain"></div><div class="actions"><button id="preview-brain" type="button">Preview edits</button><button id="apply-brain" type="button" class="primary">Apply to session</button><button id="reset-brain" type="button">Reset</button></div></section>
    <section class="section-band slide" data-slide="5" id="proof"><span class="kicker">Evidence finish line</span><h2>The demo ends at proof, not speech.</h2><div class="actions"><button id="run-eval" type="button" class="primary">Run eval proof</button><a class="mode-link" href="/assert">Open ASSERT viewer</a></div><div class="two"><div><div class="grid" id="proof-cards"></div><div class="timeline" id="eval-scorecard"></div></div><pre class="proof-pre" id="proof-json">Run the scripted demo to preview the proof bundle and ASSERT handoff.</pre></div></section>
  </main>
  <script>window.__CLUECON__ = ${data};</script>
  <script>
    let data = window.__CLUECON__;
    const state = { slide: 0, proof: null, brain: JSON.parse(JSON.stringify(data.brainBlocks)), brainSession: null };
    function esc(value) { return String(value).replace(/[&<>\"]/g, c => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"); }
    function renderReadiness() { document.getElementById("readiness").innerHTML = data.readiness.map(item => '<article class="card metric"><span class="badge ' + esc(item.status) + '">' + esc(item.status) + '</span><strong>' + esc(item.label) + '</strong><span class="muted">' + esc(item.detail) + '</span><span class="muted">' + esc(item.caveat) + '</span></article>').join(""); }
    function renderBrain() { const session = state.brainSession ? state.brainSession.session : { id: "cluecon-agent-brain-demo", activeTool: "operator.approve_offer", policyState: "policy_hold_requires_operator_approval" }; document.getElementById("brain-state").innerHTML = '<span class="badge ready">session scoped</span><h3>' + esc(session.id) + '</h3><span class="muted">Tool: ' + esc(session.activeTool) + ' / Policy: ' + esc(session.policyState) + '</span>'; document.getElementById("brain").innerHTML = state.brain.map((block, index) => '<article class="plain"><h3>' + esc(block.file) + '</h3><textarea data-brain="' + index + '">' + esc(block.summary) + '</textarea><span class="muted">Affects: ' + esc(block.affects.join(", ")) + '</span></article>').join(""); document.querySelectorAll("textarea[data-brain]").forEach(input => input.addEventListener("change", () => { state.brain[Number(input.dataset.brain)].summary = input.value; })); }
    function renderAsrPanel() { document.getElementById("asr-events").innerHTML = data.asrPanel.fixtureEvents.map(event => '<article class="plain"><span class="badge ' + (event.state === "error" ? "blocked" : "fixture") + '">' + esc(event.state) + '</span><h3>' + esc(event.text) + '</h3><span class="muted">Latency: ' + esc(event.latencyMs === null ? "unavailable" : event.latencyMs + " ms") + '</span></article>').join(""); document.getElementById("asr-benchmarks").innerHTML = ['<article class="card metric"><span class="muted">Contract</span><strong>' + esc(data.asrPanel.contract) + '</strong><span class="muted">' + esc(data.asrPanel.endpointHints.join(" / ")) + '</span></article>'].concat(data.asrPanel.benchmarks.map(item => '<article class="card metric"><span class="muted">' + esc(item.label) + '</span><strong>' + esc(item.value) + '</strong><span class="muted">' + esc(item.caveat) + '</span></article>')).join(""); }
    function renderProofCards() { document.getElementById("proof-cards").innerHTML = data.proofPreview.includes.map(item => '<article class="card metric"><span class="muted">Proof field</span><strong>' + esc(item) + '</strong></article>').join(""); document.getElementById("eval-scorecard").innerHTML = data.proofPreview.scorecardChecks.map(item => '<div class="event"><strong>' + esc(item) + '</strong><span class="muted">Waiting for eval proof run.</span></div>').join(""); }
    function renderTimeline(call) { const events = call ? call.events.slice(-8) : []; document.getElementById("timeline").innerHTML = events.map(event => '<div class="event"><strong>' + esc(event.type) + '</strong><span class="muted">' + esc(JSON.stringify(event.detail)) + '</span></div>').join("") || '<div class="plain muted">Timeline will populate from the scripted call events.</div>'; }
    function renderSlides() { document.querySelectorAll("[data-slide]").forEach(el => el.classList.toggle("active", Number(el.dataset.slide) === state.slide)); }
    function summarizeProof(proof) { return { compatibleRequest: data.proofPreview.compatibleRequest, callId: proof.callId, outcome: proof.outcome, summary: proof.summary, transcriptTurns: Array.isArray(proof.transcript) ? proof.transcript.length : 0, eventCount: Array.isArray(proof.events) ? proof.events.length : 0, latencyMarks: Array.isArray(proof.latencyMarks) ? proof.latencyMarks.length : 0, fallback: proof.demoFallback, caveats: proof.pii, artifactLinks: proof.artifacts }; }
    function renderScorecard(scorecard) { document.getElementById("eval-scorecard").innerHTML = scorecard.checks.map(check => '<div class="event"><strong>' + esc(check.label) + '</strong><span class="muted"><span class="badge ' + (check.passed ? 'ready' : 'blocked') + '">' + (check.passed ? 'pass' : 'fail') + '</span> ' + esc(check.evidence) + '</span></div>').join(""); }
    async function runEvalProof() { const buttons = document.querySelectorAll("button"); buttons.forEach(button => button.disabled = true); document.getElementById("proof-json").textContent = "Running ClueCon ASSERT-style eval proof..."; try { const response = await fetch(data.proofPreview.runRoute, { method: "POST" }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "eval proof failed"); renderScorecard(payload.scorecard); document.getElementById("proof-json").textContent = JSON.stringify({ compatibleRequest: payload.compatibleRequest, summary: payload.summary, scorecard: payload.scorecard, assertRequestPreview: payload.assertRequestPreview, proofLinks: payload.proofLinks }, null, 2); } catch (error) { document.getElementById("proof-json").textContent = String(error.message || error); } finally { buttons.forEach(button => button.disabled = false); } }
    async function refreshLiveProbes() { try { const response = await fetch("/api/cluecon"); if (!response.ok) return; data = await response.json(); window.__CLUECON__ = data; renderReadiness(); renderAsrPanel(); } catch (error) { console.warn("ClueCon live probe refresh failed", error); } }
    async function runDemo() { const buttons = document.querySelectorAll("button"); buttons.forEach(button => button.disabled = true); document.getElementById("demo-screen").textContent = "Running scripted cancellation-rescue proof..."; try { const response = await fetch(data.routes.scriptedDemo, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openclawSessionLabel: "cluecon/vertical-slice" }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "demo failed"); state.proof = payload.proof; const transcript = payload.call.transcript.map(turn => turn.speaker + ": " + turn.text).join("\n"); document.getElementById("demo-screen").textContent = transcript; document.getElementById("proof-json").textContent = JSON.stringify(summarizeProof(payload.proof), null, 2); renderTimeline(payload.call); } catch (error) { document.getElementById("demo-screen").textContent = String(error.message || error); } finally { buttons.forEach(button => button.disabled = false); } }
    async function previewBrain() { const response = await fetch(data.brainPanel.previewRoute, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocks: state.brain }) }); const payload = await response.json(); document.getElementById("proof-json").textContent = JSON.stringify(payload, null, 2); state.slide = ${mode === "present" ? 5 : 4}; renderSlides(); }
    async function applyBrain() { const response = await fetch(data.brainPanel.applyRoute, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocks: state.brain }) }); const payload = await response.json(); document.getElementById("proof-json").textContent = JSON.stringify(payload, null, 2); if (!response.ok) return; data.brainBlocks = payload.activeBrainBlocks; data.brainPanel = payload.brainPanel; state.brain = JSON.parse(JSON.stringify(payload.activeBrainBlocks)); renderBrain(); }
    async function resetBrain() { const response = await fetch(data.brainPanel.resetRoute, { method: "POST" }); const payload = await response.json(); document.getElementById("proof-json").textContent = JSON.stringify(payload, null, 2); data.brainBlocks = payload.activeBrainBlocks; data.brainPanel = payload.brainPanel; state.brain = JSON.parse(JSON.stringify(payload.activeBrainBlocks)); renderBrain(); }
    async function runOperatorDrill(kind) { const buttons = document.querySelectorAll("button"); buttons.forEach(button => button.disabled = true); try { const response = await fetch(data.operatorCockpit.drillRoute, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "operator drill failed"); document.getElementById("demo-screen").textContent = payload.summary; document.getElementById("proof-json").textContent = JSON.stringify({ drill: payload.kind, outcome: payload.outcome, workboardCard: payload.workboardCard, proofLinks: payload.proofLinks, finalState: payload.call.flowState, fallback: payload.call.demoFallback }, null, 2); renderTimeline(payload.call); } finally { buttons.forEach(button => button.disabled = false); } }
    async function runFallbackDrill(mode) { const buttons = document.querySelectorAll("button"); buttons.forEach(button => button.disabled = true); try { const start = await fetch("/api/demo/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openclawSessionLabel: "cluecon/" + mode + "-drill" }) }); const started = await start.json(); if (!start.ok) throw new Error(started.error || "start failed"); const fallback = await fetch("/api/calls/" + encodeURIComponent(started.session.callId) + "/fallback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, reason: mode + " ClueCon drill" }) }); const call = await fallback.json(); if (!fallback.ok) throw new Error(call.error || "fallback failed"); const proofResponse = await fetch("/api/calls/" + encodeURIComponent(started.session.callId) + "/proof"); const proof = await proofResponse.json(); document.getElementById("demo-screen").textContent = mode + " -> fail-closed human handoff; no improvised offer."; document.getElementById("proof-json").textContent = JSON.stringify(summarizeProof(proof), null, 2); renderTimeline(call); } finally { buttons.forEach(button => button.disabled = false); } }
    function drill(kind) { const messages = { asr: "rtc_asr_unavailable -> visible ASR blocker; scripted fixture remains labeled and no fake live transcript is claimed.", tts: "tts_unavailable -> text/local-TTS fallback; Kokoro remains marked unavailable." }; const message = messages[kind] || "unavailable drill"; document.getElementById("demo-screen").textContent = message; document.getElementById("proof-json").textContent = JSON.stringify({ failureDrill: kind, honestState: message, caveat: "Preview blocker only; scripted path is still available for talk continuity." }, null, 2); }
    document.getElementById("run-eval").addEventListener("click", () => runEvalProof().catch(error => { document.getElementById("proof-json").textContent = String(error.message || error); })); document.getElementById("run-demo").addEventListener("click", runDemo); document.getElementById("run-demo-top").addEventListener("click", runDemo); document.getElementById("drill-tool").addEventListener("click", () => runOperatorDrill("tool_timeout").catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); })); document.getElementById("drill-runtime").addEventListener("click", () => runOperatorDrill("runtime_failure").catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); })); document.getElementById("drill-transfer").addEventListener("click", () => runOperatorDrill("transfer").catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); })); document.getElementById("drill-takeover").addEventListener("click", () => runOperatorDrill("takeover").catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); })); document.getElementById("drill-end").addEventListener("click", () => runOperatorDrill("end_call").catch(error => { document.getElementById("demo-screen").textContent = String(error.message || error); })); document.getElementById("drill-asr").addEventListener("click", () => drill("asr")); document.getElementById("drill-tts").addEventListener("click", () => drill("tts")); document.getElementById("preview-brain").addEventListener("click", () => previewBrain().catch(error => { document.getElementById("proof-json").textContent = String(error.message || error); })); document.getElementById("apply-brain").addEventListener("click", () => applyBrain().catch(error => { document.getElementById("proof-json").textContent = String(error.message || error); })); document.getElementById("reset-brain").addEventListener("click", () => resetBrain().catch(error => { document.getElementById("proof-json").textContent = String(error.message || error); })); document.getElementById("next").addEventListener("click", () => { state.slide = Math.min(5, state.slide + 1); renderSlides(); }); document.getElementById("prev").addEventListener("click", () => { state.slide = Math.max(0, state.slide - 1); renderSlides(); }); document.addEventListener("keydown", event => { if (event.key === "ArrowRight" || event.key === "PageDown") { state.slide = Math.min(5, state.slide + 1); renderSlides(); } if (event.key === "ArrowLeft" || event.key === "PageUp") { state.slide = Math.max(0, state.slide - 1); renderSlides(); } });
    renderReadiness(); renderAsrPanel(); renderBrain(); renderProofCards(); renderTimeline(null); renderSlides(); refreshLiveProbes();
  </script>
</body>
</html>`;
}
