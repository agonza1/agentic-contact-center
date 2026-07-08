import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseJsonl<T>(raw: string): T[] {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

test("ASSERT export covers voice-agent regression scenarios and judge dimensions", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-assert-"));
  const suiteId = "agentic-contact-center-voice-demo-test";
  const runId = "assert-export-test-run";

  try {
    await execFileAsync(
      process.execPath,
      ["scripts/assert-export.mjs", "--suite", suiteId, "--run", runId, "--results-root", tempDir],
      { cwd: repoRoot },
    );

    const suiteDir = path.join(tempDir, suiteId);
    const runDir = path.join(suiteDir, runId);
    const testSet = parseJsonl<{ test_case_id: string; dimensions: { regression_focus: string }; seed: { title: string } }>(
      await readFile(path.join(suiteDir, "test_set.jsonl"), "utf8"),
    );
    const scores = parseJsonl<{ test_case_id: string; score_keys: string[]; verdict: { dimension_justifications: Record<string, string>; node_judgments: Array<{ relevant: boolean }> } }>(
      await readFile(path.join(runDir, "scores.jsonl"), "utf8"),
    );
    const inference = parseJsonl<{ test_case_id: string; events: unknown[] }>(await readFile(path.join(runDir, "inference_set.jsonl"), "utf8"));
    const configYaml = await readFile(path.join(runDir, "config.yaml"), "utf8");

    assert.deepEqual(
      testSet.map((row) => row.test_case_id),
      [
        "acc-voice-demo-001",
        "acc-voice-demo-002",
        "acc-voice-demo-003",
        "acc-voice-demo-004",
        "acc-voice-demo-005",
        "acc-voice-demo-006",
        "acc-voice-demo-007",
        "acc-voice-demo-008",
      ],
    );
    assert.deepEqual(
      testSet.map((row) => row.dimensions.regression_focus),
      [
        "happy_path_goal_progression",
        "handoff_discipline",
        "barge_in_recovery",
        "latency_artifact_completeness",
        "transcript_quality_recovery",
        "memory_reuse_after_context",
        "caller_correction_after_summary",
        "speech_enhancement_runtime_profile",
      ],
    );
    assert.ok(testSet.some((row) => row.seed.title === "Billing caller requires supervised handoff"));
    assert.ok(testSet.some((row) => row.seed.title === "Low-information caller recovery"));
    assert.ok(testSet.some((row) => row.seed.title === "Returning caller context reuse"));
    assert.ok(testSet.some((row) => row.seed.title === "Caller corrects the summarized next step"));
    assert.ok(testSet.some((row) => row.seed.title === "Noisy caller uses recommended speech enhancement"));
    assert.equal(inference.length, testSet.length);
    assert.ok(inference.every((row) => row.events.length > 0));
    assert.equal(scores.length, testSet.length);
    assert.ok(
      scores.every(
        (row) =>
          row.score_keys.includes("handoff_discipline") &&
          row.score_keys.includes("latency_evidence") &&
          row.score_keys.includes("transcript_quality") &&
          row.score_keys.includes("memory_reuse") &&
          row.score_keys.includes("correction_handling") &&
          row.score_keys.includes("speech_enhancement_profile"),
      ),
    );
    assert.ok(scores.every((row) => row.verdict.node_judgments.some((judgment) => judgment.relevant)));
    assert.match(configYaml, /goal_progression:/);
    assert.match(configYaml, /handoff_discipline:/);
    assert.match(configYaml, /latency_evidence:/);
    assert.match(configYaml, /transcript_quality:/);
    assert.match(configYaml, /memory_reuse:/);
    assert.match(configYaml, /correction_handling:/);
    assert.match(configYaml, /speech_enhancement_profile:/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
