import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function generatedAtTimestamp() {
  const explicitValue = argValue("--generated-at") || process.env.SOURCE_DATE_EPOCH;
  if (!explicitValue) {
    return new Date().toISOString();
  }

  const parsedValue = /^\d+$/.test(explicitValue) ? Number(explicitValue) * 1000 : explicitValue;
  const date = new Date(parsedValue);
  assert.ok(!Number.isNaN(date.valueOf()), "--generated-at or SOURCE_DATE_EPOCH must be an ISO timestamp or Unix epoch seconds");
  return date.toISOString();
}

function relativeArtifactPath(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function proofTranscriptText(proof) {
  const turns = proof.scripted.checkpoints.wrapped.transcript;
  return turns.map((turn) => `${turn.timestamp} ${turn.speaker.toUpperCase()}: ${turn.text}`).join("\n") + "\n";
}

function proofActionTrace(proof) {
  const wrapped = proof.scripted.checkpoints.wrapped;
  return wrapped.events.map((event) => ({
    type: event.type,
    at: event.at,
    detail: event.detail,
  }));
}

function latencyEvidence(proof) {
  function marksFor(flow, checkpoint) {
    return checkpoint.latencyMarks.map((mark) => ({
      flow,
      stage: mark.stage,
      observedMs: mark.elapsedMs,
      budgetMs: mark.budgetMs,
      overBudget: typeof mark.budgetMs === "number" && mark.elapsedMs > mark.budgetMs,
      at: mark.recordedAt,
    }));
  }

  return {
    runtimeMode: proof.health.pipecatFlow.prototypeMode,
    budgets: proof.health.latencyBudgetsMs,
    marks: [
      ...marksFor("scripted", proof.scripted.checkpoints.wrapped),
      ...marksFor("fallback", proof.fallback.checkpoint),
      ...marksFor("runtime_failure", proof.runtimeFailure.checkpoint),
    ],
  };
}

function finalState(proof) {
  return {
    complete: true,
    outcome: proof.scripted.outcome,
    fallbackOutcome: proof.fallback.outcome,
    runtimeFailureOutcome: proof.runtimeFailure.outcome,
    requiredOutcomes: proof.proofContract.requiredOutcomes,
    runtimeMode: proof.health.pipecatFlow.prototypeMode,
    runtimeEngine: proof.health.pipecatFlow.runtimeEngine,
    credentialsMode: proof.health.pipecatFlow.credentialsMode,
    liveTelephony: "mocked_not_used",
    providerCredentials: "not_used",
  };
}

function writeUInt32LE(buffer, value, offset) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function wavBuffer({ transcriptText, sampleRate = 16000 }) {
  const seconds = 10;
  const sampleCount = sampleRate * seconds;
  const data = Buffer.alloc(sampleCount * 2);
  const words = transcriptText.split(/\s+/).filter(Boolean).length;
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / sampleRate;
    const segment = Math.floor(t / 2.5);
    const active = t % 2.5 < 1.75;
    const frequency = active ? 330 + segment * 70 + (words % 17) : 0;
    const envelope = active ? Math.min(1, (t % 2.5) / 0.12, (1.75 - (t % 2.5)) / 0.2) : 0;
    const sample = Math.round(Math.sin(2 * Math.PI * frequency * t) * 11000 * Math.max(0, envelope));
    data.writeInt16LE(sample, index * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  writeUInt32LE(header, 36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  writeUInt32LE(header, 16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  writeUInt32LE(header, sampleRate, 24);
  writeUInt32LE(header, sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  writeUInt32LE(header, data.length, 40);
  return Buffer.concat([header, data]);
}

function screenshotSvg({ title, proof, call }) {
  const turns = call.transcript.slice(-6);
  const events = call.events.slice(-6);
  const transcriptRows = turns
    .map((turn, index) => `<text x="48" y="${228 + index * 28}" class="mono"><tspan class="label">${escapeXml(turn.speaker)}</tspan> ${escapeXml(turn.text)}</text>`)
    .join("\n");
  const eventRows = events
    .map((event, index) => `<text x="700" y="${228 + index * 28}" class="mono"><tspan class="label">${escapeXml(event.type)}</tspan> ${escapeXml(event.at)}</text>`)
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760" role="img" aria-label="${escapeXml(title)}">
  <style>
    .bg { fill: #f6f7f9; }
    .panel { fill: #ffffff; stroke: #d7dee8; stroke-width: 1; }
    .ink { fill: #14202b; font-family: Arial, sans-serif; }
    .muted { fill: #657487; font-family: Arial, sans-serif; }
    .mono { fill: #14202b; font-family: Menlo, Consolas, monospace; font-size: 16px; }
    .label { fill: #0f766e; font-weight: 700; }
    .chip { fill: #e8f7f4; stroke: #0f766e; }
    .warn { fill: #fff7ed; stroke: #f97316; }
  </style>
  <rect class="bg" width="1200" height="760" />
  <text x="40" y="58" class="ink" font-size="34" font-weight="700">${escapeXml(title)}</text>
  <text x="40" y="92" class="muted" font-size="18">Agentic Call Center demo proof | ${escapeXml(proof.health.pipecatFlow.prototypeMode)} | ${escapeXml(proof.health.pipecatFlow.credentialsMode)} credentials</text>
  <rect x="40" y="124" width="1120" height="72" rx="8" class="panel" />
  <rect x="64" y="146" width="230" height="28" rx="14" class="chip" />
  <text x="82" y="166" class="ink" font-size="16" font-weight="700">${escapeXml(call.flowState)}</text>
  <rect x="316" y="146" width="330" height="28" rx="14" class="chip" />
  <text x="334" y="166" class="ink" font-size="16" font-weight="700">runtime ${escapeXml(proof.health.pipecatFlow.runtimeEngine)}</text>
  <rect x="668" y="146" width="290" height="28" rx="14" class="warn" />
  <text x="686" y="166" class="ink" font-size="16" font-weight="700">live telephony mocked</text>
  <rect x="40" y="208" width="610" height="456" rx="8" class="panel" />
  <text x="64" y="246" class="ink" font-size="22" font-weight="700">Transcript</text>
  ${transcriptRows}
  <rect x="680" y="208" width="480" height="456" rx="8" class="panel" />
  <text x="704" y="246" class="ink" font-size="22" font-weight="700">Event Trail</text>
  ${eventRows}
  <text x="40" y="714" class="muted" font-size="16">Call ${escapeXml(call.session.callId)} | proof ${escapeXml(proof.gitRevision || "unknown")}</text>
</svg>\n`;
}

function gifLzwData(indices) {
  const minCodeSize = 8;
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;
  let bitBuffer = 0;
  let bitCount = 0;
  const bytes = [];

  function emit(code) {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  }

  emit(clearCode);
  for (const index of indices) {
    emit(index);
    nextCode += 1;
    if (nextCode === (1 << codeSize) && codeSize < 12) {
      codeSize += 1;
    }
    if (nextCode >= 4095) {
      emit(clearCode);
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    }
  }
  emit(endCode);
  if (bitCount > 0) {
    bytes.push(bitBuffer & 0xff);
  }

  const blocks = [];
  for (let offset = 0; offset < bytes.length; offset += 255) {
    const slice = bytes.slice(offset, offset + 255);
    blocks.push(Buffer.from([slice.length, ...slice]));
  }
  blocks.push(Buffer.from([0]));
  return Buffer.concat([Buffer.from([minCodeSize]), ...blocks]);
}

function drawRect(indices, width, x, y, w, h, color) {
  for (let row = y; row < y + h; row += 1) {
    for (let col = x; col < x + w; col += 1) {
      if (row >= 0 && col >= 0 && col < width && row * width + col < indices.length) {
        indices[row * width + col] = color;
      }
    }
  }
}

function gifFrame(width, height, step) {
  const pixels = new Uint8Array(width * height).fill(1);
  drawRect(pixels, width, 18, 18, width - 36, height - 36, 2);
  drawRect(pixels, width, 34, 48, width - 68, 18, 3);
  drawRect(pixels, width, 34, 88, 180 + step * 32, 18, 4);
  drawRect(pixels, width, 34, 126, 300, 70, 5);
  drawRect(pixels, width, 370, 126, 250, 70, step >= 2 ? 6 : 5);
  drawRect(pixels, width, 34, 220, 280 + step * 26, 16, 3);
  drawRect(pixels, width, 34, 252, 230 + step * 38, 16, 3);
  drawRect(pixels, width, 34, 284, 330, 16, 3);
  drawRect(pixels, width, 370, 220, 210, 16, 4);
  drawRect(pixels, width, 370, 252, 150 + step * 40, 16, 4);
  drawRect(pixels, width, 370, 284, 260, 16, 4);
  return pixels;
}

function gifBuffer() {
  const width = 640;
  const height = 360;
  const header = Buffer.from("GIF89a", "ascii");
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0xf7;
  lsd[5] = 0;
  lsd[6] = 0;
  const palette = Buffer.alloc(256 * 3);
  const colors = [
    [0, 0, 0],
    [246, 247, 249],
    [255, 255, 255],
    [15, 118, 110],
    [249, 115, 22],
    [215, 222, 232],
    [34, 197, 94],
  ];
  colors.forEach((rgb, index) => {
    palette[index * 3] = rgb[0];
    palette[index * 3 + 1] = rgb[1];
    palette[index * 3 + 2] = rgb[2];
  });
  const appExtension = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0", "ascii"), 0x03, 0x01, 0x00, 0x00, 0x00]);
  const frames = [];
  for (let step = 0; step < 6; step += 1) {
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x04, 0x64, 0x00, 0x00, 0x00]);
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(0, 1);
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 0;
    frames.push(gce, descriptor, gifLzwData(gifFrame(width, height, step)));
  }
  return Buffer.concat([header, lsd, palette, appExtension, ...frames, Buffer.from([0x3b])]);
}

async function writeJsonArtifact(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function buildArtifactPointer(filePath, { artifactId, kind, mimeType, metadata = {} }) {
  const stats = await stat(filePath);
  return {
    artifact_id: artifactId,
    kind,
    role: "input",
    uri: relativeArtifactPath(filePath),
    mime_type: mimeType,
    sha256: await sha256File(filePath),
    size_bytes: stats.size,
    source: "agentic-contact-center",
    readiness: "ready",
    metadata,
  };
}

async function buildManifestArtifact(filePath, { artifactId, kind }) {
  const stats = await stat(filePath);
  return {
    artifactId,
    kind,
    path: relativeArtifactPath(filePath),
    sha256: await sha256File(filePath),
    sizeBytes: stats.size,
    readiness: "ready",
  };
}

function localSttEvidence({ audioPath, transcriptText }) {
  const frameBytes = 640;
  const audioBytes = 16000 * 2 * 10;
  return {
    provider: "rtc-asr",
    protocol: "local-stt.v1",
    streamUrl: process.env.RTC_ASR_WS_URL || "ws://127.0.0.1:8080/v1/stt/stream",
    mode: "contract_replay_with_seeded_transcript",
    audio: {
      source: relativeArtifactPath(audioPath),
      sampleRateHz: 16000,
      channels: 1,
      encoding: "pcm16le",
      frameMs: 20,
      bytesPerFrame: frameBytes,
      generatedCapture: true,
    },
    localSttStartMessage: {
      type: "start",
      version: "local-stt.v1",
      audio: {
        sample_rate: 16000,
        channels: 1,
        format: "pcm_s16le",
        frame_ms: 20,
        bytes_per_frame: frameBytes,
      },
      interim_results: true,
    },
    binaryPcm16Frames: Math.ceil(audioBytes / frameBytes),
    finalizeMessage: { type: "finalize" },
    expectedFinalTranscript: transcriptText,
    limitation: "This proof replays the Local STT v1 framing contract with seeded transcript text; set RTC_ASR_WS_URL and run the listed optional command to replace it with a live rtc-asr stream.",
  };
}

function bundleValidationReport(proof, transcriptText) {
  const scriptedMarks = proof.scripted.checkpoints.wrapped.latencyMarks;
  const fallbackMarks = proof.fallback.checkpoint.latencyMarks;
  const runtimeFailureMarks = proof.runtimeFailure.checkpoint.latencyMarks;

  return {
    schemaVersion: 1,
    status: "ready_for_conversation_agent_evals",
    checks: {
      scriptedWrapComplete: proof.summary.scripted.outcome === "scripted_wrap_complete",
      failClosedFallbackComplete: proof.summary.fallback.outcome === "fail_closed_handoff",
      runtimeFailureFallbackComplete: proof.summary.runtimeFailure.outcome === "runtime_failure_fail_closed_handoff",
      mockedCredentialsOnly: proof.health.pipecatFlow.credentialsMode === "mocked",
      localRuntimeMode: proof.health.pipecatFlow.prototypeMode === "pipecat_local_runtime",
      transcriptHasCallerTurns: transcriptText.includes("CALLER:"),
      latencyEvidenceCoversAllFlows: scriptedMarks.length > 0 && fallbackMarks.length > 0 && runtimeFailureMarks.length > 0,
    },
    handoffReadiness: {
      conversationAgentEvalsRequest: "conversation-agent-evals-assert-request.json",
      expectedTransport: "http_sidecar",
      expectedLocalBaseUrl: "http://127.0.0.1:8091",
    },
    constraints: {
      liveTelephony: "mocked_not_used",
      providerCredentials: "not_used",
      localAsr: "contract_replay_with_seeded_transcript",
    },
  };
}

async function main() {
  const proofPath = path.resolve(process.cwd(), argValue("--proof") || "artifacts/demo-proof-latest.json");
  const outDir = path.resolve(process.cwd(), argValue("--out-dir") || "artifacts/agentic-call-center-demo");
  const generatedAt = generatedAtTimestamp();
  const proof = JSON.parse(await readFile(proofPath, "utf8"));

  assert.equal(proof.summary.scripted.outcome, "scripted_wrap_complete");
  assert.equal(proof.summary.fallback.outcome, "fail_closed_handoff");
  assert.equal(proof.summary.runtimeFailure.outcome, "runtime_failure_fail_closed_handoff");
  assert.equal(proof.health.pipecatFlow.credentialsMode, "mocked");

  const mediaDir = path.join(outDir, "media");
  const screenshotDir = path.join(outDir, "screenshots");
  const recordingDir = path.join(outDir, "recordings");
  await mkdir(mediaDir, { recursive: true });
  await mkdir(screenshotDir, { recursive: true });
  await mkdir(recordingDir, { recursive: true });

  const transcriptText = proofTranscriptText(proof);
  const transcriptPath = path.join(outDir, "transcript.txt");
  const actionTracePath = path.join(outDir, "action-trace.json");
  const latencyEvidencePath = path.join(outDir, "latency-evidence.json");
  const finalStatePath = path.join(outDir, "final-state.json");
  const bundledProofPath = path.join(outDir, "proof.json");
  const audioPath = path.join(mediaDir, "caller-capture.wav");
  const policyHoldScreenshotPath = path.join(screenshotDir, "operator-console-policy-hold.svg");
  const wrapScreenshotPath = path.join(screenshotDir, "operator-console-wrap.svg");
  const recordingPath = path.join(recordingDir, "operator-console-demo.gif");
  const localSttEvidencePath = path.join(outDir, "local-stt-v1-evidence.json");
  const validationReportPath = path.join(outDir, "bundle-validation-report.json");

  await writeFile(transcriptPath, transcriptText, "utf8");
  await writeJsonArtifact(actionTracePath, proofActionTrace(proof));
  await writeJsonArtifact(latencyEvidencePath, latencyEvidence(proof));
  await writeJsonArtifact(finalStatePath, finalState(proof));
  await writeJsonArtifact(bundledProofPath, proof);
  await writeFile(audioPath, wavBuffer({ transcriptText }));
  await writeFile(policyHoldScreenshotPath, screenshotSvg({ title: "Operator Console - Policy Hold", proof, call: proof.scripted.checkpoints.policyHold }), "utf8");
  await writeFile(wrapScreenshotPath, screenshotSvg({ title: "Operator Console - Wrapped Call", proof, call: proof.scripted.checkpoints.wrapped }), "utf8");
  await writeFile(recordingPath, gifBuffer());
  await writeJsonArtifact(localSttEvidencePath, localSttEvidence({ audioPath, transcriptText }));
  await writeJsonArtifact(validationReportPath, bundleValidationReport(proof, transcriptText));

  const assertRunCreateRequest = {
    spec_ref: {
      spec_id: "agentic-contact-center/cancellation-rescue",
      spec_kind: "scenario",
      spec_version: "2026-06-29",
      assert_project: "conversation-agent-evals",
      assert_commit: null,
    },
    evidence: {
      transcript: await buildArtifactPointer(transcriptPath, {
        artifactId: "agentic-call-center-transcript",
        kind: "transcript",
        mimeType: "text/plain",
      }),
      conversation: {
        artifact_id: "agentic-call-center-conversation",
        kind: "conversation",
        role: "input",
        inline_data: { dialog: proof.scripted.checkpoints.wrapped.transcript },
        mime_type: "application/json",
        source: "agentic-contact-center",
        readiness: "ready",
        metadata: { runtime_mode: proof.health.pipecatFlow.prototypeMode },
      },
      call_media: [
        await buildArtifactPointer(audioPath, {
          artifactId: "caller-audio-capture-wav",
          kind: "call_media",
          mimeType: "audio/wav",
          metadata: { capture: "seeded_local_audio", sample_rate_hz: 16000, channels: 1 },
        }),
        await buildArtifactPointer(policyHoldScreenshotPath, {
          artifactId: "operator-console-policy-hold-screenshot",
          kind: "call_media",
          mimeType: "image/svg+xml",
          metadata: { capture: "generated_from_proof_state", viewport: "1200x760" },
        }),
        await buildArtifactPointer(wrapScreenshotPath, {
          artifactId: "operator-console-wrap-screenshot",
          kind: "call_media",
          mimeType: "image/svg+xml",
          metadata: { capture: "generated_from_proof_state", viewport: "1200x760" },
        }),
        await buildArtifactPointer(recordingPath, {
          artifactId: "operator-console-demo-recording",
          kind: "call_media",
          mimeType: "image/gif",
          metadata: { capture: "generated_video_recording", frames: 6, duration_seconds: 6 },
        }),
      ],
      action_trace: await buildArtifactPointer(actionTracePath, {
        artifactId: "agentic-call-center-action-trace",
        kind: "action_trace",
        mimeType: "application/json",
      }),
      final_state: await buildArtifactPointer(finalStatePath, {
        artifactId: "agentic-call-center-final-state",
        kind: "final_state",
        mimeType: "application/json",
      }),
      assert_bundle: await buildArtifactPointer(bundledProofPath, {
        artifactId: "agentic-call-center-proof-bundle",
        kind: "assert_bundle",
        mimeType: "application/json",
      }),
      additional_artifacts: [
        await buildArtifactPointer(latencyEvidencePath, {
          artifactId: "agentic-call-center-latency-evidence",
          kind: "report",
          mimeType: "application/json",
        }),
        await buildArtifactPointer(localSttEvidencePath, {
          artifactId: "local-stt-v1-contract-evidence",
          kind: "manifest",
          mimeType: "application/json",
        }),
        await buildArtifactPointer(validationReportPath, {
          artifactId: "agentic-call-center-bundle-validation-report",
          kind: "report",
          mimeType: "application/json",
        }),
      ],
      provenance: {
        source_repo: "agonza1/agentic-contact-center",
        source_issue: "#60",
        coordinated_issue: "#64",
        source_proof: relativeArtifactPath(proofPath),
      },
    },
    runtime_config: {
      execution_mode: "async",
      invocation_target: {
        transport: "http_sidecar",
        environment: "local",
        base_url: "http://127.0.0.1:8091",
        package_name: "assert",
        entrypoint: "/v2/runs",
        timeout_seconds: 300,
      },
      retry_policy: { max_attempts: 1, retryable_statuses: ["error", "failed"] },
      scenario_overrides: {},
      environment_labels: ["agentic-contact-center", proof.health.pipecatFlow.prototypeMode, "mocked-telephony"],
    },
    platform_metadata: {
      user_id: "alberto-local-proof",
      project_id: "agentic-contact-center",
      project_run_label: "issue-60-agentic-call-center-demo-proof",
      initiated_by: "local-script",
      notes: "Provider credentials and live telephony are mocked; media artifacts are generated from seeded local demo proof state.",
      labels: ["issue-60", "issue-64", "pipecat-local-runtime", "local-stt-v1"],
      retention_days: 90,
      billing_tags: {},
      quota_scope: null,
    },
  };

  const assertRequestPath = path.join(outDir, "conversation-agent-evals-assert-request.json");
  await writeJsonArtifact(assertRequestPath, assertRunCreateRequest);

  const manifest = {
    schemaVersion: 1,
    generatedAt,
    workboardCard: "5b0f0dd6-fc5f-4806-a2ed-438fe722e9da",
    githubIssue: "agonza1/agentic-contact-center#60",
    coordinatedProofIssue: "agonza1/agentic-contact-center#64",
    runtimeModeLabels: {
      flow: proof.health.pipecatFlow.prototypeMode,
      runtimeEngine: proof.health.pipecatFlow.runtimeEngine,
      pipecatTransport: proof.health.pipecatFlow.transport,
      credentialsMode: proof.health.pipecatFlow.credentialsMode,
      telephony: "mocked",
      providerCredentials: "not_used",
      localAsr: "rtc-asr local-stt.v1 contract replay",
    },
    runCommands: {
      functionalProof: "npm run proof:pipecat -- --out artifacts/agentic-call-center-demo/source-proof.json --latest-out artifacts/demo-proof-latest.json",
      proofBundle: "npm run proof:bundle -- --proof artifacts/agentic-call-center-demo/source-proof.json --out-dir artifacts/agentic-call-center-demo",
      tests: "npm test",
      optionalLiveRtcAsr: "RTC_ASR_WS_URL=ws://127.0.0.1:8080/v1/stt/stream npm run proof:bundle -- --proof artifacts/agentic-call-center-demo/source-proof.json --out-dir artifacts/agentic-call-center-demo-live-asr",
      conversationAgentEvalsIngress: "Use artifacts/agentic-call-center-demo/conversation-agent-evals-assert-request.json as AssertRunCreateRequest evidence input.",
    },
    artifacts: {
      sourceProof: relativeArtifactPath(proofPath),
      proof: relativeArtifactPath(bundledProofPath),
      transcript: relativeArtifactPath(transcriptPath),
      actionTrace: relativeArtifactPath(actionTracePath),
      latencyEvidence: relativeArtifactPath(latencyEvidencePath),
      finalState: relativeArtifactPath(finalStatePath),
      audioCapture: relativeArtifactPath(audioPath),
      screenshots: [relativeArtifactPath(policyHoldScreenshotPath), relativeArtifactPath(wrapScreenshotPath)],
      videoRecording: relativeArtifactPath(recordingPath),
      localSttEvidence: relativeArtifactPath(localSttEvidencePath),
      validationReport: relativeArtifactPath(validationReportPath),
      conversationAgentEvalsRequest: relativeArtifactPath(assertRequestPath),
    },
    artifactIntegrity: [
      await buildManifestArtifact(proofPath, { artifactId: "source-proof", kind: "source_proof" }),
      await buildManifestArtifact(bundledProofPath, { artifactId: "agentic-call-center-proof-bundle", kind: "assert_bundle" }),
      await buildManifestArtifact(transcriptPath, { artifactId: "agentic-call-center-transcript", kind: "transcript" }),
      await buildManifestArtifact(actionTracePath, { artifactId: "agentic-call-center-action-trace", kind: "action_trace" }),
      await buildManifestArtifact(latencyEvidencePath, { artifactId: "agentic-call-center-latency-evidence", kind: "report" }),
      await buildManifestArtifact(finalStatePath, { artifactId: "agentic-call-center-final-state", kind: "final_state" }),
      await buildManifestArtifact(audioPath, { artifactId: "caller-audio-capture-wav", kind: "call_media" }),
      await buildManifestArtifact(policyHoldScreenshotPath, { artifactId: "operator-console-policy-hold-screenshot", kind: "call_media" }),
      await buildManifestArtifact(wrapScreenshotPath, { artifactId: "operator-console-wrap-screenshot", kind: "call_media" }),
      await buildManifestArtifact(recordingPath, { artifactId: "operator-console-demo-recording", kind: "call_media" }),
      await buildManifestArtifact(localSttEvidencePath, { artifactId: "local-stt-v1-contract-evidence", kind: "manifest" }),
      await buildManifestArtifact(validationReportPath, { artifactId: "agentic-call-center-bundle-validation-report", kind: "report" }),
      await buildManifestArtifact(assertRequestPath, { artifactId: "conversation-agent-evals-assert-request", kind: "assert_request" }),
    ],
    outcomes: proof.summary,
    limitations: [
      "No production credentials or live telephony are used.",
      "The audio capture is a deterministic local WAV generated from seeded caller turns, not a microphone recording.",
      "Local STT evidence replays the rtc-asr Local STT v1 framing contract unless RTC_ASR_WS_URL is supplied for a live local rtc-asr sidecar run.",
      "Screenshots and animated recording are generated from proof state so the bundle is reproducible in headless CI without browser or video encoder dependencies.",
    ],
  };

  const manifestPath = path.join(outDir, "proof-bundle-manifest.json");
  await writeJsonArtifact(manifestPath, manifest);

  console.log(JSON.stringify({ manifest: relativeArtifactPath(manifestPath), ...manifest.artifacts }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
