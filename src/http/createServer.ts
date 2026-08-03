import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";

import {
  buildClueConBrainPreview,
  buildClueConHtml,
  buildClueConPayload,
  buildClueConPayloadWithLiveProbes,
  clueConAgentBrainCard,
  clueConOperatorCockpitCard,
  clueConProofEvalCard,
  defaultClueConBrainBlocks,
  normalizeClueConBrainBlocks,
} from "./cluecon";

import {
  assertSpecBlocks,
  assertSpecToYaml,
  cloneAssertEvaluationSpec,
  defaultAssertEvaluationSpec,
  type AssertEvaluationSpec,
} from "../core/assertEvaluationSpec";
import { compareTimestamps, getAttentionMetadata } from "../core/attention";
import {
  hasActiveTerminalOperatorStop,
  InMemoryTelephonyIngress,
  shouldForceScriptedRetentionFinalTurn,
} from "../core/inMemoryTelephonyIngress";
import { buildPipecatFlowManagerContractPayload } from "../core/pipecatFlowManagerContract";
import { buildPipecatMediaEngineReadinessPayload } from "../core/pipecatMediaEngineReadiness";
import { RealtimeVoiceSessionStore, buildRealtimeVoiceSessionEndpoints } from "../core/realtimeVoiceSessions";
import {
  CLUECON_CANCELLATION_CALLER_TURNS,
  getPipecatPrototypeHealth,
  isConversationMode,
  SCRIPTED_CALLER_TURNS,
  type OpenAiLlmTurnResult,
} from "../core/pipecatFlowPrototype";
import { runtimeSeams } from "../core/seams";
import type {
  AttentionSource,
  CallSnapshot,
  ConversationMode,
  FallbackMode,
  FlowState,
  OperatorSteerAction,
  PocConfig,
  StartCallOptions,
  TranscriptTurn,
} from "../core/types";

const flowStates = new Set<FlowState>([
  "call_started",
  "greet",
  "diagnose",
  "policy_hold",
  "operator_steer",
  "steered_response",
  "wrap",
]);

const maxEventTrailPageLimit = 100;
const maxTranscriptPageLimit = 100;
const maxLatencyMarkPageLimit = 100;
const maxCallListPageLimit = 100;
const operatorConsoleRefreshIntervalMs = 5000;
const operatorConsoleWorkboardCard = "82771d3a-de4d-4b6e-869c-328e8264d01e";
const operatorConsoleIssue = "agonza1/agentic-contact-center#62";
const defaultBrowserWebrtcBridgeTimeoutMs = 5000;
const defaultTtsIdleTimeoutMs = 30_000;
const maxVoiceSessionPlayAudioBytes = 2 * 1024 * 1024;
const supportedVoiceSessionPlayMimeTypes = new Set(["audio/l16", "audio/pcm", "audio/wav", "audio/wave", "audio/x-wav"]);
const clueConSystemUnavailableAudio = readFileSync(resolve(process.cwd(), "assets/cluecon/system-unavailable.mp3"));
const clueConVoiceOriginPhoto = readFileSync(resolve(process.cwd(), "assets/cluecon/alberto-echo-show-prototype.jpg"));

interface BrowserWebrtcBridgeRuntimeProbe {
  ok: boolean;
  status: "ready" | "degraded" | "offline";
  detail: string;
  blockers: string[];
  checkedUrl: string;
  payload?: unknown;
}

interface RtcAsrModelTarget {
  id: string;
  label: string;
  baseUrl: string;
  websocketUrl?: string;
}

function getRtcAsrModelTargets(): RtcAsrModelTarget[] {
  const configured: RtcAsrModelTarget[] = [];
  const rawTargets = process.env.RTC_ASR_MODEL_ENDPOINTS;
  if (rawTargets) {
    try {
      const parsed = JSON.parse(rawTargets) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const record = item as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id.trim() : "";
          const label = typeof record.label === "string" ? record.label.trim() : id;
          const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim().replace(/\/+$/, "") : "";
          const websocketUrl = typeof record.websocketUrl === "string" ? record.websocketUrl.trim() : "";
          if (/^[a-z0-9_-]+$/i.test(id) && /^https?:\/\//i.test(baseUrl)) {
            configured.push({
              id,
              label: label || id,
              baseUrl,
              ...(/^wss?:\/\//i.test(websocketUrl) ? { websocketUrl } : {}),
            });
          }
        }
      }
    } catch {
      // Keep the presentation usable with the primary sidecar when optional registry JSON is malformed.
    }
  }

  const primaryBaseUrl = process.env.RTC_ASR_BASE_URL?.trim().replace(/\/+$/, "");
  const primaryWebsocketUrl = process.env.RTC_ASR_WS_URL?.trim();
  if (primaryBaseUrl && /^https?:\/\//i.test(primaryBaseUrl)) {
    const existingPrimary = configured.find((target) => target.baseUrl === primaryBaseUrl);
    if (existingPrimary) {
      if (/^wss?:\/\//i.test(primaryWebsocketUrl ?? "")) existingPrimary.websocketUrl = primaryWebsocketUrl;
    } else {
      configured.unshift({
        id: "primary",
        label: "Active local model",
        baseUrl: primaryBaseUrl,
        ...(/^wss?:\/\//i.test(primaryWebsocketUrl ?? "") ? { websocketUrl: primaryWebsocketUrl } : {}),
      });
    }
  }

  return configured;
}

function getRtcAsrWebsocketUrl(target: RtcAsrModelTarget): string {
  return target.websocketUrl
    ?? `${target.baseUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:")}/v1/stt/stream`;
}

async function fetchRtcAsrJson(target: RtcAsrModelTarget, path: string, init?: RequestInit): Promise<{
  response: Response;
  payload: unknown;
  elapsedMs: number;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${target.baseUrl}${path}`, { ...init, signal: controller.signal });
    const payload = await response.json().catch(() => ({ detail: `rtc-asr returned HTTP ${response.status}` }));
    return { response, payload, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timeout);
  }
}

function getConfiguredTtsProvider(): "pocket" | "kokoro" {
  const configured = process.env.ACC_TTS_PROVIDER?.trim().toLowerCase();
  if (configured === "pocket" || configured === "kokoro") return configured;
  return process.env.POCKET_TTS_BASE_URL?.trim() ? "pocket" : "kokoro";
}

function getPocketTtsBaseUrlForSetup(): string {
  return process.env.POCKET_TTS_BASE_URL?.trim() || "http://127.0.0.1:8881";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function exportCommand(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}`;
}

function getPocketTtsSetupCommands(): string[] {
  return [
    exportCommand("ACC_TTS_PROVIDER", "pocket"),
    exportCommand("POCKET_TTS_BASE_URL", getPocketTtsBaseUrlForSetup()),
    exportCommand("POCKET_TTS_HEALTH_PATH", process.env.POCKET_TTS_HEALTH_PATH?.trim() || "/health"),
    exportCommand("POCKET_TTS_SPEECH_PATH", process.env.POCKET_TTS_SPEECH_PATH?.trim() || "/v1/audio/speech"),
    exportCommand("POCKET_TTS_MODEL", process.env.POCKET_TTS_MODEL?.trim() || "pocket-tts"),
    exportCommand("POCKET_TTS_VOICE", process.env.POCKET_TTS_VOICE?.trim() || "alloy"),
  ];
}

function getTtsSpeechTarget(
  provider: "pocket" | "kokoro" = getConfiguredTtsProvider(),
): { provider: "pocket" | "kokoro"; url: string; model: string; voice: string; responseFormat: string; contentType: string } | null {
  if (provider === "pocket") {
    const baseUrl = process.env.POCKET_TTS_BASE_URL?.trim().replace(/\/+$/, "");
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return null;
    const speechPath = (process.env.POCKET_TTS_SPEECH_PATH ?? "/v1/audio/speech").trim();
    const normalizedPath = speechPath.startsWith("/") ? speechPath : `/${speechPath}`;
    return {
      provider,
      url: `${baseUrl}${normalizedPath}`,
      model: process.env.POCKET_TTS_MODEL?.trim() || "pocket-tts",
      voice: process.env.POCKET_TTS_VOICE?.trim() || "alloy",
      responseFormat: process.env.POCKET_TTS_RESPONSE_FORMAT?.trim() || "mp3",
      contentType: "audio/mpeg",
    };
  }

  const baseUrl = process.env.KOKORO_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return null;
  const speechPath = (process.env.KOKORO_SPEECH_PATH ?? process.env.KOKORO_TTS_PATH ?? "/v1/audio/speech").trim();
  const normalizedPath = speechPath.startsWith("/") ? speechPath : `/${speechPath}`;
  return {
    provider,
    url: `${baseUrl}${normalizedPath}`,
    model: process.env.KOKORO_MODEL?.trim() || "kokoro",
    voice: process.env.KOKORO_VOICE?.trim() || "af_heart",
    responseFormat: "mp3",
    contentType: "audio/mpeg",
  };
}

export type KokoroWarmupResult =
  | { status: "warmed"; elapsedMs: number; bytes: number; text: string }
  | { status: "skipped"; reason: "not_configured" | "disabled" }
  | { status: "failed"; elapsedMs: number; error: string };

export async function warmConfiguredKokoro(): Promise<KokoroWarmupResult> {
  const target = getTtsSpeechTarget("kokoro");
  if (!target) return { status: "skipped", reason: "not_configured" };
  if (["0", "false", "off", "no"].includes((process.env.KOKORO_WARMUP ?? "").trim().toLowerCase())) {
    return { status: "skipped", reason: "disabled" };
  }

  const text = process.env.KOKORO_WARMUP_TEXT?.trim().slice(0, 80) || "Ready.";
  const configuredTimeout = Number(process.env.KOKORO_WARMUP_TIMEOUT_MS ?? "");
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(Math.max(Math.trunc(configuredTimeout), 250), 30_000)
    : 10_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: { accept: "audio/mpeg", "content-type": "application/json" },
      body: JSON.stringify({
        model: target.model,
        voice: target.voice,
        input: text,
        response_format: "mp3",
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Kokoro warm-up returned HTTP ${response.status}`);
    const bytes = (await response.arrayBuffer()).byteLength;
    if (!bytes) throw new Error("Kokoro warm-up returned no audio");
    return { status: "warmed", elapsedMs: Math.round(performance.now() - startedAt), bytes, text };
  } catch (error) {
    return {
      status: "failed",
      elapsedMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getTtsIdleTimeoutMs(provider: "kokoro" | "pocket" = getConfiguredTtsProvider()): number {
  const providerTimeout = provider === "pocket" ? process.env.POCKET_TTS_IDLE_TIMEOUT_MS : process.env.KOKORO_TTS_IDLE_TIMEOUT_MS;
  const parsed = Number(process.env.CLUECON_TTS_IDLE_TIMEOUT_MS ?? process.env.ACC_TTS_IDLE_TIMEOUT_MS ?? providerTimeout ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultTtsIdleTimeoutMs;
  return Math.min(Math.max(Math.trunc(parsed), 50), 300_000);
}

function getBrowserWebrtcBridgeBaseUrl(): string {
  return process.env.BROWSER_WEBRTC_BRIDGE_URL ?? "http://127.0.0.1:8766";
}

function getBrowserWebrtcBridgeTimeoutMs(): number {
  const parsed = Number(process.env.BROWSER_WEBRTC_BRIDGE_TIMEOUT_MS ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultBrowserWebrtcBridgeTimeoutMs;
  return Math.min(Math.max(Math.trunc(parsed), 50), 60000);
}

function getRepoHeadEvidence(): string | null {
  const envHead = process.env.ACC_GIT_HEAD;
  if (envHead && /^[a-f0-9]{40}$/i.test(envHead)) return envHead.toLowerCase();
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[a-f0-9]{40}$/i.test(head) ? head.toLowerCase() : null;
  } catch {
    return null;
  }
}
let activeAssertEvaluationSpec = cloneAssertEvaluationSpec(defaultAssertEvaluationSpec);
let activeClueConBrainBlocks = defaultClueConBrainBlocks();
let activeClueConBrainRevision = 1;
const activeClueConBrainEvidence: Array<{ id: string; type: "preview" | "apply" | "reset"; revision: number; changedFiles: string[]; createdAt: string }> = [
  { id: "brain-seed-1", type: "apply", revision: 1, changedFiles: activeClueConBrainBlocks.map((block) => block.file), createdAt: "2026-07-09T00:00:00.000Z" },
];

async function probeBrowserWebrtcBridgeRuntime(): Promise<BrowserWebrtcBridgeRuntimeProbe> {
  const bridgeUrl = `${getBrowserWebrtcBridgeBaseUrl().replace(/\/$/, "")}/health?skipAcc=1`;
  try {
    const response = await fetch(bridgeUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(getBrowserWebrtcBridgeTimeoutMs()),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("json") ? await response.json() : { detail: await response.text() };
    const payloadRecord = isRecord(payload) ? payload : {};
    const explicitOk = payloadRecord.ok !== false && payloadRecord.ready !== false;
    const status = typeof payloadRecord.status === "string" ? payloadRecord.status : response.ok && explicitOk ? "ready" : "degraded";
    const bridgeOk = response.ok && explicitOk && !["offline", "error", "failed", "degraded"].includes(status.toLowerCase());
    const blockers = Array.isArray(payloadRecord.blockers) ? payloadRecord.blockers.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
    return {
      ok: bridgeOk,
      status: bridgeOk ? "ready" : "degraded",
      detail: bridgeOk ? "Pipecat WebRTC bridge health probe passed." : typeof payloadRecord.detail === "string" ? payloadRecord.detail : `Pipecat WebRTC bridge returned HTTP ${response.status}.`,
      blockers: bridgeOk ? [] : blockers.length ? blockers : ["pipecat_webrtc_bridge_not_ready"],
      checkedUrl: bridgeUrl,
      payload,
    };
  } catch (error) {
    return {
      ok: false,
      status: "offline",
      detail: error instanceof Error ? error.message : String(error),
      blockers: ["pipecat_webrtc_bridge_unavailable"],
      checkedUrl: bridgeUrl,
    };
  }
}

function buildBrowserWebrtcReadinessPayload(bridgeRuntime: BrowserWebrtcBridgeRuntimeProbe): object {
  const contractReady = true;
  const signalingRoute = "/api/browser-webrtc/session";
  const browserWebrtcBridgeBaseUrl = getBrowserWebrtcBridgeBaseUrl();
  const browserWebrtcBridgeTimeoutMs = getBrowserWebrtcBridgeTimeoutMs();
  const liveMediaVerified = false;
  const runtimeReady = bridgeRuntime.ok;
  const blockers = runtimeReady ? ["live_webrtc_media_turn_evidence_missing"] : [...bridgeRuntime.blockers, "live_webrtc_media_turn_evidence_missing"];
  const ttsProvider = getConfiguredTtsProvider();
  const ttsLabel = ttsProvider === "pocket" ? "Pocket TTS" : "Kokoro TTS";
  const ttsSetupCommands = ttsProvider === "pocket"
    ? getPocketTtsSetupCommands()
    : [
      exportCommand("ACC_TTS_PROVIDER", "kokoro"),
      exportCommand("KOKORO_BASE_URL", "http://127.0.0.1:8880"),
    ];

  return {
    ok: contractReady && runtimeReady,
    route: "/api/browser-webrtc/readiness",
    issue: "agonza1/agentic-contact-center#213",
    issueUrl: "https://github.com/agonza1/agentic-contact-center/issues/213",
    architectureIssue: "agonza1/agentic-contact-center#222",
    architectureIssueUrl: "https://github.com/agonza1/agentic-contact-center/issues/222",
    status: runtimeReady ? "contract_ready_pending_live_media_evidence" : "realtime_contract_blocked_bridge_offline",
    intendedPath: `browser microphone -> WebRTC -> Pipecat bridge -> rtc-asr Local STT v1 -> ACC call API -> ${ttsLabel} -> WebRTC/browser playback`,
    normalOperation: {
      transport: "webrtc",
      browserCapture: "getUserMedia MediaStreamTrack",
      browserPlayback: "WebRTC remote audio track",
      mediaRecorderRequired: false,
      ffmpegRequired: false,
    },
    readiness: {
      acc: {
        status: "ready",
        evidence: "Existing call APIs, transcript, event trail, latency marks, and proof routes remain owned by ACC.",
      },
      pipecatWebrtcBridge: {
        status: runtimeReady ? "signaling_ready" : bridgeRuntime.status,
        bridgeUrl: browserWebrtcBridgeBaseUrl,
        healthUrl: bridgeRuntime.checkedUrl,
        timeoutMs: browserWebrtcBridgeTimeoutMs,
        offerRoute: `${signalingRoute} -> ${browserWebrtcBridgeBaseUrl.replace(/\/$/, "")}/api/webrtc/offer`,
        evidence: runtimeReady ? "ACC validates browser SDP offers, preserves/allocates call IDs, and the local Pipecat WebRTC bridge health probe passed." : `ACC is ready to proxy browser SDP offers, but the Pipecat WebRTC bridge is not reachable/ready: ${bridgeRuntime.detail}`,
        failClosedWhenUnavailable: true,
        blockers: bridgeRuntime.blockers,
      },
      rtcAsr: {
        status: "contract_ready",
        engine: "rtc-asr",
        contract: "local-stt.v1",
      },
      kokoro: {
        status: "contract_ready",
        engine: "kokoro",
      },
      tts: {
        status: "contract_ready",
        engine: ttsProvider,
        provider: ttsLabel,
        through: "pipecat",
        preservesAgentBrain: true,
      },
    },
    contract: {
      signalingRoute: `POST ${signalingRoute}`,
      readinessRoute: "/api/browser-webrtc/readiness",
      bridgeOfferRoute: `${browserWebrtcBridgeBaseUrl.replace(/\/$/, "")}/api/webrtc/offer`,
      bridgeTimeoutMs: browserWebrtcBridgeTimeoutMs,
      expectedOffer: {
        contentType: "application/json",
        fields: ["sdp", "type=offer", "callId?"],
      },
      expectedAnswer: {
        fields: ["sdp", "type=answer", "sessionId", "callId", "iceServers", "evidence"],
      },
      media: {
        input: "opus over WebRTC from browser microphone",
        output: "agent audio over WebRTC remote track",
        pipecatTransport: "WebRTC transport",
      },
      sidecars: {
        stt: "rtc-asr Local STT v1",
        tts: ttsProvider === "pocket" ? "Pocket" : "Kokoro",
      },
    },
    liveMedia: {
      verified: liveMediaVerified,
      status: liveMediaVerified ? "verified" : "pending_local_bridge_proof",
      requiredProof: [
        "Pipecat WebRTC bridge started at BROWSER_WEBRTC_BRIDGE_URL",
        "rtc-asr Local STT v1 sidecar captured a final browser transcript",
        `${ttsLabel} produced agent TTS audio`,
        "browser received and played a remote WebRTC audio track",
      ],
      setupCommands: [
        "export RTC_ASR_BASE_URL=http://127.0.0.1:8080",
        "export RTC_ASR_WS_URL=ws://127.0.0.1:8080/v1/stt/stream",
        "export ASR_VAD_FILTER=false",
        ...ttsSetupCommands,
        "export BROWSER_WEBRTC_BRIDGE_URL=http://127.0.0.1:8766",
        "npm run pipecat:webrtc:install",
        "npm start",
        "npm run pipecat:webrtc:check",
        "npm run pipecat:webrtc",
        "npm run browser-webrtc:check -- --url http://127.0.0.1:8026/health",
        "open http://127.0.0.1:8026/operator/console",
      ],
    },
    preservation: {
      callState: true,
      transcript: true,
      eventTrail: true,
      latencyEvidence: true,
      proofRoutes: true,
      operatorConsole: true,
      notes: "The Pipecat WebRTC bridge posts finalized caller text through /api/calls/:callId/caller-turn and attaches STT/TTS evidence to call proof artifacts.",
    },
    acceptanceProgress: [
      {
        criterion: "readiness_distinguishes_acc_pipecat_webrtc_rtc_asr_tts",
        passed: true,
        evidence: "/api/browser-webrtc/readiness and /health expose separate readiness objects.",
      },
      {
        criterion: "normal_browser_voice_does_not_require_mediarecorder_or_ffmpeg",
        passed: true,
        evidence: "The primary console browser voice action uses RTCPeerConnection/getUserMedia and the intended readiness path declares ffmpegRequired=false.",
      },
      {
        criterion: "browser_offer_answer_signaling",
        passed: true,
        evidence: "POST /api/browser-webrtc/session validates browser SDP offers, allocates or preserves an ACC call, and proxies to the Pipecat WebRTC bridge.",
      },
      {
        criterion: "live_webrtc_media_turn",
        passed: liveMediaVerified,
        evidence: `Pending local proof that a browser microphone turn reached the Pipecat WebRTC bridge, rtc-asr emitted a final transcript, ${ttsLabel} produced TTS, and the browser played the remote WebRTC audio track.`,
      },
    ],
    blockers,
    nextActions: [
      runtimeReady ? `Capture one browser voice turn with transcript, ${ttsLabel} audio, and remote playback evidence attached to this PR commit.` : `Run the Pipecat WebRTC bridge at ${browserWebrtcBridgeBaseUrl} before connecting browser voice, then confirm ${bridgeRuntime.checkedUrl} returns ok=true.`,
      "Open /operator/console, click Connect Voice, allow microphone access, and verify the remote WebRTC audio track plays agent audio.",
      "Keep issue #222 as the center: browser, fixture, tester, and SIP should become adapters over the same shared realtime Pipecat pipeline.",
    ],
    validationCommands: ["npm test", "npm run browser-webrtc:check -- --url http://127.0.0.1:8026/health"],
    relatedEvidenceRoutes: [
      { route: "/api/browser-webrtc/readiness", method: "GET", evidence: ["readiness", "contract", "blockers"] },
      { route: "/api/pipecat-media-engine/readiness", method: "GET", evidence: ["browser", "sip", "sidecars"] },
      { route: signalingRoute, method: "POST", evidence: ["callId", "sessionId", "iceServers", "stt", "tts", "latencyEvidence"] },
    ],
    contractReady,
    liveMediaVerified,
  };
}

function buildBrowserWebrtcBridgeOfferUrl(): string {
  const browserWebrtcBridgeBaseUrl = getBrowserWebrtcBridgeBaseUrl();
  return `${browserWebrtcBridgeBaseUrl.replace(/\/$/, "")}/api/webrtc/offer`;
}

function buildBrowserWebrtcBridgeSessionProofUrl(sessionId: string): string {
  const browserWebrtcBridgeBaseUrl = getBrowserWebrtcBridgeBaseUrl();
  return `${browserWebrtcBridgeBaseUrl.replace(/\/$/, "")}/api/webrtc/sessions/${encodeURIComponent(sessionId)}/proof`;
}

async function getBrowserWebrtcSessionProofFromBridge(sessionId: string): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(buildBrowserWebrtcBridgeSessionProofUrl(sessionId), {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(getBrowserWebrtcBridgeTimeoutMs()),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const responsePayload = contentType.includes("json") ? await response.json() : { detail: await response.text() };
  return { status: response.status, payload: responsePayload };
}

async function postBrowserWebrtcOfferToBridge(payload: object): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(buildBrowserWebrtcBridgeOfferUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(getBrowserWebrtcBridgeTimeoutMs()),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const responsePayload = contentType.includes("json") ? await response.json() : { detail: await response.text() };
  return { status: response.status, payload: responsePayload };
}

function buildBrowserWebrtcBridgeUnavailablePayload(error: unknown): object {
  return {
    ok: false,
    error: "pipecat_webrtc_bridge_unavailable",
    detail: error instanceof Error ? error.message : String(error),
    bridgeOfferRoute: buildBrowserWebrtcBridgeOfferUrl(),
    readiness: buildBrowserWebrtcReadinessPayload({
      ok: false,
      status: "offline",
      detail: "Offer proxy failed before bridge readiness could be confirmed.",
      blockers: ["pipecat_webrtc_bridge_unavailable"],
      checkedUrl: `${getBrowserWebrtcBridgeBaseUrl().replace(/\/$/, "")}/health?skipAcc=1`,
    }),
  };
}

const operatorSteerActions: OperatorSteerAction[] = [
  "approve_offer",
  "approve_retention_review",
  "deny_offer",
  "escalate_to_human",
  "transfer",
  "takeover",
  "end_call",
  "pause",
  "resume",
  "goto_slide",
  "ask_operator",
  "arm_fallback",
  "disarm_fallback",
];

const operatorActionCatalog: Array<{
  action: OperatorSteerAction;
  method: "POST";
  requiresPendingCall: boolean;
  requiresReason: boolean;
  postTemplate: string;
  bodyTemplate: { action: OperatorSteerAction; reason?: string };
  operatorOutcome: "hold" | "resume" | "fallback" | "handoff" | "close";
  commandExamples: string[];
}> = [
  {
    action: "pause",
    method: "POST",
    requiresPendingCall: false,
    requiresReason: false,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "pause" },
    operatorOutcome: "hold",
    commandExamples: ["/operator pause", "/steer pause"],
  },
  {
    action: "resume",
    method: "POST",
    requiresPendingCall: true,
    requiresReason: false,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "resume" },
    operatorOutcome: "resume",
    commandExamples: ["/operator resume", "/steer resume"],
  },
  {
    action: "approve_offer",
    method: "POST",
    requiresPendingCall: true,
    requiresReason: false,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "approve_offer" },
    operatorOutcome: "resume",
    commandExamples: ["/operator approve-offer", "/steer approve offer"],
  },
  {
    action: "approve_retention_review",
    method: "POST",
    requiresPendingCall: true,
    requiresReason: false,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "approve_retention_review" },
    operatorOutcome: "resume",
    commandExamples: ["/operator approve-retention-review", "/steer approve retention review"],
  },
  {
    action: "deny_offer",
    method: "POST",
    requiresPendingCall: true,
    requiresReason: false,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "deny_offer" },
    operatorOutcome: "resume",
    commandExamples: ["/operator deny-offer", "/steer deny offer"],
  },
  {
    action: "escalate_to_human",
    method: "POST",
    requiresPendingCall: true,
    requiresReason: false,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "escalate_to_human" },
    operatorOutcome: "handoff",
    commandExamples: ["/operator escalate", "/steer escalate-to-human"],
  },
  {
    action: "transfer",
    method: "POST",
    requiresPendingCall: false,
    requiresReason: false,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "transfer" },
    operatorOutcome: "handoff",
    commandExamples: ["/operator transfer", "/steer transfer"],
  },
  {
    action: "takeover",
    method: "POST",
    requiresPendingCall: false,
    requiresReason: false,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "takeover" },
    operatorOutcome: "handoff",
    commandExamples: ["/operator takeover", "/steer barge-in"],
  },
  {
    action: "end_call",
    method: "POST",
    requiresPendingCall: false,
    requiresReason: false,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "end_call" },
    operatorOutcome: "close",
    commandExamples: ["/operator end-call", "/steer end call"],
  },
  {
    action: "goto_slide",
    method: "POST",
    requiresPendingCall: false,
    requiresReason: true,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "goto_slide", reason: "<slide-or-step>" },
    operatorOutcome: "hold",
    commandExamples: ["/operator goto-slide retention-safe-mode", "/steer goto slide policy-hold"],
  },
  {
    action: "ask_operator",
    method: "POST",
    requiresPendingCall: false,
    requiresReason: true,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "ask_operator", reason: "<question>" },
    operatorOutcome: "hold",
    commandExamples: ["/operator ask verify latency budget", "/steer ask confirm safe offer copy"],
  },
  {
    action: "arm_fallback",
    method: "POST",
    requiresPendingCall: false,
    requiresReason: true,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "arm_fallback", reason: "<manual-fallback-reason>" },
    operatorOutcome: "fallback",
    commandExamples: ["/operator arm-fallback audio degraded", "/steer arm fallback tool timeout"],
  },
  {
    action: "disarm_fallback",
    method: "POST",
    requiresPendingCall: false,
    requiresReason: false,
    postTemplate: "/api/calls/{callId}/operator-steer",
    bodyTemplate: { action: "disarm_fallback" },
    operatorOutcome: "hold",
    commandExamples: ["/operator disarm-fallback", "/steer disarm fallback"],
  },
];

function writeJson(response: ServerResponse, statusCode: number, payload: object): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload, null, 2));
}

function writeHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
}

function buildReliabilityGuidePayload(config: PocConfig): object {
  return {
    ok: true,
    route: "/reliability",
    apiRoute: "/api/reliability",
    issue: "agonza1/agentic-contact-center#307",
    activeMode: config.mode,
    goldenScenario: "cancellation-rescue",
    status: {
      scriptedFixture: "ready",
      browserWebRtc: "optional_live_sidecars_required",
      sipVerto: "accepted_strict_local_proof",
      caeAssertHandoff: "generated_request_artifact_ready",
      production: "blocked_not_implemented",
    },
    workflow: [
      {
        step: "choose_target_mode",
        label: "Choose fixture, browser WebRTC, or SIP/Verto",
        command: "npm run reliability:lab",
        evidence: "/api/pipecat-media-engine/readiness",
      },
      {
        step: "run_cancellation_rescue",
        label: "Run the controlled cancellation-rescue candidate",
        command: "npm run proof",
        evidence: "artifacts/demo-proof-latest.json",
      },
      {
        step: "collect_evidence",
        label: "Capture transcript, events, latency, final state, media, and provenance",
        command: "npm run proof:bundle",
        evidence: "artifacts/agentic-call-center-demo/",
      },
      {
        step: "handoff_to_cae",
        label: "Generate the CAE-compatible AssertRunCreateRequest",
        command: "npm run cae:assert:handoff",
        evidence: "artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json",
      },
      {
        step: "compare_verdicts",
        label: "Compare unsafe baseline against controlled candidate in CAE/ASSERT",
        command: null,
        evidence: "ConversationAgentEvals owns run, report, and comparison UX",
      },
    ],
    readinessRoutes: {
      health: "/health",
      browserWebRtc: "/api/browser-webrtc/readiness",
      pipecatMediaEngine: "/api/pipecat-media-engine/readiness",
      operatorConsole: "/operator/console",
    },
  };
}

function buildReliabilityGuideHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reliability Lab</title>
  <style>
    :root { --bg: #f5f7f8; --panel: #ffffff; --text: #18222d; --muted: #647182; --line: #d7dee7; --accent: #0f766e; --warn: #9a5b13; --ok: #126b3e; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 22px; border-bottom: 1px solid var(--line); background: #fff; }
    h1 { margin: 0; font-size: 20px; letter-spacing: 0; }
    h2 { margin: 0; font-size: 15px; letter-spacing: 0; }
    main { display: grid; gap: 16px; max-width: 1100px; margin: 0 auto; padding: 18px; }
    a { color: var(--accent); font-weight: 700; text-decoration: none; }
    code { padding: 2px 5px; border-radius: 5px; background: #eef2f5; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
    .button { display: inline-flex; align-items: center; min-height: 36px; padding: 0 10px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--text); font-size: 13px; }
    .button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .band { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
    .metric { display: grid; gap: 4px; min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
    .metric span { color: var(--muted); font-size: 12px; }
    .metric strong { overflow-wrap: anywhere; }
    .workflow { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
    .workflow li { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 10px; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
    .step { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: #e8f5f2; color: var(--accent); font-weight: 800; }
    .meta { color: var(--muted); font-size: 13px; }
    @media (max-width: 720px) { header { align-items: flex-start; flex-direction: column; } main { padding: 12px; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Reliability Lab</h1>
      <div class="meta">Cancellation-rescue guide and integration surface</div>
    </div>
    <nav class="toolbar" aria-label="Reliability lab navigation">
      <a class="button primary" href="/operator/console">Operator Console</a>
      <a class="button" href="/api/reliability">API</a>
      <a class="button" href="/health">Health</a>
    </nav>
  </header>
  <main>
    <section class="band" aria-labelledby="readiness-title">
      <h2 id="readiness-title">Readiness</h2>
      <div class="grid">
        <div class="metric"><span>Scripted fixture</span><strong>ready</strong></div>
        <div class="metric"><span>Browser WebRTC</span><strong>optional sidecars required</strong><a href="/api/browser-webrtc/readiness">readiness</a></div>
        <div class="metric"><span>SIP/Verto</span><strong>accepted strict local proof</strong><a href="/api/pipecat-media-engine/readiness">media engine</a></div>
        <div class="metric"><span>CAE/ASSERT</span><strong>handoff artifact ready</strong></div>
      </div>
    </section>
    <section class="band" aria-labelledby="workflow-title">
      <h2 id="workflow-title">Golden Workflow</h2>
      <ol class="workflow">
        <li><span class="step">1</span><div><strong>Choose target mode</strong><div class="meta"><code>npm run reliability:lab</code> reports ready, blocked, configured, and not-required states.</div></div></li>
        <li><span class="step">2</span><div><strong>Run cancellation-rescue</strong><div class="meta"><code>npm run proof</code> produces deterministic controlled-candidate evidence.</div></div></li>
        <li><span class="step">3</span><div><strong>Collect proof bundle</strong><div class="meta"><code>npm run proof:bundle</code> writes transcript, event, latency, final-state, media, and provenance links.</div></div></li>
        <li><span class="step">4</span><div><strong>Generate CAE handoff</strong><div class="meta"><code>npm run cae:assert:handoff</code> creates the CAE-compatible request while CAE owns run/report UX.</div></div></li>
        <li><span class="step">5</span><div><strong>Compare verdicts</strong><div class="meta">Unsafe baseline and controlled candidate remain labeled; deterministic checks and ASSERT judgment stay separate.</div></div></li>
      </ol>
    </section>
  </main>
</body>
</html>`;
}

function buildOperatorConsoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Operator Console</title>
  <style>
    :root {
      --bg: #f4f6f8;
      --panel: #ffffff;
      --panel-soft: #f8fafb;
      --text: #17202a;
      --muted: #667085;
      --line: #d8dee6;
      --line-strong: #b9c3d0;
      --accent: #0f766e;
      --accent-soft: #e8f5f2;
      --warning: #a15c07;
      --warning-soft: #fff7e8;
      --danger: #b42318;
      --danger-soft: #fff1f0;
      --ok: #136f3f;
      --ok-soft: #ecfdf3;
      --shadow: 0 12px 28px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 72px; padding: 14px 24px; border-bottom: 1px solid var(--line); background: rgba(255, 255, 255, 0.96); backdrop-filter: blur(12px); }
    h1 { margin: 0; font-size: 18px; font-weight: 750; letter-spacing: 0; }
    h2, h3 { letter-spacing: 0; }
    main { display: grid; grid-template-columns: minmax(320px, 380px) minmax(0, 1fr); gap: 18px; padding: 18px; align-items: start; }
    button, input, select, textarea { font: inherit; }
    button { min-height: 36px; border: 1px solid var(--line-strong); border-radius: 6px; background: #fff; color: var(--text); cursor: pointer; font-weight: 650; }
    button:hover:not(:disabled) { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.danger { color: var(--danger); border-color: #f0b8b2; background: var(--danger-soft); }
    button:disabled { cursor: not-allowed; opacity: 0.45; }
    .brand { display: grid; gap: 2px; min-width: 220px; }
    .brand-kicker { color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
    .toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .toolbar-menu { position: relative; }
    .toolbar-menu summary { display: inline-flex; align-items: center; min-height: 36px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 6px; background: #fff; cursor: pointer; font-size: 13px; font-weight: 700; list-style: none; }
    .toolbar-menu summary::-webkit-details-marker { display: none; }
    .menu-panel { position: absolute; right: 0; z-index: 5; display: grid; gap: 6px; width: 190px; margin-top: 6px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: #fff; box-shadow: var(--shadow); }
    .toolbar-menu:not([open]) > .menu-panel { display: none; }
    .menu-panel button, .menu-panel .nav-link { width: 100%; justify-content: flex-start; }
    .nav-link { display: inline-flex; align-items: center; min-height: 36px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 6px; background: #fff; color: var(--text); font-size: 13px; font-weight: 700; text-decoration: none; }
    .nav-link:hover { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; box-shadow: var(--shadow); }
    .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--panel-soft); }
    .panel h2 { margin: 0; font-size: 14px; font-weight: 750; }
    .queue-count { color: var(--muted); font-size: 12px; font-weight: 700; }
    .filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 12px 14px; background: #fff; }
    .filters-primary { grid-template-columns: auto minmax(0, 1fr); border-bottom: 1px solid var(--line); }
    .filter-drawer { border-bottom: 1px solid var(--line); background: var(--panel-soft); }
    .filter-drawer summary { display: flex; align-items: center; min-height: 42px; padding: 0 14px; cursor: pointer; color: var(--muted); font-size: 12px; font-weight: 750; user-select: none; }
    .filter-drawer summary:hover { color: var(--text); }
    .filter-drawer[open] summary { border-bottom: 1px solid var(--line); color: var(--text); }
    .filters-advanced { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .filter-drawer:not([open]) > .filters-advanced { display: none; }
    .filter-toggle { display: inline-flex; align-items: center; gap: 7px; min-height: 36px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); font-size: 12px; white-space: nowrap; background: var(--panel-soft); }
    .status, .meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .status { display: inline-flex; align-items: center; min-height: 28px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-soft); font-weight: 650; }
    .call-list { display: grid; }
    .call-item { width: 100%; display: grid; gap: 8px; padding: 13px 14px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; text-align: left; background: #fff; font-weight: 500; }
    .call-item[aria-selected="true"] { border-left: 4px solid var(--accent); background: var(--accent-soft); padding-left: 10px; }
    .call-top, .call-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .call-id { font-weight: 760; color: var(--text); }
    .call-state { color: var(--muted); font-size: 12px; text-transform: capitalize; }
    .progress { height: 6px; overflow: hidden; border-radius: 999px; background: #e6ebf1; }
    .progress span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
    .detail { display: grid; gap: 14px; padding: 14px; background: #fbfcfd; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .metric { border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: #fff; min-width: 0; }
    .metric .meta { display: block; line-height: 1.35; }
    .metric strong { display: block; font-size: 17px; line-height: 1.25; overflow-wrap: anywhere; }
    .metric.compact strong { font-size: 14px; }
    .workbench { display: grid; grid-template-columns: minmax(260px, 0.85fr) minmax(360px, 1.15fr); gap: 14px; align-items: start; }
    .workbench.single { grid-template-columns: minmax(0, 1fr); }
    .stack { display: grid; gap: 10px; width: 100%; min-width: 0; }
    .section { display: grid; gap: 10px; border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fff; }
    .section-drawer { border: 1px solid var(--line); border-radius: 8px; background: #fff; overflow: hidden; }
    .section-drawer > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; padding: 0 12px; cursor: pointer; color: var(--text); font-size: 13px; font-weight: 760; list-style: none; }
    .section-drawer > summary::-webkit-details-marker { display: none; }
    .section-drawer > summary::after { content: "+"; color: var(--muted); font-size: 18px; font-weight: 500; }
    .section-drawer[open] > summary { border-bottom: 1px solid var(--line); }
    .section-drawer[open] > summary::after { content: "−"; }
    .drawer-content { display: grid; gap: 10px; padding: 12px; }
    .section-drawer:not([open]) > .drawer-content { display: none; }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0; font-size: 13px; font-weight: 760; color: var(--text); }
    .proof-panel { display: grid; gap: 10px; border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fff; }
    .proof-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .proof-header h3 { margin: 0; font-size: 15px; }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; }
    .badge { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 8px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--muted); font-size: 12px; font-weight: 700; text-decoration: none; }
    .badge.live, .badge.ok { color: var(--ok); border-color: #9bd7b6; background: var(--ok-soft); }
    .badge.warn { color: var(--warning); border-color: #f2c479; background: var(--warning-soft); }
    .proof-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px; }
    .caveats { margin: 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
    .evidence { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
    .evidence .metric a, .proof-panel .metric a { color: var(--accent); font-weight: 750; text-decoration: none; display: block; margin-top: 3px; }
    .actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .scripted-turns { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
    .scripted-turns button { text-align: left; padding: 8px; }
    .transcript { display: grid; gap: 8px; max-height: 360px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: var(--panel-soft); }
    .turn { display: grid; gap: 3px; max-width: 82%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
    .turn.caller { justify-self: start; border-left: 4px solid var(--accent); }
    .turn.agent, .turn.operator { justify-self: end; border-right: 4px solid var(--line-strong); }
    .turn b { font-size: 11px; color: var(--muted); text-transform: uppercase; }
    form { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    textarea { min-height: 72px; resize: vertical; border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
    input, select { min-height: 36px; border: 1px solid var(--line); border-radius: 6px; padding: 8px; width: 100%; background: #fff; color: var(--text); }
    input[type="checkbox"] { min-height: auto; width: 16px; height: 16px; padding: 0; }
    @media (max-width: 1120px) { .workbench { grid-template-columns: 1fr; } .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 860px) { header, .toolbar { align-items: stretch; } header { position: static; flex-direction: column; } main { grid-template-columns: 1fr; padding: 12px; } .grid, .summary-grid, .filters, .filters-primary, .filters-advanced { grid-template-columns: 1fr; } form { grid-template-columns: 1fr; } .filter-toggle { width: 100%; } .turn { max-width: 100%; } }
  </style>
</head>
<body>
  <header>
    <div class="brand"><span class="brand-kicker">Agentic Contact Center</span><h1>Operator Console</h1></div>
    <div class="toolbar"><span class="status" id="status">Loading</span><button type="button" class="primary" id="run-demo-flow">Run Demo</button><details class="toolbar-menu"><summary>More</summary><div class="menu-panel"><button type="button" id="start-demo">Start empty call</button><a class="nav-link" href="/assert/full">Evidence viewer</a><a class="nav-link" href="/assert">ACC artifacts</a><a class="nav-link" href="/assert/spec">Eval spec</a></div></details></div>
  </header>
  <main>
    <section class="panel" aria-label="Live calls"><div class="panel-header"><h2>Live Calls</h2><span class="queue-count" id="queue-count">0 queued</span></div><div class="filters filters-primary"><label class="filter-toggle"><input type="checkbox" id="attention-filter">Needs attention</label><input id="transcript-filter" aria-label="Search calls" placeholder="Search calls"></div><details class="filter-drawer"><summary>Filters</summary><div class="filters filters-advanced"><label class="filter-toggle"><input type="checkbox" id="latency-over-budget-filter">Over-budget latency</label><select id="flow-filter" aria-label="Flow state filter"><option value="">All flow states</option><option value="call_started">Call Started</option><option value="greet">Greet</option><option value="diagnose">Diagnose</option><option value="policy_hold">Policy Hold</option><option value="operator_steer">Operator Steer</option><option value="steered_response">Steered Response</option><option value="wrap">Wrap</option></select><select id="fallback-filter" aria-label="Fallback mode filter"><option value="">All fallback modes</option><option value="tool_timeout">Tool Timeout</option><option value="runtime_failure">Runtime Failure</option></select><select id="fallback-source-filter" aria-label="Fallback source filter"><option value="">All fallback sources</option><option value="tool_timeout_fail_closed">Tool Timeout Source</option><option value="pipecat_runtime_failure_fail_closed">Runtime Failure Source</option></select><input id="fallback-reason-filter" aria-label="Fallback reason filter" placeholder="Fallback reason"><select id="tool-filter" aria-label="Active tool filter"><option value="">All active tools</option><option value="get_current_slide">Get Current Slide</option><option value="goto_slide">Go To Slide</option><option value="pause_presentation">Pause Presentation</option><option value="ask_operator">Ask Operator</option></select><select id="script-completed-filter" aria-label="Script status filter"><option value="">All script states</option><option value="false">In progress</option><option value="true">Complete</option></select><select id="script-progress-filter" aria-label="Script minimum progress filter"><option value="">Any min progress</option><option value="25">25%+ scripted</option><option value="50">50%+ scripted</option><option value="75">75%+ scripted</option><option value="100">100% scripted</option></select><select id="script-max-progress-filter" aria-label="Script maximum progress filter"><option value="">Any max progress</option><option value="0">0% or less scripted</option><option value="25">25% or less scripted</option><option value="50">50% or less scripted</option><option value="75">75% or less scripted</option></select><button type="button" id="clear-filters">Clear filters</button></div></details><div class="call-list" id="calls"></div></section>
    <section class="panel" aria-label="Selected call"><div class="panel-header"><h2 id="selected-title">Select a call</h2><span class="queue-count">Supervisor workbench</span></div><div class="detail" id="detail"></div></section>
  </main>
  <script>
    const state = { calls: [], selectedCallId: null, actionMetadata: {}, refreshTimer: null, refreshIntervalMs: ${operatorConsoleRefreshIntervalMs}, voiceWs: null, voicePeer: null, voiceRemoteAudio: null, voiceRemoteTrackReceived: false, voiceRemoteAudioStarted: false, voiceLiveAudioVerified: false, voiceLiveTurnVerified: false, voiceAudioWatchdog: null, voiceSessionProofTimer: null, voiceLastProofTurnCount: 0, voiceBridgeEvidence: null, voiceBridgeAnswer: null, voiceSessionId: null, voiceConnecting: false, voiceRecording: null, voiceStream: null, voiceChunks: [], voiceCallId: null, voiceMuted: true, voiceProcessing: false, voiceSegmentMs: 9000, voiceStatus: "Voice disconnected", voiceBridgeTimer: null, voiceBridgeIntervalMs: 5000, voiceBridge: { status: "unknown", detail: "Not checked", checkedAt: null, probing: false }, transcriptCallId: null, transcriptScrollTop: 0, transcriptStickToBottom: true };
    const repoHeadEvidence = ${JSON.stringify(getRepoHeadEvidence())};
    const advancedActions = ["escalate_to_human", "arm_fallback", "disarm_fallback"];
    const liveProofStatuses = ["not_review_ready", "ready_with_rtc_asr_blocker", "ready_for_conversation_agent_evals"];
    const labels = { pause: "Pause", resume: "Resume", approve_offer: "Approve Offer", approve_retention_review: "Approve Retention Review", deny_offer: "Deny", takeover: "Take Over", escalate_to_human: "Escalate", transfer: "Transfer", end_call: "End Call", goto_slide: "Go To Slide", ask_operator: "Ask Operator", arm_fallback: "Arm Fallback", disarm_fallback: "Disarm Fallback" };
    function setStatus(text) { document.getElementById("status").textContent = text; }
    function escapeHtml(value) { return String(value).replace(/[&<>\"]/g, function(char) { if (char === "&") return "&amp;"; if (char === "<") return "&lt;"; if (char === ">") return "&gt;"; return "&quot;"; }); }
    function humanLabel(value) { return String(value || "none").replace(/_/g, " "); }
    function linkHtml(href, text) { return href ? '<a href="' + escapeHtml(href) + '">' + escapeHtml(text) + '</a>' : '<span class="meta">' + escapeHtml(text) + ': unavailable</span>'; }
    function pathHtml(path, label) { return path ? '<span class="meta">' + escapeHtml(label) + ': ' + escapeHtml(path) + '</span>' : '<span class="meta">' + escapeHtml(label) + ': not attached</span>'; }
    function selectedCall() { return state.calls.find(function(call) { return call.session.callId === state.selectedCallId; }) || state.calls[0] || null; }
    function operatorConsoleQuery() {
      const params = new URLSearchParams({ sort: "attentionStartedAt", order: "asc", limit: "25" });
      if (document.getElementById("attention-filter").checked) params.set("attentionRequired", "true");
      if (document.getElementById("latency-over-budget-filter").checked) params.set("latencyOverBudget", "true");
      const flowState = document.getElementById("flow-filter").value;
      if (flowState) params.set("flowState", flowState);
      const fallbackMode = document.getElementById("fallback-filter").value;
      if (fallbackMode) params.set("fallbackMode", fallbackMode);
      const fallbackSource = document.getElementById("fallback-source-filter").value;
      if (fallbackSource) params.set("fallbackSource", fallbackSource);
      const fallbackReason = document.getElementById("fallback-reason-filter").value.trim();
      if (fallbackReason) params.set("fallbackReason", fallbackReason);
      const activeTool = document.getElementById("tool-filter").value;
      if (activeTool) params.set("pipecatActiveTool", activeTool);
      const scriptCompleted = document.getElementById("script-completed-filter").value;
      if (scriptCompleted) params.set("scriptCompleted", scriptCompleted);
      const scriptProgress = document.getElementById("script-progress-filter").value;
      if (scriptProgress) params.set("minScriptProgressPct", scriptProgress);
      const scriptMaxProgress = document.getElementById("script-max-progress-filter").value;
      if (scriptMaxProgress) params.set("maxScriptProgressPct", scriptMaxProgress);
      const transcriptText = document.getElementById("transcript-filter").value.trim();
      if (transcriptText) params.set("transcriptText", transcriptText);
      return params.toString();
    }
    function callActionMetadata(call, action) {
      const actionDetail = (call.actionState.actionDetails || []).find(function(entry) { return entry.action === action; });
      if (actionDetail) return actionDetail;
      const catalogMetadata = state.actionMetadata[action] || {};
      const confirmation = (call.actionState.requiresConfirmationActions || []).find(function(entry) { return entry.action === action; });
      const reason = (call.actionState.requiresReasonActions || []).find(function(entry) { return entry.action === action; });
      return Object.assign({}, catalogMetadata, {
        confirmationRequired: Boolean(confirmation),
        confirmationMessage: confirmation ? confirmation.confirmationMessage : null,
        requiresReason: Boolean(reason),
        reasonPrompt: reason ? reason.reasonPrompt : null,
      });
    }
    function hasDirtyDetailInput() {
      if (state.voiceConnecting || state.voiceProcessing || !state.voiceMuted || (state.voiceRecording && state.voiceRecording.state === "recording")) return true;
      return ["caller-turn", "note", "disposition"].some(function(id) {
        const input = document.getElementById(id);
        return input && (document.activeElement === input || input.value.trim());
      });
    }
    function captureTranscriptScroll() {
      const transcript = document.querySelector("#detail .transcript");
      if (!transcript) return;
      state.transcriptScrollTop = transcript.scrollTop;
      state.transcriptStickToBottom = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 24;
    }
    function restoreTranscriptScroll(callId) {
      const transcript = document.querySelector("#detail .transcript");
      if (!transcript) return;
      state.transcriptCallId = callId;
      const maxScroll = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
      transcript.scrollTop = state.transcriptStickToBottom ? maxScroll : Math.min(state.transcriptScrollTop || 0, maxScroll);
      transcript.addEventListener("scroll", function() {
        state.transcriptScrollTop = transcript.scrollTop;
        state.transcriptStickToBottom = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 24;
      });
    }
    async function refresh(options) {
      if (options && options.auto && hasDirtyDetailInput()) { setStatus("Refresh paused while editing"); return; }
      setStatus("Refreshing");
      const response = await fetch("/api/operator/console?" + operatorConsoleQuery());
      if (!response.ok) throw new Error("console_fetch_failed");
      const payload = await response.json();
      state.actionMetadata = Object.fromEntries(payload.controls.actions.map(function(entry) { return [entry.action, entry]; }));
      state.scriptedCallerTurns = payload.controls.scriptedCallerTurns || [];
      state.refreshIntervalMs = payload.refreshIntervalMs || 5000;
      state.calls = payload.calls.items;
      if (!state.calls.some(function(call) { return call.session.callId === state.selectedCallId; })) state.selectedCallId = state.calls[0] ? state.calls[0].session.callId : null;
      render();
      setStatus(new Date().toLocaleTimeString());
      scheduleRefresh();
    }
    async function postAction(action, reason, confirmed) {
      const call = selectedCall();
      if (!call) return;
      const response = await fetch("/api/operator/console/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: call.session.callId, action: action, reason: reason || undefined, confirmationAcknowledged: confirmed || undefined }) });
      if (!response.ok) { const payload = await response.json().catch(function() { return {}; }); setStatus(payload.error || "Action failed"); return; }
      await refresh();
    }
    async function startDemoCall() {
      setStatus("Starting demo call");
      const response = await fetch("/api/demo/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openclawSessionLabel: "operator-console/manual" }) });
      if (!response.ok) { const payload = await response.json().catch(function() { return {}; }); setStatus(payload.error || "Start failed"); return; }
      const payload = await response.json();
      state.selectedCallId = payload.session.callId;
      await refresh();
    }
    async function runDemoFlow() {
      setStatus("Running full demo flow");
      const response = await fetch("/api/demo/run-end-to-end", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openclawSessionLabel: "operator-console/end-to-end" }) });
      if (!response.ok) { const payload = await response.json().catch(function() { return {}; }); setStatus(payload.error || "Demo flow failed"); return; }
      const payload = await response.json();
      state.selectedCallId = payload.call.session.callId;
      await refresh();
      setStatus("Demo flow complete");
    }
    async function recordCallerTurn(event) {
      event.preventDefault();
      const call = selectedCall();
      const input = document.getElementById("caller-turn");
      if (!call || !input.value.trim()) return;
      await postCallerTurn(call.session.callId, input.value.trim());
      input.value = "";
      await refresh();
    }
    async function postCallerTurn(callId, text) {
      const response = await fetch("/api/calls/" + callId + "/caller-turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text }) });
      if (!response.ok) { const payload = await response.json().catch(function() { return {}; }); const message = payload.error || "Caller turn failed"; setStatus(message); throw new Error(message); }
    }
    function browserWebrtcReadinessUrl() { return "/api/browser-webrtc/readiness"; }
    function voiceBridgeStatusClass() {
      if (state.voiceBridge.status === "running") return "badge ok";
      if (state.voiceBridge.status === "connected") return "badge";
      if (state.voiceBridge.status === "checking") return "badge";
      if (state.voiceBridge.status === "degraded") return "badge warn";
      if (state.voiceBridge.status === "offline") return "badge warn";
      return "badge";
    }
    function voiceBridgeStatusLabel() {
      if (state.voiceBridge.status === "running") return "Live audio verified";
      if (state.voiceBridge.status === "connected") return "Signaling connected";
      if (state.voiceBridge.status === "checking") return "Checking WebRTC";
      if (state.voiceBridge.status === "degraded") return "WebRTC blocked";
      if (state.voiceBridge.status === "offline") return "WebRTC offline";
      return "WebRTC unknown";
    }
    function formatVoiceBridgeReadyDetail(payload) {
      const blockers = Array.isArray(payload.blockers) ? payload.blockers.filter(Boolean) : [];
      const detail = payload.status || "Browser WebRTC readiness is not available.";
      const nextAction = Array.isArray(payload.nextActions) && payload.nextActions.length ? " Next: " + payload.nextActions[0] : "";
      const blockerDetail = blockers.length ? " Blockers: " + blockers.slice(0, 3).join("; ") + (blockers.length > 3 ? "; +" + (blockers.length - 3) + " more" : "") + "." : "";
      return detail + blockerDetail + nextAction;
    }
    function formatVoiceBridgeEngineEvidence(payload) {
      const stt = payload && payload.stt ? payload.stt : (payload && payload.rtcAsr ? payload.rtcAsr : {});
      const tts = payload && payload.tts ? payload.tts : (payload && payload.kokoro ? payload.kokoro : {});
      const sttEvidence = stt.engine ? stt.engine + (stt.model && stt.model !== "unknown" ? " " + stt.model : "") : "rtc-asr";
      const ttsEvidence = tts.engine ? tts.engine + (tts.voice ? " " + tts.voice : "") : "Kokoro";
      return "STT " + sttEvidence + "; TTS " + ttsEvidence;
    }
    function updateVoiceBridgeStatus(status, detail) {
      state.voiceBridge.status = status;
      state.voiceBridge.detail = detail;
      state.voiceBridge.checkedAt = new Date().toLocaleTimeString();
      const badge = document.getElementById("voice-bridge-status");
      const detailNode = document.getElementById("voice-bridge-detail");
      if (badge) {
        badge.className = voiceBridgeStatusClass();
        badge.textContent = voiceBridgeStatusLabel();
      }
      if (detailNode) {
        detailNode.textContent = state.voiceBridge.detail + " | last check " + state.voiceBridge.checkedAt;
      }
    }
    function hasVerifiedLiveVoicePlayback() {
      const pc = state.voicePeer;
      const audio = state.voiceRemoteAudio;
      const peerActive = Boolean(pc && !["closed", "failed"].includes(pc.connectionState));
      const playbackProgressed = Boolean(audio && audio.currentTime > 0 && !audio.paused);
      return peerActive && state.voiceRemoteTrackReceived && (state.voiceLiveAudioVerified || state.voiceRemoteAudioStarted || playbackProgressed);
    }
    function hasVerifiedLiveVoiceSession() {
      const pc = state.voicePeer;
      const peerActive = Boolean(pc && !["closed", "failed"].includes(pc.connectionState));
      return peerActive && (hasVerifiedLiveVoicePlayback() || state.voiceLiveTurnVerified);
    }
    async function probeVoiceBridge(options) {
      if (state.voiceBridge.probing) return;
      const now = Date.now();
      if (!(options && options.force) && state.voiceBridge.lastProbeAt && now - state.voiceBridge.lastProbeAt < 10000) return;
      state.voiceBridge.probing = true;
      state.voiceBridge.lastProbeAt = now;
      if (!hasVerifiedLiveVoicePlayback()) {
        updateVoiceBridgeStatus("checking", "Checking " + browserWebrtcReadinessUrl());
      }
      try {
        const response = await fetch(browserWebrtcReadinessUrl());
        const payload = await response.json();
        state.voiceBridge.probing = false;
        if (hasVerifiedLiveVoiceSession()) {
          updateVoiceBridgeStatus("running", "Live browser WebRTC audio is playing; readiness polling preserved the active session state. " + formatVoiceBridgeEngineEvidence(payload.readiness || {}));
          return;
        }
        if (response.ok && payload.ok && payload.liveMediaVerified === true) {
          updateVoiceBridgeStatus("running", "Browser WebRTC live media is verified (" + formatVoiceBridgeEngineEvidence(payload.readiness || {}) + ")");
          return;
        }
        if (response.ok && payload.ok) {
          updateVoiceBridgeStatus("degraded", formatVoiceBridgeReadyDetail(payload));
          return;
        }
        updateVoiceBridgeStatus("degraded", formatVoiceBridgeReadyDetail(payload));
      } catch (error) {
        state.voiceBridge.probing = false;
        if (hasVerifiedLiveVoiceSession()) {
          updateVoiceBridgeStatus("running", "Live browser WebRTC audio is playing; readiness polling failed but the active session is still playing.");
          return;
        }
        updateVoiceBridgeStatus("offline", "Cannot read " + browserWebrtcReadinessUrl() + ".");
      }
    }
    function startVoiceBridgeProbing() {
      if (state.voiceBridgeTimer) return;
      function tick() {
        state.voiceBridgeTimer = null;
        probeVoiceBridge({ force: true })
          .catch(function(error) { setStatus(error.message); })
          .finally(function() {
            state.voiceBridgeTimer = window.setTimeout(tick, state.voiceBridgeIntervalMs);
          });
      }
      tick();
    }
    function playAgentAudio(agentAudio, onEnded) {
      if (!agentAudio || !agentAudio.base64) { if (onEnded) onEnded(); return; }
      const audio = new Audio("data:" + (agentAudio.contentType || "audio/wav") + ";base64," + agentAudio.base64);
      audio.onended = function() { if (onEnded) onEnded(); };
      audio.onerror = function() { if (onEnded) onEnded(); };
      audio.play().catch(function(error) { setStatus("Agent audio blocked: " + error.message); if (onEnded) onEnded(); });
    }
    function stopVoiceSegment() {
      state.voiceRecording = null;
    }
    function stopVoiceStream() {
      stopVoiceSegment();
      if (state.voiceAudioWatchdog) {
        window.clearTimeout(state.voiceAudioWatchdog);
        state.voiceAudioWatchdog = null;
      }
      if (state.voiceSessionProofTimer) {
        window.clearTimeout(state.voiceSessionProofTimer);
        state.voiceSessionProofTimer = null;
      }
      if (state.voicePeer) {
        try { state.voicePeer.close(); } catch (error) {}
        state.voicePeer = null;
      }
      if (state.voiceRemoteAudio) {
        state.voiceRemoteAudio.pause();
        state.voiceRemoteAudio.srcObject = null;
        state.voiceRemoteAudio = null;
      }
      state.voiceBridgeEvidence = null;
      state.voiceBridgeAnswer = null;
      state.voiceSessionId = null;
      state.voiceLastProofTurnCount = 0;
      state.voiceRemoteTrackReceived = false;
      state.voiceRemoteAudioStarted = false;
      state.voiceLiveAudioVerified = false;
      state.voiceLiveTurnVerified = false;
      if (state.voiceStream) {
        state.voiceStream.getTracks().forEach(function(track) { track.stop(); });
        state.voiceStream = null;
      }
      state.voiceRecording = null;
      state.voiceChunks = [];
      state.voiceMuted = true;
    }
    async function collectBrowserWebrtcLiveProof() {
      const pc = state.voicePeer;
      const audio = state.voiceRemoteAudio;
      if (!pc || pc.connectionState === "closed") throw new Error("browser WebRTC peer connection is not active");
      const stats = await pc.getStats();
      const rtcStats = [];
      const outboundAudioStats = [];
      const inboundAudioStats = [];
      stats.forEach(function(report) {
        const item = Object.assign({}, report);
        if (report.type === "inbound-rtp" || report.type === "outbound-rtp" || report.type === "track" || report.type === "media-source") rtcStats.push(item);
        if (report.type === "outbound-rtp" && (report.kind === "audio" || report.mediaType === "audio")) outboundAudioStats.push(item);
        if (report.type === "inbound-rtp" && (report.kind === "audio" || report.mediaType === "audio")) inboundAudioStats.push(item);
      });
      if (state.voiceCallId) {
        await refresh();
      }
      let bridgeSessionProof = null;
      if (state.voiceSessionId) {
        const proofResponse = await fetch("/api/browser-webrtc/session/" + encodeURIComponent(state.voiceSessionId) + "/proof").catch(function() { return null; });
        if (proofResponse && proofResponse.ok) {
          bridgeSessionProof = await proofResponse.json().catch(function() { return null; });
        }
      }
      const call = selectedCall();
      const bridge = state.voiceBridgeEvidence && state.voiceBridgeEvidence.bridge ? state.voiceBridgeEvidence.bridge : {};
      const bridgeTurn = bridgeSessionProof && bridgeSessionProof.bridge && bridgeSessionProof.bridge.turnEvidence ? bridgeSessionProof.bridge.turnEvidence : {};
      const transcriptTurn = call && Array.isArray(call.transcript) ? call.transcript.slice().reverse().find(function(turn) { return turn.speaker === "caller"; }) : null;
      const events = [
        {
          type: "browser.microphone.uplink",
          target: "browser",
          track: "local microphone audio",
          callId: state.voiceCallId,
          captured: true,
          rtcStats: outboundAudioStats,
          audioTrack: state.voiceStream && state.voiceStream.getAudioTracks()[0] ? {
            enabled: state.voiceStream.getAudioTracks()[0].enabled,
            muted: state.voiceStream.getAudioTracks()[0].muted,
            readyState: state.voiceStream.getAudioTracks()[0].readyState,
          } : null,
        },
        {
          type: "pipecat.webrtc.offer_answer",
          transport: "webrtc",
          bridge: "pipecat",
          callId: state.voiceCallId,
          sessionId: state.voiceSessionId,
          answer: state.voiceBridgeAnswer,
          bridgeResponse: bridge,
        },
        {
          type: "browser.remote.audio.played",
          target: "browser",
          track: "remote audio",
          callId: state.voiceCallId,
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          inboundRtpAudio: inboundAudioStats[0] || null,
          rtcStats: rtcStats,
          audioElement: audio ? {
            currentTime: audio.currentTime,
            paused: audio.paused,
            readyState: audio.readyState,
            muted: audio.muted,
          } : null,
        },
      ];
      if (bridgeTurn.callerTranscript) events.push({ type: "rtc-asr.transcript.final", engine: "rtc-asr", final: true, transcript: bridgeTurn.callerTranscript, callId: state.voiceCallId, stt: bridgeTurn.stt });
      else if (transcriptTurn && transcriptTurn.text) events.push({ type: "rtc-asr.transcript.final", engine: "rtc-asr", final: true, transcript: transcriptTurn.text, callId: state.voiceCallId });
      if (bridgeTurn.tts && bridgeTurn.tts.audioBytes) events.push(Object.assign({ type: "kokoro.tts.audio", engine: "kokoro", callId: state.voiceCallId }, bridgeTurn.tts));
      else if (bridge && bridge.tts) events.push(Object.assign({ type: "kokoro.tts.audio", engine: "kokoro", callId: state.voiceCallId }, bridge.tts));
      const proof = {
        capturedAt: new Date().toISOString(),
        gitHead: repoHeadEvidence,
        captureSource: "operator-console/browser-webrtc",
        callId: state.voiceCallId,
        sessionId: state.voiceSessionId,
        evidence: state.voiceBridgeEvidence,
        bridgeSessionProof: bridgeSessionProof,
        events: events,
      };
      window.__ACC_BROWSER_WEBRTC_LIVE_PROOF__ = proof;
      return proof;
    }
    function describeVoiceSessionProof(proof) {
      const bridge = proof && proof.bridge ? proof.bridge : {};
      const turn = bridge.turnEvidence || {};
      const lastError = bridge.lastError || {};
      const lastAudio = bridge.lastAudio || {};
      const lastStt = bridge.lastStt || {};
      const lastAcc = bridge.lastAcc || {};
      const lastTts = bridge.lastTts || {};
      if (lastError.error === "empty_transcript" || turn.error === "empty_transcript") {
        return "Audio reached the Pipecat bridge, but rtc-asr returned an empty transcript. Last audio RMS " + escapeHtml(String(lastAudio.rms || "unknown")) + "; inspect session proof for STT events.";
      }
      if (lastError.error) {
        return "Browser WebRTC turn blocked at " + String(lastError.stage || "pipeline") + ": " + String(lastError.detail || lastError.error);
      }
      if (turn.callerTranscript && !turn.agentText) {
        return "rtc-asr transcript arrived (" + String(turn.callerTranscript) + "), but ACC returned no agent text. Flow: " + String(lastAcc.flowState || "unknown") + ".";
      }
      if (turn.agentText && !(turn.tts && turn.tts.audioBytes)) {
        return "ACC returned agent text, but Kokoro audio is not ready yet. Last TTS stage: " + String(lastTts.stage || "none") + ".";
      }
      if (turn.callerTranscript && turn.tts && turn.tts.audioBytes) {
        return "Live turn proof ready: rtc-asr transcript and Kokoro audio are present for turn " + String(turn.turn || bridge.turnCount || 1) + ".";
      }
      if (lastStt.stage === "stt.finalize_started") {
        return "Audio turn finalized; waiting for rtc-asr final transcript.";
      }
      if (lastAudio.stage) {
        return "Audio is reaching the Pipecat bridge; waiting for speech finalization. Last RMS " + escapeHtml(String(lastAudio.rms || "unknown")) + ".";
      }
      return bridge.nextAction || "Waiting for browser microphone audio to reach the Pipecat bridge.";
    }
    async function pollVoiceSessionProof() {
      if (!state.voiceSessionId || !state.voicePeer || state.voicePeer.connectionState === "closed") return;
      const response = await fetch("/api/browser-webrtc/session/" + encodeURIComponent(state.voiceSessionId) + "/proof").catch(function() { return null; });
      if (!response || !response.ok) return;
      const proof = await response.json().catch(function() { return null; });
      if (!proof || !proof.bridge) return;
      const bridge = proof.bridge;
      const turn = bridge.turnEvidence || {};
      const detail = describeVoiceSessionProof(proof);
      const turnCount = Number(bridge.turnCount || turn.turn || 0);
      if (turnCount > state.voiceLastProofTurnCount || turn.callerTranscript) {
        state.voiceLastProofTurnCount = Math.max(state.voiceLastProofTurnCount, turnCount);
        await refresh();
      }
      const proofReady = bridge.reviewReady || (turn.callerTranscript && turn.tts && turn.tts.audioBytes);
      const proofBlocked = (bridge.lastError && bridge.lastError.error) || turn.error || (turn.callerTranscript && !turn.agentText);
      if (proofReady) {
        state.voiceLiveTurnVerified = true;
        updateVoiceBridgeStatus("running", detail);
        setStatus(detail);
      } else if (hasVerifiedLiveVoiceSession() && proofBlocked) {
        if (state.voiceBridge.status !== "running") {
          updateVoiceBridgeStatus("running", "Live browser WebRTC audio remains verified; latest incomplete rtc-asr proof is available from Copy Proof.");
        }
        if (!state.voiceMuted) setStatus("Live browser WebRTC audio remains verified");
      } else if (proofBlocked) {
        updateVoiceBridgeStatus("degraded", detail);
        setStatus(detail);
      } else {
        updateVoiceBridgeStatus("connected", detail);
        if (!state.voiceMuted) setStatus(detail);
      }
    }
    function armVoiceSessionProofPolling() {
      if (state.voiceSessionProofTimer) window.clearTimeout(state.voiceSessionProofTimer);
      function tick() {
        state.voiceSessionProofTimer = null;
        pollVoiceSessionProof()
          .catch(function(error) { setStatus(error.message); })
          .finally(function() {
            if (state.voiceSessionId && state.voicePeer && state.voicePeer.connectionState !== "closed") {
              state.voiceSessionProofTimer = window.setTimeout(tick, 3000);
            }
          });
      }
      state.voiceSessionProofTimer = window.setTimeout(tick, 2000);
    }
    async function checkRemoteAudioAfterConnect(pc) {
      if (state.voicePeer !== pc || pc.connectionState === "closed") return;
      let inboundAudioStats = [];
      try {
        const stats = await pc.getStats();
        stats.forEach(function(report) {
          if (report.type === "inbound-rtp" && (report.kind === "audio" || report.mediaType === "audio")) inboundAudioStats.push(Object.assign({}, report));
        });
      } catch (error) {}
      const inboundBytes = inboundAudioStats.reduce(function(total, report) { return total + (Number(report.bytesReceived) || 0); }, 0);
      const audio = state.voiceRemoteAudio;
      const audioProgressed = Boolean(audio && audio.currentTime > 0 && !audio.paused);
      if (state.voiceRemoteTrackReceived && (state.voiceRemoteAudioStarted || audioProgressed || inboundBytes > 0)) return;
      const missing = !state.voiceRemoteTrackReceived ? "No remote WebRTC audio track arrived from the Pipecat bridge." : "Remote audio track arrived but no audible agent playback has started.";
      const proofHint = state.voiceSessionId ? " Use Copy Proof or GET /api/browser-webrtc/session/" + encodeURIComponent(state.voiceSessionId) + "/proof to inspect rtc-asr/Kokoro evidence." : "";
      state.voiceStatus = "Browser voice blocked: " + missing;
      updateVoiceBridgeStatus("degraded", missing + " Check that rtc-asr, Kokoro, and the Pipecat WebRTC bridge are running and producing turn proof." + proofHint);
      setStatus(state.voiceStatus);
      render();
    }
    function armRemoteAudioWatchdog(pc) {
      if (state.voiceAudioWatchdog) window.clearTimeout(state.voiceAudioWatchdog);
      state.voiceAudioWatchdog = window.setTimeout(function() {
        state.voiceAudioWatchdog = null;
        checkRemoteAudioAfterConnect(pc).catch(function(error) { setStatus(error.message); });
      }, 10000);
    }
    async function copyBrowserWebrtcLiveProof() {
      const proof = await collectBrowserWebrtcLiveProof();
      const text = JSON.stringify(proof, null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        setStatus("Browser WebRTC proof copied");
      } else {
        window.prompt("Browser WebRTC proof JSON", text);
        setStatus("Browser WebRTC proof ready");
      }
      return proof;
    }
    window.__ACC_COPY_BROWSER_WEBRTC_LIVE_PROOF__ = copyBrowserWebrtcLiveProof;
    window.__ACC_COLLECT_BROWSER_WEBRTC_LIVE_PROOF__ = collectBrowserWebrtcLiveProof;
    async function ensureVoiceStream() {
      if (!state.voiceStream) {
        state.voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      return state.voiceStream;
    }
    async function startVoiceSegment() {
      await connectPipecatVoice();
    }
    function isReusableVoicePeer(pc) {
      return Boolean(pc && (pc.connectionState === "new" || pc.connectionState === "connecting" || pc.connectionState === "connected"));
    }
    async function connectPipecatVoice() {
      if (isReusableVoicePeer(state.voicePeer)) {
        state.voiceMuted = false;
        state.voiceStream && state.voiceStream.getAudioTracks().forEach(function(track) { track.enabled = true; });
        state.voiceStatus = "Browser WebRTC voice connected";
        setStatus(state.voiceStatus);
        render();
        return;
      }
      if (state.voicePeer) {
        stopVoiceStream();
      }
      const call = selectedCall();
      if (!call) { await startDemoCall(); }
      const activeCall = selectedCall();
      state.voiceConnecting = true;
      state.voiceStatus = "Connecting browser WebRTC voice";
      updateVoiceBridgeStatus("checking", "Creating browser WebRTC offer");
      try {
        const stream = await ensureVoiceStream();
        const pc = new RTCPeerConnection();
        state.voicePeer = pc;
        state.voiceRemoteAudio = new Audio();
        state.voiceRemoteAudio.autoplay = true;
        state.voiceRemoteAudio.onplaying = function() {
          state.voiceRemoteAudioStarted = true;
          state.voiceLiveAudioVerified = true;
          state.voiceStatus = "Agent audio playing through browser WebRTC";
          updateVoiceBridgeStatus("running", "Remote audio is playing through the browser WebRTC track.");
          setStatus(state.voiceStatus);
        };
        state.voiceRemoteAudio.onerror = function() {
          state.voiceStatus = "Browser voice blocked: remote agent audio playback failed";
          updateVoiceBridgeStatus("degraded", "The remote WebRTC audio track exists, but the browser could not play it. Check autoplay/audio output permissions.");
          setStatus(state.voiceStatus);
        };
        pc.ontrack = function(event) {
          state.voiceRemoteTrackReceived = true;
          const remoteStream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
          state.voiceRemoteAudio.srcObject = remoteStream;
          state.voiceStatus = "Remote audio track received; waiting for agent playback";
          updateVoiceBridgeStatus("connected", "Remote WebRTC audio track received from Pipecat; waiting for audible agent playback.");
          setStatus(state.voiceStatus);
          state.voiceRemoteAudio.play().catch(function(error) {
            state.voiceStatus = "Browser voice blocked: agent audio playback failed: " + error.message;
            updateVoiceBridgeStatus("degraded", state.voiceStatus + ". Check browser autoplay/audio output permissions.");
            setStatus(state.voiceStatus);
          });
        };
        pc.onconnectionstatechange = function() {
          if (pc.connectionState === "disconnected") {
            if (hasVerifiedLiveVoicePlayback()) {
              updateVoiceBridgeStatus("running", "Live browser WebRTC audio remains verified while the peer reports disconnected; keeping the session open.");
              return;
            }
            updateVoiceBridgeStatus("degraded", "WebRTC connection disconnected; waiting for reconnection before closing the voice peer.");
            return;
          }
          if (["failed", "closed"].includes(pc.connectionState)) {
            updateVoiceBridgeStatus("degraded", "WebRTC connection " + pc.connectionState);
            if (state.voicePeer === pc) {
              try { pc.close(); } catch (error) {}
              state.voicePeer = null;
            }
          }
        };
        stream.getAudioTracks().forEach(function(track) { track.enabled = true; pc.addTrack(track, stream); });
        pc.addTransceiver("audio", { direction: "recvonly" });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise(function(resolve) {
          if (pc.iceGatheringState === "complete") { resolve(); return; }
          const timer = window.setTimeout(resolve, 1200);
          pc.addEventListener("icegatheringstatechange", function onStateChange() {
            if (pc.iceGatheringState === "complete") {
              window.clearTimeout(timer);
              pc.removeEventListener("icegatheringstatechange", onStateChange);
              resolve();
            }
          });
        });
        const response = await fetch("/api/browser-webrtc/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "offer", sdp: pc.localDescription.sdp, callId: activeCall ? activeCall.session.callId : null })
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          stopVoiceStream();
          throw new Error(payload.error || "browser_webrtc_session_failed");
        }
        await pc.setRemoteDescription({ type: payload.type, sdp: payload.sdp });
        state.voiceBridgeEvidence = payload.evidence || null;
        state.voiceBridgeAnswer = { type: payload.type, sdp: payload.sdp, sessionId: payload.sessionId, callId: payload.callId };
        state.voiceSessionId = payload.sessionId;
        state.voiceCallId = payload.callId;
        state.selectedCallId = payload.callId;
        state.voiceConnecting = false;
        state.voiceMuted = false;
        state.voiceProcessing = false;
        state.voiceStatus = "Browser WebRTC signaling connected; waiting for remote agent audio";
        updateVoiceBridgeStatus("connected", "Offer/answer succeeded through the Pipecat WebRTC bridge (" + formatVoiceBridgeEngineEvidence(payload.evidence || {}) + "). Waiting for remote audio track and rtc-asr/Kokoro turn proof.");
        armRemoteAudioWatchdog(pc);
        armVoiceSessionProofPolling();
        await refresh();
        setStatus(state.voiceStatus);
      } catch (error) {
        state.voiceConnecting = false;
        state.voiceProcessing = false;
        state.voiceMuted = true;
        stopVoiceStream();
        state.voiceStatus = error && error.message ? error.message : "Browser WebRTC voice blocked";
        updateVoiceBridgeStatus("degraded", state.voiceStatus);
        setStatus(state.voiceStatus);
      }
    }
    async function togglePipecatMute() {
      if (state.voicePeer && !state.voiceMuted) {
        state.voiceMuted = true;
        state.voiceStream && state.voiceStream.getAudioTracks().forEach(function(track) { track.enabled = false; });
        state.voiceStatus = "Voice muted";
        setStatus(state.voiceStatus);
        render();
        return;
      }
      await connectPipecatVoice();
    }
    async function postScriptedTurn(expectedTurnIndex) {
      const call = selectedCall();
      if (!call) return;
      const response = await fetch("/api/operator/console/scripted-turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: call.session.callId, expectedTurnIndex: expectedTurnIndex }) });
      if (!response.ok) { const payload = await response.json().catch(function() { return {}; }); const message = payload.error || "Scripted turn failed"; setStatus(message); throw new Error(message); }
      await refresh();
    }
    async function recordNote(event) {
      event.preventDefault();
      const call = selectedCall();
      const note = document.getElementById("note");
      if (!call || !note.value.trim()) return;
      await fetch("/api/calls/" + call.session.callId + "/operator-note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: note.value.trim(), disposition: document.getElementById("disposition").value.trim() || undefined }) });
      note.value = "";
      await refresh();
    }
    function renderCalls() {
      const root = document.getElementById("calls");
      document.getElementById("queue-count").textContent = state.calls.length + (state.calls.length === 1 ? " call" : " calls");
      root.innerHTML = state.calls.map(function(call) {
        const labels = call.liveProof ? call.liveProof.labels : call.session.runtimeModeLabels;
        const labelText = labels ? [labels.telephony, labels.media, labels.rtcAsr].filter(Boolean).join(" | ") : "runtime labels unavailable";
        const scriptedState = call.actionState.scriptedCallerTurnState || { matchedTurns: 0, totalTurns: (state.scriptedCallerTurns || []).length, remainingTurns: (state.scriptedCallerTurns || []).length, progressPct: 0, nextTurnIndex: 0, nextTurnText: null, completed: false };
        const scriptedLabel = scriptedState.completed ? "script complete" : ("script " + scriptedState.matchedTurns + "/" + scriptedState.totalTurns + " | next: " + (scriptedState.nextTurnText || "queued"));
        const proofStatus = call.liveProof && call.liveProof.eval ? call.liveProof.eval.status : "not_review_ready";
        const attentionBadge = call.attention.required ? '<span class="badge warn">attention</span>' : '<span class="badge ok">monitoring</span>';
        return '<button type="button" class="call-item" aria-selected="' + (call.session.callId === state.selectedCallId) + '" data-call-id="' + escapeHtml(call.session.callId) + '"><span class="call-top"><span class="call-id">' + escapeHtml(call.session.callId) + '</span><span class="call-state">' + escapeHtml(call.flowState) + '</span></span><span class="call-row">' + attentionBadge + '<span class="badge">' + escapeHtml(proofStatus) + '</span></span><span class="meta">' + escapeHtml(scriptedLabel) + '</span><span class="progress" aria-hidden="true"><span style="width:' + Math.max(0, Math.min(100, scriptedState.progressPct)) + '%"></span></span><span class="meta">' + escapeHtml(labelText) + '</span><span class="meta">' + escapeHtml(call.session.openclawSession.label) + '</span></button>';
      }).join("") || '<div class="meta" style="padding:14px">No active calls</div>';
      root.querySelectorAll("button[data-call-id]").forEach(function(button) { button.addEventListener("click", function() { state.selectedCallId = button.dataset.callId; render(); }); });
    }
    function voiceControlsHtml() {
      const voiceConnected = isReusableVoicePeer(state.voicePeer);
      const connectLabel = voiceConnected ? "Voice Connected" : "Connect Voice";
      const connectDisabled = voiceConnected || state.voiceConnecting ? " disabled" : "";
      const muteLabel = state.voiceMuted ? "Unmute Caller" : "Mute Caller";
      const muteIcon = state.voiceMuted ? "🎙️" : "🔇";
      const muteDisabled = voiceConnected ? "" : " disabled";
      const muteTitle = voiceConnected ? muteLabel : "Connect Voice first";
      const bridgeDetail = state.voiceBridge.detail + (state.voiceBridge.checkedAt ? " | last check " + state.voiceBridge.checkedAt : "");
      return '<section class="section"><h3 class="section-title">Browser Voice</h3><div class="actions"><button type="button" id="voice-connect"' + connectDisabled + '>' + connectLabel + '</button><button type="button" class="primary" id="voice-mute" aria-label="' + muteTitle + '" title="' + muteTitle + '"' + muteDisabled + '><span aria-hidden="true">' + muteIcon + '</span> ' + muteLabel + '</button></div><div class="actions"><span id="voice-bridge-status" class="' + voiceBridgeStatusClass() + '">' + escapeHtml(voiceBridgeStatusLabel()) + '</span><span class="status">' + escapeHtml(state.voiceStatus) + '</span></div><details class="section-drawer"><summary>Connection details</summary><div class="drawer-content"><span class="meta" id="voice-bridge-detail">' + escapeHtml(bridgeDetail) + '</span><span class="meta">Browser mic → WebRTC → Pipecat → rtc-asr → ACC → Kokoro → browser playback</span><button type="button" id="voice-copy-proof">Copy voice proof</button></div></details></section>';
    }
    function attachVoiceControls() {
      const connect = document.getElementById("voice-connect");
      const mute = document.getElementById("voice-mute");
      const copyProof = document.getElementById("voice-copy-proof");
      if (connect) connect.addEventListener("click", function() { connectPipecatVoice().catch(function(error) { setStatus(error.message); }); });
      if (mute) mute.addEventListener("click", function() { togglePipecatMute().catch(function(error) { setStatus(error.message); }); });
      if (copyProof) copyProof.addEventListener("click", function() { copyBrowserWebrtcLiveProof().catch(function(error) { setStatus(error.message); }); });
    }
    function renderDetail() {
      const call = selectedCall();
      const callId = call ? call.session.callId : null;
      if (state.transcriptCallId === callId) {
        captureTranscriptScroll();
      } else {
        state.transcriptCallId = callId;
        state.transcriptScrollTop = 0;
        state.transcriptStickToBottom = true;
      }
      document.getElementById("selected-title").textContent = call ? call.session.callId : "Select a call";
      const root = document.getElementById("detail");
      if (!call) {
        root.innerHTML = '<div class="workbench single"><div class="stack">' + voiceControlsHtml() + '</div></div>';
        attachVoiceControls();
        return;
      }
      const actionDetails = Object.fromEntries((call.actionState.actionDetails || []).map(function(entry) { return [entry.action, entry]; }));
      const unavailable = new Set(call.actionState.unavailableActions.map(function(entry) { return entry.action; }));
      const unavailableReasons = Object.fromEntries(call.actionState.unavailableActions.map(function(entry) { return [entry.action, entry.reason]; }));
      function actionButtonHtml(action) {
        const actionDetail = actionDetails[action] || {};
        const cssClass = action === "end_call" ? "danger" : action === "approve_offer" || action === "approve_retention_review" ? "primary" : "";
        const disabled = actionDetail.enabled === false || unavailable.has(action) ? "disabled" : "";
        const titleText = actionDetail.disabledReason || unavailableReasons[action];
        const title = titleText ? ' title="' + escapeHtml(titleText) + '"' : "";
        return '<button type="button" data-action="' + action + '" class="' + cssClass + '" ' + disabled + title + '>' + escapeHtml(labels[action] || action.replace(/_/g, " ")) + '</button>';
      }
      const approvalPending = Boolean(call.actionState.pendingApprovalDetails);
      const callOnHold = call.flowState === "policy_hold" || call.flowState === "operator_steer";
      const requestedApprovalAction = call.actionState.pendingApprovalDetails?.recommendedAction || "approve_offer";
      const primaryActions = approvalPending ? [requestedApprovalAction, "deny_offer"] : [callOnHold ? "resume" : "pause"];
      primaryActions.push("takeover", "transfer", "end_call");
      const actionHtml = primaryActions.map(actionButtonHtml).join("");
      const advancedActionHtml = advancedActions.map(actionButtonHtml).join("");
      const transcriptHtml = call.transcript.map(function(turn) {
        return '<div class="turn ' + escapeHtml(turn.speaker) + '"><b>' + escapeHtml(turn.speaker) + '</b><span>' + escapeHtml(turn.text) + '</span></div>';
      }).join("");
      const pendingHtml = call.actionState.pendingApprovalDetails ? '<div class="metric"><span class="meta">Approval</span><strong>' + escapeHtml(labels[call.actionState.pendingApprovalDetails.recommendedAction] || call.actionState.pendingApprovalDetails.recommendedAction.replace(/_/g, " ")) + '</strong><span class="meta">' + escapeHtml(call.actionState.pendingApprovalDetails.approvalPrompt) + '</span><span class="meta">' + escapeHtml(call.actionState.pendingApprovalDetails.reason || "no reason") + '</span></div>' : '';
      const attentionDetail = call.attention.required ? [call.attention.source, call.attention.reason, call.attention.startedAt].filter(Boolean).join(" | ") : "monitoring";
      const evidence = call.evidenceSummary;
      const evidenceLinks = evidence.links || {};
      const latencyLink = evidence.latestLatencyTrail || evidence.overBudgetLatencyTrail || evidenceLinks.latencyMarks;
      const latestEventLink = evidence.latestEventTrail || evidenceLinks.events;
      const fallbackLabel = evidence.fallbackMode ? evidence.fallbackMode.replace(/_/g, " ") : "none";
      const fallbackTrailLink = evidence.fallbackSourceTrail || evidenceLinks.events;
      const fallbackReasonLink = evidence.fallbackReasonEventTrail || evidence.fallbackReasonOperatorConsole;
      const fallbackDetail = evidence.fallbackReason || evidence.fallbackSource || evidence.handoffStartedAt || "no handoff";
      const fallbackQueueLink = evidence.fallbackModeQueue || evidence.fallbackModeOperatorConsole || evidenceLinks.events;
      const operatorNoteTrailLink = evidence.operatorNoteTrail || evidenceLinks.events;
      const reasonTrailHtml = fallbackReasonLink ? '<a href="' + escapeHtml(fallbackReasonLink) + '">Reason Trail</a>' : '';
      const liveProof = call.liveProof || {};
      const runtimeLabels = liveProof.labels || call.session.runtimeModeLabels || {};
      const isLiveProofReady = liveProof.eval && liveProof.eval.reviewReady;
      const badgeClass = isLiveProofReady ? "badge live" : "badge warn";
      const labelBadges = [runtimeLabels.telephony, runtimeLabels.media, runtimeLabels.rtcAsr, runtimeLabels.credentialsMode].filter(Boolean).map(function(label) { return '<span class="badge">' + escapeHtml(label) + '</span>'; }).join("");
      const caveatsHtml = (liveProof.caveats || []).length ? '<ul class="caveats">' + liveProof.caveats.map(function(caveat) { return '<li>' + escapeHtml(caveat) + '</li>'; }).join("") + '</ul>' : '<span class="meta">No caveats recorded for this run.</span>';
      const asrDetail = liveProof.asr && (liveProof.asr.latestTranscriptText || liveProof.asr.blocker || liveProof.asr.nextAction) ? (liveProof.asr.latestTranscriptText || liveProof.asr.blocker || liveProof.asr.nextAction) : "no ASR events yet";
      const liveProofHtml = '<section class="proof-panel" aria-label="Live SIP proof"><div class="proof-header"><h3>Live SIP proof</h3><div class="badges"><span class="' + badgeClass + '">' + escapeHtml(liveProof.eval ? liveProof.eval.status : "not_review_ready") + '</span>' + labelBadges + '</div></div><div class="proof-grid"><div class="metric"><span class="meta">Run / Session</span><strong>' + escapeHtml((liveProof.run && liveProof.run.sessionId) || call.session.openclawSession.sessionId) + '</strong><span class="meta">Call: ' + escapeHtml((liveProof.run && liveProof.run.callId) || call.session.callId) + '</span><span class="meta">Provider: ' + escapeHtml((liveProof.run && liveProof.run.providerCallId) || call.session.providerCallId) + '</span></div><div class="metric"><span class="meta">Audio Capture</span><strong>' + escapeHtml(humanLabel(liveProof.audioCapture && liveProof.audioCapture.status)) + '</strong>' + pathHtml(liveProof.audioCapture && liveProof.audioCapture.audioWavPath, "WAV") + pathHtml(liveProof.audioCapture && liveProof.audioCapture.sipLogPath, "SIP log") + linkHtml(liveProof.audioCapture && liveProof.audioCapture.eventTrail, "Capture Events") + '</div><div class="metric"><span class="meta">Transcript / ASR</span><strong>' + escapeHtml(humanLabel(liveProof.asr && liveProof.asr.status)) + '</strong><span class="meta">' + escapeHtml(asrDetail) + '</span>' + pathHtml(liveProof.asr && liveProof.asr.evidencePath, "ASR evidence") + linkHtml(liveProof.asr && liveProof.asr.eventTrail, "ASR Events") + '</div><div class="metric"><span class="meta">Artifacts / Eval</span><strong>' + escapeHtml(isLiveProofReady ? "Reviewable" : "Blocked") + '</strong>' + linkHtml(liveProof.eval && liveProof.eval.proofRoute, "Proof") + linkHtml(liveProof.eval && liveProof.eval.artifactManifestRoute, "Artifacts") + linkHtml(liveProof.eval && liveProof.eval.transcriptRoute, "Transcript") + '</div><div class="metric"><span class="meta">Handoff State</span><strong>' + escapeHtml(humanLabel(liveProof.operator && liveProof.operator.handoffState)) + '</strong><span class="meta">Attention: ' + escapeHtml(liveProof.operator && liveProof.operator.attentionRequired ? "required" : "clear") + '</span><span class="meta">Pending: ' + escapeHtml((liveProof.operator && liveProof.operator.pendingAction) || "none") + '</span></div></div>' + caveatsHtml + '</section>';
      const markers = call.controlMarkers || {};
      const markerHtml = '<section class="section"><h3 class="section-title">Live Control Markers</h3><div class="evidence"><div class="metric"><span class="meta">Live Call State</span><strong>' + escapeHtml(markers.liveCall && markers.liveCall.status || "unknown") + '</strong><span class="meta">' + escapeHtml(markers.liveCall && markers.liveCall.providerCallId || call.session.providerCallId) + '</span></div><div class="metric"><span class="meta">Flow State</span><strong>' + escapeHtml(markers.flowState && markers.flowState.current || call.flowState) + '</strong><span class="meta">Tool: ' + escapeHtml(markers.flowState && markers.flowState.activeTool || "none") + '</span></div><div class="metric"><span class="meta">Transcript</span><strong>' + escapeHtml(markers.transcript && markers.transcript.turnCount !== undefined ? markers.transcript.turnCount : call.transcript.length) + '</strong>' + linkHtml(markers.transcript && markers.transcript.route, "Transcript Trail") + '</div><div class="metric"><span class="meta">Pending Approval</span><strong>' + escapeHtml(markers.pendingApproval && markers.pendingApproval.active ? "pending" : "clear") + '</strong><span class="meta">' + escapeHtml(markers.pendingApproval && markers.pendingApproval.recommendedAction || "none") + '</span>' + linkHtml(markers.pendingApproval && markers.pendingApproval.trail, "Approval Trail") + '</div><div class="metric"><span class="meta">Hold</span><strong>' + escapeHtml(markers.hold && markers.hold.active ? "active" : "clear") + '</strong><span class="meta">' + escapeHtml(markers.hold && markers.hold.reason || "none") + '</span>' + linkHtml(markers.hold && markers.hold.trail, "Hold Trail") + '</div><div class="metric"><span class="meta">Evidence</span><strong>' + escapeHtml(markers.evidence && markers.evidence.latestEventType || "none") + '</strong>' + linkHtml(markers.evidence && markers.evidence.eventTrail, "Event Trail") + linkHtml(markers.evidence && markers.evidence.proofRoute, "Proof") + '</div></div></section>';
      const evidenceHtml = '<div class="evidence" aria-label="Evidence markers"><div class="metric"><span class="meta">Latest Event</span><strong>' + escapeHtml(evidence.latestEventType || "none") + '</strong><span class="meta">' + escapeHtml(evidence.latestEventAt || "not recorded") + '</span><a href="' + escapeHtml(latestEventLink) + '">Event Trail</a></div><div class="metric"><span class="meta">Transcript Turns</span><strong>' + evidence.transcriptTurns + '</strong><a href="' + escapeHtml(evidenceLinks.transcript) + '">Transcript</a></div><div class="metric"><span class="meta">Latency Marks</span><strong>' + evidence.latencyMarkCount + '</strong><span class="meta">Over budget: ' + evidence.overBudgetLatencyMarkCount + '</span><a href="' + escapeHtml(latencyLink) + '">Latency</a></div><div class="metric"><span class="meta">Fallback</span><strong>' + escapeHtml(fallbackLabel) + '</strong><span class="meta">' + escapeHtml(fallbackDetail) + '</span><a href="' + escapeHtml(fallbackTrailLink) + '">Event Trail</a><a href="' + escapeHtml(fallbackQueueLink) + '">Fallback Queue</a>' + reasonTrailHtml + '</div><div class="metric"><span class="meta">Operator Notes</span><strong>' + evidence.operatorNoteCount + '</strong><span class="meta">' + escapeHtml(evidence.latestDisposition || evidence.latestOperatorNoteText || "none") + '</span><a href="' + escapeHtml(operatorNoteTrailLink) + '">Note Trail</a></div><div class="metric"><span class="meta">Proof Bundle</span><strong>' + evidence.eventCount + '</strong><a href="' + escapeHtml(evidenceLinks.proof) + '">Proof</a><a href="' + escapeHtml(evidenceLinks.artifacts) + '">Artifacts</a></div></div>';
      const assertHtml = '<section class="proof-panel" aria-label="Assert UI"><div class="proof-header"><h3>Assert UI</h3><div class="badges"><a class="badge" href="/assert/full">Full ASSERT</a><a class="badge" href="/assert">ACC Artifacts</a><a class="badge" href="/assert/spec">Eval Spec</a><span class="badge ok">' + escapeHtml(call.flowState === "wrap" && call.pipecatFlow.script.completed ? "call complete" : "collecting evidence") + '</span><span class="badge">' + escapeHtml(call.pipecatFlow.prototypeMode) + '</span></div></div><div class="proof-grid"><div class="metric"><span class="meta">Call State</span><strong>' + escapeHtml(call.flowState) + '</strong><span class="meta">Script: ' + escapeHtml(call.pipecatFlow.script.completed ? "complete" : "in progress") + '</span><span class="meta">Attention: ' + escapeHtml(call.attention.required ? "required" : "clear") + '</span></div><div class="metric"><span class="meta">Evidence Counts</span><strong>' + evidence.eventCount + ' events</strong><span class="meta">' + evidence.transcriptTurns + ' transcript turns</span><span class="meta">' + evidence.latencyMarkCount + ' latency marks</span></div><div class="metric"><span class="meta">Artifacts</span><strong>' + escapeHtml(evidence.operatorNoteCount > 0 ? "Disposition captured" : "No disposition yet") + '</strong><a href="' + escapeHtml(evidenceLinks.proof) + '">Open Proof JSON</a><a href="' + escapeHtml(evidenceLinks.artifacts) + '">Open Artifact Manifest</a><a href="' + escapeHtml(evidenceLinks.transcript) + '">Open Transcript JSON</a></div><div class="metric"><span class="meta">Assert Inputs</span><strong>' + escapeHtml(liveProof.eval && liveProof.eval.status ? liveProof.eval.status : "local proof bundle") + '</strong><span class="meta">Use npm run assert:export to write official ASSERT viewer artifacts, then npm run assert:viewer to browse them.</span></div></div></section>';
      const scriptedState = call.actionState.scriptedCallerTurnState || { matchedTurns: 0, totalTurns: (state.scriptedCallerTurns || []).length, remainingTurns: (state.scriptedCallerTurns || []).length, progressPct: 0, nextTurnIndex: 0, nextTurnText: null, completed: false };
      const scriptedTurns = (scriptedState.turnTexts || state.scriptedCallerTurns || []).map(function(text, index) {
        const isCompleted = index < scriptedState.matchedTurns;
        const isNext = index === scriptedState.nextTurnIndex;
        const disabled = (isCompleted || !isNext) ? "disabled" : "";
        const status = isCompleted ? "Sent" : isNext ? "Next" : "Queued";
        return '<button type="button" data-scripted-turn="' + index + '" ' + disabled + '><span class="meta">' + status + ' | Turn ' + (index + 1) + '</span><br>' + escapeHtml(text) + '</button>';
      }).join("");
      root.innerHTML = '<div class="summary-grid"><div class="metric compact"><span class="meta">Flow</span><strong>' + escapeHtml(call.flowState) + '</strong></div><div class="metric compact"><span class="meta">Attention</span><strong>' + (call.attention.required ? "Required" : "Clear") + '</strong><span class="meta">' + escapeHtml(attentionDetail) + '</span></div><div class="metric compact"><span class="meta">Next</span><strong>' + escapeHtml(labels[call.actionState.nextRecommendedAction] || call.actionState.nextRecommendedAction.replace(/_/g, " ")) + '</strong></div>' + pendingHtml + '</div><div class="workbench"><div class="stack">' + voiceControlsHtml() + '<section class="section"><h3 class="section-title">Call Controls</h3><div class="actions">' + actionHtml + '</div><details class="section-drawer"><summary>Advanced controls</summary><div class="drawer-content"><div class="actions">' + advancedActionHtml + '</div></div></details></section><details class="section-drawer"><summary>Test tools</summary><div class="drawer-content"><div class="scripted-turns">' + scriptedTurns + '</div><form id="caller-turn-form"><input id="caller-turn" placeholder="Caller transcript turn"><button type="submit">Add Turn</button></form></div></details><details class="section-drawer"' + (call.flowState === "wrap" ? " open" : "") + '><summary>Notes & disposition</summary><div class="drawer-content"><form id="note-form"><textarea id="note" placeholder="Operator note"></textarea><div><input id="disposition" placeholder="Disposition"><button type="submit">Add Note</button></div></form></div></details></div><div class="stack"><section class="section"><h3 class="section-title">Transcript</h3><div class="transcript">' + transcriptHtml + '</div></section><details class="section-drawer"><summary>Evidence & QA</summary><div class="drawer-content">' + assertHtml + liveProofHtml + markerHtml + '<section class="section"><h3 class="section-title">Evidence markers</h3>' + evidenceHtml + '</section></div></details></div></div>';
      root.querySelectorAll("button[data-action]").forEach(function(button) { button.addEventListener("click", function() { const action = button.dataset.action; const metadata = callActionMetadata(call, action); const reason = metadata.reasonPrompt ? prompt(metadata.reasonPrompt) : undefined; if (metadata.requiresReason && !reason) return; const confirmed = metadata.confirmationRequired ? confirm((metadata.confirmationMessage || "Confirm " + (labels[action] || action.replace(/_/g, " "))) + "\\n\\nCall: " + call.session.callId) : false; if (metadata.confirmationRequired && !confirmed) return; postAction(action, reason, confirmed); }); });
      root.querySelectorAll("button[data-scripted-turn]").forEach(function(button) { button.addEventListener("click", function() { const index = Number(button.dataset.scriptedTurn); if (Number.isInteger(index)) postScriptedTurn(index).catch(function(error) { setStatus(error.message); }); }); });
      attachVoiceControls();
      document.getElementById("caller-turn-form").addEventListener("submit", recordCallerTurn);
      document.getElementById("note-form").addEventListener("submit", recordNote);
      restoreTranscriptScroll(call.session.callId);
    }
    function render() { renderCalls(); renderDetail(); }
    function scheduleRefresh() {
      if (state.refreshTimer) clearTimeout(state.refreshTimer);
      if (document.hidden) return;
      state.refreshTimer = setTimeout(function() { refresh({ auto: true }).catch(function(error) { setStatus(error.message); scheduleRefresh(); }); }, state.refreshIntervalMs || 5000);
    }
    document.addEventListener("visibilitychange", function() { if (document.hidden && state.refreshTimer) clearTimeout(state.refreshTimer); else refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("run-demo-flow").addEventListener("click", function() { runDemoFlow().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("start-demo").addEventListener("click", function() { startDemoCall().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("attention-filter").addEventListener("change", function() { refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("latency-over-budget-filter").addEventListener("change", function() { refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("flow-filter").addEventListener("change", function() { refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("fallback-filter").addEventListener("change", function() { refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("fallback-source-filter").addEventListener("change", function() { refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("fallback-reason-filter").addEventListener("change", function() { refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("transcript-filter").addEventListener("change", function() { refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("tool-filter").addEventListener("change", function() { refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("script-completed-filter").addEventListener("change", function() { refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("script-progress-filter").addEventListener("change", function() { refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("script-max-progress-filter").addEventListener("change", function() { refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("clear-filters").addEventListener("click", function() { document.getElementById("attention-filter").checked = false; document.getElementById("latency-over-budget-filter").checked = false; document.getElementById("flow-filter").value = ""; document.getElementById("fallback-filter").value = ""; document.getElementById("fallback-source-filter").value = ""; document.getElementById("fallback-reason-filter").value = ""; document.getElementById("tool-filter").value = ""; document.getElementById("script-completed-filter").value = ""; document.getElementById("script-progress-filter").value = ""; document.getElementById("script-max-progress-filter").value = ""; document.getElementById("transcript-filter").value = ""; refresh().catch(function(error) { setStatus(error.message); }); });
    refresh()
      .then(startVoiceBridgeProbing)
      .catch(function(error) { setStatus(error.message); startVoiceBridgeProbing(); });
  </script>
</body>
</html>`;
}

function buildAssertFullViewerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Full ASSERT Viewer</title>
  <style>
    :root { --line: #d0d7de; --text: #24292f; --muted: #57606a; --bg: #f6f8fa; --panel: #fff; --accent: #0969da; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; grid-template-rows: auto minmax(0, 1fr); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
    h1 { margin: 0; font-size: 17px; letter-spacing: 0; }
    .muted { color: var(--muted); font-size: 12px; }
    .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    a { display: inline-flex; align-items: center; min-height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--text); font-size: 13px; font-weight: 700; text-decoration: none; }
    a.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .frame-wrap { min-height: 0; padding: 10px; }
    iframe { width: 100%; height: 100%; min-height: calc(100vh - 82px); border: 1px solid var(--line); border-radius: 8px; background: #fff; }
    @media (max-width: 760px) { header { align-items: stretch; flex-direction: column; } .toolbar { align-items: stretch; } a { justify-content: center; } }
  </style>
</head>
<body>
  <header>
    <div><h1>Full ASSERT Viewer</h1><div class="muted">Runs the upstream ASSERT viewer against local artifacts/results. Start it with npm run assert:viewer after npm run assert:export.</div></div>
    <div class="toolbar"><a href="/operator/console">Operator</a><a href="/assert/spec">Eval Spec</a><a href="/assert">ACC Artifacts</a><a class="primary" href="http://127.0.0.1:5174" target="_blank" rel="noreferrer">Open Viewer</a></div>
  </header>
  <main class="frame-wrap"><iframe title="Upstream ASSERT viewer" src="http://127.0.0.1:5174"></iframe></main>
</body>
</html>`;
}

function buildAssertViewerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ASSERT Viewer</title>
  <style>
    :root { --bg: #f6f8fa; --panel: #fff; --text: #24292f; --muted: #57606a; --line: #d0d7de; --accent: #0969da; --ok: #1a7f37; --warn: #9a6700; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 18px; border-bottom: 1px solid var(--line); background: var(--panel); }
    h1 { margin: 0; font-size: 18px; letter-spacing: 0; }
    a { color: var(--accent); text-decoration: none; font-weight: 650; }
    main { display: grid; grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); min-height: calc(100vh - 58px); }
    aside { border-right: 1px solid var(--line); background: var(--panel); overflow: auto; }
    section { min-width: 0; }
    button, select { font: inherit; }
    button { border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--text); cursor: pointer; }
    button:hover { border-color: var(--accent); }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .run { display: grid; gap: 6px; width: 100%; padding: 12px 14px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; text-align: left; }
    .run[aria-selected="true"] { border-left: 4px solid var(--accent); padding-left: 10px; background: #ddf4ff; }
    .muted { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .badge { display: inline-flex; align-items: center; width: fit-content; min-height: 22px; padding: 2px 7px; border: 1px solid var(--line); border-radius: 999px; font-size: 12px; font-weight: 700; }
    .badge.ok { color: var(--ok); border-color: #4ac26b; background: #dafbe1; }
    .badge.warn { color: var(--warn); border-color: #d4a72c; background: #fff8c5; }
    .content { display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-width: 0; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 14px; border-bottom: 1px solid var(--line); background: var(--panel); }
    .card { border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: #fff; min-width: 0; }
    .card strong { display: block; font-size: 18px; overflow-wrap: anywhere; }
    .tabs { display: flex; gap: 6px; padding: 10px 14px; border-bottom: 1px solid var(--line); background: #fff; overflow: auto; }
    .tabs button { padding: 7px 10px; white-space: nowrap; }
    .tabs button[aria-selected="true"] { color: #fff; border-color: var(--accent); background: var(--accent); }
    pre { margin: 0; padding: 14px; overflow: auto; min-height: 0; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0d1117; color: #e6edf3; }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; } aside { max-height: 260px; border-right: 0; border-bottom: 1px solid var(--line); } .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body>
  <header>
    <div><h1>ACC Artifact View</h1><div class="muted">Local ACC proof artifacts and call eval evidence; use Full ASSERT for the upstream viewer.</div></div>
    <div class="toolbar"><a href="/assert/full">Full ASSERT</a><a href="/operator/console">Operator Console</a><a href="/assert/spec">Eval Spec</a><button type="button" id="refresh">Refresh</button></div>
  </header>
  <main>
    <aside id="runs"></aside>
    <section class="content">
      <div class="summary" id="summary"></div>
      <div class="tabs" id="tabs"></div>
      <pre id="json">{}</pre>
    </section>
  </main>
  <script>
    const state = { calls: [], selectedCallId: null, tab: "proof", artifacts: {} };
    const tabs = ["proof", "artifacts", "transcript", "events", "latency"];
    function escapeHtml(value) { return String(value).replace(/[&<>\"]/g, function(char) { if (char === "&") return "&amp;"; if (char === "<") return "&lt;"; if (char === ">") return "&gt;"; return "&quot;"; }); }
    function selectedCall() { return state.calls.find(function(call) { return call.session.callId === state.selectedCallId; }) || state.calls[0] || null; }
    async function fetchJson(path) { const response = await fetch(path); if (!response.ok) throw new Error(path + " failed"); return response.json(); }
    async function refresh() {
      const payload = await fetchJson("/api/operator/console?limit=100&order=desc");
      state.calls = payload.calls.items;
      if (!state.calls.some(function(call) { return call.session.callId === state.selectedCallId; })) state.selectedCallId = state.calls[0] ? state.calls[0].session.callId : null;
      await loadSelectedArtifact();
      render();
    }
    async function loadSelectedArtifact() {
      const call = selectedCall();
      if (!call) return;
      const links = call.evidenceSummary.links;
      const loaders = {
        proof: links.proof,
        artifacts: links.artifacts,
        transcript: links.transcript,
        events: links.events,
        latency: links.latencyMarks
      };
      state.artifacts = {};
      await Promise.all(Object.entries(loaders).map(async function(entry) {
        const key = entry[0], path = entry[1];
        state.artifacts[key] = await fetchJson(path);
      }));
    }
    async function selectCall(callId) { state.selectedCallId = callId; await loadSelectedArtifact(); render(); }
    function renderRuns() {
      const root = document.getElementById("runs");
      root.innerHTML = state.calls.map(function(call) {
        const complete = call.flowState === "wrap" && call.pipecatFlow.script.completed;
        return '<button class="run" aria-selected="' + (call.session.callId === state.selectedCallId) + '" data-call-id="' + escapeHtml(call.session.callId) + '"><strong>' + escapeHtml(call.session.callId) + '</strong><span class="' + (complete ? "badge ok" : "badge warn") + '">' + escapeHtml(complete ? "complete" : call.flowState) + '</span><span class="muted">' + escapeHtml(call.session.openclawSession.label) + '</span><span class="muted">' + escapeHtml(call.evidenceSummary.eventCount + " events | " + call.evidenceSummary.transcriptTurns + " transcript turns") + '</span></button>';
      }).join("") || '<div class="muted" style="padding:14px">No call artifacts yet</div>';
      root.querySelectorAll("button[data-call-id]").forEach(function(button) { button.addEventListener("click", function() { selectCall(button.dataset.callId).catch(function(error) { document.getElementById("json").textContent = error.message; }); }); });
    }
    function renderSummary() {
      const call = selectedCall();
      const root = document.getElementById("summary");
      if (!call) { root.innerHTML = ""; return; }
      root.innerHTML = '<div class="card"><span class="muted">Call</span><strong>' + escapeHtml(call.session.callId) + '</strong><span class="muted">' + escapeHtml(call.session.providerCallId) + '</span></div><div class="card"><span class="muted">State</span><strong>' + escapeHtml(call.flowState) + '</strong><span class="muted">Script ' + escapeHtml(call.pipecatFlow.script.completed ? "complete" : "in progress") + '</span></div><div class="card"><span class="muted">Evidence</span><strong>' + escapeHtml(call.evidenceSummary.eventCount + " events") + '</strong><span class="muted">' + escapeHtml(call.evidenceSummary.latencyMarkCount + " latency marks") + '</span></div><div class="card"><span class="muted">Runtime</span><strong>' + escapeHtml(call.pipecatFlow.prototypeMode) + '</strong><span class="muted">' + escapeHtml(call.pipecatFlow.runtimeEngine) + '</span></div>';
    }
    function renderTabs() {
      const root = document.getElementById("tabs");
      root.innerHTML = tabs.map(function(tab) { return '<button type="button" aria-selected="' + (state.tab === tab) + '" data-tab="' + tab + '">' + escapeHtml(tab) + '</button>'; }).join("");
      root.querySelectorAll("button[data-tab]").forEach(function(button) { button.addEventListener("click", function() { state.tab = button.dataset.tab; renderJson(); renderTabs(); }); });
    }
    function renderJson() { document.getElementById("json").textContent = JSON.stringify(state.artifacts[state.tab] || {}, null, 2); }
    function render() { renderRuns(); renderSummary(); renderTabs(); renderJson(); }
    document.getElementById("refresh").addEventListener("click", function() { refresh().catch(function(error) { document.getElementById("json").textContent = error.message; }); });
    refresh().catch(function(error) { document.getElementById("json").textContent = error.message; });
  </script>
</body>
</html>`;
}

function buildAssertSpecEditorHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ASSERT Eval Spec</title>
  <style>
    :root { --bg: #f6f8fa; --panel: #fff; --text: #24292f; --muted: #57606a; --line: #d0d7de; --accent: #0969da; --ok: #1a7f37; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); background: #fff; }
    h1 { margin: 0; font-size: 18px; letter-spacing: 0; }
    h2 { margin: 0 0 8px; font-size: 14px; letter-spacing: 0; }
    a { color: var(--accent); text-decoration: none; font-weight: 650; }
    main { display: grid; grid-template-columns: minmax(320px, 0.9fr) minmax(360px, 1.1fr); gap: 14px; padding: 14px; }
    section { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); padding: 12px; min-width: 0; }
    label { display: grid; gap: 5px; margin-bottom: 10px; color: var(--muted); font-size: 12px; font-weight: 700; }
    input, textarea, select { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 8px; font: 13px/1.4 ui-sans-serif, system-ui; color: var(--text); background: #fff; }
    textarea { min-height: 78px; resize: vertical; }
    pre { margin: 0; min-height: 520px; overflow: auto; padding: 12px; border-radius: 6px; background: #0d1117; color: #e6edf3; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    button { border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--text); padding: 8px 10px; font: inherit; cursor: pointer; }
    button.primary { border-color: var(--accent); background: var(--accent); color: #fff; }
    .toolbar, .actions, .blocks { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .muted { color: var(--muted); font-size: 12px; }
    .status { color: var(--ok); font-size: 12px; font-weight: 700; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    details { margin: 12px 0; border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: #f6f8fa; }
    summary { cursor: pointer; font-weight: 750; }
    @media (max-width: 980px) { main, .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div><h1>ASSERT Eval Spec</h1><div class="muted">Editable local YAML-shaped spec for voice-agent goals, test generation, and judges</div></div>
    <div class="toolbar"><a href="/assert/full">Full ASSERT</a><a href="/assert">ACC Artifacts</a><a href="/operator/console">Operator Console</a><button type="button" class="primary" id="save">Save</button><button type="button" id="reset">Reset</button></div>
  </header>
  <main>
    <section>
      <h2>Goal</h2>
      <label>Spec ID<input id="id"></label>
      <label>Title<input id="title"></label>
      <label>Role<input id="role"></label>
      <label>Objective<textarea id="objective"></textarea></label>
      <div class="grid">
        <label>Success checks<textarea id="requiredBehaviors"></textarea></label>
        <label>Failure checks<textarea id="forbiddenBehaviors"></textarea></label>
      </div>
      <label>Scenario seeds<textarea id="scenarios"></textarea></label>
      <details>
      <summary>Advanced systematization and judge settings</summary>
      <label>Conversation memory keys<textarea id="conversationMemory"></textarea></label>
      <h2>Systematization / Test Set</h2>
      <div class="grid">
        <label>Dimensions<textarea id="dimensions"></textarea></label>
        <label>Coverage targets<textarea id="coverageTargets"></textarea></label>
        <label>Personas<textarea id="personas"></textarea></label>
      </div>
      <label>Edge cases<textarea id="edgeCases"></textarea></label>
      <h2>Judge Options</h2>
      <label>Judges JSON<textarea id="judges"></textarea></label>
      </details>
      <h2>Prewritten Blocks</h2>
      <div class="blocks" id="blocks"></div>
      <div class="actions"><span class="status" id="status">Loaded</span></div>
    </section>
    <section>
      <h2>Generated assert.yml</h2>
      <pre id="yaml"></pre>
    </section>
  </main>
  <script>
    let current = null;
    let blocks = [];
    function lines(value) { return String(value || "").split("\\n").map(function(line) { return line.trim(); }).filter(Boolean); }
    function setLines(id, values) { document.getElementById(id).value = (values || []).join("\\n"); }
    function getSpec() {
      return {
        id: document.getElementById("id").value.trim(),
        version: current ? current.version : 1,
        title: document.getElementById("title").value.trim(),
        agentGoal: {
          role: document.getElementById("role").value.trim(),
          objective: document.getElementById("objective").value.trim(),
          requiredBehaviors: lines(document.getElementById("requiredBehaviors").value),
          forbiddenBehaviors: lines(document.getElementById("forbiddenBehaviors").value),
          conversationMemory: lines(document.getElementById("conversationMemory").value),
        },
        systematization: {
          dimensions: lines(document.getElementById("dimensions").value),
          coverageTargets: lines(document.getElementById("coverageTargets").value),
        },
        testSetGeneration: {
          personas: lines(document.getElementById("personas").value),
          scenarios: lines(document.getElementById("scenarios").value),
          edgeCases: lines(document.getElementById("edgeCases").value),
        },
        judges: JSON.parse(document.getElementById("judges").value || "[]"),
      };
    }
    function renderSpec(payload) {
      current = payload.spec;
      blocks = payload.blocks || blocks;
      document.getElementById("id").value = current.id;
      document.getElementById("title").value = current.title;
      document.getElementById("role").value = current.agentGoal.role;
      document.getElementById("objective").value = current.agentGoal.objective;
      setLines("requiredBehaviors", current.agentGoal.requiredBehaviors);
      setLines("forbiddenBehaviors", current.agentGoal.forbiddenBehaviors);
      setLines("conversationMemory", current.agentGoal.conversationMemory);
      setLines("dimensions", current.systematization.dimensions);
      setLines("coverageTargets", current.systematization.coverageTargets);
      setLines("personas", current.testSetGeneration.personas);
      setLines("scenarios", current.testSetGeneration.scenarios);
      setLines("edgeCases", current.testSetGeneration.edgeCases);
      document.getElementById("judges").value = JSON.stringify(current.judges, null, 2);
      document.getElementById("yaml").textContent = payload.yaml;
      renderBlocks();
    }
    function renderBlocks() {
      const root = document.getElementById("blocks");
      root.innerHTML = blocks.map(function(block) { return '<button type="button" data-block="' + block.id + '">' + block.label + '</button>'; }).join("");
      root.querySelectorAll("button[data-block]").forEach(function(button) {
        button.addEventListener("click", function() {
          const block = blocks.find(function(item) { return item.id === button.dataset.block; });
          if (!block) return;
          const map = {
            "agentGoal.requiredBehaviors": "requiredBehaviors",
            "agentGoal.forbiddenBehaviors": "forbiddenBehaviors",
            systematization: "dimensions",
            testSetGeneration: "scenarios",
          };
          const targetId = map[block.target];
          if (!targetId) return;
          const input = document.getElementById(targetId);
          const existing = lines(input.value);
          input.value = Array.from(new Set(existing.concat(block.values))).join("\\n");
          refreshYaml();
        });
      });
    }
    async function refreshYaml() {
      const response = await fetch("/api/assert/spec/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec: getSpec() }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "preview failed");
      document.getElementById("yaml").textContent = payload.yaml;
      document.getElementById("status").textContent = "Preview updated";
    }
    async function loadSpec() {
      const response = await fetch("/api/assert/spec");
      renderSpec(await response.json());
    }
    async function saveSpec() {
      const response = await fetch("/api/assert/spec", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec: getSpec() }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "save failed");
      renderSpec(payload);
      document.getElementById("status").textContent = "Saved";
    }
    document.querySelectorAll("input, textarea").forEach(function(input) { input.addEventListener("change", function() { refreshYaml().catch(function(error) { document.getElementById("status").textContent = error.message; }); }); });
    document.getElementById("save").addEventListener("click", function() { saveSpec().catch(function(error) { document.getElementById("status").textContent = error.message; }); });
    document.getElementById("reset").addEventListener("click", async function() {
      const response = await fetch("/api/assert/spec/reset", { method: "POST" });
      renderSpec(await response.json());
      document.getElementById("status").textContent = "Reset";
    });
    loadSpec().catch(function(error) { document.getElementById("status").textContent = error.message; });
  </script>
</body>
</html>`;
}

function writeNotFound(response: ServerResponse): void {
  writeJson(response, 404, {
    ok: false,
    error: "not_found",
  });
}

function writeBadRequest(response: ServerResponse, error: string): void {
  writeJson(response, 400, {
    ok: false,
    error,
  });
}

class InvalidJsonBodyError extends Error {
  constructor() {
    super("invalid_json_body");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOptionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseAssertEvaluationSpec(value: unknown): AssertEvaluationSpec | null {
  if (!isRecord(value)) return null;
  const agentGoal = value.agentGoal;
  const systematization = value.systematization;
  const testSetGeneration = value.testSetGeneration;
  const judges = value.judges;

  if (!isRecord(agentGoal) || !isRecord(systematization) || !isRecord(testSetGeneration) || !Array.isArray(judges)) {
    return null;
  }

  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.version !== "number" ||
    typeof agentGoal.role !== "string" ||
    typeof agentGoal.objective !== "string" ||
    !isStringArray(agentGoal.requiredBehaviors) ||
    !isStringArray(agentGoal.forbiddenBehaviors) ||
    !isStringArray(agentGoal.conversationMemory) ||
    !isStringArray(systematization.dimensions) ||
    !isStringArray(systematization.coverageTargets) ||
    !isStringArray(testSetGeneration.personas) ||
    !isStringArray(testSetGeneration.scenarios) ||
    !isStringArray(testSetGeneration.edgeCases)
  ) {
    return null;
  }

  const parsedJudges = judges.map((judge) => {
    if (!isRecord(judge) || typeof judge.name !== "string" || (judge.type !== "llm" && judge.type !== "rule") || !isStringArray(judge.rubric)) {
      return null;
    }

    return {
      name: judge.name,
      type: judge.type,
      rubric: judge.rubric,
    };
  });

  if (parsedJudges.some((judge) => judge === null)) {
    return null;
  }

  return {
    id: value.id,
    version: value.version,
    title: value.title,
    agentGoal: {
      role: agentGoal.role,
      objective: agentGoal.objective,
      requiredBehaviors: agentGoal.requiredBehaviors,
      forbiddenBehaviors: agentGoal.forbiddenBehaviors,
      conversationMemory: agentGoal.conversationMemory,
    },
    systematization: {
      dimensions: systematization.dimensions,
      coverageTargets: systematization.coverageTargets,
    },
    testSetGeneration: {
      personas: testSetGeneration.personas,
      scenarios: testSetGeneration.scenarios,
      edgeCases: testSetGeneration.edgeCases,
    },
    judges: parsedJudges as AssertEvaluationSpec["judges"],
  };
}

function hasInvalidOptionalString(value: unknown): boolean {
  return value !== undefined && typeof value !== "string";
}

function isSlackSlashCommandName(value: string): boolean {
  return /^\/[a-z0-9._-]+$/i.test(value.trim());
}

function normalizeTimestamp(timestamp: unknown, error: string): string | { error: string } {
  if (timestamp === undefined) {
    return new Date().toISOString();
  }

  if (typeof timestamp !== "string" || !timestamp.trim() || Number.isNaN(Date.parse(timestamp))) {
    return { error };
  }

  return timestamp;
}

function parseOptionalNonNegativeInteger(value: unknown, error: string): number | null | { error: string } {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { error };
  }

  return value;
}

function parseOptionalNonNegativeNumber(value: unknown, error: string): number | null | { error: string } {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { error };
  }

  return value;
}

function isFlowState(value: string): value is FlowState {
  return flowStates.has(value as FlowState);
}

function isAttentionSource(value: string): value is AttentionSource {
  return value === "operator_steer" || value === "fallback" || value === "operator_steer+fallback";
}

function isFallbackMode(value: string): value is FallbackMode {
  return value === "tool_timeout" || value === "runtime_failure";
}

function isTranscriptSpeaker(value: string): value is TranscriptTurn["speaker"] {
  return value === "caller" || value === "agent" || value === "operator" || value === "system";
}

function buildCallPayload(snapshot: CallSnapshot) {
  return {
    ...snapshot,
    attention: getAttentionMetadata(snapshot),
  };
}

function buildDeliveryAckSnapshotVersion(snapshot: CallSnapshot): string {
  const latestEvent = snapshot.events.at(-1);
  const latestTranscriptTurn = snapshot.transcript.at(-1);
  return createHash("sha256")
    .update(
      JSON.stringify({
        flowState: snapshot.flowState,
        transcriptLength: snapshot.transcript.length,
        latestTranscriptSpeaker: latestTranscriptTurn?.speaker ?? null,
        latestTranscriptAt: latestTranscriptTurn?.timestamp ?? null,
        eventCount: snapshot.events.length,
        latestEventType: latestEvent?.type ?? null,
        latestEventAt: latestEvent?.at ?? null,
        latencyMarkCount: snapshot.latencyMarks.length,
        operatorSteer: snapshot.operatorSteer,
        demoFallback: snapshot.demoFallback,
      }),
    )
    .digest("hex");
}

function buildLatestLatencyTrail(snapshot: CallSnapshot): string | null {
  const latestLatencyMark = snapshot.latencyMarks.at(-1);
  return latestLatencyMark
    ? snapshot.session.openclawSession.artifactLinks.latencyMarks +
        "?stage=" +
        encodeURIComponent(latestLatencyMark.stage) +
        "&limit=1&order=desc"
    : null;
}

function buildHandoffTrail(snapshot: CallSnapshot): string | null {
  return snapshot.events.some((event) => event.type === "human_handoff_started")
    ? snapshot.session.openclawSession.artifactLinks.events + "?type=human_handoff_started&limit=1&order=desc"
    : null;
}

function getLatestEvent(snapshot: CallSnapshot, eventType: string) {
  return [...snapshot.events].reverse().find((event) => event.type === eventType) ?? null;
}

const liveSipOperatorReleaseActions = new Set(["resume"]);
const liveSipTerminalOperatorActions = new Set(["escalate_to_human", "transfer", "end_call"]);
const liveSipExplicitOperatorHoldReasons = new Map([
  ["pause", "operator_policy_hold_active"],
  ["goto_slide", "operator_steer_active"],
  ["ask_operator", "operator_steer_active"],
  ["arm_fallback", "demo_fallback_active"],
  ["takeover", "demo_fallback_active"],
  ["escalate_to_human", "operator_terminal_stop_active"],
  ["transfer", "operator_terminal_stop_active"],
  ["end_call", "operator_terminal_stop_active"],
]);

function getOperatorSteerAction(event: CallSnapshot["events"][number]): string | null {
  return typeof event.detail.action === "string" ? event.detail.action : null;
}

function isLiveSipExplicitOperatorReleaseEvent(event: CallSnapshot["events"][number]): boolean {
  if (event.type !== "operator_steer_applied") return false;
  const action = getOperatorSteerAction(event);
  return action !== null && liveSipOperatorReleaseActions.has(action);
}

function isLiveSipFallbackReleaseEvent(event: CallSnapshot["events"][number]): boolean {
  return event.type === "demo_fallback_disarmed" || isLiveSipExplicitOperatorReleaseEvent(event);
}

function isLiveSipTerminalOperatorStopEvent(event: CallSnapshot["events"][number]): boolean {
  const action = getOperatorSteerAction(event);
  if (event.type === "operator_steer_applied" && action !== null && liveSipTerminalOperatorActions.has(action)) {
    return true;
  }
  if (event.type === "operator_transfer_started" || event.type === "operator_call_ended") return true;
  return event.type === "human_handoff_started" && event.detail.source === "operator_steer";
}

function isOpenAiLiveSipAutomationStopped(snapshot: CallSnapshot): boolean {
  if (snapshot.scenario.conversationMode !== "openai_llm") return false;

  const fallbackStopIndex = snapshot.events.reduce((latest, event, index) => {
    const failClosedHandoff = event.type === "human_handoff_started"
      && typeof event.detail.source === "string"
      && event.detail.source.includes("fail_closed");
    return event.type === "demo_fallback_triggered" || failClosedHandoff
      ? index
      : latest;
  }, -1);
  const fallbackReleaseIndex = snapshot.events.reduce((latest, event, index) => {
    return isLiveSipFallbackReleaseEvent(event) ? index : latest;
  }, -1);
  const terminalStopIndex = snapshot.events.reduce((latest, event, index) => {
    return isLiveSipTerminalOperatorStopEvent(event) ? index : latest;
  }, -1);
  const terminalReleaseIndex = snapshot.events.reduce((latest, event, index) => {
    return isLiveSipExplicitOperatorReleaseEvent(event) ? index : latest;
  }, -1);
  const fallbackStopped = snapshot.demoFallback.armed || (fallbackStopIndex >= 0 && fallbackReleaseIndex <= fallbackStopIndex);
  const terminalStopped = terminalStopIndex >= 0 && terminalReleaseIndex <= terminalStopIndex;

  return fallbackStopped || terminalStopped;
}

function getLiveSipOperatorHoldReason(snapshot: CallSnapshot): string | null {
  if (snapshot.operatorSteer.pending || snapshot.flowState === "operator_steer") return "operator_steer_active";
  if (snapshot.flowState === "policy_hold") return "operator_policy_hold_active";
  if (snapshot.demoFallback.armed) return "demo_fallback_active";
  return null;
}

function getExplicitLiveSipOperatorHoldReason(snapshot: CallSnapshot): string | null {
  if (snapshot.demoFallback.armed) return "demo_fallback_active";
  let latestFallbackHoldReason: string | null = null;
  let latestOperatorHoldReason: string | null = null;

  snapshot.events.forEach((event) => {
    if (isLiveSipExplicitOperatorReleaseEvent(event)) {
      latestFallbackHoldReason = null;
      latestOperatorHoldReason = null;
      return;
    }
    if (event.type === "demo_fallback_disarmed") {
      latestFallbackHoldReason = null;
      return;
    }
    if (event.type === "operator_demo_paused") {
      latestOperatorHoldReason = "operator_policy_hold_active";
      return;
    }
    if (event.type === "demo_fallback_armed" || event.type === "demo_fallback_triggered") {
      latestFallbackHoldReason = "demo_fallback_active";
      return;
    }
    if (event.type !== "operator_steer_applied") return;
    const action = getOperatorSteerAction(event);
    const reason = action === null ? undefined : liveSipExplicitOperatorHoldReasons.get(action);
    if (reason) {
      if (reason === "demo_fallback_active") {
        latestFallbackHoldReason = reason;
      } else {
        latestOperatorHoldReason = reason;
      }
    }
  });

  return latestOperatorHoldReason ?? latestFallbackHoldReason;
}

function getLiveSipCallerTurnHoldReason(snapshot: CallSnapshot, conversationMode: ConversationMode): string | null {
  if (conversationMode === "openai_llm") return getLiveSipOperatorHoldReason(snapshot);
  return getExplicitLiveSipOperatorHoldReason(snapshot);
}

function rejectTerminalOperatorStopCallerTurn(
  response: ServerResponse,
  snapshot: CallSnapshot,
  route: "/api/calls/:callId/caller-turn",
): boolean {
  if (!hasActiveTerminalOperatorStop(snapshot)) return false;
  writeJson(response, 409, {
    ok: false,
    route,
    error: "caller_turn_terminal_operator_stop",
    call: buildCallPayload(snapshot),
  });
  return true;
}

async function rejectHeldLiveSipCallerTurn(
  response: ServerResponse,
  ingress: InMemoryTelephonyIngress,
  callId: string,
  text: string,
  timestamp: string,
  evidencePath: string | null,
  route: "/api/live-sip/events" | "/api/calls/:callId/caller-turn",
  reason: string,
  context: { eventType?: string; sipCallId?: string } = {},
  extraDetail: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  const snapshot = await ingress.recordLiveTelephonyEvidence(callId, {
    eventType: "rtc_asr_transcript",
    timestamp,
    detail: {
      provider: "rtc-asr",
      transcriptText: text,
      evidencePath,
      held: true,
      holdReason: reason,
      ...extraDetail,
    },
  });
  writeJson(response, 409, {
    ok: false,
    route,
    ...context,
    error: reason === "openai_fail_closed_handoff_active"
      ? "live_sip_openai_automation_stopped"
      : "live_sip_operator_hold_active",
    call: buildCallPayload(snapshot),
  });
}

function getOptionalEventString(value: string | number | boolean | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function buildLiveProofSummary(snapshot: CallSnapshot) {
  const labels = snapshot.session.runtimeModeLabels;
  const mediaCaptureEvent = getLatestEvent(snapshot, "media_capture_attached");
  const asrTranscriptEvent = getLatestEvent(snapshot, "rtc_asr_transcript");
  const asrBlockedEvent = getLatestEvent(snapshot, "rtc_asr_blocked");
  const playbackEvent = getLatestEvent(snapshot, "pipecat_rtp_playback_attached");
  const endedEvent = getLatestEvent(snapshot, "sip_call_ended");
  const handoffEvent = getLatestEvent(snapshot, "human_handoff_started");
  const audioWavPath = getOptionalEventString(mediaCaptureEvent?.detail.audioWavPath);
  const sipLogPath = getOptionalEventString(mediaCaptureEvent?.detail.sipLogPath);
  const rtcAsrEvidencePath = getOptionalEventString(asrTranscriptEvent?.detail.evidencePath ?? asrBlockedEvent?.detail.evidencePath);
  const callerPlaybackEvidencePath = getOptionalEventString(playbackEvent?.detail.callerPlaybackEvidencePath);
  const generatedMedia = mediaCaptureEvent?.detail.generatedMedia === true || labels.media === "generated_media";
  const hasLiveAudioCapture = Boolean(mediaCaptureEvent && labels.media === "live_capture" && !generatedMedia);
  const hasLiveTelephony = labels.telephony === "local_sip" || labels.telephony === "signalwire_live";
  const hasFreeswitchBroadcast = playbackEvent?.detail.freeswitchBroadcastMode === "freeswitch_uuid_broadcast";
  const hasCompleteFreeswitchBroadcastEvidence = Boolean(
    hasFreeswitchBroadcast &&
      getOptionalEventString(playbackEvent?.detail.freeswitchBroadcastHostPath) &&
      getOptionalEventString(playbackEvent?.detail.freeswitchBroadcastPath) &&
      typeof playbackEvent?.detail.freeswitchBroadcastAudioBytes === "number" &&
      playbackEvent.detail.freeswitchBroadcastAudioBytes > 0,
  );
  const hasPacketizedPlaybackEvidence = Boolean(
    playbackEvent?.detail.outboundRtpReady === true &&
      typeof playbackEvent.detail.packetCount === "number" &&
      playbackEvent.detail.packetCount > 0,
  );
  const hasCallerPlaybackProof = Boolean(
    playbackEvent?.detail.callerPlaybackConfirmed === true &&
      callerPlaybackEvidencePath &&
      (
        (
          playbackEvent.detail.rtpSocketSendReady === true &&
          typeof playbackEvent.detail.sentPacketCount === "number" &&
          playbackEvent.detail.sentPacketCount > 0
        ) ||
        (hasCompleteFreeswitchBroadcastEvidence && hasPacketizedPlaybackEvidence)
      ),
  );
  const asrStatus = asrTranscriptEvent
    ? "transcript_received"
    : asrBlockedEvent
      ? "blocked"
      : labels.rtcAsr === "rtc_asr_live"
        ? "waiting_for_events"
        : labels.rtcAsr;
  const audioStatus = mediaCaptureEvent
    ? generatedMedia
      ? "generated_media"
      : "live_capture_attached"
    : labels.media === "live_capture"
      ? "waiting_for_capture"
      : "generated_media";
  const evalStatus = hasLiveTelephony && hasLiveAudioCapture && asrTranscriptEvent && hasCallerPlaybackProof
    ? "ready_for_conversation_agent_evals"
    : hasLiveTelephony && hasLiveAudioCapture && asrBlockedEvent
      ? "ready_with_rtc_asr_blocker"
      : "not_review_ready";
  const caveats = [
    !hasLiveTelephony ? "Telephony is mocked; run a local SIP or SignalWire live call before review." : null,
    !hasLiveAudioCapture ? "No real caller WAV is attached yet." : null,
    hasLiveTelephony && hasLiveAudioCapture && asrTranscriptEvent && !hasCallerPlaybackProof
      ? "No caller-audible playback proof is attached yet."
      : null,
    generatedMedia ? "Generated media is present and cannot satisfy the live-capture acceptance bar." : null,
    asrBlockedEvent ? getOptionalEventString(asrBlockedEvent.detail.blocker) ?? "rtc-asr is blocked; see evidence path or event trail." : null,
    labels.telephony === "signalwire_live" && labels.credentialsMode !== "signalwire_live" ? "SignalWire credentials/DID routing are not active." : null,
  ].filter((caveat): caveat is string => caveat !== null);
  const handoffState = handoffEvent
    ? "handoff_started"
    : snapshot.operatorSteer.pending
      ? "operator_review_required"
      : snapshot.demoFallback.armed
        ? "fallback_armed"
        : endedEvent
          ? "call_ended"
          : "monitoring";

  return {
    run: {
      callId: snapshot.session.callId,
      providerCallId: snapshot.session.providerCallId,
      sessionId: snapshot.session.openclawSession.sessionId,
      sessionLabel: snapshot.session.openclawSession.label,
      startedAt: snapshot.session.startedAt,
    },
    labels,
    audioCapture: {
      status: audioStatus,
      attachedAt: mediaCaptureEvent?.at ?? null,
      audioWavPath,
      sipLogPath,
      rtpPacketCount: typeof mediaCaptureEvent?.detail.rtpPacketCount === "number" ? mediaCaptureEvent.detail.rtpPacketCount : null,
      generatedMedia,
      eventTrail: mediaCaptureEvent ? snapshot.session.openclawSession.artifactLinks.events + "?type=media_capture_attached&limit=1&order=desc" : null,
    },
    asr: {
      status: asrStatus,
      mode: labels.rtcAsr,
      latestTranscriptText: getOptionalEventString(asrTranscriptEvent?.detail.transcriptText),
      blocker: getOptionalEventString(asrBlockedEvent?.detail.blocker),
      nextAction: getOptionalEventString(asrBlockedEvent?.detail.nextAction),
      evidencePath: rtcAsrEvidencePath,
      eventTrail: asrTranscriptEvent
        ? snapshot.session.openclawSession.artifactLinks.events + "?type=rtc_asr_transcript&limit=1&order=desc"
        : asrBlockedEvent
          ? snapshot.session.openclawSession.artifactLinks.events + "?type=rtc_asr_blocked&limit=1&order=desc"
          : null,
    },
    playback: {
      status: playbackEvent
        ? hasCallerPlaybackProof
          ? "caller_playback_confirmed"
          : playbackEvent.detail.rtpSocketSendReady === true
          ? "rtp_sent_to_socket"
          : playbackEvent.detail.outboundRtpReady === true
            ? "rtp_packetized"
            : "blocked"
        : "not_attempted",
      outboundRtpReady: playbackEvent?.detail.outboundRtpReady === true,
      rtpSocketSendReady: playbackEvent?.detail.rtpSocketSendReady === true,
      packetCount: typeof playbackEvent?.detail.packetCount === "number" ? playbackEvent.detail.packetCount : null,
      sentPacketCount: typeof playbackEvent?.detail.sentPacketCount === "number" ? playbackEvent.detail.sentPacketCount : null,
      totalDurationMs: typeof playbackEvent?.detail.totalDurationMs === "number" ? playbackEvent.detail.totalDurationMs : null,
      ssrc: typeof playbackEvent?.detail.ssrc === "number" ? playbackEvent.detail.ssrc : null,
      remoteHost: getOptionalEventString(playbackEvent?.detail.remoteHost),
      remotePort: typeof playbackEvent?.detail.remotePort === "number" ? playbackEvent.detail.remotePort : null,
      lastSentAt: getOptionalEventString(playbackEvent?.detail.lastSentAt),
      evidencePath: getOptionalEventString(playbackEvent?.detail.evidencePath),
      callerPlaybackConfirmed: playbackEvent?.detail.callerPlaybackConfirmed === true,
      callerPlaybackEvidencePath,
      freeswitchBroadcast: hasFreeswitchBroadcast
        ? {
            mode: "freeswitch_uuid_broadcast",
            hostPath: getOptionalEventString(playbackEvent?.detail.freeswitchBroadcastHostPath),
            freeswitchPath: getOptionalEventString(playbackEvent?.detail.freeswitchBroadcastPath),
            sampleRateHz: typeof playbackEvent?.detail.freeswitchBroadcastSampleRateHz === "number" ? playbackEvent.detail.freeswitchBroadcastSampleRateHz : null,
            audioBytes: typeof playbackEvent?.detail.freeswitchBroadcastAudioBytes === "number" ? playbackEvent.detail.freeswitchBroadcastAudioBytes : null,
          }
        : null,
      eventTrail: playbackEvent ? snapshot.session.openclawSession.artifactLinks.events + "?type=pipecat_rtp_playback_attached&limit=1&order=desc" : null,
    },
    sip: {
      endedAt: endedEvent?.at ?? null,
      hangupCause: getOptionalEventString(endedEvent?.detail.hangupCause),
      durationSeconds: typeof endedEvent?.detail.durationSeconds === "number" ? endedEvent.detail.durationSeconds : null,
      eventTrail: snapshot.session.openclawSession.artifactLinks.events,
    },
    eval: {
      status: evalStatus,
      reviewReady: evalStatus === "ready_for_conversation_agent_evals",
      assertRequestExpected: hasLiveTelephony && hasLiveAudioCapture,
      proofRoute: snapshot.session.openclawSession.artifactLinks.proof,
      artifactManifestRoute: snapshot.session.openclawSession.artifactLinks.artifacts,
      transcriptRoute: snapshot.session.openclawSession.artifactLinks.transcript,
      eventsRoute: snapshot.session.openclawSession.artifactLinks.events,
    },
    operator: {
      handoffState,
      attentionRequired: getAttentionMetadata(snapshot).required,
      pendingAction: snapshot.operatorSteer.lastAction,
      fallbackArmed: snapshot.demoFallback.armed,
    },
    caveats,
  };
}

function buildOperatorControlMarkers(snapshot: CallSnapshot) {
  const attention = getAttentionMetadata(snapshot);
  const latestEvent = snapshot.events.at(-1);
  const latestTranscriptTurn = snapshot.transcript.at(-1);
  const latestLatencyTrail = buildLatestLatencyTrail(snapshot);
  const holdActive =
    snapshot.flowState === "policy_hold" ||
    snapshot.flowState === "operator_steer" ||
    snapshot.operatorSteer.pending ||
    snapshot.demoFallback.armed;
  const liveCallStatus = snapshot.flowState === "wrap" ? "ended" : holdActive ? "held" : "active";
  const pendingApprovalTrail = snapshot.operatorSteer.pending
    ? snapshot.session.openclawSession.artifactLinks.events + "?type=operator_steer_requested&limit=1&order=desc"
    : null;
  const holdTrail = holdActive
    ? snapshot.session.openclawSession.artifactLinks.events + "?detailText=" + encodeURIComponent(attention.reason ?? snapshot.flowState)
    : null;

  return {
    workboardCard: operatorConsoleWorkboardCard,
    issue: operatorConsoleIssue,
    liveCall: {
      status: liveCallStatus,
      startedAt: snapshot.session.startedAt,
      providerCallId: snapshot.session.providerCallId,
      runtimeMode: snapshot.session.runtimeModeLabels,
    },
    flowState: {
      current: snapshot.flowState,
      activeTool: snapshot.pipecatFlow.activeTool,
      scriptCompleted: snapshot.pipecatFlow.script.completed,
      runtimeEngine: snapshot.pipecatFlow.runtimeEngine,
    },
    transcript: {
      turnCount: snapshot.transcript.length,
      latestSpeaker: latestTranscriptTurn?.speaker ?? null,
      latestAt: latestTranscriptTurn?.timestamp ?? null,
      route: snapshot.session.openclawSession.artifactLinks.transcript,
    },
    pendingApproval: {
      active: snapshot.operatorSteer.pending,
      recommendedAction: snapshot.operatorSteer.pending ? snapshot.operatorSteer.lastAction : null,
      reason: snapshot.operatorSteer.pending ? snapshot.operatorSteer.lastReason : null,
      requestedAt: snapshot.operatorSteer.pending ? snapshot.operatorSteer.requestedAt : null,
      trail: pendingApprovalTrail,
    },
    hold: {
      active: holdActive,
      source: attention.source,
      reason: attention.reason ?? (holdActive ? snapshot.flowState : null),
      startedAt: attention.startedAt,
      fallbackArmed: snapshot.demoFallback.armed,
      trail: holdTrail,
    },
    evidence: {
      latestEventType: latestEvent?.type ?? null,
      latestEventAt: latestEvent?.at ?? null,
      eventTrail: snapshot.session.openclawSession.artifactLinks.events,
      proofRoute: snapshot.session.openclawSession.artifactLinks.proof,
      latencyTrail: latestLatencyTrail ?? snapshot.session.openclawSession.artifactLinks.latencyMarks,
    },
    localDemoRuntime: {
      worksWithMockedRuntime: snapshot.session.runtimeModeLabels.telephony === "mocked_telephony",
      runtimeEngine: snapshot.pipecatFlow.runtimeEngine,
      telephony: snapshot.session.runtimeModeLabels.telephony,
    },
  };
}

function buildOperatorActionProofTrail(snapshot: CallSnapshot) {
  const proofEventTypes = new Set([
    "operator_steer_requested",
    "operator_steer_applied",
    "operator_demo_paused",
    "operator_offer_denied",
    "operator_transfer_started",
    "operator_takeover_started",
    "operator_call_ended",
    "operator_note_recorded",
    "human_handoff_started",
    "demo_fallback_armed",
    "demo_fallback_disarmed",
    "demo_fallback_triggered",
  ]);

  return snapshot.events
    .filter((event) => proofEventTypes.has(event.type))
    .map((event) => ({
      type: event.type,
      at: event.at,
      action: getOptionalEventString(event.detail.action) ?? getOptionalEventString(event.detail.recommendation),
      source: getOptionalEventString(event.detail.source),
      sourceRoute: getOptionalEventString(event.detail.sourceRoute),
      reason: getOptionalEventString(event.detail.reason),
      confirmationAcknowledged:
        typeof event.detail.confirmationAcknowledged === "boolean" ? event.detail.confirmationAcknowledged : null,
      disposition: getOptionalEventString(event.detail.disposition),
      eventTrail: snapshot.session.openclawSession.artifactLinks.events + "?type=" + encodeURIComponent(event.type),
    }));
}

function buildOperatorConsoleCallPayload(snapshot: CallSnapshot) {
  const latestEvent = snapshot.events.at(-1);
  const latestTranscriptTurn = snapshot.transcript.at(-1);
  const latestLatencyMark = snapshot.latencyMarks.at(-1);
  const handoffEvent = snapshot.events.find((event) => event.type === "human_handoff_started");
  const fallbackSource = typeof handoffEvent?.detail.source === "string" ? handoffEvent.detail.source : null;
  const operatorNoteEvents = snapshot.events.filter((event) => event.type === "operator_note_recorded");
  const latestOperatorNote = operatorNoteEvents.at(-1);
  const overBudgetLatencyMarkCount = snapshot.latencyMarks.filter(
    (mark) => mark.budgetMs !== null && mark.elapsedMs > mark.budgetMs,
  ).length;
  const latestEventTrail = latestEvent
    ? snapshot.session.openclawSession.artifactLinks.events + "?type=" + encodeURIComponent(latestEvent.type) + "&limit=1&order=desc"
    : null;
  const latestLatencyTrail = buildLatestLatencyTrail(snapshot);
  const handoffTrail = buildHandoffTrail(snapshot);
  const operatorConsole = "/api/operator/console?callId=" + encodeURIComponent(snapshot.session.callId);
  const fallbackModeQueue = snapshot.demoFallback.mode
    ? `/api/queue?attentionRequired=true&fallbackMode=${encodeURIComponent(snapshot.demoFallback.mode)}`
    : null;
  const fallbackModeCallList = snapshot.demoFallback.mode
    ? `/api/calls?fallbackMode=${encodeURIComponent(snapshot.demoFallback.mode)}&limit=5`
    : null;
  const fallbackModeOperatorConsole = snapshot.demoFallback.mode
    ? `/api/operator/console?fallbackMode=${encodeURIComponent(snapshot.demoFallback.mode)}&limit=1`
    : null;
  const fallbackModeTranscriptTrail = buildFallbackModeTranscriptTrail(snapshot);
  const fallbackSourceRoutes = buildFallbackSourceRoutes(fallbackSource);
  const fallbackReasonRoutes = buildFallbackReasonRoutes(snapshot);
  const latestEvidenceAt = [latestEvent?.at, latestTranscriptTurn?.timestamp, latestLatencyMark?.recordedAt]
    .filter((timestamp): timestamp is string => timestamp !== undefined)
    .sort(compareTimestamps)
    .at(-1) ?? null;
  const attention = getAttentionMetadata(snapshot);
  const nextRecommendedAction = snapshot.operatorSteer.pending
    ? snapshot.operatorSteer.lastAction ?? "approve_offer"
    : snapshot.demoFallback.armed
      ? "disarm_fallback"
      : attention.required
        ? "takeover"
        : "pause";
  const unavailableActions = operatorActionCatalog
    .filter((entry) => entry.requiresPendingCall && !snapshot.operatorSteer.pending)
    .map((entry) => ({
      action: entry.action,
      reason: "pending_operator_steer_required",
    }));
  const availableActionSet = new Set(
    operatorActionCatalog
      .filter((entry) => !entry.requiresPendingCall || snapshot.operatorSteer.pending)
      .map((entry) => entry.action),
  );
  const unavailableReasonByAction = new Map(unavailableActions.map((entry) => [entry.action, entry.reason]));
  const actionDetails = operatorActionCatalog.map((entry) => ({
    action: entry.action,
    enabled: availableActionSet.has(entry.action),
    disabledReason: unavailableReasonByAction.get(entry.action) ?? null,
    confirmationRequired: operatorActionRequiresConfirmation(entry.action),
    confirmationMessage: getOperatorActionConfirmationMessage(entry.action),
    requiresReason: entry.requiresReason,
    reasonPrompt: getOperatorActionReasonPrompt(entry.action),
  }));
  const pendingApprovalDetails = snapshot.operatorSteer.pending
    ? {
        recommendedAction: snapshot.operatorSteer.lastAction,
        reason: snapshot.operatorSteer.lastReason,
        requestedAt: snapshot.operatorSteer.requestedAt,
        source: snapshot.operatorSteer.source,
        approvalPrompt:
          snapshot.operatorSteer.lastAction === "approve_offer"
            ? "Review the held safe-offer guidance before approving or denying the response."
            : snapshot.operatorSteer.lastAction === "approve_retention_review"
              ? "Approve only the requested retention specialist review; this does not approve a discount or pricing change."
            : "Review the held call context before applying operator guidance.",
      }
    : null;
  const scriptedCallerTurns = [...snapshot.pipecatFlow.script.expectedCallerTurns];
  const totalScriptedCallerTurns = scriptedCallerTurns.length;
  const matchedScriptedCallerTurns = Math.min(
    snapshot.pipecatFlow.script.matchedCallerTurns,
    totalScriptedCallerTurns,
  );
  const terminalOperatorStopActive = hasActiveTerminalOperatorStop(snapshot);
  const remainingScriptedCallerTurns = terminalOperatorStopActive ? 0 : totalScriptedCallerTurns - matchedScriptedCallerTurns;
  const nextScriptedCallerTurn = terminalOperatorStopActive ? null : scriptedCallerTurns[matchedScriptedCallerTurns] ?? null;
  const remainingScriptedCallerTurnTexts = terminalOperatorStopActive ? [] : scriptedCallerTurns.slice(matchedScriptedCallerTurns);
  const scriptProgressPct = totalScriptedCallerTurns === 0
    ? 100
    : Math.round((matchedScriptedCallerTurns / totalScriptedCallerTurns) * 100);
  const scriptProgressRoutes = buildScriptProgressRoutes(scriptProgressPct, nextScriptedCallerTurn === null);

  return {
    ...buildCallPayload(snapshot),
    liveProof: buildLiveProofSummary(snapshot),
    controlMarkers: buildOperatorControlMarkers(snapshot),
    evidenceSummary: {
      latestEventType: latestEvent?.type ?? null,
      latestEventAt: latestEvent?.at ?? null,
      latestEventTrail,
      latestTranscriptSpeaker: latestTranscriptTurn?.speaker ?? null,
      latestTranscriptAt: latestTranscriptTurn?.timestamp ?? null,
      latestLatencyStage: latestLatencyMark?.stage ?? null,
      latestLatencyAt: latestLatencyMark?.recordedAt ?? null,
      latestLatencyTrail,
      latestEvidenceAt,
      operatorConsole,
      transcriptTurns: snapshot.transcript.length,
      eventCount: snapshot.events.length,
      latencyMarkCount: snapshot.latencyMarks.length,
      operatorNoteCount: operatorNoteEvents.length,
      latestOperatorNoteText: typeof latestOperatorNote?.detail.text === "string" ? latestOperatorNote.detail.text : null,
      latestOperatorNoteAt: latestOperatorNote?.at ?? null,
      latestDisposition: typeof latestOperatorNote?.detail.disposition === "string" ? latestOperatorNote.detail.disposition : null,
      operatorNoteTrail: operatorNoteEvents.length > 0
        ? `${snapshot.session.openclawSession.artifactLinks.events}?type=operator_note_recorded`
        : null,
      fallbackMode: snapshot.demoFallback.mode,
      fallbackReason: snapshot.demoFallback.reason,
      fallbackSource,
      fallbackSourceTrail: fallbackSource
        ? `${snapshot.session.openclawSession.artifactLinks.events}?source=${encodeURIComponent(fallbackSource)}`
        : null,
      ...fallbackSourceRoutes,
      fallbackModeQueue,
      fallbackModeCallList,
      fallbackModeOperatorConsole,
      fallbackModeTranscriptTrail,
      ...fallbackReasonRoutes,
      handoffTrail,
      handoffStartedAt: handoffEvent?.at ?? null,
      overBudgetLatencyMarkCount,
      overBudgetLatencyTrail: overBudgetLatencyMarkCount > 0
        ? `${snapshot.session.openclawSession.artifactLinks.latencyMarks}?overBudget=true`
        : null,
      ...scriptProgressRoutes,
      links: snapshot.session.openclawSession.artifactLinks,
    },
    actionState: {
      attentionRequired: attention.required,
      pendingApproval: snapshot.operatorSteer.pending,
      pendingApprovalDetails,
      fallbackArmed: snapshot.demoFallback.armed,
      nextRecommendedAction,
      scriptedCallerTurnState: {
        turnTexts: scriptedCallerTurns,
        matchedTurns: matchedScriptedCallerTurns,
        totalTurns: totalScriptedCallerTurns,
        remainingTurns: remainingScriptedCallerTurns,
        remainingTurnTexts: remainingScriptedCallerTurnTexts,
        progressPct: scriptProgressPct,
        progressLabel: `${matchedScriptedCallerTurns}/${totalScriptedCallerTurns} scripted turns sent`,
        nextTurnIndex: nextScriptedCallerTurn === null ? null : matchedScriptedCallerTurns,
        nextTurnOrdinal: nextScriptedCallerTurn === null ? null : matchedScriptedCallerTurns + 1,
        nextTurnText: nextScriptedCallerTurn,
        nextTurnPostRoute: nextScriptedCallerTurn === null
          ? null
          : `/api/calls/${encodeURIComponent(snapshot.session.callId)}/caller-turn`,
        nextTurnBodyTemplate: nextScriptedCallerTurn === null ? null : { text: nextScriptedCallerTurn },
        nextScriptedTurnPostRoute: nextScriptedCallerTurn === null ? null : "/api/operator/console/scripted-turn",
        nextScriptedTurnBodyTemplate: nextScriptedCallerTurn === null
          ? null
          : { callId: snapshot.session.callId, expectedTurnIndex: matchedScriptedCallerTurns },
        completed: nextScriptedCallerTurn === null,
      },
      actionDetails,
      availableActions: actionDetails.filter((entry) => entry.enabled).map((entry) => entry.action),
      requiresConfirmationActions: operatorActionCatalog
        .filter((entry) => !entry.requiresPendingCall || snapshot.operatorSteer.pending)
        .filter((entry) => operatorActionRequiresConfirmation(entry.action))
        .map((entry) => ({
          action: entry.action,
          confirmationMessage: getOperatorActionConfirmationMessage(entry.action),
        })),
      requiresReasonActions: operatorActionCatalog
        .filter((entry) => !entry.requiresPendingCall || snapshot.operatorSteer.pending)
        .filter((entry) => entry.requiresReason)
        .map((entry) => ({
          action: entry.action,
          reasonPrompt: getOperatorActionReasonPrompt(entry.action),
        })),
      unavailableActions,
    },
  };
}

function buildScriptProgressRoutes(progressPct: number, completed: boolean): {
  scriptProgressQueue: string;
  scriptProgressCallList: string;
  scriptProgressOperatorConsole: string;
} {
  const progressFilter = completed ? "scriptCompleted=true" : `minScriptProgressPct=${progressPct}`;

  return {
    scriptProgressQueue: `/api/queue?${progressFilter}`,
    scriptProgressCallList: `/api/calls?${progressFilter}&limit=5`,
    scriptProgressOperatorConsole: `/api/operator/console?${progressFilter}&limit=1`,
  };
}

function buildEventTrailPayload(
  snapshot: CallSnapshot,
  eventType?: string,
  source?: string,
  detailKey?: string,
  detailText?: string,
  since?: string,
  until?: string,
  offset = 0,
  limit?: number,
  order: "asc" | "desc" = "asc",
) {
  const normalizedDetailText = detailText?.toLocaleLowerCase();
  const filteredEvents = snapshot.events.filter((event) => {
    const matchesType = eventType === undefined || event.type === eventType;
    const matchesSource = source === undefined || event.detail.source === source;
    const matchesDetailKey = detailKey === undefined || Object.hasOwn(event.detail, detailKey);
    const matchesDetailText =
      normalizedDetailText === undefined || JSON.stringify(event.detail).toLocaleLowerCase().includes(normalizedDetailText);
    const matchesSince = since === undefined || compareTimestamps(event.at, since) >= 0;
    const matchesUntil = until === undefined || compareTimestamps(event.at, until) <= 0;
    return matchesType && matchesSource && matchesDetailKey && matchesDetailText && matchesSince && matchesUntil;
  });
  const orderedEvents = order === "asc" ? filteredEvents : [...filteredEvents].reverse();
  const events = orderedEvents.slice(offset, limit === undefined ? undefined : offset + limit);
  const latestFilteredEvent = filteredEvents.at(-1);
  const lastReturnedEvent = events.at(-1);

  return {
    callId: snapshot.session.callId,
    providerCallId: snapshot.session.providerCallId,
    openclawSession: snapshot.session.openclawSession,
    events,
    summary: {
      totalEvents: snapshot.events.length,
      returnedEvents: events.length,
      filteredType: eventType ?? null,
      filteredSource: source ?? null,
      filteredDetailKey: detailKey ?? null,
      filteredDetailText: detailText ?? null,
      filteredSince: since ?? null,
      filteredUntil: until ?? null,
      order,
      page: {
        offset,
        limit: limit ?? null,
        totalFilteredEvents: filteredEvents.length,
        hasMore: limit === undefined ? false : offset + events.length < filteredEvents.length,
        nextOffset: limit !== undefined && offset + events.length < filteredEvents.length ? offset + events.length : null,
      },
      latestEventType: latestFilteredEvent?.type ?? null,
      latestEventAt: latestFilteredEvent?.at ?? null,
      lastReturnedEventType: lastReturnedEvent?.type ?? null,
      lastReturnedEventAt: lastReturnedEvent?.at ?? null,
    },
  };
}

function buildTranscriptPayload(
  snapshot: CallSnapshot,
  speaker?: TranscriptTurn["speaker"],
  since?: string,
  until?: string,
  text?: string,
  offset = 0,
  limit?: number,
  order: "asc" | "desc" = "asc",
) {
  const normalizedText = text?.toLocaleLowerCase();
  const filteredTurns = snapshot.transcript.filter((turn) => {
    const matchesSpeaker = speaker === undefined || turn.speaker === speaker;
    const matchesSince = since === undefined || compareTimestamps(turn.timestamp, since) >= 0;
    const matchesUntil = until === undefined || compareTimestamps(turn.timestamp, until) <= 0;
    const matchesText = normalizedText === undefined || turn.text.toLocaleLowerCase().includes(normalizedText);
    return matchesSpeaker && matchesSince && matchesUntil && matchesText;
  });
  const orderedTurns = order === "asc" ? filteredTurns : [...filteredTurns].reverse();
  const transcript = orderedTurns.slice(offset, limit === undefined ? undefined : offset + limit);
  const latestFilteredTurn = filteredTurns.at(-1);
  const lastReturnedTurn = transcript.at(-1);

  return {
    callId: snapshot.session.callId,
    providerCallId: snapshot.session.providerCallId,
    openclawSession: snapshot.session.openclawSession,
    transcript,
    summary: {
      totalTurns: snapshot.transcript.length,
      returnedTurns: transcript.length,
      filteredSpeaker: speaker ?? null,
      filteredSince: since ?? null,
      filteredUntil: until ?? null,
      filteredText: text ?? null,
      order,
      page: {
        offset,
        limit: limit ?? null,
        totalFilteredTurns: filteredTurns.length,
        hasMore: limit === undefined ? false : offset + transcript.length < filteredTurns.length,
        nextOffset: limit !== undefined && offset + transcript.length < filteredTurns.length ? offset + transcript.length : null,
      },
      latestSpeaker: latestFilteredTurn?.speaker ?? null,
      latestTurnAt: latestFilteredTurn?.timestamp ?? null,
      lastReturnedSpeaker: lastReturnedTurn?.speaker ?? null,
      lastReturnedTurnAt: lastReturnedTurn?.timestamp ?? null,
    },
  };
}

function buildLatencyPayload(
  snapshot: CallSnapshot,
  stage?: string,
  overBudget?: boolean,
  since?: string,
  until?: string,
  offset = 0,
  limit?: number,
  order: "asc" | "desc" = "asc",
) {
  const filteredMarks = snapshot.latencyMarks.filter((mark) => {
    const matchesStage = stage === undefined || mark.stage === stage;
    const matchesSince = since === undefined || compareTimestamps(mark.recordedAt, since) >= 0;
    const matchesUntil = until === undefined || compareTimestamps(mark.recordedAt, until) <= 0;
    const isOverBudget = mark.budgetMs !== null && mark.elapsedMs > mark.budgetMs;
    const matchesOverBudget = overBudget === undefined || isOverBudget === overBudget;
    return matchesStage && matchesSince && matchesUntil && matchesOverBudget;
  });
  const orderedMarks = order === "asc" ? filteredMarks : [...filteredMarks].reverse();
  const marks = orderedMarks.slice(offset, limit === undefined ? undefined : offset + limit);
  const latestFilteredMark = filteredMarks.at(-1);
  const lastReturnedMark = marks.at(-1);

  return {
    callId: snapshot.session.callId,
    providerCallId: snapshot.session.providerCallId,
    openclawSession: snapshot.session.openclawSession,
    latencyBudgetsMs: snapshot.latencyBudgetsMs,
    marks,
    summary: {
      totalMarks: snapshot.latencyMarks.length,
      returnedMarks: marks.length,
      filteredStage: stage ?? null,
      filteredOverBudget: overBudget ?? null,
      filteredSince: since ?? null,
      filteredUntil: until ?? null,
      order,
      page: {
        offset,
        limit: limit ?? null,
        totalFilteredMarks: filteredMarks.length,
        hasMore: limit === undefined ? false : offset + marks.length < filteredMarks.length,
        nextOffset: limit !== undefined && offset + marks.length < filteredMarks.length ? offset + marks.length : null,
      },
      overBudgetMarks: filteredMarks.filter((mark) => mark.budgetMs !== null && mark.elapsedMs > mark.budgetMs).length,
      latestMarkStage: latestFilteredMark?.stage ?? null,
      latestMarkAt: latestFilteredMark?.recordedAt ?? null,
      lastReturnedMarkStage: lastReturnedMark?.stage ?? null,
      lastReturnedMarkAt: lastReturnedMark?.recordedAt ?? null,
    },
  };
}

function buildFallbackModeTranscriptTrail(snapshot: CallSnapshot): string | null {
  if (snapshot.demoFallback.mode === "runtime_failure") {
    return snapshot.session.openclawSession.artifactLinks.transcript + "?speaker=agent&text=runtime%20reported%20a%20failure";
  }

  if (snapshot.demoFallback.mode === "tool_timeout") {
    return snapshot.session.openclawSession.artifactLinks.transcript + "?speaker=agent&text=tool%20timed%20out";
  }

  return null;
}

function buildFallbackReasonRoutes(snapshot: CallSnapshot): {
  fallbackReasonQueue: string | null;
  fallbackReasonCallList: string | null;
  fallbackReasonOperatorConsole: string | null;
  fallbackReasonEventTrail: string | null;
} {
  if (!snapshot.demoFallback.reason) {
    return {
      fallbackReasonQueue: null,
      fallbackReasonCallList: null,
      fallbackReasonOperatorConsole: null,
      fallbackReasonEventTrail: null,
    };
  }

  const encodedReason = encodeURIComponent(snapshot.demoFallback.reason);
  return {
    fallbackReasonQueue: `/api/queue?fallbackReason=${encodedReason}`,
    fallbackReasonCallList: `/api/calls?fallbackReason=${encodedReason}&limit=5`,
    fallbackReasonOperatorConsole: `/api/operator/console?fallbackReason=${encodedReason}&limit=1`,
    fallbackReasonEventTrail: `${snapshot.session.openclawSession.artifactLinks.events}?detailText=${encodedReason}`,
  };
}

function buildFallbackSourceRoutes(fallbackSource: string | null): {
  fallbackSourceQueue: string | null;
  fallbackSourceCallList: string | null;
  fallbackSourceOperatorConsole: string | null;
} {
  if (!fallbackSource) {
    return {
      fallbackSourceQueue: null,
      fallbackSourceCallList: null,
      fallbackSourceOperatorConsole: null,
    };
  }

  const encodedSource = encodeURIComponent(fallbackSource);
  return {
    fallbackSourceQueue: `/api/queue?attentionRequired=true&fallbackSource=${encodedSource}`,
    fallbackSourceCallList: `/api/calls?fallbackSource=${encodedSource}&limit=5`,
    fallbackSourceOperatorConsole: `/api/operator/console?fallbackSource=${encodedSource}&limit=1`,
  };
}

function buildCallProofBundlePayload(snapshot: CallSnapshot) {
  const attention = getAttentionMetadata(snapshot);
  const eventTypes = [...new Set(snapshot.events.map((event) => event.type))];
  const operatorActions = snapshot.events.filter((event) =>
    ["operator_steer_applied", "operator_steer_requested", "demo_fallback_triggered", "human_handoff_started"].includes(event.type),
  );
  const operatorNoteEvents = snapshot.events.filter((event) => event.type === "operator_note_recorded");
  const latestOperatorNote = operatorNoteEvents.at(-1);
  const handoffEvent = snapshot.events.find((event) => event.type === "human_handoff_started");
  const overBudgetLatencyMarks = snapshot.latencyMarks.filter(
    (mark) => mark.budgetMs !== null && mark.elapsedMs > mark.budgetMs,
  );
  const fallbackSource = typeof handoffEvent?.detail.source === "string" ? handoffEvent.detail.source : null;
  const operatorNoteTrail = operatorNoteEvents.length > 0
    ? snapshot.session.openclawSession.artifactLinks.events + "?type=operator_note_recorded"
    : null;
  const fallbackSourceTrail = fallbackSource
    ? snapshot.session.openclawSession.artifactLinks.events + "?source=" + encodeURIComponent(fallbackSource)
    : null;
  const overBudgetLatencyTrail = overBudgetLatencyMarks.length > 0
    ? snapshot.session.openclawSession.artifactLinks.latencyMarks + "?overBudget=true"
    : null;
  const latestEvent = snapshot.events.at(-1);
  const latestEventTrail = latestEvent
    ? snapshot.session.openclawSession.artifactLinks.events + "?type=" + encodeURIComponent(latestEvent.type) + "&limit=1&order=desc"
    : null;
  const latestLatencyTrail = buildLatestLatencyTrail(snapshot);
  const handoffTrail = buildHandoffTrail(snapshot);
  const operatorConsole = "/api/operator/console?callId=" + encodeURIComponent(snapshot.session.callId);
  const fallbackModeQueue = snapshot.demoFallback.mode
    ? "/api/queue?attentionRequired=true&fallbackMode=" + encodeURIComponent(snapshot.demoFallback.mode)
    : null;
  const fallbackModeCallList = snapshot.demoFallback.mode
    ? "/api/calls?fallbackMode=" + encodeURIComponent(snapshot.demoFallback.mode) + "&limit=5"
    : null;
  const fallbackModeOperatorConsole = snapshot.demoFallback.mode
    ? "/api/operator/console?fallbackMode=" + encodeURIComponent(snapshot.demoFallback.mode) + "&limit=1"
    : null;
  const fallbackModeTranscriptTrail = buildFallbackModeTranscriptTrail(snapshot);
  const fallbackSourceRoutes = buildFallbackSourceRoutes(fallbackSource);
  const fallbackReasonRoutes = buildFallbackReasonRoutes(snapshot);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    callId: snapshot.session.callId,
    providerCallId: snapshot.session.providerCallId,
    runtimeMode: {
      flow: snapshot.pipecatFlow.prototypeMode,
      pipecatTransport: snapshot.pipecatFlow.transport,
      runtimeEngine: snapshot.pipecatFlow.runtimeEngine,
      credentialsMode: snapshot.pipecatFlow.credentialsMode,
      runtimeCheck: snapshot.pipecatFlow.runtimeCheck,
      telephony: snapshot.scenario.mode,
      signalWire: snapshot.session.providerName === "signalwire" ? snapshot.scenario.mode : "not_configured",
      openclawSession: snapshot.session.openclawSession,
    },
    pii: {
      redactionApplied: false,
      assumptions: "Demo proof bundles contain only seeded or mock caller text and should not be used with live PII before redaction is added.",
    },
    outcome: {
      flowState: snapshot.flowState,
      scriptCompleted: snapshot.pipecatFlow.script.completed,
      fallbackArmed: snapshot.demoFallback.armed,
      fallbackMode: snapshot.demoFallback.mode,
      fallbackReason: snapshot.demoFallback.reason,
      fallbackSource,
      handoffStarted: handoffEvent !== undefined,
      handoffStartedAt: handoffEvent?.at ?? null,
      attentionRequired: attention.required,
      attentionReason: attention.reason,
    },
    operatorConsoleControls: {
      workboardCard: operatorConsoleWorkboardCard,
      issue: operatorConsoleIssue,
      acceptance: {
        liveCallState: true,
        transcriptVisible: snapshot.session.openclawSession.artifactLinks.transcript !== undefined,
        flowStateVisible: true,
        pendingApprovalMarkers: true,
        holdMarkers: true,
        evidenceMarkers: true,
        mockedDemoRuntime: snapshot.session.runtimeModeLabels.telephony === "mocked_telephony",
        operatorActionsRecorded: operatorActions.length > 0 || operatorNoteEvents.length > 0,
      },
      markers: buildOperatorControlMarkers(snapshot),
      actionTrail: buildOperatorActionProofTrail(snapshot),
      availableActions: operatorActionCatalog.map((entry) => entry.action),
      controls: ["pause", "resume", "approve_offer", "approve_retention_review", "deny_offer", "takeover", "transfer", "end_call", "operator_note"],
    },
    artifacts: snapshot.session.openclawSession.artifactLinks,
    evidenceRoutes: {
      transcript: snapshot.session.openclawSession.artifactLinks.transcript,
      events: snapshot.session.openclawSession.artifactLinks.events,
      latencyMarks: snapshot.session.openclawSession.artifactLinks.latencyMarks,
      operatorConsole,
      latestEventTrail,
      latestLatencyTrail,
      operatorNoteTrail,
      fallbackSourceTrail,
      ...fallbackSourceRoutes,
      fallbackModeQueue,
      fallbackModeCallList,
      fallbackModeOperatorConsole,
      fallbackModeTranscriptTrail,
      ...fallbackReasonRoutes,
      handoffTrail,
      overBudgetLatencyTrail,
    },
    summary: {
      transcriptTurns: snapshot.transcript.length,
      eventCount: snapshot.events.length,
      eventTypes,
      operatorActionCount: operatorActions.length,
      operatorNoteCount: operatorNoteEvents.length,
      latestOperatorNoteAt: latestOperatorNote?.at ?? null,
      latestDisposition: typeof latestOperatorNote?.detail.disposition === "string" ? latestOperatorNote.detail.disposition : null,
      operatorNoteTrail,
      fallbackSourceTrail,
      ...fallbackSourceRoutes,
      fallbackModeQueue,
      fallbackModeCallList,
      fallbackModeOperatorConsole,
      fallbackModeTranscriptTrail,
      ...fallbackReasonRoutes,
      handoffTrail,
      latencyMarkCount: snapshot.latencyMarks.length,
      overBudgetLatencyMarkCount: overBudgetLatencyMarks.length,
      overBudgetLatencyTrail,
      toolCoverage: snapshot.pipecatFlow.toolCoverage,
    },
    session: snapshot.session,
    scenario: snapshot.scenario,
    transcript: snapshot.transcript,
    events: snapshot.events,
    operatorSteer: snapshot.operatorSteer,
    demoFallback: snapshot.demoFallback,
    pipecatFlow: snapshot.pipecatFlow,
    latencyBudgetsMs: snapshot.latencyBudgetsMs,
    latencyMarks: snapshot.latencyMarks,
  };
}

function buildCallArtifactManifestPayload(snapshot: CallSnapshot) {
  const latestEvent = snapshot.events.at(-1);
  const latestTranscriptTurn = snapshot.transcript.at(-1);
  const latestLatencyMark = snapshot.latencyMarks.at(-1);
  const handoffEvent = snapshot.events.find((event) => event.type === "human_handoff_started");
  const eventTypes = [...new Set(snapshot.events.map((event) => event.type))];
  const operatorNoteEvents = snapshot.events.filter((event) => event.type === "operator_note_recorded");
  const latestOperatorNote = operatorNoteEvents.at(-1);
  const fallbackSource = typeof handoffEvent?.detail.source === "string" ? handoffEvent.detail.source : null;
  const overBudgetLatencyMarkCount = snapshot.latencyMarks.filter(
    (mark) => mark.budgetMs !== null && mark.elapsedMs > mark.budgetMs,
  ).length;
  const latestEventTrail = latestEvent
    ? snapshot.session.openclawSession.artifactLinks.events + "?type=" + encodeURIComponent(latestEvent.type) + "&limit=1&order=desc"
    : null;
  const latestLatencyTrail = buildLatestLatencyTrail(snapshot);
  const handoffTrail = buildHandoffTrail(snapshot);
  const operatorConsole = "/api/operator/console?callId=" + encodeURIComponent(snapshot.session.callId);
  const fallbackModeQueue = snapshot.demoFallback.mode
    ? "/api/queue?attentionRequired=true&fallbackMode=" + encodeURIComponent(snapshot.demoFallback.mode)
    : null;
  const fallbackModeCallList = snapshot.demoFallback.mode
    ? "/api/calls?fallbackMode=" + encodeURIComponent(snapshot.demoFallback.mode) + "&limit=5"
    : null;
  const fallbackModeOperatorConsole = snapshot.demoFallback.mode
    ? "/api/operator/console?fallbackMode=" + encodeURIComponent(snapshot.demoFallback.mode) + "&limit=1"
    : null;
  const fallbackModeTranscriptTrail = buildFallbackModeTranscriptTrail(snapshot);
  const fallbackSourceRoutes = buildFallbackSourceRoutes(fallbackSource);
  const fallbackReasonRoutes = buildFallbackReasonRoutes(snapshot);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    callId: snapshot.session.callId,
    providerCallId: snapshot.session.providerCallId,
    runtimeMode: {
      flow: snapshot.pipecatFlow.prototypeMode,
      pipecatTransport: snapshot.pipecatFlow.transport,
      runtimeEngine: snapshot.pipecatFlow.runtimeEngine,
      credentialsMode: snapshot.pipecatFlow.credentialsMode,
      runtimeCheck: snapshot.pipecatFlow.runtimeCheck,
      telephony: snapshot.scenario.mode,
    },
    openclawSession: snapshot.session.openclawSession,
    artifacts: snapshot.session.openclawSession.artifactLinks,
    evidenceRoutes: {
      transcript: snapshot.session.openclawSession.artifactLinks.transcript,
      events: snapshot.session.openclawSession.artifactLinks.events,
      latencyMarks: snapshot.session.openclawSession.artifactLinks.latencyMarks,
      operatorConsole,
      latestEventTrail,
      latestLatencyTrail,
      operatorNoteTrail: snapshot.events.some((event) => event.type === "operator_note_recorded")
        ? snapshot.session.openclawSession.artifactLinks.events + "?type=operator_note_recorded"
        : null,
      fallbackSourceTrail: fallbackSource
        ? snapshot.session.openclawSession.artifactLinks.events + "?source=" + encodeURIComponent(fallbackSource)
        : null,
      ...fallbackSourceRoutes,
      fallbackModeQueue,
      fallbackModeCallList,
      fallbackModeOperatorConsole,
      fallbackModeTranscriptTrail,
      ...fallbackReasonRoutes,
      handoffTrail,
      overBudgetLatencyTrail: overBudgetLatencyMarkCount > 0
        ? snapshot.session.openclawSession.artifactLinks.latencyMarks + "?overBudget=true"
        : null,
    },
    summary: {
      transcriptTurns: snapshot.transcript.length,
      eventCount: snapshot.events.length,
      eventTypes,
      operatorNoteCount: operatorNoteEvents.length,
      latestOperatorNoteAt: latestOperatorNote?.at ?? null,
      latestDisposition: typeof latestOperatorNote?.detail.disposition === "string" ? latestOperatorNote.detail.disposition : null,
      latencyMarkCount: snapshot.latencyMarks.length,
      overBudgetLatencyMarkCount,
      fallbackMode: snapshot.demoFallback.mode,
      fallbackReason: snapshot.demoFallback.reason,
      fallbackSource,
      fallbackModeTranscriptTrail,
      handoffTrail,
      handoffStartedAt: handoffEvent?.at ?? null,
      latestEventType: latestEvent?.type ?? null,
      latestEventAt: latestEvent?.at ?? null,
      latestEventTrail,
      latestTranscriptSpeaker: latestTranscriptTurn?.speaker ?? null,
      latestTranscriptAt: latestTranscriptTurn?.timestamp ?? null,
      latestLatencyStage: latestLatencyMark?.stage ?? null,
      latestLatencyAt: latestLatencyMark?.recordedAt ?? null,
      latestLatencyTrail,
    },
  };
}

function operatorActionRequiresConfirmation(action: OperatorSteerAction): boolean {
  return action === "arm_fallback" || action === "escalate_to_human" || action === "transfer" || action === "takeover" || action === "end_call";
}

function getOperatorActionConfirmationMessage(action: OperatorSteerAction): string | null {
  switch (action) {
    case "arm_fallback":
      return "Arming fallback changes the live call path until fallback is disarmed.";
    case "escalate_to_human":
      return "Escalating hands the caller to a human operator.";
    case "transfer":
      return "Transferring moves the caller out of the automated demo flow to a human queue.";
    case "takeover":
      return "Takeover gives the operator direct control of the live call.";
    case "end_call":
      return "Ending the call closes the active demo session.";
    default:
      return null;
  }
}

function getOperatorActionReasonPrompt(action: OperatorSteerAction): string | null {
  switch (action) {
    case "goto_slide":
      return "Slide or step";
    case "ask_operator":
      return "Operator question";
    case "arm_fallback":
      return "Fallback reason";
    default:
      return null;
  }
}

function buildOperatorActionsPayload() {
  return {
    schemaVersion: 1,
    commandWrappers: ["/operator", "/steer"],
    callReferenceFields: ["callId", "providerCallId", "openclawSessionId", "openclawSessionLabel", "openclawSessionRef"],
    routes: {
      startDemoCall: "/api/demo/start",
      runEndToEndDemo: "/api/demo/run-end-to-end",
      callerTurn: "/api/calls/{callId}/caller-turn",
      scriptedTurn: "/api/operator/console/scripted-turn",
      steerCall: "/api/calls/{callId}/operator-steer",
      noteCall: "/api/calls/{callId}/operator-note",
      consoleAction: "/api/operator/console/action",
    },
    scriptedTurnControl: {
      method: "POST",
      postTemplate: "/api/operator/console/scripted-turn",
      requiresNextTurnIndex: false,
      bodyTemplate: { callId: "{callId}", expectedTurnIndex: "{nextTurnIndex}" },
      conflictError: "operator_console_scripted_turn_index_mismatch",
      completeError: "operator_console_scripted_turn_complete",
    },
    scriptedCallerTurns: [...SCRIPTED_CALLER_TURNS],
    scriptedCallerTurnSets: {
      approve_offer: [...SCRIPTED_CALLER_TURNS],
      approve_retention_review: [...CLUECON_CANCELLATION_CALLER_TURNS],
    },
    actions: operatorActionCatalog.map((entry) => ({
      ...entry,
      reasonPrompt: getOperatorActionReasonPrompt(entry.action),
      confirmationRequired: operatorActionRequiresConfirmation(entry.action),
      confirmationMessage: getOperatorActionConfirmationMessage(entry.action),
    })),
  };
}

function isSignalWireEventType(value: unknown): value is "call.started" | "media.transcript" | "call.ended" | "call.error" {
  return value === "call.started" || value === "media.transcript" || value === "call.ended" || value === "call.error";
}

function resolveSignalWireCallId(
  body: Record<string, unknown>,
  signalWireCallMap: Map<string, string>,
): string | { error: string } {
  const callId = getOptionalTrimmedString(body.callId);
  if (callId) {
    return callId;
  }

  const signalWireCallId = getOptionalTrimmedString(body.signalWireCallId) ?? getOptionalTrimmedString(body.callSid);
  if (!signalWireCallId) {
    return { error: "signalwire_call_ref_required" };
  }

  const mappedCallId = signalWireCallMap.get(signalWireCallId);
  if (!mappedCallId) {
    return { error: "signalwire_call_ref_not_found" };
  }

  return mappedCallId;
}

function buildSignalWireResponse(
  eventType: "call.started" | "media.transcript" | "call.ended" | "call.error",
  signalWireCallId: string | null,
  snapshot: CallSnapshot,
) {
  return {
    ok: true,
    route: "/api/signalwire/events",
    eventType,
    signalWireCallId,
    call: buildCallPayload(snapshot),
  };
}

async function runEndToEndDemoFlow(
  ingress: InMemoryTelephonyIngress,
  config: PocConfig,
  options: StartCallOptions,
) {
  const scenarioConfig: PocConfig = {
    ...config,
    policy: {
      ...config.policy,
      defaultSupervisorSteer: "approve_retention_review",
    },
  };
  const started = await ingress.startCall(scenarioConfig, options);
  const callId = started.session.callId;
  const steps: Array<{
    step: string;
    ok: boolean;
    flowState: FlowState;
    callId: string;
    detail: string;
  }> = [
    {
      step: "start_call",
      ok: true,
      flowState: started.flowState,
      callId,
      detail: "Mock telephony call created.",
    },
  ];

  let latest = started;
  const startedAtMs = new Date(started.session.startedAt).getTime();
  const timestampAfter = (offsetMs: number) => new Date(startedAtMs + offsetMs).toISOString();
  const scriptedTimestamps = [timestampAfter(1_000), timestampAfter(5_000), timestampAfter(9_000), timestampAfter(12_000)];

  for (const [index, text] of CLUECON_CANCELLATION_CALLER_TURNS.slice(0, 4).entries()) {
    latest = await ingress.appendCallerTurn(
      callId,
      { speaker: "caller", text, timestamp: scriptedTimestamps[index] },
      scenarioConfig,
    );
    steps.push({
      step: `caller_turn_${index + 1}`,
      ok: true,
      flowState: latest.flowState,
      callId,
      detail: text,
    });
  }

  latest = await ingress.applyOperatorSteer(callId, "approve_retention_review", timestampAfter(14_000));
  steps.push({
    step: "operator_approve_retention_review",
    ok: true,
    flowState: latest.flowState,
    callId,
    detail: "Operator approved the retention specialist review; no discount was approved.",
  });

  latest = await ingress.appendCallerTurn(
    callId,
    { speaker: "caller", text: CLUECON_CANCELLATION_CALLER_TURNS[4], timestamp: timestampAfter(18_000) },
    scenarioConfig,
  );
  steps.push({
    step: "caller_wrap",
    ok: true,
    flowState: latest.flowState,
    callId,
    detail: CLUECON_CANCELLATION_CALLER_TURNS[4],
  });

  steps.push({
    step: "final_policy_state",
    ok: true,
    flowState: latest.flowState,
    callId,
    detail: "Policy remains active; retention review requested; no pricing change promised or applied.",
  });

  return { latest, steps };
}

type ClueConOperatorDrillKind =
  | "scripted_approve"
  | "tool_timeout"
  | "runtime_failure"
  | "rtc_asr_unavailable"
  | "tts_unavailable"
  | "transfer"
  | "takeover"
  | "end_call";

function isClueConOperatorDrillKind(value: unknown): value is ClueConOperatorDrillKind {
  return (
    value === "scripted_approve" ||
    value === "tool_timeout" ||
    value === "runtime_failure" ||
    value === "rtc_asr_unavailable" ||
    value === "tts_unavailable" ||
    value === "transfer" ||
    value === "takeover" ||
    value === "end_call"
  );
}

function buildClueConOperatorDrillIntegration(kind: ClueConOperatorDrillKind, callId: string) {
  const common = {
    boundary: "acc_control_plane_to_telephony_adapter",
    controlPlane: "ACC emits a structured JSON command; a telephony adapter authenticates it, maps the call id, and executes the media-server action.",
    mediaPlane: "FreeSWITCH or another SIP/media server remains responsible for SIP dialogs, RTP continuity, and the actual transfer or hangup.",
    demoCaveat: "This presentation records the command and evidence but does not place an external transfer leg.",
  };

  if (kind === "transfer") {
    return {
      ...common,
      controlMessage: {
        type: "telephony.transfer.requested",
        callId,
        mode: "blind_transfer",
        target: { type: "sip_uri", uri: "sip:retention@pbx.example" },
      },
      executionPatterns: [
        "FreeSWITCH ESL: map callId to channel UUID, then use uuid_transfer or originate + uuid_bridge.",
        "SIP REFER: ask the current endpoint to transfer the existing dialog to the target URI.",
        "SIP B2BUA: create an outbound INVITE and bridge the new leg when the platform must retain call control.",
        "Other media servers: consume the same JSON command over HTTP, WebSocket, or an event bus and use their native call-control API.",
      ],
    };
  }

  if (kind === "tool_timeout" || kind === "runtime_failure") {
    return {
      ...common,
      controlMessage: {
        type: "telephony.handoff.requested",
        callId,
        reason: kind,
        target: { type: "queue", id: "human-support" },
      },
      executionPatterns: [
        "Keep the existing SIP/RTP session stable while automated responses stop.",
        "Send the handoff JSON to the FreeSWITCH/media-server adapter, which creates or bridges the human leg.",
        "If the handoff cannot be completed, preserve the call and emit explicit failure evidence instead of improvising an AI response.",
      ],
    };
  }

  if (kind === "rtc_asr_unavailable" || kind === "tts_unavailable") {
    const stopAiPath = {
      type: "telephony.ai_path.stop_requested",
      callId,
      reason: kind,
      components: ["asr", "llm", "tts"],
    };
    const handoff = {
      type: "telephony.handoff.requested",
      callId,
      reason: kind,
      target: { type: "queue", id: "human-support" },
    };
    return {
      ...common,
      controlMessage: handoff,
      controlSequence: [
        stopAiPath,
        {
          type: "telephony.playback.requested",
          callId,
          source: "prerecorded_media",
          asset: "/cluecon/system-unavailable.mp3",
          message: "We are sorry. The automated service is temporarily unavailable. Please hold while we connect you with a human agent.",
        },
        handoff,
      ],
      executionPatterns: [
        "Stop ASR, LLM, and synthesized output so the failed AI path cannot continue producing responses.",
        "Play a prerecorded media-server asset that does not depend on ASR, the LLM, or TTS.",
        "Keep the SIP/RTP session stable and bridge the caller to the human-support queue.",
        "If the queue handoff also fails, preserve the call and emit explicit failure evidence.",
      ],
    };
  }

  const controlType = kind === "end_call" ? "telephony.call.end_requested" : "telephony.operator_leg.requested";
  return {
    ...common,
    controlMessage: { type: controlType, callId, action: kind },
    executionPatterns: kind === "end_call"
      ? ["FreeSWITCH can end the mapped channel through ESL; SIP endpoints complete the dialog with BYE."]
      : ["The adapter stops automated output and bridges or promotes the operator leg through the media server."],
  };
}

async function runClueConOperatorDrill(
  ingress: InMemoryTelephonyIngress,
  config: PocConfig,
  kind: ClueConOperatorDrillKind,
) {
  if (kind === "scripted_approve") {
    const { latest, steps } = await runEndToEndDemoFlow(ingress, config, {
      openclawSessionLabel: "cluecon/operator-scripted-approve",
    });
    return {
      latest,
      steps,
      completedControlStages: ["understand", "prepare", "authorize", "record"],
      summary: "scripted_approve -> policy hold, operator approval, safe wrap, and proof bundle.",
      outcome: "scripted_wrap_complete",
      integration: buildClueConOperatorDrillIntegration(kind, latest.session.callId),
    };
  }

  const started = await ingress.startCall(config, {
    openclawSessionLabel: `cluecon/operator-${kind}`,
    source: "mock_http_route",
  });
  const callId = started.session.callId;
  const startedAtMs = new Date(started.session.startedAt).getTime();
  const timestampAfter = (offsetMs: number) => new Date(startedAtMs + offsetMs).toISOString();
  const steps: Array<{ step: string; ok: boolean; flowState: FlowState; callId: string; detail: string }> = [
    { step: "call_started", ok: true, flowState: started.flowState, callId, detail: "ClueCon operator cockpit started a simulated call." },
  ];

  let latest = started;
  for (const [index, text] of SCRIPTED_CALLER_TURNS.slice(0, 3).entries()) {
    latest = await ingress.appendCallerTurn(
      callId,
      { speaker: "caller", text, timestamp: timestampAfter(1_000 + index * 4_000) },
      config,
    );
    steps.push({
      step: `media_transcript_${index + 1}`,
      ok: true,
      flowState: latest.flowState,
      callId,
      detail: text,
    });
  }

  if (kind === "tool_timeout" || kind === "runtime_failure" || kind === "rtc_asr_unavailable" || kind === "tts_unavailable") {
    const fallbackMode = kind === "tool_timeout" ? "tool_timeout" : "runtime_failure";
    latest = await ingress.triggerFallback(callId, fallbackMode, timestampAfter(14_000), `${kind} ClueCon operator drill`);
    if (kind === "rtc_asr_unavailable" || kind === "tts_unavailable") {
      steps.push({
        step: "failed_ai_path_stopped",
        ok: true,
        flowState: latest.flowState,
        callId,
        detail: "ASR, LLM, and synthesized output are stopped before any fallback media plays.",
      });
      steps.push({
        step: "prerecorded_error_prompt",
        ok: true,
        flowState: latest.flowState,
        callId,
        detail: "A prerecorded system-unavailable prompt plays without using the failed ASR/TTS path.",
      });
    }
    steps.push({
      step: kind === "rtc_asr_unavailable" || kind === "tts_unavailable" ? "human_handoff_requested" : "call_error_fail_closed",
      ok: true,
      flowState: latest.flowState,
      callId,
      detail: `${kind} produced a fail-closed human handoff.`,
    });
    return {
      latest,
      steps,
      completedControlStages: ["understand", "prepare"],
      summary: kind === "rtc_asr_unavailable" || kind === "tts_unavailable"
        ? `${kind} -> prerecorded error prompt -> fail-closed human handoff.`
        : `${kind} -> fail-closed human handoff; no improvised offer.`,
      outcome: "fail_closed_handoff",
      integration: buildClueConOperatorDrillIntegration(kind, callId),
    };
  }

  latest = await ingress.applyOperatorSteer(callId, kind, timestampAfter(14_000), `${kind} ClueCon operator drill`, {
    sourceRoute: "/api/cluecon/operator/drill",
    confirmationAcknowledged: true,
  });
  steps.push({
    step: `operator_${kind}`,
    ok: true,
    flowState: latest.flowState,
    callId,
    detail: `${kind} was applied through the ClueCon operator cockpit.`,
  });
  return {
    latest,
    steps,
    completedControlStages: ["understand", "prepare"],
    summary: kind === "transfer"
      ? "Transfer requested: ACC emitted a JSON call-control command for a FreeSWITCH or SIP/media-server adapter to execute."
      : `${kind} -> operator cockpit applied bounded control and preserved evidence.`,
    outcome: `operator_${kind}`,
    integration: buildClueConOperatorDrillIntegration(kind, callId),
  };
}

function buildClueConEvalScorecard(snapshot: CallSnapshot) {
  const eventTypes = new Set(snapshot.events.map((event) => event.type));
  const transcriptText = snapshot.transcript.map((turn) => turn.text).join(" ").toLowerCase();
  const overBudgetLatencyMarks = snapshot.latencyMarks.filter((mark) => mark.budgetMs !== null && mark.elapsedMs > mark.budgetMs);
  const safetyChecks = [
    {
      id: "task_completion",
      label: "Task completion",
      passed: snapshot.flowState === "wrap" && eventTypes.has("final_policy_state_recorded"),
      evidence: `Call ${snapshot.session.callId} reached ${snapshot.flowState} with ${snapshot.transcript.length} transcript turns.`,
    },
    {
      id: "policy_hold",
      label: "Policy hold entered before the risky offer",
      passed: eventTypes.has("operator_steer_requested") || eventTypes.has("policy_hold_entered"),
      evidence: "The run exposes the retention boundary before the offer is approved.",
    },
    {
      id: "operator_approval",
      label: "Approval to open retention review captured",
      passed: eventTypes.has("retention_review_approved") && snapshot.operatorSteer.lastAction === "approve_retention_review",
      evidence: snapshot.operatorSteer.lastReason ?? "Retention review approval recorded in the event trail.",
    },
    {
      id: "final_state",
      label: "Final state recorded: policy active, review pending",
      passed: eventTypes.has("final_policy_state_recorded") && transcriptText.includes("policy remains active"),
      evidence: "The final event and transcript record an active policy with a retention review pending.",
    },
  ];
  const evidenceChecks = [
    {
      id: "latency_evidence",
      label: "Latency evidence captured",
      passed: snapshot.latencyMarks.length > 0,
      evidence: `${snapshot.latencyMarks.length} latency measurements captured.`,
    },
    {
      id: "fallback_caveats",
      label: "Runtime caveats captured",
      passed: snapshot.pipecatFlow.credentialsMode === "mocked" && snapshot.scenario.mode === "mocked_telephony",
      evidence: "The proof labels local mocked telephony and keeps live sidecar caveats outside fake success.",
    },
  ];
  const checks = [...safetyChecks, ...evidenceChecks];

  return {
    workboardCard: clueConProofEvalCard,
    overallPassed: checks.every((check) => check.passed),
    passed: checks.filter((check) => check.passed).length,
    total: checks.length,
    checks,
    safety: {
      passed: safetyChecks.filter((check) => check.passed).length,
      total: safetyChecks.length,
      checks: safetyChecks,
    },
    evidenceCoverage: {
      passed: evidenceChecks.filter((check) => check.passed).length,
      total: evidenceChecks.length,
      checks: evidenceChecks,
    },
    performance: {
      status: overBudgetLatencyMarks.length > 0 ? "warning" : "within_target",
      total: snapshot.latencyMarks.length,
      overBudget: overBudgetLatencyMarks.length,
      evidence: `${overBudgetLatencyMarks.length} of ${snapshot.latencyMarks.length} latency measurements were over budget.`,
    },
  };
}

function buildClueConAssertRequestPreview(snapshot: CallSnapshot, proof: ReturnType<typeof buildCallProofBundlePayload>) {
  return {
    spec_ref: {
      spec_id: "agentic-contact-center/cluecon-cancellation-rescue",
      spec_kind: "scenario",
      spec_version: "2026-07-09",
      assert_project: "conversation-agent-evals",
      assert_commit: null,
    },
    evidence: {
      transcript: {
        artifact_id: "cluecon-transcript",
        kind: "transcript",
        source: "agentic-contact-center",
        readiness: "inline_preview",
        inline_data: snapshot.transcript,
      },
      action_trace: {
        artifact_id: "cluecon-action-trace",
        kind: "action_trace",
        source: "agentic-contact-center",
        readiness: "inline_preview",
        inline_data: snapshot.events.map((event) => ({ type: event.type, at: event.at, detail: event.detail })),
      },
      final_state: {
        artifact_id: "cluecon-final-state",
        kind: "final_state",
        source: "agentic-contact-center",
        readiness: "inline_preview",
        inline_data: proof.outcome,
      },
      proof_bundle: {
        artifact_id: "cluecon-proof-bundle",
        kind: "proof_bundle",
        source: "agentic-contact-center",
        readiness: "route_preview",
        routes: proof.evidenceRoutes,
      },
    },
    metadata: {
      demo: "cluecon-2026-cancellation-rescue",
      route: "/api/cluecon/eval/run",
      compatible_file: "conversation-agent-evals-assert-request.json",
      local_import_mode: "handoff_artifact",
      live_telephony: snapshot.scenario.mode,
      runtime_engine: snapshot.pipecatFlow.runtimeEngine,
      credentials_mode: snapshot.pipecatFlow.credentialsMode,
    },
  };
}

function buildClueConEvalPreviewPayload() {
  return {
    ok: true,
    route: "/api/cluecon/eval/preview",
    workboardCard: clueConProofEvalCard,
    mode: "non_mutating_preview",
    compatibleRequest: "conversation-agent-evals-assert-request.json",
    runRoute: "/api/cluecon/eval/run",
    scorecardChecks: ["task_completion", "policy_hold", "operator_approval", "final_state", "latency_evidence", "fallback_caveats"],
    scorecardGroups: {
      safety: ["task_completion", "policy_hold", "operator_approval", "final_state"],
      evidenceCoverage: ["latency_evidence", "fallback_caveats"],
      performance: "reported_separately",
    },
    evidenceArtifacts: ["transcript", "action_trace", "final_state", "proof_bundle", "latency_marks", "asr_tts_caveats"],
    caveat: "ACC runs the local scorecard; the route emits a CAE-compatible handoff artifact for import and comparison.",
  };
}

async function resolveOperatorConsoleCallId(
  body: Record<string, unknown>,
  ingress: InMemoryTelephonyIngress,
): Promise<string | { error: string }> {
  const directCallId = getOptionalTrimmedString(body.callId);
  if (directCallId) {
    return directCallId;
  }

  const providerCallId = getOptionalTrimmedString(body.providerCallId);
  const openclawSessionId = getOptionalTrimmedString(body.openclawSessionId);
  const openclawSessionLabel = getOptionalTrimmedString(body.openclawSessionLabel);
  const openclawSessionRef = getOptionalTrimmedString(body.openclawSessionRef);
  const referenceCount = [providerCallId, openclawSessionId, openclawSessionLabel, openclawSessionRef].filter(Boolean).length;

  if (referenceCount === 0) {
    return { error: "operator_console_action_call_ref_required" };
  }

  if (referenceCount > 1) {
    return { error: "operator_console_action_call_ref_conflict" };
  }

  const matches = await ingress.listSnapshots({ providerCallId, openclawSessionId, openclawSessionLabel, openclawSessionRef });
  if (matches.length !== 1) {
    return { error: "operator_console_action_call_ref_not_found" };
  }

  return matches[0].session.callId;
}

function parseOptionalBooleanFilter(
  value: string | null,
  error: string,
): boolean | { error: string } | undefined {
  if (value === null) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return { error };
}

function parseOptionalPositiveIntegerFilter(
  value: string | null,
  error: string,
): number | { error: string } | undefined {
  if (value === null) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    return { error };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { error };
  }

  return parsed;
}

function parseOptionalNonNegativeIntegerFilter(
  value: string | null,
  error: string,
): number | { error: string } | undefined {
  if (value === null) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    return { error };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { error };
  }

  return parsed;
}

function parseOptionalPercentFilter(
  value: string | null,
  error: string,
): number | { error: string } | undefined {
  const parsed = parseOptionalNonNegativeIntegerFilter(value, error);
  if (typeof parsed !== "number") {
    return parsed;
  }

  return parsed <= 100 ? parsed : { error };
}

function parseCallListSort(value: string | null): CallListSort | { error: string } {
  if (value === null || value === "startedAt") {
    return "startedAt";
  }

  if (value === "attentionStartedAt") {
    return "attentionStartedAt";
  }

  return { error: "call_list_sort_invalid" };
}

function parseCallListOrder(value: string | null): CallListOrder | { error: string } {
  if (value === null || value === "asc") {
    return "asc";
  }

  if (value === "desc") {
    return "desc";
  }

  return { error: "call_list_order_invalid" };
}

function compareAttentionQueueOrder(left: CallSnapshot, right: CallSnapshot): number {
  const leftAttention = getAttentionMetadata(left);
  const rightAttention = getAttentionMetadata(right);

  if (leftAttention.startedAt && rightAttention.startedAt) {
    const attentionOrder = compareTimestamps(leftAttention.startedAt, rightAttention.startedAt);
    return attentionOrder === 0 ? compareTimestamps(left.session.startedAt, right.session.startedAt) : attentionOrder;
  }

  if (leftAttention.startedAt) {
    return -1;
  }

  if (rightAttention.startedAt) {
    return 1;
  }

  return compareTimestamps(left.session.startedAt, right.session.startedAt);
}

interface CallListFilters {
  flowState?: FlowState;
  pipecatActiveTool?: string;
  pendingOperatorSteer?: boolean;
  fallbackArmed?: boolean;
  fallbackMode?: FallbackMode;
  fallbackReason?: string;
  fallbackSource?: string;
  attentionRequired?: boolean;
  attentionSource?: AttentionSource;
  attentionReason?: string;
  openclawSessionId?: string;
  openclawSessionLabel?: string;
  openclawSessionRef?: string;
  callId?: string;
  providerCallId?: string;
  transcriptText?: string;
  scriptCompleted?: boolean;
  minScriptProgressPct?: number;
  maxScriptProgressPct?: number;
  minAttentionAgeMs?: number;
  maxAttentionAgeMs?: number;
  latencyStage?: string;
  latencyOverBudget?: boolean;
}

type CallListSort = "startedAt" | "attentionStartedAt";
type CallListOrder = "asc" | "desc";

function parseCallListFilters(
  requestUrl: URL,
  invalidPrefix: "call_list" | "queue" | "operator_console",
): CallListFilters | { error: string } {
  const flowState = requestUrl.searchParams.get("flowState");
  if (flowState !== null && !isFlowState(flowState)) {
    return { error: `${invalidPrefix}_flow_state_invalid` };
  }

  const pipecatActiveTool = requestUrl.searchParams.get("pipecatActiveTool");
  if (pipecatActiveTool !== null && !pipecatActiveTool.trim()) {
    return { error: `${invalidPrefix}_pipecat_active_tool_invalid` };
  }

  const pendingOperatorSteer = parseOptionalBooleanFilter(
    requestUrl.searchParams.get("pendingOperatorSteer"),
    `${invalidPrefix}_pending_operator_steer_invalid`,
  );
  if (typeof pendingOperatorSteer !== "boolean" && pendingOperatorSteer !== undefined) {
    return pendingOperatorSteer;
  }

  const fallbackArmed = parseOptionalBooleanFilter(
    requestUrl.searchParams.get("fallbackArmed"),
    `${invalidPrefix}_fallback_armed_invalid`,
  );
  if (typeof fallbackArmed !== "boolean" && fallbackArmed !== undefined) {
    return fallbackArmed;
  }

  const fallbackMode = requestUrl.searchParams.get("fallbackMode");
  if (fallbackMode !== null && !isFallbackMode(fallbackMode)) {
    return { error: `${invalidPrefix}_fallback_mode_invalid` };
  }

  const fallbackReason = requestUrl.searchParams.get("fallbackReason");
  if (fallbackReason !== null && !fallbackReason.trim()) {
    return { error: `${invalidPrefix}_fallback_reason_invalid` };
  }

  const fallbackSource = requestUrl.searchParams.get("fallbackSource");
  if (fallbackSource !== null && !fallbackSource.trim()) {
    return { error: `${invalidPrefix}_fallback_source_invalid` };
  }

  const attentionRequired = parseOptionalBooleanFilter(
    requestUrl.searchParams.get("attentionRequired"),
    `${invalidPrefix}_attention_required_invalid`,
  );
  if (typeof attentionRequired !== "boolean" && attentionRequired !== undefined) {
    return attentionRequired;
  }

  const attentionSource = requestUrl.searchParams.get("attentionSource");
  if (attentionSource !== null && !isAttentionSource(attentionSource)) {
    return { error: `${invalidPrefix}_attention_source_invalid` };
  }

  const attentionReason = requestUrl.searchParams.get("attentionReason");
  if (attentionReason !== null && !attentionReason.trim()) {
    return { error: `${invalidPrefix}_attention_reason_invalid` };
  }

  const openclawSessionId = requestUrl.searchParams.get("openclawSessionId");
  if (openclawSessionId !== null && !openclawSessionId.trim()) {
    return { error: `${invalidPrefix}_openclaw_session_id_invalid` };
  }

  const openclawSessionLabel = requestUrl.searchParams.get("openclawSessionLabel");
  if (openclawSessionLabel !== null && !openclawSessionLabel.trim()) {
    return { error: `${invalidPrefix}_openclaw_session_label_invalid` };
  }

  const openclawSessionRef = requestUrl.searchParams.get("openclawSessionRef");
  if (openclawSessionRef !== null && !openclawSessionRef.trim()) {
    return { error: `${invalidPrefix}_openclaw_session_ref_invalid` };
  }

  const callId = requestUrl.searchParams.get("callId");
  if (callId !== null && !callId.trim()) {
    return { error: `${invalidPrefix}_call_id_invalid` };
  }

  const providerCallId = requestUrl.searchParams.get("providerCallId");
  if (providerCallId !== null && !providerCallId.trim()) {
    return { error: `${invalidPrefix}_provider_call_id_invalid` };
  }

  const transcriptText = requestUrl.searchParams.get("transcriptText");
  if (transcriptText !== null && !transcriptText.trim()) {
    return { error: `${invalidPrefix}_transcript_text_invalid` };
  }

  const scriptCompleted = parseOptionalBooleanFilter(
    requestUrl.searchParams.get("scriptCompleted"),
    `${invalidPrefix}_script_completed_invalid`,
  );
  if (scriptCompleted !== undefined && typeof scriptCompleted !== "boolean") {
    return scriptCompleted;
  }

  const minScriptProgressPct = parseOptionalPercentFilter(
    requestUrl.searchParams.get("minScriptProgressPct"),
    `${invalidPrefix}_min_script_progress_pct_invalid`,
  );
  if (minScriptProgressPct !== undefined && typeof minScriptProgressPct !== "number") {
    return minScriptProgressPct;
  }

  const maxScriptProgressPct = parseOptionalPercentFilter(
    requestUrl.searchParams.get("maxScriptProgressPct"),
    `${invalidPrefix}_max_script_progress_pct_invalid`,
  );
  if (maxScriptProgressPct !== undefined && typeof maxScriptProgressPct !== "number") {
    return maxScriptProgressPct;
  }

  if (
    typeof minScriptProgressPct === "number" &&
    typeof maxScriptProgressPct === "number" &&
    minScriptProgressPct > maxScriptProgressPct
  ) {
    return { error: `${invalidPrefix}_script_progress_range_invalid` };
  }

  const minAttentionAgeMs = parseOptionalNonNegativeIntegerFilter(
    requestUrl.searchParams.get("minAttentionAgeMs"),
    `${invalidPrefix}_min_attention_age_ms_invalid`,
  );
  if (minAttentionAgeMs !== undefined && typeof minAttentionAgeMs !== "number") {
    return minAttentionAgeMs;
  }

  const maxAttentionAgeMs = parseOptionalNonNegativeIntegerFilter(
    requestUrl.searchParams.get("maxAttentionAgeMs"),
    `${invalidPrefix}_max_attention_age_ms_invalid`,
  );
  if (maxAttentionAgeMs !== undefined && typeof maxAttentionAgeMs !== "number") {
    return maxAttentionAgeMs;
  }

  const latencyStage = requestUrl.searchParams.get("latencyStage");
  if (latencyStage !== null && !latencyStage.trim()) {
    return { error: `${invalidPrefix}_latency_stage_invalid` };
  }

  const latencyOverBudget = parseOptionalBooleanFilter(
    requestUrl.searchParams.get("latencyOverBudget"),
    `${invalidPrefix}_latency_over_budget_invalid`,
  );
  if (latencyOverBudget !== undefined && typeof latencyOverBudget !== "boolean") {
    return latencyOverBudget;
  }

  return {
    flowState: flowState ?? undefined,
    pipecatActiveTool: pipecatActiveTool?.trim() || undefined,
    pendingOperatorSteer,
    fallbackArmed,
    fallbackMode: fallbackMode ?? undefined,
    fallbackReason: fallbackReason?.trim() || undefined,
    fallbackSource: fallbackSource?.trim() || undefined,
    attentionRequired,
    attentionSource: attentionSource ?? undefined,
    attentionReason: attentionReason?.trim() || undefined,
    openclawSessionId: openclawSessionId?.trim() || undefined,
    openclawSessionLabel: openclawSessionLabel?.trim() || undefined,
    openclawSessionRef: openclawSessionRef?.trim() || undefined,
    callId: callId?.trim() || undefined,
    providerCallId: providerCallId?.trim() || undefined,
    transcriptText: transcriptText?.trim() || undefined,
    scriptCompleted,
    minScriptProgressPct,
    maxScriptProgressPct,
    minAttentionAgeMs,
    maxAttentionAgeMs,
    latencyStage: latencyStage?.trim() || undefined,
    latencyOverBudget,
  };
}

function parseOperatorSteerCommand(
  value: unknown,
): { action: OperatorSteerAction; reason?: string } | { error: string } | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    return { error: "operator_steer_command_invalid" };
  }

  const command = value.trim();
  if (!command) {
    return { error: "operator_steer_command_invalid" };
  }

  const normalizedCommand = command.startsWith("/") ? command.slice(1).trimStart() : command;
  if (!normalizedCommand) {
    return { error: "operator_steer_command_invalid" };
  }

  // Accept Slack-style wrappers like `/operator pause` and `/steer ask verify latency budget`.
  const unwrappedCommand = normalizedCommand.replace(/^(?:operator|steer)\s+/i, "");
  if (!unwrappedCommand) {
    return { error: "operator_steer_command_invalid" };
  }

  const lowerCommand = unwrappedCommand.toLowerCase();

  if (lowerCommand === "pause") {
    return { action: "pause" };
  }

  if (lowerCommand === "resume") {
    return { action: "resume" };
  }

  if (lowerCommand === "approve-offer" || lowerCommand === "approve offer") {
    return { action: "approve_offer" };
  }

  if (lowerCommand === "approve-retention-review" || lowerCommand === "approve retention review") {
    return { action: "approve_retention_review" };
  }

  if (lowerCommand === "deny-offer" || lowerCommand === "deny offer") {
    return { action: "deny_offer" };
  }

  if (lowerCommand === "escalate" || lowerCommand === "escalate-to-human") {
    return { action: "escalate_to_human" };
  }

  if (lowerCommand === "transfer") {
    return { action: "transfer" };
  }

  if (lowerCommand === "takeover" || lowerCommand === "barge-in" || lowerCommand === "barge in") {
    return { action: "takeover" };
  }

  if (lowerCommand === "end-call" || lowerCommand === "end call" || lowerCommand === "hangup") {
    return { action: "end_call" };
  }

  if (lowerCommand === "disarm-fallback" || lowerCommand === "disarm fallback") {
    return { action: "disarm_fallback" };
  }

  const commandPrefixes: Array<{
    prefix: string;
    action: OperatorSteerAction;
    requireArgument?: boolean;
  }> = [
    { prefix: "goto-slide", action: "goto_slide", requireArgument: true },
    { prefix: "goto slide", action: "goto_slide", requireArgument: true },
    { prefix: "ask", action: "ask_operator", requireArgument: true },
    { prefix: "arm-fallback", action: "arm_fallback", requireArgument: true },
    { prefix: "arm fallback", action: "arm_fallback", requireArgument: true },
  ];

  for (const entry of commandPrefixes) {
    if (lowerCommand === entry.prefix) {
      return entry.requireArgument ? { error: "operator_steer_command_invalid" } : { action: entry.action };
    }

    if (!lowerCommand.startsWith(`${entry.prefix} `)) {
      continue;
    }

    const reason = unwrappedCommand.slice(entry.prefix.length).trim();
    if (!reason) {
      return { error: "operator_steer_command_invalid" };
    }

    return { action: entry.action, reason };
  }

  return { error: "operator_steer_command_invalid" };
}

function parseOperatorSteerBody(
  body: Record<string, unknown>,
  errors: {
    actionRequired: string;
    commandInvalid: string;
    commandConflict: string;
    reasonInvalid: string;
    fallbackReasonRequired: string;
    timestampInvalid: string;
  },
): { action: OperatorSteerAction; reason?: string; timestamp: string } | { error: string } {
  const commandInput = getOptionalTrimmedString(body.command);
  const textInput = getOptionalTrimmedString(body.text);

  let parsedCommand = parseOperatorSteerCommand(commandInput);
  if (parsedCommand && "error" in parsedCommand && commandInput && textInput && isSlackSlashCommandName(commandInput)) {
    parsedCommand = undefined;
  }

  if (parsedCommand && "error" in parsedCommand) {
    return { error: errors.commandInvalid };
  }

  const parsedText = parsedCommand ? undefined : parseOperatorSteerCommand(textInput);
  if (parsedText && "error" in parsedText) {
    return { error: errors.commandInvalid };
  }

  const action = body.action;
  if (action !== undefined && !operatorSteerActions.includes(action as OperatorSteerAction)) {
    return { error: errors.actionRequired };
  }

  const parsedSteer = parsedCommand ?? parsedText;

  if (action !== undefined && parsedSteer && action !== parsedSteer.action) {
    return { error: errors.commandConflict };
  }

  const resolvedAction = (action as OperatorSteerAction | undefined) ?? parsedSteer?.action;
  if (!resolvedAction) {
    return { error: errors.actionRequired };
  }

  if (hasInvalidOptionalString(body.reason)) {
    return { error: errors.reasonInvalid };
  }

  const reason = getOptionalTrimmedString(body.reason) ?? parsedSteer?.reason;
  if (resolvedAction === "arm_fallback" && !reason) {
    return { error: errors.fallbackReasonRequired };
  }

  const timestamp = normalizeTimestamp(body.timestamp, errors.timestampInvalid);
  if (typeof timestamp !== "string") {
    return timestamp;
  }

  return { action: resolvedAction, reason, timestamp };
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");

  if (!rawBody) {
    return {} as T;
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new InvalidJsonBodyError();
  }
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function parseStringMetadata(value: unknown): Record<string, string> | { error: string } {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return { error: "voice_session_metadata_invalid" };
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return { error: "voice_session_metadata_invalid" };
    metadata[key] = item;
  }
  return metadata;
}

function parseOptionalPositiveInteger(value: unknown, error: string): number | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return { error };
  return value;
}

function parseOptionalPositiveIntegerHeader(value: string | string[] | undefined, error: string): number | undefined | { error: string } {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return { error };
  if (!/^\d+$/.test(trimmed)) return { error };
  return parseOptionalPositiveInteger(Number(trimmed), error);
}

function parseRequiredBase64Audio(value: unknown, error: string): Buffer | { error: string } {
  const raw = getOptionalTrimmedString(value);
  if (!raw) return { error };
  const normalized = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) return { error };
  const audio = Buffer.from(normalized, "base64");
  if (audio.byteLength === 0 || audio.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) return { error };
  return audio;
}

function isVoiceSessionControlAction(value: string): boolean {
  return ["barge_in", "pause", "resume", "close", "flush", "mark"].includes(value);
}

function parseBooleanHeader(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "1" || raw?.toLowerCase() === "true";
}

function buildWebSocketAcceptKey(key: string): string {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function encodeWebSocketTextFrame(payload: object): Buffer {
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  if (data.byteLength < 126) {
    return Buffer.concat([Buffer.from([0x81, data.byteLength]), data]);
  }
  if (data.byteLength <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.byteLength, 2);
    return Buffer.concat([header, data]);
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(data.byteLength), 2);
  return Buffer.concat([header, data]);
}

function decodeWebSocketFrames(buffer: Buffer): { frames: Array<{ fin: boolean; opcode: number; payload: Buffer }>; remaining: Buffer } {
  const frames: Array<{ fin: boolean; opcode: number; payload: Buffer }> = [];
  let offset = 0;
  while (offset + 2 <= buffer.byteLength) {
    const frameStart = offset;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    offset += 2;
    if (length === 126) {
      if (offset + 2 > buffer.byteLength) return { frames, remaining: buffer.subarray(frameStart) };
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.byteLength) return { frames, remaining: buffer.subarray(frameStart) };
      const longLength = buffer.readBigUInt64BE(offset);
      if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) return { frames, remaining: Buffer.alloc(0) };
      length = Number(longLength);
      offset += 8;
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (offset + 4 > buffer.byteLength) return { frames, remaining: buffer.subarray(frameStart) };
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (offset + length > buffer.byteLength) return { frames, remaining: buffer.subarray(frameStart) };
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    offset += length;
    if (mask) {
      for (let index = 0; index < payload.byteLength; index += 1) {
        payload[index] = payload[index] ^ mask[index % 4];
      }
    }
    frames.push({ fin, opcode, payload });
  }
  return { frames, remaining: buffer.subarray(offset) };
}

function buildProductionReadiness(
  config: PocConfig,
  pipecatFlow: ReturnType<typeof getPipecatPrototypeHealth>,
): {
  demoReady: boolean;
  productionReady: boolean;
  statePersistence: "in_memory";
  requiredForProduction: string[];
  blockers: string[];
} {
  const blockers: string[] = [];

  if (config.mode !== "signalwire_live") {
    blockers.push("live_telephony_not_enabled");
  }

  if (config.provider.callId.startsWith("mock-")) {
    blockers.push("provider_call_id_is_mock");
  }

  if (pipecatFlow.credentialsMode === "mocked") {
    blockers.push("provider_credentials_mocked");
  }

  if (!pipecatFlow.runtimeCheck.liveTelephonyRequired) {
    blockers.push("runtime_check_does_not_require_live_telephony");
  }

  blockers.push("state_store_in_memory");

  return {
    demoReady: true,
    productionReady: blockers.length === 0,
    statePersistence: "in_memory",
    requiredForProduction: [
      "signalwire_live_telephony",
      "real_provider_credentials",
      "persistent_call_state",
      "live_rtc_asr_evidence",
      "operator_auth_and_audit",
    ],
    blockers,
  };
}

async function withLiveSipCallLock<T>(
  locks: Map<string, Promise<void>>,
  sipCallId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(sipCallId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  locks.set(sipCallId, queued);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    releaseCurrent();
    if (locks.get(sipCallId) === queued) {
      locks.delete(sipCallId);
    }
  }
}

async function withLiveSipOpenAiGenerationLock<T>(
  locks: Map<string, Promise<void>>,
  sipCallId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(sipCallId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  locks.set(sipCallId, queued);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    releaseCurrent();
    if (locks.get(sipCallId) === queued) {
      locks.delete(sipCallId);
    }
  }
}

function normalizeLiveSipIngressSource(value: unknown): "freeswitch_esl" | "freeswitch_verto" | "local_sip_harness" {
  const source = getOptionalTrimmedString(value);
  if (source === "freeswitch_esl" || source === "freeswitch_verto") return source;
  return "local_sip_harness";
}

function normalizeLiveSipDestination(value: unknown): string | null {
  const destination = getOptionalTrimmedString(value);
  if (!destination) return null;
  const normalized = destination.toLowerCase() === "acc" ? "8600" : destination;
  return /^(8600|8611)$/.test(normalized) ? normalized : destination;
}

function conversationModeForLiveSipDestination(destination: string | null): ConversationMode {
  if (destination === "8600") return "openai_llm";
  return "scripted";
}

function normalizeLiveSipConversationMode(value: unknown, destination: string | null): ConversationMode {
  if (isConversationMode(value)) return value;
  return conversationModeForLiveSipDestination(destination);
}

function openAiConversationModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.ACC_OPENAI_CONVERSATION_MODEL?.trim() || "GPT-5.4-mini";
}

function openAiConversationTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.ACC_OPENAI_REQUEST_TIMEOUT_MS?.trim() || "12000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12000;
}

type OpenAiConversationAuthMode = "api_key" | "openclaw_oauth";

type OpenAiConversationRequestConfig = {
  model: string;
  requestModel: string;
  baseUrl: string;
  bearerToken: string | null;
  missingCredentialError: string;
  useStringInput: boolean;
  headers: Record<string, string>;
};

function openAiConversationAuthMode(env: NodeJS.ProcessEnv = process.env): OpenAiConversationAuthMode {
  return env.ACC_OPENAI_AUTH_MODE?.trim().toLowerCase() === "openclaw_oauth" ? "openclaw_oauth" : "api_key";
}

function openAiConversationGatewayAgentId(env: NodeJS.ProcessEnv = process.env): string {
  return env.ACC_OPENCLAW_AGENT_ID?.trim() || "acc-voice";
}

function openAiConversationGatewayBackendModel(model: string): string {
  return model.includes("/") ? model : `openai/${model.toLowerCase()}`;
}

function buildOpenAiConversationRequestConfig(model: string, env: NodeJS.ProcessEnv = process.env): OpenAiConversationRequestConfig {
  if (openAiConversationAuthMode(env) === "openclaw_oauth") {
    const agentId = openAiConversationGatewayAgentId(env);
    const backendModel = openAiConversationGatewayBackendModel(model);
    return {
      model,
      requestModel: `openclaw/${agentId}`,
      baseUrl: (env.ACC_OPENAI_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || "http://127.0.0.1:18789/v1").replace(/\/+$/, ""),
      bearerToken: env.ACC_OPENAI_AUTH_TOKEN?.trim() || env.OPENCLAW_GATEWAY_TOKEN?.trim() || null,
      missingCredentialError: "openclaw_gateway_token_missing",
      useStringInput: true,
      headers: {
        "x-openclaw-agent-id": agentId,
        "x-openclaw-model": backendModel,
      },
    };
  }

  return {
    model,
    requestModel: model,
    baseUrl: (env.ACC_OPENAI_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    bearerToken: env.ACC_OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || null,
    missingCredentialError: "openai_api_key_missing",
    useStringInput: false,
    headers: {},
  };
}

function redactOpenAiError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? "openai_request_failed");
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[redacted]");
}

function extractOpenAiResponseText(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const outputText = getOptionalTrimmedString(payload.output_text);
  if (outputText) return outputText;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      const text = getOptionalTrimmedString(part.text);
      if (text) chunks.push(text);
    }
  }
  return chunks.join(" ").trim();
}

function validateOpenAiAgentText(text: string): string | null {
  if (!text.trim()) return "openai_response_empty";
  if (text.length > 700) return "openai_response_too_long";
  if (/\b(guarantee|guaranteed|approved\s+(credit|discount|refund)|i can offer you|i can give you)\b/i.test(text)) {
    return "openai_response_guardrail_violation";
  }
  return null;
}

async function generateOpenAiLiveSipResponse(
  snapshot: CallSnapshot,
  callerText: string,
  timestamp: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenAiLlmTurnResult> {
  const model = openAiConversationModel(env);
  const requestConfig = buildOpenAiConversationRequestConfig(model, env);
  if (!requestConfig.bearerToken) {
    return { ok: false, model, error: requestConfig.missingCredentialError, status: null };
  }
  const transcript = snapshot.transcript
    .slice(-8)
    .map((turn) => `${turn.speaker}: ${turn.text}`)
    .join("\n");
  const systemPromptText = [
    "You are the live OpenAI-backed conversation path for ACC SIP extension 8600.",
    "Answer in one or two short sentences suitable for TTS.",
    "Do not promise discounts, refunds, cancellation completion, policy changes, or regulated advice.",
    "When a request requires approval, account access, or a human decision, say you will prepare a safe handoff.",
    "Ask at most one focused follow-up question.",
  ].join(" ");
  const userPromptText = [
    `Timestamp: ${timestamp}`,
    `Flow state: ${snapshot.flowState}`,
    `Recent transcript:\n${transcript || "(none)"}`,
    `Latest caller turn: ${callerText}`,
  ].join("\n");
  const input = requestConfig.useStringInput
    ? `${systemPromptText}\n\n${userPromptText}`
    : [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: systemPromptText,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: userPromptText,
            },
          ],
        },
      ];
  const body = {
    model: requestConfig.requestModel,
    store: false,
    max_output_tokens: 160,
    input,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), openAiConversationTimeoutMs(env));
  try {
    const response = await fetch(`${requestConfig.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${requestConfig.bearerToken}`,
        "content-type": "application/json",
        ...requestConfig.headers,
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = isRecord(payload) && isRecord(payload.error) ? getOptionalTrimmedString(payload.error.message) : null;
      return { ok: false, model, error: redactOpenAiError(errorMessage ?? response.statusText), status: response.status };
    }
    const text = extractOpenAiResponseText(payload);
    const validationError = validateOpenAiAgentText(text);
    if (validationError) {
      return { ok: false, model, error: validationError, status: response.status };
    }
    return {
      ok: true,
      model,
      text,
      responseId: isRecord(payload) ? getOptionalTrimmedString(payload.id) ?? null : null,
      status: response.status,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, model, error: "openai_request_timeout", status: null };
    }
    return { ok: false, model, error: redactOpenAiError(error), status: null };
  } finally {
    clearTimeout(timeout);
  }
}

type CallerTurnDeliveryAckPreview = {
  callId: string;
  snapshotVersion: string;
  callerTranscript: string;
  timestamp: string;
  createdAtMs: number;
  conversationMode?: ConversationMode;
  expectedAgentText: string;
  openAiLlm?: OpenAiLlmTurnResult;
  openAiFailClosedAlreadyPersisted?: boolean;
};

const callerTurnDeliveryAckPreviewTtlMs = 5 * 60 * 1000;
const liveSipEndedCallAliasTtlMs = 10 * 60 * 1000;
const maxLiveSipEndedCallAliases = 1000;

interface LiveSipEndedCallAlias {
  callId: string;
  endedAtMs: number;
}

function buildCallerTurnDeliveryAckKey(callId: string, snapshotVersion: string): string {
  return `${callId}:${snapshotVersion}`;
}

function purgeExpiredCallerTurnDeliveryAckPreviews(
  previews: Map<string, CallerTurnDeliveryAckPreview>,
  nowMs = Date.now(),
): void {
  for (const [key, preview] of previews) {
    if (nowMs - preview.createdAtMs >= callerTurnDeliveryAckPreviewTtlMs) previews.delete(key);
  }
}

function purgeCallerTurnDeliveryAckPreviewsForCall(
  previews: Map<string, CallerTurnDeliveryAckPreview>,
  callId: string,
): void {
  for (const [key, preview] of previews) {
    if (preview.callId === callId) previews.delete(key);
  }
}

function getCallerTurnDeliveryAckPreview(
  previews: Map<string, CallerTurnDeliveryAckPreview>,
  callId: string,
  snapshotVersion: string,
): CallerTurnDeliveryAckPreview | undefined {
  return previews.get(buildCallerTurnDeliveryAckKey(callId, snapshotVersion));
}

function deleteCallerTurnDeliveryAckPreview(
  previews: Map<string, CallerTurnDeliveryAckPreview>,
  callId: string,
  snapshotVersion: string,
): void {
  previews.delete(buildCallerTurnDeliveryAckKey(callId, snapshotVersion));
}

function isCallerTurnDeliveryAckPreviewForTurn(
  preview: CallerTurnDeliveryAckPreview,
  callerTranscript: string,
  timestamp: string,
  conversationMode: ConversationMode,
): boolean {
  return (
    preview.callerTranscript === callerTranscript
    && preview.timestamp === timestamp
    && preview.conversationMode === conversationMode
  );
}

function writeCallerTurnDeliveryAckPreviewPending(
  response: ServerResponse,
  callId: string,
  snapshotVersion: string,
  createdAtMs: number,
  route = "/api/calls/:callId/caller-turn",
): void {
  writeJson(response, 409, {
    ok: false,
    route,
    error: "caller_turn_delivery_ack_preview_pending",
    callerTurnCommit: {
      mode: "delivery_ack",
      status: "pending",
      callId,
      snapshotVersion,
      createdAtMs,
    },
  });
}

function uniqueLiveSipCallIds(...values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function getMappedLiveSipCallId(liveSipCallMap: Map<string, string>, ids: string[]): string | undefined {
  for (const id of ids) {
    const callId = liveSipCallMap.get(id);
    if (callId) return callId;
  }
  return undefined;
}

function setLiveSipCallAliases(liveSipCallMap: Map<string, string>, ids: string[], callId: string): void {
  for (const id of ids) liveSipCallMap.set(id, callId);
}

function deleteLiveSipCallAliases(liveSipCallMap: Map<string, string>, ids: string[]): void {
  for (const id of ids) liveSipCallMap.delete(id);
}

function deleteLiveSipCallAliasesForCall(liveSipCallMap: Map<string, string>, callId: string): void {
  for (const [id, mappedCallId] of liveSipCallMap) {
    if (mappedCallId === callId) liveSipCallMap.delete(id);
  }
}

function liveSipCallAliasesForCall(liveSipCallMap: Map<string, string>, callId: string): string[] {
  return [...liveSipCallMap.entries()].filter(([, mappedCallId]) => mappedCallId === callId).map(([id]) => id);
}

function purgeLiveSipEndedCallAliases(
  liveSipEndedCallMap: Map<string, LiveSipEndedCallAlias>,
  nowMs = Date.now(),
): void {
  for (const [id, alias] of liveSipEndedCallMap) {
    if (nowMs - alias.endedAtMs >= liveSipEndedCallAliasTtlMs) liveSipEndedCallMap.delete(id);
  }

  while (liveSipEndedCallMap.size > maxLiveSipEndedCallAliases) {
    let oldestId: string | null = null;
    let oldestEndedAtMs = Number.POSITIVE_INFINITY;
    for (const [id, alias] of liveSipEndedCallMap) {
      if (alias.endedAtMs < oldestEndedAtMs) {
        oldestId = id;
        oldestEndedAtMs = alias.endedAtMs;
      }
    }
    if (!oldestId) break;
    liveSipEndedCallMap.delete(oldestId);
  }
}

function getMappedLiveSipEndedCallId(
  liveSipEndedCallMap: Map<string, LiveSipEndedCallAlias>,
  ids: string[],
): string | undefined {
  purgeLiveSipEndedCallAliases(liveSipEndedCallMap);
  for (const id of ids) {
    const alias = liveSipEndedCallMap.get(id);
    if (alias) return alias.callId;
  }
  return undefined;
}

function setLiveSipEndedCallAliases(
  liveSipEndedCallMap: Map<string, LiveSipEndedCallAlias>,
  ids: string[],
  callId: string,
  endedAtMs = Date.now(),
): void {
  purgeLiveSipEndedCallAliases(liveSipEndedCallMap, endedAtMs);
  for (const id of ids) liveSipEndedCallMap.set(id, { callId, endedAtMs });
  purgeLiveSipEndedCallAliases(liveSipEndedCallMap, endedAtMs);
}

function deleteLiveSipEndedCallAliases(liveSipEndedCallMap: Map<string, LiveSipEndedCallAlias>, ids: string[]): void {
  for (const id of ids) liveSipEndedCallMap.delete(id);
}

function isLiveSipCallEnded(snapshot: CallSnapshot): boolean {
  return snapshot.events.some((event) => event.type === "sip_call_ended");
}

async function listLiveSipSnapshotsByProviderIds(
  ingress: InMemoryTelephonyIngress,
  ids: string[],
): Promise<CallSnapshot[]> {
  const snapshots = (await Promise.all(ids.map((id) => ingress.listSnapshots({ providerCallId: id })))).flat();
  const uniqueSnapshots = new Map<string, CallSnapshot>();
  for (const snapshot of snapshots) {
    uniqueSnapshots.set(snapshot.session.callId, snapshot);
  }
  return [...uniqueSnapshots.values()];
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: PocConfig,
  ingress: InMemoryTelephonyIngress,
  signalWireCallMap: Map<string, string>,
  liveSipCallMap: Map<string, string>,
  liveSipEndedCallMap: Map<string, LiveSipEndedCallAlias>,
  liveSipCallLocks: Map<string, Promise<void>>,
  liveSipOpenAiGenerationLocks: Map<string, Promise<void>>,
  callerTurnDeliveryAckPreviews: Map<string, CallerTurnDeliveryAckPreview>,
  callerTurnDeliveryAckPreviewReservations: Set<string>,
  voiceSessions: RealtimeVoiceSessionStore,
): Promise<void> {
  const url = request.url ?? "/";
  const requestUrl = new URL(url, "http://localhost");
  const pathname = requestUrl.pathname;
  purgeExpiredCallerTurnDeliveryAckPreviews(callerTurnDeliveryAckPreviews);
  purgeLiveSipEndedCallAliases(liveSipEndedCallMap);

  if (request.method === "GET" && pathname === "/health") {
    const pipecatFlow = getPipecatPrototypeHealth();
    const browserWebRtc = buildBrowserWebrtcReadinessPayload(await probeBrowserWebrtcBridgeRuntime());
    writeJson(response, 200, {
      ok: true,
      demoName: config.demoName,
      mode: config.mode,
      provider: config.provider.name,
      policyProfile: config.policy.profile,
      policyToolScope: config.policy.toolScope,
      operatorChannel: config.operator.channel,
      fallbackMode: config.policy.fallbackMode,
      latencyBudgetsMs: config.latencyBudgetsMs,
      runtimeSeams,
      pipecatFlow,
      browserWebRtc,
      productionReadiness: buildProductionReadiness(config, pipecatFlow),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/pipecat-media-engine/readiness") {
    writeJson(response, 200, buildPipecatMediaEngineReadinessPayload());
    return;
  }

  if (request.method === "GET" && pathname === "/api/pipecat-flowmanager/contract") {
    writeJson(response, 200, buildPipecatFlowManagerContractPayload());
    return;
  }

  if (request.method === "GET" && pathname === "/api/browser-webrtc/readiness") {
    writeJson(response, 200, buildBrowserWebrtcReadinessPayload(await probeBrowserWebrtcBridgeRuntime()));
    return;
  }

  if (request.method === "GET" && pathname === "/api/reliability") {
    writeJson(response, 200, buildReliabilityGuidePayload(config));
    return;
  }

  if (request.method === "GET" && pathname.startsWith("/api/browser-webrtc/session/") && pathname.endsWith("/proof")) {
    const encodedSessionId = pathname.slice("/api/browser-webrtc/session/".length, -"/proof".length);
    const sessionId = decodeURIComponent(encodedSessionId);
    if (!sessionId.trim()) {
      writeBadRequest(response, "browser_webrtc_session_id_required");
      return;
    }
    try {
      const bridgeResponse = await getBrowserWebrtcSessionProofFromBridge(sessionId);
      writeJson(response, bridgeResponse.status, {
        ok: bridgeResponse.status.toString().startsWith("2"),
        route: "/api/browser-webrtc/session/:sessionId/proof",
        sessionId,
        bridgeProofRoute: buildBrowserWebrtcBridgeSessionProofUrl(sessionId),
        bridge: bridgeResponse.payload,
      });
    } catch (error) {
      writeJson(response, 503, {
        ...buildBrowserWebrtcBridgeUnavailablePayload(error),
        route: "/api/browser-webrtc/session/:sessionId/proof",
        sessionId,
        bridgeProofRoute: buildBrowserWebrtcBridgeSessionProofUrl(sessionId),
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/browser-webrtc/session") {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const type = getOptionalTrimmedString(body.type);
    const sdp = getOptionalTrimmedString(body.sdp);
    if (type !== "offer") {
      writeBadRequest(response, "browser_webrtc_offer_type_required");
      return;
    }
    if (!sdp || !sdp.includes("v=0")) {
      writeBadRequest(response, "browser_webrtc_offer_sdp_invalid");
      return;
    }

    const requestedCallId = getOptionalTrimmedString(body.callId);
    const existingSnapshot = requestedCallId ? await ingress.getSnapshot(requestedCallId) : null;
    if (requestedCallId && !existingSnapshot) {
      writeBadRequest(response, "browser_webrtc_call_not_found");
      return;
    }
    const snapshot = existingSnapshot ?? await ingress.startCall(config, {
      openclawSessionId: `browser-webrtc-${randomUUID()}`,
      openclawSessionLabel: "browser-webrtc/pipecat",
    } satisfies StartCallOptions);
    const callId = snapshot.session.callId;
    const sessionId = getOptionalTrimmedString(body.sessionId) ?? `browser-webrtc-${randomUUID()}`;
    const host = request.headers.host ?? "127.0.0.1:8026";
    const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "http";

    try {
      const bridgeResponse = await postBrowserWebrtcOfferToBridge({
        type,
        sdp,
        sessionId,
        callId,
        accUrl: `${protocol}://${host}`,
        stt: { engine: "rtc-asr", contract: "local-stt.v1" },
        tts: { engine: "kokoro" },
        evidence: {
          source: "acc_browser_webrtc_session",
          mediaRecorderRequired: false,
          ffmpegRequired: false,
          preservation: ["callState", "transcript", "eventTrail", "latencyEvidence", "proofRoutes"],
        },
      });

      if (!isRecord(bridgeResponse.payload)) {
        writeJson(response, 502, {
          ok: false,
          error: "pipecat_webrtc_bridge_invalid_response",
          bridgeOfferRoute: buildBrowserWebrtcBridgeOfferUrl(),
        });
        return;
      }

      const answerType = getOptionalTrimmedString(bridgeResponse.payload.type);
      const answerSdp = typeof bridgeResponse.payload.sdp === "string" ? bridgeResponse.payload.sdp : "";
      if (!bridgeResponse.status.toString().startsWith("2") || answerType !== "answer" || !answerSdp.trim()) {
        writeJson(response, 502, {
          ok: false,
          error: "pipecat_webrtc_bridge_offer_failed",
          bridgeStatus: bridgeResponse.status,
          bridgeOfferRoute: buildBrowserWebrtcBridgeOfferUrl(),
          bridge: bridgeResponse.payload,
        });
        return;
      }

      const bridgeSessionId = getOptionalTrimmedString(bridgeResponse.payload.sessionId) ?? sessionId;
      writeJson(response, 201, {
        ok: true,
        route: "/api/browser-webrtc/session",
        sessionId: bridgeSessionId,
        requestedSessionId: sessionId,
        callId,
        type: "answer",
        sdp: answerSdp,
        iceServers: Array.isArray(bridgeResponse.payload.iceServers) ? bridgeResponse.payload.iceServers : [],
        evidence: {
          source: "acc_browser_webrtc_session",
          bridgeOfferRoute: buildBrowserWebrtcBridgeOfferUrl(),
          mediaRecorderRequired: false,
          ffmpegRequired: false,
          stt: { engine: "rtc-asr", contract: "local-stt.v1" },
          tts: { engine: "kokoro" },
          call: buildCallPayload(snapshot),
          bridge: isRecord(bridgeResponse.payload.evidence) ? bridgeResponse.payload.evidence : {},
          sessionId: bridgeSessionId,
          requestedSessionId: sessionId,
          callId,
        },
      });
    } catch (error) {
      writeJson(response, 503, buildBrowserWebrtcBridgeUnavailablePayload(error));
    }
    return;
  }


  if (request.method === "POST" && pathname === "/api/voice/sessions") {
    const body = await readJsonBody<unknown>(request);
    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    if (body.mode !== undefined && body.mode !== "realtime_audio") {
      writeBadRequest(response, "voice_session_mode_invalid");
      return;
    }

    if (getOptionalTrimmedString(body.expectedTranscript) || getOptionalTrimmedString(body.transcript)) {
      writeBadRequest(response, "voice_session_transcript_shortcut_rejected");
      return;
    }

    const requestedCallId = getOptionalTrimmedString(body.callId);
    const existingSnapshot = requestedCallId ? await ingress.getSnapshot(requestedCallId) : null;
    if (requestedCallId && !existingSnapshot) {
      writeBadRequest(response, "voice_session_call_not_found");
      return;
    }

    const metadata = parseStringMetadata(body.metadata);
    if ("error" in metadata) {
      writeBadRequest(response, metadata.error);
      return;
    }

    const requestedSessionId = getOptionalTrimmedString(body.sessionId);
    if (requestedSessionId && voiceSessions.has(requestedSessionId)) {
      writeJson(response, 409, { ok: false, error: "voice_session_already_exists" });
      return;
    }

    const snapshot = existingSnapshot ?? await ingress.startCall(config, {
      providerName: "acc-realtime-voice",
      providerCallId: getOptionalTrimmedString(body.providerCallId) ?? `acc-realtime-${randomUUID()}`,
      openclawSessionId: getOptionalTrimmedString(body.openclawSessionId) ?? `acc-realtime-${randomUUID()}`,
      openclawSessionLabel: getOptionalTrimmedString(body.openclawSessionLabel) ?? "conversation-agent-evals/realtime-audio",
      source: "mock_http_route",
      runtimeModeLabels: {
        telephony: "mocked_telephony",
        media: "live_capture",
        rtcAsr: "rtc_asr_live",
        credentialsMode: "mocked",
      },
    } satisfies StartCallOptions);
    const session = voiceSessions.create({
      requestedId: requestedSessionId,
      callId: snapshot.session.callId,
      target: getOptionalTrimmedString(body.target),
      metadata,
    });
    writeJson(response, 201, {
      ok: true,
      route: "/api/voice/sessions",
      session: voiceSessions.snapshot(session.id, snapshot),
      endpoints: buildRealtimeVoiceSessionEndpoints(session.id),
      contract: {
        realtimeAudioOnly: true,
        transcriptShortcutAllowed: false,
        persistentFullDuplex: true,
        ownerBoundary: "CAE drives fixtures; ACC owns audio intake, rtc-asr, agent turns, TTS, events, and proof.",
      },
    });
    return;
  }

  const voiceSessionMatch = pathname.match(/^\/api\/voice\/sessions\/([^/]+)(?:\/(play|media\/input|media\/output|events|control|close|proof))?$/);
  if (voiceSessionMatch) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(voiceSessionMatch[1]);
    } catch {
      writeBadRequest(response, "voice_session_id_invalid");
      return;
    }
    const action = voiceSessionMatch[2] ?? "snapshot";
    const session = voiceSessions.get(sessionId);
    if (!session) {
      writeJson(response, 404, { ok: false, error: "voice_session_not_found" });
      return;
    }
    const call = await ingress.getSnapshot(session.callId);

    if (request.method === "GET" && action === "snapshot") {
      writeJson(response, 200, {
        ok: true,
        route: "/api/voice/sessions/:id",
        session: voiceSessions.snapshot(sessionId, call),
      });
      return;
    }

    if (request.method === "GET" && action === "events") {
      const after = parseOptionalNonNegativeIntegerFilter(requestUrl.searchParams.get("afterSequence"), "voice_session_after_sequence_invalid");
      if (after !== undefined && typeof after !== "number") {
        writeBadRequest(response, after.error);
        return;
      }
      const events = voiceSessions.events(sessionId, after ?? 0) ?? [];
      writeJson(response, 200, {
        ok: true,
        route: "/api/voice/sessions/:id/events",
        sessionId,
        events,
        summary: { returnedEvents: events.length, latestSequence: events.at(-1)?.sequence ?? after ?? 0 },
      });
      return;
    }

    if (request.method === "GET" && action === "proof") {
      writeJson(response, 200, voiceSessions.proof(sessionId, call) ?? { ok: false, error: "voice_session_not_found" });
      return;
    }

    if (request.method === "POST" && action === "play") {
      const body = await readJsonBody<unknown>(request);
      if (!isRecord(body)) {
        writeBadRequest(response, "json_object_required");
        return;
      }
      if (getOptionalTrimmedString(body.expectedTranscript) || getOptionalTrimmedString(body.transcript)) {
        writeBadRequest(response, "voice_session_transcript_shortcut_rejected");
        return;
      }
      const audio = parseRequiredBase64Audio(body.audioData ?? body.audioBase64, "voice_session_play_audio_invalid");
      if ("error" in audio) {
        writeBadRequest(response, audio.error);
        return;
      }
      if (audio.byteLength > maxVoiceSessionPlayAudioBytes) {
        writeBadRequest(response, "voice_session_play_audio_too_large");
        return;
      }
      const audioMimeType = getOptionalTrimmedString(body.mimeType) ?? getOptionalTrimmedString(body.audioMimeType) ?? "audio/l16";
      if (!supportedVoiceSessionPlayMimeTypes.has(audioMimeType.toLowerCase())) {
        writeBadRequest(response, "voice_session_play_audio_format_unsupported");
        return;
      }
      const sampleRateHz = parseOptionalPositiveInteger(body.sampleRateHz, "voice_session_sample_rate_invalid");
      if (sampleRateHz !== undefined && typeof sampleRateHz !== "number") {
        writeBadRequest(response, sampleRateHz.error);
        return;
      }
      const label = getOptionalTrimmedString(body.label) ?? getOptionalTrimmedString(body.callerActId) ?? getOptionalTrimmedString(body.assetName);
      const assetName = getOptionalTrimmedString(body.assetName) ?? label;
      const audioSha256 = createHash("sha256").update(audio).digest("hex");
      const silentAudio = audio.every((byte) => byte === 0);
      if (session.output.status === "streaming") {
        const cancelled = voiceSessions.recordControl(sessionId, { action: "barge_in", reason: "fixture_audio_play" });
        if (!cancelled) {
          writeJson(response, 409, { ok: false, error: "voice_session_closed" });
          return;
        }
      }
      const requested = voiceSessions.recordPlaybackRequest(sessionId, {
        label,
        assetName,
        audioBytes: audio.byteLength,
        audioUrl: getOptionalTrimmedString(body.audioUrl),
        audioMimeType,
        sampleRateHz,
        audioSha256,
        injectedToMediaInput: true,
        silentAudio,
      });
      if (!requested) {
        writeJson(response, 409, { ok: false, error: "voice_session_closed" });
        return;
      }
      const updated = voiceSessions.recordMediaInput(sessionId, {
        bytes: audio.byteLength,
        mimeType: audioMimeType,
        sampleRateHz,
        assetName,
        source: "play",
        audioSha256,
      });
      if (!updated) {
        writeJson(response, 409, { ok: false, error: "voice_session_closed" });
        return;
      }
      writeJson(response, 202, {
        ok: true,
        route: "/api/voice/sessions/:id/play",
        session: updated,
        accepted: true,
        injectedAudio: {
          assetName: assetName ?? null,
          bytes: audio.byteLength,
          mimeType: audioMimeType,
          sampleRateHz: sampleRateHz ?? null,
          sha256: audioSha256,
          silentAudio,
          path: "voice_session_media_input",
        },
      });
      return;
    }

    if (request.method === "POST" && action === "media/input") {
      const sampleRateHz = parseOptionalPositiveIntegerHeader(request.headers["x-sample-rate-hz"], "voice_session_sample_rate_invalid");
      if (sampleRateHz !== undefined && typeof sampleRateHz !== "number") {
        writeBadRequest(response, sampleRateHz.error);
        return;
      }
      const body = await readRawBody(request);
      if (body.byteLength === 0) {
        writeBadRequest(response, "voice_session_media_input_empty");
        return;
      }
      const updated = voiceSessions.recordMediaInput(sessionId, {
        bytes: body.byteLength,
        mimeType: request.headers["content-type"]?.toString(),
        sampleRateHz,
      });
      if (!updated) {
        writeJson(response, 409, { ok: false, error: "voice_session_closed" });
        return;
      }
      writeJson(response, 202, { ok: true, route: "/api/voice/sessions/:id/media/input", session: updated, accepted: true });
      return;
    }

    if (request.method === "POST" && action === "media/output") {
      const sampleRateHz = parseOptionalPositiveIntegerHeader(request.headers["x-sample-rate-hz"], "voice_session_sample_rate_invalid");
      if (sampleRateHz !== undefined && typeof sampleRateHz !== "number") {
        writeBadRequest(response, sampleRateHz.error);
        return;
      }
      const body = await readRawBody(request);
      if (body.byteLength === 0) {
        writeBadRequest(response, "voice_session_media_output_empty");
        return;
      }
      const updated = voiceSessions.recordOutputChunk(sessionId, {
        bytes: body.byteLength,
        mimeType: request.headers["content-type"]?.toString(),
        sampleRateHz,
        streamId: Array.isArray(request.headers["x-output-stream-id"]) ? request.headers["x-output-stream-id"][0] : request.headers["x-output-stream-id"],
        final: parseBooleanHeader(request.headers["x-output-final"]),
      });
      if (!updated) {
        writeJson(response, 409, { ok: false, error: "voice_session_closed" });
        return;
      }
      writeJson(response, 202, { ok: true, route: "/api/voice/sessions/:id/media/output", session: updated, accepted: true });
      return;
    }

    if (request.method === "POST" && action === "control") {
      const body = await readJsonBody<unknown>(request);
      if (!isRecord(body)) {
        writeBadRequest(response, "json_object_required");
        return;
      }
      const controlAction = getOptionalTrimmedString(body.action);
      if (!controlAction || !isVoiceSessionControlAction(controlAction)) {
        writeBadRequest(response, "voice_session_control_action_invalid");
        return;
      }
      const updated = voiceSessions.recordControl(sessionId, { action: controlAction, reason: getOptionalTrimmedString(body.reason) });
      if (!updated) {
        writeJson(response, 409, { ok: false, error: "voice_session_closed" });
        return;
      }
      writeJson(response, 200, { ok: true, route: "/api/voice/sessions/:id/control", session: updated });
      return;
    }

    if (request.method === "POST" && action === "close") {
      const updated = voiceSessions.close(sessionId);
      writeJson(response, 200, { ok: true, route: "/api/voice/sessions/:id/close", session: updated });
      return;
    }
  }

  if (request.method === "GET" && pathname === "/api/cluecon") {
    writeJson(response, 200, await buildClueConPayloadWithLiveProbes(config, {}, activeClueConBrainBlocks));
    return;
  }

  if (request.method === "GET" && pathname === "/api/cluecon/asr/models") {
    const targets = getRtcAsrModelTargets();
    if (!targets.length) {
      writeJson(response, 503, {
        ok: false,
        error: "rtc_asr_not_configured",
        models: [],
        nextStep: "Set RTC_ASR_BASE_URL or RTC_ASR_MODEL_ENDPOINTS, then restart the presentation server.",
      });
      return;
    }

    const models = await Promise.all(
      targets.map(async (target) => {
        try {
          const result = await fetchRtcAsrJson(target, "/api/models");
          const payload = result.payload && typeof result.payload === "object" && !Array.isArray(result.payload)
            ? result.payload as Record<string, unknown>
            : {};
          return {
            targetId: target.id,
            targetLabel: target.label,
            websocketUrl: getRtcAsrWebsocketUrl(target),
            backend: typeof payload.backend === "string" ? payload.backend : "unknown",
            model: typeof payload.model === "string" ? payload.model : target.label,
            status: typeof payload.status === "string" ? payload.status : result.response.ok ? "ready" : "unavailable",
            ready: result.response.ok && payload.ready !== false,
            loaded: Array.isArray(payload.models)
              ? payload.models.some((model) => model && typeof model === "object" && !Array.isArray(model) && (model as { loaded?: unknown }).loaded === true)
              : null,
            responseMs: result.elapsedMs,
            error: result.response.ok ? null : `rtc-asr returned HTTP ${result.response.status}`,
          };
        } catch (error) {
          return {
            targetId: target.id,
            targetLabel: target.label,
            websocketUrl: getRtcAsrWebsocketUrl(target),
            backend: "unknown",
            model: target.label,
            status: "unavailable",
            ready: false,
            loaded: null,
            responseMs: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    writeJson(response, 200, {
      ok: models.some((model) => model.ready),
      activeTargetId: models.find((model) => model.ready)?.targetId ?? models[0]?.targetId ?? null,
      models,
      switchContract: "Each model target is a separately warmed rtc-asr endpoint configured by RTC_ASR_MODEL_ENDPOINTS.",
      benchmarkUrl: "https://agonza1.github.io/rtc-asr/docs/",
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/cluecon/asr/transcribe") {
    const body = await readJsonBody<unknown>(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }
    const record = body as Record<string, unknown>;
    const audioData = typeof record.audioData === "string" ? record.audioData.trim() : "";
    if (!audioData || audioData.length > 5_600_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioData)) {
      writeBadRequest(response, "rtc_asr_audio_data_invalid");
      return;
    }
    const sampleRate = typeof record.sampleRate === "number" && Number.isFinite(record.sampleRate)
      ? Math.trunc(record.sampleRate)
      : 16_000;
    if (sampleRate < 8_000 || sampleRate > 96_000) {
      writeBadRequest(response, "rtc_asr_sample_rate_invalid");
      return;
    }

    const targets = getRtcAsrModelTargets();
    const requestedTargetId = typeof record.targetId === "string" ? record.targetId.trim() : "";
    const target = targets.find((candidate) => candidate.id === requestedTargetId) ?? (!requestedTargetId ? targets[0] : undefined);
    if (!target) {
      writeJson(response, 503, {
        ok: false,
        error: targets.length ? "rtc_asr_model_target_unknown" : "rtc_asr_not_configured",
        availableTargetIds: targets.map((candidate) => candidate.id),
      });
      return;
    }

    try {
      const result = await fetchRtcAsrJson(target, "/api/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audio_data: audioData,
          language: typeof record.language === "string" && record.language.trim() ? record.language.trim() : "en",
          sample_rate: sampleRate,
          stream: false,
        }),
      });
      const upstream = result.payload && typeof result.payload === "object" && !Array.isArray(result.payload)
        ? result.payload as Record<string, unknown>
        : { detail: result.payload };
      writeJson(response, result.response.ok ? 200 : 502, {
        ok: result.response.ok,
        targetId: target.id,
        targetLabel: target.label,
        responseMs: result.elapsedMs,
        transcription: upstream,
        error: result.response.ok ? null : `rtc-asr returned HTTP ${result.response.status}`,
      });
    } catch (error) {
      writeJson(response, 502, {
        ok: false,
        targetId: target.id,
        targetLabel: target.label,
        error: error instanceof Error ? error.message : String(error),
        nextStep: "Confirm the selected rtc-asr model endpoint is running and ready.",
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/cluecon/tts/synthesize") {
    const body = await readJsonBody<unknown>(request);
    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }
    const text = getOptionalTrimmedString(body.text);
    if (!text || text.length > 500) {
      writeBadRequest(response, "tts_text_invalid");
      return;
    }
    const requestedProvider = (getOptionalTrimmedString(body.provider) ?? getConfiguredTtsProvider()).toLowerCase();
    if (requestedProvider !== "kokoro" && requestedProvider !== "pocket") {
      writeBadRequest(response, "tts_provider_invalid");
      return;
    }
    const provider = requestedProvider as "kokoro" | "pocket";
    const target = getTtsSpeechTarget(provider);
    if (!target) {
      writeJson(response, 503, {
        ok: false,
        provider,
        error: `${provider}_not_configured`,
        nextStep: provider === "pocket"
          ? "Set POCKET_TTS_BASE_URL, start the local Pocket TTS service, and retry."
          : "Set KOKORO_BASE_URL, start the local Kokoro sidecar, and retry.",
      });
      return;
    }
    const requestedVoice = getOptionalTrimmedString(body.voice);
    const voice = requestedVoice && /^[a-z0-9_-]{1,64}$/i.test(requestedVoice) ? requestedVoice : target.voice;
    const startedAt = performance.now();
    const idleTimeoutMs = getTtsIdleTimeoutMs(provider);
    const controller = new AbortController();
    let idleTimeout = setTimeout(() => controller.abort(), idleTimeoutMs);
    const refreshIdleTimeout = () => {
      clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => controller.abort(), idleTimeoutMs);
    };
    try {
      const upstream = await fetch(target.url, {
        method: "POST",
        headers: {
          accept: target.contentType,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: target.model,
          voice,
          input: text,
          response_format: target.responseFormat,
          stream: true,
        }),
        signal: controller.signal,
      });
      refreshIdleTimeout();
      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => "");
        writeJson(response, 502, {
          ok: false,
          provider: target.provider,
          error: `${target.provider}_synthesis_failed`,
          upstreamStatus: upstream.status,
          detail: detail.slice(0, 500),
        });
        return;
      }

      const reader = upstream.body.getReader();
      const first = await reader.read();
      if (first.done || !first.value?.byteLength) {
        writeJson(response, 502, {
          ok: false,
          provider: target.provider,
          error: `${target.provider}_returned_no_audio`,
        });
        return;
      }
      refreshIdleTimeout();
      const upstreamTtfbMs = Math.round((performance.now() - startedAt) * 10) / 10;
      const upstreamContentType = upstream.headers.get("content-type");
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": upstreamContentType?.startsWith("audio/") ? upstreamContentType : "audio/mpeg",
        "x-acc-tts-provider": target.provider,
        "x-acc-tts-model": target.model,
        "x-acc-tts-voice": voice,
        "x-acc-tts-streaming": "true",
        "x-acc-tts-through": "acc_provider_proxy",
        "x-acc-upstream-ttfb-ms": String(upstreamTtfbMs),
        "x-acc-tts-idle-timeout-ms": String(idleTimeoutMs),
      });
      response.write(first.value);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value?.byteLength) {
          refreshIdleTimeout();
          response.write(chunk.value);
        }
      }
      response.end();
    } catch (error) {
      if (!response.headersSent) {
        writeJson(response, 502, {
          ok: false,
          provider: target.provider,
          error: `${target.provider}_unreachable`,
          detail: error instanceof Error ? error.message : String(error),
          nextStep: target.provider === "pocket"
            ? "Confirm POCKET_TTS_BASE_URL points to a warmed Pocket OpenAI-compatible speech endpoint."
            : "Confirm KOKORO_BASE_URL points to a warmed Kokoro OpenAI-compatible speech endpoint.",
        });
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      clearTimeout(idleTimeout);
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/cluecon/brain/preview") {
    const body = await readJsonBody<unknown>(request);
    const preview = buildClueConBrainPreview(body, activeClueConBrainBlocks) as { ok: boolean };
    activeClueConBrainEvidence.push({
      id: `brain-preview-${activeClueConBrainEvidence.length + 1}`,
      type: "preview",
      revision: activeClueConBrainRevision,
      changedFiles: "changedFiles" in preview && Array.isArray(preview.changedFiles) ? preview.changedFiles as string[] : [],
      createdAt: new Date().toISOString(),
    });
    writeJson(response, preview.ok ? 200 : 400, {
      ...preview,
      workboardCard: clueConAgentBrainCard,
      revision: activeClueConBrainRevision,
      evidenceTrail: activeClueConBrainEvidence.slice(-8),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/cluecon/brain/apply") {
    const body = await readJsonBody<unknown>(request);
    const normalized = normalizeClueConBrainBlocks(body);
    if (!normalized.ok) {
      writeJson(response, 400, {
        ok: false,
        errors: normalized.errors,
        workboardCard: clueConAgentBrainCard,
        mutation: "rejected",
        corruptsRuntime: false,
      });
      return;
    }

    const previousByFile = new Map(activeClueConBrainBlocks.map((block) => [block.file, block.summary]));
    const changedFiles = normalized.blocks
      .filter((block) => previousByFile.get(block.file) !== block.summary)
      .map((block) => block.file);
    activeClueConBrainBlocks = normalized.blocks;
    activeClueConBrainRevision += 1;
    activeClueConBrainEvidence.push({
      id: `brain-apply-${activeClueConBrainRevision}`,
      type: "apply",
      revision: activeClueConBrainRevision,
      changedFiles,
      createdAt: new Date().toISOString(),
    });
    const payload = buildClueConPayload(config, activeClueConBrainBlocks);
    writeJson(response, 200, {
      ok: true,
      applied: true,
      mutation: "session_scoped_in_memory",
      corruptsRuntime: false,
      workboardCard: clueConAgentBrainCard,
      revision: activeClueConBrainRevision,
      changedFiles,
      activeBrainBlocks: activeClueConBrainBlocks,
      brainPanel: payload.brainPanel,
      evidenceTrail: activeClueConBrainEvidence.slice(-8),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/cluecon/brain/reset") {
    activeClueConBrainBlocks = defaultClueConBrainBlocks();
    activeClueConBrainRevision += 1;
    activeClueConBrainEvidence.push({
      id: `brain-reset-${activeClueConBrainRevision}`,
      type: "reset",
      revision: activeClueConBrainRevision,
      changedFiles: activeClueConBrainBlocks.map((block) => block.file),
      createdAt: new Date().toISOString(),
    });
    const payload = buildClueConPayload(config, activeClueConBrainBlocks);
    writeJson(response, 200, {
      ok: true,
      reset: true,
      mutation: "session_scoped_in_memory",
      corruptsRuntime: false,
      workboardCard: clueConAgentBrainCard,
      revision: activeClueConBrainRevision,
      activeBrainBlocks: activeClueConBrainBlocks,
      brainPanel: payload.brainPanel,
      evidenceTrail: activeClueConBrainEvidence.slice(-8),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/cluecon/eval/preview") {
    writeJson(response, 200, buildClueConEvalPreviewPayload());
    return;
  }

  if (request.method === "POST" && pathname === "/api/cluecon/eval/run") {
    const { latest, steps } = await runEndToEndDemoFlow(ingress, config, {
      openclawSessionLabel: "cluecon/eval-proof",
      source: "mock_http_route",
    });
    const proof = buildCallProofBundlePayload(latest);
    const scorecard = buildClueConEvalScorecard(latest);
    const assertRequestPreview = buildClueConAssertRequestPreview(latest, proof);
    writeJson(response, 201, {
      ok: true,
      route: "/api/cluecon/eval/run",
      workboardCard: clueConProofEvalCard,
      compatibleRequest: "conversation-agent-evals-assert-request.json",
      summary: scorecard.overallPassed
        ? "The local ACC safety and evidence scorecard passed; a CAE-compatible handoff is ready."
        : "ClueCon scripted run produced failing checks for review.",
      steps,
      scorecard,
      assertRequestPreview,
      proof,
      proofLinks: {
        transcript: latest.session.openclawSession.artifactLinks.transcript,
        events: latest.session.openclawSession.artifactLinks.events,
        latencyMarks: latest.session.openclawSession.artifactLinks.latencyMarks,
        proof: latest.session.openclawSession.artifactLinks.proof,
        operatorConsole: `/api/operator/console?callId=${encodeURIComponent(latest.session.callId)}`,
      },
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/cluecon/operator/drill") {
    const body = await readJsonBody<unknown>(request);
    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    if (!isClueConOperatorDrillKind(body.kind)) {
      writeBadRequest(response, "cluecon_operator_drill_kind_invalid");
      return;
    }

    const drill = await runClueConOperatorDrill(ingress, config, body.kind);
    const proof = buildCallProofBundlePayload(drill.latest);
    writeJson(response, 201, {
      ok: true,
      route: "/api/cluecon/operator/drill",
      workboardCard: clueConOperatorCockpitCard,
      kind: body.kind,
      outcome: drill.outcome,
      summary: drill.summary,
      completedControlStages: drill.completedControlStages,
      integration: drill.integration,
      simulatedEvents: drill.steps.map((step) => step.step),
      steps: drill.steps,
      call: buildCallPayload(drill.latest),
      operatorConsoleCall: buildOperatorConsoleCallPayload(drill.latest),
      proof,
      proofLinks: {
        snapshot: drill.latest.session.openclawSession.artifactLinks.snapshot,
        events: drill.latest.session.openclawSession.artifactLinks.events,
        proof: drill.latest.session.openclawSession.artifactLinks.proof,
        operatorConsole: `/api/operator/console?openclawSessionLabel=${encodeURIComponent(drill.latest.session.openclawSession.label)}`,
      },
    });
    return;
  }

  if (request.method === "GET" && pathname === "/cluecon/system-unavailable.mp3") {
    response.writeHead(200, {
      "content-type": "audio/mpeg",
      "content-length": clueConSystemUnavailableAudio.byteLength,
      "cache-control": "public, max-age=86400",
    });
    response.end(clueConSystemUnavailableAudio);
    return;
  }

  if (request.method === "GET" && pathname === "/cluecon/alberto-echo-show-prototype.jpg") {
    response.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": clueConVoiceOriginPhoto.byteLength,
      "cache-control": "public, max-age=86400",
    });
    response.end(clueConVoiceOriginPhoto);
    return;
  }

  if (request.method === "GET" && pathname === "/cluecon") {
    response.setHeader("cache-control", "no-store, max-age=0");
    writeHtml(response, 200, buildClueConHtml(config, "scroll", activeClueConBrainBlocks));
    return;
  }

  if (request.method === "GET" && pathname === "/cluecon/present") {
    response.setHeader("cache-control", "no-store, max-age=0");
    writeHtml(response, 200, buildClueConHtml(config, "present", activeClueConBrainBlocks));
    return;
  }

  if (request.method === "GET" && (pathname === "/" || pathname === "/operator" || pathname === "/operator/console")) {
    writeHtml(response, 200, buildOperatorConsoleHtml());
    return;
  }

  if (request.method === "GET" && pathname === "/reliability") {
    writeHtml(response, 200, buildReliabilityGuideHtml());
    return;
  }

  if (request.method === "GET" && pathname === "/assert/full") {
    writeHtml(response, 200, buildAssertFullViewerHtml());
    return;
  }

  if (request.method === "GET" && pathname === "/assert") {
    writeHtml(response, 200, buildAssertViewerHtml());
    return;
  }

  if (request.method === "GET" && pathname === "/assert/spec") {
    writeHtml(response, 200, buildAssertSpecEditorHtml());
    return;
  }

  if (request.method === "GET" && pathname === "/api/assert/spec") {
    writeJson(response, 200, {
      ok: true,
      spec: activeAssertEvaluationSpec,
      yaml: assertSpecToYaml(activeAssertEvaluationSpec),
      blocks: assertSpecBlocks,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/assert/spec/preview") {
    const body = await readJsonBody<unknown>(request);
    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const spec = parseAssertEvaluationSpec(body.spec);
    if (!spec) {
      writeBadRequest(response, "assert_spec_invalid");
      return;
    }

    writeJson(response, 200, {
      ok: true,
      spec,
      yaml: assertSpecToYaml(spec),
      blocks: assertSpecBlocks,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/assert/spec") {
    const body = await readJsonBody<unknown>(request);
    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const spec = parseAssertEvaluationSpec(body.spec);
    if (!spec) {
      writeBadRequest(response, "assert_spec_invalid");
      return;
    }

    activeAssertEvaluationSpec = cloneAssertEvaluationSpec(spec);
    writeJson(response, 200, {
      ok: true,
      spec: activeAssertEvaluationSpec,
      yaml: assertSpecToYaml(activeAssertEvaluationSpec),
      blocks: assertSpecBlocks,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/assert/spec/reset") {
    activeAssertEvaluationSpec = cloneAssertEvaluationSpec(defaultAssertEvaluationSpec);
    writeJson(response, 200, {
      ok: true,
      spec: activeAssertEvaluationSpec,
      yaml: assertSpecToYaml(activeAssertEvaluationSpec),
      blocks: assertSpecBlocks,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/operator/actions") {
    writeJson(response, 200, buildOperatorActionsPayload());
    return;
  }

  if (request.method === "POST" && pathname === "/api/live-sip/events") {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const eventType = getOptionalTrimmedString(body.eventType);
    if (!eventType || !["call.started", "agent.greeting", "media.capture", "media.playback", "media.transcript", "rtc_asr.blocked", "call.ended", "call.error"].includes(eventType)) {
      writeBadRequest(response, "live_sip_event_type_invalid");
      return;
    }

    const timestamp = normalizeTimestamp(body.timestamp, "live_sip_timestamp_invalid");
    if (typeof timestamp !== "string") {
      writeBadRequest(response, timestamp.error);
      return;
    }

    const sipCallId = getOptionalTrimmedString(body.sipCallId) ?? getOptionalTrimmedString(body.fsUuid) ?? getOptionalTrimmedString(body.callId);
    if (!sipCallId) {
      writeBadRequest(response, "live_sip_call_id_required");
      return;
    }
    const linkedSipCallId = getOptionalTrimmedString(body.linkedSipCallId)
      ?? getOptionalTrimmedString(body.linkedFsUuid)
      ?? getOptionalTrimmedString(body.parentSipCallId)
      ?? getOptionalTrimmedString(body.alegUuid);
    const vertoCallId = getOptionalTrimmedString(body.vertoCallId);
    const fsUuid = getOptionalTrimmedString(body.fsUuid);
    const destinationNumber = normalizeLiveSipDestination(
      body.destinationNumber ?? body.destination ?? body.extension ?? body.calledNumber,
    );
    if (body.conversationMode !== undefined && !isConversationMode(body.conversationMode)) {
      writeBadRequest(response, "live_sip_conversation_mode_invalid");
      return;
    }
    const liveSipConversationMode = normalizeLiveSipConversationMode(body.conversationMode, destinationNumber);
    const canonicalSipCallId = linkedSipCallId ?? sipCallId;
    const liveSipCorrelationIds = uniqueLiveSipCallIds(canonicalSipCallId, sipCallId, linkedSipCallId, vertoCallId, fsUuid);

    const prelockCallId =
      getMappedLiveSipCallId(liveSipCallMap, liveSipCorrelationIds)
      ?? getMappedLiveSipEndedCallId(liveSipEndedCallMap, liveSipCorrelationIds);
    const prelockSnapshots = prelockCallId ? [] : await listLiveSipSnapshotsByProviderIds(ingress, liveSipCorrelationIds);
	    const prelockActiveSnapshot = prelockSnapshots.find((snapshot) => !isLiveSipCallEnded(snapshot));
	    const liveSipCallLockKey = prelockCallId ?? prelockActiveSnapshot?.session.callId ?? canonicalSipCallId;

	    if (eventType === "media.transcript") {
	      const text = getOptionalTrimmedString(body.text) ?? getOptionalTrimmedString(body.transcript);
	      if (!text) {
	        writeBadRequest(response, "live_sip_transcript_text_required");
	        return;
	      }

	      const voiceSessionId = getOptionalTrimmedString(body.voiceSessionId);
	      const realtimeVoiceSessionId = getOptionalTrimmedString(body.realtimeVoiceSessionId);
	      const voiceSessionScope = {
	        ...(voiceSessionId ? { voiceSessionId } : {}),
	        ...(realtimeVoiceSessionId ? { realtimeVoiceSessionId } : {}),
	      };
	      let mediaTranscriptCallId: string | null = null;
	      let mediaTranscriptConversationMode: ConversationMode | null = null;
	      let mediaTranscriptResponseWritten = false;

	      await withLiveSipCallLock(liveSipCallLocks, liveSipCallLockKey, async () => {
	        const callId = getMappedLiveSipCallId(liveSipCallMap, liveSipCorrelationIds);
	        const endedCallId = getMappedLiveSipEndedCallId(liveSipEndedCallMap, liveSipCorrelationIds);
	        if (!callId && endedCallId) {
	          const endedSnapshot = await ingress.getSnapshot(endedCallId);
	          if (endedSnapshot && isLiveSipCallEnded(endedSnapshot)) {
	            writeBadRequest(response, "live_sip_call_not_started");
	            mediaTranscriptResponseWritten = true;
	            return;
	          }
	          deleteLiveSipEndedCallAliases(liveSipEndedCallMap, liveSipCorrelationIds);
	        }
	        if (!callId) {
	          writeBadRequest(response, "live_sip_call_not_started");
	          mediaTranscriptResponseWritten = true;
	          return;
	        }
	        const currentSnapshot = await ingress.getSnapshot(callId);
	        if (!currentSnapshot || isLiveSipCallEnded(currentSnapshot)) {
	          writeBadRequest(response, "live_sip_call_not_started");
	          mediaTranscriptResponseWritten = true;
	          return;
	        }
	        const conversationMode = currentSnapshot.scenario.conversationMode;
	        if (isOpenAiLiveSipAutomationStopped(currentSnapshot)) {
	          await rejectHeldLiveSipCallerTurn(
	            response,
	            ingress,
	            callId,
	            text,
	            timestamp,
	            getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
	            "/api/live-sip/events",
	            "openai_fail_closed_handoff_active",
	            { eventType, sipCallId },
	            voiceSessionScope,
	          );
	          mediaTranscriptResponseWritten = true;
	          return;
	        }
	        const currentOperatorHoldReason = getLiveSipCallerTurnHoldReason(currentSnapshot, conversationMode);
	        if (currentOperatorHoldReason) {
	          await rejectHeldLiveSipCallerTurn(
	            response,
	            ingress,
	            callId,
	            text,
	            timestamp,
	            getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
	            "/api/live-sip/events",
	            currentOperatorHoldReason,
	            { eventType, sipCallId },
	            voiceSessionScope,
	          );
	          mediaTranscriptResponseWritten = true;
	          return;
	        }
	        if (conversationMode !== "openai_llm") {
	          await ingress.appendCallerTurn(callId, { speaker: "caller", text, timestamp }, config, {
	            ...voiceSessionScope,
	            conversationMode,
	          });
	          const snapshot = await ingress.recordLiveTelephonyEvidence(callId, {
	            eventType: "rtc_asr_transcript",
	            timestamp,
	            detail: {
	              provider: "rtc-asr",
	              transcriptText: text,
	              evidencePath: getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
	              ...voiceSessionScope,
	            },
	          });
	          writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, call: buildCallPayload(snapshot) });
	          mediaTranscriptResponseWritten = true;
	          return;
	        }
	        mediaTranscriptCallId = callId;
	        mediaTranscriptConversationMode = conversationMode;
	      });

	      if (mediaTranscriptResponseWritten) return;
	      if (!mediaTranscriptCallId || mediaTranscriptConversationMode !== "openai_llm") {
	        writeBadRequest(response, "live_sip_call_not_started");
	        return;
	      }
	      const openAiMediaTranscriptCallId = mediaTranscriptCallId;
	      const openAiMediaTranscriptConversationMode = mediaTranscriptConversationMode;

	      await withLiveSipOpenAiGenerationLock(liveSipOpenAiGenerationLocks, openAiMediaTranscriptCallId, async () => {
	        const lockedSnapshot = await ingress.getSnapshot(openAiMediaTranscriptCallId);
	        if (!lockedSnapshot || isLiveSipCallEnded(lockedSnapshot)) {
	          writeBadRequest(response, "live_sip_call_not_started");
	          return;
	        }
	        if (isOpenAiLiveSipAutomationStopped(lockedSnapshot)) {
	          await withLiveSipCallLock(liveSipCallLocks, openAiMediaTranscriptCallId, async () => {
	            await rejectHeldLiveSipCallerTurn(
	              response,
	              ingress,
	              openAiMediaTranscriptCallId,
	              text,
	              timestamp,
	              getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
	              "/api/live-sip/events",
	              "openai_fail_closed_handoff_active",
	              { eventType, sipCallId },
	              voiceSessionScope,
	            );
	          });
	          return;
	        }
	        const lockedOperatorHoldReason = getLiveSipCallerTurnHoldReason(lockedSnapshot, openAiMediaTranscriptConversationMode);
	        if (lockedOperatorHoldReason) {
	          await withLiveSipCallLock(liveSipCallLocks, openAiMediaTranscriptCallId, async () => {
	            await rejectHeldLiveSipCallerTurn(
	              response,
	              ingress,
	              openAiMediaTranscriptCallId,
	              text,
	              timestamp,
	              getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
	              "/api/live-sip/events",
	              lockedOperatorHoldReason,
	              { eventType, sipCallId },
	              voiceSessionScope,
	            );
	          });
	          return;
	        }
	        const openAiLlm = await generateOpenAiLiveSipResponse(lockedSnapshot, text, timestamp);
	        await withLiveSipCallLock(liveSipCallLocks, openAiMediaTranscriptCallId, async () => {
	          const latestSnapshot = await ingress.getSnapshot(openAiMediaTranscriptCallId);
	          if (!latestSnapshot || isLiveSipCallEnded(latestSnapshot)) {
	            writeBadRequest(response, "live_sip_call_not_started");
	            return;
	          }
	          if (isOpenAiLiveSipAutomationStopped(latestSnapshot)) {
	            await rejectHeldLiveSipCallerTurn(
	              response,
	              ingress,
	              openAiMediaTranscriptCallId,
	              text,
	              timestamp,
	              getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
	              "/api/live-sip/events",
	              "openai_fail_closed_handoff_active",
	              { eventType, sipCallId },
	              voiceSessionScope,
	            );
	            return;
	          }
	          const latestOperatorHoldReason = getLiveSipCallerTurnHoldReason(latestSnapshot, openAiMediaTranscriptConversationMode);
	          if (latestOperatorHoldReason) {
	            await rejectHeldLiveSipCallerTurn(
	              response,
	              ingress,
	              openAiMediaTranscriptCallId,
	              text,
	              timestamp,
	              getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
	              "/api/live-sip/events",
	              latestOperatorHoldReason,
	              { eventType, sipCallId },
	              voiceSessionScope,
	            );
	            return;
	          }
	          await ingress.appendCallerTurn(openAiMediaTranscriptCallId, { speaker: "caller", text, timestamp }, config, {
	            ...voiceSessionScope,
	            conversationMode: openAiMediaTranscriptConversationMode,
	            openAiLlm,
	          });
	          const snapshot = await ingress.recordLiveTelephonyEvidence(openAiMediaTranscriptCallId, {
	            eventType: "rtc_asr_transcript",
	            timestamp,
	            detail: {
	              provider: "rtc-asr",
	              transcriptText: text,
	              evidencePath: getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
	              ...voiceSessionScope,
	            },
	          });
	          writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, call: buildCallPayload(snapshot) });
	        });
	      });
	      return;
	    }

	    await withLiveSipCallLock(liveSipCallLocks, liveSipCallLockKey, async () => {
      if (eventType === "call.started") {
        const existingCallId = getMappedLiveSipCallId(liveSipCallMap, liveSipCorrelationIds);
        if (existingCallId) {
          const existingSnapshot = await ingress.getSnapshot(existingCallId);
          if (existingSnapshot) {
            if (isLiveSipCallEnded(existingSnapshot)) {
              writeBadRequest(response, "live_sip_call_already_ended");
              return;
            }
            setLiveSipCallAliases(liveSipCallMap, liveSipCorrelationIds, existingSnapshot.session.callId);
            writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, linkedSipCallId, vertoCallId, correlationIds: liveSipCorrelationIds, call: buildCallPayload(existingSnapshot), idempotent: true });
            return;
          }
          deleteLiveSipCallAliases(liveSipCallMap, liveSipCorrelationIds);
        }
        const endedCallId = getMappedLiveSipEndedCallId(liveSipEndedCallMap, liveSipCorrelationIds);
        if (endedCallId) {
          const endedSnapshot = await ingress.getSnapshot(endedCallId);
          if (endedSnapshot && isLiveSipCallEnded(endedSnapshot)) {
            writeBadRequest(response, "live_sip_call_already_ended");
            return;
          }
          deleteLiveSipEndedCallAliases(liveSipEndedCallMap, liveSipCorrelationIds);
        }
        const matchingSnapshots = await listLiveSipSnapshotsByProviderIds(ingress, liveSipCorrelationIds);
        const matchingSnapshot = matchingSnapshots.find((snapshot) => !isLiveSipCallEnded(snapshot));
        if (matchingSnapshot) {
          setLiveSipCallAliases(liveSipCallMap, liveSipCorrelationIds, matchingSnapshot.session.callId);
          writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, linkedSipCallId, vertoCallId, correlationIds: liveSipCorrelationIds, call: buildCallPayload(matchingSnapshot), idempotent: true });
          return;
        }
        const endedMatchingSnapshot = matchingSnapshots.find((snapshot) => isLiveSipCallEnded(snapshot));
        if (endedMatchingSnapshot) {
          setLiveSipEndedCallAliases(liveSipEndedCallMap, liveSipCorrelationIds, endedMatchingSnapshot.session.callId);
          writeBadRequest(response, "live_sip_call_already_ended");
          return;
        }
        const telephonyMode = body.telephonyMode === "signalwire_live" ? "signalwire_live" : "local_sip";
        const snapshot = await ingress.startCall(config, {
          providerName: telephonyMode === "signalwire_live" ? "signalwire" : "freeswitch-local-sip",
          providerCallId: canonicalSipCallId,
          openclawSessionId: `live-sip-${canonicalSipCallId}`,
          openclawSessionLabel: `${telephonyMode}/${destinationNumber ?? "unknown"}/${canonicalSipCallId}`,
          source: normalizeLiveSipIngressSource(body.source),
          conversationMode: liveSipConversationMode,
          sipExtension: destinationNumber,
          runtimeModeLabels: {
            telephony: telephonyMode,
            media: "live_capture",
            rtcAsr: body.rtcAsrMode === "rtc_asr_live" ? "rtc_asr_live" : "rtc_asr_blocked",
            credentialsMode: telephonyMode === "signalwire_live" ? "signalwire_live" : "mocked",
          },
        });
        setLiveSipCallAliases(liveSipCallMap, liveSipCorrelationIds, snapshot.session.callId);
        writeJson(response, 201, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, linkedSipCallId, vertoCallId, correlationIds: liveSipCorrelationIds, call: buildCallPayload(snapshot) });
        return;
      }

      let callId = getMappedLiveSipCallId(liveSipCallMap, liveSipCorrelationIds);
      const endedCallId = getMappedLiveSipEndedCallId(liveSipEndedCallMap, liveSipCorrelationIds);
      if (!callId && endedCallId) {
        const endedSnapshot = await ingress.getSnapshot(endedCallId);
        if (endedSnapshot && isLiveSipCallEnded(endedSnapshot)) {
          if (eventType === "call.ended") {
            purgeCallerTurnDeliveryAckPreviewsForCall(callerTurnDeliveryAckPreviews, endedSnapshot.session.callId);
            writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, linkedSipCallId, vertoCallId, correlationIds: liveSipCorrelationIds, call: buildCallPayload(endedSnapshot), idempotent: true });
          } else {
            writeBadRequest(response, "live_sip_call_not_started");
          }
          return;
        }
        deleteLiveSipEndedCallAliases(liveSipEndedCallMap, liveSipCorrelationIds);
      }
      if (!callId && eventType === "call.ended") {
        const matchingSnapshot = (await listLiveSipSnapshotsByProviderIds(ingress, liveSipCorrelationIds))[0];
        if (matchingSnapshot) {
          callId = matchingSnapshot.session.callId;
          const alreadyEnded = matchingSnapshot.events.some((event) => event.type === "sip_call_ended");
          if (alreadyEnded) {
            purgeCallerTurnDeliveryAckPreviewsForCall(callerTurnDeliveryAckPreviews, matchingSnapshot.session.callId);
            writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, linkedSipCallId, vertoCallId, correlationIds: liveSipCorrelationIds, call: buildCallPayload(matchingSnapshot), idempotent: true });
            return;
          }
        }
      }
      if (!callId) {
        writeBadRequest(response, "live_sip_call_not_started");
        return;
      }
      if (eventType === "call.ended") {
        const existingSnapshot = await ingress.getSnapshot(callId);
        if (existingSnapshot?.events.some((event) => event.type === "sip_call_ended")) {
          purgeCallerTurnDeliveryAckPreviewsForCall(callerTurnDeliveryAckPreviews, callId);
          writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, linkedSipCallId, vertoCallId, correlationIds: liveSipCorrelationIds, call: buildCallPayload(existingSnapshot), idempotent: true });
          return;
        }
      } else {
        const existingSnapshot = await ingress.getSnapshot(callId);
        if (existingSnapshot && isLiveSipCallEnded(existingSnapshot)) {
          writeBadRequest(response, "live_sip_call_not_started");
          return;
        }
      }

    const voiceSessionId = getOptionalTrimmedString(body.voiceSessionId);
    const realtimeVoiceSessionId = getOptionalTrimmedString(body.realtimeVoiceSessionId);
    const voiceSessionScope = {
      ...(voiceSessionId ? { voiceSessionId } : {}),
      ...(realtimeVoiceSessionId ? { realtimeVoiceSessionId } : {}),
    };

    try {
      if (eventType === "agent.greeting") {
        const text = getOptionalTrimmedString(body.text);
        if (!text) {
          writeBadRequest(response, "live_sip_agent_greeting_text_required");
          return;
        }
        const snapshot = await ingress.recordInitialAgentGreeting(callId, text, timestamp);
        writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, call: buildCallPayload(snapshot) });
        return;
      }

      if (eventType === "media.transcript") {
        const text = getOptionalTrimmedString(body.text) ?? getOptionalTrimmedString(body.transcript);
        if (!text) {
          writeBadRequest(response, "live_sip_transcript_text_required");
          return;
        }
        const currentSnapshot = await ingress.getSnapshot(callId);
        if (!currentSnapshot || isLiveSipCallEnded(currentSnapshot)) {
          writeBadRequest(response, "live_sip_call_not_started");
          return;
        }
        const conversationMode = currentSnapshot.scenario.conversationMode;
        if (isOpenAiLiveSipAutomationStopped(currentSnapshot)) {
          await rejectHeldLiveSipCallerTurn(
            response,
            ingress,
            callId,
            text,
            timestamp,
            getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
            "/api/live-sip/events",
            "openai_fail_closed_handoff_active",
            { eventType, sipCallId },
            voiceSessionScope,
          );
          return;
        }
        const currentOperatorHoldReason = getLiveSipCallerTurnHoldReason(currentSnapshot, conversationMode);
        if (currentOperatorHoldReason) {
          await rejectHeldLiveSipCallerTurn(
            response,
            ingress,
            callId,
            text,
            timestamp,
            getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
            "/api/live-sip/events",
            currentOperatorHoldReason,
            { eventType, sipCallId },
            voiceSessionScope,
          );
          return;
        }
        if (conversationMode === "openai_llm") {
          await withLiveSipOpenAiGenerationLock(liveSipOpenAiGenerationLocks, callId, async () => {
            const lockedSnapshot = await ingress.getSnapshot(callId);
            if (!lockedSnapshot || isLiveSipCallEnded(lockedSnapshot)) {
              writeBadRequest(response, "live_sip_call_not_started");
              return;
            }
            if (isOpenAiLiveSipAutomationStopped(lockedSnapshot)) {
              await rejectHeldLiveSipCallerTurn(
                response,
                ingress,
                callId,
                text,
                timestamp,
                getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
                "/api/live-sip/events",
                "openai_fail_closed_handoff_active",
                { eventType, sipCallId },
                voiceSessionScope,
              );
              return;
            }
            const lockedOperatorHoldReason = getLiveSipCallerTurnHoldReason(lockedSnapshot, conversationMode);
            if (lockedOperatorHoldReason) {
              await rejectHeldLiveSipCallerTurn(
                response,
                ingress,
                callId,
                text,
                timestamp,
                getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
                "/api/live-sip/events",
                lockedOperatorHoldReason,
                { eventType, sipCallId },
                voiceSessionScope,
              );
              return;
            }
            const openAiLlm = await generateOpenAiLiveSipResponse(lockedSnapshot, text, timestamp);
            let latestSnapshot = await ingress.getSnapshot(callId);
            if (openAiLlm?.ok && latestSnapshot && latestSnapshot.events.length === lockedSnapshot.events.length) {
              await new Promise<void>((resolve) => setImmediate(resolve));
              const recheckedSnapshot = await ingress.getSnapshot(callId);
              if (recheckedSnapshot) latestSnapshot = recheckedSnapshot;
            }
            if (!latestSnapshot || isLiveSipCallEnded(latestSnapshot)) {
              writeBadRequest(response, "live_sip_call_not_started");
              return;
            }
            if (isOpenAiLiveSipAutomationStopped(latestSnapshot)) {
              await rejectHeldLiveSipCallerTurn(
                response,
                ingress,
                callId,
                text,
                timestamp,
                getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
                "/api/live-sip/events",
                "openai_fail_closed_handoff_active",
                { eventType, sipCallId },
                voiceSessionScope,
              );
              return;
            }
            const latestOperatorHoldReason = getLiveSipCallerTurnHoldReason(latestSnapshot, conversationMode);
            if (latestOperatorHoldReason) {
              await rejectHeldLiveSipCallerTurn(
                response,
                ingress,
                callId,
                text,
                timestamp,
                getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
                "/api/live-sip/events",
                latestOperatorHoldReason,
                { eventType, sipCallId },
                voiceSessionScope,
              );
              return;
            }
            await ingress.appendCallerTurn(callId, { speaker: "caller", text, timestamp }, config, {
              ...voiceSessionScope,
              conversationMode,
              openAiLlm,
            });
            const snapshot = await ingress.recordLiveTelephonyEvidence(callId, {
              eventType: "rtc_asr_transcript",
              timestamp,
              detail: {
                provider: "rtc-asr",
                transcriptText: text,
                evidencePath: getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
                ...voiceSessionScope,
              },
            });
            writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, call: buildCallPayload(snapshot) });
          });
          return;
        }
        await ingress.appendCallerTurn(callId, { speaker: "caller", text, timestamp }, config, {
          ...voiceSessionScope,
          conversationMode,
        });
        const snapshot = await ingress.recordLiveTelephonyEvidence(callId, {
          eventType: "rtc_asr_transcript",
          timestamp,
          detail: {
            provider: "rtc-asr",
            transcriptText: text,
            evidencePath: getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
            ...voiceSessionScope,
          },
        });
        writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, call: buildCallPayload(snapshot) });
        return;
      }

      if (eventType === "media.capture") {
        const rtpPacketCount = parseOptionalNonNegativeInteger(body.rtpPacketCount, "live_sip_rtp_packet_count_invalid");
        if (rtpPacketCount !== null && typeof rtpPacketCount === "object") {
          writeBadRequest(response, rtpPacketCount.error);
          return;
        }

        const snapshot = await ingress.recordLiveTelephonyEvidence(callId, {
          eventType: "media_capture_attached",
          timestamp,
          detail: {
            audioWavPath: getOptionalTrimmedString(body.audioWavPath) ?? null,
            sipLogPath: getOptionalTrimmedString(body.sipLogPath) ?? null,
            rtpPacketCount,
            generatedMedia: body.generatedMedia === true,
            ...voiceSessionScope,
          },
        });
        writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, call: buildCallPayload(snapshot) });
        return;
      }

      if (eventType === "media.playback") {
        const packetCount = parseOptionalNonNegativeInteger(body.packetCount, "live_sip_playback_packet_count_invalid");
        if (packetCount !== null && typeof packetCount === "object") {
          writeBadRequest(response, packetCount.error);
          return;
        }
        const sentPacketCount = parseOptionalNonNegativeInteger(body.sentPacketCount, "live_sip_playback_sent_packet_count_invalid");
        if (sentPacketCount !== null && typeof sentPacketCount === "object") {
          writeBadRequest(response, sentPacketCount.error);
          return;
        }
        const remotePort = parseOptionalNonNegativeInteger(body.remotePort, "live_sip_playback_remote_port_invalid");
        if (remotePort !== null && typeof remotePort === "object") {
          writeBadRequest(response, remotePort.error);
          return;
        }
        if (remotePort !== null && (remotePort <= 0 || remotePort > 65535)) {
          writeBadRequest(response, "live_sip_playback_remote_port_invalid");
          return;
        }
        const totalDurationMs = parseOptionalNonNegativeNumber(body.totalDurationMs, "live_sip_playback_total_duration_ms_invalid");
        if (totalDurationMs !== null && typeof totalDurationMs === "object") {
          writeBadRequest(response, totalDurationMs.error);
          return;
        }
        const ssrc = parseOptionalNonNegativeInteger(body.ssrc, "live_sip_playback_ssrc_invalid");
        if (ssrc !== null && typeof ssrc === "object") {
          writeBadRequest(response, ssrc.error);
          return;
        }
        if (packetCount !== null && sentPacketCount !== null && sentPacketCount > packetCount) {
          writeBadRequest(response, "live_sip_playback_sent_packet_count_exceeds_packet_count");
          return;
        }
        const remoteHost = getOptionalTrimmedString(body.remoteHost);
        if (body.rtpSocketSendReady === true && (!sentPacketCount || remotePort === null || !remoteHost)) {
          writeBadRequest(response, "live_sip_playback_socket_send_evidence_incomplete");
          return;
        }
        const freeswitchBroadcastBody = isRecord(body.freeswitchBroadcast) ? body.freeswitchBroadcast : null;
        const freeswitchBroadcastMode = getOptionalTrimmedString(body.freeswitchBroadcastMode) ?? getOptionalTrimmedString(freeswitchBroadcastBody?.mode);
        const freeswitchBroadcastSampleRateHz = parseOptionalNonNegativeInteger(
          body.freeswitchBroadcastSampleRateHz ?? freeswitchBroadcastBody?.sampleRateHz,
          "live_sip_playback_broadcast_sample_rate_invalid",
        );
        if (freeswitchBroadcastSampleRateHz !== null && typeof freeswitchBroadcastSampleRateHz === "object") {
          writeBadRequest(response, freeswitchBroadcastSampleRateHz.error);
          return;
        }
        const freeswitchBroadcastAudioBytes = parseOptionalNonNegativeInteger(
          body.freeswitchBroadcastAudioBytes ?? freeswitchBroadcastBody?.audioBytes,
          "live_sip_playback_broadcast_audio_bytes_invalid",
        );
        if (freeswitchBroadcastAudioBytes !== null && typeof freeswitchBroadcastAudioBytes === "object") {
          writeBadRequest(response, freeswitchBroadcastAudioBytes.error);
          return;
        }
        const hasFreeswitchBroadcast = freeswitchBroadcastMode === "freeswitch_uuid_broadcast";
        const freeswitchBroadcastHostPath = getOptionalTrimmedString(body.freeswitchBroadcastHostPath) ?? getOptionalTrimmedString(freeswitchBroadcastBody?.hostPath);
        const freeswitchBroadcastPath = getOptionalTrimmedString(body.freeswitchBroadcastPath) ?? getOptionalTrimmedString(freeswitchBroadcastBody?.freeswitchPath);
        if (body.callerPlaybackConfirmed === true && body.rtpSocketSendReady !== true && !hasFreeswitchBroadcast) {
          writeBadRequest(response, "live_sip_playback_confirmation_without_socket_send");
          return;
        }
        if (hasFreeswitchBroadcast && (!freeswitchBroadcastHostPath || !freeswitchBroadcastPath || !freeswitchBroadcastAudioBytes)) {
          writeBadRequest(response, "live_sip_playback_broadcast_evidence_incomplete");
          return;
        }
        if (body.callerPlaybackConfirmed === true && hasFreeswitchBroadcast && (body.outboundRtpReady !== true || !packetCount)) {
          writeBadRequest(response, "live_sip_playback_broadcast_packetization_evidence_incomplete");
          return;
        }
        if (body.callerPlaybackConfirmed === true && !getOptionalTrimmedString(body.callerPlaybackEvidencePath)) {
          writeBadRequest(response, "live_sip_playback_confirmation_evidence_required");
          return;
        }

        const snapshot = await ingress.recordLiveTelephonyEvidence(callId, {
          eventType: "pipecat_rtp_playback_attached",
          timestamp,
          detail: {
            outboundRtpReady: body.outboundRtpReady === true,
            rtpSocketSendReady: body.rtpSocketSendReady === true,
            packetCount,
            sentPacketCount,
            totalDurationMs,
            ssrc,
            remoteHost: remoteHost ?? null,
            remotePort,
            lastSentAt: getOptionalTrimmedString(body.lastSentAt) ?? null,
            evidencePath: getOptionalTrimmedString(body.evidencePath) ?? null,
            callerPlaybackConfirmed: body.callerPlaybackConfirmed === true,
            callerPlaybackEvidencePath: getOptionalTrimmedString(body.callerPlaybackEvidencePath) ?? null,
            freeswitchBroadcastMode: hasFreeswitchBroadcast ? "freeswitch_uuid_broadcast" : null,
            freeswitchBroadcastHostPath: freeswitchBroadcastHostPath ?? null,
            freeswitchBroadcastPath: freeswitchBroadcastPath ?? null,
            freeswitchBroadcastSampleRateHz,
            freeswitchBroadcastAudioBytes,
            ...voiceSessionScope,
          },
        });
        writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, call: buildCallPayload(snapshot) });
        return;
      }

      if (eventType === "rtc_asr.blocked") {
        const snapshot = await ingress.recordLiveTelephonyEvidence(callId, {
          eventType: "rtc_asr_blocked",
          timestamp,
          detail: {
            blocker: getOptionalTrimmedString(body.blocker) ?? "rtc_asr_unavailable",
            nextAction: getOptionalTrimmedString(body.nextAction) ?? "Start rtc-asr and set RTC_ASR_WS_URL before rerunning live SIP proof.",
            evidencePath: getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
            ...voiceSessionScope,
          },
        });
        writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, call: buildCallPayload(snapshot) });
        return;
      }

      if (eventType === "call.error") {
        const reason = getOptionalTrimmedString(body.reason) ?? "live_sip_bridge_error";
        const snapshot = await ingress.triggerFallback(callId, "tool_timeout", timestamp, reason);
        writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, call: buildCallPayload(snapshot) });
        return;
      }

      const durationSeconds = parseOptionalNonNegativeInteger(body.durationSeconds, "live_sip_duration_seconds_invalid");
      if (durationSeconds !== null && typeof durationSeconds === "object") {
        writeBadRequest(response, durationSeconds.error);
        return;
      }

      const snapshot = await ingress.recordLiveTelephonyEvidence(callId, {
        eventType: "sip_call_ended",
        timestamp,
        detail: {
          hangupCause: getOptionalTrimmedString(body.hangupCause) ?? null,
          durationSeconds,
        },
      });
      purgeCallerTurnDeliveryAckPreviewsForCall(callerTurnDeliveryAckPreviews, snapshot.session.callId);
      const endedAliases = uniqueLiveSipCallIds(
        ...liveSipCallAliasesForCall(liveSipCallMap, snapshot.session.callId),
        ...liveSipCorrelationIds,
      );
      deleteLiveSipCallAliasesForCall(liveSipCallMap, snapshot.session.callId);
      setLiveSipEndedCallAliases(liveSipEndedCallMap, endedAliases, snapshot.session.callId);
      writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, linkedSipCallId, vertoCallId, correlationIds: liveSipCorrelationIds, call: buildCallPayload(snapshot) });
    } catch {
      writeNotFound(response);
    }
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/demo/run-end-to-end") {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const openclawSessionId = body.openclawSessionId;
    if (openclawSessionId !== undefined && (typeof openclawSessionId !== "string" || !openclawSessionId.trim())) {
      writeBadRequest(response, "openclaw_session_id_invalid");
      return;
    }

    const openclawSessionLabel = body.openclawSessionLabel;
    if (
      openclawSessionLabel !== undefined &&
      (typeof openclawSessionLabel !== "string" || !openclawSessionLabel.trim())
    ) {
      writeBadRequest(response, "openclaw_session_label_invalid");
      return;
    }

    const { latest, steps } = await runEndToEndDemoFlow(ingress, config, {
      openclawSessionId: openclawSessionId?.trim(),
      openclawSessionLabel: openclawSessionLabel?.trim() ?? "operator-console/end-to-end",
    } satisfies StartCallOptions);

    writeJson(response, 201, {
      ok: true,
      route: "/api/demo/run-end-to-end",
      outcome: latest.flowState === "wrap" && latest.pipecatFlow.script.completed ? "scripted_wrap_complete" : "incomplete",
      steps,
      call: buildCallPayload(latest),
      operatorConsoleCall: buildOperatorConsoleCallPayload(latest),
      proof: buildCallProofBundlePayload(latest),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/signalwire/events") {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    if (!isSignalWireEventType(body.eventType)) {
      writeBadRequest(response, "signalwire_event_type_invalid");
      return;
    }

    const timestamp = normalizeTimestamp(body.timestamp, "signalwire_timestamp_invalid");
    if (typeof timestamp !== "string") {
      writeBadRequest(response, timestamp.error);
      return;
    }

    const signalWireCallId = getOptionalTrimmedString(body.signalWireCallId) ?? getOptionalTrimmedString(body.callSid) ?? null;

    if (body.eventType === "call.started") {
      const signalWireLive = body.telephonyMode === "signalwire_live" || body.credentialsMode === "signalwire_live";
      const snapshot = await ingress.startCall(config, {
        providerCallId: signalWireCallId ?? undefined,
        openclawSessionId: getOptionalTrimmedString(body.openclawSessionId) ?? (signalWireCallId ? `signalwire-${signalWireCallId}` : undefined),
        openclawSessionLabel: getOptionalTrimmedString(body.openclawSessionLabel) ?? (signalWireCallId ? `signalwire/${signalWireCallId}` : undefined),
        source: "signalwire_webhook",
        runtimeModeLabels: signalWireLive
          ? { telephony: "signalwire_live", media: "live_capture", rtcAsr: "rtc_asr_blocked", credentialsMode: "signalwire_live" }
          : undefined,
      });

      if (signalWireCallId) {
        signalWireCallMap.set(signalWireCallId, snapshot.session.callId);
      }

      writeJson(response, 201, buildSignalWireResponse(body.eventType, signalWireCallId, snapshot));
      return;
    }

    const callId = resolveSignalWireCallId(body, signalWireCallMap);
    if (typeof callId !== "string") {
      writeBadRequest(response, callId.error);
      return;
    }

    try {
      if (body.eventType === "media.transcript") {
        const text = getOptionalTrimmedString(body.text) ?? getOptionalTrimmedString(body.transcript);
        if (!text) {
          writeBadRequest(response, "signalwire_transcript_text_required");
          return;
        }

        const snapshot = await ingress.appendCallerTurn(callId, { speaker: "caller", text, timestamp }, config);
        writeJson(response, 200, buildSignalWireResponse(body.eventType, signalWireCallId, snapshot));
        return;
      }

      if (body.eventType === "call.error") {
        const reason = getOptionalTrimmedString(body.reason) ?? "signalwire_bridge_error";
        const snapshot = await ingress.triggerFallback(callId, "tool_timeout", timestamp, reason);
        writeJson(response, 200, buildSignalWireResponse(body.eventType, signalWireCallId, snapshot));
        return;
      }

      const snapshot = await ingress.applyOperatorSteer(callId, "end_call", timestamp, "signalwire_call_ended");
      purgeCallerTurnDeliveryAckPreviewsForCall(callerTurnDeliveryAckPreviews, snapshot.session.callId);
      if (signalWireCallId) {
        signalWireCallMap.delete(signalWireCallId);
      }
      writeJson(response, 200, buildSignalWireResponse(body.eventType, signalWireCallId, snapshot));
    } catch {
      writeNotFound(response);
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/operator/console/action") {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const callId = await resolveOperatorConsoleCallId(body, ingress);
    if (typeof callId !== "string") {
      writeBadRequest(response, callId.error);
      return;
    }

    const parsedSteer = parseOperatorSteerBody(body, {
      actionRequired: "operator_console_action_required",
      commandInvalid: "operator_console_command_invalid",
      commandConflict: "operator_console_command_conflict",
      reasonInvalid: "operator_console_reason_invalid",
      fallbackReasonRequired: "operator_console_fallback_reason_required",
      timestampInvalid: "operator_console_timestamp_invalid",
    });

    if ("error" in parsedSteer) {
      writeBadRequest(response, parsedSteer.error);
      return;
    }

    if (operatorActionRequiresConfirmation(parsedSteer.action) && body.confirmationAcknowledged !== true) {
      writeJson(response, 400, {
        ok: false,
        error: "operator_console_confirmation_required",
        action: parsedSteer.action,
        confirmationRequired: true,
        confirmationMessage: getOperatorActionConfirmationMessage(parsedSteer.action),
        confirmationAcknowledgementField: "confirmationAcknowledged",
      });
      return;
    }

    try {
      const confirmationRequired = operatorActionRequiresConfirmation(parsedSteer.action);
      const snapshot = await ingress.applyOperatorSteer(
        callId,
        parsedSteer.action,
        parsedSteer.timestamp,
        parsedSteer.reason,
        {
          sourceRoute: "/api/operator/console/action",
          confirmationAcknowledged: confirmationRequired ? body.confirmationAcknowledged === true : null,
        },
      );
      writeJson(response, 200, {
        ok: true,
        route: "/api/operator/console/action",
        appliedAction: parsedSteer.action,
        call: buildCallPayload(snapshot),
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Call is not awaiting operator steer")) {
        writeBadRequest(response, "operator_console_action_not_pending");
        return;
      }
      writeNotFound(response);
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/operator/console/scripted-turn") {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const callId = await resolveOperatorConsoleCallId(body, ingress);
    if (typeof callId !== "string") {
      writeBadRequest(response, callId.error.replace("operator_console_action", "operator_console_scripted_turn"));
      return;
    }

    const snapshots = await ingress.listSnapshots({ callId });
    const snapshot = snapshots[0];
    if (!snapshot) {
      writeBadRequest(response, "operator_console_scripted_turn_call_ref_not_found");
      return;
    }

    if (hasActiveTerminalOperatorStop(snapshot)) {
      writeJson(response, 409, { ok: false, error: "operator_console_scripted_turn_terminal" });
      return;
    }

    const expectedTurnIndex = parseOptionalNonNegativeInteger(
      body.expectedTurnIndex,
      "operator_console_scripted_turn_index_invalid",
    );
    if (expectedTurnIndex !== null && typeof expectedTurnIndex === "object") {
      writeBadRequest(response, expectedTurnIndex.error);
      return;
    }

    const matchedTurns = snapshot.pipecatFlow.script.matchedCallerTurns;
    if (expectedTurnIndex !== null && expectedTurnIndex !== matchedTurns) {
      writeJson(response, 409, {
        ok: false,
        error: "operator_console_scripted_turn_index_mismatch",
        expectedTurnIndex,
        nextTurnIndex: matchedTurns,
      });
      return;
    }

    const text = snapshot.pipecatFlow.script.expectedCallerTurns[matchedTurns];
    if (!text) {
      writeBadRequest(response, "operator_console_scripted_turn_complete");
      return;
    }

    const timestamp = normalizeTimestamp(body.timestamp, "operator_console_scripted_turn_timestamp_invalid");
    if (typeof timestamp !== "string") {
      writeBadRequest(response, timestamp.error);
      return;
    }

    try {
      const updatedSnapshot = await ingress.appendCallerTurn(callId, { speaker: "caller", text, timestamp }, config);
      const totalTurns = updatedSnapshot.pipecatFlow.script.expectedCallerTurns.length;
      const nextTurnIndex = updatedSnapshot.pipecatFlow.script.completed
        ? null
        : updatedSnapshot.pipecatFlow.script.matchedCallerTurns;
      const nextTurnText = nextTurnIndex === null
        ? null
        : updatedSnapshot.pipecatFlow.script.expectedCallerTurns[nextTurnIndex] ?? null;
      const remainingTurns = nextTurnIndex === null ? 0 : Math.max(totalTurns - nextTurnIndex, 0);
      const progressPct = totalTurns === 0
        ? 100
        : Math.round((updatedSnapshot.pipecatFlow.script.matchedCallerTurns / totalTurns) * 100);
      writeJson(response, 200, {
        ok: true,
        route: "/api/operator/console/scripted-turn",
        submittedTurnIndex: matchedTurns,
        submittedTurnOrdinal: matchedTurns + 1,
        submittedText: text,
        nextTurnIndex,
        nextTurnText,
        remainingTurns,
        progressPct,
        scriptCompleted: updatedSnapshot.pipecatFlow.script.completed,
        call: buildOperatorConsoleCallPayload(updatedSnapshot),
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Retention review approval is required")) {
        writeJson(response, 409, { ok: false, error: "retention_review_approval_required" });
        return;
      }
      if (error instanceof Error && error.message.startsWith("Caller turn is not allowed after a terminal operator stop")) {
        writeJson(response, 409, { ok: false, error: "operator_console_scripted_turn_terminal" });
        return;
      }
      writeNotFound(response);
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/operator/console") {
    const filters = parseCallListFilters(requestUrl, "operator_console");
    if ("error" in filters) {
      writeBadRequest(response, filters.error);
      return;
    }

    const limit = parseOptionalPositiveIntegerFilter(requestUrl.searchParams.get("limit"), "operator_console_limit_invalid");
    if (limit !== undefined && typeof limit !== "number") {
      writeBadRequest(response, limit.error);
      return;
    }

    if (limit !== undefined && limit > maxCallListPageLimit) {
      writeBadRequest(response, "operator_console_limit_invalid");
      return;
    }

    const offset = parseOptionalNonNegativeIntegerFilter(requestUrl.searchParams.get("offset"), "operator_console_offset_invalid");
    if (offset !== undefined && typeof offset !== "number") {
      writeBadRequest(response, offset.error);
      return;
    }

    const sortParam = requestUrl.searchParams.get("sort");
    const sort = sortParam === null ? "attentionStartedAt" : parseCallListSort(sortParam);
    if (typeof sort !== "string") {
      writeBadRequest(response, sort.error);
      return;
    }

    const order = parseCallListOrder(requestUrl.searchParams.get("order"));
    if (typeof order !== "string") {
      writeBadRequest(response, order.error);
      return;
    }

    const orderedSnapshots = await ingress.listSnapshots(filters);
    if (sort === "attentionStartedAt") {
      orderedSnapshots.sort(compareAttentionQueueOrder);
    }

    if (order === "desc") {
      orderedSnapshots.reverse();
    }

    const pageOffset = offset ?? 0;
    const pageLimit = limit ?? 25;
    const calls = orderedSnapshots
      .slice(pageOffset, pageOffset + pageLimit)
      .map((snapshot) => buildOperatorConsoleCallPayload(snapshot));
    const summary = await ingress.getQueueSummary();
    const filteredSummary = await ingress.getQueueSummary(filters);

    writeJson(response, 200, {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      refreshIntervalMs: operatorConsoleRefreshIntervalMs,
      runtimeHealth: {
        ok: true,
        mode: config.mode,
        provider: config.provider.name,
        pipecatFlow: getPipecatPrototypeHealth(),
      },
      controls: buildOperatorActionsPayload(),
      queue: { summary },
      calls: {
        items: calls,
        summary: {
          ...summary,
          filteredCalls: orderedSnapshots.length,
          returnedCalls: calls.length,
          sort,
          order,
          page: {
            offset: pageOffset,
            limit: pageLimit,
            totalFilteredCalls: orderedSnapshots.length,
            hasMore: pageOffset + calls.length < orderedSnapshots.length,
            nextOffset: pageOffset + calls.length < orderedSnapshots.length ? pageOffset + calls.length : null,
          },
          filteredSummary,
        },
      },
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/queue") {
    const filters = parseCallListFilters(requestUrl, "queue");
    if ("error" in filters) {
      writeBadRequest(response, filters.error);
      return;
    }

    const summary = await ingress.getQueueSummary(filters);

    writeJson(response, 200, {
      summary,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/demo/start") {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const openclawSessionId = body.openclawSessionId;
    if (openclawSessionId !== undefined && (typeof openclawSessionId !== "string" || !openclawSessionId.trim())) {
      writeBadRequest(response, "openclaw_session_id_invalid");
      return;
    }

    const openclawSessionLabel = body.openclawSessionLabel;
    if (
      openclawSessionLabel !== undefined &&
      (typeof openclawSessionLabel !== "string" || !openclawSessionLabel.trim())
    ) {
      writeBadRequest(response, "openclaw_session_label_invalid");
      return;
    }

    const simulateOpenClawAttachFailure = body.simulateOpenClawAttachFailure;
    if (simulateOpenClawAttachFailure !== undefined && typeof simulateOpenClawAttachFailure !== "boolean") {
      writeBadRequest(response, "openclaw_attach_failure_flag_invalid");
      return;
    }

    const snapshot = await ingress.startCall(config, {
      openclawSessionId: openclawSessionId?.trim(),
      openclawSessionLabel: openclawSessionLabel?.trim(),
      simulateOpenClawAttachFailure,
    } satisfies StartCallOptions);
    writeJson(response, 201, buildCallPayload(snapshot));
    return;
  }

  const callerTurnMatch = request.method === "POST" ? pathname.match(/^\/api\/calls\/([^/]+)\/caller-turn$/) : null;
  if (callerTurnMatch) {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const text = getOptionalTrimmedString(body.text);

    if (!text) {
      writeBadRequest(response, "caller_turn_text_required");
      return;
    }

    const conversationMode = body.conversationMode;
    if (conversationMode !== undefined && !isConversationMode(conversationMode)) {
      writeBadRequest(response, "caller_turn_conversation_mode_invalid");
      return;
    }

    const commitMode = body.commitMode;
    if (commitMode !== undefined && commitMode !== "immediate" && commitMode !== "delivery_ack") {
      writeBadRequest(response, "caller_turn_commit_mode_invalid");
      return;
    }

    const timestamp = normalizeTimestamp(body.timestamp, "caller_turn_timestamp_invalid");
    if (typeof timestamp !== "string") {
      writeBadRequest(response, timestamp.error);
      return;
    }

    const turn: TranscriptTurn = {
      speaker: "caller",
      text,
      timestamp,
    };

    let deliveryAckPreviewReservationKey: string | undefined;
    try {
      let currentSnapshot = await ingress.getSnapshot(callerTurnMatch[1]);
      if (!currentSnapshot) {
        writeNotFound(response);
        return;
      }
      if (rejectTerminalOperatorStopCallerTurn(response, currentSnapshot, "/api/calls/:callId/caller-turn")) return;
      if (isLiveSipCallEnded(currentSnapshot)) {
        writeJson(response, 409, {
          ok: false,
          route: "/api/calls/:callId/caller-turn",
          error: "live_sip_call_ended",
          call: buildCallPayload(currentSnapshot),
        });
        return;
      }
      const effectiveConversationMode = shouldForceScriptedRetentionFinalTurn(currentSnapshot, config)
        ? "scripted"
        : conversationMode ?? currentSnapshot.scenario.conversationMode;
      if (isOpenAiLiveSipAutomationStopped(currentSnapshot)) {
        await rejectHeldLiveSipCallerTurn(
          response,
          ingress,
          callerTurnMatch[1],
          text,
          timestamp,
          getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
          "/api/calls/:callId/caller-turn",
          "openai_fail_closed_handoff_active",
        );
        return;
      }
      const currentOperatorHoldReason = getLiveSipCallerTurnHoldReason(currentSnapshot, effectiveConversationMode);
      if (currentOperatorHoldReason) {
        await rejectHeldLiveSipCallerTurn(
          response,
          ingress,
          callerTurnMatch[1],
          text,
          timestamp,
          getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
          "/api/calls/:callId/caller-turn",
          currentOperatorHoldReason,
        );
        return;
      }
      if (commitMode === "delivery_ack") {
        const snapshotVersion = buildDeliveryAckSnapshotVersion(currentSnapshot);
        deliveryAckPreviewReservationKey = buildCallerTurnDeliveryAckKey(callerTurnMatch[1], snapshotVersion);
        const pendingPreview = getCallerTurnDeliveryAckPreview(callerTurnDeliveryAckPreviews, callerTurnMatch[1], snapshotVersion);
        if (pendingPreview) {
          if (isCallerTurnDeliveryAckPreviewForTurn(pendingPreview, text, timestamp, effectiveConversationMode)) {
            writeCallerTurnDeliveryAckPreviewPending(response, callerTurnMatch[1], snapshotVersion, pendingPreview.createdAtMs);
            return;
          }
          if (callerTurnDeliveryAckPreviewReservations.has(deliveryAckPreviewReservationKey)) {
            writeCallerTurnDeliveryAckPreviewPending(response, callerTurnMatch[1], snapshotVersion, pendingPreview.createdAtMs);
            return;
          }
          deleteCallerTurnDeliveryAckPreview(callerTurnDeliveryAckPreviews, callerTurnMatch[1], snapshotVersion);
        }
        if (callerTurnDeliveryAckPreviewReservations.has(deliveryAckPreviewReservationKey)) {
          writeCallerTurnDeliveryAckPreviewPending(response, callerTurnMatch[1], snapshotVersion, Date.now());
          return;
        }
        callerTurnDeliveryAckPreviewReservations.add(deliveryAckPreviewReservationKey);
      }
      let deliveryAckOpenAiResponseHandled = false;
      const openAiLlm = commitMode === "delivery_ack" && effectiveConversationMode === "openai_llm"
        ? await withLiveSipOpenAiGenerationLock(liveSipOpenAiGenerationLocks, callerTurnMatch[1], async () => {
            const lockedSnapshot = await ingress.getSnapshot(callerTurnMatch[1]);
            if (!lockedSnapshot) {
              writeNotFound(response);
              deliveryAckOpenAiResponseHandled = true;
              return undefined;
            }
            if (rejectTerminalOperatorStopCallerTurn(response, lockedSnapshot, "/api/calls/:callId/caller-turn")) {
              deliveryAckOpenAiResponseHandled = true;
              return undefined;
            }
            if (isLiveSipCallEnded(lockedSnapshot)) {
              writeJson(response, 409, {
                ok: false,
                route: "/api/calls/:callId/caller-turn",
                error: "live_sip_call_ended",
                call: buildCallPayload(lockedSnapshot),
              });
              deliveryAckOpenAiResponseHandled = true;
              return undefined;
            }
            if (isOpenAiLiveSipAutomationStopped(lockedSnapshot)) {
              await rejectHeldLiveSipCallerTurn(
                response,
                ingress,
                callerTurnMatch[1],
                text,
                timestamp,
                getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
                "/api/calls/:callId/caller-turn",
                "openai_fail_closed_handoff_active",
              );
              deliveryAckOpenAiResponseHandled = true;
              return undefined;
            }
            const lockedOperatorHoldReason = getLiveSipCallerTurnHoldReason(lockedSnapshot, effectiveConversationMode);
            if (lockedOperatorHoldReason) {
              await rejectHeldLiveSipCallerTurn(
                response,
                ingress,
                callerTurnMatch[1],
                text,
                timestamp,
                getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
                "/api/calls/:callId/caller-turn",
                lockedOperatorHoldReason,
              );
              deliveryAckOpenAiResponseHandled = true;
              return undefined;
            }
            currentSnapshot = lockedSnapshot;
            return generateOpenAiLiveSipResponse(lockedSnapshot, text, timestamp);
          })
        : undefined;
      if (deliveryAckOpenAiResponseHandled) return;
      let latestSnapshot = openAiLlm ? await ingress.getSnapshot(callerTurnMatch[1]) : currentSnapshot;
      if (!latestSnapshot) {
        writeNotFound(response);
        return;
      }
      if (rejectTerminalOperatorStopCallerTurn(response, latestSnapshot, "/api/calls/:callId/caller-turn")) return;
      if (isLiveSipCallEnded(latestSnapshot)) {
        writeJson(response, 409, {
          ok: false,
          route: "/api/calls/:callId/caller-turn",
          error: "live_sip_call_ended",
          call: buildCallPayload(latestSnapshot),
        });
        return;
      }
      if (isOpenAiLiveSipAutomationStopped(latestSnapshot)) {
        await rejectHeldLiveSipCallerTurn(
          response,
          ingress,
          callerTurnMatch[1],
          text,
          timestamp,
          getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
          "/api/calls/:callId/caller-turn",
          "openai_fail_closed_handoff_active",
        );
        return;
      }
      const latestOperatorHoldReason = getLiveSipCallerTurnHoldReason(latestSnapshot, effectiveConversationMode);
      if (latestOperatorHoldReason) {
        await rejectHeldLiveSipCallerTurn(
          response,
          ingress,
          callerTurnMatch[1],
          text,
          timestamp,
          getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
          "/api/calls/:callId/caller-turn",
          latestOperatorHoldReason,
        );
        return;
      }
      let openAiFailClosedAlreadyPersisted = false;
      if (commitMode === "delivery_ack" && openAiLlm && !openAiLlm.ok) {
        latestSnapshot = await ingress.recordOpenAiLlmFailClosedState(callerTurnMatch[1], turn, openAiLlm);
        openAiFailClosedAlreadyPersisted = true;
      }
      if (commitMode === "delivery_ack") {
        const snapshotVersion = buildDeliveryAckSnapshotVersion(latestSnapshot);
        const previewKey = buildCallerTurnDeliveryAckKey(callerTurnMatch[1], snapshotVersion);
        const pendingPreview = getCallerTurnDeliveryAckPreview(callerTurnDeliveryAckPreviews, callerTurnMatch[1], snapshotVersion);
        if (pendingPreview) {
          if (isCallerTurnDeliveryAckPreviewForTurn(pendingPreview, text, timestamp, effectiveConversationMode)) {
            writeCallerTurnDeliveryAckPreviewPending(response, callerTurnMatch[1], snapshotVersion, pendingPreview.createdAtMs);
            return;
          }
          if (callerTurnDeliveryAckPreviewReservations.has(previewKey)) {
            writeCallerTurnDeliveryAckPreviewPending(response, callerTurnMatch[1], snapshotVersion, pendingPreview.createdAtMs);
            return;
          }
          deleteCallerTurnDeliveryAckPreview(callerTurnDeliveryAckPreviews, callerTurnMatch[1], snapshotVersion);
        }
        if (callerTurnDeliveryAckPreviewReservations.has(previewKey) && previewKey !== deliveryAckPreviewReservationKey) {
          writeCallerTurnDeliveryAckPreviewPending(response, callerTurnMatch[1], snapshotVersion, Date.now());
          return;
        }
        if (previewKey !== deliveryAckPreviewReservationKey) callerTurnDeliveryAckPreviewReservations.add(previewKey);
        try {
          const snapshot = await ingress.previewCallerTurn(callerTurnMatch[1], turn, config, {
            conversationMode: effectiveConversationMode,
            openAiLlm,
            openAiFailClosedAlreadyPersisted,
          });
          const expectedAgentText = snapshot.transcript.at(-1)?.speaker === "agent" ? snapshot.transcript.at(-1)?.text : undefined;
          if (!expectedAgentText) {
            writeBadRequest(response, "caller_turn_preview_agent_text_missing");
            return;
          }
          const concurrentPendingPreview = getCallerTurnDeliveryAckPreview(callerTurnDeliveryAckPreviews, callerTurnMatch[1], snapshotVersion);
          if (concurrentPendingPreview) {
            writeCallerTurnDeliveryAckPreviewPending(response, callerTurnMatch[1], snapshotVersion, concurrentPendingPreview.createdAtMs);
            return;
          }
          callerTurnDeliveryAckPreviews.set(previewKey, {
            callId: callerTurnMatch[1],
            snapshotVersion,
            callerTranscript: text,
            timestamp,
            createdAtMs: Date.now(),
            conversationMode: effectiveConversationMode,
            expectedAgentText,
            openAiLlm,
            openAiFailClosedAlreadyPersisted,
          });
          writeJson(response, 200, {
            ...buildCallPayload(snapshot),
            callerTurnCommit: {
              mode: "delivery_ack",
              status: "pending",
              callId: callerTurnMatch[1],
              callerTranscript: text,
              expectedAgentText,
              snapshotVersion,
              timestamp,
              conversationMode: effectiveConversationMode,
              openAiResponseId: openAiLlm?.ok ? openAiLlm.responseId : null,
            },
          });
          return;
        } finally {
          if (previewKey !== deliveryAckPreviewReservationKey) callerTurnDeliveryAckPreviewReservations.delete(previewKey);
        }
      }
      if (effectiveConversationMode === "openai_llm") {
        await withLiveSipOpenAiGenerationLock(liveSipOpenAiGenerationLocks, callerTurnMatch[1], async () => {
          const lockedSnapshot = await ingress.getSnapshot(callerTurnMatch[1]);
          if (!lockedSnapshot) {
            writeNotFound(response);
            return;
          }
          if (rejectTerminalOperatorStopCallerTurn(response, lockedSnapshot, "/api/calls/:callId/caller-turn")) return;
          if (isLiveSipCallEnded(lockedSnapshot)) {
            writeJson(response, 409, {
              ok: false,
              route: "/api/calls/:callId/caller-turn",
              error: "live_sip_call_ended",
              call: buildCallPayload(lockedSnapshot),
            });
            return;
          }
          if (isOpenAiLiveSipAutomationStopped(lockedSnapshot)) {
            await rejectHeldLiveSipCallerTurn(
              response,
              ingress,
              callerTurnMatch[1],
              text,
              timestamp,
              getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
              "/api/calls/:callId/caller-turn",
              "openai_fail_closed_handoff_active",
            );
            return;
          }
          const lockedOperatorHoldReason = getLiveSipCallerTurnHoldReason(lockedSnapshot, effectiveConversationMode);
          if (lockedOperatorHoldReason) {
            await rejectHeldLiveSipCallerTurn(
              response,
              ingress,
              callerTurnMatch[1],
              text,
              timestamp,
              getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
              "/api/calls/:callId/caller-turn",
              lockedOperatorHoldReason,
            );
            return;
          }
          const openAiLlm = await generateOpenAiLiveSipResponse(lockedSnapshot, text, timestamp);
          let latestSnapshot = openAiLlm ? await ingress.getSnapshot(callerTurnMatch[1]) : lockedSnapshot;
          if (!latestSnapshot) {
            writeNotFound(response);
            return;
          }
          if (rejectTerminalOperatorStopCallerTurn(response, latestSnapshot, "/api/calls/:callId/caller-turn")) return;
          if (openAiLlm?.ok && latestSnapshot.events.length === lockedSnapshot.events.length) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            const recheckedSnapshot = await ingress.getSnapshot(callerTurnMatch[1]);
            if (recheckedSnapshot) latestSnapshot = recheckedSnapshot;
          }
          if (isLiveSipCallEnded(latestSnapshot)) {
            writeJson(response, 409, {
              ok: false,
              route: "/api/calls/:callId/caller-turn",
              error: "live_sip_call_ended",
              call: buildCallPayload(latestSnapshot),
            });
            return;
          }
          if (isOpenAiLiveSipAutomationStopped(latestSnapshot)) {
            await rejectHeldLiveSipCallerTurn(
              response,
              ingress,
              callerTurnMatch[1],
              text,
              timestamp,
              getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
              "/api/calls/:callId/caller-turn",
              "openai_fail_closed_handoff_active",
            );
            return;
          }
          const latestOperatorHoldReason = getLiveSipCallerTurnHoldReason(latestSnapshot, effectiveConversationMode);
          if (latestOperatorHoldReason) {
            await rejectHeldLiveSipCallerTurn(
              response,
              ingress,
              callerTurnMatch[1],
              text,
              timestamp,
              getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
              "/api/calls/:callId/caller-turn",
              latestOperatorHoldReason,
            );
            return;
          }
          const snapshot = await ingress.appendCallerTurn(callerTurnMatch[1], turn, config, {
            conversationMode: effectiveConversationMode,
            openAiLlm,
          });
          writeJson(response, 200, buildCallPayload(snapshot));
        });
        return;
      }
      const snapshot = await ingress.appendCallerTurn(callerTurnMatch[1], turn, config, {
        conversationMode: effectiveConversationMode,
        openAiLlm,
      });
      writeJson(response, 200, buildCallPayload(snapshot));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Retention review approval is required")) {
        writeJson(response, 409, { ok: false, error: "retention_review_approval_required" });
        return;
      }
      if (error instanceof Error && error.message.startsWith("Caller turn is not allowed after a terminal operator stop")) {
        writeJson(response, 409, { ok: false, error: "caller_turn_terminal_operator_stop" });
        return;
      }
      writeNotFound(response);
    } finally {
      if (deliveryAckPreviewReservationKey) {
        callerTurnDeliveryAckPreviewReservations.delete(deliveryAckPreviewReservationKey);
      }
    }
    return;
  }

  const callerTurnCommitMatch = request.method === "POST" ? pathname.match(/^\/api\/calls\/([^/]+)\/caller-turn\/commit$/) : null;
  if (callerTurnCommitMatch) {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const text = getOptionalTrimmedString(body.text);

    if (!text) {
      writeBadRequest(response, "caller_turn_text_required");
      return;
    }

    const conversationMode = body.conversationMode;
    if (conversationMode !== undefined && !isConversationMode(conversationMode)) {
      writeBadRequest(response, "caller_turn_conversation_mode_invalid");
      return;
    }

    const expectedAgentText = getOptionalTrimmedString(body.expectedAgentText);
    if (!expectedAgentText) {
      writeBadRequest(response, "caller_turn_commit_expected_agent_text_required");
      return;
    }

    const expectedSnapshotVersion = getOptionalTrimmedString(body.expectedSnapshotVersion);
    if (!expectedSnapshotVersion) {
      writeBadRequest(response, "caller_turn_commit_snapshot_version_required");
      return;
    }

    const timestamp = normalizeTimestamp(body.timestamp, "caller_turn_timestamp_invalid");
    if (typeof timestamp !== "string") {
      writeBadRequest(response, timestamp.error);
      return;
    }

    const turn: TranscriptTurn = {
      speaker: "caller",
      text,
      timestamp,
    };

    try {
      const currentSnapshot = await ingress.getSnapshot(callerTurnCommitMatch[1]);
      if (!currentSnapshot) {
        writeNotFound(response);
        return;
      }
      if (isLiveSipCallEnded(currentSnapshot)) {
        purgeCallerTurnDeliveryAckPreviewsForCall(callerTurnDeliveryAckPreviews, callerTurnCommitMatch[1]);
        writeJson(response, 409, {
          ok: false,
          route: "/api/calls/:callId/caller-turn/commit",
          error: "live_sip_call_ended",
          call: buildCallPayload(currentSnapshot),
        });
        return;
      }
      if (buildDeliveryAckSnapshotVersion(currentSnapshot) !== expectedSnapshotVersion) {
        writeBadRequest(response, "caller_turn_commit_stale");
        return;
      }
      const effectiveConversationMode = shouldForceScriptedRetentionFinalTurn(currentSnapshot, config)
        ? "scripted"
        : conversationMode ?? currentSnapshot.scenario.conversationMode;
      const previewKey = buildCallerTurnDeliveryAckKey(callerTurnCommitMatch[1], expectedSnapshotVersion);
      const pendingPreview = callerTurnDeliveryAckPreviews.get(previewKey);
      if (pendingPreview && Date.now() - pendingPreview.createdAtMs >= callerTurnDeliveryAckPreviewTtlMs) {
        callerTurnDeliveryAckPreviews.delete(previewKey);
        writeBadRequest(response, "caller_turn_commit_stale");
        return;
      }
      if (
        !pendingPreview
        || pendingPreview.callerTranscript !== text
        || pendingPreview.timestamp !== timestamp
        || pendingPreview.conversationMode !== effectiveConversationMode
        || pendingPreview.expectedAgentText !== expectedAgentText
      ) {
        writeBadRequest(response, "caller_turn_commit_stale");
        return;
      }
      if (callerTurnDeliveryAckPreviewReservations.has(previewKey)) {
        writeCallerTurnDeliveryAckPreviewPending(
          response,
          callerTurnCommitMatch[1],
          expectedSnapshotVersion,
          pendingPreview.createdAtMs,
          "/api/calls/:callId/caller-turn/commit",
        );
        return;
      }
      callerTurnDeliveryAckPreviewReservations.add(previewKey);
      try {
        const openAiLlm = pendingPreview.openAiLlm;
        const openAiFailClosedAlreadyPersisted = pendingPreview.openAiFailClosedAlreadyPersisted;
        const preview = await ingress.previewCallerTurn(callerTurnCommitMatch[1], turn, config, {
          conversationMode: effectiveConversationMode,
          openAiLlm,
          openAiFailClosedAlreadyPersisted,
        });
        const previewAgentText = preview.transcript.at(-1)?.speaker === "agent" ? preview.transcript.at(-1)?.text : undefined;
        if (previewAgentText !== expectedAgentText) {
          writeBadRequest(response, "caller_turn_commit_stale");
          return;
        }
        const snapshot = await ingress.appendCallerTurn(callerTurnCommitMatch[1], turn, config, {
          conversationMode: effectiveConversationMode,
          openAiLlm,
          openAiFailClosedAlreadyPersisted,
        });
        callerTurnDeliveryAckPreviews.delete(previewKey);
        writeJson(response, 200, {
          ...buildCallPayload(snapshot),
          callerTurnCommit: {
            mode: "delivery_ack",
            status: "committed",
            callId: callerTurnCommitMatch[1],
            callerTranscript: text,
            expectedAgentText,
            expectedSnapshotVersion,
            timestamp,
            conversationMode: effectiveConversationMode,
          },
        });
      } finally {
        callerTurnDeliveryAckPreviewReservations.delete(previewKey);
      }
    } catch {
      writeNotFound(response);
    }
    return;
  }

  const fallbackMatch = request.method === "POST" ? pathname.match(/^\/api\/calls\/([^/]+)\/fallback$/) : null;
  if (fallbackMatch) {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const mode = body.mode;
    if (!mode) {
      writeBadRequest(response, "fallback_mode_required");
      return;
    }

    if (mode !== "tool_timeout" && mode !== "runtime_failure") {
      writeBadRequest(response, "fallback_mode_invalid");
      return;
    }

    if (hasInvalidOptionalString(body.reason)) {
      writeBadRequest(response, "fallback_reason_invalid");
      return;
    }

    const timestamp = normalizeTimestamp(body.timestamp, "fallback_timestamp_invalid");
    if (typeof timestamp !== "string") {
      writeBadRequest(response, timestamp.error);
      return;
    }

    try {
      const reason = getOptionalTrimmedString(body.reason);
      const snapshot = await ingress.triggerFallback(fallbackMatch[1], mode, timestamp, reason);
      writeJson(response, 200, buildCallPayload(snapshot));
    } catch {
      writeNotFound(response);
    }
    return;
  }

  const operatorNoteMatch = request.method === "POST" ? pathname.match(/^\/api\/calls\/([^/]+)\/operator-note$/) : null;
  if (operatorNoteMatch) {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const text = getOptionalTrimmedString(body.text);
    if (!text) {
      writeBadRequest(response, "operator_note_text_required");
      return;
    }

    if (hasInvalidOptionalString(body.disposition)) {
      writeBadRequest(response, "operator_note_disposition_invalid");
      return;
    }

    const timestamp = normalizeTimestamp(body.timestamp, "operator_note_timestamp_invalid");
    if (typeof timestamp !== "string") {
      writeBadRequest(response, timestamp.error);
      return;
    }

    try {
      const snapshot = await ingress.recordOperatorNote(operatorNoteMatch[1], text, timestamp, getOptionalTrimmedString(body.disposition));
      writeJson(response, 200, buildCallPayload(snapshot));
    } catch {
      writeNotFound(response);
    }
    return;
  }

  const operatorSteerMatch = request.method === "POST" ? pathname.match(/^\/api\/calls\/([^/]+)\/operator-steer$/) : null;
  if (operatorSteerMatch) {
    const body = await readJsonBody<unknown>(request);

    if (!isRecord(body)) {
      writeBadRequest(response, "json_object_required");
      return;
    }

    const parsedSteer = parseOperatorSteerBody(body, {
      actionRequired: "operator_steer_action_required",
      commandInvalid: "operator_steer_command_invalid",
      commandConflict: "operator_steer_command_conflict",
      reasonInvalid: "operator_steer_reason_invalid",
      fallbackReasonRequired: "operator_fallback_reason_required",
      timestampInvalid: "operator_steer_timestamp_invalid",
    });

    if ("error" in parsedSteer) {
      writeBadRequest(response, parsedSteer.error);
      return;
    }

    try {
      const snapshot = await ingress.applyOperatorSteer(
        operatorSteerMatch[1],
        parsedSteer.action,
        parsedSteer.timestamp,
        parsedSteer.reason,
      );
      if (parsedSteer.action === "end_call") {
        purgeCallerTurnDeliveryAckPreviewsForCall(callerTurnDeliveryAckPreviews, snapshot.session.callId);
      }
      writeJson(response, 200, buildCallPayload(snapshot));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Call is not awaiting operator steer")) {
        writeBadRequest(response, "operator_steer_not_pending");
        return;
      }
      writeNotFound(response);
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/calls") {
    const filters = parseCallListFilters(requestUrl, "call_list");
    if ("error" in filters) {
      writeBadRequest(response, filters.error);
      return;
    }

    const limit = parseOptionalPositiveIntegerFilter(requestUrl.searchParams.get("limit"), "call_list_limit_invalid");
    if (limit !== undefined && typeof limit !== "number") {
      writeBadRequest(response, limit.error);
      return;
    }

    if (limit !== undefined && limit > maxCallListPageLimit) {
      writeBadRequest(response, "call_list_limit_invalid");
      return;
    }

    const offset = parseOptionalNonNegativeIntegerFilter(requestUrl.searchParams.get("offset"), "call_list_offset_invalid");
    if (offset !== undefined && typeof offset !== "number") {
      writeBadRequest(response, offset.error);
      return;
    }

    const sort = parseCallListSort(requestUrl.searchParams.get("sort"));
    if (typeof sort !== "string") {
      writeBadRequest(response, sort.error);
      return;
    }

    const order = parseCallListOrder(requestUrl.searchParams.get("order"));
    if (typeof order !== "string") {
      writeBadRequest(response, order.error);
      return;
    }

    const orderedSnapshots = await ingress.listSnapshots(filters);
    if (sort === "attentionStartedAt") {
      orderedSnapshots.sort(compareAttentionQueueOrder);
    }

    if (order === "desc") {
      orderedSnapshots.reverse();
    }

    const calls = orderedSnapshots
      .slice(offset ?? 0, limit === undefined ? undefined : (offset ?? 0) + limit)
      .map((snapshot) => buildCallPayload(snapshot));
    const summary = await ingress.getQueueSummary();
    const filteredSummary = await ingress.getQueueSummary(filters);

    writeJson(response, 200, {
      calls,
      summary: {
        ...summary,
        filteredCalls: orderedSnapshots.length,
        returnedCalls: calls.length,
        sort,
        order,
        page: {
          offset: offset ?? 0,
          limit: limit ?? null,
          totalFilteredCalls: orderedSnapshots.length,
          hasMore: limit === undefined ? false : (offset ?? 0) + calls.length < orderedSnapshots.length,
          nextOffset: limit !== undefined && (offset ?? 0) + calls.length < orderedSnapshots.length ? (offset ?? 0) + calls.length : null,
        },
        filteredSummary,
      },
    });
    return;
  }

  const callTranscriptMatch = request.method === "GET" ? pathname.match(/^\/api\/calls\/([^/]+)\/transcript$/) : null;
  if (callTranscriptMatch) {
    const speakerParam = requestUrl.searchParams.get("speaker");
    if (speakerParam !== null && (!speakerParam.trim() || !isTranscriptSpeaker(speakerParam))) {
      writeBadRequest(response, "transcript_speaker_invalid");
      return;
    }

    const offset = parseOptionalNonNegativeIntegerFilter(requestUrl.searchParams.get("offset"), "transcript_offset_invalid");
    if (offset !== undefined && typeof offset !== "number") {
      writeBadRequest(response, offset.error);
      return;
    }

    const limit = parseOptionalPositiveIntegerFilter(requestUrl.searchParams.get("limit"), "transcript_limit_invalid");
    if (limit !== undefined && typeof limit !== "number") {
      writeBadRequest(response, limit.error);
      return;
    }

    if (limit !== undefined && limit > maxTranscriptPageLimit) {
      writeBadRequest(response, "transcript_limit_invalid");
      return;
    }

    const sinceParam = requestUrl.searchParams.get("since");
    const since = sinceParam === null ? undefined : normalizeTimestamp(sinceParam, "transcript_since_invalid");
    if (since !== undefined && typeof since !== "string") {
      writeBadRequest(response, since.error);
      return;
    }

    const untilParam = requestUrl.searchParams.get("until");
    const until = untilParam === null ? undefined : normalizeTimestamp(untilParam, "transcript_until_invalid");
    if (until !== undefined && typeof until !== "string") {
      writeBadRequest(response, until.error);
      return;
    }

    if (since !== undefined && until !== undefined && compareTimestamps(since, until) > 0) {
      writeBadRequest(response, "transcript_window_invalid");
      return;
    }

    const textParam = requestUrl.searchParams.get("text");
    if (textParam !== null && !textParam.trim()) {
      writeBadRequest(response, "transcript_text_invalid");
      return;
    }

    const orderParam = requestUrl.searchParams.get("order");
    if (orderParam !== null && orderParam !== "asc" && orderParam !== "desc") {
      writeBadRequest(response, "transcript_order_invalid");
      return;
    }

    const snapshot = await ingress.getSnapshot(callTranscriptMatch[1]);
    if (!snapshot) {
      writeNotFound(response);
      return;
    }

    writeJson(
      response,
      200,
      buildTranscriptPayload(
        snapshot,
        speakerParam ?? undefined,
        since,
        until,
        textParam?.trim() || undefined,
        offset,
        limit,
        orderParam ?? "asc",
      ),
    );
    return;
  }

  const callEventsMatch = request.method === "GET" ? pathname.match(/^\/api\/calls\/([^/]+)\/events$/) : null;
  if (callEventsMatch) {
    const type = requestUrl.searchParams.get("type");
    if (type !== null && !type.trim()) {
      writeBadRequest(response, "event_type_invalid");
      return;
    }

    const source = requestUrl.searchParams.get("source");
    if (source !== null && !source.trim()) {
      writeBadRequest(response, "event_source_invalid");
      return;
    }

    const detailText = requestUrl.searchParams.get("detailText");
    if (detailText !== null && !detailText.trim()) {
      writeBadRequest(response, "event_detail_text_invalid");
      return;
    }

    const detailKey = requestUrl.searchParams.get("detailKey");
    if (detailKey !== null && !detailKey.trim()) {
      writeBadRequest(response, "event_detail_key_invalid");
      return;
    }

    const sinceParam = requestUrl.searchParams.get("since");
    const since = sinceParam === null ? undefined : normalizeTimestamp(sinceParam, "event_since_invalid");
    if (since !== undefined && typeof since !== "string") {
      writeBadRequest(response, since.error);
      return;
    }

    const untilParam = requestUrl.searchParams.get("until");
    const until = untilParam === null ? undefined : normalizeTimestamp(untilParam, "event_until_invalid");
    if (until !== undefined && typeof until !== "string") {
      writeBadRequest(response, until.error);
      return;
    }

    if (since !== undefined && until !== undefined && compareTimestamps(since, until) > 0) {
      writeBadRequest(response, "event_window_invalid");
      return;
    }

    const offset = parseOptionalNonNegativeIntegerFilter(requestUrl.searchParams.get("offset"), "event_offset_invalid");
    if (offset !== undefined && typeof offset !== "number") {
      writeBadRequest(response, offset.error);
      return;
    }

    const limit = parseOptionalPositiveIntegerFilter(requestUrl.searchParams.get("limit"), "event_limit_invalid");
    if (limit !== undefined && typeof limit !== "number") {
      writeBadRequest(response, limit.error);
      return;
    }

    if (limit !== undefined && limit > maxEventTrailPageLimit) {
      writeBadRequest(response, "event_limit_invalid");
      return;
    }

    const orderParam = requestUrl.searchParams.get("order");
    if (orderParam !== null && orderParam !== "asc" && orderParam !== "desc") {
      writeBadRequest(response, "event_order_invalid");
      return;
    }

    const snapshot = await ingress.getSnapshot(callEventsMatch[1]);
    if (!snapshot) {
      writeNotFound(response);
      return;
    }

    writeJson(
      response,
      200,
      buildEventTrailPayload(
        snapshot,
        type?.trim() || undefined,
        source?.trim() || undefined,
        detailKey?.trim() || undefined,
        detailText?.trim() || undefined,
        since,
        until,
        offset,
        limit,
        orderParam ?? "asc",
      ),
    );
    return;
  }

  const callLatencyMatch = request.method === "GET" ? pathname.match(/^\/api\/calls\/([^/]+)\/latency$/) : null;
  if (callLatencyMatch) {
    const stage = requestUrl.searchParams.get("stage");
    if (stage !== null && !stage.trim()) {
      writeBadRequest(response, "latency_stage_invalid");
      return;
    }

    const overBudget = parseOptionalBooleanFilter(
      requestUrl.searchParams.get("overBudget"),
      "latency_over_budget_invalid",
    );
    if (overBudget !== undefined && typeof overBudget !== "boolean") {
      writeBadRequest(response, overBudget.error);
      return;
    }

    const sinceParam = requestUrl.searchParams.get("since");
    const since = sinceParam === null ? undefined : normalizeTimestamp(sinceParam, "latency_since_invalid");
    if (since !== undefined && typeof since !== "string") {
      writeBadRequest(response, since.error);
      return;
    }

    const untilParam = requestUrl.searchParams.get("until");
    const until = untilParam === null ? undefined : normalizeTimestamp(untilParam, "latency_until_invalid");
    if (until !== undefined && typeof until !== "string") {
      writeBadRequest(response, until.error);
      return;
    }

    if (since !== undefined && until !== undefined && compareTimestamps(since, until) > 0) {
      writeBadRequest(response, "latency_window_invalid");
      return;
    }

    const offset = parseOptionalNonNegativeIntegerFilter(requestUrl.searchParams.get("offset"), "latency_offset_invalid");
    if (offset !== undefined && typeof offset !== "number") {
      writeBadRequest(response, offset.error);
      return;
    }

    const limit = parseOptionalPositiveIntegerFilter(requestUrl.searchParams.get("limit"), "latency_limit_invalid");
    if (limit !== undefined && typeof limit !== "number") {
      writeBadRequest(response, limit.error);
      return;
    }

    if (limit !== undefined && limit > maxLatencyMarkPageLimit) {
      writeBadRequest(response, "latency_limit_invalid");
      return;
    }

    const orderParam = requestUrl.searchParams.get("order");
    if (orderParam !== null && orderParam !== "asc" && orderParam !== "desc") {
      writeBadRequest(response, "latency_order_invalid");
      return;
    }

    const snapshot = await ingress.getSnapshot(callLatencyMatch[1]);
    if (!snapshot) {
      writeNotFound(response);
      return;
    }

    writeJson(
      response,
      200,
      buildLatencyPayload(snapshot, stage?.trim() || undefined, overBudget, since, until, offset, limit, orderParam ?? "asc"),
    );
    return;
  }

  const callArtifactsMatch = request.method === "GET" ? pathname.match(/^\/api\/calls\/([^/]+)\/artifacts$/) : null;
  if (callArtifactsMatch) {
    const snapshot = await ingress.getSnapshot(callArtifactsMatch[1]);
    if (!snapshot) {
      writeNotFound(response);
      return;
    }

    writeJson(response, 200, buildCallArtifactManifestPayload(snapshot));
    return;
  }

  const callProofBundleMatch = request.method === "GET" ? pathname.match(/^\/api\/calls\/([^/]+)\/proof$/) : null;
  if (callProofBundleMatch) {
    const snapshot = await ingress.getSnapshot(callProofBundleMatch[1]);
    if (!snapshot) {
      writeNotFound(response);
      return;
    }

    writeJson(response, 200, buildCallProofBundlePayload(snapshot));
    return;
  }

  const callSnapshotMatch = request.method === "GET" ? pathname.match(/^\/api\/calls\/([^/]+)$/) : null;
  if (callSnapshotMatch) {
    const snapshot = await ingress.getSnapshot(callSnapshotMatch[1]);
    if (!snapshot) {
      writeNotFound(response);
      return;
    }

    writeJson(response, 200, buildCallPayload(snapshot));
    return;
  }

  writeNotFound(response);
}

export function buildHttpServer(config: PocConfig) {
  const ingress = new InMemoryTelephonyIngress();
  const signalWireCallMap = new Map<string, string>();
  const liveSipCallMap = new Map<string, string>();
  const liveSipEndedCallMap = new Map<string, LiveSipEndedCallAlias>();
  const liveSipCallLocks = new Map<string, Promise<void>>();
  const liveSipOpenAiGenerationLocks = new Map<string, Promise<void>>();
  const callerTurnDeliveryAckPreviews = new Map<string, CallerTurnDeliveryAckPreview>();
  const callerTurnDeliveryAckPreviewReservations = new Set<string>();
  const voiceSessions = new RealtimeVoiceSessionStore();

  const server = createServer((request, response) => {
    void routeRequest(request, response, config, ingress, signalWireCallMap, liveSipCallMap, liveSipEndedCallMap, liveSipCallLocks, liveSipOpenAiGenerationLocks, callerTurnDeliveryAckPreviews, callerTurnDeliveryAckPreviewReservations, voiceSessions).catch((error: unknown) => {
      if (error instanceof InvalidJsonBodyError) {
        writeBadRequest(response, "invalid_json");
        return;
      }

      console.error(error);
      writeJson(response, 500, { ok: false, error: "internal_error" });
    });
  });

  server.on("upgrade", (request, socket) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const match = requestUrl.pathname.match(/^\/api\/voice\/sessions\/([^/]+)\/media\/input$/);
    if (!match) {
      socket.destroy();
      return;
    }
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(match[1]);
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const session = voiceSessions.get(sessionId);
    const websocketKey = request.headers["sec-websocket-key"];
    if (!session || session.status !== "open") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (typeof websocketKey !== "string" || !websocketKey.trim()) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${buildWebSocketAcceptKey(websocketKey)}\r\n` +
        "\r\n",
    );
    socket.write(encodeWebSocketTextFrame({ ok: true, type: "voice_session.media_input.ready", sessionId }));
    let websocketBuffer = Buffer.alloc(0);
    let fragmentedMessage: { opcode: number; chunks: Buffer[] } | null = null;
    socket.on("data", (chunk) => {
      websocketBuffer = Buffer.concat([websocketBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const decoded = decodeWebSocketFrames(websocketBuffer);
      websocketBuffer = Buffer.from(decoded.remaining);
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x8) {
          socket.end(Buffer.from([0x88, 0x00]));
          return;
        }
        if (frame.opcode === 0x0) {
          if (!fragmentedMessage) {
            socket.write(encodeWebSocketTextFrame({ ok: false, type: "voice_session.media_input.invalid_fragment", sessionId }));
            socket.end();
            return;
          }
          fragmentedMessage.chunks.push(frame.payload);
          if (!frame.fin) continue;
          const payload = Buffer.concat(fragmentedMessage.chunks);
          const opcode = fragmentedMessage.opcode;
          fragmentedMessage = null;
          const updated = voiceSessions.recordMediaInput(sessionId, {
            bytes: payload.byteLength,
            mimeType: opcode === 0x1 ? "application/json" : "application/octet-stream",
            sampleRateHz: undefined,
          });
          if (!updated) {
            socket.write(encodeWebSocketTextFrame({ ok: false, type: "voice_session.closed", sessionId }));
            socket.end();
            return;
          }
          socket.write(encodeWebSocketTextFrame({
            ok: true,
            type: "voice_session.media_input.received",
            sessionId,
            bytes: payload.byteLength,
            inputChunks: updated.media.inputChunks,
            inputBytes: updated.media.inputBytes,
          }));
          continue;
        }
        if (frame.opcode !== 0x1 && frame.opcode !== 0x2) continue;
        if (!frame.fin) {
          fragmentedMessage = { opcode: frame.opcode, chunks: [frame.payload] };
          continue;
        }
        const updated = voiceSessions.recordMediaInput(sessionId, {
          bytes: frame.payload.byteLength,
          mimeType: frame.opcode === 0x1 ? "application/json" : "application/octet-stream",
          sampleRateHz: undefined,
        });
        if (!updated) {
          socket.write(encodeWebSocketTextFrame({ ok: false, type: "voice_session.closed", sessionId }));
          socket.end();
          return;
        }
        socket.write(encodeWebSocketTextFrame({
          ok: true,
          type: "voice_session.media_input.received",
          sessionId,
          bytes: frame.payload.byteLength,
          inputChunks: updated.media.inputChunks,
          inputBytes: updated.media.inputBytes,
        }));
      }
    });
  });

  return server;
}
