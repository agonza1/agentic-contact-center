import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("agentic call center proof bundle emits ConversationAgentEvals-ready media evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-bundle-"));
  const sourceProofPath = path.join(tempDir, "source-proof.json");
  const latestProofPath = path.join(tempDir, "latest-proof.json");
  const outDir = path.join(tempDir, "bundle");

  try {
    await execFileAsync(process.execPath, ["scripts/demo-proof.mjs", "--out", sourceProofPath, "--latest-out", latestProofPath], {
      cwd: repoRoot,
    });

    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/agentic-call-center-proof.mjs", "--proof", sourceProofPath, "--out-dir", outDir],
      { cwd: repoRoot },
    );

    const scriptSummary = JSON.parse(stdout) as { manifest: string; audioCapture: string; videoRecording: string };
    assert.match(scriptSummary.manifest, /proof-bundle-manifest\.json$/);
    assert.match(scriptSummary.audioCapture, /caller-capture\.wav$/);
    assert.match(scriptSummary.videoRecording, /operator-console-demo\.gif$/);

    const manifest = JSON.parse(await readFile(path.join(outDir, "proof-bundle-manifest.json"), "utf8")) as {
      runtimeModeLabels: { flow: string; credentialsMode: string; localAsr: string };
      artifacts: { audioCapture: string; screenshots: string[]; videoRecording: string; latencyEvidence: string; conversationAgentEvalsRequest: string };
      artifactIntegrity: Array<{ artifactId: string; kind: string; path: string; sha256: string; sizeBytes: number; readiness: string }>;
      limitations: string[];
    };
    assert.equal(manifest.runtimeModeLabels.flow, "pipecat_local_runtime");
    assert.equal(manifest.runtimeModeLabels.credentialsMode, "mocked");
    assert.match(manifest.runtimeModeLabels.localAsr, /local-stt\.v1/);
    assert.equal(manifest.artifacts.screenshots.length, 2);
    assert.match(manifest.artifacts.latencyEvidence, /latency-evidence\.json$/);
    assert.equal(manifest.artifactIntegrity.length, 12);
    assert.ok(
      manifest.artifactIntegrity.every(
        (artifact) => artifact.readiness === "ready" && artifact.sha256.match(/^[a-f0-9]{64}$/) && artifact.sizeBytes > 0,
      ),
    );
    assert.ok(manifest.artifactIntegrity.some((artifact) => artifact.artifactId === "conversation-agent-evals-assert-request" && artifact.kind === "assert_request"));
    assert.ok(manifest.artifactIntegrity.some((artifact) => artifact.path.endsWith("media/caller-capture.wav")));
    assert.ok(manifest.limitations.some((limitation) => limitation.includes("No production credentials")));

    const latencyEvidence = JSON.parse(await readFile(path.join(outDir, "latency-evidence.json"), "utf8")) as {
      runtimeMode: string;
      marks: Array<{ flow: string; stage: string; overBudget: boolean }>;
    };
    assert.equal(latencyEvidence.runtimeMode, "pipecat_local_runtime");
    assert.ok(latencyEvidence.marks.some((mark) => mark.flow === "scripted" && mark.stage === "policy_hold_entered"));
    assert.ok(latencyEvidence.marks.some((mark) => mark.flow === "fallback" && mark.stage === "operator_notified"));
    assert.ok(latencyEvidence.marks.some((mark) => mark.flow === "runtime_failure" && mark.stage === "operator_notified"));

    const wav = await readFile(path.join(outDir, "media", "caller-capture.wav"));
    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(wav.readUInt32LE(24), 16000);

    const gif = await readFile(path.join(outDir, "recordings", "operator-console-demo.gif"));
    assert.equal(gif.subarray(0, 6).toString("ascii"), "GIF89a");
    assert.ok((await stat(path.join(outDir, "screenshots", "operator-console-policy-hold.svg"))).size > 500);

    const assertRequest = JSON.parse(await readFile(path.join(outDir, "conversation-agent-evals-assert-request.json"), "utf8")) as {
      spec_ref: { spec_id: string; spec_kind: string; spec_version: string };
      evidence: { transcript: unknown; call_media: Array<{ artifact_id: string; kind: string; readiness: string }>; assert_bundle: unknown; additional_artifacts: Array<{ artifact_id: string; kind: string; readiness: string }> };
      runtime_config: { invocation_target: { transport: string; base_url: string } };
      platform_metadata: { labels: string[] };
    };
    assert.equal(assertRequest.spec_ref.spec_id, "agentic-contact-center/cancellation-rescue");
    assert.equal(assertRequest.spec_ref.spec_kind, "scenario");
    assert.equal(assertRequest.spec_ref.spec_version, "2026-06-29");
    assert.equal(assertRequest.runtime_config.invocation_target.transport, "http_sidecar");
    assert.equal(assertRequest.runtime_config.invocation_target.base_url, "http://127.0.0.1:8091");
    assert.equal(assertRequest.evidence.call_media.length, 4);
    assert.deepEqual(
      assertRequest.evidence.call_media.map((artifact) => artifact.artifact_id),
      [
        "caller-audio-capture-wav",
        "operator-console-policy-hold-screenshot",
        "operator-console-wrap-screenshot",
        "operator-console-demo-recording",
      ],
    );
    assert.ok(assertRequest.evidence.call_media.every((artifact) => artifact.kind === "call_media" && artifact.readiness === "ready"));
    assert.deepEqual(
      assertRequest.evidence.additional_artifacts.map((artifact) => artifact.artifact_id),
      ["agentic-call-center-latency-evidence", "local-stt-v1-contract-evidence"],
    );
    assert.equal(assertRequest.evidence.additional_artifacts[0].kind, "report");
    assert.ok(assertRequest.evidence.additional_artifacts.every((artifact) => artifact.readiness === "ready"));
    assert.ok(assertRequest.platform_metadata.labels.includes("local-stt-v1"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
