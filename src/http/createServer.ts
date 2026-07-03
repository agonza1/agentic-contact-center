import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { compareTimestamps, getAttentionMetadata } from "../core/attention";
import { InMemoryTelephonyIngress } from "../core/inMemoryTelephonyIngress";
import { LocalRealtimeShimPrototype } from "../core/localRealtimeShimPrototype";
import { getPipecatPrototypeHealth, SCRIPTED_CALLER_TURNS } from "../core/pipecatFlowPrototype";
import { REALTIME_SHIM_RPCS } from "../core/realtimeShimContract";
import { runtimeSeams } from "../core/seams";
import type {
  AttentionSource,
  CallSnapshot,
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

function buildRealtimeShimProofPayload(): object {
  const shim = new LocalRealtimeShimPrototype();
  const envelope = shim.createSession({ relaySessionId: "local-rt-http-proof" });
  const interruptEnvelope = shim.createSession({ relaySessionId: "local-rt-http-interrupt-proof" });
  const inputCancelEnvelope = shim.createSession({ relaySessionId: "local-rt-http-input-cancel-proof" });
  const errorEnvelope = shim.createSession({ relaySessionId: "local-rt-http-error-proof" });
  const invalidAudioEnvelope = shim.createSession({ relaySessionId: "local-rt-http-invalid-audio-proof" });
  const audioBase64 = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]).toString("base64");

  shim.appendAudio({ sessionId: envelope.sessionId, audioBase64, timestamp: 42 });
  const evidence = shim.finalizeTurn({
    sessionId: envelope.sessionId,
    transcriptText: "Can I get a retention credit?",
  });
  const closeEvidence = shim.closeSession({
    sessionId: envelope.sessionId,
    reason: "complete",
  });

  shim.appendAudio({ sessionId: interruptEnvelope.sessionId, audioBase64, timestamp: 84 });
  shim.finalizeTurn({
    sessionId: interruptEnvelope.sessionId,
    transcriptText: "Actually, I need to interrupt.",
  });
  const interruptionEvidence = shim.cancelOutput({
    sessionId: interruptEnvelope.sessionId,
    reason: "barge-in",
  });

  shim.appendAudio({ sessionId: inputCancelEnvelope.sessionId, audioBase64, timestamp: 126 });
  const inputCancelEvidence = shim.cancelInput({ sessionId: inputCancelEnvelope.sessionId });

  shim.appendAudio({ sessionId: errorEnvelope.sessionId, audioBase64, timestamp: 168 });
  shim.recordLocalSttError({
    sessionId: errorEnvelope.sessionId,
    code: "stream_warning",
    message: "local stt partial frame arrived late",
    retryable: true,
  });
  const errorEvidence = shim.recordLocalSttError({
    sessionId: errorEnvelope.sessionId,
    code: "stt_disconnected",
    message: "local stt websocket closed before final transcript",
  });
  const invalidAudioResult = shim.appendAudioWithErrorEvidence({
    sessionId: invalidAudioEnvelope.sessionId,
    audioBase64: "AQI",
    timestamp: 210,
  });

  const acceptanceSummary = {
    oneLocalVoiceTurn: evidence.qaChecklist.oneTurnEvidence && closeEvidence.state === "closed",
    adapterContract:
      evidence.envelope.transport === "gateway-relay" &&
      evidence.envelope.provider === "local-realtime-shim" &&
      buildRealtimeShimRpcSmoke().every((step) => step.ok),
    interruptionCancelBehavior:
      interruptionEvidence.qaChecklist.interruptionEvidence && inputCancelEvidence.qaChecklist.inputCancelEvidence,
    qaEvidence:
      evidence.qaChecklist.eventTranscriptEvidence && evidence.qaChecklist.logEvidence && evidence.latencyMarks.length > 0,
    mockedPiecesIsolated:
      evidence.qaChecklist.mockedPiecesNamed && evidence.mockedPieces.length > 0 && evidence.limitations.length > 0,
    boundedErrorEvidence:
      errorEvidence.qaChecklist.boundedErrorEvidence && invalidAudioResult.evidence.qaChecklist.boundedErrorEvidence,
  };
  const localSttStartMessage = evidence.localSttMessages.find((message) => message.type === "start");
  const localSttVersion = localSttStartMessage && "version" in localSttStartMessage
    ? localSttStartMessage.version
    : "unknown-local-stt";
  const acceptanceDetails = {
    oneLocalVoiceTurn: {
      status: acceptanceSummary.oneLocalVoiceTurn ? "passed" : "failed",
      evidence: "Gateway relay session accepted microphone audio, finalized a transcript, emitted output audio, and closed cleanly.",
      routes: ["GET /api/realtime-shim/proof", "POST /api/realtime-shim/rpc"],
    },
    adapterContract: {
      status: acceptanceSummary.adapterContract ? "passed" : "failed",
      evidence: `${evidence.envelope.provider} over ${evidence.envelope.transport} with ${localSttVersion}`,
      routes: ["POST /api/realtime-shim/rpc"],
    },
    interruptionCancelBehavior: {
      status: acceptanceSummary.interruptionCancelBehavior ? "passed" : "failed",
      evidence: "Barge-in emits relay clear evidence and input cancel drops buffered STT audio without dispatching a final transcript.",
      routes: ["GET /api/realtime-shim/proof", "POST /api/realtime-shim/rpc"],
    },
    qaEvidence: {
      status: acceptanceSummary.qaEvidence ? "passed" : "failed",
      evidence: "Proof payload includes logs, event transcript, timeline, latency marks, and pipeline stage evidence.",
      routes: ["GET /api/realtime-shim/proof"],
    },
    mockedPiecesIsolated: {
      status: acceptanceSummary.mockedPiecesIsolated ? "passed" : "failed",
      evidence: evidence.mockedPieces.join(", "),
      routes: ["GET /api/realtime-shim/proof"],
    },
    boundedErrorEvidence: {
      status: acceptanceSummary.boundedErrorEvidence ? "passed" : "failed",
      evidence: "Local STT disconnects and malformed relay audio return bounded error evidence with retryability.",
      routes: ["GET /api/realtime-shim/proof", "POST /api/realtime-shim/rpc"],
    },
  };

  return {
    ok: true,
    route: "/api/realtime-shim/proof",
    issue: "agonza1/agentic-contact-center#85",
    rpcBoundary: "gateway-relay",
    localSttContract: "local-stt.v1",
    rpcCompatibility: {
      route: "POST /api/realtime-shim/rpc",
      supportedRpcs: REALTIME_SHIM_RPCS,
      statefulSession: true,
      boundedErrors: true,
    },
    acceptanceSummary,
    acceptanceDetails,
    readyForIssue85Review: Object.values(acceptanceSummary).every(Boolean),
    rpcSmoke: buildRealtimeShimRpcSmoke(),
    evidence,
    closeEvidence,
    interruptionEvidence,
    inputCancelEvidence,
    errorEvidence,
    invalidAudioResult,
  };
}

function buildRealtimeShimRpcSmoke(): Array<{
  method: string;
  ok: boolean;
  relaySessionId?: string;
  state?: string;
  audioChunks?: number;
  relayEvents?: number;
  diagnostics?: number;
  turnSummary?: {
    inputAudioChunks: number;
    inputAudioBytes: number;
    finalTranscript?: string;
    outputAudioChunks: number;
    outputCancelled: boolean;
    inputCancelled: boolean;
    errorCount: number;
    closed: boolean;
  };
}> {
  const shim = new LocalRealtimeShimPrototype();
  const audioBase64 = Buffer.from([9, 0, 10, 0]).toString("base64");
  const steps = [
    {
      method: "talk.session.create",
      params: { mode: "realtime", transport: "gateway-relay", relaySessionId: "local-rt-rpc-smoke" },
    },
    { method: "talk.session.appendAudio", params: { sessionId: "local-rt-rpc-smoke", audioBase64, timestamp: 12 } },
    {
      method: "talk.session.finalizeTurn",
      params: { sessionId: "local-rt-rpc-smoke", transcriptText: "Need a retention credit." },
    },
    { method: "talk.session.getEvidence", params: { sessionId: "local-rt-rpc-smoke" } },
    { method: "talk.session.close", params: { sessionId: "local-rt-rpc-smoke", reason: "complete" } },
    {
      method: "talk.session.create",
      params: { mode: "realtime", transport: "gateway-relay", relaySessionId: "local-rt-rpc-cancel" },
    },
    { method: "talk.session.appendAudio", params: { sessionId: "local-rt-rpc-cancel", audioBase64, timestamp: 24 } },
    {
      method: "talk.session.finalizeTurn",
      params: { sessionId: "local-rt-rpc-cancel", transcriptText: "Please stop that response." },
    },
    { method: "talk.session.cancelOutput", params: { sessionId: "local-rt-rpc-cancel", reason: "barge-in" } },
    { method: "talk.session.cancelInput", params: { sessionId: "local-rt-rpc-cancel" } },
    {
      method: "talk.session.create",
      params: { mode: "realtime", transport: "gateway-relay", relaySessionId: "local-rt-rpc-tools" },
    },
    {
      method: "talk.session.submitToolResult",
      params: { sessionId: "local-rt-rpc-tools", toolCallId: "tool-review-1", result: { ok: true } },
    },
    {
      method: "talk.session.recordError",
      params: {
        sessionId: "local-rt-rpc-tools",
        code: "stt_disconnected",
        message: "Local STT websocket closed before final transcript",
        retryable: true,
      },
    },
  ];

  return steps.map((step) => {
    const response = buildRealtimeShimRpcResponse(shim, step);
    const result = isRecord(response) && isRecord(response.result) ? response.result : undefined;
    const audioInput = result && isRecord(result.audioInput) ? result.audioInput : undefined;
    const turnSummary = result && isRealtimeShimTurnSummary(result.turnSummary) ? result.turnSummary : undefined;

    return {
      method: step.method,
      ok: isRecord(response) && response.ok === true,
      relaySessionId: result ? getOptionalTrimmedString(result.relaySessionId) : undefined,
      state: result ? getOptionalTrimmedString(result.state) : undefined,
      audioChunks: typeof audioInput?.chunks === "number" ? audioInput.chunks : undefined,
      relayEvents: Array.isArray(result?.relayEvents) ? result.relayEvents.length : undefined,
      diagnostics: Array.isArray(result?.diagnostics) ? result.diagnostics.length : undefined,
      turnSummary,
    };
  });
}

function isRealtimeShimTurnSummary(value: unknown): value is {
  inputAudioChunks: number;
  inputAudioBytes: number;
  finalTranscript?: string;
  outputAudioChunks: number;
  outputCancelled: boolean;
  inputCancelled: boolean;
  errorCount: number;
  closed: boolean;
} {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.inputAudioChunks === "number" &&
    typeof value.inputAudioBytes === "number" &&
    (value.finalTranscript === undefined || typeof value.finalTranscript === "string") &&
    typeof value.outputAudioChunks === "number" &&
    typeof value.outputCancelled === "boolean" &&
    typeof value.inputCancelled === "boolean" &&
    typeof value.errorCount === "number" &&
    typeof value.closed === "boolean"
  );
}

function buildRealtimeShimReadinessPayload(): object {
  const proof = buildRealtimeShimProofPayload() as {
    issue: string;
    rpcBoundary: string;
    localSttContract: string;
    rpcCompatibility: { route: string; supportedRpcs: string[]; statefulSession: boolean; boundedErrors: boolean };
    acceptanceSummary: Record<string, boolean>;
    readyForIssue85Review: boolean;
    evidence: {
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
      mockedPieces: string[];
      limitations: string[];
      pipelineStages: Array<{ stage: string; status: string; mocked: boolean; evidence: string }>;
    };
    closeEvidence: { state: string };
    interruptionEvidence: { qaChecklist: Record<string, boolean> };
    inputCancelEvidence: { qaChecklist: Record<string, boolean> };
    errorEvidence: { qaChecklist: Record<string, boolean> };
  };

  return {
    ok: true,
    route: "/api/realtime-shim/readiness",
    issue: proof.issue,
    status: proof.readyForIssue85Review ? "ready_for_issue_85_review" : "not_ready",
    adapter: {
      rpcBoundary: proof.rpcBoundary,
      localSttContract: proof.localSttContract,
      rpcRoute: proof.rpcCompatibility.route,
      supportedRpcs: proof.rpcCompatibility.supportedRpcs,
      statefulSession: proof.rpcCompatibility.statefulSession,
      boundedErrors: proof.rpcCompatibility.boundedErrors,
    },
    browserRelayCompatibility: proof.evidence.browserRelayCompatibility,
    latencyBudget: proof.evidence.latencyBudget,
    runtimeMode: {
      labels: {
        relay: "gateway_relay",
        stt: "local_stt_mock",
        llm: "local_llm_mock",
        tts: "kokoro_tts_mock",
      },
      liveSidecarsRequired: false,
      reviewStatus: proof.readyForIssue85Review ? "deterministic_local_proof_ready" : "blocked",
    },
    reviewBlockers: proof.readyForIssue85Review ? [] : ["One or more Issue #85 acceptance criteria are not satisfied."],
    reviewPacket: {
      ready: proof.readyForIssue85Review,
      issue: proof.issue,
      primaryRoute: "/api/realtime-shim/proof",
      readinessRoute: "/api/realtime-shim/readiness",
      rpcRoute: proof.rpcCompatibility.route,
      validationCommands: ["npm test", "npm run pipecat:check", "npm run proof:realtime-shim"],
      probeCommands: [
        "curl -fsS http://127.0.0.1:8026/api/realtime-shim/proof",
        "curl -fsS http://127.0.0.1:8026/api/realtime-shim/readiness",
        "curl -fsS -X POST http://127.0.0.1:8026/api/realtime-shim/rpc -H 'content-type: application/json' --data '{\"method\":\"talk.session.getEvidence\",\"params\":{\"sessionId\":\"local-rt-review\"}}'",
      ],
      rpcExamples: [
        {
          label: "create local realtime shim session",
          method: "talk.session.create",
          body: {
            method: "talk.session.create",
            params: { mode: "realtime", transport: "gateway-relay", relaySessionId: "local-rt-review" },
          },
        },
        {
          label: "append one browser PCM16 audio chunk",
          method: "talk.session.appendAudio",
          body: {
            method: "talk.session.appendAudio",
            params: { sessionId: "local-rt-review", audioBase64: "AAABAAIAAwA=", timestamp: 42 },
          },
        },
        {
          label: "finalize one local voice turn",
          method: "talk.session.finalizeTurn",
          body: {
            method: "talk.session.finalizeTurn",
            params: { sessionId: "local-rt-review", transcriptText: "Need a retention credit." },
          },
        },
        {
          label: "inspect review evidence",
          method: "talk.session.getEvidence",
          body: { method: "talk.session.getEvidence", params: { sessionId: "local-rt-review" } },
        },
        {
          label: "cancel output on browser barge-in",
          method: "talk.session.cancelOutput",
          body: { method: "talk.session.cancelOutput", params: { sessionId: "local-rt-review", reason: "barge-in" } },
        },
        {
          label: "cancel pending input audio",
          method: "talk.session.cancelInput",
          body: { method: "talk.session.cancelInput", params: { sessionId: "local-rt-review" } },
        },
        {
          label: "record bounded Local STT error",
          method: "talk.session.recordError",
          body: {
            method: "talk.session.recordError",
            params: {
              sessionId: "local-rt-review",
              code: "stt_disconnected",
              message: "Local STT websocket closed before final transcript",
              retryable: true,
            },
          },
        },
        {
          label: "record tool result compatibility evidence",
          method: "talk.session.submitToolResult",
          body: {
            method: "talk.session.submitToolResult",
            params: { sessionId: "local-rt-review", toolCallId: "tool-review-1", result: { ok: true } },
          },
        },
        {
          label: "close local realtime shim session",
          method: "talk.session.close",
          body: { method: "talk.session.close", params: { sessionId: "local-rt-review", reason: "complete" } },
        },
      ],
      reviewerChecklist: [
        "Confirm the Gateway relay RPC boundary matches the OpenClaw browser voice surface.",
        "Inspect proof.evidence.eventTranscript, proof.evidence.logs, proof.evidence.latencyMarks, and latencyBudget for the one-turn path.",
        "Inspect interruptionEvidence, inputCancelEvidence, errorEvidence, and invalidAudioResult for cancel/error behavior.",
        "Confirm mockedPieces and limitations name the non-live rtc-asr, local LLM, and Kokoro boundaries.",
      ],
    },
    validationCommands: ["npm test", "npm run pipecat:check", "npm run proof:realtime-shim"],
    qaEvidenceRoutes: [
      {
        route: "/api/realtime-shim/proof",
        method: "GET",
        evidence: ["logs", "eventTranscript", "timeline", "latencyMarks", "latencyBudget", "pipelineStages"],
      },
      {
        route: "/api/realtime-shim/rpc",
        method: "POST",
        evidence: ["statefulSession", "cancelInput", "cancelOutput", "boundedErrors", "toolResults"],
      },
    ],
    acceptanceCriteria: [
      {
        name: "adapter_contract",
        passed: proof.acceptanceSummary.adapterContract,
        evidence: `${proof.rpcBoundary} RPCs expose ${proof.localSttContract}`,
      },
      {
        name: "one_local_voice_turn",
        passed: proof.acceptanceSummary.oneLocalVoiceTurn && proof.closeEvidence.state === "closed",
        evidence: "Proof flow ingests audio, finalizes transcript, emits output audio, and closes cleanly.",
      },
      {
        name: "interruption_cancel_behavior",
        passed: proof.acceptanceSummary.interruptionCancelBehavior &&
          proof.interruptionEvidence.qaChecklist.interruptionEvidence &&
          proof.inputCancelEvidence.qaChecklist.inputCancelEvidence,
        evidence: "Barge-in clear and input cancel are both represented in deterministic Gateway relay evidence.",
      },
      {
        name: "qa_evidence",
        passed: proof.acceptanceSummary.qaEvidence,
        evidence: "Proof payload includes logs, event transcript, timeline, latency marks, and pipeline stage evidence.",
      },
      {
        name: "mocked_pieces_isolated",
        passed: proof.acceptanceSummary.mockedPiecesIsolated,
        evidence: proof.evidence.mockedPieces.join(", "),
      },
      {
        name: "bounded_error_evidence",
        passed: proof.acceptanceSummary.boundedErrorEvidence && proof.errorEvidence.qaChecklist.boundedErrorEvidence,
        evidence: "Local STT and malformed audio failures emit bounded retryability/error evidence.",
      },
    ],
    pipelineStages: proof.evidence.pipelineStages,
    mockedPieces: proof.evidence.mockedPieces,
    limitations: proof.evidence.limitations,
  };
}

function buildRealtimeShimRpcResponse(shim: LocalRealtimeShimPrototype, body: unknown): object {
  if (!isRecord(body)) {
    return { ok: false, error: "json_object_required" };
  }

  const method = getOptionalTrimmedString(body.method);
  const params = body.params === undefined ? {} : body.params;

  if (!method) {
    return { ok: false, error: "realtime_shim_method_required" };
  }

  if (!isRecord(params)) {
    return { ok: false, error: "realtime_shim_params_object_required" };
  }

  try {
    if (method === "talk.session.create") {
      const mode = getOptionalTrimmedString(params.mode) ?? "realtime";
      const transport = getOptionalTrimmedString(params.transport) ?? "gateway-relay";

      if (mode !== "realtime" || transport !== "gateway-relay") {
        return { ok: false, error: "realtime_shim_session_shape_invalid" };
      }

      return {
        ok: true,
        method,
        result: shim.createSession({
          brain: getOptionalTrimmedString(params.brain),
          relaySessionId: getOptionalTrimmedString(params.relaySessionId),
        }),
      };
    }

    if (method === "talk.session.appendAudio") {
      return {
        ok: true,
        method,
        result: shim.appendAudio({
          sessionId: getOptionalTrimmedString(params.sessionId) ?? "",
          audioBase64: getOptionalTrimmedString(params.audioBase64) ?? "",
          timestamp: typeof params.timestamp === "number" ? params.timestamp : undefined,
        }),
      };
    }

    if (method === "talk.session.finalizeTurn") {
      return {
        ok: true,
        method,
        result: shim.finalizeTurn({
          sessionId: getOptionalTrimmedString(params.sessionId) ?? "",
          transcriptText: getOptionalTrimmedString(params.transcriptText),
        }),
      };
    }

    if (method === "talk.session.getEvidence") {
      return {
        ok: true,
        method,
        result: shim.getEvidence(getOptionalTrimmedString(params.sessionId) ?? ""),
      };
    }

    if (method === "talk.session.cancelOutput") {
      return {
        ok: true,
        method,
        result: shim.cancelOutput({
          sessionId: getOptionalTrimmedString(params.sessionId) ?? "",
          reason: parseRealtimeShimCancelReason(params.reason),
        }),
      };
    }

    if (method === "talk.session.cancelInput") {
      return {
        ok: true,
        method,
        result: shim.cancelInput({
          sessionId: getOptionalTrimmedString(params.sessionId) ?? "",
        }),
      };
    }

    if (method === "talk.session.recordError") {
      return {
        ok: true,
        method,
        result: shim.recordLocalSttError({
          sessionId: getOptionalTrimmedString(params.sessionId) ?? "",
          code: getOptionalTrimmedString(params.code) ?? "local_stt_error",
          message: getOptionalTrimmedString(params.message) ?? "Local STT error",
          retryable: typeof params.retryable === "boolean" ? params.retryable : undefined,
        }),
      };
    }

    if (method === "talk.session.submitToolResult") {
      return {
        ok: true,
        method,
        result: shim.submitToolResult({
          sessionId: getOptionalTrimmedString(params.sessionId) ?? "",
          toolCallId: getOptionalTrimmedString(params.toolCallId) ?? "",
          result: params.result,
        }),
      };
    }

    if (method === "talk.session.close") {
      return {
        ok: true,
        method,
        result: shim.closeSession({
          sessionId: getOptionalTrimmedString(params.sessionId) ?? "",
          reason: parseRealtimeShimCloseReason(params.reason),
        }),
      };
    }

    return { ok: false, error: "realtime_shim_method_unsupported" };
  } catch (error) {
    return {
      ok: false,
      error: "realtime_shim_rpc_error",
      message: error instanceof Error ? error.message : "Realtime shim RPC failed",
    };
  }
}

function parseRealtimeShimCancelReason(value: unknown): "barge-in" | "cancelled" | "error" | undefined {
  return value === "barge-in" || value === "cancelled" || value === "error" ? value : undefined;
}

function parseRealtimeShimCloseReason(value: unknown): "client" | "complete" | "error" | undefined {
  return value === "client" || value === "complete" || value === "error" ? value : undefined;
}

const operatorSteerActions: OperatorSteerAction[] = [
  "approve_offer",
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

function buildOperatorConsoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Operator Console</title>
  <style>
    :root { --bg: #f6f7f9; --panel: #fff; --text: #14202b; --muted: #657487; --line: #d7dee8; --accent: #0f766e; --danger: #b42318; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 24px; border-bottom: 1px solid var(--line); background: var(--panel); }
    h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0; }
    main { display: grid; grid-template-columns: minmax(260px, 360px) 1fr; gap: 16px; padding: 16px; }
    button, input, select, textarea { font: inherit; }
    button { min-height: 36px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--text); cursor: pointer; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.danger { color: var(--danger); border-color: #f0b8b2; }
    button:disabled { cursor: not-allowed; opacity: 0.45; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .panel h2 { margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--line); font-size: 15px; }
    .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid var(--line); background: #fbfcfe; }
    .filter-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; white-space: nowrap; }
    .status, .meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .call-list { display: grid; }
    .call-item { width: 100%; display: grid; gap: 4px; padding: 12px 14px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; text-align: left; }
    .call-item[aria-selected="true"] { border-left: 4px solid var(--accent); background: #eefaf7; padding-left: 10px; }
    .call-id { font-weight: 700; }
    .detail { display: grid; gap: 14px; padding: 14px; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .metric { border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: #fbfcfe; }
    .metric strong { display: block; font-size: 18px; }
    .proof-panel { display: grid; gap: 10px; border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #f8fafc; }
    .proof-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .proof-header h3 { margin: 0; font-size: 15px; }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; }
    .badge { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 8px; border: 1px solid var(--line); border-radius: 999px; background: #fff; color: var(--muted); font-size: 12px; }
    .badge.live { color: #0f5f58; border-color: #8fd6cd; background: #eefaf7; }
    .badge.warn { color: #8a3d13; border-color: #f5bf8f; background: #fff7ed; }
    .proof-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
    .caveats { margin: 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
    .evidence { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
    .evidence a { color: var(--accent); font-weight: 700; text-decoration: none; }
    .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 8px; }
    .scripted-turns { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
    .scripted-turns button { text-align: left; padding: 8px; }
    .transcript { display: grid; gap: 8px; max-height: 320px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: #fbfcfe; }
    .turn { display: grid; gap: 2px; }
    .turn b { font-size: 12px; color: var(--muted); text-transform: uppercase; }
    form { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    textarea { min-height: 72px; resize: vertical; border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
    input, select { min-height: 36px; border: 1px solid var(--line); border-radius: 6px; padding: 8px; max-width: 180px; background: #fff; }
    input[type="checkbox"] { min-height: auto; width: 16px; height: 16px; padding: 0; }
    @media (max-width: 820px) { main { grid-template-columns: 1fr; } .grid { grid-template-columns: 1fr; } form { grid-template-columns: 1fr; } input, select { max-width: none; width: 100%; } .filters { align-items: stretch; } .filter-toggle { width: 100%; } }
  </style>
</head>
<body>
  <header>
    <h1>Operator Console</h1>
    <div class="toolbar"><span class="status" id="status">Loading</span><button type="button" id="start-demo">Start Demo Call</button><button type="button" id="refresh">Refresh</button></div>
  </header>
  <main>
    <section class="panel" aria-label="Live calls"><h2>Live Calls</h2><div class="filters"><label class="filter-toggle"><input type="checkbox" id="attention-filter">Attention only</label><label class="filter-toggle"><input type="checkbox" id="latency-over-budget-filter">Over-budget latency</label><select id="flow-filter" aria-label="Flow state filter"><option value="">All flow states</option><option value="call_started">Call Started</option><option value="greet">Greet</option><option value="diagnose">Diagnose</option><option value="policy_hold">Policy Hold</option><option value="operator_steer">Operator Steer</option><option value="steered_response">Steered Response</option><option value="wrap">Wrap</option></select><select id="fallback-filter" aria-label="Fallback mode filter"><option value="">All fallback modes</option><option value="tool_timeout">Tool Timeout</option><option value="runtime_failure">Runtime Failure</option></select><select id="fallback-source-filter" aria-label="Fallback source filter"><option value="">All fallback sources</option><option value="tool_timeout_fail_closed">Tool Timeout Source</option><option value="pipecat_runtime_failure_fail_closed">Runtime Failure Source</option></select><input id="fallback-reason-filter" aria-label="Fallback reason filter" placeholder="Fallback reason"><select id="tool-filter" aria-label="Active tool filter"><option value="">All active tools</option><option value="get_current_slide">Get Current Slide</option><option value="goto_slide">Go To Slide</option><option value="pause_presentation">Pause Presentation</option><option value="ask_operator">Ask Operator</option></select><select id="script-completed-filter" aria-label="Script status filter"><option value="">All script states</option><option value="false">In progress</option><option value="true">Complete</option></select><select id="script-progress-filter" aria-label="Script minimum progress filter"><option value="">Any min progress</option><option value="25">25%+ scripted</option><option value="50">50%+ scripted</option><option value="75">75%+ scripted</option><option value="100">100% scripted</option></select><select id="script-max-progress-filter" aria-label="Script maximum progress filter"><option value="">Any max progress</option><option value="0">0% or less scripted</option><option value="25">25% or less scripted</option><option value="50">50% or less scripted</option><option value="75">75% or less scripted</option></select><input id="transcript-filter" placeholder="Transcript search"><button type="button" id="clear-filters">Clear</button></div><div class="call-list" id="calls"></div></section>
    <section class="panel" aria-label="Selected call"><h2 id="selected-title">Select a call</h2><div class="detail" id="detail"></div></section>
  </main>
  <script>
    const state = { calls: [], selectedCallId: null, actionMetadata: {}, refreshTimer: null, refreshIntervalMs: ${operatorConsoleRefreshIntervalMs} };
    const actions = ["pause", "resume", "approve_offer", "deny_offer", "takeover", "escalate_to_human", "transfer", "end_call", "goto_slide", "ask_operator", "arm_fallback", "disarm_fallback"];
    const liveProofStatuses = ["not_review_ready", "ready_with_rtc_asr_blocker", "ready_for_conversation_agent_evals"];
    const labels = { approve_offer: "Approve", deny_offer: "Deny", escalate_to_human: "Escalate", transfer: "Transfer", end_call: "End Call", goto_slide: "Go To Slide", ask_operator: "Ask Operator", arm_fallback: "Arm Fallback", disarm_fallback: "Disarm Fallback" };
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
      return ["caller-turn", "note", "disposition"].some(function(id) {
        const input = document.getElementById(id);
        return input && (document.activeElement === input || input.value.trim());
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
      root.innerHTML = state.calls.map(function(call) {
        const labels = call.liveProof ? call.liveProof.labels : call.session.runtimeModeLabels;
        const labelText = labels ? [labels.telephony, labels.media, labels.rtcAsr].filter(Boolean).join(" | ") : "runtime labels unavailable";
        const scriptedState = call.actionState.scriptedCallerTurnState || { matchedTurns: 0, totalTurns: (state.scriptedCallerTurns || []).length, remainingTurns: (state.scriptedCallerTurns || []).length, progressPct: 0, nextTurnIndex: 0, nextTurnText: null, completed: false };
        const scriptedLabel = scriptedState.completed ? "script complete" : ("script " + scriptedState.matchedTurns + "/" + scriptedState.totalTurns + " | next: " + (scriptedState.nextTurnText || "queued"));
        return '<button type="button" class="call-item" aria-selected="' + (call.session.callId === state.selectedCallId) + '" data-call-id="' + escapeHtml(call.session.callId) + '"><span class="call-id">' + escapeHtml(call.session.callId) + '</span><span class="meta">' + escapeHtml(call.flowState) + ' | ' + (call.attention.required ? "attention" : "monitoring") + '</span><span class="meta">' + escapeHtml(scriptedLabel) + '</span><span class="meta">' + escapeHtml(labelText) + '</span><span class="meta">' + escapeHtml(call.session.openclawSession.label) + '</span></button>';
      }).join("") || '<div class="meta" style="padding:14px">No active calls</div>';
      root.querySelectorAll("button[data-call-id]").forEach(function(button) { button.addEventListener("click", function() { state.selectedCallId = button.dataset.callId; render(); }); });
    }
    function renderDetail() {
      const call = selectedCall();
      document.getElementById("selected-title").textContent = call ? call.session.callId : "Select a call";
      const root = document.getElementById("detail");
      if (!call) { root.innerHTML = ""; return; }
      const actionDetails = Object.fromEntries((call.actionState.actionDetails || []).map(function(entry) { return [entry.action, entry]; }));
      const unavailable = new Set(call.actionState.unavailableActions.map(function(entry) { return entry.action; }));
      const unavailableReasons = Object.fromEntries(call.actionState.unavailableActions.map(function(entry) { return [entry.action, entry.reason]; }));
      const actionHtml = actions.map(function(action) {
        const actionDetail = actionDetails[action] || {};
        const cssClass = action === "end_call" ? "danger" : action === "approve_offer" ? "primary" : "";
        const disabled = actionDetail.enabled === false || unavailable.has(action) ? "disabled" : "";
        const titleText = actionDetail.disabledReason || unavailableReasons[action];
        const title = titleText ? ' title="' + escapeHtml(titleText) + '"' : "";
        return '<button type="button" data-action="' + action + '" class="' + cssClass + '" ' + disabled + title + '>' + escapeHtml(labels[action] || action.replace(/_/g, " ")) + '</button>';
      }).join("");
      const transcriptHtml = call.transcript.slice(-10).map(function(turn) {
        return '<div class="turn"><b>' + escapeHtml(turn.speaker) + '</b><span>' + escapeHtml(turn.text) + '</span></div>';
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
      const evidenceHtml = '<div class="evidence" aria-label="Evidence markers"><div class="metric"><span class="meta">Latest Event</span><strong>' + escapeHtml(evidence.latestEventType || "none") + '</strong><span class="meta">' + escapeHtml(evidence.latestEventAt || "not recorded") + '</span><a href="' + escapeHtml(latestEventLink) + '">Event Trail</a></div><div class="metric"><span class="meta">Transcript Turns</span><strong>' + evidence.transcriptTurns + '</strong><a href="' + escapeHtml(evidenceLinks.transcript) + '">Transcript</a></div><div class="metric"><span class="meta">Latency Marks</span><strong>' + evidence.latencyMarkCount + '</strong><span class="meta">Over budget: ' + evidence.overBudgetLatencyMarkCount + '</span><a href="' + escapeHtml(latencyLink) + '">Latency</a></div><div class="metric"><span class="meta">Fallback</span><strong>' + escapeHtml(fallbackLabel) + '</strong><span class="meta">' + escapeHtml(fallbackDetail) + '</span><a href="' + escapeHtml(fallbackTrailLink) + '">Event Trail</a><a href="' + escapeHtml(fallbackQueueLink) + '">Fallback Queue</a>' + reasonTrailHtml + '</div><div class="metric"><span class="meta">Operator Notes</span><strong>' + evidence.operatorNoteCount + '</strong><span class="meta">' + escapeHtml(evidence.latestDisposition || evidence.latestOperatorNoteText || "none") + '</span><a href="' + escapeHtml(operatorNoteTrailLink) + '">Note Trail</a></div><div class="metric"><span class="meta">Proof Bundle</span><strong>' + evidence.eventCount + '</strong><a href="' + escapeHtml(evidenceLinks.proof) + '">Proof</a><a href="' + escapeHtml(evidenceLinks.artifacts) + '">Artifacts</a></div></div>';
      const scriptedState = call.actionState.scriptedCallerTurnState || { matchedTurns: 0, totalTurns: (state.scriptedCallerTurns || []).length, remainingTurns: (state.scriptedCallerTurns || []).length, progressPct: 0, nextTurnIndex: 0, nextTurnText: null, completed: false };
      const scriptedTurns = (state.scriptedCallerTurns || []).map(function(text, index) {
        const isCompleted = index < scriptedState.matchedTurns;
        const isNext = index === scriptedState.nextTurnIndex;
        const disabled = (isCompleted || !isNext) ? "disabled" : "";
        const status = isCompleted ? "Sent" : isNext ? "Next" : "Queued";
        return '<button type="button" data-scripted-turn="' + index + '" ' + disabled + '><span class="meta">' + status + ' | Turn ' + (index + 1) + '</span><br>' + escapeHtml(text) + '</button>';
      }).join("");
      const scriptedMetric = '<div class="metric"><span class="meta">Scripted Turns</span><strong>' + scriptedState.progressPct + '%</strong><span class="meta">' + scriptedState.matchedTurns + '/' + scriptedState.totalTurns + ' sent | ' + scriptedState.remainingTurns + ' remaining</span><span class="meta">' + escapeHtml(scriptedState.completed ? "complete" : scriptedState.nextTurnText || "queued") + '</span></div>';
      root.innerHTML = '<div class="grid"><div class="metric"><span class="meta">Flow</span><strong>' + escapeHtml(call.flowState) + '</strong></div><div class="metric"><span class="meta">Attention</span><strong>' + (call.attention.required ? "Required" : "Clear") + '</strong><span class="meta">' + escapeHtml(attentionDetail) + '</span></div><div class="metric"><span class="meta">Next</span><strong>' + escapeHtml(labels[call.actionState.nextRecommendedAction] || call.actionState.nextRecommendedAction.replace(/_/g, " ")) + '</strong></div>' + scriptedMetric + pendingHtml + '</div>' + liveProofHtml + evidenceHtml + '<div class="actions">' + actionHtml + '</div><div class="scripted-turns">' + scriptedTurns + '</div><form id="caller-turn-form"><input id="caller-turn" placeholder="Caller transcript turn"><button type="submit">Add Turn</button></form><div class="transcript">' + transcriptHtml + '</div><form id="note-form"><textarea id="note" placeholder="Operator note"></textarea><div><input id="disposition" placeholder="Disposition"><button type="submit">Add Note</button></div></form>';
      root.querySelectorAll("button[data-action]").forEach(function(button) { button.addEventListener("click", function() { const action = button.dataset.action; const metadata = callActionMetadata(call, action); const reason = metadata.reasonPrompt ? prompt(metadata.reasonPrompt) : undefined; if (metadata.requiresReason && !reason) return; const confirmed = metadata.confirmationRequired ? confirm((metadata.confirmationMessage || "Confirm " + (labels[action] || action.replace(/_/g, " "))) + "\\n\\nCall: " + call.session.callId) : false; if (metadata.confirmationRequired && !confirmed) return; postAction(action, reason, confirmed); }); });
      root.querySelectorAll("button[data-scripted-turn]").forEach(function(button) { button.addEventListener("click", function() { const index = Number(button.dataset.scriptedTurn); if (Number.isInteger(index)) postScriptedTurn(index).catch(function(error) { setStatus(error.message); }); }); });
      document.getElementById("caller-turn-form").addEventListener("submit", recordCallerTurn);
      document.getElementById("note-form").addEventListener("submit", recordNote);
    }
    function render() { renderCalls(); renderDetail(); }
    function scheduleRefresh() {
      if (state.refreshTimer) clearTimeout(state.refreshTimer);
      if (document.hidden) return;
      state.refreshTimer = setTimeout(function() { refresh({ auto: true }).catch(function(error) { setStatus(error.message); scheduleRefresh(); }); }, state.refreshIntervalMs || 5000);
    }
    document.addEventListener("visibilitychange", function() { if (document.hidden && state.refreshTimer) clearTimeout(state.refreshTimer); else refresh().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("start-demo").addEventListener("click", function() { startDemoCall().catch(function(error) { setStatus(error.message); }); });
    document.getElementById("refresh").addEventListener("click", function() { refresh().catch(function(error) { setStatus(error.message); }); });
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
    refresh().catch(function(error) { setStatus(error.message); });
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

function getOptionalEventString(value: string | number | boolean | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function buildLiveProofSummary(snapshot: CallSnapshot) {
  const labels = snapshot.session.runtimeModeLabels;
  const mediaCaptureEvent = getLatestEvent(snapshot, "media_capture_attached");
  const asrTranscriptEvent = getLatestEvent(snapshot, "rtc_asr_transcript");
  const asrBlockedEvent = getLatestEvent(snapshot, "rtc_asr_blocked");
  const endedEvent = getLatestEvent(snapshot, "sip_call_ended");
  const handoffEvent = getLatestEvent(snapshot, "human_handoff_started");
  const audioWavPath = getOptionalEventString(mediaCaptureEvent?.detail.audioWavPath);
  const sipLogPath = getOptionalEventString(mediaCaptureEvent?.detail.sipLogPath);
  const rtcAsrEvidencePath = getOptionalEventString(asrTranscriptEvent?.detail.evidencePath ?? asrBlockedEvent?.detail.evidencePath);
  const generatedMedia = mediaCaptureEvent?.detail.generatedMedia === true || labels.media === "generated_media";
  const hasLiveAudioCapture = Boolean(mediaCaptureEvent && labels.media === "live_capture" && !generatedMedia);
  const hasLiveTelephony = labels.telephony === "local_sip" || labels.telephony === "signalwire_live";
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
  const evalStatus = hasLiveTelephony && hasLiveAudioCapture && asrTranscriptEvent
    ? "ready_for_conversation_agent_evals"
    : hasLiveTelephony && hasLiveAudioCapture && asrBlockedEvent
      ? "ready_with_rtc_asr_blocker"
      : "not_review_ready";
  const caveats = [
    !hasLiveTelephony ? "Telephony is mocked; run a local SIP or SignalWire live call before review." : null,
    !hasLiveAudioCapture ? "No real caller WAV is attached yet." : null,
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
    ? "approve_offer"
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
            : "Review the held call context before applying operator guidance.",
      }
    : null;
  const totalScriptedCallerTurns: number = SCRIPTED_CALLER_TURNS.length;
  const matchedScriptedCallerTurns = Math.min(
    snapshot.pipecatFlow.script.matchedCallerTurns,
    totalScriptedCallerTurns,
  );
  const remainingScriptedCallerTurns = totalScriptedCallerTurns - matchedScriptedCallerTurns;
  const nextScriptedCallerTurn = SCRIPTED_CALLER_TURNS[matchedScriptedCallerTurns] ?? null;
  const remainingScriptedCallerTurnTexts = SCRIPTED_CALLER_TURNS.slice(matchedScriptedCallerTurns);
  const scriptProgressPct = totalScriptedCallerTurns === 0
    ? 100
    : Math.round((matchedScriptedCallerTurns / totalScriptedCallerTurns) * 100);
  const scriptProgressRoutes = buildScriptProgressRoutes(scriptProgressPct, nextScriptedCallerTurn === null);

  return {
    ...buildCallPayload(snapshot),
    liveProof: buildLiveProofSummary(snapshot),
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

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: PocConfig,
  ingress: InMemoryTelephonyIngress,
  signalWireCallMap: Map<string, string>,
  liveSipCallMap: Map<string, string>,
  realtimeShim: LocalRealtimeShimPrototype,
): Promise<void> {
  const url = request.url ?? "/";
  const requestUrl = new URL(url, "http://localhost");
  const pathname = requestUrl.pathname;

  if (request.method === "GET" && pathname === "/health") {
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
      pipecatFlow: getPipecatPrototypeHealth(),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/realtime-shim/proof") {
    writeJson(response, 200, buildRealtimeShimProofPayload());
    return;
  }

  if (request.method === "GET" && pathname === "/api/realtime-shim/readiness") {
    writeJson(response, 200, buildRealtimeShimReadinessPayload());
    return;
  }

  if (request.method === "POST" && pathname === "/api/realtime-shim/rpc") {
    const body = await readJsonBody<unknown>(request);
    const payload = buildRealtimeShimRpcResponse(realtimeShim, body) as { ok?: boolean };
    writeJson(response, payload.ok === false ? 400 : 200, payload);
    return;
  }

  if (request.method === "GET" && (pathname === "/operator" || pathname === "/operator/console")) {
    writeHtml(response, 200, buildOperatorConsoleHtml());
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
    if (!eventType || !["call.started", "media.capture", "media.transcript", "rtc_asr.blocked", "call.ended", "call.error"].includes(eventType)) {
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

    if (eventType === "call.started") {
      const telephonyMode = body.telephonyMode === "signalwire_live" ? "signalwire_live" : "local_sip";
      const snapshot = await ingress.startCall(config, {
        providerName: telephonyMode === "signalwire_live" ? "signalwire" : "freeswitch-local-sip",
        providerCallId: sipCallId,
        openclawSessionId: `live-sip-${sipCallId}`,
        openclawSessionLabel: `${telephonyMode}/${sipCallId}`,
        source: getOptionalTrimmedString(body.source) === "freeswitch_esl" ? "freeswitch_esl" : "local_sip_harness",
        runtimeModeLabels: {
          telephony: telephonyMode,
          media: "live_capture",
          rtcAsr: body.rtcAsrMode === "rtc_asr_live" ? "rtc_asr_live" : "rtc_asr_blocked",
          credentialsMode: telephonyMode === "signalwire_live" ? "signalwire_live" : "mocked",
        },
      });
      liveSipCallMap.set(sipCallId, snapshot.session.callId);
      writeJson(response, 201, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, call: buildCallPayload(snapshot) });
      return;
    }

    const callId = liveSipCallMap.get(sipCallId);
    if (!callId) {
      writeBadRequest(response, "live_sip_call_not_started");
      return;
    }

    try {
      if (eventType === "media.transcript") {
        const text = getOptionalTrimmedString(body.text) ?? getOptionalTrimmedString(body.transcript);
        if (!text) {
          writeBadRequest(response, "live_sip_transcript_text_required");
          return;
        }
        await ingress.appendCallerTurn(callId, { speaker: "caller", text, timestamp }, config);
        const snapshot = await ingress.recordLiveTelephonyEvidence(callId, {
          eventType: "rtc_asr_transcript",
          timestamp,
          detail: {
            provider: "rtc-asr",
            transcriptText: text,
            evidencePath: getOptionalTrimmedString(body.rtcAsrEvidencePath) ?? null,
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
      liveSipCallMap.delete(sipCallId);
      writeJson(response, 200, { ok: true, route: "/api/live-sip/events", eventType, sipCallId, call: buildCallPayload(snapshot) });
    } catch {
      writeNotFound(response);
    }
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
    } catch {
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
      const snapshot = await ingress.appendCallerTurn(callerTurnMatch[1], turn, config);
      writeJson(response, 200, buildCallPayload(snapshot));
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
  const realtimeShim = new LocalRealtimeShimPrototype();

  return createServer((request, response) => {
    void routeRequest(request, response, config, ingress, signalWireCallMap, liveSipCallMap, realtimeShim).catch((error: unknown) => {
      if (error instanceof InvalidJsonBodyError) {
        writeBadRequest(response, "invalid_json");
        return;
      }

      console.error(error);
      writeJson(response, 500, { ok: false, error: "internal_error" });
    });
  });
}
