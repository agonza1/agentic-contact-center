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
    assert.match(stdout, /Acceptance criteria: 8\/9/);
    assert.match(stdout, /Next slice: live_softphone_playback_acceptance/);

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      ok: boolean;
      issue: string;
      generatedAt: string;
      artifactSummary: {
        readinessStatus: string;
        reviewReady: boolean;
        reviewBlockers: string[];
        acceptanceCriteriaPassed: number;
        acceptanceCriteriaTotal: number;
        implementedAdapters: string[];
        blockedAdapters: string[];
        nextUnblockedSlice: { id: string; title: string; adapter: string; entryPoint: string };
        liveSipProofAcceptance: { requiredManifestFlags: string[]; rejectedShortcuts: string[]; proofBundleCommand: string };
        validationCommands: string[];
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
      acceptanceCriteriaPassed: 8,
      acceptanceCriteriaTotal: 9,
      implementedAdapters: ["browser_webrtc", "sip_freeswitch_rtp"],
      blockedAdapters: ["signalwire_sip_trunk"],
      nextUnblockedSlice: {
        id: "live_softphone_playback_acceptance",
        title: "Capture end-to-end softphone playback proof",
        adapter: "sip_freeswitch_rtp",
        entryPoint: "scripts/freeswitch-acc-bridge.mjs",
      },
      liveSipProofAcceptance: {
        requiredManifestFlags: ["live_capture", "rtc_asr_live", "pipecat_rtp_playback_sent", "caller_audible_playback"],
        rejectedShortcuts: [
          "generated_media_without_live_capture",
          "stale_rtc_asr_evidence_reused_across_calls",
          "uuid_broadcast_without_caller_capture",
        ],
        proofBundleCommand: "node scripts/live-sip-proof-bundle.mjs --require-live-capture --require-rtc-asr-live --require-caller-playback",
      },
      validationCommands: [
        "npm test",
        "curl -fsS http://127.0.0.1:8026/api/pipecat-media-engine/readiness",
      ],
    });
    assert.equal(artifact.readiness.ok, true);
    assert.equal(artifact.readiness.route, "/api/pipecat-media-engine/readiness");
    assert.equal(artifact.readiness.status, "shared_contract_ready_local_sip_playback_proof_pending");
    assert.equal(artifact.readiness.acceptanceCriteria.filter((criterion) => criterion.passed).length, 8);
    assert.equal(artifact.readiness.acceptanceCriteria.length, 9);
    assert.equal(artifact.readiness.acceptanceCriteria.find((criterion) => criterion.name === "pipecat_14_small_webrtc_migration_recorded")?.passed, true);
    assert.deepEqual(latestArtifact, artifact);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
