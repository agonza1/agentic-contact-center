import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("CAE ASSERT handoff maps tester scenarios into canonical evidence request", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "acc-cae-assert-handoff-"));

  try {
    const stdout = execFileSync(
      process.execPath,
      [
        "scripts/cae-assert-handoff.mjs",
        "--out-dir",
        outDir,
        "--call-id-prefix",
        "qa-cae-handoff",
        "--generated-at",
        "2026-07-16T22:40:00.000Z",
      ],
      { encoding: "utf8" },
    );
    const summary = JSON.parse(stdout) as {
      ok: boolean;
      manifest: string;
      assertRequest: string;
      prefillTemplate: string;
      validation: string;
      scenarioCount: number;
      coverage: Record<string, boolean>;
    };

    assert.equal(summary.ok, true);
    assert.equal(summary.scenarioCount, 5);
    assert.equal(summary.coverage.requirements, true);
    assert.equal(summary.coverage.scenario, true);
    assert.equal(summary.coverage.eventTimeline, true);
    assert.equal(summary.coverage.transcript, true);
    assert.equal(summary.coverage.audioArtifacts, true);
    assert.equal(summary.coverage.rawAudioTrack, false);

    const requestPath = path.resolve(summary.assertRequest);
    const request = JSON.parse(readFileSync(requestPath, "utf8")) as {
      spec_ref: { spec_id: string; assert_project: string };
      evidence: {
        transcript: { artifact_id: string; readiness: string };
        conversation: { artifact_id: string; readiness: string };
        call_media: Array<{ artifact_id: string; readiness: string; metadata: Record<string, string> }>;
        action_trace: { artifact_id: string; readiness: string };
        final_state: { artifact_id: string; readiness: string };
        assert_bundle: { artifact_id: string; readiness: string };
        additional_artifacts: Array<{ artifact_id: string; kind: string; readiness: string }>;
        provenance: { workboard_card: string; related_cae_issues: string[] };
      };
      runtime_config: { invocation_target: { entrypoint: string }; scenario_overrides: { failure_modes: Array<{ code: string }> } };
      platform_metadata: { labels: string[] };
    };
    assert.equal(request.spec_ref.spec_id, "call-center-voice-ai/acc-shared-pipeline-evidence-handoff");
    assert.equal(request.spec_ref.assert_project, "conversation-agent-evals");
    assert.equal(request.evidence.transcript.artifact_id, "acc-shared-pipeline-transcript");
    assert.equal(request.evidence.conversation.readiness, "ready");
    assert.equal(request.evidence.action_trace.artifact_id, "acc-shared-pipeline-event-timeline");
    assert.equal(request.evidence.final_state.readiness, "ready");
    assert.equal(request.evidence.assert_bundle.readiness, "ready");
    assert.equal(request.evidence.call_media[0].artifact_id, "acc-shared-pipeline-raw-audio-track");
    assert.equal(request.evidence.call_media[0].readiness, "missing");
    assert.match(request.evidence.call_media[0].metadata.reason, /deterministic_tester_agent/);
    assert.ok(request.evidence.additional_artifacts.some((artifact) => artifact.artifact_id === "acc-shared-pipeline-requirements" && artifact.kind === "manifest"));
    assert.ok(request.evidence.additional_artifacts.some((artifact) => artifact.artifact_id === "acc-shared-pipeline-verdicts" && artifact.kind === "summary"));
    assert.ok(request.evidence.additional_artifacts.some((artifact) => artifact.artifact_id === "acc-cae-prefill-template" && artifact.kind === "manifest"));
    assert.equal(request.evidence.provenance.workboard_card, "38e2b285-a6ae-4e3b-b518-58656dc60828");
    assert.ok(request.evidence.provenance.related_cae_issues.some((url) => url.endsWith("/issues/94")));
    assert.ok(request.evidence.provenance.related_cae_issues.some((url) => url.endsWith("/issues/96")));
    assert.equal(request.runtime_config.invocation_target.entrypoint, "/api/assert/runs");
    assert.ok(request.runtime_config.scenario_overrides.failure_modes.some((mode) => mode.code === "missing_audio_track"));
    assert.ok(request.platform_metadata.labels.includes("cae-assert"));

    const validation = JSON.parse(readFileSync(path.resolve(summary.validation), "utf8")) as { ok: boolean; errors: string[] };
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.errors, []);

    const timeline = JSON.parse(readFileSync(path.join(outDir, "event-timeline.json"), "utf8")) as {
      redaction: { transcriptTextIncluded: boolean; audioContentIncluded: boolean };
      events: Array<Record<string, unknown>>;
    };
    assert.equal(timeline.redaction.transcriptTextIncluded, false);
    assert.equal(timeline.redaction.audioContentIncluded, false);
    assert.ok(timeline.events.some((event) => event.phase === "tts.playback_chunk"));
    assert.equal(timeline.events.some((event) => Object.hasOwn(event, "callerTranscript")), false);

    const prefill = JSON.parse(readFileSync(path.resolve(summary.prefillTemplate), "utf8")) as {
      owner: string;
      preferredSurface: { issue: string; deepLink: string };
      template: { extensions: { agentic_contact_center: { thinWrapperOnly: boolean } } };
    };
    assert.equal(prefill.owner, "ConversationAgentEvals");
    assert.match(prefill.preferredSurface.issue, /ConversationAgentEvals\/issues\/100/);
    assert.match(prefill.preferredSurface.deepLink, /\/specs\/new/);
    assert.equal(prefill.template.extensions.agentic_contact_center.thinWrapperOnly, true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
