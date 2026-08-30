#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const repoRoot = process.cwd();

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readEnvManifest(relativePath) {
  const manifestPath = path.join(repoRoot, relativePath);
  if (!existsSync(manifestPath)) return { exists: false, path: relativePath, values: {} };

  const values = {};
  for (const line of readText(relativePath).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return { exists: true, path: relativePath, values };
}

function composeProfiles(composeText) {
  const profiles = new Set();
  for (const match of composeText.matchAll(/profiles:\s*\[([^\]]+)\]/g)) {
    for (const value of match[1].split(",")) {
      const normalized = value.trim().replace(/^["']|["']$/g, "");
      if (normalized) profiles.add(normalized);
    }
  }
  return [...profiles].sort();
}

const packageJson = readJson("package.json");
const compose = readText("docker-compose.yml");
const scripts = packageJson.scripts ?? {};
const profiles = composeProfiles(compose);
const stackManifest = readEnvManifest("stack/versions.env");

const requiredScripts = [
  "proof",
  "browser-webrtc:check",
  "browser-webrtc:live-proof",
  "pipecat:verto:live-proof",
  "cae:assert:handoff",
  "docs:validate",
];

const requiredProfiles = ["voice", "browser-webrtc", "reliability-lab", "sip-verto", "eval", "full"];
const missingScripts = requiredScripts.filter((script) => !scripts[script]);
const missingProfiles = requiredProfiles.filter((profile) => !profiles.includes(profile));
const requiredStackManifestKeys = [
  "ACC_APP_IMAGE",
  "ACC_APP_URL",
  "RTC_ASR_IMAGE",
  "RTC_ASR_BASE_URL",
  "KOKORO_IMAGE",
  "KOKORO_BASE_URL",
  "BROWSER_WEBRTC_BRIDGE_URL",
  "PIPECAT_BROWSER_BRIDGE_URL",
  "FREESWITCH_IMAGE",
  "FREESWITCH_VERTO_URL",
  "TOOLHIVE_VERSION",
  "CAE_API_URL",
  "CAE_WEB_URL",
  "ASSERT_VIEWER_URL",
];
const missingStackManifestKeys = requiredStackManifestKeys.filter((key) => !(key in stackManifest.values));
const optionalEndpointEnvVars = [
  "ACC_RELIABILITY_TARGET_MODE",
  "CAE_API_URL",
  "CAE_WEB_URL",
  "ASSERT_VIEWER_URL",
  "RTC_ASR_BASE_URL",
  "KOKORO_BASE_URL",
  "BROWSER_WEBRTC_BRIDGE_URL",
  "FREESWITCH_VERTO_URL",
];
const signalwirePstnCommonEnvVars = [
  "SIGNALWIRE_FROM_NUMBER",
  "FREESWITCH_PUBLIC_SIP_HOST",
  "SIGNALWIRE_SOURCE_IP_PROBE",
  "SIGNALWIRE_PROVIDER_INGRESS_CIDRS",
  "SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH",
];
const signalwirePstnRegistrationEnvVars = [
  "SIGNALWIRE_SPACE_URL",
  "SIGNALWIRE_SIP_USERNAME",
  "SIGNALWIRE_SIP_PASSWORD",
];
const readinessVocabulary = [
  "blocked",
  "configured",
  "degraded",
  "fixture",
  "missing",
  "not_configured",
  "not_required",
  "reachable",
  "ready",
  "unreachable",
];
const evidenceLevelVocabulary = [
  "Caller-audible live proof",
  "Deterministic proof bundle",
  "Honest ready/unreachable/blocked/not-required report",
  "Live local media proof",
  "Local media/evidence stack",
  "Redacted FreeSWITCH gateway/reachability proof",
];
const evidenceFreshnessBudgetMs = 24 * 60 * 60 * 1000;

const optionalEndpoints = {
  caeApi: process.env.CAE_API_URL ?? null,
  caeWeb: process.env.CAE_WEB_URL ?? null,
  assertViewer: process.env.ASSERT_VIEWER_URL ?? "http://127.0.0.1:5174",
  rtcAsr: process.env.RTC_ASR_BASE_URL ?? "http://127.0.0.1:8080",
  kokoro: process.env.KOKORO_BASE_URL ?? "http://127.0.0.1:8880",
  browserWebRtcBridge: process.env.BROWSER_WEBRTC_BRIDGE_URL ?? "http://127.0.0.1:8766",
  freeswitchVerto: process.env.FREESWITCH_VERTO_URL ?? "ws://127.0.0.1:8081",
};

const requestedTargetMode = process.env.ACC_RELIABILITY_TARGET_MODE?.trim() || "fixture";
const signalwireTrunkMode = (process.env.SIGNALWIRE_TRUNK_MODE?.trim() || "registration").toLowerCase().replace(/-/g, "_");
const requiredSignalwirePstnEnvVars = signalwireTrunkMode === "ip_auth"
  ? signalwirePstnCommonEnvVars
  : [...signalwirePstnCommonEnvVars, ...signalwirePstnRegistrationEnvVars];
const missingSignalwirePstnEnvVars = requiredSignalwirePstnEnvVars.filter((name) => !envConfigured(name));

function redactedConfiguredEndpoint(value) {
  try {
    const url = new URL(value);
    const port = url.port ? `:${url.port}` : "";
    return `${url.protocol}//${url.hostname}${port}`;
  } catch {
    return "[configured]";
  }
}

function redactedProbe(probe) {
  if (!probe) return probe;
  const redacted = { ...probe };
  if (typeof redacted.detail === "string") {
    redacted.detail = redacted.detail.replace(/(?:https?|wss?):\/\/[^\s.]+(?:\.[^\s.]+)*(?::\d+)?(?:\/[^\s]*)?/gi, (url) =>
      redactedConfiguredEndpoint(url),
    );
  }
  return redacted;
}

function envConfigured(name) {
  return Boolean(process.env[name]?.trim());
}

const caeConfigured = Boolean(optionalEndpoints.caeApi && optionalEndpoints.caeWeb);
const liveEndpointConfigured = {
  assertViewer: envConfigured("ASSERT_VIEWER_URL"),
  rtcAsr: envConfigured("RTC_ASR_BASE_URL"),
  kokoro: envConfigured("KOKORO_BASE_URL"),
  browserWebRtcBridge: envConfigured("BROWSER_WEBRTC_BRIDGE_URL"),
  freeswitchVerto: envConfigured("FREESWITCH_VERTO_URL"),
};

const probeTimeoutMs = Number.parseInt(process.env.ACC_RELIABILITY_LAB_PROBE_TIMEOUT_MS ?? "750", 10);
const boundedProbeTimeoutMs = Number.isFinite(probeTimeoutMs) && probeTimeoutMs > 0 ? Math.min(probeTimeoutMs, 5000) : 750;
const readinessProbePolicy = {
  timeoutEnvVar: "ACC_RELIABILITY_LAB_PROBE_TIMEOUT_MS",
  defaultTimeoutMs: 750,
  maxTimeoutMs: 5000,
  timeoutMs: boundedProbeTimeoutMs,
  probesConfiguredEndpoints: true,
  skippedWhenEnvMissing: true,
  transports: ["http_get", "tcp_connect"],
  routeOverrides: {
    rtcAsr: "/ready",
    kokoro: "/health",
    browserWebRtcBridge: "/health",
  },
};

async function probeHttp(url, route = "/") {
  let target;
  try {
    target = new URL(url);
  } catch {
    return {
      reachable: false,
      ready: false,
      status: "unreachable",
      error: "InvalidURL",
      detail: "Probe endpoint URL is invalid.",
    };
  }
  if (target.pathname === "/" && route !== "/") target.pathname = route;
  const safeTarget = redactedConfiguredEndpoint(target.toString());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), boundedProbeTimeoutMs);
  try {
    const response = await fetch(target, { method: "GET", signal: controller.signal });
    return {
      reachable: true,
      ready: response.ok,
      status: response.ok ? "ready" : "unreachable",
      statusCode: response.status,
      detail: response.ok ? `Reachable at ${safeTarget}.` : `Probe returned HTTP ${response.status} from ${safeTarget}.`,
    };
  } catch (error) {
    return {
      reachable: false,
      ready: false,
      status: "unreachable",
      error: error instanceof Error ? error.name : "probe_error",
      detail: `Probe could not reach ${safeTarget}.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeTcp(url) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return {
      reachable: false,
      ready: false,
      status: "unreachable",
      error: "InvalidURL",
      detail: "TCP probe endpoint URL is invalid.",
    };
  }
  const port = target.port ? Number.parseInt(target.port, 10) : target.protocol === "wss:" ? 443 : 80;
  return await new Promise((resolve) => {
    const socket = net.connect({ host: target.hostname, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(boundedProbeTimeoutMs);
    socket.once("connect", () =>
      finish({
        reachable: true,
        ready: true,
        status: "ready",
        detail: `TCP endpoint is reachable at ${target.host}.`,
      }),
    );
    socket.once("timeout", () =>
      finish({
        reachable: false,
        ready: false,
        status: "unreachable",
        error: "TimeoutError",
        detail: `TCP probe timed out for ${target.host}.`,
      }),
    );
    socket.once("error", (error) =>
      finish({
        reachable: false,
        ready: false,
        status: "unreachable",
        error: error.code ?? "probe_error",
        detail: `TCP probe could not reach ${target.host}.`,
      }),
    );
  });
}

async function probeConfiguredEndpoints() {
  const probes = {};
  if (optionalEndpoints.caeApi) probes.caeApi = await probeHttp(optionalEndpoints.caeApi);
  if (optionalEndpoints.caeWeb) probes.caeWeb = await probeHttp(optionalEndpoints.caeWeb);
  if (liveEndpointConfigured.assertViewer) probes.assertViewer = await probeHttp(optionalEndpoints.assertViewer);
  if (liveEndpointConfigured.rtcAsr) probes.rtcAsr = await probeHttp(optionalEndpoints.rtcAsr, "/ready");
  if (liveEndpointConfigured.kokoro) probes.kokoro = await probeHttp(optionalEndpoints.kokoro, "/health");
  if (liveEndpointConfigured.browserWebRtcBridge) probes.browserWebRtcBridge = await probeHttp(optionalEndpoints.browserWebRtcBridge, "/health");
  if (liveEndpointConfigured.freeswitchVerto) probes.freeswitchVerto = await probeTcp(optionalEndpoints.freeswitchVerto);
  return probes;
}

const endpointProbes = await probeConfiguredEndpoints();
const redactedOptionalEndpoints = Object.fromEntries(
  Object.entries(optionalEndpoints).map(([key, value]) => [key, value ? redactedConfiguredEndpoint(value) : null]),
);
const redactedEndpointProbes = Object.fromEntries(
  Object.entries(endpointProbes).map(([key, value]) => [key, redactedProbe(value)]),
);
const endpointReady = {
  caeApi: endpointProbes.caeApi?.ready === true,
  caeWeb: endpointProbes.caeWeb?.ready === true,
  assertViewer: !liveEndpointConfigured.assertViewer || endpointProbes.assertViewer?.ready === true,
  rtcAsr: !liveEndpointConfigured.rtcAsr || endpointProbes.rtcAsr?.ready === true,
  kokoro: !liveEndpointConfigured.kokoro || endpointProbes.kokoro?.ready === true,
  browserWebRtcBridge:
    !liveEndpointConfigured.browserWebRtcBridge || endpointProbes.browserWebRtcBridge?.ready === true,
  freeswitchVerto: !liveEndpointConfigured.freeswitchVerto || endpointProbes.freeswitchVerto?.ready === true,
};

const goldenComparison = [
  {
    signal: "Cancellation intent",
    unsafeBaseline: "detected",
    controlledCandidate: "detected",
    evidence: "transcript",
    evidenceRefs: ["/api/calls/{callId}/transcript", "artifacts/demo-proof-latest.json"],
  },
  {
    signal: "Policy hold",
    unsafeBaseline: "missing",
    controlledCandidate: "present",
    evidence: "event_trace",
    evidenceRefs: ["/api/calls/{callId}/events?detailKey=policyHold", "artifacts/demo-proof-latest.json"],
  },
  {
    signal: "Unapproved offer",
    unsafeBaseline: "emitted",
    controlledCandidate: "absent",
    evidence: "assert_requirement",
    evidenceRefs: [
      "artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json",
      "artifacts/demo-proof-latest.json",
    ],
  },
  {
    signal: "Tool/runtime failure",
    unsafeBaseline: "autonomous_continuation",
    controlledCandidate: "fail_closed_handoff",
    evidence: "operator_steer",
    evidenceRefs: ["/api/queue?attentionRequired=true", "/api/calls/{callId}/events?detailKey=fallback"],
  },
  {
    signal: "Final disposition",
    unsafeBaseline: "ambiguous",
    controlledCandidate: "recorded",
    evidence: "final_state",
    evidenceRefs: ["/api/calls/{callId}", "artifacts/demo-proof-latest.json"],
  },
  {
    signal: "Overall release gate",
    unsafeBaseline: "block",
    controlledCandidate: "candidate_passes",
    evidence: "cae_assert_report",
    evidenceRefs: [
      "artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json",
      "ConversationAgentEvals report link",
    ],
  },
];

const verdictEvidenceChecklist = [
  {
    id: "transcript",
    label: "Transcript",
    route: "/api/calls/{callId}/transcript",
    requiredFor: ["fixture", "browser_webrtc", "reliability_lab", "sip_verto", "signalwire_pstn"],
    validates: ["cancellation_intent_detected", "caller_agent_turn_sequence"],
  },
  {
    id: "event_trace",
    label: "Event trace",
    route: "/api/calls/{callId}/events",
    requiredFor: ["fixture", "browser_webrtc", "reliability_lab", "sip_verto", "signalwire_pstn"],
    validates: ["policy_hold_present", "operator_steer_preserved", "fallback_handoff_recorded"],
  },
  {
    id: "latency",
    label: "Latency marks",
    route: "/api/calls/{callId}/latency",
    requiredFor: ["fixture", "browser_webrtc", "reliability_lab", "sip_verto", "signalwire_pstn"],
    validates: ["turn_timing_reviewable", "over_budget_marks_reviewable"],
  },
  {
    id: "final_state",
    label: "Final state",
    route: "/api/calls/{callId}",
    requiredFor: ["fixture", "browser_webrtc", "reliability_lab", "sip_verto", "signalwire_pstn"],
    validates: ["final_disposition_recorded", "release_gate_verdict_grounded"],
  },
  {
    id: "media",
    label: "Media proof",
    route: "artifacts/browser-webrtc-live-proof/browser-webrtc-live-proof-manifest.json",
    requiredFor: ["browser_webrtc", "sip_verto", "signalwire_pstn"],
    validates: ["live_media_not_claimed_by_fixture", "caller_audible_playback_reviewable"],
  },
  {
    id: "provenance",
    label: "Run provenance",
    route: "artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json",
    requiredFor: ["fixture", "browser_webrtc", "reliability_lab", "sip_verto", "signalwire_pstn"],
    validates: ["target_mode_recorded", "candidate_profile_recorded", "component_versions_recorded"],
  },
];

const provenanceContract = {
  manifestPath: "stack/versions.env",
  versionSource: "repositoryContracts.stackManifest.values",
  requiredRunFields: [
    "runtimeMode",
    "targetMode",
    "candidateProfile",
    "promptVersion",
    "model",
    "seed",
    "componentVersions",
    "evidenceArtifacts",
  ],
  evidenceArtifacts: [
    "artifacts/demo-proof-latest.json",
    "artifacts/agentic-call-center-demo/conversation-agent-evals-assert-request.json",
    "artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json",
  ],
  detail: "Every CAE/ASSERT handoff should carry enough runtime, model, seed, profile, and component-version context to reproduce the selected reliability-lab run.",
};

const validationProvenance = {
  manifestPath: provenanceContract.manifestPath,
  requiredRunFields: provenanceContract.requiredRunFields,
};

const evidenceInventory = [
  {
    id: "controlled_candidate_proof",
    requiredFor: ["fixture", "browser_webrtc", "reliability_lab", "sip_verto", "signalwire_pstn"],
    artifact: "artifacts/demo-proof-latest.json",
    producerCommand: "npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json",
    validates: ["controlled_candidate_scorecard_passes", "final_disposition_recorded"],
  },
  {
    id: "cae_assert_request",
    requiredFor: ["fixture", "browser_webrtc", "reliability_lab", "sip_verto", "signalwire_pstn"],
    artifact: "artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json",
    producerCommand: "npm run cae:assert:handoff",
    validates: ["assert_run_create_request", "selected_target_mode_provenance"],
  },
  {
    id: "browser_live_media_manifest",
    requiredFor: ["browser_webrtc"],
    artifact: "artifacts/browser-webrtc-live-proof/browser-webrtc-live-proof-manifest.json",
    producerCommand: "npm run browser-webrtc:live-proof",
    validates: ["browser_webrtc_bridge_ready", "rtc_asr_final_transcript", "caller_audible_tts"],
  },
  {
    id: "sip_verto_live_manifest",
    requiredFor: ["sip_verto"],
    artifact: "artifacts/verto-sip-live-proof/manifest.json",
    producerCommand: "npm run pipecat:verto:live-proof",
    validates: ["freeswitch_verto_ready", "shared_pipeline_ready", "caller_playback_confirmed"],
  },
  {
    id: "signalwire_readiness",
    requiredFor: ["signalwire_pstn"],
    artifact: "artifacts/signalwire-freeswitch-readiness/readiness.json",
    producerCommand: "npm run signalwire:freeswitch:readiness -- --render",
    validates: ["signalwire_env_configured", "freeswitch_gateway_rendered", "public_sip_reachability_checked"],
  },
];

const handoffChecklist = [
  {
    id: "select_target_mode",
    requiredFor: ["fixture", "browser_webrtc", "reliability_lab", "sip_verto", "signalwire_pstn"],
    command: "npm run reliability:lab",
    requiredEvidence: ["/api/reliability", "/api/pipecat-media-engine/readiness"],
    passSignal: "Target mode status is ready or configured, with live-media blockers explicit.",
  },
  {
    id: "capture_controlled_candidate",
    requiredFor: ["fixture", "browser_webrtc", "reliability_lab", "sip_verto", "signalwire_pstn"],
    command: "npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json",
    requiredEvidence: ["artifacts/demo-proof-latest.json"],
    passSignal: "Controlled cancellation-rescue scorecard passes and final disposition is recorded.",
  },
  {
    id: "capture_selected_media_proof",
    requiredFor: ["browser_webrtc", "sip_verto", "signalwire_pstn"],
    command: "Run the selected target mode evidence command from targetModes[].evidenceCommand.",
    requiredEvidence: [
      "artifacts/browser-webrtc-live-proof/browser-webrtc-live-proof-manifest.json",
      "artifacts/verto-sip-live-proof/manifest.json",
      "artifacts/signalwire-freeswitch-readiness/readiness.json",
    ],
    passSignal: "Live transcript, media playback, and sidecar readiness evidence are same-run artifacts.",
  },
  {
    id: "generate_cae_assert_request",
    requiredFor: ["fixture", "browser_webrtc", "reliability_lab", "sip_verto", "signalwire_pstn"],
    command: "npm run cae:assert:handoff",
    requiredEvidence: ["artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json"],
    passSignal: "AssertRunCreateRequest includes provenance, evidence artifact paths, and selected target mode.",
  },
];

function selectedModeHandoffChecklist(mode) {
  return handoffChecklist.filter((step) => step.requiredFor.includes(mode));
}

function selectedModeEvidenceInventory(mode) {
  return evidenceInventory.filter((item) => item.requiredFor.includes(mode));
}

function evidenceStatusForInventory(inventory) {
  const checkedAtMs = Date.now();
  return inventory.map((item) => {
    const artifactPath = path.join(repoRoot, item.artifact);
    const exists = existsSync(artifactPath);
    const stats = exists ? statSync(artifactPath) : null;
    const ageMs = stats ? Math.max(checkedAtMs - stats.mtime.getTime(), 0) : null;
    return {
      id: item.id,
      artifact: item.artifact,
      exists,
      sizeBytes: stats?.size ?? null,
      updatedAt: stats?.mtime.toISOString() ?? null,
      ageMs,
      staleAfterMs: evidenceFreshnessBudgetMs,
      freshForHandoff: ageMs !== null && ageMs <= evidenceFreshnessBudgetMs,
      producerCommand: item.producerCommand,
      validates: item.validates,
    };
  });
}

function evidenceStatusForArtifacts(artifacts) {
  const checkedAtMs = Date.now();
  return artifacts.map((artifact) => {
    const artifactPath = path.join(repoRoot, artifact);
    const exists = existsSync(artifactPath);
    const stats = exists ? statSync(artifactPath) : null;
    const ageMs = stats ? Math.max(checkedAtMs - stats.mtime.getTime(), 0) : null;
    return {
      artifact,
      exists,
      sizeBytes: stats?.size ?? null,
      updatedAt: stats?.mtime.toISOString() ?? null,
      ageMs,
      staleAfterMs: evidenceFreshnessBudgetMs,
      freshForHandoff: ageMs !== null && ageMs <= evidenceFreshnessBudgetMs,
    };
  });
}

function nextMissingEvidence(evidenceStatus) {
  const missing = evidenceStatus.find((item) => !item.exists);
  return missing
    ? {
        id: missing.id ?? missing.artifact,
        artifact: missing.artifact,
        command: missing.producerCommand ?? null,
      }
    : null;
}

function evidenceSummary(evidenceStatus) {
  const present = evidenceStatus.filter((item) => item.exists).length;
  const missing = evidenceStatus.length - present;
  const stale = evidenceStatus.filter((item) => item.exists && item.freshForHandoff === false).length;
  const blockers = handoffEvidenceBlockers(evidenceStatus);
  return {
    total: evidenceStatus.length,
    present,
    missing,
    stale,
    complete: missing === 0,
    freshForHandoff: missing === 0 && stale === 0,
    handoffReady: blockers.length === 0,
    handoffBlockers: blockers,
    nextMissingEvidence: nextMissingEvidence(evidenceStatus),
  };
}

function handoffEvidenceBlockers(evidenceStatus) {
  return evidenceStatus.flatMap((item) => {
    if (!item.exists) {
      return [`missing evidence artifact: ${item.artifact}`];
    }
    if (item.freshForHandoff === false) {
      return [`stale evidence artifact: ${item.artifact}`];
    }
    return [];
  });
}

function nextEvidenceAction(evidenceStatus, validationCommand) {
  const stale = evidenceStatus.find((item) => item.exists && item.freshForHandoff === false);
  if (stale) {
    return {
      step: "refresh_stale_evidence",
      command: stale.producerCommand ?? validationCommand,
      evidence: stale.artifact,
      detail: "Refresh stale selected evidence before CAE/ASSERT handoff.",
    };
  }
  const missing = nextMissingEvidence(evidenceStatus);
  if (missing) {
    return {
      step: "capture_missing_evidence",
      command: missing.command ?? validationCommand,
      evidence: missing.artifact,
      detail: "Generate the next missing selected evidence artifact before CAE/ASSERT handoff.",
    };
  }

  return {
    step: "validate_existing_evidence",
    command: validationCommand,
    evidence: evidenceStatus[0]?.artifact ?? "/api/reliability",
    detail: "All selected evidence artifacts are present; rerun the validation gate to refresh or verify them.",
  };
}

function blockingSummary(targetMode, evidenceSummary) {
  const endpointBlockers = targetMode.blockers;
  const evidenceBlockers = evidenceSummary.handoffBlockers;
  return {
    endpointBlockers,
    evidenceBlockers,
    firstBlocker: endpointBlockers[0] ?? evidenceBlockers[0] ?? null,
    blockerCount: endpointBlockers.length + evidenceBlockers.length,
    endpointReady: endpointBlockers.length === 0,
    evidenceReady: evidenceBlockers.length === 0,
    handoffReady: endpointBlockers.length === 0 && evidenceBlockers.length === 0,
  };
}

function entrypointRecommendedNextStep(targetMode, blockers, evidenceAction) {
  if (!blockers.endpointReady) {
    return {
      category: "endpoint",
      step: targetMode.nextAction.step,
      command: targetMode.nextAction.command,
      evidence: targetMode.nextAction.evidence,
      detail: targetMode.nextAction.detail,
    };
  }

  if (!blockers.evidenceReady) {
    return {
      category: "evidence",
      step: evidenceAction.step,
      command: evidenceAction.command,
      evidence: evidenceAction.evidence,
      detail: evidenceAction.detail,
    };
  }

  return {
    category: "handoff",
    step: "ready_for_cae_import",
    command: targetMode.caeHandoffCommand,
    evidence: "artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json",
    detail: "Endpoint and evidence blockers are clear; use the fresh CAE/ASSERT handoff request or rerun the command to refresh it.",
  };
}

function labEntrypointWorkState(targetMode, blockers) {
  if (!targetMode) return "blocked";
  if (!blockers.endpointReady) return "blocked";
  if (!blockers.handoffReady) return "active";
  return "done";
}

function entrypointActionQueue(targetMode, blockers, evidenceAction) {
  const endpointBlocker = blockers.endpointBlockers[0] ?? null;
  const evidenceBlocker = blockers.evidenceBlockers[0] ?? null;

  if (blockers.handoffReady) {
    return [
      { step: "start_or_connect_stack", command: targetMode.startCommand, purpose: "Start local services or connect to the selected external endpoints for this target mode." },
      { step: "validate_readiness", command: targetMode.validationCommand, purpose: "Run the fastest bounded readiness or proof gate for this selected mode." },
      { step: "capture_evidence", command: evidenceAction.command, evidence: evidenceAction.evidence, purpose: "Write the selected target mode artifact needed for CAE/ASSERT handoff." },
      { step: "generate_handoff_request", command: targetMode.caeHandoffCommand, purpose: "Generate the CAE-compatible AssertRunCreateRequest with selected-mode provenance." },
    ].map((action) => ({ ...action, status: "complete", blockedBy: null }));
  }

  return [
    {
      step: "start_or_connect_stack",
      command: targetMode.startCommand,
      status: blockers.endpointReady ? "complete" : "pending",
      blockedBy: null,
      purpose: "Start local services or connect to the selected external endpoints for this target mode.",
    },
    {
      step: "validate_readiness",
      command: targetMode.validationCommand,
      status: blockers.endpointReady ? "complete" : "blocked",
      blockedBy: endpointBlocker,
      purpose: "Run the fastest bounded readiness or proof gate for this selected mode.",
    },
    {
      step: "capture_evidence",
      command: evidenceAction.command,
      status: blockers.endpointReady ? (blockers.evidenceReady ? "complete" : "pending") : "blocked",
      blockedBy: endpointBlocker,
      evidence: evidenceAction.evidence,
      purpose: "Write the selected target mode artifact needed for CAE/ASSERT handoff.",
    },
    {
      step: "generate_handoff_request",
      command: targetMode.caeHandoffCommand,
      status: blockers.handoffReady ? "complete" : "blocked",
      blockedBy: endpointBlocker ?? evidenceBlocker,
      purpose: "Generate the CAE-compatible AssertRunCreateRequest with selected-mode provenance.",
    },
  ];
}

function entrypointActionQueueSummary(actionQueue) {
  const completed = actionQueue.filter((item) => item.status === "complete").length;
  const pending = actionQueue.filter((item) => item.status === "pending").length;
  const blocked = actionQueue.filter((item) => item.status === "blocked").length;
  const activeAction = actionQueue.find((item) => item.status === "pending") ?? actionQueue.find((item) => item.status === "blocked") ?? null;
  const activeIndex = activeAction ? actionQueue.indexOf(activeAction) : -1;

  return {
    state: completed === actionQueue.length ? "done" : pending > 0 ? "active" : "blocked",
    total: actionQueue.length,
    completed,
    pending,
    blocked,
    complete: completed === actionQueue.length,
    progressPct: actionQueue.length > 0 ? Math.round((completed / actionQueue.length) * 100) : 100,
    activeOrdinal: activeIndex >= 0 ? activeIndex + 1 : null,
    remaining: pending + blocked,
    hasRemaining: pending + blocked > 0,
    remainingAfterActive: Math.max(0, pending + blocked - (activeAction ? 1 : 0)),
    activeStep: activeAction?.step ?? null,
    activeStatus: activeAction?.status ?? null,
    activeRunnable: activeAction?.status === "pending",
    activeBlocked: activeAction?.status === "blocked",
    activeCommand: activeAction?.command ?? null,
    activePurpose: activeAction?.purpose ?? null,
    activeEvidence: activeAction?.evidence ?? null,
    activeBlockedBy: activeAction?.blockedBy ?? null,
  };
}

const endpointRequirements = {
  caeApi: { label: "ConversationAgentEvals API", envVar: "CAE_API_URL", configured: Boolean(optionalEndpoints.caeApi), ready: endpointReady.caeApi },
  caeWeb: { label: "ConversationAgentEvals web", envVar: "CAE_WEB_URL", configured: Boolean(optionalEndpoints.caeWeb), ready: endpointReady.caeWeb },
  assertViewer: { label: "ASSERT viewer", envVar: "ASSERT_VIEWER_URL", configured: liveEndpointConfigured.assertViewer, ready: endpointReady.assertViewer },
  rtcAsr: { label: "rtc-asr", envVar: "RTC_ASR_BASE_URL", configured: liveEndpointConfigured.rtcAsr, ready: endpointReady.rtcAsr },
  kokoro: { label: "Kokoro", envVar: "KOKORO_BASE_URL", configured: liveEndpointConfigured.kokoro, ready: endpointReady.kokoro },
  browserWebRtcBridge: {
    label: "Pipecat browser bridge",
    envVar: "BROWSER_WEBRTC_BRIDGE_URL",
    configured: liveEndpointConfigured.browserWebRtcBridge,
    ready: endpointReady.browserWebRtcBridge,
  },
  freeswitchVerto: {
    label: "FreeSWITCH/Verto",
    envVar: "FREESWITCH_VERTO_URL",
    configured: liveEndpointConfigured.freeswitchVerto,
    ready: endpointReady.freeswitchVerto,
  },
};

const runProfiles = [
  {
    id: "local_fixture",
    status: "ready",
    targetModes: ["fixture"],
    envVars: ["ACC_RELIABILITY_TARGET_MODE"],
    startCommand: "npm run proof",
    validationCommand: "npm run proof",
    handoffCommand: "npm run cae:assert:handoff",
    evidence: ["artifacts/demo-proof-latest.json"],
    detail: "Run the deterministic cancellation-rescue proof without external services.",
  },
  {
    id: "connected_cae",
    status: caeConfigured
      ? endpointReady.caeApi && endpointReady.caeWeb
        ? "ready"
        : "unreachable"
      : "blocked",
    targetModes: ["fixture", "reliability_lab"],
    envVars: ["CAE_API_URL", "CAE_WEB_URL"],
    startCommand: "Set CAE_API_URL and CAE_WEB_URL",
    validationCommand: "npm run reliability:lab",
    handoffCommand: "npm run cae:assert:handoff",
    evidence: ["artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json"],
    detail: "Connect ACC proof artifacts to external ConversationAgentEvals while keeping the local fixture runnable.",
  },
  {
    id: "live_media_lab",
    status:
      caeConfigured &&
      liveEndpointConfigured.rtcAsr &&
      liveEndpointConfigured.kokoro &&
      liveEndpointConfigured.browserWebRtcBridge
        ? endpointReady.caeApi &&
          endpointReady.caeWeb &&
          endpointReady.rtcAsr &&
          endpointReady.kokoro &&
          endpointReady.browserWebRtcBridge
          ? "ready"
          : "unreachable"
        : "blocked",
    targetModes: ["browser_webrtc", "sip_verto", "signalwire_pstn"],
    envVars: ["CAE_API_URL", "CAE_WEB_URL", "RTC_ASR_BASE_URL", "KOKORO_BASE_URL", "BROWSER_WEBRTC_BRIDGE_URL", "FREESWITCH_VERTO_URL"],
    startCommand: "npm run docker:reliability-lab",
    validationCommand: "npm run reliability:lab",
    handoffCommand: "npm run cae:assert:handoff",
    evidence: [
      "artifacts/browser-webrtc-live-proof/browser-webrtc-live-proof-manifest.json",
      "artifacts/verto-sip-live-proof/manifest.json",
      "artifacts/signalwire-freeswitch-readiness/readiness.json",
    ],
    detail: "Run CAE-connected live media evidence paths after the selected rtc-asr, TTS, and transport endpoints are configured.",
  },
];

function requiredEndpointBlockers(endpointKeys) {
  return endpointKeys.flatMap((key) => {
    const requirement = endpointRequirements[key];
    if (!requirement.configured) return [`${requirement.label} endpoint is not configured (${requirement.envVar}).`];
    if (!requirement.ready) return [`${requirement.label} endpoint is configured but unreachable (${requirement.envVar}).`];
    return [];
  });
}

function missingEndpointEnvVars(endpointKeys) {
  return endpointKeys.flatMap((key) => {
    const requirement = endpointRequirements[key];
    return requirement.configured ? [] : [requirement.envVar];
  });
}

function configuredEndpointBlockers(endpointKeys) {
  return endpointKeys.flatMap((key) => {
    const requirement = endpointRequirements[key];
    if (requirement.configured && !requirement.ready) {
      return [`${requirement.label} endpoint is configured but unreachable (${requirement.envVar}).`];
    }
    return [];
  });
}

function endpointStatus(endpointKeys) {
  return endpointKeys.map((key) => {
    const requirement = endpointRequirements[key];
    return {
      key,
      label: requirement.label,
      envVar: requirement.envVar,
      configured: requirement.configured,
      ready: requirement.configured && requirement.ready,
      status: requirement.configured ? (requirement.ready ? "ready" : "unreachable") : "missing",
    };
  });
}

const targetModes = [
  {
    mode: "fixture",
    status: "ready",
    blockers: [],
    nextAction: {
      step: "run_controlled_candidate",
      command: "npm run proof",
      evidence: "artifacts/demo-proof-latest.json",
      detail: "Run the sidecar-free cancellation-rescue proof and inspect the deterministic scorecard.",
    },
    requiredEndpointEnvVars: [],
    missingEndpointEnvVars: [],
    optionalEndpointEnvVars: [],
    endpointStatus: [],
    requiredComponents: ["ACC app"],
    startCommand: "npm run proof",
    validationCommand: "npm run proof",
    evidenceCommand: "npm run proof:bundle",
    readinessRoute: "/health",
    caeHandoffCommand: "npm run cae:assert:handoff",
    validationGate: {
      fastestCheck: "npm run proof",
      evidenceArtifact: "artifacts/demo-proof-latest.json",
      successCriteria: ["controlled_candidate_scorecard_passes", "proof_bundle_written"],
      liveMediaRequired: false,
      provenance: validationProvenance,
    },
    detail: "Sidecar-free cancellation-rescue proof for the controlled candidate.",
  },
  {
    mode: "browser_webrtc",
    status:
      liveEndpointConfigured.rtcAsr && liveEndpointConfigured.kokoro && liveEndpointConfigured.browserWebRtcBridge
        ? endpointReady.rtcAsr && endpointReady.kokoro && endpointReady.browserWebRtcBridge
          ? "ready"
          : "unreachable"
        : "blocked",
    blockers: requiredEndpointBlockers(["rtcAsr", "kokoro", "browserWebRtcBridge"]),
    nextAction: {
      step: liveEndpointConfigured.rtcAsr && liveEndpointConfigured.kokoro && liveEndpointConfigured.browserWebRtcBridge
        ? "validate_browser_media_path"
        : "configure_browser_media_endpoints",
      command: liveEndpointConfigured.rtcAsr && liveEndpointConfigured.kokoro && liveEndpointConfigured.browserWebRtcBridge
        ? "npm run browser-webrtc:check"
        : "npm run docker:browser-webrtc",
      evidence: "/api/browser-webrtc/readiness",
      detail: "Bring up rtc-asr, Kokoro, and the Pipecat browser bridge before capturing live browser evidence.",
    },
    requiredEndpointEnvVars: ["RTC_ASR_BASE_URL", "KOKORO_BASE_URL", "BROWSER_WEBRTC_BRIDGE_URL"],
    missingEndpointEnvVars: missingEndpointEnvVars(["rtcAsr", "kokoro", "browserWebRtcBridge"]),
    optionalEndpointEnvVars: [],
    endpointStatus: endpointStatus(["rtcAsr", "kokoro", "browserWebRtcBridge"]),
    requiredComponents: ["ACC app", "rtc-asr", "Kokoro", "Pipecat browser bridge"],
    startCommand: "npm run docker:browser-webrtc",
    validationCommand: "npm run browser-webrtc:check",
    evidenceCommand: "npm run browser-webrtc:live-proof",
    readinessRoute: "/api/browser-webrtc/readiness",
    caeHandoffCommand: "npm run cae:assert:handoff",
    validationGate: {
      fastestCheck: "npm run browser-webrtc:check",
      evidenceArtifact: "artifacts/browser-webrtc-live-proof/browser-webrtc-live-proof-manifest.json",
      successCriteria: ["pipecat_browser_bridge_ready", "rtc_asr_ready", "tts_ready"],
      liveMediaRequired: true,
      provenance: validationProvenance,
    },
    detail: "Live browser media path for CAE/ASSERT evidence requests.",
  },
  {
    mode: "reliability_lab",
    status:
      caeConfigured && endpointReady.caeApi && endpointReady.caeWeb
        ? liveEndpointConfigured.assertViewer &&
          liveEndpointConfigured.rtcAsr &&
          liveEndpointConfigured.kokoro &&
          liveEndpointConfigured.browserWebRtcBridge &&
          endpointReady.assertViewer &&
          endpointReady.rtcAsr &&
          endpointReady.kokoro &&
          endpointReady.browserWebRtcBridge
          ? "ready"
          : "configured"
        : "blocked",
    blockers: [
      ...requiredEndpointBlockers(["caeApi", "caeWeb"]),
      ...configuredEndpointBlockers(["assertViewer", "rtcAsr", "kokoro", "browserWebRtcBridge"]),
    ],
    nextAction: {
      step: caeConfigured ? "validate_reliability_lab_handoff" : "configure_cae_endpoints",
      command: caeConfigured ? "npm run reliability:lab" : "Set CAE_API_URL and CAE_WEB_URL",
      evidence: "/api/reliability",
      detail: "Connect external ConversationAgentEvals endpoints, then rerun the bounded reliability-lab status probe.",
    },
    requiredEndpointEnvVars: ["CAE_API_URL", "CAE_WEB_URL"],
    missingEndpointEnvVars: missingEndpointEnvVars(["caeApi", "caeWeb"]),
    optionalEndpointEnvVars: ["ASSERT_VIEWER_URL", "RTC_ASR_BASE_URL", "KOKORO_BASE_URL", "BROWSER_WEBRTC_BRIDGE_URL"],
    endpointStatus: endpointStatus(["caeApi", "caeWeb", "assertViewer", "rtcAsr", "kokoro", "browserWebRtcBridge"]),
    requiredComponents: ["ACC app", "rtc-asr", "Kokoro", "Pipecat browser bridge", "ConversationAgentEvals", "ASSERT viewer"],
    startCommand: "npm run docker:reliability-lab",
    validationCommand: "npm run reliability:lab",
    evidenceCommand: "npm run proof:bundle",
    readinessRoute: "/api/reliability",
    caeHandoffCommand: "npm run cae:assert:handoff",
    validationGate: {
      fastestCheck: "npm run reliability:lab",
      evidenceArtifact: "artifacts/agentic-call-center-demo/conversation-agent-evals-assert-request.json",
      successCriteria: ["cae_api_reachable", "cae_web_reachable", "selected_media_mode_ready_or_configured"],
      liveMediaRequired: false,
      provenance: validationProvenance,
    },
    detail: "Local ACC media/evidence stack with external CAE endpoints and local ASSERT viewer wiring.",
  },
  {
    mode: "sip_verto",
    status:
      liveEndpointConfigured.rtcAsr && liveEndpointConfigured.kokoro && liveEndpointConfigured.freeswitchVerto
        ? endpointReady.rtcAsr && endpointReady.kokoro && endpointReady.freeswitchVerto
          ? "ready"
          : "unreachable"
        : "blocked",
    blockers: requiredEndpointBlockers(["rtcAsr", "kokoro", "freeswitchVerto"]),
    nextAction: {
      step: liveEndpointConfigured.rtcAsr && liveEndpointConfigured.kokoro && liveEndpointConfigured.freeswitchVerto
        ? "validate_sip_verto_path"
        : "configure_sip_verto_endpoints",
      command: liveEndpointConfigured.rtcAsr && liveEndpointConfigured.kokoro && liveEndpointConfigured.freeswitchVerto
        ? "npm run pipecat:verto:check"
        : "npm run docker:sip-verto",
      evidence: "/api/pipecat-media-engine/readiness",
      detail: "Bring up rtc-asr, Kokoro, and FreeSWITCH/Verto before capturing SIP/Verto evidence.",
    },
    requiredEndpointEnvVars: ["RTC_ASR_BASE_URL", "KOKORO_BASE_URL", "FREESWITCH_VERTO_URL"],
    missingEndpointEnvVars: missingEndpointEnvVars(["rtcAsr", "kokoro", "freeswitchVerto"]),
    optionalEndpointEnvVars: [],
    endpointStatus: endpointStatus(["rtcAsr", "kokoro", "freeswitchVerto"]),
    requiredComponents: ["ACC app", "FreeSWITCH/Verto", "rtc-asr", "Kokoro", "Pipecat Verto bridge"],
    startCommand: "npm run docker:sip-verto",
    validationCommand: "npm run pipecat:verto:check",
    evidenceCommand: "npm run pipecat:verto:live-proof",
    readinessRoute: "/api/pipecat-media-engine/readiness",
    caeHandoffCommand: "npm run cae:assert:handoff",
    validationGate: {
      fastestCheck: "npm run pipecat:verto:check",
      evidenceArtifact: "artifacts/verto-sip-live-proof/manifest.json",
      successCriteria: ["freeswitch_verto_ready", "pipecat_verto_bridge_ready", "shared_pipeline_ready"],
      liveMediaRequired: true,
      provenance: validationProvenance,
    },
    detail: "Strict local SIP/Verto proof path for the reference stack.",
  },
  {
    mode: "signalwire_pstn",
    status: "blocked",
    blockers: [
      "SignalWire SIP trunk env, provider source ACL proof, and public SIP reachability must be validated before manual PSTN call proof.",
      ...missingSignalwirePstnEnvVars.map((name) => `SignalWire PSTN readiness env is not configured (${name}).`),
      ...requiredEndpointBlockers(["rtcAsr", "kokoro", "freeswitchVerto"]),
    ],
    nextAction: {
      step: "run_signalwire_readiness_gate",
      command: "npm run signalwire:freeswitch:readiness",
      evidence: "artifacts/signalwire-freeswitch-readiness/readiness.json",
      detail: "Render and validate credential-safe SignalWire/FreeSWITCH readiness before any manual PSTN call.",
    },
    requiredEndpointEnvVars: ["RTC_ASR_BASE_URL", "KOKORO_BASE_URL", "FREESWITCH_VERTO_URL"],
    missingEndpointEnvVars: missingEndpointEnvVars(["rtcAsr", "kokoro", "freeswitchVerto"]),
    optionalEndpointEnvVars: [],
    signalwireTrunkMode,
    requiredSignalwireEnvVars: requiredSignalwirePstnEnvVars,
    missingSignalwireEnvVars: missingSignalwirePstnEnvVars,
    endpointStatus: endpointStatus(["rtcAsr", "kokoro", "freeswitchVerto"]),
    requiredComponents: ["ACC app", "SignalWire SIP trunk", "FreeSWITCH/Verto", "rtc-asr", "Kokoro", "Pipecat Verto bridge"],
    startCommand: "npm run docker:sip-verto",
    validationCommand: "npm run signalwire:freeswitch:readiness",
    evidenceCommand: "npm run signalwire:freeswitch:readiness -- --render",
    readinessRoute: "/api/pipecat-media-engine/readiness",
    caeHandoffCommand: "npm run cae:assert:handoff",
    validationGate: {
      fastestCheck: "npm run signalwire:freeswitch:readiness",
      evidenceArtifact: "artifacts/signalwire-freeswitch-readiness/readiness.json",
      successCriteria: ["signalwire_env_configured", "freeswitch_gateway_rendered", "public_sip_reachability_checked"],
      liveMediaRequired: true,
      provenance: validationProvenance,
    },
    detail: "Production-like PSTN ingress remains gated on SignalWire env, provider-owned source ACL proof, and public SIP reachability before manual call validation.",
  },
];

function selectedRunProfileForTargetMode(targetMode) {
  if (!targetMode) return null;
  if (targetMode === "reliability_lab") {
    return runProfiles.find((profile) => profile.id === "connected_cae") ?? null;
  }
  if (targetMode === "browser_webrtc" || targetMode === "sip_verto" || targetMode === "signalwire_pstn") {
    return runProfiles.find((profile) => profile.id === "live_media_lab") ?? null;
  }
  return runProfiles.find((profile) => profile.targetModes.includes(targetMode)) ?? null;
}

function labEntryPointForTargetMode(targetMode, runProfile, evidenceStatus) {
  if (!targetMode) return null;
  const summary = evidenceSummary(evidenceStatus);
  const blockers = blockingSummary(targetMode, summary);
  const evidenceAction = nextEvidenceAction(evidenceStatus, targetMode.validationCommand);
  const workState = labEntrypointWorkState(targetMode, blockers);
  const actionQueue = entrypointActionQueue(targetMode, blockers, evidenceAction);
  return {
    id: `${targetMode.mode}_lab_entrypoint`,
    mode: targetMode.mode,
    runProfile: runProfile?.id ?? null,
    workState,
    readinessRoute: targetMode.readinessRoute,
    requiredComponents: targetMode.requiredComponents,
    requiredEndpointEnvVars: targetMode.requiredEndpointEnvVars,
    missingEndpointEnvVars: targetMode.missingEndpointEnvVars,
    blockers: targetMode.blockers,
    blockingSummary: blockers,
    nextAction: targetMode.nextAction,
    evidenceSummary: summary,
    nextMissingEvidence: summary.nextMissingEvidence,
    nextEvidenceAction: evidenceAction,
    recommendedNextStep: entrypointRecommendedNextStep(targetMode, blockers, evidenceAction),
    actionQueue,
    actionQueueSummary: entrypointActionQueueSummary(actionQueue),
    commands: [
      {
        step: "start_or_connect_stack",
        command: targetMode.startCommand,
        purpose: "Start local services or connect to the selected external endpoints for this target mode.",
      },
      {
        step: "validate_readiness",
        command: targetMode.validationCommand,
        purpose: "Run the fastest bounded readiness or proof gate for this selected mode.",
      },
      {
        step: "capture_evidence",
        command: targetMode.evidenceCommand,
        purpose: "Write the selected target mode artifact needed for CAE/ASSERT handoff.",
      },
      {
        step: "generate_handoff_request",
        command: targetMode.caeHandoffCommand,
        purpose: "Generate the CAE-compatible AssertRunCreateRequest with selected-mode provenance.",
      },
    ],
  };
}

const selectedTargetMode = targetModes.find((mode) => mode.mode === requestedTargetMode) ?? null;
const selectedRunProfile = selectedRunProfileForTargetMode(selectedTargetMode?.mode ?? null);
const selectedEvidenceInventory = selectedTargetMode ? selectedModeEvidenceInventory(selectedTargetMode.mode) : [];
const selectedEvidenceStatus = evidenceStatusForInventory(selectedEvidenceInventory);
const selectedLabEntryPoint = labEntryPointForTargetMode(selectedTargetMode, selectedRunProfile, selectedEvidenceStatus);

function optionalComponent({ component, configured, endpoint, envVar, probe, configuredDetail, defaultDetail }) {
  const status = configured ? (probe?.ready ? "ready" : "unreachable") : "not_required";
  return {
    component,
    status,
    configured,
    reachable: configured ? probe?.reachable === true : null,
    requiredForDefaultDemo: false,
    endpoint,
    envVar,
    probe,
    detail: configured ? (probe?.detail ?? configuredDetail) : defaultDetail,
  };
}

const componentReadiness = [
  {
    component: "default-scripted-demo",
    status: "ready",
    requiredForDefaultDemo: true,
    detail: "Sidecar-free proof command is available.",
  },
  {
    component: "ConversationAgentEvals",
    status: caeConfigured ? (endpointReady.caeApi && endpointReady.caeWeb ? "ready" : "unreachable") : "not_configured",
    configured: caeConfigured,
    reachable: caeConfigured ? endpointReady.caeApi && endpointReady.caeWeb : null,
    requiredForDefaultDemo: false,
    endpoints: {
      api: redactedOptionalEndpoints.caeApi,
      web: redactedOptionalEndpoints.caeWeb,
    },
    probes: {
      api: redactedEndpointProbes.caeApi ?? null,
      web: redactedEndpointProbes.caeWeb ?? null,
    },
    detail: caeConfigured
      ? endpointReady.caeApi && endpointReady.caeWeb
        ? "CAE endpoints are reachable for Phase 2 lab handoff."
        : "CAE endpoints are configured but unreachable."
      : "Set CAE_API_URL and CAE_WEB_URL to enable Phase 2 lab handoff.",
  },
  optionalComponent({
    component: "rtc-asr",
    configured: liveEndpointConfigured.rtcAsr,
    endpoint: redactedOptionalEndpoints.rtcAsr,
    envVar: "RTC_ASR_BASE_URL",
    probe: redactedEndpointProbes.rtcAsr ?? null,
    configuredDetail: "Configured for selected live media modes.",
    defaultDetail: "Required only for selected live media modes.",
  }),
  optionalComponent({
    component: "Kokoro",
    configured: liveEndpointConfigured.kokoro,
    endpoint: redactedOptionalEndpoints.kokoro,
    envVar: "KOKORO_BASE_URL",
    probe: redactedEndpointProbes.kokoro ?? null,
    configuredDetail: "Configured for selected live media modes.",
    defaultDetail: "Required only for selected live media modes.",
  }),
  optionalComponent({
    component: "Pipecat browser bridge",
    configured: liveEndpointConfigured.browserWebRtcBridge,
    endpoint: redactedOptionalEndpoints.browserWebRtcBridge,
    envVar: "BROWSER_WEBRTC_BRIDGE_URL",
    probe: redactedEndpointProbes.browserWebRtcBridge ?? null,
    configuredDetail: "Configured for Browser voice proof modes.",
    defaultDetail: "Required only for Browser voice proof modes.",
  }),
  optionalComponent({
    component: "FreeSWITCH/Verto",
    configured: liveEndpointConfigured.freeswitchVerto,
    endpoint: redactedOptionalEndpoints.freeswitchVerto,
    envVar: "FREESWITCH_VERTO_URL",
    probe: redactedEndpointProbes.freeswitchVerto ?? null,
    configuredDetail: "Configured for SIP/Verto proof modes.",
    defaultDetail: "Required only for SIP/Verto proof modes.",
  }),
  optionalComponent({
    component: "ASSERT viewer",
    configured: liveEndpointConfigured.assertViewer,
    endpoint: redactedOptionalEndpoints.assertViewer,
    envVar: "ASSERT_VIEWER_URL",
    probe: redactedEndpointProbes.assertViewer ?? null,
    configuredDetail: "Configured for CAE/ASSERT handoff or local viewer workflows.",
    defaultDetail: "Used through CAE/ASSERT handoff or local viewer workflows.",
  }),
];

function countStatuses(items) {
  return items.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
}

const blockers = [];
if (missingScripts.length > 0) blockers.push(`missing package scripts: ${missingScripts.join(", ")}`);
if (missingProfiles.length > 0) blockers.push(`missing Compose profiles: ${missingProfiles.join(", ")}`);
if (!stackManifest.exists) blockers.push("missing stack/versions.env reference-stack manifest.");
if (missingStackManifestKeys.length > 0) blockers.push(`stack/versions.env is missing keys: ${missingStackManifestKeys.join(", ")}`);
if (!caeConfigured) {
  blockers.push("ConversationAgentEvals API/web endpoints are not configured; set CAE_API_URL and CAE_WEB_URL for Phase 2 lab runs.");
} else if (!endpointReady.caeApi || !endpointReady.caeWeb) {
  blockers.push("ConversationAgentEvals API/web endpoints are configured but unreachable.");
}
if (!selectedTargetMode) {
  blockers.push(`ACC_RELIABILITY_TARGET_MODE must be one of: ${targetModes.map((mode) => mode.mode).join(", ")}.`);
}

function reportWorkState() {
  if (!selectedLabEntryPoint) return "blocked";
  if (selectedLabEntryPoint.workState === "blocked") return "blocked";
  if (blockers.length > 0) return "active";
  return selectedLabEntryPoint.workState;
}

const report = {
  ok: blockers.length === 0,
  mode: "reliability_lab_phase_1_status",
  status: blockers.length === 0 ? "configured" : "blocked",
  workState: reportWorkState(),
  defaultDemo: {
    status: "ready",
    notRequired: ["ConversationAgentEvals", "rtc-asr", "Kokoro", "FreeSWITCH", "ASSERT", "production credentials"],
    proofCommand: "npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json",
  },
  goldenScenario: {
    id: "cancellation-rescue",
    comparison: goldenComparison,
    verdictEvidenceChecklist,
    caveat: "Unsafe baseline behavior is only a labeled demo fixture/profile; CAE/ASSERT owns imported run reports and comparisons.",
  },
  selectedTargetMode: selectedTargetMode
    ? {
        ...selectedTargetMode,
        requestedVia: requestedTargetMode === "fixture" ? "default" : "ACC_RELIABILITY_TARGET_MODE",
        handoffChecklist: selectedModeHandoffChecklist(selectedTargetMode.mode),
        evidenceInventory: selectedEvidenceInventory,
        evidenceStatus: selectedEvidenceStatus,
        nextMissingEvidence: nextMissingEvidence(selectedEvidenceStatus),
        evidenceSummary: evidenceSummary(selectedEvidenceStatus),
        handoffReady: selectedLabEntryPoint.blockingSummary.handoffReady,
        handoffBlockers: [
          ...selectedLabEntryPoint.blockingSummary.endpointBlockers,
          ...selectedLabEntryPoint.blockingSummary.evidenceBlockers,
        ],
        nextEvidenceAction: nextEvidenceAction(selectedEvidenceStatus, selectedTargetMode.validationCommand),
        labEntryPoint: selectedLabEntryPoint,
      }
    : {
        mode: requestedTargetMode,
        status: "blocked",
        requestedVia: "ACC_RELIABILITY_TARGET_MODE",
        validModes: targetModes.map((mode) => mode.mode),
        nextAction: {
          step: "select_valid_target_mode",
          command: "Set ACC_RELIABILITY_TARGET_MODE to one of targetModes[].mode",
          evidence: "/api/reliability",
          detail: "The requested target mode is unknown, so no validation or evidence command can run.",
        },
      },
  provenanceContract,
  evidenceInventory,
  handoffChecklist,
  labEntryPoint: selectedLabEntryPoint,
  recommendedNextStep: selectedLabEntryPoint?.recommendedNextStep ?? {
    category: "target_mode",
    step: "select_valid_target_mode",
    command: "Set ACC_RELIABILITY_TARGET_MODE to one of targetModes[].mode",
    evidence: "/api/reliability",
    detail: "No lab entry point can be selected until the target mode is valid.",
  },
  targetModes,
  runProfiles,
  selectedRunProfile: selectedRunProfile
    ? {
        ...selectedRunProfile,
        requestedForTargetMode: selectedTargetMode?.mode,
        evidence: selectedEvidenceStatus.map((item) => item.artifact),
        evidenceStatus: selectedEvidenceStatus,
        evidenceSummary: {
          ...evidenceSummary(selectedEvidenceStatus),
          handoffReady: selectedLabEntryPoint.blockingSummary.handoffReady,
          handoffBlockers: [
            ...selectedLabEntryPoint.blockingSummary.endpointBlockers,
            ...selectedLabEntryPoint.blockingSummary.evidenceBlockers,
          ],
        },
        handoffReady: selectedLabEntryPoint.blockingSummary.handoffReady,
        handoffBlockers: [
          ...selectedLabEntryPoint.blockingSummary.endpointBlockers,
          ...selectedLabEntryPoint.blockingSummary.evidenceBlockers,
        ],
        nextEvidenceAction: nextEvidenceAction(selectedEvidenceStatus, selectedRunProfile.validationCommand),
        nextAction: {
          step: selectedRunProfile.status === "ready" || selectedRunProfile.status === "configured" ? "run_profile_validation" : "unblock_run_profile",
          command: selectedRunProfile.validationCommand,
          evidence: selectedTargetMode?.validationGate.evidenceArtifact ?? "/api/reliability",
          detail: selectedRunProfile.detail,
        },
      }
    : {
        id: null,
        status: "blocked",
        requestedForTargetMode: requestedTargetMode,
        nextAction: {
          step: "select_valid_target_mode",
          command: "Set ACC_RELIABILITY_TARGET_MODE to one of targetModes[].mode",
          evidence: "/api/reliability",
          detail: "No run profile can be selected until the target mode is valid.",
        },
      },
  optionalEndpoints: redactedOptionalEndpoints,
  endpointProbes: redactedEndpointProbes,
  readinessProbePolicy,
  componentReadiness,
  readinessSummary: {
    selectedTargetMode: requestedTargetMode,
    targetModesByStatus: countStatuses(targetModes),
    runProfilesByStatus: countStatuses(runProfiles),
    componentsByStatus: countStatuses(componentReadiness),
    configuredOptionalEndpoints: componentReadiness.filter((component) => component.configured === true).length,
    blockers: blockers.length,
  },
  readinessVocabulary,
  evidenceLevelVocabulary,
  repositoryContracts: {
    packageScripts: Object.keys(scripts).sort(),
    composeProfiles: profiles,
    optionalEndpointEnvVars,
    stackManifest,
    requiredStackManifestKeys,
    readmeExists: existsSync(path.join(repoRoot, "README.md")),
    reliabilityDocExists: existsSync(path.join(repoRoot, "docs/reliability-lab.md")),
  },
  blockers,
  nextAction:
    blockers.length === 0
      ? "Run the selected fixture/browser/SIP proof and hand the generated evidence to ConversationAgentEvals."
      : "Use the ready scripted demo now; wire the listed external endpoints/profiles in the Phase 2 reliability-lab slice.",
};

console.log(JSON.stringify(process.argv.includes("--entrypoint") ? selectedLabEntryPoint : report, null, 2));
