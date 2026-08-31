import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(__dirname, "..", "..");
const liveEndpointEnvVars = [
  "ACC_RELIABILITY_TARGET_MODE",
  "RTC_ASR_BASE_URL",
  "KOKORO_BASE_URL",
  "BROWSER_WEBRTC_BRIDGE_URL",
  "FREESWITCH_VERTO_URL",
  "ASSERT_VIEWER_URL",
];
const expectedEndpointEnvVars = [
  "ACC_RELIABILITY_TARGET_MODE",
  "CAE_API_URL",
  "CAE_WEB_URL",
  "ASSERT_VIEWER_URL",
  "RTC_ASR_BASE_URL",
  "KOKORO_BASE_URL",
  "BROWSER_WEBRTC_BRIDGE_URL",
  "FREESWITCH_VERTO_URL",
];
const expectedValidationProvenance = {
  manifestPath: "stack/versions.env",
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
};

test("docker reliability lab mounts shared artifacts into the app container", () => {
  const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "  app:");
  const end = lines.findIndex((line, index) => index > start && /^  [a-zA-Z0-9_-]+:/.test(line));
  const appService = lines.slice(start + 1, end === -1 ? undefined : end).join("\n");

  assert.match(appService, /volumes:\n(?:      .*\n)*      - \.\/artifacts:\/app\/artifacts\b/);
});

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
  assert.equal(payload.workState, "active");
  assert.equal(payload.defaultDemo.status, "ready");
  assert.ok(payload.defaultDemo.notRequired.includes("ConversationAgentEvals"));
  assert.ok(payload.defaultDemo.notRequired.includes("rtc-asr"));
  assert.equal(payload.goldenScenario.id, "cancellation-rescue");
  assert.deepEqual(payload.provenanceContract.requiredRunFields, [
    "runtimeMode",
    "targetMode",
    "candidateProfile",
    "promptVersion",
    "model",
    "seed",
    "componentVersions",
    "evidenceArtifacts",
  ]);
  assert.equal(payload.provenanceContract.manifestPath, "stack/versions.env");
  assert.ok(payload.provenanceContract.evidenceArtifacts.includes("artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json"));
  assert.deepEqual(
    payload.evidenceInventory.map((item: { id: string; artifact: string; producerCommand: string }) => [
      item.id,
      item.artifact,
      item.producerCommand,
    ]),
    [
      [
        "controlled_candidate_proof",
        "artifacts/demo-proof-latest.json",
        "npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json",
      ],
      [
        "cae_assert_request",
        "artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json",
        "npm run cae:assert:handoff",
      ],
      [
        "browser_live_media_manifest",
        "artifacts/browser-webrtc-live-proof/browser-webrtc-live-proof-manifest.json",
        "npm run browser-webrtc:live-proof",
      ],
      ["sip_verto_live_manifest", "artifacts/verto-sip-live-proof/manifest.json", "npm run pipecat:verto:live-proof"],
      [
        "signalwire_readiness",
        "artifacts/signalwire-freeswitch-readiness/readiness.json",
        "npm run signalwire:freeswitch:readiness -- --render",
      ],
    ],
  );
  assert.deepEqual(payload.evidenceInventory[2].requiredFor, ["browser_webrtc"]);
  assert.ok(payload.evidenceInventory[3].validates.includes("caller_playback_confirmed"));
  assert.deepEqual(
    payload.handoffChecklist.map((step: { id: string; command: string }) => [step.id, step.command]),
    [
      ["select_target_mode", "npm run reliability:lab"],
      [
        "capture_controlled_candidate",
        "npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json",
      ],
      ["capture_selected_media_proof", "Run the selected target mode evidence command from targetModes[].evidenceCommand."],
      ["generate_cae_assert_request", "npm run cae:assert:handoff"],
    ],
  );
  assert.deepEqual(payload.handoffChecklist[2].requiredFor, ["browser_webrtc", "sip_verto", "signalwire_pstn"]);
  assert.ok(
    payload.handoffChecklist[3].requiredEvidence.includes(
      "artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json",
    ),
  );
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
    payload.goldenScenario.verdictEvidenceChecklist.map((item: { id: string; route: string }) => [item.id, item.route]),
    [
      ["transcript", "/api/calls/{callId}/transcript"],
      ["event_trace", "/api/calls/{callId}/events"],
      ["latency", "/api/calls/{callId}/latency"],
      ["final_state", "/api/calls/{callId}"],
      ["media", "artifacts/browser-webrtc-live-proof/browser-webrtc-live-proof-manifest.json"],
      ["provenance", "artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json"],
    ],
  );
  assert.deepEqual(payload.goldenScenario.verdictEvidenceChecklist.find((item: { id: string }) => item.id === "media")?.requiredFor, [
    "browser_webrtc",
    "sip_verto",
    "signalwire_pstn",
  ]);
  assert.equal(payload.selectedTargetMode.mode, "fixture");
  assert.equal(payload.selectedTargetMode.requestedVia, "default");
  assert.equal(payload.selectedTargetMode.validationCommand, "npm run proof");
  assert.equal(payload.labEntryPoint.id, "fixture_lab_entrypoint");
  assert.equal(payload.labEntryPoint.mode, "fixture");
  assert.equal(payload.labEntryPoint.runProfile, "local_fixture");
  assert.equal(payload.labEntryPoint.workState, payload.labEntryPoint.evidenceSummary.handoffReady ? "done" : "active");
  assert.deepEqual(payload.labEntryPoint.blockingSummary.endpointBlockers, []);
  assert.equal(payload.labEntryPoint.blockingSummary.blockerCount, payload.labEntryPoint.blockingSummary.evidenceBlockers.length);
  assert.equal(payload.labEntryPoint.blockingSummary.endpointReady, true);
  assert.equal(payload.labEntryPoint.blockingSummary.evidenceReady, payload.labEntryPoint.evidenceSummary.handoffReady);
  assert.equal(payload.labEntryPoint.blockingSummary.handoffReady, payload.labEntryPoint.evidenceSummary.handoffReady);
  assert.equal(payload.labEntryPoint.recommendedNextStep.category, payload.labEntryPoint.evidenceSummary.handoffReady ? "handoff" : "evidence");
  assert.equal(
    payload.labEntryPoint.recommendedNextStep.step,
    payload.labEntryPoint.evidenceSummary.handoffReady ? "ready_for_cae_import" : payload.labEntryPoint.nextEvidenceAction.step,
  );
  assert.deepEqual(
    payload.labEntryPoint.commands.map((command: { step: string; command: string }) => [command.step, command.command]),
    [
      ["start_or_connect_stack", "npm run proof"],
      ["validate_readiness", "npm run proof"],
      ["capture_evidence", "npm run proof:bundle"],
      ["generate_handoff_request", "npm run cae:assert:handoff"],
    ],
  );
  assert.deepEqual(payload.selectedTargetMode.labEntryPoint, payload.labEntryPoint);
  assert.deepEqual(payload.recommendedNextStep, payload.labEntryPoint.recommendedNextStep);
  assert.ok(["endpoint", "evidence", "handoff"].includes(payload.recommendedNextStep.category));
  assert.equal(typeof payload.recommendedNextStep.command, "string");
  assert.equal(payload.selectedRunProfile.id, "local_fixture");
  assert.equal(payload.selectedRunProfile.requestedForTargetMode, "fixture");
  assert.deepEqual(
    payload.selectedRunProfile.evidenceStatus.map((item: { artifact: string; exists: boolean }) => [
      item.artifact,
      typeof item.exists,
    ]),
    [
      ["artifacts/demo-proof-latest.json", "boolean"],
      ["artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json", "boolean"],
    ],
  );
  assert.equal(payload.selectedRunProfile.evidenceSummary.total, 2);
  assert.equal(typeof payload.selectedRunProfile.evidenceSummary.complete, "boolean");
  assert.equal(typeof payload.selectedRunProfile.evidenceSummary.freshForHandoff, "boolean");
  assert.equal(typeof payload.selectedRunProfile.evidenceSummary.handoffReady, "boolean");
  assert.deepEqual(payload.selectedRunProfile.evidenceSummary.handoffBlockers, payload.selectedRunProfile.handoffBlockers);
  assert.equal(payload.selectedRunProfile.handoffReady, payload.selectedRunProfile.evidenceSummary.handoffReady);
  assert.equal(payload.selectedRunProfile.nextAction.step, "run_profile_validation");
  assert.equal(payload.selectedRunProfile.nextAction.command, "npm run proof");
  assert.deepEqual(
    payload.selectedTargetMode.handoffChecklist.map((step: { id: string }) => step.id),
    ["select_target_mode", "capture_controlled_candidate", "generate_cae_assert_request"],
  );
  assert.deepEqual(
    payload.selectedTargetMode.evidenceInventory.map((item: { id: string }) => item.id),
    ["controlled_candidate_proof", "cae_assert_request"],
  );
  assert.deepEqual(
    payload.selectedTargetMode.evidenceStatus.map((item: { id: string; artifact: string; exists: boolean; producerCommand: string }) => [
      item.id,
      item.artifact,
      typeof item.exists,
      item.producerCommand,
    ]),
    [
      [
        "controlled_candidate_proof",
        "artifacts/demo-proof-latest.json",
        "boolean",
        "npm run proof -- --out artifacts/demo-proof.json --latest-out artifacts/demo-proof-latest.json",
      ],
      ["cae_assert_request", "artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json", "boolean", "npm run cae:assert:handoff"],
    ],
  );
  for (const item of payload.selectedTargetMode.evidenceStatus as Array<{
    exists: boolean;
    sizeBytes: number | null;
    updatedAt: string | null;
    ageMs: number | null;
    staleAfterMs: number;
    freshForHandoff: boolean;
  }>) {
    assert.equal(typeof item.sizeBytes === "number" || item.sizeBytes === null, true);
    assert.equal(typeof item.updatedAt === "string" || item.updatedAt === null, true);
    assert.equal(typeof item.ageMs === "number" || item.ageMs === null, true);
    assert.equal(item.staleAfterMs, 24 * 60 * 60 * 1000);
    assert.equal(typeof item.freshForHandoff, "boolean");
    assert.equal(item.exists, item.sizeBytes !== null);
    assert.equal(item.exists, item.updatedAt !== null);
    assert.equal(item.exists, item.ageMs !== null);
  }
  assert.equal(payload.selectedTargetMode.evidenceSummary.total, 2);
  assert.equal(payload.selectedTargetMode.evidenceSummary.present + payload.selectedTargetMode.evidenceSummary.missing, 2);
  assert.equal(payload.selectedTargetMode.evidenceSummary.complete, payload.selectedTargetMode.evidenceSummary.missing === 0);
  assert.equal(payload.selectedTargetMode.evidenceSummary.freshForHandoff, payload.selectedTargetMode.evidenceSummary.missing === 0 && payload.selectedTargetMode.evidenceSummary.stale === 0);
  assert.equal(payload.selectedTargetMode.evidenceSummary.handoffReady, payload.selectedTargetMode.evidenceSummary.handoffBlockers.length === 0);
  assert.deepEqual(payload.selectedTargetMode.handoffBlockers, payload.selectedTargetMode.evidenceSummary.handoffBlockers);
  assert.equal(payload.selectedTargetMode.handoffReady, payload.selectedTargetMode.evidenceSummary.handoffReady);
  assert.ok(
    payload.selectedTargetMode.handoffBlockers.every((blocker: string) =>
      /^missing evidence artifact: |^stale evidence artifact: /.test(blocker),
    ),
  );
  if (payload.selectedTargetMode.nextMissingEvidence) {
    assert.ok(["controlled_candidate_proof", "cae_assert_request"].includes(payload.selectedTargetMode.nextMissingEvidence.id));
    const staleSelectedEvidence = payload.selectedTargetMode.evidenceStatus.find(
      (item: { exists: boolean; freshForHandoff: boolean }) => item.exists && item.freshForHandoff === false,
    );
    if (staleSelectedEvidence) {
      assert.equal(payload.selectedTargetMode.nextEvidenceAction.step, "refresh_stale_evidence");
      assert.equal(payload.selectedTargetMode.nextEvidenceAction.evidence, staleSelectedEvidence.artifact);
    } else {
      assert.equal(payload.selectedTargetMode.nextEvidenceAction.step, "capture_missing_evidence");
      assert.equal(payload.selectedTargetMode.nextEvidenceAction.evidence, payload.selectedTargetMode.nextMissingEvidence.artifact);
    }
  } else {
    assert.ok(["refresh_stale_evidence", "validate_existing_evidence"].includes(payload.selectedTargetMode.nextEvidenceAction.step));
  }
  assert.match(payload.selectedTargetMode.nextEvidenceAction.detail, /evidence/);
  assert.deepEqual(payload.selectedTargetMode.nextAction, {
    step: "run_controlled_candidate",
    command: "npm run proof",
    evidence: "artifacts/demo-proof-latest.json",
    detail: "Run the sidecar-free cancellation-rescue proof and inspect the deterministic scorecard.",
  });
  assert.deepEqual(payload.readinessSummary, {
    selectedTargetMode: "fixture",
    targetModesByStatus: { ready: 1, blocked: 4 },
    runProfilesByStatus: { ready: 1, blocked: 2 },
    componentsByStatus: { ready: 1, not_configured: 1, not_required: 5 },
    configuredOptionalEndpoints: 0,
    blockers: 1,
  });
  assert.deepEqual(payload.readinessVocabulary, [
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
  ]);
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
  assert.deepEqual(payload.targetModes[0].requiredEndpointEnvVars, []);
  assert.deepEqual(payload.targetModes[0].missingEndpointEnvVars, []);
  assert.deepEqual(payload.targetModes[0].optionalEndpointEnvVars, []);
  assert.deepEqual(payload.targetModes[1].requiredEndpointEnvVars, [
    "RTC_ASR_BASE_URL",
    "KOKORO_BASE_URL",
    "BROWSER_WEBRTC_BRIDGE_URL",
  ]);
  assert.deepEqual(payload.targetModes[1].missingEndpointEnvVars, [
    "RTC_ASR_BASE_URL",
    "KOKORO_BASE_URL",
    "BROWSER_WEBRTC_BRIDGE_URL",
  ]);
  assert.deepEqual(payload.targetModes[1].optionalEndpointEnvVars, []);
  assert.deepEqual(payload.targetModes[1].requiredComponents, ["ACC app", "rtc-asr", "Kokoro", "Pipecat browser bridge"]);
  assert.deepEqual(
    payload.targetModes[1].endpointStatus.map((endpoint: { key: string; status: string; configured: boolean; ready: boolean }) => [
      endpoint.key,
      endpoint.status,
      endpoint.configured,
      endpoint.ready,
    ]),
    [
      ["rtcAsr", "missing", false, false],
      ["kokoro", "missing", false, false],
      ["browserWebRtcBridge", "missing", false, false],
    ],
  );
  assert.deepEqual(payload.targetModes[1].blockers, [
    "rtc-asr endpoint is not configured (RTC_ASR_BASE_URL).",
    "Kokoro endpoint is not configured (KOKORO_BASE_URL).",
    "Pipecat browser bridge endpoint is not configured (BROWSER_WEBRTC_BRIDGE_URL).",
  ]);
  assert.deepEqual(payload.targetModes[1].nextAction, {
    step: "configure_browser_media_endpoints",
    command: "npm run docker:browser-webrtc",
    evidence: "/api/browser-webrtc/readiness",
    detail: "Bring up rtc-asr, Kokoro, and the Pipecat browser bridge before capturing live browser evidence.",
  });
  assert.deepEqual(payload.targetModes[2].blockers, [
    "ConversationAgentEvals API endpoint is not configured (CAE_API_URL).",
    "ConversationAgentEvals web endpoint is not configured (CAE_WEB_URL).",
  ]);
  assert.deepEqual(payload.targetModes[0].validationGate, {
    fastestCheck: "npm run proof",
    evidenceArtifact: "artifacts/demo-proof-latest.json",
    successCriteria: ["controlled_candidate_scorecard_passes", "proof_bundle_written"],
    liveMediaRequired: false,
    provenance: expectedValidationProvenance,
  });
  assert.deepEqual(payload.targetModes[1].validationGate, {
    fastestCheck: "npm run browser-webrtc:check",
    evidenceArtifact: "artifacts/browser-webrtc-live-proof/browser-webrtc-live-proof-manifest.json",
    successCriteria: ["pipecat_browser_bridge_ready", "rtc_asr_ready", "tts_ready"],
    liveMediaRequired: true,
    provenance: expectedValidationProvenance,
  });
  assert.deepEqual(payload.targetModes[2].requiredComponents, [
    "ACC app",
    "rtc-asr",
    "Kokoro",
    "Pipecat browser bridge",
    "ConversationAgentEvals",
    "ASSERT viewer",
  ]);
  assert.deepEqual(payload.targetModes[2].requiredEndpointEnvVars, ["CAE_API_URL", "CAE_WEB_URL"]);
  assert.deepEqual(payload.targetModes[2].missingEndpointEnvVars, ["CAE_API_URL", "CAE_WEB_URL"]);
  assert.deepEqual(payload.targetModes[2].optionalEndpointEnvVars, [
    "ASSERT_VIEWER_URL",
    "RTC_ASR_BASE_URL",
    "KOKORO_BASE_URL",
    "BROWSER_WEBRTC_BRIDGE_URL",
  ]);
  assert.deepEqual(
    payload.targetModes[2].endpointStatus.map((endpoint: { key: string; status: string; configured: boolean; ready: boolean }) => [
      endpoint.key,
      endpoint.status,
      endpoint.configured,
      endpoint.ready,
    ]),
    [
      ["caeApi", "missing", false, false],
      ["caeWeb", "missing", false, false],
      ["assertViewer", "missing", false, false],
      ["rtcAsr", "missing", false, false],
      ["kokoro", "missing", false, false],
      ["browserWebRtcBridge", "missing", false, false],
    ],
  );
  assert.deepEqual(payload.targetModes[3].requiredEndpointEnvVars, [
    "RTC_ASR_BASE_URL",
    "KOKORO_BASE_URL",
    "FREESWITCH_VERTO_URL",
  ]);
  assert.deepEqual(payload.targetModes[3].missingEndpointEnvVars, [
    "RTC_ASR_BASE_URL",
    "KOKORO_BASE_URL",
    "FREESWITCH_VERTO_URL",
  ]);
  assert.equal(payload.targetModes[3].caeHandoffCommand, "npm run cae:assert:handoff");
  assert.equal(payload.targetModes[4].signalwireTrunkMode, "registration");
  assert.deepEqual(payload.targetModes[4].requiredSignalwireEnvVars, [
    "SIGNALWIRE_FROM_NUMBER",
    "FREESWITCH_PUBLIC_SIP_HOST",
    "SIGNALWIRE_SOURCE_IP_PROBE",
    "SIGNALWIRE_PROVIDER_INGRESS_CIDRS",
    "SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH",
    "SIGNALWIRE_SPACE_URL",
    "SIGNALWIRE_SIP_USERNAME",
    "SIGNALWIRE_SIP_PASSWORD",
  ]);
  assert.deepEqual(payload.targetModes[4].missingSignalwireEnvVars, payload.targetModes[4].requiredSignalwireEnvVars);
  assert.ok(payload.targetModes[4].blockers.includes("SignalWire PSTN readiness env is not configured (SIGNALWIRE_FROM_NUMBER)."));
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
  assert.deepEqual(payload.readinessProbePolicy, {
    timeoutEnvVar: "ACC_RELIABILITY_LAB_PROBE_TIMEOUT_MS",
    defaultTimeoutMs: 750,
    maxTimeoutMs: 5000,
    timeoutMs: 750,
    probesConfiguredEndpoints: true,
    skippedWhenEnvMissing: true,
    transports: ["http_get", "tcp_connect"],
    routeOverrides: {
      rtcAsr: "/ready",
      kokoro: "/health",
      browserWebRtcBridge: "/health",
    },
  });
  assert.equal(payload.repositoryContracts.stackManifest.path, "stack/versions.env");
  assert.equal(payload.repositoryContracts.stackManifest.exists, true);
  assert.equal(payload.repositoryContracts.stackManifest.values.ACC_APP_URL, "http://127.0.0.1:8026");
  assert.equal(payload.repositoryContracts.stackManifest.values.TOOLHIVE_VERSION, "v0.40.0");
  assert.ok(payload.repositoryContracts.requiredStackManifestKeys.includes("CAE_API_URL"));
  assert.ok(payload.repositoryContracts.requiredStackManifestKeys.includes("TOOLHIVE_VERSION"));
  assert.ok(payload.repositoryContracts.reliabilityDocExists);
  assert.ok(payload.readinessVocabulary.includes("missing"));
  for (const mode of payload.targetModes as Array<{ endpointStatus: Array<{ status: string }> }>) {
    for (const endpoint of mode.endpointStatus) {
      assert.ok(payload.readinessVocabulary.includes(endpoint.status));
    }
  }
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
      provenance: expectedValidationProvenance,
    },
  );
});

test("reliability lab status exposes requested target mode selection", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/reliability-lab-status.mjs"], {
    cwd: repoRoot,
    env: {
      ...withClearedLiveEndpointEnv(),
      ACC_RELIABILITY_TARGET_MODE: "browser_webrtc",
      CAE_API_URL: "",
      CAE_WEB_URL: "",
    },
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.status, "blocked");
  assert.equal(payload.workState, "blocked");
  assert.equal(payload.selectedTargetMode.mode, "browser_webrtc");
  assert.equal(payload.selectedTargetMode.requestedVia, "ACC_RELIABILITY_TARGET_MODE");
  assert.equal(payload.selectedTargetMode.validationCommand, "npm run browser-webrtc:check");
  assert.equal(payload.selectedTargetMode.evidenceCommand, "npm run browser-webrtc:live-proof");
  assert.equal(payload.selectedTargetMode.nextAction.step, "configure_browser_media_endpoints");
  assert.equal(payload.selectedRunProfile.id, "live_media_lab");
  assert.equal(payload.selectedRunProfile.requestedForTargetMode, "browser_webrtc");
  assert.equal(payload.selectedRunProfile.nextAction.step, "unblock_run_profile");
  assert.ok(["capture_missing_evidence", "refresh_stale_evidence", "validate_existing_evidence"].includes(payload.selectedRunProfile.nextEvidenceAction.step));
  assert.deepEqual(payload.selectedRunProfile.evidence, [
    "artifacts/demo-proof-latest.json",
    "artifacts/cae-assert-handoff/conversation-agent-evals-assert-request.json",
    "artifacts/browser-webrtc-live-proof/browser-webrtc-live-proof-manifest.json",
  ]);
  assert.equal(
    payload.selectedRunProfile.nextAction.evidence,
    "artifacts/browser-webrtc-live-proof/browser-webrtc-live-proof-manifest.json",
  );
  assert.deepEqual(payload.selectedRunProfile.handoffBlockers, payload.selectedRunProfile.evidenceSummary.handoffBlockers);
  assert.equal(payload.selectedRunProfile.handoffReady, payload.selectedRunProfile.evidenceSummary.handoffReady);
  assert.deepEqual(
    payload.selectedTargetMode.handoffChecklist.map((step: { id: string }) => step.id),
    ["select_target_mode", "capture_controlled_candidate", "capture_selected_media_proof", "generate_cae_assert_request"],
  );
  assert.deepEqual(
    payload.selectedTargetMode.evidenceInventory.map((item: { id: string }) => item.id),
    ["controlled_candidate_proof", "cae_assert_request", "browser_live_media_manifest"],
  );
  assert.equal(payload.selectedTargetMode.evidenceSummary.total, 3);
  assert.equal(payload.selectedTargetMode.evidenceSummary.present + payload.selectedTargetMode.evidenceSummary.missing, 3);
  assert.equal(payload.selectedTargetMode.evidenceSummary.complete, payload.selectedTargetMode.evidenceSummary.missing === 0);
  assert.ok(payload.selectedTargetMode.blockers.includes("rtc-asr endpoint is not configured (RTC_ASR_BASE_URL)."));
});

test("reliability lab status blocks invalid target mode selection", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/reliability-lab-status.mjs"], {
    cwd: repoRoot,
    env: {
      ...withClearedLiveEndpointEnv(),
      ACC_RELIABILITY_TARGET_MODE: "unknown_mode",
      CAE_API_URL: "",
      CAE_WEB_URL: "",
    },
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.selectedTargetMode.mode, "unknown_mode");
  assert.equal(payload.selectedTargetMode.status, "blocked");
  assert.ok(payload.selectedTargetMode.validModes.includes("fixture"));
  assert.equal(payload.selectedRunProfile.id, null);
  assert.equal(payload.selectedRunProfile.nextAction.step, "select_valid_target_mode");
  assert.deepEqual(payload.selectedTargetMode.nextAction, {
    step: "select_valid_target_mode",
    command: "Set ACC_RELIABILITY_TARGET_MODE to one of targetModes[].mode",
    evidence: "/api/reliability",
    detail: "The requested target mode is unknown, so no validation or evidence command can run.",
  });
  assert.ok(payload.blockers.some((blocker: string) => blocker.includes("ACC_RELIABILITY_TARGET_MODE must be one of")));
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
  assert.equal(payload.readinessSummary.configuredOptionalEndpoints, 1);
  assert.deepEqual(payload.readinessSummary.targetModesByStatus, { ready: 1, blocked: 3, configured: 1 });
  assert.equal(payload.targetModes.find((mode: { mode: string }) => mode.mode === "fixture").status, "ready");
  assert.deepEqual(payload.targetModes.find((mode: { mode: string }) => mode.mode === "reliability_lab").blockers, []);
  assert.deepEqual(payload.targetModes.find((mode: { mode: string }) => mode.mode === "reliability_lab").missingEndpointEnvVars, []);
});

test("reliability lab status redacts configured endpoint secrets", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/reliability-lab-status.mjs"], {
    cwd: repoRoot,
    env: {
      ...withClearedLiveEndpointEnv(),
      CAE_API_URL: "https://cae-user:cae-secret@example.com:8443/api?token=leaky-token",
      CAE_WEB_URL: "https://web-user:web-secret@example.com/app?token=web-token",
      BROWSER_WEBRTC_BRIDGE_URL: "https://bridge-user:bridge-secret@example.com:9443/proof?token=bridge-token",
      ACC_RELIABILITY_LAB_PROBE_TIMEOUT_MS: "50",
    },
  });
  const payload = JSON.parse(result.stdout);
  const serialized = JSON.stringify(payload);

  assert.equal(payload.optionalEndpoints.caeApi, "https://example.com:8443");
  assert.equal(payload.optionalEndpoints.caeWeb, "https://example.com");
  assert.equal(payload.optionalEndpoints.browserWebRtcBridge, "https://example.com:9443");
  assert.equal(payload.readinessProbePolicy.timeoutMs, 50);
  assert.doesNotMatch(serialized, /cae-secret|web-secret|bridge-secret|leaky-token|web-token|bridge-token/);
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
  assert.equal(payload.readinessSummary.configuredOptionalEndpoints, 6);
  assert.deepEqual(payload.readinessSummary.componentsByStatus, { ready: 7 });
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
  assert.equal(payload.targetModes.find((mode: { mode: string }) => mode.mode === "browser_webrtc").nextAction.step, "validate_browser_media_path");
  assert.deepEqual(
    payload.targetModes.find((mode: { mode: string }) => mode.mode === "browser_webrtc").endpointStatus.map(
      (endpoint: { key: string; status: string }) => [endpoint.key, endpoint.status],
    ),
    [
      ["rtcAsr", "ready"],
      ["kokoro", "ready"],
      ["browserWebRtcBridge", "ready"],
    ],
  );
  assert.equal(payload.targetModes.find((mode: { mode: string }) => mode.mode === "reliability_lab").status, "ready");
  assert.equal(payload.targetModes.find((mode: { mode: string }) => mode.mode === "sip_verto").status, "ready");
  assert.equal(payload.targetModes.find((mode: { mode: string }) => mode.mode === "signalwire_pstn").status, "blocked");
  assert.deepEqual(payload.targetModes.find((mode: { mode: string }) => mode.mode === "signalwire_pstn").missingSignalwireEnvVars, [
    "SIGNALWIRE_FROM_NUMBER",
    "FREESWITCH_PUBLIC_SIP_HOST",
    "SIGNALWIRE_SOURCE_IP_PROBE",
    "SIGNALWIRE_PROVIDER_INGRESS_CIDRS",
    "SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH",
    "SIGNALWIRE_SPACE_URL",
    "SIGNALWIRE_SIP_USERNAME",
    "SIGNALWIRE_SIP_PASSWORD",
  ]);
  assert.deepEqual(payload.targetModes.find((mode: { mode: string }) => mode.mode === "browser_webrtc").blockers, []);
  assert.deepEqual(payload.targetModes.find((mode: { mode: string }) => mode.mode === "browser_webrtc").missingEndpointEnvVars, []);
});

test("reliability entrypoint command returns only selected lab entry point", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/reliability-lab-status.mjs", "--entrypoint"], {
    cwd: repoRoot,
    env: {
      ...withClearedLiveEndpointEnv(),
      ACC_RELIABILITY_TARGET_MODE: "browser_webrtc",
      CAE_API_URL: "",
      CAE_WEB_URL: "",
    },
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.id, "browser_webrtc_lab_entrypoint");
  assert.equal(payload.mode, "browser_webrtc");
  assert.equal(payload.runProfile, "live_media_lab");
  assert.equal(payload.workState, "blocked");
  assert.deepEqual(payload.requiredEndpointEnvVars, ["RTC_ASR_BASE_URL", "KOKORO_BASE_URL", "BROWSER_WEBRTC_BRIDGE_URL"]);
  assert.deepEqual(payload.missingEndpointEnvVars, ["RTC_ASR_BASE_URL", "KOKORO_BASE_URL", "BROWSER_WEBRTC_BRIDGE_URL"]);
  assert.equal(payload.blockingSummary.endpointReady, false);
  assert.equal(payload.blockingSummary.evidenceReady, payload.evidenceSummary.handoffReady);
  assert.equal(payload.blockingSummary.firstBlocker, "rtc-asr endpoint is not configured (RTC_ASR_BASE_URL).");
  assert.equal(payload.blockingSummary.blockerCount, payload.blockingSummary.endpointBlockers.length + payload.blockingSummary.evidenceBlockers.length);
  assert.deepEqual(payload.recommendedNextStep, {
    category: "endpoint",
    step: "configure_browser_media_endpoints",
    command: "npm run docker:browser-webrtc",
    evidence: "/api/browser-webrtc/readiness",
    detail: "Bring up rtc-asr, Kokoro, and the Pipecat browser bridge before capturing live browser evidence.",
  });
  assert.deepEqual(
    payload.actionQueue.map((item: { step: string; command: string; status: string; blockedBy: string | null }) => [
      item.step,
      item.command,
      item.status,
      item.blockedBy,
    ]),
    [
      ["start_or_connect_stack", "npm run docker:browser-webrtc", "pending", null],
      ["validate_readiness", "npm run browser-webrtc:check", "blocked", "rtc-asr endpoint is not configured (RTC_ASR_BASE_URL)."],
      [
        "capture_evidence",
        payload.nextEvidenceAction.command,
        "blocked",
        "rtc-asr endpoint is not configured (RTC_ASR_BASE_URL).",
      ],
      [
        "generate_handoff_request",
        "npm run cae:assert:handoff",
        "blocked",
        "rtc-asr endpoint is not configured (RTC_ASR_BASE_URL).",
      ],
    ],
  );
  assert.deepEqual(payload.actionQueueSummary, {
    state: "active",
    total: 4,
    completed: 0,
    pending: 1,
    blocked: 3,
    complete: false,
    progressPct: 0,
    activeOrdinal: 1,
    remaining: 4,
    hasRemaining: true,
    remainingAfterActive: 3,
    activeIsFinal: false,
    followUpOrdinal: 2,
    followUpStep: "validate_readiness",
    followUpStatus: "blocked",
    followUpCommand: "npm run browser-webrtc:check",
    followUpPurpose: "Run the fastest bounded readiness or proof gate for this selected mode.",
    activeStep: "start_or_connect_stack",
    activeStatus: "pending",
    activeRunnable: true,
    activeBlocked: false,
    activeCommand: "npm run docker:browser-webrtc",
    activePurpose: "Start local services or connect to the selected external endpoints for this target mode.",
    activeEvidence: null,
    activeRequiresEvidence: false,
    activeBlockedBy: null,
  });
  assert.equal(payload.evidenceSummary.total, 3);
  assert.equal(payload.evidenceSummary.present + payload.evidenceSummary.missing, 3);
  assert.equal(typeof payload.evidenceSummary.handoffReady, "boolean");
  assert.equal(typeof payload.evidenceSummary.freshForHandoff, "boolean");
  assert.ok(["capture_missing_evidence", "refresh_stale_evidence", "validate_existing_evidence"].includes(payload.nextEvidenceAction.step));
  assert.match(payload.nextEvidenceAction.detail, /evidence/);
  if (payload.nextMissingEvidence) {
    assert.ok(["controlled_candidate_proof", "cae_assert_request", "browser_live_media_manifest"].includes(payload.nextMissingEvidence.id));
  }
  assert.deepEqual(
    payload.commands.map((command: { step: string; command: string }) => [command.step, command.command]),
    [
      ["start_or_connect_stack", "npm run docker:browser-webrtc"],
      ["validate_readiness", "npm run browser-webrtc:check"],
      ["capture_evidence", "npm run browser-webrtc:live-proof"],
      ["generate_handoff_request", "npm run cae:assert:handoff"],
    ],
  );
});

test("reliability lab status narrows SignalWire PSTN env for IP-auth trunks", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/reliability-lab-status.mjs"], {
    cwd: repoRoot,
    env: {
      ...withClearedLiveEndpointEnv(),
      SIGNALWIRE_TRUNK_MODE: "ip_auth",
      SIGNALWIRE_FROM_NUMBER: "+12025550123",
      FREESWITCH_PUBLIC_SIP_HOST: "sip.example.test",
      SIGNALWIRE_SOURCE_IP_PROBE: "54.172.60.0",
      SIGNALWIRE_PROVIDER_INGRESS_CIDRS: "54.172.60.0/30",
      SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH: "artifacts/freeswitch-signalwire/external-sip-reachability.json",
      CAE_API_URL: "",
      CAE_WEB_URL: "",
    },
  });
  const payload = JSON.parse(result.stdout);
  const signalwireMode = payload.targetModes.find((mode: { mode: string }) => mode.mode === "signalwire_pstn");

  assert.equal(signalwireMode.signalwireTrunkMode, "ip_auth");
  assert.deepEqual(signalwireMode.requiredSignalwireEnvVars, [
    "SIGNALWIRE_FROM_NUMBER",
    "FREESWITCH_PUBLIC_SIP_HOST",
    "SIGNALWIRE_SOURCE_IP_PROBE",
    "SIGNALWIRE_PROVIDER_INGRESS_CIDRS",
    "SIGNALWIRE_EXTERNAL_SIP_REACHABILITY_PROOF_PATH",
  ]);
  assert.deepEqual(signalwireMode.missingSignalwireEnvVars, []);
  assert.ok(!signalwireMode.blockers.some((blocker: string) => blocker.includes("SIGNALWIRE_SIP_PASSWORD")));
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

test("reliability lab status reports malformed configured endpoints without crashing", async () => {
  const result = await execFileAsync(process.execPath, ["scripts/reliability-lab-status.mjs"], {
    cwd: repoRoot,
    env: {
      ...withClearedLiveEndpointEnv(),
      CAE_API_URL: "not-a-url",
      CAE_WEB_URL: "also-not-a-url",
      FREESWITCH_VERTO_URL: "invalid-verto-url",
    },
  });
  const payload = JSON.parse(result.stdout);
  const cae = payload.componentReadiness.find(
    (component: { component: string }) => component.component === "ConversationAgentEvals",
  );
  const verto = payload.componentReadiness.find(
    (component: { component: string }) => component.component === "FreeSWITCH/Verto",
  );

  assert.equal(cae.status, "unreachable");
  assert.equal(cae.probes.api.error, "InvalidURL");
  assert.equal(cae.probes.web.error, "InvalidURL");
  assert.equal(verto.status, "unreachable");
  assert.equal(verto.probe.error, "InvalidURL");
  assert.ok(payload.blockers.some((blocker: string) => blocker.includes("configured but unreachable")));
});
