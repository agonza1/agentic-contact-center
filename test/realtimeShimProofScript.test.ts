import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("realtime shim proof runner writes proof and readiness evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const scriptPath = path.join(repoRoot, "scripts", "realtime-shim-proof.mjs");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "realtime-shim-proof-"));
  const outputPath = path.join(tempDir, "realtime-shim-proof.json");
  const latestOutputPath = path.join(tempDir, "realtime-shim-proof-latest.json");

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

    assert.match(stdout, /Saved realtime shim proof artifact/);
    assert.match(stdout, /Updated latest realtime shim proof artifact/);
    assert.match(stdout, /Issue #85 ready: yes/);
    assert.match(stdout, /Acceptance criteria: 6\/6/);
    assert.match(stdout, /RPC HTTP smoke: 5 requests/);

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      ok: boolean;
      issue: string;
      generatedAt: string;
      artifactSummary: {
        readyForIssue85Review: boolean;
        readinessStatus: string;
        reviewBlockers: string[];
        acceptanceCriteriaPassed: number;
        acceptanceCriteriaTotal: number;
        cancelAndErrorEvidence: {
          outputCancelled: boolean;
          inputCancelled: boolean;
          boundedErrors: number;
        };
        evidence: {
          eventTranscriptLines: number;
          logLines: number;
          timelineEvents: number;
          latencyMarks: number;
          relayEvents: number;
        };
        rpcHttpSmoke: {
          route: string;
          sessionId: string;
          requests: number;
          methods: string[];
          finalTranscript: string;
          outputAudioChunks: number;
          closed: boolean;
        };
      };
      readiness: {
        ok: boolean;
        route: string;
        status: string;
        reviewBlockers: string[];
        acceptanceCriteria: Array<{ passed: boolean }>;
      };
      proof: {
        ok: boolean;
        route: string;
        readyForIssue85Review: boolean;
      };
    };

    assert.equal(artifact.ok, true);
    assert.equal(artifact.issue, "agonza1/agentic-contact-center#85");
    assert.doesNotThrow(() => new Date(artifact.generatedAt).toISOString());
    assert.deepEqual(artifact.artifactSummary, {
      readyForIssue85Review: true,
      readinessStatus: "ready_for_issue_85_review",
      reviewBlockers: [],
      acceptanceCriteriaPassed: 6,
      acceptanceCriteriaTotal: 6,
      cancelAndErrorEvidence: {
        outputCancelled: true,
        inputCancelled: true,
        boundedErrors: 3,
      },
      evidence: {
        eventTranscriptLines: 13,
        logLines: 13,
        timelineEvents: 13,
        latencyMarks: 3,
        relayEvents: 1,
      },
      rpcHttpSmoke: {
        route: "/api/realtime-shim/rpc",
        sessionId: "local-rt-http-smoke",
        requests: 5,
        methods: [
          "talk.session.create",
          "talk.session.appendAudio",
          "talk.session.finalizeTurn",
          "talk.session.getEvidence",
          "talk.session.close",
        ],
        finalTranscript: "Need a retention credit.",
        outputAudioChunks: 1,
        closed: true,
      },
    });
    assert.equal(artifact.readiness.ok, true);
    assert.equal(artifact.readiness.route, "/api/realtime-shim/readiness");
    assert.equal(artifact.readiness.status, "ready_for_issue_85_review");
    assert.deepEqual(artifact.readiness.reviewBlockers, []);
    assert.equal(artifact.readiness.acceptanceCriteria.every((criterion) => criterion.passed), true);
    assert.equal(artifact.proof.ok, true);
    assert.equal(artifact.proof.route, "/api/realtime-shim/proof");
    assert.equal(artifact.proof.readyForIssue85Review, true);

    const latestArtifact = JSON.parse(await readFile(latestOutputPath, "utf8"));
    assert.deepEqual(latestArtifact, artifact);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
test("realtime shim proof runner refreshes latest artifact by default", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const scriptPath = path.join(repoRoot, "scripts", "realtime-shim-proof.mjs");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "realtime-shim-proof-default-"));

  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
      cwd: tempDir,
      env: {
        ...process.env,
        POC_CONFIG_PATH: path.join(repoRoot, "config", "poc.config.example.json"),
      },
    });

    const outputMatch = stdout.match(/Saved realtime shim proof artifact to (artifacts\/realtime-shim-proof-[^\n]+\.json)/);
    assert.ok(outputMatch, stdout);
    assert.match(stdout, /Updated latest realtime shim proof artifact at artifacts\/realtime-shim-proof-latest\.json/);

    const outputArtifact = JSON.parse(await readFile(path.join(tempDir, outputMatch[1]), "utf8"));
    const latestArtifact = JSON.parse(await readFile(path.join(tempDir, "artifacts", "realtime-shim-proof-latest.json"), "utf8"));

    assert.deepEqual(latestArtifact, outputArtifact);
    assert.equal(latestArtifact.artifactSummary.acceptanceCriteriaPassed, 6);
    assert.equal(latestArtifact.artifactSummary.rpcHttpSmoke.requests, 5);
    assert.equal(latestArtifact.artifactSummary.rpcHttpSmoke.closed, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
