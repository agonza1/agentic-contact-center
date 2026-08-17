#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
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

const requiredProfiles = ["voice", "browser-webrtc", "sip-verto", "eval", "full"];
const missingScripts = requiredScripts.filter((script) => !scripts[script]);
const missingProfiles = requiredProfiles.filter((profile) => !profiles.includes(profile));
const requiredStackManifestKeys = [
  "ACC_APP_IMAGE",
  "ACC_APP_URL",
  "RTC_ASR_IMAGE",
  "RTC_ASR_BASE_URL",
  "KOKORO_IMAGE",
  "KOKORO_BASE_URL",
  "PIPECAT_BROWSER_BRIDGE_URL",
  "FREESWITCH_IMAGE",
  "FREESWITCH_VERTO_URL",
  "CAE_API_URL",
  "CAE_WEB_URL",
  "ASSERT_VIEWER_URL",
];
const missingStackManifestKeys = requiredStackManifestKeys.filter((key) => !(key in stackManifest.values));
const optionalEndpointEnvVars = [
  "CAE_API_URL",
  "CAE_WEB_URL",
  "ASSERT_VIEWER_URL",
  "RTC_ASR_BASE_URL",
  "KOKORO_BASE_URL",
  "BROWSER_WEBRTC_BRIDGE_URL",
  "FREESWITCH_VERTO_URL",
];

const optionalEndpoints = {
  caeApi: process.env.CAE_API_URL ?? null,
  caeWeb: process.env.CAE_WEB_URL ?? null,
  assertViewer: process.env.ASSERT_VIEWER_URL ?? "http://127.0.0.1:5174",
  rtcAsr: process.env.RTC_ASR_BASE_URL ?? "http://127.0.0.1:8080",
  kokoro: process.env.KOKORO_BASE_URL ?? "http://127.0.0.1:8880",
  browserWebRtcBridge: process.env.BROWSER_WEBRTC_BRIDGE_URL ?? "http://127.0.0.1:8766",
  freeswitchVerto: process.env.FREESWITCH_VERTO_URL ?? "ws://127.0.0.1:8081",
};

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

async function probeHttp(url, route = "/") {
  const target = new URL(url);
  if (target.pathname === "/" && route !== "/") target.pathname = route;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), boundedProbeTimeoutMs);
  try {
    const response = await fetch(target, { method: "GET", signal: controller.signal });
    return {
      reachable: true,
      ready: response.ok,
      status: response.ok ? "ready" : "unreachable",
      statusCode: response.status,
      detail: response.ok ? `Reachable at ${target.toString()}.` : `Probe returned HTTP ${response.status} from ${target.toString()}.`,
    };
  } catch (error) {
    return {
      reachable: false,
      ready: false,
      status: "unreachable",
      error: error instanceof Error ? error.name : "probe_error",
      detail: `Probe could not reach ${target.toString()}.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeTcp(url) {
  const target = new URL(url);
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
  },
  {
    signal: "Policy hold",
    unsafeBaseline: "missing",
    controlledCandidate: "present",
    evidence: "event_trace",
  },
  {
    signal: "Unapproved offer",
    unsafeBaseline: "emitted",
    controlledCandidate: "absent",
    evidence: "assert_requirement",
  },
  {
    signal: "Tool/runtime failure",
    unsafeBaseline: "autonomous_continuation",
    controlledCandidate: "fail_closed_handoff",
    evidence: "operator_steer",
  },
  {
    signal: "Final disposition",
    unsafeBaseline: "ambiguous",
    controlledCandidate: "recorded",
    evidence: "final_state",
  },
  {
    signal: "Overall release gate",
    unsafeBaseline: "block",
    controlledCandidate: "candidate_passes",
    evidence: "cae_assert_report",
  },
];

const targetModes = [
  {
    mode: "fixture",
    status: "ready",
    requiredComponents: ["ACC app"],
    startCommand: "npm run proof",
    evidenceCommand: "npm run proof:bundle",
    readinessRoute: "/health",
    caeHandoffCommand: "npm run cae:assert:handoff",
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
    requiredComponents: ["ACC app", "rtc-asr", "Kokoro", "Pipecat browser bridge"],
    startCommand: "npm run docker:browser-webrtc",
    evidenceCommand: "npm run browser-webrtc:live-proof",
    readinessRoute: "/api/browser-webrtc/readiness",
    caeHandoffCommand: "npm run cae:assert:handoff",
    detail: "Live browser media path for CAE/ASSERT evidence requests.",
  },
  {
    mode: "sip_verto",
    status:
      liveEndpointConfigured.rtcAsr && liveEndpointConfigured.kokoro && liveEndpointConfigured.freeswitchVerto
        ? endpointReady.rtcAsr && endpointReady.kokoro && endpointReady.freeswitchVerto
          ? "ready"
          : "unreachable"
        : "blocked",
    requiredComponents: ["ACC app", "FreeSWITCH/Verto", "rtc-asr", "Kokoro", "Pipecat Verto bridge"],
    startCommand: "npm run docker:sip-verto",
    evidenceCommand: "npm run pipecat:verto:live-proof",
    readinessRoute: "/api/pipecat-media-engine/readiness",
    caeHandoffCommand: "npm run cae:assert:handoff",
    detail: "Strict local SIP/Verto proof path for the reference stack.",
  },
];

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
      api: optionalEndpoints.caeApi,
      web: optionalEndpoints.caeWeb,
    },
    probes: {
      api: endpointProbes.caeApi ?? null,
      web: endpointProbes.caeWeb ?? null,
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
    endpoint: optionalEndpoints.rtcAsr,
    envVar: "RTC_ASR_BASE_URL",
    probe: endpointProbes.rtcAsr ?? null,
    configuredDetail: "Configured for selected live media modes.",
    defaultDetail: "Required only for selected live media modes.",
  }),
  optionalComponent({
    component: "Kokoro",
    configured: liveEndpointConfigured.kokoro,
    endpoint: optionalEndpoints.kokoro,
    envVar: "KOKORO_BASE_URL",
    probe: endpointProbes.kokoro ?? null,
    configuredDetail: "Configured for selected live media modes.",
    defaultDetail: "Required only for selected live media modes.",
  }),
  optionalComponent({
    component: "Pipecat browser bridge",
    configured: liveEndpointConfigured.browserWebRtcBridge,
    endpoint: optionalEndpoints.browserWebRtcBridge,
    envVar: "BROWSER_WEBRTC_BRIDGE_URL",
    probe: endpointProbes.browserWebRtcBridge ?? null,
    configuredDetail: "Configured for Browser voice proof modes.",
    defaultDetail: "Required only for Browser voice proof modes.",
  }),
  optionalComponent({
    component: "FreeSWITCH/Verto",
    configured: liveEndpointConfigured.freeswitchVerto,
    endpoint: optionalEndpoints.freeswitchVerto,
    envVar: "FREESWITCH_VERTO_URL",
    probe: endpointProbes.freeswitchVerto ?? null,
    configuredDetail: "Configured for SIP/Verto proof modes.",
    defaultDetail: "Required only for SIP/Verto proof modes.",
  }),
  optionalComponent({
    component: "ASSERT viewer",
    configured: liveEndpointConfigured.assertViewer,
    endpoint: optionalEndpoints.assertViewer,
    envVar: "ASSERT_VIEWER_URL",
    probe: endpointProbes.assertViewer ?? null,
    configuredDetail: "Configured for CAE/ASSERT handoff or local viewer workflows.",
    defaultDetail: "Used through CAE/ASSERT handoff or local viewer workflows.",
  }),
];

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

const report = {
  ok: blockers.length === 0,
  mode: "reliability_lab_phase_1_status",
  status: blockers.length === 0 ? "configured" : "blocked",
  defaultDemo: {
    status: "ready",
    notRequired: ["ConversationAgentEvals", "rtc-asr", "Kokoro", "FreeSWITCH", "ASSERT", "production credentials"],
    proofCommand: "npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json",
  },
  goldenScenario: {
    id: "cancellation-rescue",
    comparison: goldenComparison,
    caveat: "Unsafe baseline behavior is only a labeled demo fixture/profile; CAE/ASSERT owns imported run reports and comparisons.",
  },
  targetModes,
  optionalEndpoints,
  endpointProbes,
  componentReadiness,
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

console.log(JSON.stringify(report, null, 2));
