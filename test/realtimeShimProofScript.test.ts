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

  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--out", outputPath], {
      cwd: repoRoot,
    });

    assert.match(stdout, /Saved realtime shim proof artifact/);
    assert.match(stdout, /Issue #85 ready: yes/);

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      ok: boolean;
      issue: string;
      generatedAt: string;
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
    assert.equal(artifact.readiness.ok, true);
    assert.equal(artifact.readiness.route, "/api/realtime-shim/readiness");
    assert.equal(artifact.readiness.status, "ready_for_issue_85_review");
    assert.deepEqual(artifact.readiness.reviewBlockers, []);
    assert.equal(artifact.readiness.acceptanceCriteria.every((criterion) => criterion.passed), true);
    assert.equal(artifact.proof.ok, true);
    assert.equal(artifact.proof.route, "/api/realtime-shim/proof");
    assert.equal(artifact.proof.readyForIssue85Review, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
