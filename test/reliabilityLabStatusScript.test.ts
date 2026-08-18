import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(__dirname, "..", "..");
const liveEndpointEnvVars = [
  "RTC_ASR_BASE_URL",
  "KOKORO_BASE_URL",
  "BROWSER_WEBRTC_BRIDGE_URL",
  "FREESWITCH_VERTO_URL",
  "ASSERT_VIEWER_URL",
];
const expectedEndpointEnvVars = [
  "CAE_API_URL",
  "CAE_WEB_URL",
  "ASSERT_VIEWER_URL",
  "RTC_ASR_BASE_URL",
  "KOKORO_BASE_URL",
  "BROWSER_WEBRTC_BRIDGE_URL",
  "FREESWITCH_VERTO_URL",
];

function withClearedLiveEndpointEnv() {
  const env = { ...process.env };
  for (const name of liveEndpointEnvVars) {
    delete env[name];
  }
  return env;
}

async function listen(server: Server | net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function withHttpServers<T>(
  count: number,
  run: (urls: string[]) => Promise<T>,
): Promise<T> {
  const servers = Array.from({ length: count }, () =>
    createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, ready: true }));
    }),
  );
  try {
    const ports = await Promise.all(servers.map((server) => listen(server)));
    return await run(ports.map((port) => `http://127.0.0.1:${port}`));
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

test("reliability lab status reports explicit blockers without starting sidecars", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/reliability-lab-status.mjs"], {
    cwd: repoRoot,
    env: {
      ...withClearedLiveEndpointEnv(),
      CAE_API_URL: "",
      CAE_WEB_URL: "",
    },
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.mode, "reliability_lab_phase_1_status");
  assert.equal(payload.status, "blocked");
  assert.equal(payload.defaultDemo.status, "ready");
  assert.ok(payload.defaultDemo.notRequired.includes("ConversationAgentEvals"));
  assert.ok(payload.defaultDemo.notRequired.includes("rtc-asr"));
  assert.equal(payload.goldenScenario.id, "cancellation-rescue");
  assert.deepEqual(
    payload.goldenScenario.comparison.map((signal: { signal: string; unsafeBaseline: string; controlledCandidate: string }) => [
      signal.signal,
      signal.unsafeBaseline,
      signal.controlledCandidate,
    ]),
    [
      ["Cancellation intent", "detected", "detected"],
      ["Policy hold", "missing", "present"],
      ["Unapproved offer", "emitted", "absent"],
      ["Tool/runtime failure", "autonomous_continuation", "fail_closed_handoff"],
      ["Final disposition", "ambiguous", "recorded"],
      ["Overall release gate", "block", "candidate_passes"],
    ],
  );
  assert.match(payload.goldenScenario.caveat, /labeled demo fixture/);
  assert.deepEqual(
    payload.targetModes.map((mode: { mode: string; status: string; startCommand: string; validationCommand: string; evidenceCommand: string; readinessRoute: string }) => [
      mode.mode,
      mode.status,
      mode.startCommand,
      mode.validationCommand,
      mode.evidenceCommand,
      mode.readinessRoute,
    ]),
    [
      ["fixture", "ready", "npm run proof", "npm run proof", "npm run proof:bundle", "/health"],
      ["browser_webrtc", "blocked", "npm run docker:browser-webrtc", "npm run browser-webrtc:check", "npm run browser-webrtc:live-proof", "/api/browser-webrtc/readiness"],
      ["reliability_lab", "blocked", "npm run docker:reliability-lab", "npm run reliability:lab", "npm run proof:bundle", "/api/reliability"],
      ["sip_verto", "blocked", "npm run docker:sip-verto", "npm run pipecat:verto:check", "npm run pipecat:verto:live-proof", "/api/pipecat-media-engine/readiness"],
      ["signalwire_pstn", "blocked", "npm run docker:sip-verto", "npm run signalwire:freeswitch:readiness", "npm run signalwire:freeswitch:readiness -- --render", "/api/pipecat-media-engine/readiness"],
    ],
  );
  assert.deepEqual(payload.targetModes[1].requiredComponents, ["ACC app", "rtc-asr", "Kokoro", "Pipecat browser bridge"]);
  assert.deepEqual(payload.targetModes[0].validationGate, {
    fastestCheck: "npm run proof",
    evidenceArtifact: "artifacts/demo-proof-latest.json",
    successCriteria: ["controlled_candidate_scorecard_passes", "proof_bundle_written"],
    liveMediaRequired: false,
  });
  assert.deepEqual(payload.targetModes[1].validationGate, {
    fastestCheck: "npm run browser-webrtc:check",
    evidenceArtifact: "artifacts/browser-webrtc-live-proof/browser-webrtc-live-proof-manifest.json",
    successCriteria: ["pipecat_browser_bridge_ready", "rtc_asr_ready", "tts_ready"],
    liveMediaRequired: true,
  });
  assert.deepEqual(payload.targetModes[2].requiredComponents, [
    "ACC app",
    "rtc-asr",
    "Kokoro",
    "Pipecat browser bridge",
    "ConversationAgentEvals",
    "ASSERT viewer",
  ]);
  assert.equal(payload.targetModes[3].caeHandoffCommand, "npm run cae:assert:handoff");
  assert.ok(payload.blockers.some((blocker: string) => blocker.includes("ConversationAgentEvals API/web endpoints")));
  assert.deepEqual(
    payload.componentReadiness.map((component: { component: string; status: string }) => [component.component, component.status]),
    [
      ["default-scripted-demo", "ready"],
      ["ConversationAgentEvals", "not_configured"],
      ["rtc-asr", "not_required"],
      ["Kokoro", "not_required"],
      ["Pipecat browser bridge", "not_required"],
      ["FreeSWITCH/Verto", "not_required"],
      ["ASSERT viewer", "not_required"],
    ],
  );
  assert.ok(payload.repositoryContracts.packageScripts.includes("proof"));
  assert.ok(payload.repositoryContracts.composeProfiles.includes("browser-webrtc"));
  assert.deepEqual(payload.repositoryContracts.optionalEndpointEnvVars, expectedEndpointEnvVars);
  assert.equal(payload.repositoryContracts.stackManifest.path, "stack/versions.env");
  assert.equal(payload.repositoryContracts.stackManifest.exists, true);
  assert.equal(payload.repositoryContracts.stackManifest.values.ACC_APP_URL, "http://127.0.0.1:8026");
  assert.ok(payload.repositoryContracts.requiredStackManifestKeys.includes("CAE_API_URL"));
  assert.ok(payload.repositoryContracts.reliabilityDocExists);
  assert.equal(
    payload.componentReadiness.find((component: { component: string }) => component.component === "Pipecat browser bridge").envVar,
    "BROWSER_WEBRTC_BRIDGE_URL",
  );
  assert.deepEqual(
    payload.targetModes.find((mode: { mode: string }) => mode.mode === "reliability_lab").validationGate,
    {
      fastestCheck: "npm run reliability:lab",
      evidenceArtifact: "artifacts/agentic-call-center-demo/conversation-agent-evals-assert-request.json",
      successCriteria: ["cae_api_reachable", "cae_web_reachable", "selected_media_mode_ready_or_configured"],
      liveMediaRequired: false,
    },
  );
});

test("reliability lab status becomes configured when CAE endpoints are supplied", async () => {
  const result = await withHttpServers(2, async ([caeApiUrl, caeWebUrl]) =>
    execFileAsync(process.execPath, ["scripts/reliability-lab-status.mjs"], {
      cwd: repoRoot,
      env: {
        ...withClearedLiveEndpointEnv(),
        CAE_API_URL: caeApiUrl,
        CAE_WEB_URL: caeWebUrl,
      },
    }),
  );
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.status, "configured");
  assert.deepEqual(payload.blockers, []);
  assert.match(payload.optionalEndpoints.caeApi, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(payload.optionalEndpoints.caeWeb, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(
    payload.componentReadiness.find((component: { component: string }) => component.component === "ConversationAgentEvals").status,
    "ready",
  );
  assert.equal(payload.targetModes.find((mode: { mode: string }) => mode.mode === "fixture").status, "ready");
});

test("reliability lab status reports explicitly configured live media endpoints", async () => {
  const tcpServer = net.createServer((socket) => socket.end());
  const result = await withHttpServers(6, async ([caeApiUrl, caeWebUrl, rtcAsrUrl, kokoroUrl, browserBridgeUrl, assertViewerUrl]) => {
    const tcpPort = await listen(tcpServer);
    return execFileAsync(process.execPath, ["scripts/reliability-lab-status.mjs"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CAE_API_URL: caeApiUrl,
        CAE_WEB_URL: caeWebUrl,
        RTC_ASR_BASE_URL: rtcAsrUrl,
        KOKORO_BASE_URL: kokoroUrl,
        BROWSER_WEBRTC_BRIDGE_URL: browserBridgeUrl,
        FREESWITCH_VERTO_URL: `ws://127.0.0.1:${tcpPort}`,
        ASSERT_VIEWER_URL: assertViewerUrl,
      },
    });
  }).finally(() => new Promise<void>((resolve) => tcpServer.close(() => resolve())));
  const payload = JSON.parse(result.stdout);
  const statuses = Object.fromEntries(
    payload.componentReadiness.map((component: { component: string; status: string }) => [component.component, component.status]),
  );

  assert.equal(statuses["rtc-asr"], "ready");
  assert.equal(statuses.Kokoro, "ready");
  assert.equal(statuses["Pipecat browser bridge"], "ready");
  assert.equal(statuses["FreeSWITCH/Verto"], "ready");
  assert.equal(statuses["ASSERT viewer"], "ready");
  assert.equal(
    payload.componentReadiness.find((component: { component: string }) => component.component === "Pipecat browser bridge").envVar,
    "BROWSER_WEBRTC_BRIDGE_URL",
  );
  assert.match(payload.optionalEndpoints.rtcAsr, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(payload.optionalEndpoints.kokoro, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(payload.optionalEndpoints.browserWebRtcBridge, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(payload.optionalEndpoints.freeswitchVerto, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.match(payload.optionalEndpoints.assertViewer, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(payload.targetModes.find((mode: { mode: string }) => mode.mode === "browser_webrtc").status, "ready");
  assert.equal(payload.targetModes.find((mode: { mode: string }) => mode.mode === "reliability_lab").status, "ready");
  assert.equal(payload.targetModes.find((mode: { mode: string }) => mode.mode === "sip_verto").status, "ready");
  assert.equal(payload.targetModes.find((mode: { mode: string }) => mode.mode === "signalwire_pstn").status, "blocked");
});

test("reliability lab status distinguishes configured but unreachable endpoints", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/reliability-lab-status.mjs"], {
    cwd: repoRoot,
    env: {
      ...withClearedLiveEndpointEnv(),
      CAE_API_URL: "http://127.0.0.1:9",
      CAE_WEB_URL: "http://127.0.0.1:9",
      ACC_RELIABILITY_LAB_PROBE_TIMEOUT_MS: "50",
    },
  });
  const payload = JSON.parse(result.stdout);
  const cae = payload.componentReadiness.find((component: { component: string }) => component.component === "ConversationAgentEvals");

  assert.equal(payload.status, "blocked");
  assert.equal(cae.status, "unreachable");
  assert.equal(cae.configured, true);
  assert.equal(cae.reachable, false);
  assert.ok(payload.blockers.some((blocker: string) => blocker.includes("configured but unreachable")));
});
