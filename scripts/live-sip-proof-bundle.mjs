#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();

function argValue(flag, fallback = undefined) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function rel(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function artifact(filePath, artifactId, kind, mimeType) {
  const stats = await stat(filePath);
  return {
    artifact_id: artifactId,
    kind,
    role: "input",
    uri: rel(filePath),
    mime_type: mimeType,
    sha256: await sha256File(filePath),
    size_bytes: stats.size,
    source: "agentic-contact-center",
    readiness: stats.size > 0 ? "ready" : "blocked",
  };
}

async function integrity(filePath, artifactId, kind) {
  const stats = await stat(filePath);
  return {
    artifactId,
    kind,
    path: rel(filePath),
    sha256: await sha256File(filePath),
    sizeBytes: stats.size,
    readiness: stats.size > 0 ? "ready" : "blocked",
  };
}

async function main() {
  const liveManifestPath = path.resolve(repoRoot, argValue("--live-manifest") || "artifacts/local-sip-selftest/local-sip-live-proof-manifest.json");
  const outDir = path.resolve(repoRoot, argValue("--out-dir") || "artifacts/live-sip-proof-bundle");
  await mkdir(outDir, { recursive: true });
  const liveManifest = JSON.parse(await readFile(liveManifestPath, "utf8"));
  const audioPath = path.resolve(repoRoot, liveManifest.artifacts.audioWav);
  const sipLogPath = path.resolve(repoRoot, liveManifest.artifacts.sipLog);
  const runtimeTracePath = path.join(outDir, "runtime-event-trace.json");
  const blockerPath = path.join(outDir, "rtc-asr-blocker.json");
  const labels = [
    liveManifest.runtimeModeLabels.telephony,
    liveManifest.runtimeModeLabels.media,
    liveManifest.runtimeModeLabels.rtcAsr,
    liveManifest.runtimeModeLabels.credentialsMode === "signalwire_live" ? "signalwire_live" : "mocked_telephony",
  ];
  const runtimeTrace = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    callId: liveManifest.callId,
    sipCallId: liveManifest.sipCallId,
    localSip: liveManifest.localSip,
    runtimeModeLabels: liveManifest.runtimeModeLabels,
    reviewReady: liveManifest.reviewReady,
    blockers: liveManifest.blockers,
  };
  await writeFile(runtimeTracePath, `${JSON.stringify(runtimeTrace, null, 2)}\n`, "utf8");
  await writeFile(blockerPath, `${JSON.stringify({ provider: "rtc-asr", mode: liveManifest.runtimeModeLabels.rtcAsr, blockers: liveManifest.blockers.filter((b) => b.toLowerCase().includes("rtc")), nextAction: "Run rtc-asr and set RTC_ASR_WS_URL before rerunning live proof." }, null, 2)}\n`, "utf8");

  const assertRequest = {
    spec_ref: {
      spec_id: "agentic-contact-center/local-sip-live-capture",
      spec_kind: "scenario",
      spec_version: "2026-06-30",
      assert_project: "conversation-agent-evals",
      assert_commit: null,
    },
    evidence: {
      call_media: [await artifact(audioPath, "local-sip-real-caller-audio-wav", "call_media", "audio/wav")],
      additional_artifacts: [
        await artifact(sipLogPath, "local-sip-and-freeswitch-sip-log", "sip_log", "application/json"),
        await artifact(runtimeTracePath, "agentic-contact-center-runtime-event-trace", "action_trace", "application/json"),
        await artifact(blockerPath, "rtc-asr-live-status", "manifest", "application/json"),
      ],
      provenance: {
        source_repo: "agonza1/agentic-contact-center",
        workboard_card: "872af947-ef57-47bd-a4f3-3750f54e1948",
        live_manifest: rel(liveManifestPath),
      },
    },
    runtime_config: {
      execution_mode: "async",
      invocation_target: { transport: "http_sidecar", environment: "local", base_url: "http://127.0.0.1:8091", entrypoint: "/v2/runs", timeout_seconds: 300 },
      environment_labels: ["agentic-contact-center", ...labels],
    },
    platform_metadata: {
      user_id: "alberto-local-sip-proof",
      project_id: "agentic-contact-center",
      project_run_label: "workboard-872af947-local-sip-live-capture",
      initiated_by: "local-script",
      notes: liveManifest.reviewReady ? "Local SIP live capture bundle." : "Not review-ready; blockers list explains missing live proof requirements.",
      labels,
      retention_days: 90,
    },
  };
  const assertRequestPath = path.join(outDir, "conversation-agent-evals-assert-request.json");
  await writeFile(assertRequestPath, `${JSON.stringify(assertRequest, null, 2)}\n`, "utf8");
  const artifactIntegrity = [
    await integrity(liveManifestPath, "local-sip-live-proof-manifest", "manifest"),
    await integrity(audioPath, "local-sip-real-caller-audio-wav", "call_media"),
    await integrity(sipLogPath, "local-sip-and-freeswitch-sip-log", "sip_log"),
    await integrity(runtimeTracePath, "agentic-contact-center-runtime-event-trace", "action_trace"),
    await integrity(blockerPath, "rtc-asr-live-status", "manifest"),
    await integrity(assertRequestPath, "conversation-agent-evals-assert-request", "assert_request"),
  ];
  const validationSummary = {
    status: liveManifest.reviewReady === true ? "ready_for_review" : "blocked_before_review",
    checks: {
      acceptedInvite: liveManifest.localSip?.acceptedInvite === true,
      capturedRtp: Number(liveManifest.localSip?.rtpPacketCount ?? 0) > 0,
      liveCapture: liveManifest.runtimeModeLabels?.media === "live_capture",
      rtcAsrLive: liveManifest.runtimeModeLabels?.rtcAsr === "rtc_asr_live",
      artifactsPresent: artifactIntegrity.every((artifact) => artifact.readiness === "ready"),
    },
    blockers: liveManifest.blockers,
  };
  const bundleManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workboardCard: "872af947-ef57-47bd-a4f3-3750f54e1948",
    reviewReady: liveManifest.reviewReady === true,
    runtimeModeLabels: liveManifest.runtimeModeLabels,
    labels,
    artifacts: {
      liveManifest: rel(liveManifestPath),
      audioCapture: rel(audioPath),
      sipLogs: rel(sipLogPath),
      runtimeEventTrace: rel(runtimeTracePath),
      rtcAsrStatus: rel(blockerPath),
      conversationAgentEvalsRequest: rel(assertRequestPath),
    },
    artifactIntegrity,
    validationSummary,
    blockers: liveManifest.blockers,
  };
  const bundleManifestPath = path.join(outDir, "proof-bundle-manifest.json");
  await writeFile(bundleManifestPath, `${JSON.stringify(bundleManifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ manifest: rel(bundleManifestPath), reviewReady: bundleManifest.reviewReady, blockers: bundleManifest.blockers }, null, 2));
  if (!bundleManifest.reviewReady && process.argv.includes("--require-review-ready")) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
