import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("Pipecat media engine readiness proof runner writes route evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const scriptPath = path.join(repoRoot, "scripts", "pipecat-media-engine-readiness-proof.mjs");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pipecat-media-readiness-proof-"));
  const outputPath = path.join(tempDir, "pipecat-media-readiness-proof.json");
  const latestOutputPath = path.join(tempDir, "pipecat-media-readiness-proof-latest.json");

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "--out",
      outputPath,
      "--latest-out",
      latestOutputPath,
    ], {
      cwd: repoRoot,
    });

    assert.match(stdout, /Saved Pipecat media engine readiness artifact/);
    assert.match(stdout, /Updated latest Pipecat media engine readiness artifact/);
    assert.match(stdout, /Review ready: yes/);
    assert.match(stdout, /Review blockers: 0/);
    assert.match(stdout, /Acceptance criteria: 11\/11/);
    assert.match(stdout, /Failing criteria: none/);
    assert.match(stdout, /Next slice: flow_manager_runtime_qa/);
    assert.match(stdout, /Runtime prerequisites: acc_http, freeswitch_sip, freeswitch_esl, freeswitch_verto, pipecat_verto_bridge, rtc_asr_ws, kokoro_http/);

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      ok: boolean;
      issue: string;
      generatedAt: string;
      artifactSummary: {
        readinessStatus: string;
        reviewReady: boolean;
        reviewBlockers: string[];
        reviewBlockerCount: number;
        acceptanceCriteriaPassed: number;
        acceptanceCriteriaTotal: number;
        failingAcceptanceCriteria: string[];
        implementedAdapters: string[];
        blockedAdapters: string[];
        nextUnblockedSlice: {
          id: string;
          title: string;
          adapter: string;
          entryPoint: string;
          migrationStages: Array<{ id: string; verificationCommand: string }>;
        };
        liveSipProofAcceptance: { requiredManifestFlags: string[]; rejectedShortcuts: string[]; proofBundleCommand: string };
        remainingWorkCount: number;
        validationCommands: string[];
        nextValidationCommand: string;
        requiredRuntimeEndpoints: Array<{ id: string; evidence: string }>;
      };
      readiness: {
        ok: boolean;
        route: string;
        status: string;
        acceptanceCriteria: Array<{ name: string; passed: boolean }>;
      };
    };
    const latestArtifact = JSON.parse(await readFile(latestOutputPath, "utf8"));

    assert.equal(artifact.ok, true);
    assert.equal(artifact.issue, "agonza1/agentic-contact-center#214");
    assert.doesNotThrow(() => new Date(artifact.generatedAt).toISOString());
    assert.deepEqual(artifact.artifactSummary, {
      readinessStatus: "shared_media_and_flowmanager_runtime_complete",
      reviewReady: true,
      reviewBlockers: [],
      reviewBlockerCount: 0,
      acceptanceCriteriaPassed: 11,
      acceptanceCriteriaTotal: 11,
      failingAcceptanceCriteria: [],
      implementedAdapters: ["browser_webrtc", "sip_freeswitch_verto", "sip_freeswitch_rtp_legacy", "fixture_audio_injection"],
      blockedAdapters: ["signalwire_sip_trunk"],
      nextUnblockedSlice: {
        id: "flow_manager_runtime_qa",
        title: "Validate the Pipecat FlowManager runtime cutover",
        adapter: "pipecat_flows",
        entryPoint: "scripts/acc_pipecat_flow_manager.py",
        migrationStages: [
          { id: "sidecar_free_contract_lock", verificationCommand: "npm run pipecat:flows:contract" },
          { id: "flowmanager_node_handlers", verificationCommand: "npm run pipecat:flows:contract" },
          { id: "acc_runtime_adapter_cutover", verificationCommand: "npm run pipecat:flows:runtime" },
        ],
      },
      liveSipProofAcceptance: {
        requiredManifestFlags: ["live_capture", "rtc_asr_live", "pipecat_verto_webrtc", "caller_audible_playback"],
        requiredRuntimeEndpoints: [
          { id: "acc_http", defaultUrl: "http://127.0.0.1:8026", evidence: "ACC health/readiness routes are reachable while the SIP proof listener runs." },
          { id: "freeswitch_sip", defaultAddress: "127.0.0.1:5060", evidence: "A local softphone can place an accepted INVITE to extension 8600." },
          { id: "freeswitch_esl", defaultAddress: "127.0.0.1:8021", evidence: "freeswitch-acc-bridge can observe CHANNEL_ANSWER and RTP call events." },
          { id: "freeswitch_verto", defaultUrl: "ws://127.0.0.1:8081", evidence: "FreeSWITCH Verto accepts the registered acc-pipecat WebRTC agent leg." },
          { id: "pipecat_verto_bridge", defaultUrl: "http://127.0.0.1:8770/health", evidence: "Pipecat Verto sidecar is registered and ready to answer the FreeSWITCH WebRTC dialog." },
          { id: "rtc_asr_ws", env: "RTC_ASR_WS_URL", evidence: "The current call audio is transcribed into fresh rtc_asr_live final transcript evidence." },
          { id: "kokoro_http", env: "KOKORO_BASE_URL", evidence: "Kokoro returns TTS audio that is packetized and played back to the caller." },
        ],
        rejectedShortcuts: [
          "generated_media_without_live_capture",
          "stale_rtc_asr_evidence_reused_across_calls",
          "uuid_broadcast_without_caller_capture",
          "parked_esl_post_hangup_transcription",
        ],
        proofBundleCommand: "node scripts/live-sip-proof-bundle.mjs --require-live-capture --require-rtc-asr-live --require-caller-playback",
      },
      remainingWorkCount: 1,
      validationCommands: [
        "npm run pipecat:flows:contract",
        "npm run pipecat:flows:runtime",
        "python3 test/fixtures/pipecat_flowmanager_adapter_regression.py",
        "npm test",
        "curl -fsS http://127.0.0.1:8026/api/pipecat-media-engine/readiness",
      ],
      nextValidationCommand: "npm run pipecat:flows:contract",
      requiredRuntimeEndpoints: [
        { id: "acc_http", defaultUrl: "http://127.0.0.1:8026", evidence: "ACC health/readiness routes are reachable while the SIP proof listener runs." },
        { id: "freeswitch_sip", defaultAddress: "127.0.0.1:5060", evidence: "A local softphone can place an accepted INVITE to extension 8600." },
        { id: "freeswitch_esl", defaultAddress: "127.0.0.1:8021", evidence: "freeswitch-acc-bridge can observe CHANNEL_ANSWER and RTP call events." },
        { id: "freeswitch_verto", defaultUrl: "ws://127.0.0.1:8081", evidence: "FreeSWITCH Verto accepts the registered acc-pipecat WebRTC agent leg." },
        { id: "pipecat_verto_bridge", defaultUrl: "http://127.0.0.1:8770/health", evidence: "Pipecat Verto sidecar is registered and ready to answer the FreeSWITCH WebRTC dialog." },
        { id: "rtc_asr_ws", env: "RTC_ASR_WS_URL", evidence: "The current call audio is transcribed into fresh rtc_asr_live final transcript evidence." },
        { id: "kokoro_http", env: "KOKORO_BASE_URL", evidence: "Kokoro returns TTS audio that is packetized and played back to the caller." },
      ],
    });
    assert.equal(artifact.readiness.ok, true);
    assert.equal(artifact.readiness.route, "/api/pipecat-media-engine/readiness");
    assert.equal(artifact.readiness.status, "shared_media_and_flowmanager_runtime_complete");
    assert.equal(artifact.readiness.acceptanceCriteria.filter((criterion) => criterion.passed).length, 11);
    assert.equal(artifact.readiness.acceptanceCriteria.length, 11);
    assert.equal(artifact.readiness.acceptanceCriteria.find((criterion) => criterion.name === "pipecat_14_small_webrtc_migration_recorded")?.passed, true);
    assert.equal(artifact.readiness.acceptanceCriteria.find((criterion) => criterion.name === "pipecat_flows_flowmanager_owns_conversation_flow")?.passed, true);
    assert.deepEqual(latestArtifact, artifact);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
