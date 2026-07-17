#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const cardId = "38e2b285-a6ae-4e3b-b518-58656dc60828";

function argValue(flag, fallback = undefined) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasArg(flag) {
  return process.argv.includes(flag);
}

function gitRevision() {
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  return {
    repo: "agonza1/agentic-contact-center",
    commit: git(["rev-parse", "HEAD"]),
    shortCommit: git(["rev-parse", "--short=12", "HEAD"]),
    branch: git(["branch", "--show-current"]),
    dirty: Boolean(git(["status", "--porcelain"])),
  };
}

function rel(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stableJson(value), "utf8");
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function pointer(filePath, { artifactId, kind, mimeType, role = "input", metadata = {} }) {
  const stats = await stat(filePath);
  return {
    artifact_id: artifactId,
    kind,
    role,
    uri: rel(filePath),
    mime_type: mimeType,
    sha256: await sha256File(filePath),
    size_bytes: stats.size,
    source: "agentic-contact-center",
    readiness: "ready",
    metadata,
  };
}

function missingPointer({ artifactId, kind, metadata }) {
  return {
    artifact_id: artifactId,
    kind,
    role: "input",
    uri: null,
    inline_data: null,
    mime_type: null,
    sha256: null,
    size_bytes: null,
    source: "agentic-contact-center",
    readiness: "missing",
    metadata,
  };
}

async function runTesterScenarios(outDir, callIdPrefix) {
  const { stdout } = await execFileAsync(
    "python3",
    ["scripts/pipecat-tester-agent-scenarios.py", "--out-dir", outDir, "--call-id-prefix", callIdPrefix],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function loadOrGenerateTesterManifest(outDir) {
  const suppliedManifest = argValue("--tester-manifest");
  if (suppliedManifest) {
    const manifestPath = path.resolve(repoRoot, suppliedManifest);
    return {
      manifestPath,
      manifest: JSON.parse(await readFile(manifestPath, "utf8")),
      generated: false,
    };
  }
  const scenarioDir = path.join(outDir, "tester-scenarios");
  const callIdPrefix = argValue("--call-id-prefix", "cae-assert-p1-9");
  const manifest = await runTesterScenarios(scenarioDir, callIdPrefix);
  return {
    manifestPath: path.resolve(repoRoot, manifest.artifactPaths.manifest),
    manifest,
    generated: true,
  };
}

function phaseForStage(stage) {
  if (stage.startsWith("acc.caller_turn")) return "acc.agent_processing";
  if (stage === "tts.stream_started") return "tts.playback_started";
  if (stage === "tts.audio_chunk") return "tts.playback_chunk";
  if (stage === "tts.stream_completed") return "tts.playback_completed";
  if (stage === "tts.stream_cancelled" || stage === "output.transport_flushed") return "barge_in.cancelled";
  if (stage.startsWith("tester.no_speech")) return "turn_timeout";
  if (stage.startsWith("tester.expected_transcript_mismatch")) return "schema_mismatch";
  if (stage.startsWith("tester.transport_start_failed")) return "transport.failure";
  return "runtime.event";
}

function scenarioStatus(scenario) {
  if (scenario.ok === true && scenario.expectedFailureHandled === true) return "expected_failure_handled";
  if (scenario.ok === true) return "pass";
  return "fail";
}

function buildTranscript(scenarios) {
  return scenarios
    .flatMap((scenario) => {
      const rows = [`# ${scenario.id}`];
      if (scenario.callerTranscript) rows.push(`Caller: ${scenario.callerTranscript}`);
      if (scenario.expectedTranscript) rows.push(`Expected transcript: ${scenario.expectedTranscript}`);
      if (scenario.agentResponse) rows.push(`Agent: ${scenario.agentResponse}`);
      if (!scenario.callerTranscript && !scenario.agentResponse) rows.push("No caller/agent transcript was produced; scenario validates failure handling before ACC mutation.");
      return rows;
    })
    .join("\n\n") + "\n";
}

function buildConversation(scenarios) {
  return {
    dialog: scenarios.flatMap((scenario) => {
      const turns = [];
      if (scenario.callerTranscript) {
        turns.push({ scenarioId: scenario.id, role: "user", speaker: "caller", content: scenario.callerTranscript, correlationId: scenario.correlationId });
      }
      if (scenario.agentResponse) {
        turns.push({ scenarioId: scenario.id, role: "assistant", speaker: "agent", content: scenario.agentResponse, correlationId: scenario.correlationId });
      }
      return turns;
    }),
  };
}

function buildTimeline(scenarios) {
  return {
    schemaVersion: 1,
    redaction: {
      transcriptTextIncluded: false,
      audioContentIncluded: false,
      audioSha256Allowed: true,
    },
    events: scenarios.flatMap((scenario) =>
      (scenario.timingEvents ?? []).map((event, index) => ({
        sequence: index + 1,
        scenarioId: scenario.id,
        correlationId: event.correlationId ?? scenario.correlationId,
        stage: event.stage,
        phase: phaseForStage(String(event.stage ?? "")),
        ok: event.ok ?? null,
        at: event.timestamp ?? null,
        streamId: typeof event.streamId === "string" ? event.streamId : null,
        audioBytes: typeof event.audioBytes === "number" ? event.audioBytes : null,
        outputGeneration: typeof event.outputGeneration === "number" ? event.outputGeneration : null,
        status: typeof event.error === "string" ? event.error : null,
      })),
    ).map((event, index) => ({ ...event, sequence: index + 1 })),
  };
}

function buildAudioSummary(scenarios) {
  return {
    schemaVersion: 1,
    rawAudioTrackAttached: false,
    note: "The deterministic tester-agent emits frame summaries and audio hashes; attach browser/SIP/track recording artifacts for raw call_media.",
    scenarios: scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      correlationId: scenario.correlationId,
      frameSummary: scenario.frameSummary ?? null,
      interruptedFrameSummary: scenario.interruptedFrameSummary ?? null,
      resumedFrameSummary: scenario.resumedFrameSummary ?? null,
    })),
  };
}

function buildFinalState(manifest, scenarios) {
  return {
    complete: manifest.ok === true,
    outcome: manifest.ok === true ? "shared_pipeline_tester_scenarios_passed" : "shared_pipeline_tester_scenarios_failed",
    executionMode: manifest.mode,
    scenarioCount: scenarios.length,
    sharedProcessors: manifest.sharedProcessors,
    productionPipelineContract: manifest.productionPipelineContract,
    testerPipelineContract: manifest.testerPipelineContract,
    scenarioStatuses: Object.fromEntries(scenarios.map((scenario) => [scenario.id, scenarioStatus(scenario)])),
  };
}

function buildVerdicts(scenarios) {
  return {
    schemaVersion: 1,
    overall: scenarios.every((scenario) => scenario.ok === true) ? "pass" : "fail",
    verdicts: scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      status: scenarioStatus(scenario),
      expectedFailureHandled: scenario.expectedFailureHandled === true,
      checks: scenario.checks ?? {},
      evidence: {
        timingEvents: Array.isArray(scenario.timingEvents) ? scenario.timingEvents.length : 0,
        hasCallerTranscript: Boolean(scenario.callerTranscript),
        hasAgentResponse: Boolean(scenario.agentResponse),
        hasAudioFrameSummary: Boolean(scenario.frameSummary || scenario.interruptedFrameSummary || scenario.resumedFrameSummary),
      },
    })),
  };
}

function buildRequirements() {
  return {
    schemaVersion: 1,
    source: "ACC #222 P1-9",
    relatedIssues: {
      acc: "https://github.com/agonza1/agentic-contact-center/issues/222",
      caeAssertFlowDemo: "https://github.com/agonza1/ConversationAgentEvals/issues/94",
      caeBringYourOwnDocs: "https://github.com/agonza1/ConversationAgentEvals/issues/96",
      caeSpecEditorOwnership: "https://github.com/agonza1/ConversationAgentEvals/issues/100",
    },
    naturalLanguageRequirements: [
      "Submit ACC shared-pipeline evidence to ConversationAgentEvals/ASSERT without manually rewriting artifacts.",
      "Map requirements, scenario, event timeline, transcript, audio evidence, final state, and verdict fields into the CAE ASSERT request contract.",
      "Keep Agentic Contact Center as a thin producer of ACC defaults and artifact pointers; CAE owns the generic editable ASSERT spec UI and runner semantics.",
    ],
    requiredBehaviors: [
      "Preserve a correlation id across each tester scenario and timing event.",
      "Expose shared processor boundaries: tester transport input, ACC caller-turn processor, Kokoro TTS processor, tester transport output.",
      "Represent expected failure scenarios as handled verdicts, not hidden passes.",
      "Make absent raw audio tracks explicit so QA can attach browser/SIP/recording artifacts when needed.",
    ],
    forbiddenBehaviors: [
      "Do not create a second generic ASSERT YAML/spec editor inside ACC.",
      "Do not claim live rtc-asr, live SIP, browser media, or raw microphone audio from the deterministic tester-agent scenario.",
      "Do not include customer audio content or unredacted transcript text inside timing timeline entries.",
    ],
  };
}

function buildScenarioContract(manifest) {
  return {
    suite_id: "call-center-voice-ai",
    scenario_id: "acc-shared-pipeline-evidence-handoff",
    spec_ref: {
      spec_id: "call-center-voice-ai/acc-shared-pipeline-evidence-handoff",
      spec_kind: "scenario",
      spec_version: "2026-07-16",
      assert_project: "conversation-agent-evals",
      assert_commit: null,
    },
    expected_evidence: ["transcript", "conversation", "action_trace", "final_state", "assert_bundle", "call_media"],
    target: {
      source_repo: "agonza1/agentic-contact-center",
      entrypoint: manifest.entryPoint,
      command: manifest.command,
      mode: manifest.mode,
    },
    deterministic_checks: [
      "manifest.ok == true",
      "all scenarios have correlationId",
      "timing events carry correlationId",
      "happy path commits after TTS audio",
      "barge-in flushes/cancels stale output before fresh response",
      "no-speech timeout does not mutate ACC",
      "expected transcript mismatch is rejected before ACC mutation",
      "transport start failure is captured before processors",
    ],
  };
}

function buildPrefillTemplate({ requirements, scenarioContract, manifestPath }) {
  return {
    schemaVersion: 1,
    owner: "ConversationAgentEvals",
    preferredSurface: {
      product: "ConversationAgentEvals",
      issue: "https://github.com/agonza1/ConversationAgentEvals/issues/100",
      deepLink: "http://127.0.0.1:18036/specs/new",
      api: {
        preview: "POST /api/specs/preview",
        validate: "POST /api/specs/validate",
        create: "POST /api/specs",
        run: "POST /api/specs/:specId/runs",
      },
      status: "CAE owns the generic editor; ACC supplies this import payload and artifact references.",
    },
    template: {
      title: "ACC shared Pipecat pipeline evidence handoff",
      role: "Local Pipecat voice contact-center agent",
      objective: "Evaluate whether shared-pipeline ACC voice scenarios preserve caller intent, timing evidence, barge-in behavior, and failure handling.",
      successChecks: requirements.requiredBehaviors,
      failureChecks: requirements.forbiddenBehaviors,
      scenarioSeeds: scenarioContract.deterministic_checks,
      evidenceRequirements: scenarioContract.expected_evidence,
      extensions: {
        agentic_contact_center: {
          issue: "https://github.com/agonza1/agentic-contact-center/issues/222",
          workboardCard: cardId,
          sourceManifest: rel(manifestPath),
          thinWrapperOnly: true,
        },
      },
    },
  };
}

function buildFailureModes() {
  return [
    {
      code: "missing_audio_track",
      status: "explicit_gap",
      impact: "Tester-agent scenarios include audio frame summaries and hashes but no raw call_media file.",
      nextAction: "Attach browser/SIP/track recording artifacts or run a live media proof when raw audio is required.",
    },
    {
      code: "failed_scenario_verdict",
      status: "handled",
      impact: "Scenario-level failures are represented in final-state/verdict artifacts and should fail the ASSERT run if unexpected.",
      nextAction: "Inspect verdicts.json and the source scenario artifact.",
    },
    {
      code: "schema_mismatch",
      status: "guarded",
      impact: "The request uses the CAE AssertRunCreateRequest field names and canonical artifact kinds.",
      nextAction: "Submit to CAE /api/assert/runs or validate through CAE /api/specs/preview when available.",
    },
    {
      code: "cross_repo_path_portability",
      status: "documented",
      impact: "ACC writes repo-relative artifact URIs and provenance so CAE can copy or resolve them without importing ACC at startup.",
      nextAction: "When uploading to CAE, preserve artifact files beside the request or rewrite URIs during upload.",
    },
  ];
}

function validateRequest(request) {
  const errors = [];
  if (!request.spec_ref?.spec_id || !request.spec_ref?.spec_version) errors.push("spec_ref requires spec_id and spec_version");
  if (!request.evidence?.transcript) errors.push("transcript evidence is missing");
  if (!request.evidence?.action_trace) errors.push("action_trace evidence is missing");
  if (!request.evidence?.final_state) errors.push("final_state evidence is missing");
  if (!request.evidence?.assert_bundle) errors.push("assert_bundle evidence is missing");
  if (!Array.isArray(request.evidence?.additional_artifacts) || request.evidence.additional_artifacts.length < 4) errors.push("additional_artifacts must include requirements/scenario/verdict/template artifacts");
  if (request.runtime_config?.invocation_target?.entrypoint !== "/api/assert/runs") errors.push("ASSERT invocation target should use CAE /api/assert/runs");
  return errors;
}

async function main() {
  const generatedAt = argValue("--generated-at", new Date().toISOString());
  const outDir = path.resolve(repoRoot, argValue("--out-dir", "artifacts/cae-assert-handoff"));
  const assertBaseUrl = argValue("--assert-base-url", "http://127.0.0.1:8091");
  await mkdir(outDir, { recursive: true });

  const { manifest, manifestPath, generated } = await loadOrGenerateTesterManifest(outDir);
  const sourceManifestCopy = path.join(outDir, "source-tester-manifest.json");
  await copyFile(manifestPath, sourceManifestCopy);
  const scenarios = Array.isArray(manifest.scenarios) ? manifest.scenarios : [];
  if (scenarios.length === 0) {
    throw new Error("Tester scenario manifest has no scenarios.");
  }

  const requirements = buildRequirements();
  const scenarioContract = buildScenarioContract(manifest);
  const timeline = buildTimeline(scenarios);
  const conversation = buildConversation(scenarios);
  const finalState = buildFinalState(manifest, scenarios);
  const verdicts = buildVerdicts(scenarios);
  const audioSummary = buildAudioSummary(scenarios);
  const failureModes = buildFailureModes();
  const revision = gitRevision();

  const requirementsPath = path.join(outDir, "requirements.json");
  const scenarioPath = path.join(outDir, "scenario-contract.json");
  const transcriptPath = path.join(outDir, "transcript.txt");
  const conversationPath = path.join(outDir, "conversation.json");
  const timelinePath = path.join(outDir, "event-timeline.json");
  const finalStatePath = path.join(outDir, "final-state.json");
  const verdictsPath = path.join(outDir, "verdicts.json");
  const audioSummaryPath = path.join(outDir, "audio-evidence-summary.json");
  const failureModesPath = path.join(outDir, "failure-modes.json");
  const prefillPath = path.join(outDir, "acc-cae-prefill-template.json");
  const validationPath = path.join(outDir, "schema-validation.json");
  const manifestOutPath = path.join(outDir, "cae-assert-handoff-manifest.json");
  const requestPath = path.join(outDir, "conversation-agent-evals-assert-request.json");

  await writeJson(requirementsPath, requirements);
  await writeJson(scenarioPath, scenarioContract);
  await writeFile(transcriptPath, buildTranscript(scenarios), "utf8");
  await writeJson(conversationPath, conversation);
  await writeJson(timelinePath, timeline);
  await writeJson(finalStatePath, finalState);
  await writeJson(verdictsPath, verdicts);
  await writeJson(audioSummaryPath, audioSummary);
  await writeJson(failureModesPath, failureModes);
  await writeJson(prefillPath, buildPrefillTemplate({ requirements, scenarioContract, manifestPath }));

  const request = {
    spec_ref: scenarioContract.spec_ref,
    evidence: {
      transcript: await pointer(transcriptPath, { artifactId: "acc-shared-pipeline-transcript", kind: "transcript", mimeType: "text/plain" }),
      conversation: await pointer(conversationPath, { artifactId: "acc-shared-pipeline-conversation", kind: "conversation", mimeType: "application/json" }),
      call_media: [
        missingPointer({
          artifactId: "acc-shared-pipeline-raw-audio-track",
          kind: "call_media",
          metadata: {
            reason: "deterministic_tester_agent_does_not_write_raw_audio_track",
            replacement: "audio-evidence-summary.json and optional browser/SIP/track recording artifacts",
          },
        }),
      ],
      action_trace: await pointer(timelinePath, { artifactId: "acc-shared-pipeline-event-timeline", kind: "action_trace", mimeType: "application/json" }),
      final_state: await pointer(finalStatePath, { artifactId: "acc-shared-pipeline-final-state", kind: "final_state", mimeType: "application/json" }),
      assert_bundle: null,
      additional_artifacts: [
        await pointer(requirementsPath, { artifactId: "acc-shared-pipeline-requirements", kind: "manifest", mimeType: "application/json" }),
        await pointer(scenarioPath, { artifactId: "acc-shared-pipeline-scenario-contract", kind: "manifest", mimeType: "application/json" }),
        await pointer(verdictsPath, { artifactId: "acc-shared-pipeline-verdicts", kind: "summary", mimeType: "application/json" }),
        await pointer(audioSummaryPath, { artifactId: "acc-shared-pipeline-audio-summary", kind: "report", mimeType: "application/json" }),
        await pointer(failureModesPath, { artifactId: "acc-shared-pipeline-failure-modes", kind: "report", mimeType: "application/json" }),
        await pointer(prefillPath, { artifactId: "acc-cae-prefill-template", kind: "manifest", mimeType: "application/json" }),
        await pointer(sourceManifestCopy, { artifactId: "acc-source-tester-scenario-manifest", kind: "manifest", mimeType: "application/json" }),
      ],
      provenance: {
        source: "agentic-contact-center",
        source_repo: "agonza1/agentic-contact-center",
        source_issue: "https://github.com/agonza1/agentic-contact-center/issues/222",
        workboard_card: cardId,
        source_revision: revision,
        source_tester_manifest: rel(sourceManifestCopy),
        related_cae_issues: [
          "https://github.com/agonza1/ConversationAgentEvals/issues/94",
          "https://github.com/agonza1/ConversationAgentEvals/issues/96",
          "https://github.com/agonza1/ConversationAgentEvals/issues/100",
        ],
      },
    },
    runtime_config: {
      execution_mode: "async",
      invocation_target: {
        transport: "http_sidecar",
        environment: "local",
        base_url: assertBaseUrl,
        package_name: "assert",
        entrypoint: "/api/assert/runs",
        timeout_seconds: 300,
      },
      retry_policy: { max_attempts: 1, retryable_statuses: ["error", "failed"] },
      scenario_overrides: {
        requirements,
        scenario: scenarioContract,
        deterministic_checks: scenarioContract.deterministic_checks,
        failure_modes: failureModes,
      },
      environment_labels: ["agentic-contact-center", manifest.mode, "shared-pipeline", "cae-assert-handoff"],
    },
    platform_metadata: {
      user_id: "alberto-acc-shared-pipeline",
      project_id: "agentic-contact-center",
      project_run_label: `acc-shared-pipeline:${manifest.mode}`,
      initiated_by: "agentic-contact-center",
      notes: "ACC thin CAE/ASSERT handoff for shared-pipeline tester evidence. CAE owns generic spec editing and ASSERT run semantics.",
      labels: ["acc-222", "cae-assert", "shared-pipeline", manifest.mode],
      retention_days: 90,
      billing_tags: {},
      quota_scope: cardId,
    },
  };

  const handoffManifest = {
    schemaVersion: 1,
    generatedAt,
    ok: manifest.ok === true,
    workboardCard: cardId,
    sourceIssue: "https://github.com/agonza1/agentic-contact-center/issues/222",
    sourceRevision: revision,
    generatedTesterScenarios: generated,
    caeOwnership: {
      genericSpecEditorIssue: "https://github.com/agonza1/ConversationAgentEvals/issues/100",
      assertion: "ACC supplies prefilled templates and artifact pointers; CAE owns generic editor, validation, persistence, and ASSERT runner UX.",
    },
    mapping: {
      requirements: rel(requirementsPath),
      scenario: rel(scenarioPath),
      transcript: rel(transcriptPath),
      conversation: rel(conversationPath),
      eventTimeline: rel(timelinePath),
      audioEvidence: rel(audioSummaryPath),
      finalState: rel(finalStatePath),
      verdicts: rel(verdictsPath),
      failureModes: rel(failureModesPath),
      prefillTemplate: rel(prefillPath),
      assertRequest: rel(requestPath),
      requestValidation: rel(validationPath),
    },
    coverage: {
      requirements: true,
      scenario: true,
      eventTimeline: timeline.events.length > 0,
      transcript: conversation.dialog.length > 0,
      audioArtifacts: audioSummary.scenarios.some((scenario) => scenario.frameSummary || scenario.interruptedFrameSummary || scenario.resumedFrameSummary),
      rawAudioTrack: false,
      finalState: true,
      verdicts: verdicts.verdicts.length === scenarios.length,
    },
    failureModes,
    limitations: [
      manifest.limitation,
      "The generated request does not call CAE; submit conversation-agent-evals-assert-request.json to CAE when its sidecar/API is running.",
      "Raw audio call_media is marked missing for tester-agent artifacts; use browser/SIP/recording artifacts when raw audio is required.",
    ],
  };

  await writeJson(manifestOutPath, handoffManifest);
  request.evidence.assert_bundle = await pointer(manifestOutPath, {
    artifactId: "acc-cae-assert-handoff-manifest",
    kind: "assert_bundle",
    mimeType: "application/json",
    role: "derived",
  });
  const schemaErrors = validateRequest(request);
  await writeJson(requestPath, request);
  await writeJson(validationPath, { ok: schemaErrors.length === 0, errors: schemaErrors, request: rel(requestPath) });

  if (schemaErrors.length > 0 || manifest.ok !== true) {
    process.exitCode = 2;
  }
  console.log(stableJson({
    ok: process.exitCode !== 2,
    manifest: rel(manifestOutPath),
    assertRequest: rel(requestPath),
    prefillTemplate: rel(prefillPath),
    validation: rel(validationPath),
    generatedTesterScenarios: generated,
    scenarioCount: scenarios.length,
    coverage: handoffManifest.coverage,
  }).trim());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
