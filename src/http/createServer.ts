import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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
import { InMemoryTelephonyIngress } from "../core/inMemoryTelephonyIngress";
import { LocalRealtimeShimPrototype } from "../core/localRealtimeShimPrototype";
import { getPipecatPrototypeHealth, SCRIPTED_CALLER_TURNS } from "../core/pipecatFlowPrototype";
import { REALTIME_SHIM_RPCS } from "../core/realtimeShimContract";
import {
  buildSpeechEnhancementCaptureReplayChecklist,
  buildSpeechEnhancementCaptureReplayNextStep,
  buildSpeechEnhancementCaptureReplayTemplate,
  buildSpeechEnhancementHealthSummary,
  buildSpeechEnhancementSourceManifestTemplate,
  buildSpeechEnhancementReviewGate,
  buildSpeechEnhancementRuntimeReadiness,
  buildSpeechEnhancementReviewHandoff,
  buildSpeechEnhancementSpikeReport,
  buildSpeechEnhancementStrictArtifactVerification,
  resolveSpeechEnhancementRuntimeConfig,
  resolveSpeechEnhancementCloseGateStatus,
  validateSpeechEnhancementCaptureReplayManifest,
} from "../core/speechEnhancementSpike";
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
const operatorConsoleWorkboardCard = "82771d3a-de4d-4b6e-869c-328e8264d01e";
const operatorConsoleIssue = "agonza1/agentic-contact-center#62";
function getBrowserWebrtcBridgeBaseUrl(): string {
  return process.env.BROWSER_WEBRTC_BRIDGE_URL ?? "http://127.0.0.1:8766";
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
  shim.appendAudio({ sessionId: interruptEnvelope.sessionId, audioBase64, timestamp: 96 });
  const bargeInRecoveryEvidence = shim.finalizeTurn({
    sessionId: interruptEnvelope.sessionId,
    transcriptText: "Continue with a human handoff instead.",
  });
  const bargeInRecoveryCloseEvidence = shim.closeSession({
    sessionId: interruptEnvelope.sessionId,
    reason: "complete",
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
      interruptionEvidence.qaChecklist.interruptionEvidence &&
      inputCancelEvidence.qaChecklist.inputCancelEvidence &&
      bargeInRecoveryEvidence.turnSummary.finalTranscript === "Continue with a human handoff instead." &&
      bargeInRecoveryEvidence.turnSummary.outputAudioChunks === 2 &&
      bargeInRecoveryCloseEvidence.state === "closed",
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
      evidence: "Barge-in emits relay clear evidence, the same session recovers into the next voice turn, closes cleanly after recovery, and input cancel drops buffered STT audio without dispatching a final transcript.",
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
    bargeInRecoveryEvidence,
    bargeInRecoveryCloseEvidence,
    inputCancelEvidence,
    errorEvidence,
    invalidAudioResult,
  };
}

function buildRealtimeShimRpcSmoke(): Array<{
  method: string;
  ok: boolean;
  requestId?: string | number;
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
      requestId: "rt-smoke-1",
      method: "talk.session.create",
      params: { mode: "realtime", transport: "gateway-relay", relaySessionId: "local-rt-rpc-smoke" },
    },
    {
      requestId: "rt-smoke-2",
      method: "talk.session.appendAudio",
      params: { sessionId: "local-rt-rpc-smoke", audioBase64, timestamp: 12 },
    },
    {
      requestId: "rt-smoke-3",
      method: "talk.session.finalizeTurn",
      params: { sessionId: "local-rt-rpc-smoke", transcriptText: "Need a retention credit." },
    },
    { requestId: "rt-smoke-4", method: "talk.session.getEvidence", params: { sessionId: "local-rt-rpc-smoke" } },
    {
      requestId: "rt-smoke-5",
      method: "talk.session.close",
      params: { sessionId: "local-rt-rpc-smoke", reason: "complete" },
    },
    {
      requestId: "rt-smoke-6",
      method: "talk.session.create",
      params: { mode: "realtime", transport: "gateway-relay", relaySessionId: "local-rt-rpc-cancel" },
    },
    {
      requestId: "rt-smoke-7",
      method: "talk.session.appendAudio",
      params: { sessionId: "local-rt-rpc-cancel", audioBase64, timestamp: 24 },
    },
    {
      requestId: "rt-smoke-8",
      method: "talk.session.finalizeTurn",
      params: { sessionId: "local-rt-rpc-cancel", transcriptText: "Please stop that response." },
    },
    {
      requestId: "rt-smoke-9",
      method: "talk.session.cancelOutput",
      params: { sessionId: "local-rt-rpc-cancel", reason: "barge-in" },
    },
    { requestId: "rt-smoke-10", method: "talk.session.cancelInput", params: { sessionId: "local-rt-rpc-cancel" } },
    {
      requestId: "rt-smoke-11",
      method: "talk.session.create",
      params: { mode: "realtime", transport: "gateway-relay", relaySessionId: "local-rt-rpc-tools" },
    },
    {
      requestId: "rt-smoke-12",
      method: "talk.session.submitToolResult",
      params: { sessionId: "local-rt-rpc-tools", toolCallId: "tool-review-1", result: { ok: true } },
    },
    {
      requestId: "rt-smoke-13",
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
    const requestId = isRecord(response) &&
      (typeof response.requestId === "string" || typeof response.requestId === "number")
      ? response.requestId
      : undefined;

    return {
      method: step.method,
      ok: isRecord(response) && response.ok === true,
      requestId,
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
    rpcSmoke: Array<{ ok: boolean; method: string; requestId?: string | number }>;
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
      sampleRateBridge: {
        browserInputSampleRateHz: number;
        localSttSampleRateHz: number;
        browserOutputSampleRateHz: number;
        resamplingRequired: boolean;
        boundary: string;
        evidence: string;
      };
      mockedPieces: string[];
      limitations: string[];
      pipelineStages: Array<{ stage: string; status: string; mocked: boolean; evidence: string }>;
    };
    closeEvidence: { state: string };
    interruptionEvidence: { qaChecklist: Record<string, boolean> };
    bargeInRecoveryEvidence: { turnSummary: { finalTranscript?: string; outputAudioChunks: number } };
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
    sampleRateBridge: proof.evidence.sampleRateBridge,
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
    liveSidecarPromotion: {
      status: "ready_for_sidecar_swap",
      order: ["rtc-asr", "local_llm", "kokoro_tts"],
      nextSwap: {
        sidecar: "rtc-asr",
        mockedStage: "local_stt",
        validationGate: "npm run proof:realtime-shim",
        rollbackSignal: "Revert to Local STT v1 deterministic messages if transcript.done, barge-in recovery, or bounded error evidence regresses.",
      },
      requiredSidecars: ["rtc-asr", "local_llm", "kokoro_tts"],
      contractToPreserve: {
        rpcBoundary: proof.rpcCompatibility.route,
        localSttContract: proof.localSttContract,
        browserRelayCompatibility: proof.evidence.browserRelayCompatibility.status,
      },
      firstValidationGate: "npm run proof:realtime-shim -- --out artifacts/realtime-shim-proof.json --latest-out artifacts/realtime-shim-proof-latest.json",
      rollbackSignal: "Keep mocked local proof green before replacing one sidecar at a time.",
    },
    sidecarAcceptanceGates: [
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
    ],
    reviewBlockers: proof.readyForIssue85Review ? [] : ["One or more Issue #85 acceptance criteria are not satisfied."],
    reviewPacket: {
      ready: proof.readyForIssue85Review,
      issue: proof.issue,
      issueUrl: "https://github.com/agonza1/agentic-contact-center/issues/85",
      primaryRoute: "/api/realtime-shim/proof",
      readinessRoute: "/api/realtime-shim/readiness",
      rpcRoute: proof.rpcCompatibility.route,
      validationCommands: ["npm test", "npm run pipecat:check", "npm run proof:realtime-shim"],
      probeCommands: [
        "curl -fsS http://127.0.0.1:8026/api/realtime-shim/proof",
        "curl -fsS http://127.0.0.1:8026/api/realtime-shim/readiness",
        "curl -fsS -X POST http://127.0.0.1:8026/api/realtime-shim/rpc -H 'content-type: application/json' --data '{\"method\":\"talk.session.getEvidence\",\"params\":{\"sessionId\":\"local-rt-review\"}}'",
      ],
      artifactOutputs: {
        defaultProof: "artifacts/realtime-shim-proof-<timestamp>.json",
        defaultLatest: "artifacts/realtime-shim-proof-latest.json",
        explicitProofCommand: "npm run proof:realtime-shim -- --out artifacts/realtime-shim-proof.json --latest-out artifacts/realtime-shim-proof-latest.json",
      },
      proofSignals: {
        readyForIssue85Review: proof.readyForIssue85Review,
        acceptanceCriteriaPassed: Object.values(proof.acceptanceSummary).filter(Boolean).length,
        acceptanceCriteriaTotal: Object.values(proof.acceptanceSummary).length,
        inProcessRpcSmokePassed: proof.rpcSmoke.filter((step) => step.ok).length,
        inProcessRpcSmokeTotal: proof.rpcSmoke.length,
        requestIdEchoed: proof.rpcSmoke.every((step, index) => step.requestId === `rt-smoke-${index + 1}`),
        oneTurnClosed: proof.closeEvidence.state === "closed",
        cancelAndErrorEvidence: {
          outputCancelled: proof.interruptionEvidence.qaChecklist.interruptionEvidence === true,
          inputCancelled: proof.inputCancelEvidence.qaChecklist.inputCancelEvidence === true,
          boundedErrors: proof.errorEvidence.qaChecklist.boundedErrorEvidence === true,
        },
        bargeInRecoveryReady:
          proof.bargeInRecoveryEvidence.turnSummary.finalTranscript === "Continue with a human handoff instead." &&
          proof.bargeInRecoveryEvidence.turnSummary.outputAudioChunks === 2,
        liveSidecarPromotionStatus: "ready_for_sidecar_swap",
        liveSidecarPromotionOrder: ["rtc-asr", "local_llm", "kokoro_tts"],
      },
      mockedPieces: proof.evidence.mockedPieces,
      limitations: proof.evidence.limitations,
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

function buildBrowserWebrtcReadinessPayload(): object {
  const realtimeReadiness = buildRealtimeShimReadinessPayload() as {
    adapter: { localSttContract: string };
    acceptanceCriteria: Array<{ name: string; passed: boolean; evidence: string }>;
    qaEvidenceRoutes: Array<{ route: string; method: string; evidence: string[] }>;
  };
  const contractReady = realtimeReadiness.acceptanceCriteria.every((criterion) => criterion.passed);
  const signalingRoute = "/api/browser-webrtc/session";
  const browserWebrtcBridgeBaseUrl = getBrowserWebrtcBridgeBaseUrl();
  const liveMediaVerified = false;

  return {
    ok: contractReady,
    route: "/api/browser-webrtc/readiness",
    issue: "agonza1/agentic-contact-center#213",
    issueUrl: "https://github.com/agonza1/agentic-contact-center/issues/213",
    status: contractReady ? "contract_ready_pending_live_media_evidence" : "realtime_contract_degraded",
    intendedPath: "browser microphone -> WebRTC -> Pipecat bridge -> rtc-asr Local STT v1 -> ACC call API -> Kokoro TTS -> WebRTC/browser playback",
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
        status: "signaling_ready",
        bridgeUrl: browserWebrtcBridgeBaseUrl,
        offerRoute: `${signalingRoute} -> ${browserWebrtcBridgeBaseUrl.replace(/\/$/, "")}/api/webrtc/offer`,
        evidence: "ACC validates browser SDP offers, preserves/allocates call IDs, and proxies signaling to the local Pipecat WebRTC bridge.",
        failClosedWhenUnavailable: true,
      },
      rtcAsr: {
        status: contractReady ? "contract_ready" : "contract_degraded",
        engine: "rtc-asr",
        contract: realtimeReadiness.adapter.localSttContract,
      },
      kokoro: {
        status: "contract_ready",
        engine: "kokoro",
      },
    },
    legacyChunkBridge: {
      status: "isolated_legacy",
      command: "npm run pipecat:voice",
      transport: "websocket_binary_webm_chunks",
      mediaRecorderRequired: true,
      ffmpegRequired: true,
      intendedForNormalBrowserVoice: false,
      note: "Retained only as legacy local proof plumbing; normal browser voice uses WebRTC signaling and does not fall back to this path.",
    },
    contract: {
      signalingRoute: `POST ${signalingRoute}`,
      readinessRoute: "/api/browser-webrtc/readiness",
      bridgeOfferRoute: `${browserWebrtcBridgeBaseUrl.replace(/\/$/, "")}/api/webrtc/offer`,
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
        tts: "Kokoro",
      },
    },
    liveMedia: {
      verified: liveMediaVerified,
      status: liveMediaVerified ? "verified" : "pending_local_bridge_proof",
      requiredProof: [
        "Pipecat WebRTC bridge started at BROWSER_WEBRTC_BRIDGE_URL",
        "rtc-asr Local STT v1 sidecar captured a final browser transcript",
        "Kokoro produced agent TTS audio",
        "browser received and played a remote WebRTC audio track",
      ],
      setupCommands: [
        "export BROWSER_WEBRTC_BRIDGE_URL=http://127.0.0.1:8766",
        "npm start",
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
        criterion: "readiness_distinguishes_acc_pipecat_webrtc_rtc_asr_kokoro",
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
        evidence: "Pending local proof that a browser microphone turn reached the Pipecat WebRTC bridge, rtc-asr emitted a final transcript, Kokoro produced TTS, and the browser played the remote WebRTC audio track.",
      },
    ],
    blockers: contractReady ? ["live_webrtc_media_turn_evidence_missing"] : ["realtime_shim_contract_degraded"],
    nextActions: [
      `Run the Pipecat WebRTC bridge at ${browserWebrtcBridgeBaseUrl} before connecting browser voice.`,
      "Open /operator/console, click Connect Voice, allow microphone access, and verify the remote WebRTC audio track plays agent audio.",
    ],
    validationCommands: ["npm test", "npm run browser-webrtc:check -- --url http://127.0.0.1:8026/health"],
    relatedEvidenceRoutes: [
      ...realtimeReadiness.qaEvidenceRoutes,
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

async function postBrowserWebrtcOfferToBridge(payload: object): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(buildBrowserWebrtcBridgeOfferUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
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
    readiness: buildBrowserWebrtcReadinessPayload(),
  };
}

function buildRealtimeShimRpcResponse(shim: LocalRealtimeShimPrototype, body: unknown): object {
  if (!isRecord(body)) {
    return buildRealtimeShimRpcContractError("json_object_required");
  }

  const requestId = getRealtimeShimRpcRequestId(body);
  const jsonRpcVersion = getRealtimeShimJsonRpcVersion(body);
  const method = getOptionalTrimmedString(body.method);
  const params = body.params === undefined ? {} : body.params;

  if (!method) {
    return buildRealtimeShimRpcContractError("realtime_shim_method_required", undefined, requestId, jsonRpcVersion);
  }

  if (!isRecord(params)) {
    return buildRealtimeShimRpcContractError("realtime_shim_params_object_required", method, requestId, jsonRpcVersion);
  }

  try {
    if (method === "talk.session.create") {
      const mode = getOptionalTrimmedString(params.mode) ?? "realtime";
      const transport = getOptionalTrimmedString(params.transport) ?? "gateway-relay";

      if (mode !== "realtime" || transport !== "gateway-relay") {
        return buildRealtimeShimRpcContractError("realtime_shim_session_shape_invalid", method, requestId, jsonRpcVersion);
      }

      return {
        ok: true,
        method,
        ...buildRealtimeShimRpcCorrelationPayload(requestId, jsonRpcVersion),
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
        ...buildRealtimeShimRpcCorrelationPayload(requestId, jsonRpcVersion),
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
        ...buildRealtimeShimRpcCorrelationPayload(requestId, jsonRpcVersion),
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
        ...buildRealtimeShimRpcCorrelationPayload(requestId, jsonRpcVersion),
        result: shim.getEvidence(getOptionalTrimmedString(params.sessionId) ?? ""),
      };
    }

    if (method === "talk.session.cancelOutput") {
      return {
        ok: true,
        method,
        ...buildRealtimeShimRpcCorrelationPayload(requestId, jsonRpcVersion),
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
        ...buildRealtimeShimRpcCorrelationPayload(requestId, jsonRpcVersion),
        result: shim.cancelInput({
          sessionId: getOptionalTrimmedString(params.sessionId) ?? "",
        }),
      };
    }

    if (method === "talk.session.recordError") {
      return {
        ok: true,
        method,
        ...buildRealtimeShimRpcCorrelationPayload(requestId, jsonRpcVersion),
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
        ...buildRealtimeShimRpcCorrelationPayload(requestId, jsonRpcVersion),
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
        ...buildRealtimeShimRpcCorrelationPayload(requestId, jsonRpcVersion),
        result: shim.closeSession({
          sessionId: getOptionalTrimmedString(params.sessionId) ?? "",
          reason: parseRealtimeShimCloseReason(params.reason),
        }),
      };
    }

    return buildRealtimeShimRpcContractError("realtime_shim_method_unsupported", method, requestId, jsonRpcVersion);
  } catch (error) {
    return {
      ok: false,
      error: "realtime_shim_rpc_error",
      method,
      ...buildRealtimeShimRpcCorrelationPayload(requestId, jsonRpcVersion),
      message: error instanceof Error ? error.message : "Realtime shim RPC failed",
      rpcCompatibility: buildRealtimeShimRpcCompatibility(),
    };
  }
}

function buildRealtimeShimRpcContractError(
  error: string,
  method?: string,
  requestId?: string | number,
  jsonRpcVersion?: "2.0",
): object {
  return {
    ok: false,
    error,
    method,
    ...buildRealtimeShimRpcCorrelationPayload(requestId, jsonRpcVersion),
    rpcCompatibility: buildRealtimeShimRpcCompatibility(),
  };
}

function getRealtimeShimRpcRequestId(body: Record<string, unknown>): string | number | undefined {
  const id = body.requestId ?? body.id;

  if (typeof id === "string") {
    const normalizedId = id.trim();
    return normalizedId ? normalizedId : undefined;
  }

  return typeof id === "number" && Number.isFinite(id) ? id : undefined;
}

function getRealtimeShimJsonRpcVersion(body: Record<string, unknown>): "2.0" | undefined {
  return body.jsonrpc === "2.0" ? "2.0" : undefined;
}

function buildRealtimeShimRpcCorrelationPayload(
  requestId: string | number | undefined,
  jsonRpcVersion: "2.0" | undefined,
): object {
  return {
    ...(jsonRpcVersion === undefined ? {} : { jsonrpc: jsonRpcVersion }),
    ...(requestId === undefined ? {} : { requestId, id: requestId }),
  };
}

function buildRealtimeShimRpcCompatibility(): object {
  return {
    route: "POST /api/realtime-shim/rpc",
    supportedRpcs: REALTIME_SHIM_RPCS,
    statefulSession: true,
    boundedErrors: true,
  };
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
    .nav-link { display: inline-flex; align-items: center; min-height: 36px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 6px; background: #fff; color: var(--text); font-size: 13px; font-weight: 700; text-decoration: none; }
    .nav-link:hover { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; box-shadow: var(--shadow); }
    .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--panel-soft); }
    .panel h2 { margin: 0; font-size: 14px; font-weight: 750; }
    .queue-count { color: var(--muted); font-size: 12px; font-weight: 700; }
    .filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); background: #fff; }
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
    .diagram { overflow: visible; }
    .diagram .section-title { font-size: 15px; }
    .demo-flow-svg { display: block; width: 100%; max-width: 980px; height: auto; min-height: 250px; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
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
    @media (max-width: 860px) { header, .toolbar { align-items: stretch; } header { position: static; flex-direction: column; } main { grid-template-columns: 1fr; padding: 12px; } .grid, .summary-grid, .filters { grid-template-columns: 1fr; } form { grid-template-columns: 1fr; } .filter-toggle { width: 100%; } .turn { max-width: 100%; } }
  </style>
</head>
<body>
  <header>
    <div class="brand"><span class="brand-kicker">Agentic Contact Center</span><h1>Operator Console</h1></div>
    <div class="toolbar"><a class="nav-link" href="/assert/full">Full ASSERT</a><a class="nav-link" href="/assert">ACC Artifacts</a><a class="nav-link" href="/assert/spec">Eval Spec</a><span class="status" id="status">Loading</span><button type="button" class="primary" id="run-demo-flow">Run Demo Flow</button><button type="button" id="start-demo">Start Empty Call</button><button type="button" id="refresh">Refresh</button></div>
  </header>
  <main>
    <section class="panel" aria-label="Live calls"><div class="panel-header"><h2>Live Calls</h2><span class="queue-count" id="queue-count">0 queued</span></div><div class="filters"><label class="filter-toggle"><input type="checkbox" id="attention-filter">Attention only</label><label class="filter-toggle"><input type="checkbox" id="latency-over-budget-filter">Over-budget latency</label><select id="flow-filter" aria-label="Flow state filter"><option value="">All flow states</option><option value="call_started">Call Started</option><option value="greet">Greet</option><option value="diagnose">Diagnose</option><option value="policy_hold">Policy Hold</option><option value="operator_steer">Operator Steer</option><option value="steered_response">Steered Response</option><option value="wrap">Wrap</option></select><select id="fallback-filter" aria-label="Fallback mode filter"><option value="">All fallback modes</option><option value="tool_timeout">Tool Timeout</option><option value="runtime_failure">Runtime Failure</option></select><select id="fallback-source-filter" aria-label="Fallback source filter"><option value="">All fallback sources</option><option value="tool_timeout_fail_closed">Tool Timeout Source</option><option value="pipecat_runtime_failure_fail_closed">Runtime Failure Source</option></select><input id="fallback-reason-filter" aria-label="Fallback reason filter" placeholder="Fallback reason"><select id="tool-filter" aria-label="Active tool filter"><option value="">All active tools</option><option value="get_current_slide">Get Current Slide</option><option value="goto_slide">Go To Slide</option><option value="pause_presentation">Pause Presentation</option><option value="ask_operator">Ask Operator</option></select><select id="script-completed-filter" aria-label="Script status filter"><option value="">All script states</option><option value="false">In progress</option><option value="true">Complete</option></select><select id="script-progress-filter" aria-label="Script minimum progress filter"><option value="">Any min progress</option><option value="25">25%+ scripted</option><option value="50">50%+ scripted</option><option value="75">75%+ scripted</option><option value="100">100% scripted</option></select><select id="script-max-progress-filter" aria-label="Script maximum progress filter"><option value="">Any max progress</option><option value="0">0% or less scripted</option><option value="25">25% or less scripted</option><option value="50">50% or less scripted</option><option value="75">75% or less scripted</option></select><input id="transcript-filter" placeholder="Transcript search"><button type="button" id="clear-filters">Clear</button></div><div class="call-list" id="calls"></div></section>
    <section class="panel" aria-label="Selected call"><div class="panel-header"><h2 id="selected-title">Select a call</h2><span class="queue-count">Supervisor workbench</span></div><div class="detail" id="detail"></div></section>
  </main>
  <script>
    const state = { calls: [], selectedCallId: null, actionMetadata: {}, refreshTimer: null, refreshIntervalMs: ${operatorConsoleRefreshIntervalMs}, voiceWs: null, voicePeer: null, voiceRemoteAudio: null, voiceBridgeEvidence: null, voiceSessionId: null, voiceConnecting: false, voiceRecording: null, voiceStream: null, voiceChunks: [], voiceCallId: null, voiceMuted: true, voiceProcessing: false, voiceSegmentMs: 9000, voiceStatus: "Voice disconnected", voiceBridgeTimer: null, voiceBridgeIntervalMs: 5000, voiceBridge: { status: "unknown", detail: "Not checked", checkedAt: null, probing: false }, transcriptCallId: null, transcriptScrollTop: 0, transcriptStickToBottom: true };
    const repoHeadEvidence = ${JSON.stringify(getRepoHeadEvidence())};
    const actions = ["pause", "resume", "approve_offer", "deny_offer", "takeover", "escalate_to_human", "transfer", "end_call", "goto_slide", "ask_operator", "arm_fallback", "disarm_fallback"];
    const liveProofStatuses = ["not_review_ready", "ready_with_rtc_asr_blocker", "ready_for_conversation_agent_evals"];
    const labels = { pause: "Pause", resume: "Resume", approve_offer: "Approve", deny_offer: "Deny", takeover: "Barge In", escalate_to_human: "Escalate", transfer: "Transfer", end_call: "End Call", goto_slide: "Go To Slide", ask_operator: "Ask Operator", arm_fallback: "Arm Fallback", disarm_fallback: "Disarm Fallback" };
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
      if (state.voiceBridge.status === "checking") return "badge";
      if (state.voiceBridge.status === "degraded") return "badge warn";
      if (state.voiceBridge.status === "offline") return "badge warn";
      return "badge";
    }
    function voiceBridgeStatusLabel() {
      if (state.voiceBridge.status === "running") return "WebRTC ready";
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
    async function probeVoiceBridge(options) {
      if (state.voiceBridge.probing) return;
      const now = Date.now();
      if (!(options && options.force) && state.voiceBridge.lastProbeAt && now - state.voiceBridge.lastProbeAt < 10000) return;
      state.voiceBridge.probing = true;
      state.voiceBridge.lastProbeAt = now;
      updateVoiceBridgeStatus("checking", "Checking " + browserWebrtcReadinessUrl());
      try {
        const response = await fetch(browserWebrtcReadinessUrl());
        const payload = await response.json();
        state.voiceBridge.probing = false;
        if (response.ok && payload.ok) {
          updateVoiceBridgeStatus("running", "Browser WebRTC path is ready (" + formatVoiceBridgeEngineEvidence(payload.readiness || {}) + ")");
          return;
        }
        updateVoiceBridgeStatus("degraded", formatVoiceBridgeReadyDetail(payload));
      } catch (error) {
        state.voiceBridge.probing = false;
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
      state.voiceSessionId = null;
      if (state.voiceStream) {
        state.voiceStream.getTracks().forEach(function(track) { track.stop(); });
        state.voiceStream = null;
      }
      state.voiceRecording = null;
      state.voiceChunks = [];
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
      const call = selectedCall();
      const bridge = state.voiceBridgeEvidence && state.voiceBridgeEvidence.bridge ? state.voiceBridgeEvidence.bridge : {};
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
      if (transcriptTurn && transcriptTurn.text) events.push({ type: "rtc-asr.transcript.final", engine: "rtc-asr", final: true, transcript: transcriptTurn.text, callId: state.voiceCallId });
      if (bridge && bridge.tts) events.push(Object.assign({ type: "kokoro.tts.audio", engine: "kokoro", callId: state.voiceCallId }, bridge.tts));
      const proof = {
        capturedAt: new Date().toISOString(),
        gitHead: repoHeadEvidence,
        captureSource: "operator-console/browser-webrtc",
        callId: state.voiceCallId,
        sessionId: state.voiceSessionId,
        evidence: state.voiceBridgeEvidence,
        events: events,
      };
      window.__ACC_BROWSER_WEBRTC_LIVE_PROOF__ = proof;
      return proof;
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
    async function connectPipecatVoice() {
      if (state.voicePeer && state.voicePeer.connectionState !== "closed") {
        state.voiceMuted = false;
        state.voiceStream && state.voiceStream.getAudioTracks().forEach(function(track) { track.enabled = true; });
        state.voiceStatus = "Browser WebRTC voice connected";
        setStatus(state.voiceStatus);
        render();
        return;
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
        pc.ontrack = function(event) {
          const remoteStream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
          state.voiceRemoteAudio.srcObject = remoteStream;
          state.voiceRemoteAudio.play().catch(function(error) { setStatus("Agent audio blocked: " + error.message); });
        };
        pc.onconnectionstatechange = function() {
          if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
            updateVoiceBridgeStatus("degraded", "WebRTC connection " + pc.connectionState);
          }
        };
        stream.getAudioTracks().forEach(function(track) { pc.addTrack(track, stream); });
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
        state.voiceSessionId = payload.sessionId;
        state.voiceCallId = payload.callId;
        state.selectedCallId = payload.callId;
        state.voiceConnecting = false;
        state.voiceMuted = false;
        state.voiceProcessing = false;
        state.voiceStatus = "Browser WebRTC voice connected";
        updateVoiceBridgeStatus("running", "Connected through Pipecat WebRTC bridge (" + formatVoiceBridgeEngineEvidence(payload.evidence || {}) + ")");
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
      const muteLabel = state.voiceMuted ? "Unmute Caller" : "Mute Caller";
      const bridgeDetail = state.voiceBridge.detail + (state.voiceBridge.checkedAt ? " | last check " + state.voiceBridge.checkedAt : "");
      return '<section class="section"><h3 class="section-title">Pipecat WebRTC Caller</h3><div class="actions"><button type="button" id="voice-connect">Connect Voice</button><button type="button" class="primary" id="voice-mute">' + muteLabel + '</button><button type="button" id="voice-copy-proof">Copy Proof</button></div><div class="actions"><span id="voice-bridge-status" class="' + voiceBridgeStatusClass() + '">' + escapeHtml(voiceBridgeStatusLabel()) + '</span><span class="status">' + escapeHtml(state.voiceStatus) + '</span></div><span class="meta" id="voice-bridge-detail">' + escapeHtml(bridgeDetail) + '</span><span class="meta">Target path: browser mic -> WebRTC -> Pipecat bridge -> rtc-asr Local STT v1 -> ACC call API -> Kokoro TTS -> WebRTC playback. This path intentionally does not require ffmpeg for normal operation.</span></section><section class="section diagram"><h3 class="section-title">Demo Flow</h3><svg class="demo-flow-svg" viewBox="0 0 980 360" role="img" aria-label="Caller audio flows through Pipecat, rtc-asr, the agent, Kokoro, operator controls, and ASSERT artifacts" preserveAspectRatio="xMidYMid meet"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#0969da"/></marker><style>.node{fill:#ffffff;stroke:#d0d7de;stroke-width:2}.primaryNode{fill:#ddf4ff;stroke:#0969da;stroke-width:2}.artifactNode{fill:#dafbe1;stroke:#1a7f37;stroke-width:2}.label{font:700 17px system-ui,sans-serif;fill:#24292f}.small{font:600 13px system-ui,sans-serif;fill:#57606a}.line{stroke:#0969da;stroke-width:3;fill:none;marker-end:url(#arrow)}.softLine{stroke:#57606a;stroke-width:2.5;stroke-dasharray:7 6;fill:none;marker-end:url(#arrow)}</style></defs><rect class="primaryNode" x="30" y="58" width="145" height="82" rx="10"/><text class="label" x="103" y="92" text-anchor="middle">Caller</text><text class="small" x="103" y="116" text-anchor="middle">browser mic</text><rect class="node" x="225" y="58" width="150" height="82" rx="10"/><text class="label" x="300" y="88" text-anchor="middle">Pipecat</text><text class="small" x="300" y="112" text-anchor="middle">WebRTC bridge</text><rect class="node" x="425" y="58" width="150" height="82" rx="10"/><text class="label" x="500" y="88" text-anchor="middle">rtc-asr</text><text class="small" x="500" y="112" text-anchor="middle">Local STT v1</text><rect class="primaryNode" x="625" y="58" width="150" height="82" rx="10"/><text class="label" x="700" y="88" text-anchor="middle">Agent</text><text class="small" x="700" y="112" text-anchor="middle">goal + memory</text><rect class="node" x="825" y="58" width="125" height="82" rx="10"/><text class="label" x="888" y="88" text-anchor="middle">Kokoro</text><text class="small" x="888" y="112" text-anchor="middle">TTS sidecar</text><rect class="artifactNode" x="515" y="225" width="170" height="82" rx="10"/><text class="label" x="600" y="255" text-anchor="middle">Artifacts</text><text class="small" x="600" y="279" text-anchor="middle">proof + transcript</text><rect class="artifactNode" x="742" y="225" width="178" height="82" rx="10"/><text class="label" x="831" y="255" text-anchor="middle">ASSERT</text><text class="small" x="831" y="279" text-anchor="middle">viewer + eval spec</text><rect class="node" x="210" y="225" width="180" height="82" rx="10"/><text class="label" x="300" y="255" text-anchor="middle">Operator</text><text class="small" x="300" y="279" text-anchor="middle">listen / steer</text><path class="line" d="M175 99 H225"/><path class="line" d="M375 99 H425"/><path class="line" d="M575 99 H625"/><path class="line" d="M775 99 H825"/><path class="line" d="M888 140 C888 178 816 178 775 140"/><path class="line" d="M700 140 V225"/><path class="line" d="M685 266 H742"/><path class="softLine" d="M390 266 C470 266 520 185 625 120"/></svg></section>';
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
      const actionHtml = actions.map(function(action) {
        const actionDetail = actionDetails[action] || {};
        const cssClass = action === "end_call" ? "danger" : action === "approve_offer" ? "primary" : "";
        const disabled = actionDetail.enabled === false || unavailable.has(action) ? "disabled" : "";
        const titleText = actionDetail.disabledReason || unavailableReasons[action];
        const title = titleText ? ' title="' + escapeHtml(titleText) + '"' : "";
        return '<button type="button" data-action="' + action + '" class="' + cssClass + '" ' + disabled + title + '>' + escapeHtml(labels[action] || action.replace(/_/g, " ")) + '</button>';
      }).join("");
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
      const runtimeModeText = [runtimeLabels.telephony, runtimeLabels.media, runtimeLabels.rtcAsr, runtimeLabels.credentialsMode].filter(Boolean).join(" | ") || "labels unavailable";
      const runtimeMetric = '<div class="metric compact"><span class="meta">Runtime Mode</span><strong>' + escapeHtml(runtimeModeText) + '</strong></div>';
      const caveatsHtml = (liveProof.caveats || []).length ? '<ul class="caveats">' + liveProof.caveats.map(function(caveat) { return '<li>' + escapeHtml(caveat) + '</li>'; }).join("") + '</ul>' : '<span class="meta">No caveats recorded for this run.</span>';
      const asrDetail = liveProof.asr && (liveProof.asr.latestTranscriptText || liveProof.asr.blocker || liveProof.asr.nextAction) ? (liveProof.asr.latestTranscriptText || liveProof.asr.blocker || liveProof.asr.nextAction) : "no ASR events yet";
      const liveProofHtml = '<section class="proof-panel" aria-label="Live SIP proof"><div class="proof-header"><h3>Live SIP proof</h3><div class="badges"><span class="' + badgeClass + '">' + escapeHtml(liveProof.eval ? liveProof.eval.status : "not_review_ready") + '</span>' + labelBadges + '</div></div><div class="proof-grid"><div class="metric"><span class="meta">Run / Session</span><strong>' + escapeHtml((liveProof.run && liveProof.run.sessionId) || call.session.openclawSession.sessionId) + '</strong><span class="meta">Call: ' + escapeHtml((liveProof.run && liveProof.run.callId) || call.session.callId) + '</span><span class="meta">Provider: ' + escapeHtml((liveProof.run && liveProof.run.providerCallId) || call.session.providerCallId) + '</span></div><div class="metric"><span class="meta">Audio Capture</span><strong>' + escapeHtml(humanLabel(liveProof.audioCapture && liveProof.audioCapture.status)) + '</strong>' + pathHtml(liveProof.audioCapture && liveProof.audioCapture.audioWavPath, "WAV") + pathHtml(liveProof.audioCapture && liveProof.audioCapture.sipLogPath, "SIP log") + linkHtml(liveProof.audioCapture && liveProof.audioCapture.eventTrail, "Capture Events") + '</div><div class="metric"><span class="meta">Transcript / ASR</span><strong>' + escapeHtml(humanLabel(liveProof.asr && liveProof.asr.status)) + '</strong><span class="meta">' + escapeHtml(asrDetail) + '</span>' + pathHtml(liveProof.asr && liveProof.asr.evidencePath, "ASR evidence") + linkHtml(liveProof.asr && liveProof.asr.eventTrail, "ASR Events") + '</div><div class="metric"><span class="meta">Artifacts / Eval</span><strong>' + escapeHtml(isLiveProofReady ? "Reviewable" : "Blocked") + '</strong>' + linkHtml(liveProof.eval && liveProof.eval.proofRoute, "Proof") + linkHtml(liveProof.eval && liveProof.eval.artifactManifestRoute, "Artifacts") + linkHtml(liveProof.eval && liveProof.eval.transcriptRoute, "Transcript") + '</div><div class="metric"><span class="meta">Handoff State</span><strong>' + escapeHtml(humanLabel(liveProof.operator && liveProof.operator.handoffState)) + '</strong><span class="meta">Attention: ' + escapeHtml(liveProof.operator && liveProof.operator.attentionRequired ? "required" : "clear") + '</span><span class="meta">Pending: ' + escapeHtml((liveProof.operator && liveProof.operator.pendingAction) || "none") + '</span></div></div>' + caveatsHtml + '</section>';
      const markers = call.controlMarkers || {};
      const markerHtml = '<section class="section"><h3 class="section-title">Live Control Markers</h3><div class="evidence"><div class="metric"><span class="meta">Live Call State</span><strong>' + escapeHtml(markers.liveCall && markers.liveCall.status || "unknown") + '</strong><span class="meta">' + escapeHtml(markers.liveCall && markers.liveCall.providerCallId || call.session.providerCallId) + '</span></div><div class="metric"><span class="meta">Flow State</span><strong>' + escapeHtml(markers.flowState && markers.flowState.current || call.flowState) + '</strong><span class="meta">Tool: ' + escapeHtml(markers.flowState && markers.flowState.activeTool || "none") + '</span></div><div class="metric"><span class="meta">Transcript</span><strong>' + escapeHtml(markers.transcript && markers.transcript.turnCount !== undefined ? markers.transcript.turnCount : call.transcript.length) + '</strong>' + linkHtml(markers.transcript && markers.transcript.route, "Transcript Trail") + '</div><div class="metric"><span class="meta">Pending Approval</span><strong>' + escapeHtml(markers.pendingApproval && markers.pendingApproval.active ? "pending" : "clear") + '</strong><span class="meta">' + escapeHtml(markers.pendingApproval && markers.pendingApproval.recommendedAction || "none") + '</span>' + linkHtml(markers.pendingApproval && markers.pendingApproval.trail, "Approval Trail") + '</div><div class="metric"><span class="meta">Hold</span><strong>' + escapeHtml(markers.hold && markers.hold.active ? "active" : "clear") + '</strong><span class="meta">' + escapeHtml(markers.hold && markers.hold.reason || "none") + '</span>' + linkHtml(markers.hold && markers.hold.trail, "Hold Trail") + '</div><div class="metric"><span class="meta">Evidence</span><strong>' + escapeHtml(markers.evidence && markers.evidence.latestEventType || "none") + '</strong>' + linkHtml(markers.evidence && markers.evidence.eventTrail, "Event Trail") + linkHtml(markers.evidence && markers.evidence.proofRoute, "Proof") + '</div></div></section>';
      const evidenceHtml = '<div class="evidence" aria-label="Evidence markers"><div class="metric"><span class="meta">Latest Event</span><strong>' + escapeHtml(evidence.latestEventType || "none") + '</strong><span class="meta">' + escapeHtml(evidence.latestEventAt || "not recorded") + '</span><a href="' + escapeHtml(latestEventLink) + '">Event Trail</a></div><div class="metric"><span class="meta">Transcript Turns</span><strong>' + evidence.transcriptTurns + '</strong><a href="' + escapeHtml(evidenceLinks.transcript) + '">Transcript</a></div><div class="metric"><span class="meta">Latency Marks</span><strong>' + evidence.latencyMarkCount + '</strong><span class="meta">Over budget: ' + evidence.overBudgetLatencyMarkCount + '</span><a href="' + escapeHtml(latencyLink) + '">Latency</a></div><div class="metric"><span class="meta">Fallback</span><strong>' + escapeHtml(fallbackLabel) + '</strong><span class="meta">' + escapeHtml(fallbackDetail) + '</span><a href="' + escapeHtml(fallbackTrailLink) + '">Event Trail</a><a href="' + escapeHtml(fallbackQueueLink) + '">Fallback Queue</a>' + reasonTrailHtml + '</div><div class="metric"><span class="meta">Operator Notes</span><strong>' + evidence.operatorNoteCount + '</strong><span class="meta">' + escapeHtml(evidence.latestDisposition || evidence.latestOperatorNoteText || "none") + '</span><a href="' + escapeHtml(operatorNoteTrailLink) + '">Note Trail</a></div><div class="metric"><span class="meta">Proof Bundle</span><strong>' + evidence.eventCount + '</strong><a href="' + escapeHtml(evidenceLinks.proof) + '">Proof</a><a href="' + escapeHtml(evidenceLinks.artifacts) + '">Artifacts</a></div></div>';
      const assertHtml = '<section class="proof-panel" aria-label="Assert UI"><div class="proof-header"><h3>Assert UI</h3><div class="badges"><a class="badge" href="/assert/full">Full ASSERT</a><a class="badge" href="/assert">ACC Artifacts</a><a class="badge" href="/assert/spec">Eval Spec</a><span class="badge ok">' + escapeHtml(call.flowState === "wrap" && call.pipecatFlow.script.completed ? "call complete" : "collecting evidence") + '</span><span class="badge">' + escapeHtml(call.pipecatFlow.prototypeMode) + '</span></div></div><div class="proof-grid"><div class="metric"><span class="meta">Call State</span><strong>' + escapeHtml(call.flowState) + '</strong><span class="meta">Script: ' + escapeHtml(call.pipecatFlow.script.completed ? "complete" : "in progress") + '</span><span class="meta">Attention: ' + escapeHtml(call.attention.required ? "required" : "clear") + '</span></div><div class="metric"><span class="meta">Evidence Counts</span><strong>' + evidence.eventCount + ' events</strong><span class="meta">' + evidence.transcriptTurns + ' transcript turns</span><span class="meta">' + evidence.latencyMarkCount + ' latency marks</span></div><div class="metric"><span class="meta">Artifacts</span><strong>' + escapeHtml(evidence.operatorNoteCount > 0 ? "Disposition captured" : "No disposition yet") + '</strong><a href="' + escapeHtml(evidenceLinks.proof) + '">Open Proof JSON</a><a href="' + escapeHtml(evidenceLinks.artifacts) + '">Open Artifact Manifest</a><a href="' + escapeHtml(evidenceLinks.transcript) + '">Open Transcript JSON</a></div><div class="metric"><span class="meta">Assert Inputs</span><strong>' + escapeHtml(liveProof.eval && liveProof.eval.status ? liveProof.eval.status : "local proof bundle") + '</strong><span class="meta">Use npm run assert:export to write official ASSERT viewer artifacts, then npm run assert:viewer to browse them.</span></div></div></section>';
      const scriptedState = call.actionState.scriptedCallerTurnState || { matchedTurns: 0, totalTurns: (state.scriptedCallerTurns || []).length, remainingTurns: (state.scriptedCallerTurns || []).length, progressPct: 0, nextTurnIndex: 0, nextTurnText: null, completed: false };
      const scriptedTurns = (state.scriptedCallerTurns || []).map(function(text, index) {
        const isCompleted = index < scriptedState.matchedTurns;
        const isNext = index === scriptedState.nextTurnIndex;
        const disabled = (isCompleted || !isNext) ? "disabled" : "";
        const status = isCompleted ? "Sent" : isNext ? "Next" : "Queued";
        return '<button type="button" data-scripted-turn="' + index + '" ' + disabled + '><span class="meta">' + status + ' | Turn ' + (index + 1) + '</span><br>' + escapeHtml(text) + '</button>';
      }).join("");
      const scriptedMetric = '<div class="metric"><span class="meta">Scripted Turns</span><strong>' + scriptedState.progressPct + '%</strong><span class="meta">' + scriptedState.matchedTurns + '/' + scriptedState.totalTurns + ' sent | ' + scriptedState.remainingTurns + ' remaining</span><span class="meta">' + escapeHtml(scriptedState.completed ? "complete" : scriptedState.nextTurnText || "queued") + '</span></div>';
      root.innerHTML = '<div class="summary-grid"><div class="metric compact"><span class="meta">Flow</span><strong>' + escapeHtml(call.flowState) + '</strong></div><div class="metric compact"><span class="meta">Attention</span><strong>' + (call.attention.required ? "Required" : "Clear") + '</strong><span class="meta">' + escapeHtml(attentionDetail) + '</span></div><div class="metric compact"><span class="meta">Next</span><strong>' + escapeHtml(labels[call.actionState.nextRecommendedAction] || call.actionState.nextRecommendedAction.replace(/_/g, " ")) + '</strong></div>' + runtimeMetric + scriptedMetric + pendingHtml + '</div><div class="workbench"><div class="stack">' + voiceControlsHtml() + '<section class="section"><h3 class="section-title">Operator Actions</h3><div class="actions">' + actionHtml + '</div></section><section class="section"><h3 class="section-title">Caller Script</h3><div class="scripted-turns">' + scriptedTurns + '</div><form id="caller-turn-form"><input id="caller-turn" placeholder="Caller transcript turn"><button type="submit">Add Turn</button></form></section><section class="section"><h3 class="section-title">Disposition</h3><form id="note-form"><textarea id="note" placeholder="Operator note"></textarea><div><input id="disposition" placeholder="Disposition"><button type="submit">Add Note</button></div></form></section></div><div class="stack">' + assertHtml + liveProofHtml + markerHtml + '<section class="section"><h3 class="section-title">Evidence markers</h3>' + evidenceHtml + '</section><section class="section"><h3 class="section-title">Transcript</h3><div class="transcript">' + transcriptHtml + '</div></section></div></div>';
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
      controls: ["pause", "resume", "approve_offer", "deny_offer", "takeover", "transfer", "end_call", "operator_note"],
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
  const started = await ingress.startCall(config, options);
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
  const scriptedTimestamps = [timestampAfter(1_000), timestampAfter(5_000), timestampAfter(9_000)];

  for (const [index, text] of SCRIPTED_CALLER_TURNS.slice(0, 3).entries()) {
    latest = await ingress.appendCallerTurn(
      callId,
      { speaker: "caller", text, timestamp: scriptedTimestamps[index] },
      config,
    );
    steps.push({
      step: `caller_turn_${index + 1}`,
      ok: true,
      flowState: latest.flowState,
      callId,
      detail: text,
    });
  }

  latest = await ingress.applyOperatorSteer(callId, "approve_offer", timestampAfter(11_000));
  steps.push({
    step: "operator_approve_offer",
    ok: true,
    flowState: latest.flowState,
    callId,
    detail: "Operator approved the safe retention response.",
  });

  latest = await ingress.appendCallerTurn(
    callId,
    { speaker: "caller", text: SCRIPTED_CALLER_TURNS[3], timestamp: timestampAfter(15_000) },
    config,
  );
  steps.push({
    step: "caller_wrap",
    ok: true,
    flowState: latest.flowState,
    callId,
    detail: SCRIPTED_CALLER_TURNS[3],
  });

  latest = await ingress.recordOperatorNote(
    callId,
    "Demo completed end to end: policy hold, operator approval, safe retention wrap, and proof bundle are available.",
    timestampAfter(16_000),
    "demo_completed",
  );
  steps.push({
    step: "operator_disposition",
    ok: true,
    flowState: latest.flowState,
    callId,
    detail: "Disposition recorded as demo_completed.",
  });

  return { latest, steps };
}

type ClueConOperatorDrillKind =
  | "scripted_approve"
  | "tool_timeout"
  | "runtime_failure"
  | "transfer"
  | "takeover"
  | "end_call";

function isClueConOperatorDrillKind(value: unknown): value is ClueConOperatorDrillKind {
  return (
    value === "scripted_approve" ||
    value === "tool_timeout" ||
    value === "runtime_failure" ||
    value === "transfer" ||
    value === "takeover" ||
    value === "end_call"
  );
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
      summary: "scripted_approve -> policy hold, operator approval, safe wrap, and proof bundle.",
      outcome: "scripted_wrap_complete",
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

  if (kind === "tool_timeout" || kind === "runtime_failure") {
    latest = await ingress.triggerFallback(callId, kind, timestampAfter(14_000), `${kind} ClueCon operator drill`);
    steps.push({
      step: "call_error_fail_closed",
      ok: true,
      flowState: latest.flowState,
      callId,
      detail: `${kind} produced a fail-closed human handoff.`,
    });
    return {
      latest,
      steps,
      summary: `${kind} -> fail-closed human handoff; no improvised offer.`,
      outcome: "fail_closed_handoff",
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
    summary: `${kind} -> operator cockpit applied bounded control and preserved evidence.`,
    outcome: `operator_${kind}`,
  };
}

function buildClueConEvalScorecard(snapshot: CallSnapshot) {
  const eventTypes = new Set(snapshot.events.map((event) => event.type));
  const transcriptText = snapshot.transcript.map((turn) => turn.text).join(" ").toLowerCase();
  const overBudgetLatencyMarks = snapshot.latencyMarks.filter((mark) => mark.budgetMs !== null && mark.elapsedMs > mark.budgetMs);
  const checks = [
    {
      id: "task_completion",
      label: "Task completion",
      passed: snapshot.flowState === "wrap" && eventTypes.has("operator_note_recorded"),
      evidence: `Call ${snapshot.session.callId} reached ${snapshot.flowState} with ${snapshot.transcript.length} transcript turns.`,
    },
    {
      id: "policy_hold",
      label: "Policy hold before risky offer",
      passed: eventTypes.has("operator_steer_requested") || eventTypes.has("policy_hold_entered"),
      evidence: "The run exposes the retention boundary before the offer is approved.",
    },
    {
      id: "operator_approval",
      label: "Operator approval captured",
      passed: eventTypes.has("operator_steer_applied") && snapshot.operatorSteer.lastAction === "approve_offer",
      evidence: snapshot.operatorSteer.lastReason ?? "approve_offer recorded in the event trail.",
    },
    {
      id: "final_state",
      label: "Safe final state",
      passed: transcriptText.includes("offer"),
      evidence: "Final transcript contains the seeded safe retention offer path.",
    },
    {
      id: "latency_evidence",
      label: "Latency evidence",
      passed: snapshot.latencyMarks.length > 0,
      evidence: `${snapshot.latencyMarks.length} latency marks captured; ${overBudgetLatencyMarks.length} over budget.`,
    },
    {
      id: "fallback_caveats",
      label: "ASR/TTS caveats visible",
      passed: snapshot.pipecatFlow.credentialsMode === "mocked" && snapshot.scenario.mode === "mocked_telephony",
      evidence: "The proof labels local mocked telephony and keeps live sidecar caveats outside fake success.",
    },
  ];

  return {
    workboardCard: clueConProofEvalCard,
    overallPassed: checks.every((check) => check.passed),
    passed: checks.filter((check) => check.passed).length,
    total: checks.length,
    checks,
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
    evidenceArtifacts: ["transcript", "action_trace", "final_state", "proof_bundle", "latency_marks", "asr_tts_caveats"],
    caveat: "Preview names the ASSERT handoff contract; POST /api/cluecon/eval/run creates a fresh scripted proof and scorecard.",
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
    const pipecatFlow = getPipecatPrototypeHealth();
    const browserWebRtc = buildBrowserWebrtcReadinessPayload();
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
      speechEnhancement: buildSpeechEnhancementHealthSummary(),
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

  if (request.method === "GET" && pathname === "/api/browser-webrtc/readiness") {
    writeJson(response, 200, buildBrowserWebrtcReadinessPayload());
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
      const answerSdp = getOptionalTrimmedString(bridgeResponse.payload.sdp);
      if (!bridgeResponse.status.toString().startsWith("2") || answerType !== "answer" || !answerSdp) {
        writeJson(response, 502, {
          ok: false,
          error: "pipecat_webrtc_bridge_offer_failed",
          bridgeStatus: bridgeResponse.status,
          bridgeOfferRoute: buildBrowserWebrtcBridgeOfferUrl(),
          bridge: bridgeResponse.payload,
        });
        return;
      }

      writeJson(response, 201, {
        ok: true,
        route: "/api/browser-webrtc/session",
        sessionId,
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
        },
      });
    } catch (error) {
      writeJson(response, 503, buildBrowserWebrtcBridgeUnavailablePayload(error));
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/realtime-shim/speech-enhancement-spike/capture-template") {
    const template = buildSpeechEnhancementCaptureReplayTemplate();
    const includeContract = ["1", "true"].includes(
      (requestUrl.searchParams.get("includeContract") ?? "").toLowerCase(),
    );

    if (!includeContract) {
      writeJson(response, 200, template);
      return;
    }

    const report = buildSpeechEnhancementSpikeReport();
    const handoff = buildSpeechEnhancementReviewHandoff();
    writeJson(response, 200, {
      template,
      sourceManifestTemplate: buildSpeechEnhancementSourceManifestTemplate(),
      contract: report.captureReplayContract,
      validation: {
        command: handoff.strictValidationCommand,
        route: handoff.captureReplayValidationRoute,
      },
      captureReplayChecklist: buildSpeechEnhancementCaptureReplayChecklist(),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/realtime-shim/speech-enhancement-spike/capture-replay/checklist") {
    const report = buildSpeechEnhancementSpikeReport();

    writeJson(response, 200, {
      ok: true,
      route: "/api/realtime-shim/speech-enhancement-spike/capture-replay/checklist",
      issue: "agonza1/agentic-contact-center#97",
      captureReplayChecklist: buildSpeechEnhancementCaptureReplayChecklist(),
      closeGateProfile: report.closeGateProfile,
      captureReplayContract: report.captureReplayContract,
      handoff: buildSpeechEnhancementReviewHandoff(),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/realtime-shim/speech-enhancement-spike/capture-replay/close-gate") {
    const report = buildSpeechEnhancementSpikeReport();
    const runtimeConfig = resolveSpeechEnhancementRuntimeConfig({
      featureFlag: process.env.RTC_ASR_SPEECH_ENHANCEMENT,
      latencyMs: process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS,
    });

    const reviewGate = buildSpeechEnhancementReviewGate(report);

    writeJson(response, 200, {
      ok: true,
      route: "/api/realtime-shim/speech-enhancement-spike/capture-replay/close-gate",
      issue: "agonza1/agentic-contact-center#97",
      closeGateStatus: resolveSpeechEnhancementCloseGateStatus(reviewGate),
      reviewGate,
      runtimeReadiness: buildSpeechEnhancementRuntimeReadiness(runtimeConfig, report),
      strictArtifactVerification: buildSpeechEnhancementStrictArtifactVerification(),
      handoff: buildSpeechEnhancementReviewHandoff(),
      captureReplayChecklist: buildSpeechEnhancementCaptureReplayChecklist(),
      nextChecklistStep: buildSpeechEnhancementCaptureReplayNextStep(reviewGate),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/realtime-shim/speech-enhancement-spike/capture-replay/validate") {
    const body = await readJsonBody<unknown>(request);
    const validation = validateSpeechEnhancementCaptureReplayManifest(body);

    if (!validation.manifestOk || !validation.metric) {
      const report = buildSpeechEnhancementSpikeReport();
      const reviewGate = buildSpeechEnhancementReviewGate(report);
      const strictArtifactVerification = buildSpeechEnhancementStrictArtifactVerification();

      writeJson(response, 400, {
        ok: false,
        route: "/api/realtime-shim/speech-enhancement-spike/capture-replay/validate",
        validation,
        closeGateStatus: resolveSpeechEnhancementCloseGateStatus(reviewGate, strictArtifactVerification),
        reviewGate,
        strictArtifactVerification,
        nextChecklistStep: buildSpeechEnhancementCaptureReplayNextStep(reviewGate),
      });
      return;
    }

    const report = buildSpeechEnhancementSpikeReport({ captureReplayMetrics: [validation.metric] });
    const runtimeConfig = resolveSpeechEnhancementRuntimeConfig({
      featureFlag: process.env.RTC_ASR_SPEECH_ENHANCEMENT,
      latencyMs: process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS,
    });
    const reviewGate = buildSpeechEnhancementReviewGate(report);

    writeJson(response, 200, {
      ok: true,
      route: "/api/realtime-shim/speech-enhancement-spike/capture-replay/validate",
      validation,
      reviewGate,
      handoff: buildSpeechEnhancementReviewHandoff(),
      runtimeReadiness: buildSpeechEnhancementRuntimeReadiness(runtimeConfig, report),
      captureReplayChecklist: buildSpeechEnhancementCaptureReplayChecklist(),
      closeGateStatus: resolveSpeechEnhancementCloseGateStatus(
        reviewGate,
        buildSpeechEnhancementStrictArtifactVerification([{ strictArtifactsVerified: false }]),
      ),
      nextChecklistStep: buildSpeechEnhancementCaptureReplayNextStep(reviewGate),
      strictArtifactVerification: buildSpeechEnhancementStrictArtifactVerification([
        { strictArtifactsVerified: false },
      ]),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/realtime-shim/speech-enhancement-spike") {
    const report = buildSpeechEnhancementSpikeReport();
    const runtimeConfig = resolveSpeechEnhancementRuntimeConfig({
      featureFlag: process.env.RTC_ASR_SPEECH_ENHANCEMENT,
      latencyMs: process.env.RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS,
    });
    const reviewGate = buildSpeechEnhancementReviewGate(report);
    const strictArtifactVerification = buildSpeechEnhancementStrictArtifactVerification();

    writeJson(response, 200, {
      ...report,
      runtimeConfig,
      runtimeReadiness: buildSpeechEnhancementRuntimeReadiness(runtimeConfig, report),
      closeGateStatus: resolveSpeechEnhancementCloseGateStatus(reviewGate, strictArtifactVerification),
      reviewGate,
      reviewHandoff: buildSpeechEnhancementReviewHandoff(),
      captureReplayChecklist: buildSpeechEnhancementCaptureReplayChecklist(),
      nextChecklistStep: buildSpeechEnhancementCaptureReplayNextStep(reviewGate),
      strictArtifactVerification,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/realtime-shim/rpc") {
    const body = await readJsonBody<unknown>(request);
    const payload = buildRealtimeShimRpcResponse(realtimeShim, body) as { ok?: boolean };
    writeJson(response, payload.ok === false ? 400 : 200, payload);
    return;
  }

  if (request.method === "GET" && pathname === "/api/cluecon") {
    writeJson(response, 200, await buildClueConPayloadWithLiveProbes(config, {}, activeClueConBrainBlocks));
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
        ? "ClueCon scripted run passed the local ASSERT-style scorecard."
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

  if (request.method === "GET" && pathname === "/cluecon") {
    writeHtml(response, 200, buildClueConHtml(config, "scroll", activeClueConBrainBlocks));
    return;
  }

  if (request.method === "GET" && pathname === "/cluecon/present") {
    writeHtml(response, 200, buildClueConHtml(config, "present", activeClueConBrainBlocks));
    return;
  }

  if (request.method === "GET" && (pathname === "/" || pathname === "/operator" || pathname === "/operator/console")) {
    writeHtml(response, 200, buildOperatorConsoleHtml());
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

    const conversationMode = body.conversationMode;
    if (
      conversationMode !== undefined &&
      conversationMode !== "scripted" &&
      conversationMode !== "free_caller"
    ) {
      writeBadRequest(response, "caller_turn_conversation_mode_invalid");
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
      const snapshot = await ingress.appendCallerTurn(callerTurnMatch[1], turn, config, {
        conversationMode,
      });
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
