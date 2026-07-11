import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function digestCaptureReplaySources(sources: Array<{ captureId: string; path: string; strictArtifactsVerified: boolean }>): string {
  return createHash("sha256").update(JSON.stringify(sources)).digest("hex");
}

function runNode(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}

test("speech enhancement spike report script writes review-gated artifact", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const latestOutputPath = path.join(tempDir, "speech-enhancement-spike-latest.json");
  const markdownOutputPath = path.join(tempDir, "speech-enhancement-spike.md");
  const captureReplayTemplateOutputPath = path.join(tempDir, "speech-enhancement-capture-replay-template.json");
  const sourceManifestTemplateOutputPath = path.join(tempDir, "speech-enhancement-source-manifest-template.json");

  try {
    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--latest-out",
      latestOutputPath,
      "--markdown-out",
      markdownOutputPath,
      "--capture-replay-template-out",
      captureReplayTemplateOutputPath,
      "--source-manifest-template-out",
      sourceManifestTemplateOutputPath,
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      closeGateStatus: string;
      outputPath: string;
      latestOutputPath: string;
      markdownOutputPath: string;
      captureReplayTemplateOutputPath: string;
      sourceManifestTemplateOutputPath: string;
      captureReplaySourceDigest: string;
      runtimeLiveDemoEligible: boolean;
      runtimeBypassReasons: string[];
      captureReplaySources: Array<{ captureId: string; path: string; strictArtifactsVerified: boolean }>;
      strictArtifactVerification: { requiredForClose: boolean; verified: boolean; reason: string };
      strictArtifactChecks: string[];
      nextChecklistStep: { step: string; owner: string; evidence: string; command: string; status: string; reason: string };
    };
    assert.equal(summary.ok, true);
    assert.equal(summary.closeGateStatus, "blocked_before_real_capture");
    assert.equal(summary.outputPath, outputPath);
    assert.equal(summary.latestOutputPath, latestOutputPath);
    assert.equal(summary.markdownOutputPath, markdownOutputPath);
    assert.equal(summary.captureReplayTemplateOutputPath, captureReplayTemplateOutputPath);
    assert.equal(summary.sourceManifestTemplateOutputPath, sourceManifestTemplateOutputPath);
    assert.deepEqual(summary.captureReplaySources, []);
    assert.equal(summary.captureReplaySourceDigest, digestCaptureReplaySources([]));
    assert.deepEqual(summary.strictArtifactVerification, {
      requiredForClose: true,
      verified: false,
      sourceCount: 0,
      verifiedSourceCount: 0,
      unverifiedSourceCount: 0,
      reason: "attach_real_capture_replay_before_strict_artifact_verification",
    });
    assert.equal(summary.runtimeLiveDemoEligible, false);
    assert.deepEqual(summary.runtimeBypassReasons, ["feature_flag_disabled", "blocked_until_real_capture"]);
    assert.deepEqual(summary.strictArtifactChecks, [
      "exists",
      "sha256_matches",
      "artifact_uri_is_workspace_relative",
      "source_manifest_json_object",
      "source_manifest_identity_fields_present",
      "source_manifest_capture_id_matches",
      "source_manifest_audio_source_uri_matches",
      "source_manifest_recorded_at_matches",
      "source_manifest_noise_profile_matches",
      "source_manifest_scenario_matches",
      "source_manifest_runtime_host_matches",
    ]);
    assert.deepEqual(summary.nextChecklistStep, {
      step: "record_real_noisy_local_sip",
      owner: "agentic_contact_center",
      evidence: "Real noisy local SIP audio plus source manifest with matching capture_id and audio_source_uri.",
      command:
        "npm run proof:speech-enhancement -- --capture-replay-template-out artifacts/speech-enhancement-real-capture-replay.json",
      status: "blocked",
      reason: "Attach one real noisy local SIP capture replay before closing Issue #97.",
    });

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      schemaVersion: number;
      artifactType: string;
      closeGateStatus: string;
      report: {
        issue: string;
        proposedConfig: { featureFlag: string };
        replayCoverage: { liveDemoGate: string };
        closeGateProfile: {
          requiredCaptureIdPrefix: string;
          requiredLatencySettingMs: number;
          maxAddedTurnLatencyMsP95: number;
          maxCpuPercentP95: number;
          allowedCpuCostEstimates: string[];
        };
        captureReplayContract: { fixtureManifestPath: string; requiredFields: string[]; strictArtifactFields: string[]; strictArtifactChecks: string[] };
      };
      runtimeConfig: { enabled: boolean; latencyMs: number; bypassReason?: string; env: { featureFlag: string; latencyMs: string } };
      runtimeReadiness: { enabled: boolean; latencyMs: number; liveDemoEligible: boolean; frameBudget: { rtcAsrFrameMs: number; lookaheadFrames: number | null; maxBufferedAudioMs: number | null }; bypassReasons: string[] };
      handoff: {
        issueUrl: string;
        reviewRoute: string;
        captureTemplateRoute: string;
        captureTemplateCommand: string;
        validationCommand: string;
        strictValidationCommand: string;
        nextEvidenceOwner: string;
      };
      captureReplaySources: Array<{ captureId: string; path: string; strictArtifactsVerified: boolean }>;
      captureReplaySourceDigest: string;
      strictArtifactVerification: { requiredForClose: boolean; verified: boolean; reason: string };
      nextChecklistStep: { step: string; owner: string; evidence: string; command: string; status: string; reason: string };
      reviewGate: {
        issueCloseReady: boolean;
        checks: Record<string, boolean>;
        failureReasons: Record<string, string>;
        blockers: string[];
        nextEvidence: string[];
        nextAction: { owner: string; action: string; command: string; reason: string };
        realCaptureReplayIds: string[];
        passingRealCaptureReplayIds: string[];
        blockedRealCaptureReplayIds: string[];
        realCaptureReplayEvidence: Array<{
          captureId: string;
          status: "passing" | "blocked";
          enableForLiveDemo: boolean;
          failingEvidence: string[];
          reasons: string[];
          wordErrorRateDelta: number;
          addedLatencyBudgetHeadroomMs: number;
          cpuP95BudgetHeadroomPercent: number;
          recordedAt: string | null;
          audioSourceUri: string | null;
          audioSha256: string | null;
          sourceManifestUri: string | null;
          sourceManifestSha256: string | null;
          noiseProfile: string | null;
          runtimeHost: string | null;
        }>;
      };
    };
    const latestArtifact = JSON.parse(await readFile(latestOutputPath, "utf8"));
    const markdown = await readFile(markdownOutputPath, "utf8");
    const captureReplayTemplate = JSON.parse(await readFile(captureReplayTemplateOutputPath, "utf8")) as {
      capture_id: string;
      audio_source_uri: string;
      source_manifest_uri: string;
      latency_setting_ms: number;
      enhanced_rtc_asr: { cpu_percent_p95: number; cpu_cost_estimate: string };
    };
    const sourceManifestTemplate = JSON.parse(await readFile(sourceManifestTemplateOutputPath, "utf8")) as {
      capture_id: string;
      audio_source_uri: string;
      recorded_at: string;
      noise_profile: string;
      scenario: string;
      runtime_host: string;
      source: { kind: string; sample_rate_hz: number; channel_count: number; format: string };
    };

    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.artifactType, "speech_enhancement_spike_report");
    assert.equal(artifact.closeGateStatus, "blocked_before_real_capture");
    assert.deepEqual(artifact.captureReplaySources, []);
    assert.equal(artifact.captureReplaySourceDigest, digestCaptureReplaySources([]));
    assert.equal(artifact.report.issue, "agonza1/agentic-contact-center#97");
    assert.equal(artifact.handoff.issueUrl, "https://github.com/agonza1/agentic-contact-center/issues/97");
    assert.equal(artifact.handoff.reviewRoute, "/api/realtime-shim/speech-enhancement-spike");
    assert.equal(
      artifact.handoff.captureTemplateRoute,
      "/api/realtime-shim/speech-enhancement-spike/capture-template?includeContract=1",
    );
    assert.equal(
      artifact.handoff.captureTemplateCommand,
      "npm run proof:speech-enhancement -- --capture-replay-template-out artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.equal(artifact.handoff.validationCommand, "npm run proof:speech-enhancement -- --require-close-ready");
    assert.equal(
      artifact.handoff.strictValidationCommand,
      "npm run proof:speech-enhancement -- --require-close-ready --strict-capture-artifacts --capture-replay artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.equal(artifact.handoff.nextEvidenceOwner, "agentic_contact_center");
    assert.equal(artifact.report.proposedConfig.featureFlag, "RTC_ASR_SPEECH_ENHANCEMENT");
    assert.equal(artifact.report.replayCoverage.liveDemoGate, "blocked_until_real_capture");
    assert.deepEqual(artifact.runtimeConfig, {
      enabled: false,
      latencyMs: 12.5,
      bypassReason: "feature_flag_disabled",
      env: { featureFlag: "RTC_ASR_SPEECH_ENHANCEMENT", latencyMs: "RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS" },
    });
    assert.equal(artifact.runtimeReadiness.liveDemoEligible, false);
    assert.deepEqual(artifact.runtimeReadiness.frameBudget, { lookaheadFrames: 1, maxBufferedAudioMs: 32.5, rtcAsrFrameMs: 20 });
    assert.deepEqual(artifact.runtimeReadiness.bypassReasons, ["feature_flag_disabled", "blocked_until_real_capture"]);
    assert.deepEqual(artifact.report.closeGateProfile, {
      requiredCaptureIdPrefix: "real-noisy-local-sip-",
      requiredLatencySettingMs: 12.5,
      maxAddedTurnLatencyMsP95: 25,
      maxCpuPercentP95: 80,
      allowedCpuCostEstimates: ["low", "medium"],
    });
    assert.equal(
      artifact.report.captureReplayContract.fixtureManifestPath,
      "artifacts/speech-enhancement-real-capture-replay.json",
    );
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("audio_source_uri"));
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("source_manifest_uri"));
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("audio_sha256"));
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("source_manifest_sha256"));
    assert.deepEqual(artifact.report.captureReplayContract.strictArtifactFields, [
      "audio_source_uri",
      "audio_sha256",
      "source_manifest_uri",
      "source_manifest_sha256",
    ]);
    assert.deepEqual(artifact.report.captureReplayContract.strictArtifactChecks, [
      "exists",
      "sha256_matches",
      "artifact_uri_is_workspace_relative",
      "source_manifest_json_object",
      "source_manifest_identity_fields_present",
      "source_manifest_capture_id_matches",
      "source_manifest_audio_source_uri_matches",
      "source_manifest_recorded_at_matches",
      "source_manifest_noise_profile_matches",
      "source_manifest_scenario_matches",
      "source_manifest_runtime_host_matches",
    ]);
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("runtime_host"));
    assert.ok(artifact.report.captureReplayContract.requiredFields.includes("enhanced_rtc_asr.cpu_percent_p95"));
    assert.equal(artifact.reviewGate.issueCloseReady, false);
    assert.equal(artifact.reviewGate.checks.realNoisyCaptureReplay, false);
    assert.equal(artifact.reviewGate.checks.cpuRuntimeCost, false);
    assert.match(artifact.reviewGate.failureReasons.realNoisyCaptureReplay, /real noisy local SIP capture/);
    assert.ok(artifact.reviewGate.blockers.some((blocker) => blocker.includes("real noisy local SIP capture")));
    assert.ok(artifact.reviewGate.nextEvidence.includes("real_noisy_local_sip_capture_baseline_vs_enhanced_replay"));
    assert.deepEqual(artifact.reviewGate.nextAction, {
      owner: "agentic_contact_center",
      action: "attach_real_capture_replay",
      command:
        "npm run proof:speech-enhancement -- --require-close-ready --strict-capture-artifacts --capture-replay artifacts/speech-enhancement-real-capture-replay.json",
      reason: "Attach one real noisy local SIP capture replay before closing Issue #97.",
    });
    assert.deepEqual(artifact.nextChecklistStep, summary.nextChecklistStep);
    assert.deepEqual(artifact.reviewGate.realCaptureReplayIds, []);
    assert.deepEqual(artifact.reviewGate.passingRealCaptureReplayIds, []);
    assert.deepEqual(artifact.reviewGate.blockedRealCaptureReplayIds, []);
    assert.deepEqual(artifact.reviewGate.realCaptureReplayEvidence, []);
    assert.deepEqual(latestArtifact.report, artifact.report);
    assert.match(markdown, /# Speech Enhancement Spike Report/);
    assert.match(markdown, /Decision: go_for_feature_flagged_spike at 12\.5 ms/);
    assert.match(markdown, /Review gate: blocked/);
    assert.match(markdown, /Close gate status: blocked_before_real_capture/);
    assert.match(markdown, /Runtime readiness: bypassed/);
    assert.match(markdown, /Runtime latency: 12\.5 ms/);
    assert.match(markdown, /Runtime frame budget: 1 lookahead frame\(s\), 32\.5 ms max buffered audio/);
    assert.match(markdown, /Runtime bypass reasons: feature_flag_disabled, blocked_until_real_capture/);
    assert.equal(markdown.match(/## Evidence Coverage/g)?.length, 1);
    assert.match(markdown, /Real noisy capture replays: 0/);
    assert.match(markdown, new RegExp(`Capture replay source digest: ${digestCaptureReplaySources([])}`));
    assert.match(markdown, /Strict artifact fields: audio_source_uri, audio_sha256, source_manifest_uri, source_manifest_sha256/);
    assert.match(markdown, /Strict artifact verification: not_verified/);
    assert.match(markdown, /Strict artifact source count: 0/);
    assert.match(markdown, /Strict artifact verified source count: 0/);
    assert.match(markdown, /Strict artifact unverified source count: 0/);
    assert.match(markdown, /Strict artifact verification reason: attach_real_capture_replay_before_strict_artifact_verification/);
    assert.match(markdown, /Passing real replay ids: None/);
    assert.match(markdown, /Blocked real replay ids: None/);
    assert.match(markdown, /Close Gate Profile/);
    assert.match(markdown, /Required capture id prefix: real-noisy-local-sip-/);
    assert.match(markdown, /Required latency setting: 12\.5 ms/);
    assert.match(markdown, /Max added turn latency p95: 25 ms/);
    assert.match(markdown, /Max CPU p95: 80%/);
    assert.match(markdown, /Allowed CPU cost estimates: low, medium/);
    assert.match(markdown, /Latency Profiles/);
    assert.match(markdown, /latency_12_5_ms: 12\.5 ms: live-demo-eligible; env_value=12\.5; enable_command=RTC_ASR_SPEECH_ENHANCEMENT=enabled RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS=12\.5 npm run proof:realtime-shim; lookahead_frames=1; max_buffered_audio_ms=32\.5; expected_use=default; recommendation=recommended/);
    assert.match(markdown, /latency_75_ms: 75 ms: offline-only; env_value=75; enable_command=RTC_ASR_SPEECH_ENHANCEMENT=enabled RTC_ASR_SPEECH_ENHANCEMENT_LATENCY_MS=75 npm run proof:realtime-shim; lookahead_frames=4; max_buffered_audio_ms=95; expected_use=offline_review; recommendation=avoid_for_live_turns/);
    assert.match(markdown, /Real Capture Replay Evidence/);
    assert.match(markdown, /- None attached\./);
    assert.match(markdown, /Capture Replay Sources/);
    assert.match(markdown, /- None loaded\./);
    assert.match(markdown, /Replay Decisions/);
    assert.match(markdown, /synthetic-noisy-cancellation-rescue-001: enabled; latency_setting_ms=12\.5; wer_delta=0\.05; latency_headroom_ms=7; cpu_headroom_percent=38/);
    assert.match(markdown, /Review Checks/);
    assert.match(markdown, /- \[ \] realNoisyCaptureReplay/);
    assert.match(markdown, /- \[ \] wordErrorImproved/);
    assert.match(markdown, /Failure Reasons/);
    assert.match(markdown, /realNoisyCaptureReplay: Attach one real noisy local SIP capture replay before closing Issue #97\./);
    assert.match(markdown, /Next Action/);
    assert.equal(markdown.match(/Action: attach_real_capture_replay/g)?.length, 1);
    assert.match(markdown, /Next Checklist Step/);
    assert.match(markdown, /Step: record_real_noisy_local_sip/);
    assert.match(markdown, /Status: blocked/);
    assert.match(markdown, /Run: npm run proof:speech-enhancement -- --require-close-ready/);
    assert.match(markdown, /Strict artifact check: npm run proof:speech-enhancement -- --require-close-ready --strict-capture-artifacts --capture-replay artifacts\/speech-enhancement-real-capture-replay\.json/);
    assert.equal(captureReplayTemplate.capture_id, "real-noisy-local-sip-001");
    assert.equal(captureReplayTemplate.audio_source_uri, "artifacts/local-sip/real-noisy-local-sip-001.wav");
    assert.equal(captureReplayTemplate.source_manifest_uri, "artifacts/local-sip/proof-manifest-001.json");
    assert.equal(captureReplayTemplate.latency_setting_ms, 12.5);
    assert.equal(captureReplayTemplate.enhanced_rtc_asr.cpu_percent_p95, 42);
    assert.equal(captureReplayTemplate.enhanced_rtc_asr.cpu_cost_estimate, "medium");
    assert.equal(sourceManifestTemplate.capture_id, captureReplayTemplate.capture_id);
    assert.equal(sourceManifestTemplate.audio_source_uri, captureReplayTemplate.audio_source_uri);
    assert.equal(sourceManifestTemplate.recorded_at, "2026-07-08T00:00:00.000Z");
    assert.equal(sourceManifestTemplate.noise_profile, "describe_real_call_noise");
    assert.equal(sourceManifestTemplate.runtime_host, "selected-rtc-asr-hostname");
    assert.deepEqual(sourceManifestTemplate.source, {
      kind: "local_sip_noisy_capture",
      sample_rate_hz: 16000,
      channel_count: 1,
      format: "pcm_s16le_wav",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report script can enforce issue-close readiness", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-strict-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");

  try {
    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 1);
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      closeGateStatus: string;
      issueCloseReady: boolean;
      checks: Record<string, boolean>;
      failureReasons: Record<string, string>;
      blockers: string[];
      nextEvidence: string[];
      nextAction: { owner: string; action: string; command: string; reason: string };
      realCaptureReplayIds: string[];
      passingRealCaptureReplayIds: string[];
      blockedRealCaptureReplayIds: string[];
      outputPath: string;
      latestOutputPath: string | null;
      markdownOutputPath: string | null;
      captureReplaySources: Array<{ captureId: string; path: string; strictArtifactsVerified: boolean }>;
      captureReplaySourceDigest: string;
    };
    assert.equal(summary.ok, false);
    assert.equal(summary.closeGateStatus, "blocked_before_real_capture");
    assert.equal(summary.issueCloseReady, false);
    assert.equal(summary.outputPath, outputPath);
    assert.equal(summary.latestOutputPath, null);
    assert.equal(summary.markdownOutputPath, null);
    assert.deepEqual(summary.captureReplaySources, []);
    assert.equal(summary.captureReplaySourceDigest, digestCaptureReplaySources([]));
    assert.equal(summary.checks.realNoisyCaptureReplay, false);
    assert.match(summary.failureReasons.realNoisyCaptureReplay, /real noisy local SIP capture/);
    assert.ok(summary.blockers.some((blocker) => blocker.includes("real noisy local SIP capture")));
    assert.ok(summary.nextEvidence.includes("real_noisy_local_sip_capture_baseline_vs_enhanced_replay"));
    assert.equal(summary.nextAction.action, "attach_real_capture_replay");
    assert.equal(summary.nextAction.owner, "agentic_contact_center");
    assert.deepEqual(summary.realCaptureReplayIds, []);
    assert.deepEqual(summary.passingRealCaptureReplayIds, []);
    assert.deepEqual(summary.blockedRealCaptureReplayIds, []);
    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as { reviewGate: { issueCloseReady: boolean } };
    assert.equal(artifact.reviewGate.issueCloseReady, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report rejects incomplete real capture replay evidence", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-invalid-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-002",
          scenario: "local SIP caller missing source metadata",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid capture replay manifest: .*recorded_at/);
    assert.match(result.stderr, /Invalid capture replay manifest: .*source_manifest_uri\.artifacts_relative_path_required/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report rejects whitespace-only real capture replay evidence", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-whitespace-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-005",
          recorded_at: "2026-07-05T07:55:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-005.wav",
          audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source_manifest_uri: "artifacts/local-sip/proof-manifest-005.json",
          source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          noise_profile: "   ",
          scenario: "local SIP caller with blank evidence metadata",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "   ",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid capture replay manifest: .*noise_profile/);
    assert.match(result.stderr, /Invalid capture replay manifest: .*enhanced_rtc_asr\.transcript/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report rejects non-numeric real capture replay metrics", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-invalid-metrics-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-004",
          recorded_at: "2026-07-05T07:55:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-004.wav",
          audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source_manifest_uri: "artifacts/local-sip/proof-manifest-004.json",
          source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with malformed WER metric",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: "0.18",
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid capture replay manifest: .*baseline_rtc_asr\.word_error_rate_estimate/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report rejects malformed CPU p95 evidence", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-invalid-cpu-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-005",
          recorded_at: "2026-07-05T08:30:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-005.wav",
          audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source_manifest_uri: "artifacts/local-sip/proof-manifest-005.json",
          source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with malformed CPU metric",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 130,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid capture replay manifest: .*enhanced_rtc_asr\.cpu_percent_p95/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report keeps over-budget real capture replay evidence review-blocked", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-overbudget-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-003",
          recorded_at: "2026-07-05T06:45:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-003.wav",
          audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source_manifest_uri: "artifacts/local-sip/proof-manifest-003.json",
          source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with improved transcript but too much added latency",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 31,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 1);
    const summary = JSON.parse(result.stdout) as { ok: boolean; issueCloseReady: boolean; blockers: string[] };
    assert.equal(summary.ok, false);
    assert.equal(summary.issueCloseReady, false);
    assert.ok(summary.blockers.some((blocker) => blocker.includes("measured_12_5_ms_added_turn_latency_under_25_ms_p95")));

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: { replayDecisions: Array<{ captureId: string; enableForLiveDemo: boolean; reasons: string[] }> };
      reviewGate: {
        issueCloseReady: boolean;
        checks: Record<string, boolean>;
        failureReasons: Record<string, string>;
        nextEvidence: string[];
        realCaptureReplayIds: string[];
        passingRealCaptureReplayIds: string[];
        blockedRealCaptureReplayIds: string[];
        realCaptureReplayEvidence: Array<{
          captureId: string;
          status: "passing" | "blocked";
          failingEvidence: string[];
          reasons: string[];
          recordedAt: string | null;
          audioSourceUri: string | null;
          audioSha256: string | null;
          sourceManifestUri: string | null;
          sourceManifestSha256: string | null;
          noiseProfile: string | null;
          runtimeHost: string | null;
        }>;
      };
    };
    const decision = artifact.report.replayDecisions.at(-1);
    assert.equal(artifact.reviewGate.issueCloseReady, false);
    assert.equal(artifact.reviewGate.checks.addedLatencyP95, false);
    assert.match(artifact.reviewGate.failureReasons.addedLatencyP95, /added turn latency/);
    assert.equal(decision?.captureId, "real-noisy-local-sip-003");
    assert.equal(decision?.enableForLiveDemo, false);
    assert.ok(decision?.reasons.includes("latency_over_budget"));
    assert.deepEqual(artifact.reviewGate.nextEvidence, ["measured_12_5_ms_added_turn_latency_under_25_ms_p95"]);
    assert.deepEqual(artifact.reviewGate.realCaptureReplayEvidence[0].failingEvidence, [
      "measured_12_5_ms_added_turn_latency_under_25_ms_p95",
    ]);
    assert.ok(artifact.reviewGate.realCaptureReplayEvidence[0].reasons.includes("latency_over_budget"));
    assert.deepEqual(artifact.reviewGate.realCaptureReplayIds, ["real-noisy-local-sip-003"]);
    assert.deepEqual(artifact.reviewGate.passingRealCaptureReplayIds, []);
    assert.deepEqual(artifact.reviewGate.blockedRealCaptureReplayIds, ["real-noisy-local-sip-003"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report keeps high measured CPU p95 review-blocked", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-highcpu-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-007",
          recorded_at: "2026-07-05T10:05:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-007.wav",
          audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source_manifest_uri: "artifacts/local-sip/proof-manifest-007.json",
          source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with improved transcript but high CPU p95",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 88,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 1);
    const summary = JSON.parse(result.stdout) as { ok: boolean; issueCloseReady: boolean; blockers: string[] };
    assert.equal(summary.ok, false);
    assert.equal(summary.issueCloseReady, false);
    assert.ok(
      summary.blockers.some((blocker) =>
        blocker.includes("measured_cpu_cost_on_selected_rtc_asr_host_under_80_percent_p95"),
      ),
    );

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: { replayDecisions: Array<{ captureId: string; enableForLiveDemo: boolean; reasons: string[] }> };
      reviewGate: { issueCloseReady: boolean; nextEvidence: string[] };
    };
    const decision = artifact.report.replayDecisions.at(-1);
    assert.equal(artifact.reviewGate.issueCloseReady, false);
    assert.equal(decision?.captureId, "real-noisy-local-sip-007");
    assert.equal(decision?.enableForLiveDemo, false);
    assert.ok(decision?.reasons.includes("cpu_cost_high"));
    assert.deepEqual(artifact.reviewGate.nextEvidence, ["measured_cpu_cost_on_selected_rtc_asr_host_under_80_percent_p95"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report reports strict artifact verification status", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-real-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const markdownOutputPath = path.join(tempDir, "speech-enhancement-spike.md");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-001",
          recorded_at: "2026-07-05T06:40:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-001.wav",
          audio_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          source_manifest_uri: "artifacts/local-sip/proof-manifest-001.json",
          source_manifest_sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with cafe noise",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--markdown-out",
      markdownOutputPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      closeGateStatus: string;
      issueCloseReady: boolean;
      blockers: string[];
      strictArtifactVerification: { requiredForClose: boolean; verified: boolean; reason: string };
      realCaptureReplayIds: string[];
      passingRealCaptureReplayIds: string[];
      blockedRealCaptureReplayIds: string[];
      realCaptureReplayEvidence: Array<{
        captureId: string;
        status: string;
        failingEvidence: string[];
        reasons: string[];
        wordErrorRateDelta: number;
      }>;
      captureReplaySources: Array<{ captureId: string; path: string; strictArtifactsVerified: boolean }>;
      captureReplaySourceDigest: string;
    };
    assert.equal(summary.ok, true);
    assert.equal(summary.closeGateStatus, "blocked_before_strict_artifacts");
    assert.equal(summary.issueCloseReady, true);
    assert.deepEqual(summary.blockers, []);
    assert.deepEqual(summary.strictArtifactVerification, {
      requiredForClose: true,
      verified: false,
      sourceCount: 1,
      verifiedSourceCount: 0,
      unverifiedSourceCount: 1,
      reason: "run_with_strict_capture_artifacts_before_closing",
    });
    assert.deepEqual(summary.realCaptureReplayIds, ["real-noisy-local-sip-001"]);
    assert.deepEqual(summary.passingRealCaptureReplayIds, ["real-noisy-local-sip-001"]);
    assert.deepEqual(summary.blockedRealCaptureReplayIds, []);
    assert.deepEqual(summary.captureReplaySources, [
      { captureId: "real-noisy-local-sip-001", path: captureReplayPath, strictArtifactsVerified: false },
    ]);
    assert.equal(summary.captureReplaySourceDigest, digestCaptureReplaySources(summary.captureReplaySources));
    assert.deepEqual(summary.realCaptureReplayEvidence.map((evidence) => ({
      captureId: evidence.captureId,
      status: evidence.status,
      failingEvidence: evidence.failingEvidence,
      reasons: evidence.reasons,
      wordErrorRateDelta: evidence.wordErrorRateDelta,
    })), [
      {
        captureId: "real-noisy-local-sip-001",
        status: "passing",
        failingEvidence: [],
        reasons: [
          "wer_improved",
          "endpointing_no_regression",
          "barge_in_risk_no_regression",
          "latency_within_budget",
          "cpu_cost_allowed",
        ],
        wordErrorRateDelta: 0.12,
      },
    ]);

    const markdown = await readFile(markdownOutputPath, "utf8");
    assert.match(markdown, /Passing real replay ids: real-noisy-local-sip-001/);
    assert.match(markdown, /Blocked real replay ids: None/);
    assert.match(markdown, /- \[x\] realNoisyCaptureReplay/);
    assert.match(markdown, /- \[x\] cpuRuntimeCost/);
    assert.match(markdown, /Failure Reasons\n\n- None\./);
    assert.match(
      markdown,
      /real-noisy-local-sip-001: passing; wer_delta=0\.12; latency_headroom_ms=7; cpu_headroom_percent=38; failing_evidence=none; reasons=wer_improved, endpointing_no_regression, barge_in_risk_no_regression, latency_within_budget, cpu_cost_allowed; audio=artifacts\/local-sip\/real-noisy-local-sip-001\.wav; audio_sha256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; source_manifest=artifacts\/local-sip\/proof-manifest-001\.json; source_manifest_sha256=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd; runtime_host=local-rtc-asr-host/,
    );
    assert.match(markdown, /Capture Replay Sources/);
    assert.match(
      markdown,
      new RegExp("real-noisy-local-sip-001: path=" + captureReplayPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "; strict_artifacts=not_verified"),
    );

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: {
        acceptanceReadiness: { noisyReplay: string; cpuRuntimeCost: string };
        replayCoverage: { realNoisyCaptureReplayCount: number; liveDemoGate: string; missingEvidence: string[] };
        replayMetrics: Array<{
          captureId: string;
          captureEvidence?: {
            recordedAt: string;
            audioSourceUri: string;
            audioSha256?: string;
            sourceManifestUri?: string;
            sourceManifestSha256?: string;
            noiseProfile: string;
            runtimeHost: string;
          };
        }>;
        replayDecisions: Array<{ captureId: string; enableForLiveDemo: boolean }>;
      };
      captureReplaySources: Array<{ captureId: string; path: string; strictArtifactsVerified: boolean }>;
      captureReplaySourceDigest: string;
      strictArtifactVerification: { requiredForClose: boolean; verified: boolean; reason: string };
      reviewGate: {
        issueCloseReady: boolean;
        checks: Record<string, boolean>;
        failureReasons: Record<string, string>;
        blockers: string[];
        nextEvidence: string[];
        realCaptureReplayIds: string[];
        passingRealCaptureReplayIds: string[];
        blockedRealCaptureReplayIds: string[];
        realCaptureReplayEvidence: Array<{
          captureId: string;
          status: "passing" | "blocked";
          failingEvidence: string[];
          reasons: string[];
          recordedAt: string | null;
          audioSourceUri: string | null;
          audioSha256: string | null;
          sourceManifestUri: string | null;
          sourceManifestSha256: string | null;
          noiseProfile: string | null;
          runtimeHost: string | null;
        }>;
      };
    };

    assert.deepEqual(artifact.captureReplaySources, [
      { captureId: "real-noisy-local-sip-001", path: captureReplayPath, strictArtifactsVerified: false },
    ]);
    assert.equal(artifact.captureReplaySourceDigest, digestCaptureReplaySources(artifact.captureReplaySources));
    assert.deepEqual(artifact.strictArtifactVerification, {
      requiredForClose: true,
      verified: false,
      sourceCount: 1,
      verifiedSourceCount: 0,
      unverifiedSourceCount: 1,
      reason: "run_with_strict_capture_artifacts_before_closing",
    });
    assert.equal(artifact.reviewGate.issueCloseReady, true);
    assert.deepEqual(Object.values(artifact.reviewGate.checks), [true, true, true, true, true, true, true]);
    assert.deepEqual(artifact.reviewGate.failureReasons, {});
    assert.equal(artifact.report.acceptanceReadiness.noisyReplay, "real_capture_ready");
    assert.equal(artifact.report.acceptanceReadiness.cpuRuntimeCost, "covered");
    assert.deepEqual(artifact.reviewGate.blockers, []);
    assert.deepEqual(artifact.reviewGate.nextEvidence, []);
    assert.equal(artifact.report.replayCoverage.realNoisyCaptureReplayCount, 1);
    assert.equal(artifact.report.replayCoverage.liveDemoGate, "eligible");
    assert.deepEqual(artifact.report.replayCoverage.missingEvidence, []);
    assert.equal(artifact.report.replayMetrics.at(-1)?.captureId, "real-noisy-local-sip-001");
    assert.deepEqual(artifact.report.replayMetrics.at(-1)?.captureEvidence, {
      recordedAt: "2026-07-05T06:40:00.000Z",
      audioSourceUri: "artifacts/local-sip/real-noisy-local-sip-001.wav",
      audioSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      sourceManifestUri: "artifacts/local-sip/proof-manifest-001.json",
      sourceManifestSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      noiseProfile: "cafe_noise",
      runtimeHost: "local-rtc-asr-host",
    });
    assert.equal(artifact.report.replayDecisions.at(-1)?.captureId, "real-noisy-local-sip-001");
    assert.equal(artifact.report.replayDecisions.at(-1)?.enableForLiveDemo, true);
    assert.deepEqual(artifact.reviewGate.realCaptureReplayIds, ["real-noisy-local-sip-001"]);
    assert.deepEqual(artifact.reviewGate.passingRealCaptureReplayIds, ["real-noisy-local-sip-001"]);
    assert.deepEqual(artifact.reviewGate.blockedRealCaptureReplayIds, []);
    assert.deepEqual(artifact.reviewGate.realCaptureReplayEvidence, [
      {
        captureId: "real-noisy-local-sip-001",
        status: "passing",
        enableForLiveDemo: true,
        failingEvidence: [],
        reasons: [
          "wer_improved",
          "endpointing_no_regression",
          "barge_in_risk_no_regression",
          "latency_within_budget",
          "cpu_cost_allowed",
        ],
        wordErrorRateDelta: 0.12,
        addedLatencyBudgetHeadroomMs: 7,
        cpuP95BudgetHeadroomPercent: 38,
        recordedAt: "2026-07-05T06:40:00.000Z",
        audioSourceUri: "artifacts/local-sip/real-noisy-local-sip-001.wav",
        audioSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sourceManifestUri: "artifacts/local-sip/proof-manifest-001.json",
        sourceManifestSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        noiseProfile: "cafe_noise",
        runtimeHost: "local-rtc-asr-host",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report accepts no-worse endpointing and barge-in improvements", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-noworse-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-006",
          recorded_at: "2026-07-05T09:35:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-006.wav",
          audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source_manifest_uri: "artifacts/local-sip/proof-manifest-006.json",
          source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller improves from unstable endpointing and high barge-in risk",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "unstable",
            barge_in_risk: "high",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: { replayDecisions: Array<{ captureId: string; enableForLiveDemo: boolean; reasons: string[] }> };
      reviewGate: { issueCloseReady: boolean; nextEvidence: string[] };
    };
    const decision = artifact.report.replayDecisions.at(-1);

    assert.equal(artifact.reviewGate.issueCloseReady, true);
    assert.deepEqual(artifact.reviewGate.nextEvidence, []);
    assert.equal(decision?.captureId, "real-noisy-local-sip-006");
    assert.equal(decision?.enableForLiveDemo, true);
    assert.ok(decision?.reasons.includes("endpointing_no_regression"));
    assert.ok(decision?.reasons.includes("barge_in_risk_no_regression"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report accepts multiple real capture replay manifests", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-multiple-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const firstCaptureReplayPath = path.join(tempDir, "real-capture-replay-1.json");
  const secondCaptureReplayPath = path.join(tempDir, "real-capture-replay-2.json");

  const buildCaptureReplay = (captureId: string, recordedAt: string) => ({
    capture_id: captureId,
    recorded_at: recordedAt,
    audio_source_uri: `artifacts/local-sip/${captureId}.wav`,
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: `artifacts/local-sip/${captureId}-manifest.json`,
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "cafe_noise",
    scenario: "local SIP caller with repeatable noisy capture evidence",
    latency_setting_ms: 12.5,
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I need to cansel my policy",
      word_error_rate_estimate: 0.18,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I need to cancel my policy",
      word_error_rate_estimate: 0.06,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 18,
      cpu_percent_p95: 42,
      cpu_cost_estimate: "medium",
    },
  });

  try {
    await writeFile(firstCaptureReplayPath, JSON.stringify(buildCaptureReplay("real-noisy-local-sip-101", "2026-07-05T12:00:00.000Z"), null, 2), "utf8");
    await writeFile(secondCaptureReplayPath, JSON.stringify(buildCaptureReplay("real-noisy-local-sip-102", "2026-07-05T12:05:00.000Z"), null, 2), "utf8");

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      firstCaptureReplayPath,
      "--capture-replay",
      secondCaptureReplayPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      issueCloseReady: boolean;
      captureReplaySources: Array<{ captureId: string; path: string; strictArtifactsVerified: boolean }>;
      captureReplaySourceDigest: string;
    };
    assert.equal(summary.ok, true);
    assert.equal(summary.issueCloseReady, true);
    assert.deepEqual(summary.captureReplaySources, [
      { captureId: "real-noisy-local-sip-101", path: firstCaptureReplayPath, strictArtifactsVerified: false },
      { captureId: "real-noisy-local-sip-102", path: secondCaptureReplayPath, strictArtifactsVerified: false },
    ]);

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: { replayCoverage: { realNoisyCaptureReplayCount: number; baselineEnhancedPairs: number } };
      captureReplaySources: Array<{ captureId: string; path: string; strictArtifactsVerified: boolean }>;
      captureReplaySourceDigest: string;
      reviewGate: { realCaptureReplayIds: string[]; passingRealCaptureReplayIds: string[] };
    };
    assert.equal(summary.captureReplaySourceDigest, digestCaptureReplaySources(summary.captureReplaySources));
    assert.deepEqual(artifact.captureReplaySources, summary.captureReplaySources);
    assert.equal(artifact.captureReplaySourceDigest, summary.captureReplaySourceDigest);
    assert.equal(artifact.report.replayCoverage.realNoisyCaptureReplayCount, 2);
    assert.equal(artifact.report.replayCoverage.baselineEnhancedPairs, 3);
    assert.deepEqual(artifact.reviewGate.realCaptureReplayIds, ["real-noisy-local-sip-101", "real-noisy-local-sip-102"]);
    assert.deepEqual(artifact.reviewGate.passingRealCaptureReplayIds, ["real-noisy-local-sip-101", "real-noisy-local-sip-102"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report script loads capture replay manifests from a directory", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-dir-"));
  const captureReplayDir = path.join(tempDir, "captures");
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");

  const buildCaptureReplay = (captureId: string, recordedAt: string) => ({
    capture_id: captureId,
    recorded_at: recordedAt,
    audio_source_uri: `artifacts/local-sip/${captureId}.wav`,
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: `artifacts/local-sip/${captureId}-manifest.json`,
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "speakerphone fan noise",
    scenario: "local SIP caller with repeatable noisy capture evidence",
    latency_setting_ms: 12.5,
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cansel my policy today",
      word_error_rate_estimate: 0.18,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.06,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 18,
      cpu_percent_p95: 42,
      cpu_cost_estimate: "medium",
    },
  });

  try {
    await mkdir(captureReplayDir, { recursive: true });
    await writeFile(
      path.join(captureReplayDir, "b-capture.json"),
      JSON.stringify(buildCaptureReplay("real-noisy-local-sip-202", "2026-07-05T12:05:00.000Z"), null, 2),
      "utf8",
    );
    await writeFile(path.join(captureReplayDir, "notes.txt"), "ignored", "utf8");
    await writeFile(
      path.join(captureReplayDir, "a-capture.json"),
      JSON.stringify(buildCaptureReplay("real-noisy-local-sip-201", "2026-07-05T12:00:00.000Z"), null, 2),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay-dir",
      captureReplayDir,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      issueCloseReady: boolean;
      captureReplaySources: Array<{ captureId: string; path: string; strictArtifactsVerified: boolean }>;
      captureReplaySourceDigest: string;
    };
    assert.equal(summary.ok, true);
    assert.equal(summary.issueCloseReady, true);
    assert.deepEqual(summary.captureReplaySources, [
      { captureId: "real-noisy-local-sip-201", path: path.join(captureReplayDir, "a-capture.json"), strictArtifactsVerified: false },
      { captureId: "real-noisy-local-sip-202", path: path.join(captureReplayDir, "b-capture.json"), strictArtifactsVerified: false },
    ]);

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: { replayCoverage: { realNoisyCaptureReplayCount: number; baselineEnhancedPairs: number } };
      captureReplaySources: Array<{ captureId: string; path: string; strictArtifactsVerified: boolean }>;
      captureReplaySourceDigest: string;
      reviewGate: { realCaptureReplayIds: string[]; passingRealCaptureReplayIds: string[] };
    };
    assert.equal(summary.captureReplaySourceDigest, digestCaptureReplaySources(summary.captureReplaySources));
    assert.deepEqual(artifact.captureReplaySources, summary.captureReplaySources);
    assert.equal(artifact.captureReplaySourceDigest, summary.captureReplaySourceDigest);
    assert.equal(artifact.report.replayCoverage.realNoisyCaptureReplayCount, 2);
    assert.equal(artifact.report.replayCoverage.baselineEnhancedPairs, 3);
    assert.deepEqual(artifact.reviewGate.realCaptureReplayIds, ["real-noisy-local-sip-201", "real-noisy-local-sip-202"]);
    assert.deepEqual(artifact.reviewGate.passingRealCaptureReplayIds, ["real-noisy-local-sip-201", "real-noisy-local-sip-202"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report script loads nested capture replay directories deterministically", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-nested-dir-"));
  const captureReplayDir = path.join(tempDir, "captures");
  const nestedCaptureReplayDir = path.join(captureReplayDir, "nested", "local-sip");
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");

  const buildCaptureReplay = (captureId: string, recordedAt: string) => ({
    capture_id: captureId,
    recorded_at: recordedAt,
    audio_source_uri: `artifacts/local-sip/${captureId}.wav`,
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: `artifacts/local-sip/${captureId}-manifest.json`,
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "speakerphone fan noise",
    scenario: "local SIP caller with nested noisy capture evidence",
    latency_setting_ms: 12.5,
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I want to cansel my policy today",
      word_error_rate_estimate: 0.18,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I want to cancel my policy today",
      word_error_rate_estimate: 0.06,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 18,
      cpu_percent_p95: 42,
      cpu_cost_estimate: "medium",
    },
  });

  try {
    await mkdir(nestedCaptureReplayDir, { recursive: true });
    await writeFile(
      path.join(nestedCaptureReplayDir, "b-nested-capture.json"),
      JSON.stringify(buildCaptureReplay("real-noisy-local-sip-402", "2026-07-05T12:20:00.000Z"), null, 2),
      "utf8",
    );
    await writeFile(
      path.join(captureReplayDir, "a-root-capture.json"),
      JSON.stringify(buildCaptureReplay("real-noisy-local-sip-401", "2026-07-05T12:15:00.000Z"), null, 2),
      "utf8",
    );
    await writeFile(path.join(nestedCaptureReplayDir, "notes.txt"), "ignored", "utf8");

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay-dir",
      captureReplayDir,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      captureReplaySources: Array<{ captureId: string; path: string; strictArtifactsVerified: boolean }>;
    };
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.captureReplaySources, [
      { captureId: "real-noisy-local-sip-401", path: path.join(captureReplayDir, "a-root-capture.json"), strictArtifactsVerified: false },
      { captureId: "real-noisy-local-sip-402", path: path.join(nestedCaptureReplayDir, "b-nested-capture.json"), strictArtifactsVerified: false },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report script rejects missing capture replay directories", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-missing-dir-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const missingCaptureReplayDir = path.join(tempDir, "missing-captures");

  try {
    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay-dir",
      missingCaptureReplayDir,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Missing capture replay directory:/);
    assert.match(result.stderr, new RegExp(missingCaptureReplayDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report script deduplicates explicit and directory capture replay sources", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-dedupe-"));
  const captureReplayDir = path.join(tempDir, "captures");
  const captureReplayPath = path.join(captureReplayDir, "real-capture-replay.json");
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");

  try {
    await mkdir(captureReplayDir, { recursive: true });
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-301",
          recorded_at: "2026-07-05T12:10:00.000Z",
          audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-301.wav",
          audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source_manifest_uri: "artifacts/local-sip/real-noisy-local-sip-301-manifest.json",
          source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          noise_profile: "speakerphone fan noise",
          scenario: "local SIP caller with repeatable noisy capture evidence",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I want to cansel my policy today",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I want to cancel my policy today",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--capture-replay-dir",
      captureReplayDir,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      issueCloseReady: boolean;
      captureReplaySources: Array<{ captureId: string; path: string; strictArtifactsVerified: boolean }>;
      captureReplaySourceDigest: string;
    };
    assert.equal(summary.ok, true);
    assert.equal(summary.issueCloseReady, true);
    assert.deepEqual(summary.captureReplaySources, [
      { captureId: "real-noisy-local-sip-301", path: captureReplayPath, strictArtifactsVerified: false },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report blocks mixed passing and failing real capture replays", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-mixed-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const passingCaptureReplayPath = path.join(tempDir, "real-capture-replay-pass.json");
  const failingCaptureReplayPath = path.join(tempDir, "real-capture-replay-fail.json");

  const buildCaptureReplay = (captureId: string, addedTurnLatencyMsP95: number) => ({
    capture_id: captureId,
    recorded_at: "2026-07-05T12:10:00.000Z",
    audio_source_uri: `artifacts/local-sip/${captureId}.wav`,
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: `artifacts/local-sip/${captureId}-manifest.json`,
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "cafe_noise",
    scenario: "local SIP caller with mixed noisy capture evidence",
    latency_setting_ms: 12.5,
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I need to cansel my policy",
      word_error_rate_estimate: 0.18,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I need to cancel my policy",
      word_error_rate_estimate: 0.06,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: addedTurnLatencyMsP95,
      cpu_percent_p95: 42,
      cpu_cost_estimate: "medium",
    },
  });

  try {
    await writeFile(
      passingCaptureReplayPath,
      JSON.stringify(buildCaptureReplay("real-noisy-local-sip-201", 18), null, 2),
      "utf8",
    );
    await writeFile(
      failingCaptureReplayPath,
      JSON.stringify(buildCaptureReplay("real-noisy-local-sip-202", 31), null, 2),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      failingCaptureReplayPath,
      "--capture-replay",
      passingCaptureReplayPath,
      "--require-close-ready",
    ]);

    assert.equal(result.exitCode, 1);
    const summary = JSON.parse(result.stdout) as { ok: boolean; issueCloseReady: boolean; blockers: string[] };
    assert.equal(summary.ok, false);
    assert.equal(summary.issueCloseReady, false);
    assert.ok(summary.blockers.some((blocker) => blocker.includes("real-noisy-local-sip-202")));

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      report: { replayCoverage: { liveDemoGate: string; missingEvidence: string[] } };
      reviewGate: {
        issueCloseReady: boolean;
        checks: Record<string, boolean>;
        nextEvidence: string[];
        passingRealCaptureReplayIds: string[];
        blockedRealCaptureReplayIds: string[];
      };
    };
    assert.equal(artifact.reviewGate.issueCloseReady, false);
    assert.equal(artifact.report.replayCoverage.liveDemoGate, "blocked_until_real_capture");
    assert.deepEqual(artifact.report.replayCoverage.missingEvidence, [
      "measured_12_5_ms_added_turn_latency_under_25_ms_p95",
    ]);
    assert.equal(artifact.reviewGate.checks.addedLatencyP95, false);
    assert.deepEqual(artifact.reviewGate.nextEvidence, ["measured_12_5_ms_added_turn_latency_under_25_ms_p95"]);
    assert.deepEqual(artifact.reviewGate.passingRealCaptureReplayIds, ["real-noisy-local-sip-201"]);
    assert.deepEqual(artifact.reviewGate.blockedRealCaptureReplayIds, ["real-noisy-local-sip-202"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report rejects duplicate real capture replay ids", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-duplicate-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const firstCaptureReplayPath = path.join(tempDir, "real-capture-replay-1.json");
  const secondCaptureReplayPath = path.join(tempDir, "real-capture-replay-2.json");

  const captureReplay = {
    capture_id: "real-noisy-local-sip-301",
    recorded_at: "2026-07-06T14:25:00.000Z",
    audio_source_uri: "artifacts/local-sip/real-noisy-local-sip-301.wav",
    audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source_manifest_uri: "artifacts/local-sip/real-noisy-local-sip-301-manifest.json",
    source_manifest_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    noise_profile: "cafe_noise",
    scenario: "local SIP caller with duplicate capture evidence",
    latency_setting_ms: 12.5,
    runtime_host: "local-rtc-asr-host",
    baseline_rtc_asr: {
      transcript: "I need to cansel my policy",
      word_error_rate_estimate: 0.18,
      endpointing_stability: "acceptable",
      barge_in_risk: "medium",
    },
    enhanced_rtc_asr: {
      transcript: "I need to cancel my policy",
      word_error_rate_estimate: 0.06,
      endpointing_stability: "stable",
      barge_in_risk: "low",
      added_turn_latency_ms_p95: 18,
      cpu_percent_p95: 42,
      cpu_cost_estimate: "medium",
    },
  };

  try {
    await writeFile(firstCaptureReplayPath, JSON.stringify(captureReplay, null, 2), "utf8");
    await writeFile(
      secondCaptureReplayPath,
      JSON.stringify({ ...captureReplay, recorded_at: "2026-07-06T14:30:00.000Z" }, null, 2),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      firstCaptureReplayPath,
      "--capture-replay",
      secondCaptureReplayPath,
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Duplicate capture replay id: real-noisy-local-sip-301/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report strict mode verifies capture artifact files and hashes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-strict-artifacts-"));
  const artifactDir = path.join(process.cwd(), "artifacts", `strict-capture-${path.basename(tempDir)}`);
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");
  const audioUri = `artifacts/${path.basename(artifactDir)}/real-noisy-local-sip-201.wav`;
  const sourceManifestUri = `artifacts/${path.basename(artifactDir)}/proof-manifest-201.json`;
  const audioContents = "fake wav evidence for strict hash validation\n";
  const sourceManifestContents = JSON.stringify({
    proof: "strict replay source",
    capture_id: "real-noisy-local-sip-201",
    audio_source_uri: audioUri,
    recorded_at: "2026-07-06T13:10:00.000Z",
    noise_profile: "cafe_noise",
    scenario: "local SIP caller with strict artifact evidence",
    runtime_host: "local-rtc-asr-host",
  });
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(process.cwd(), audioUri), audioContents, "utf8");
    await writeFile(path.join(process.cwd(), sourceManifestUri), sourceManifestContents, "utf8");
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-201",
          recorded_at: "2026-07-06T13:10:00.000Z",
          audio_source_uri: audioUri,
          audio_sha256: sha256(audioContents),
          source_manifest_uri: sourceManifestUri,
          source_manifest_sha256: sha256(sourceManifestContents),
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with strict artifact evidence",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--require-close-ready",
      "--strict-capture-artifacts",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      closeGateStatus: string;
      issueCloseReady: boolean;
      strictArtifactVerification: { requiredForClose: boolean; verified: boolean; reason: string };
    };
    assert.equal(summary.ok, true);
    assert.equal(summary.closeGateStatus, "ready_to_close");
    assert.equal(summary.issueCloseReady, true);
    assert.deepEqual(summary.strictArtifactVerification, {
      requiredForClose: true,
      verified: true,
      sourceCount: 1,
      verifiedSourceCount: 1,
      unverifiedSourceCount: 0,
      reason: "all_loaded_capture_replay_artifacts_verified",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report strict mode rejects non-json source manifests", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-strict-manifest-json-"));
  const artifactDir = path.join(process.cwd(), "artifacts", `strict-capture-${path.basename(tempDir)}`);
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");
  const audioUri = `artifacts/${path.basename(artifactDir)}/real-noisy-local-sip-202.wav`;
  const sourceManifestUri = `artifacts/${path.basename(artifactDir)}/proof-manifest-202.json`;
  const audioContents = "fake wav evidence for strict source manifest validation\n";
  const sourceManifestContents = "not json\n";
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(process.cwd(), audioUri), audioContents, "utf8");
    await writeFile(path.join(process.cwd(), sourceManifestUri), sourceManifestContents, "utf8");
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-202",
          recorded_at: "2026-07-06T13:12:00.000Z",
          audio_source_uri: audioUri,
          audio_sha256: sha256(audioContents),
          source_manifest_uri: sourceManifestUri,
          source_manifest_sha256: sha256(sourceManifestContents),
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with invalid strict source manifest evidence",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--strict-capture-artifacts",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid source manifest JSON for strict capture replay artifact/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report strict mode rejects non-object source manifests", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-strict-manifest-object-"));
  const artifactDir = path.join(process.cwd(), "artifacts", `strict-capture-${path.basename(tempDir)}`);
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");
  const audioUri = `artifacts/${path.basename(artifactDir)}/real-noisy-local-sip-203.wav`;
  const sourceManifestUri = `artifacts/${path.basename(artifactDir)}/proof-manifest-203.json`;
  const audioContents = "fake wav evidence for strict source manifest object validation\n";
  const sourceManifestContents = "[\"not a source manifest object\"]\n";
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(process.cwd(), audioUri), audioContents, "utf8");
    await writeFile(path.join(process.cwd(), sourceManifestUri), sourceManifestContents, "utf8");
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-203",
          recorded_at: "2026-07-06T13:14:00.000Z",
          audio_source_uri: audioUri,
          audio_sha256: sha256(audioContents),
          source_manifest_uri: sourceManifestUri,
          source_manifest_sha256: sha256(sourceManifestContents),
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with non-object strict source manifest evidence",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--strict-capture-artifacts",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid source manifest JSON object for strict capture replay artifact/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report strict mode rejects source manifest capture id mismatches", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-strict-manifest-id-"));
  const artifactDir = path.join(process.cwd(), "artifacts", `strict-capture-${path.basename(tempDir)}`);
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");
  const audioUri = `artifacts/${path.basename(artifactDir)}/real-noisy-local-sip-204.wav`;
  const sourceManifestUri = `artifacts/${path.basename(artifactDir)}/proof-manifest-204.json`;
  const audioContents = "fake wav evidence for strict source manifest id validation\n";
  const sourceManifestContents = JSON.stringify({
    capture_id: "real-noisy-local-sip-other",
    audio_source_uri: audioUri,
  });
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(process.cwd(), audioUri), audioContents, "utf8");
    await writeFile(path.join(process.cwd(), sourceManifestUri), sourceManifestContents, "utf8");
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-204",
          recorded_at: "2026-07-06T13:16:00.000Z",
          audio_source_uri: audioUri,
          audio_sha256: sha256(audioContents),
          source_manifest_uri: sourceManifestUri,
          source_manifest_sha256: sha256(sourceManifestContents),
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with mismatched strict source manifest evidence",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--strict-capture-artifacts",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Source manifest capture_id mismatch for strict capture replay artifact/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report strict mode rejects source manifest audio source mismatches", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-strict-manifest-audio-"));
  const artifactDir = path.join(process.cwd(), "artifacts", `strict-capture-${path.basename(tempDir)}`);
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");
  const audioUri = `artifacts/${path.basename(artifactDir)}/real-noisy-local-sip-205.wav`;
  const sourceManifestUri = `artifacts/${path.basename(artifactDir)}/proof-manifest-205.json`;
  const audioContents = "fake wav evidence for strict source manifest audio validation\n";
  const sourceManifestContents = JSON.stringify({
    capture_id: "real-noisy-local-sip-205",
    audio_source_uri: `artifacts/${path.basename(artifactDir)}/different-audio.wav`,
  });
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(process.cwd(), audioUri), audioContents, "utf8");
    await writeFile(path.join(process.cwd(), sourceManifestUri), sourceManifestContents, "utf8");
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-205",
          recorded_at: "2026-07-06T13:16:00.000Z",
          audio_source_uri: audioUri,
          audio_sha256: sha256(audioContents),
          source_manifest_uri: sourceManifestUri,
          source_manifest_sha256: sha256(sourceManifestContents),
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with mismatched strict source manifest audio evidence",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--strict-capture-artifacts",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Source manifest audio_source_uri mismatch for strict capture replay artifact/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report strict mode rejects source manifest recorded-at mismatches", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-strict-manifest-recorded-"));
  const artifactDir = path.join(process.cwd(), "artifacts", `strict-capture-${path.basename(tempDir)}`);
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");
  const audioUri = `artifacts/${path.basename(artifactDir)}/real-noisy-local-sip-206.wav`;
  const sourceManifestUri = `artifacts/${path.basename(artifactDir)}/proof-manifest-206.json`;
  const audioContents = "fake wav evidence for strict source manifest timestamp validation\n";
  const sourceManifestContents = JSON.stringify({
    capture_id: "real-noisy-local-sip-206",
    audio_source_uri: audioUri,
    recorded_at: "2026-07-06T13:29:00.000Z",
  });
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(process.cwd(), audioUri), audioContents, "utf8");
    await writeFile(path.join(process.cwd(), sourceManifestUri), sourceManifestContents, "utf8");
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-206",
          recorded_at: "2026-07-06T13:28:00.000Z",
          audio_source_uri: audioUri,
          audio_sha256: sha256(audioContents),
          source_manifest_uri: sourceManifestUri,
          source_manifest_sha256: sha256(sourceManifestContents),
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with mismatched strict source manifest timestamp evidence",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--strict-capture-artifacts",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Source manifest recorded_at mismatch for strict capture replay artifact/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report strict mode rejects source manifest scenario mismatches", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-strict-manifest-scenario-"));
  const artifactDir = path.join(process.cwd(), "artifacts", `strict-capture-${path.basename(tempDir)}`);
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");
  const audioUri = `artifacts/${path.basename(artifactDir)}/real-noisy-local-sip-207.wav`;
  const sourceManifestUri = `artifacts/${path.basename(artifactDir)}/proof-manifest-207.json`;
  const audioContents = "fake wav evidence for strict source manifest scenario validation\n";
  const sourceManifestContents = JSON.stringify({
    capture_id: "real-noisy-local-sip-207",
    audio_source_uri: audioUri,
    recorded_at: "2026-07-06T13:30:00.000Z",
    noise_profile: "cafe_noise",
    scenario: "different noisy caller scenario",
    runtime_host: "local-rtc-asr-host",
  });
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(process.cwd(), audioUri), audioContents, "utf8");
    await writeFile(path.join(process.cwd(), sourceManifestUri), sourceManifestContents, "utf8");
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-207",
          recorded_at: "2026-07-06T13:30:00.000Z",
          audio_source_uri: audioUri,
          audio_sha256: sha256(audioContents),
          source_manifest_uri: sourceManifestUri,
          source_manifest_sha256: sha256(sourceManifestContents),
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with scenario-bound source manifest evidence",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--strict-capture-artifacts",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Source manifest scenario mismatch for strict capture replay artifact/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(artifactDir, { recursive: true, force: true });
  }
});


test("speech enhancement spike report strict mode rejects missing capture artifact files", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "acc-speech-enhancement-strict-missing-"));
  const outputPath = path.join(tempDir, "speech-enhancement-spike.json");
  const captureReplayPath = path.join(tempDir, "real-capture-replay.json");

  try {
    await writeFile(
      captureReplayPath,
      JSON.stringify(
        {
          capture_id: "real-noisy-local-sip-202",
          recorded_at: "2026-07-06T13:15:00.000Z",
          audio_source_uri: "artifacts/strict-missing/real-noisy-local-sip-202.wav",
          audio_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          source_manifest_uri: "artifacts/strict-missing/proof-manifest-202.json",
          source_manifest_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          noise_profile: "cafe_noise",
          scenario: "local SIP caller with missing strict artifact evidence",
          latency_setting_ms: 12.5,
          runtime_host: "local-rtc-asr-host",
          baseline_rtc_asr: {
            transcript: "I need to cansel my policy",
            word_error_rate_estimate: 0.18,
            endpointing_stability: "acceptable",
            barge_in_risk: "medium",
          },
          enhanced_rtc_asr: {
            transcript: "I need to cancel my policy",
            word_error_rate_estimate: 0.06,
            endpointing_stability: "stable",
            barge_in_risk: "low",
            added_turn_latency_ms_p95: 18,
            cpu_percent_p95: 42,
            cpu_cost_estimate: "medium",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runNode([
      "scripts/speech-enhancement-spike-report.mjs",
      "--out",
      outputPath,
      "--capture-replay",
      captureReplayPath,
      "--strict-capture-artifacts",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Missing capture replay artifact for audio_source_uri/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("speech enhancement spike report script rejects unknown arguments", async () => {
  const result = await runNode(["scripts/speech-enhancement-spike-report.mjs", "--outt", "artifact.json"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown argument: --outt/);
});

test("speech enhancement spike report script rejects missing argument values", async () => {
  const result = await runNode(["scripts/speech-enhancement-spike-report.mjs", "--capture-replay", "--require-close-ready"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Missing value for --capture-replay/);
});
