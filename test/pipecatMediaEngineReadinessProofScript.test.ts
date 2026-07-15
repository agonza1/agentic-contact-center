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
    assert.match(stdout, /Review ready: no/);
    assert.match(stdout, /Review blockers: 1/);
    assert.match(stdout, /Acceptance criteria: 9\/10/);
    assert.match(stdout, /Failing criteria: sip_caller_audible_playback_live_proof/);
    assert.match(stdout, /Next slice: live_softphone_playback_acceptance/);
    assert.match(stdout, /Next validation: node scripts\/live-sip-proof-bundle\.mjs --require-live-capture --require-rtc-asr-live --require-caller-playback/);
    assert.match(stdout, /Runtime prerequisites: acc_http, freeswitch_sip, freeswitch_esl, rtc_asr_ws, kokoro_http/);

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
        nextUnblockedSlice: { id: string; title: string; adapter: string; entryPoint: string };
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
      readinessStatus: "shared_contract_ready_local_sip_playback_proof_pending",
      reviewReady: false,
      reviewBlockers: [
        "Local 8600 return audio is wired through Kokoro/Pipecat TTS, PCMU RTP packetization evidence, and FreeSWITCH uuid_broadcast WAV playback; live softphone capture still needs to prove the caller heard that playback end-to-end.",
      ],
      reviewBlockerCount: 1,
      acceptanceCriteriaPassed: 9,
      acceptanceCriteriaTotal: 10,
      failingAcceptanceCriteria: ["sip_caller_audible_playback_live_proof"],
      implementedAdapters: ["browser_webrtc", "sip_freeswitch_rtp", "fixture_audio_injection"],
      blockedAdapters: ["signalwire_sip_trunk"],
      nextUnblockedSlice: {
        id: "live_softphone_playback_acceptance",
        title: "Capture end-to-end softphone playback proof",
        adapter: "sip_freeswitch_rtp",
        entryPoint: "scripts/freeswitch-acc-bridge.mjs",
      },
      liveSipProofAcceptance: {
        requiredManifestFlags: ["live_capture", "rtc_asr_live", "pipecat_rtp_playback_sent", "caller_audible_playback"],
        requiredRuntimeEndpoints: [
          { id: "acc_http", defaultUrl: "http://127.0.0.1:8026", evidence: "ACC health/readiness routes are reachable while the SIP proof listener runs." },
          { id: "freeswitch_sip", defaultAddress: "127.0.0.1:5060", evidence: "A local softphone can place an accepted INVITE to extension 8600." },
          { id: "freeswitch_esl", defaultAddress: "127.0.0.1:8021", evidence: "freeswitch-acc-bridge can observe CHANNEL_ANSWER and RTP call events." },
          { id: "rtc_asr_ws", env: "RTC_ASR_WS_URL", evidence: "The current call audio is transcribed into fresh rtc_asr_live final transcript evidence." },
          { id: "kokoro_http", env: "KOKORO_BASE_URL", evidence: "Kokoro returns TTS audio that is packetized and played back to the caller." },
        ],
        rejectedShortcuts: [
          "generated_media_without_live_capture",
          "stale_rtc_asr_evidence_reused_across_calls",
          "uuid_broadcast_without_caller_capture",
        ],
        proofBundleCommand: "node scripts/live-sip-proof-bundle.mjs --require-live-capture --require-rtc-asr-live --require-caller-playback",
      },
      remainingWorkCount: 4,
      validationCommands: [
        "npm test",
        "curl -fsS http://127.0.0.1:8026/api/pipecat-media-engine/readiness",
      ],
      nextValidationCommand: "node scripts/live-sip-proof-bundle.mjs --require-live-capture --require-rtc-asr-live --require-caller-playback",
      requiredRuntimeEndpoints: [
        { id: "acc_http", defaultUrl: "http://127.0.0.1:8026", evidence: "ACC health/readiness routes are reachable while the SIP proof listener runs." },
        { id: "freeswitch_sip", defaultAddress: "127.0.0.1:5060", evidence: "A local softphone can place an accepted INVITE to extension 8600." },
        { id: "freeswitch_esl", defaultAddress: "127.0.0.1:8021", evidence: "freeswitch-acc-bridge can observe CHANNEL_ANSWER and RTP call events." },
        { id: "rtc_asr_ws", env: "RTC_ASR_WS_URL", evidence: "The current call audio is transcribed into fresh rtc_asr_live final transcript evidence." },
        { id: "kokoro_http", env: "KOKORO_BASE_URL", evidence: "Kokoro returns TTS audio that is packetized and played back to the caller." },
      ],
    });
    assert.equal(artifact.readiness.ok, true);
    assert.equal(artifact.readiness.route, "/api/pipecat-media-engine/readiness");
    assert.equal(artifact.readiness.status, "shared_contract_ready_local_sip_playback_proof_pending");
    assert.equal(artifact.readiness.acceptanceCriteria.filter((criterion) => criterion.passed).length, 9);
    assert.equal(artifact.readiness.acceptanceCriteria.length, 10);
    assert.equal(artifact.readiness.acceptanceCriteria.find((criterion) => criterion.name === "pipecat_14_small_webrtc_migration_recorded")?.passed, true);
    assert.deepEqual(latestArtifact, artifact);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
