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

async function sipLogEvidence(filePath) {
  const raw = await readFile(filePath, "utf8");
  let entries = [];
  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      });
  }
  const startLines = entries
    .map((entry) => typeof entry?.startLine === "string" ? entry.startLine : "")
    .filter(Boolean);
  const eventNames = entries
    .flatMap((entry) => Array.isArray(entry?.events) ? entry.events : [entry])
    .map((entry) => typeof entry?.headers?.["Event-Name"] === "string" ? entry.headers["Event-Name"] : "")
    .filter(Boolean);
  return {
    entryCount: entries.length,
    hasInvite: startLines.some((line) => line.startsWith("INVITE ")) || eventNames.includes("CHANNEL_ANSWER"),
    hasAcceptedInviteResponse: startLines.some((line) => line.startsWith("SIP/2.0 200")) || eventNames.includes("CHANNEL_ANSWER"),
  };
}

async function rtcAsrEvidence(filePath) {
  if (!filePath) return { required: false, ready: false, reason: "rtc-asr transcript evidence is not attached." };
  const raw = await readFile(filePath, "utf8");
  const parsed = parseJsonOrJsonLines(raw);
  if (parsed.length === 0) {
    return { required: true, ready: false, reason: "rtc-asr transcript evidence is not valid JSON." };
  }
  const transcript = parsed.flatMap(transcriptFragments).join(" ").trim();
  const final = parsed.some(isFinalTranscriptEvidence);
  if (!transcript) return { required: true, ready: false, reason: "rtc-asr transcript evidence has no non-empty transcript text." };
  if (!final) return { required: true, ready: false, reason: "rtc-asr transcript evidence is missing a final transcript marker." };
  return { required: true, ready: true, transcriptChars: transcript.length, eventCount: parsed.length };
}

function parseJsonOrJsonLines(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      });
  }
}

function transcriptFragments(entry) {
  return [
    typeof entry?.transcript === "string" ? entry.transcript : "",
    typeof entry?.transcript?.text === "string" ? entry.transcript.text : "",
    typeof entry?.text === "string" ? entry.text : "",
    typeof entry?.result?.text === "string" ? entry.result.text : "",
    typeof entry?.result?.transcript === "string" ? entry.result.transcript : "",
    typeof entry?.alternatives?.[0]?.transcript === "string" ? entry.alternatives[0].transcript : "",
    typeof entry?.channel?.alternatives?.[0]?.transcript === "string" ? entry.channel.alternatives[0].transcript : "",
    ...(Array.isArray(entry?.segments) ? entry.segments.map((segment) => typeof segment?.text === "string" ? segment.text : "") : []),
  ].filter(Boolean);
}

function isFinalTranscriptEvidence(entry) {
  return entry?.final === true
    || entry?.isFinal === true
    || entry?.is_final === true
    || entry?.transcript?.final === true
    || entry?.result?.final === true
    || entry?.speech_final === true
    || entry?.status === "final"
    || entry?.type === "transcript.final";
}

async function wavEvidence(filePath) {
  const buffer = await readFile(filePath);
  const riffHeader = buffer.subarray(0, 4).toString("ascii");
  const waveHeader = buffer.subarray(8, 12).toString("ascii");
  const hasRiffWaveHeader = riffHeader === "RIFF" && waveHeader === "WAVE";
  let audioFormat = null;
  let channelCount = null;
  let sampleRateHz = null;
  let bitsPerSample = null;
  let declaredDataBytes = 0;
  let dataChunkEnd = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunkId = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt " && offset + 8 + chunkSize <= buffer.length && chunkSize >= 16) {
      audioFormat = buffer.readUInt16LE(offset + 8);
      channelCount = buffer.readUInt16LE(offset + 10);
      sampleRateHz = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    }
    if (chunkId === "data") {
      declaredDataBytes = chunkSize;
      dataChunkEnd = offset + 8 + chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  const hasPcmFormat = audioFormat === 1 && Number(channelCount) > 0 && Number(sampleRateHz) > 0 && Number(bitsPerSample) > 0;
  const hasAudioPayload = declaredDataBytes > 0 && buffer.length >= dataChunkEnd;
  return {
    ready: hasRiffWaveHeader && hasPcmFormat && hasAudioPayload,
    hasRiffWaveHeader,
    hasPcmFormat,
    hasAudioPayload,
    audioFormat,
    channelCount,
    sampleRateHz,
    bitsPerSample,
    declaredDataBytes,
    sizeBytes: buffer.length,
  };
}

async function sourceArtifactIntegrityEvidence(liveManifest) {
  const artifacts = Array.isArray(liveManifest.artifactIntegrity) ? liveManifest.artifactIntegrity : [];
  const checkedArtifacts = await Promise.all(artifacts.map(async (artifact) => {
    const artifactPath = artifact?.path ?? artifact?.uri ?? null;
    const resolvedPath = artifactPath ? path.resolve(repoRoot, artifactPath) : null;
    const currentStats = resolvedPath ? await stat(resolvedPath).catch(() => null) : null;
    const currentSha256 = currentStats && resolvedPath ? await sha256File(resolvedPath) : null;
    const expectedSha256 = artifact?.sha256 ?? null;
    const expectedSizeBytes = Number.isFinite(Number(artifact?.sizeBytes ?? artifact?.size_bytes)) ? Number(artifact?.sizeBytes ?? artifact?.size_bytes) : null;
    const sha256Matches = !expectedSha256 || currentSha256 === expectedSha256;
    const sizeMatches = expectedSizeBytes === null || currentStats?.size === expectedSizeBytes;
    return {
      artifactId: artifact?.artifactId ?? artifact?.artifact_id ?? "unknown",
      readiness: artifact?.readiness ?? "unknown",
      path: artifactPath,
      exists: currentStats !== null,
      expectedSha256,
      currentSha256,
      sha256Matches,
      expectedSizeBytes,
      currentSizeBytes: currentStats?.size ?? null,
      sizeMatches,
    };
  }));
  const blockedArtifacts = checkedArtifacts.filter((artifact) => artifact.readiness && artifact.readiness !== "ready");
  const changedArtifacts = checkedArtifacts.filter((artifact) => !artifact.exists || !artifact.sha256Matches || !artifact.sizeMatches);
  return {
    checked: artifacts.length,
    blocked: blockedArtifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      readiness: artifact.readiness,
      path: artifact.path,
    })),
    changed: changedArtifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      path: artifact.path,
      exists: artifact.exists,
      expectedSha256: artifact.expectedSha256,
      currentSha256: artifact.currentSha256,
      sha256Matches: artifact.sha256Matches,
      expectedSizeBytes: artifact.expectedSizeBytes,
      currentSizeBytes: artifact.currentSizeBytes,
      sizeMatches: artifact.sizeMatches,
    })),
    ready: blockedArtifacts.length === 0 && changedArtifacts.length === 0,
  };
}

function reviewNextActions(liveManifest) {
  const actions = [];
  if (liveManifest.runtimeModeLabels?.media !== "live_capture") {
    actions.push("Place a real local SIP/FreeSWITCH softphone call and rerun the live proof without --self-test.");
  }
  if (liveManifest.runtimeModeLabels?.rtcAsr !== "rtc_asr_live") {
    actions.push("Start rtc-asr, set RTC_ASR_WS_URL, and rerun the live proof to capture a websocket-backed transcript.");
  }
  if (Number(liveManifest.localSip?.rtpPacketCount ?? 0) <= 0) {
    actions.push("Verify RTP routing and rerun until caller audio packets are captured.");
  }
  for (const action of liveManifest.reviewGate?.nextActions ?? []) {
    if (!actions.includes(action)) actions.push(action);
  }
  return actions;
}

function reviewGate(liveManifest, artifactIntegrity, sipEvidence, rtcAsrEvidenceResult, wavEvidenceResult, sourceArtifactIntegrityResult) {
  const checks = {
    acceptedInvite: liveManifest.localSip?.acceptedInvite === true,
    sipLogHasInvite: sipEvidence.hasInvite,
    sipLogHasAcceptedInvite: sipEvidence.hasAcceptedInviteResponse,
    capturedRtp: Number(liveManifest.localSip?.rtpPacketCount ?? 0) > 0,
    callerAudioWavValid: wavEvidenceResult.ready === true,
    liveCapture: liveManifest.runtimeModeLabels?.media === "live_capture",
    rtcAsrLive: liveManifest.runtimeModeLabels?.rtcAsr === "rtc_asr_live",
    rtcAsrEvidenceValid: liveManifest.runtimeModeLabels?.rtcAsr !== "rtc_asr_live" || rtcAsrEvidenceResult.ready === true,
    artifactsPresent: artifactIntegrity.every((artifact) => artifact.readiness === "ready"),
    sourceArtifactIntegrityReady: sourceArtifactIntegrityResult.ready === true,
    sourceManifestReviewReady: liveManifest.reviewReady === true,
  };
  const requiredLabels = ["local_sip", "live_capture", "rtc_asr_live"];
  const labels = [
    liveManifest.runtimeModeLabels?.telephony,
    liveManifest.runtimeModeLabels?.media,
    liveManifest.runtimeModeLabels?.rtcAsr,
  ].filter(Boolean);
  return {
    passed: Object.values(checks).every(Boolean) && liveManifest.reviewReady === true,
    requiredLabels,
    missingLabels: requiredLabels.filter((label) => !labels.includes(label)),
    checks,
    failureReasons: reviewGateFailureReasons(checks, { rtcAsrEvidence: rtcAsrEvidenceResult }),
  };
}

function reviewGateFailureReasons(checks, details = {}) {
  const reasons = {
    acceptedInvite: "No accepted local SIP INVITE was recorded.",
    sipLogHasInvite: "SIP log does not include an INVITE entry, so the source manifest cannot prove a local SIP call.",
    sipLogHasAcceptedInvite: "SIP log does not include an accepted INVITE response or FreeSWITCH CHANNEL_ANSWER event.",
    capturedRtp: "No RTP packets were captured for caller audio.",
    callerAudioWavValid: "Caller audio artifact is not a non-empty PCM RIFF/WAVE file with captured audio payload.",
    liveCapture: "Media is not labeled live_capture; rerun with a real local SIP/FreeSWITCH softphone call.",
    rtcAsrLive: "rtc-asr is not labeled rtc_asr_live; start rtc-asr and set RTC_ASR_WS_URL before rerunning.",
    rtcAsrEvidenceValid: details.rtcAsrEvidence?.reason
      ? `rtc-asr live transcript evidence failed validation: ${details.rtcAsrEvidence.reason}`
      : "rtc-asr live transcript evidence is missing, invalid, empty, or not final.",
    artifactsPresent: "One or more required proof artifacts are missing or empty.",
    sourceArtifactIntegrityReady: "Source live proof manifest reports blocked, missing, or changed artifacts.",
    sourceManifestReviewReady: "Source live proof manifest is not review-ready; inspect its blockers before submitting the bundle.",
  };
  return Object.fromEntries(Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => [name, reasons[name]]));
}

function markdownChecklist(checks) {
  return Object.entries(checks)
    .map(([name, passed]) => `- [${passed ? "x" : " "}] ${name}`)
    .join("\n");
}

function reviewGateReport(bundleManifest) {
  const gate = bundleManifest.reviewGate;
  const nextActions = bundleManifest.validationSummary.nextActions.length > 0
    ? bundleManifest.validationSummary.nextActions.map((action) => `- ${action}`).join("\n")
    : "- No follow-up actions required.";
  const missingLabels = gate.missingLabels.length > 0 ? gate.missingLabels.join(", ") : "none";
  const blockers = bundleManifest.blockers.length > 0 ? bundleManifest.blockers.map((blocker) => `- ${blocker}`).join("\n") : "- none";
  const failedChecks = Object.entries(gate.failureReasons).length > 0
    ? Object.entries(gate.failureReasons).map(([name, reason]) => `- ${name}: ${reason}`).join("\n")
    : "- none";
  const sourceGateMissingLabels = bundleManifest.sourceManifestReviewGate?.missingLabels?.length > 0
    ? bundleManifest.sourceManifestReviewGate.missingLabels.join(", ")
    : "none";
  const sourceGateNextActions = bundleManifest.sourceManifestReviewGate?.nextActions?.length > 0
    ? bundleManifest.sourceManifestReviewGate.nextActions.map((action) => `- ${action}`).join("\n")
    : "- none";

  return [
    "# Local SIP Review Gate",
    "",
    `Status: ${bundleManifest.validationSummary.status}`,
    `Review ready: ${bundleManifest.reviewReady ? "yes" : "no"}`,
    `Missing runtime labels: ${missingLabels}`,
    "",
    "## Checks",
    "",
    markdownChecklist(gate.checks),
    "",
    "## Failed Check Reasons",
    "",
    failedChecks,
    "",
    "## Source Manifest Review Gate",
    "",
    `Missing runtime labels: ${sourceGateMissingLabels}`,
    "",
    "Next actions:",
    sourceGateNextActions,
    "",
    "## Blockers",
    "",
    blockers,
    "",
    "## Next Actions",
    "",
    nextActions,
    "",
  ].join("\n");
}

function reviewGateReportJson(bundleManifest) {
  return {
    schemaVersion: 1,
    generatedAt: bundleManifest.generatedAt,
    workboardCard: bundleManifest.workboardCard,
    status: bundleManifest.validationSummary.status,
    reviewReady: bundleManifest.reviewReady,
    reviewGatePassed: bundleManifest.reviewGate.passed,
    requiredLabels: bundleManifest.reviewGate.requiredLabels,
    missingLabels: bundleManifest.reviewGate.missingLabels,
    checks: bundleManifest.reviewGate.checks,
    failureReasons: bundleManifest.reviewGate.failureReasons,
    blockers: bundleManifest.validationSummary.blockers,
    nextActions: bundleManifest.validationSummary.nextActions,
    sourceManifestReviewGate: bundleManifest.sourceManifestReviewGate,
    artifacts: bundleManifest.artifacts,
    artifactIntegrity: bundleManifest.artifactIntegrity.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      path: artifact.path,
      readiness: artifact.readiness,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
    })),
  };
}

async function main() {
  const liveManifestPath = path.resolve(repoRoot, argValue("--live-manifest") || "artifacts/local-sip-selftest/local-sip-live-proof-manifest.json");
  const outDir = path.resolve(repoRoot, argValue("--out-dir") || "artifacts/live-sip-proof-bundle");
  await mkdir(outDir, { recursive: true });
  const liveManifest = JSON.parse(await readFile(liveManifestPath, "utf8"));
  const audioPath = path.resolve(repoRoot, liveManifest.artifacts.audioWav);
  const sipLogPath = path.resolve(repoRoot, liveManifest.artifacts.sipLog);
  const rtcAsrEvidencePath = liveManifest.artifacts.rtcAsrEvidence ? path.resolve(repoRoot, liveManifest.artifacts.rtcAsrEvidence) : null;
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
        ...(rtcAsrEvidencePath ? [await artifact(rtcAsrEvidencePath, "rtc-asr-transcript-evidence", "transcript_evidence", "application/json")] : []),
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
    ...(rtcAsrEvidencePath ? [await integrity(rtcAsrEvidencePath, "rtc-asr-transcript-evidence", "transcript_evidence")] : []),
  ];
  const sipEvidence = await sipLogEvidence(sipLogPath);
  const rtcAsrEvidenceResult = await rtcAsrEvidence(rtcAsrEvidencePath);
  const wavEvidenceResult = await wavEvidence(audioPath);
  const sourceArtifactIntegrityResult = await sourceArtifactIntegrityEvidence(liveManifest);
  const gate = reviewGate(liveManifest, artifactIntegrity, sipEvidence, rtcAsrEvidenceResult, wavEvidenceResult, sourceArtifactIntegrityResult);
  const validationSummary = {
    status: gate.passed ? "ready_for_review" : "blocked_before_review",
    checks: gate.checks,
    blockers: liveManifest.blockers,
    nextActions: reviewNextActions(liveManifest),
    callerAudioEvidence: wavEvidenceResult,
    sipLogEvidence: sipEvidence,
    rtcAsrEvidence: rtcAsrEvidenceResult,
    sourceArtifactIntegrityEvidence: sourceArtifactIntegrityResult,
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
      rtcAsrEvidence: rtcAsrEvidencePath ? rel(rtcAsrEvidencePath) : null,
    },
    artifactIntegrity,
    reviewGate: gate,
    sourceManifestReviewGate: liveManifest.reviewGate ?? null,
    validationSummary,
    blockers: liveManifest.blockers,
  };
  const bundleManifestPath = path.join(outDir, "proof-bundle-manifest.json");
  await writeFile(bundleManifestPath, `${JSON.stringify(bundleManifest, null, 2)}\n`, "utf8");
  const reviewGateReportPath = path.join(outDir, "review-gate-report.md");
  await writeFile(reviewGateReportPath, reviewGateReport(bundleManifest), "utf8");
  const reviewGateReportJsonPath = path.join(outDir, "review-gate-report.json");
  await writeFile(reviewGateReportJsonPath, JSON.stringify(reviewGateReportJson(bundleManifest), null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    manifest: rel(bundleManifestPath),
    reviewGateReport: rel(reviewGateReportPath),
    reviewGateReportJson: rel(reviewGateReportJsonPath),
    reviewReady: bundleManifest.reviewReady,
    reviewGatePassed: bundleManifest.reviewGate.passed,
    validationStatus: bundleManifest.validationSummary.status,
    blockers: bundleManifest.blockers,
  }, null, 2));
  if (!bundleManifest.reviewGate.passed && process.argv.includes("--require-review-ready")) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
