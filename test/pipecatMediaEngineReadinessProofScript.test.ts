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
    assert.match(stdout, /Acceptance criteria: 5\/6/);
    assert.match(stdout, /Next slice: sip_rtp_to_pipecat_input_frames/);

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
      readinessStatus: "shared_contract_ready_sip_rtp_blocked",
      reviewReady: false,
      reviewBlockers: [
        "FreeSWITCH RTP is not yet streamed bidirectionally through Pipecat frames; the current SIP bridge records/captures media, posts ACC events, and can attach rtc-asr evidence after capture.",
      ],
      acceptanceCriteriaPassed: 5,
      acceptanceCriteriaTotal: 6,
      implementedAdapters: ["browser_webrtc"],
      blockedAdapters: ["sip_freeswitch_rtp", "signalwire_sip_trunk"],
      nextUnblockedSlice: {
        id: "sip_rtp_to_pipecat_input_frames",
        title: "Decode FreeSWITCH RTP into Pipecat input frames",
        adapter: "sip_freeswitch_rtp",
        entryPoint: "scripts/freeswitch-acc-bridge.mjs",
      },
      validationCommands: [
        "npm test",
        "curl -fsS http://127.0.0.1:8026/api/pipecat-media-engine/readiness",
      ],
    });
    assert.equal(artifact.readiness.ok, true);
    assert.equal(artifact.readiness.route, "/api/pipecat-media-engine/readiness");
    assert.equal(artifact.readiness.status, "shared_contract_ready_sip_rtp_blocked");
    assert.equal(artifact.readiness.acceptanceCriteria.filter((criterion) => criterion.passed).length, 5);
    assert.deepEqual(latestArtifact, artifact);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
