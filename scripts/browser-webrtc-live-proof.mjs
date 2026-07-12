#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";

const args = process.argv.slice(2);

function getArg(name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const outDir = getArg("--out-dir", "artifacts/browser-webrtc-live-proof");
const evidencePath = getArg("--evidence");
const templatePath = getArg("--write-template");
const requireReviewReady = args.includes("--require-review-ready");
const probeSidecars = args.includes("--probe-sidecars");

const setupCommands = [
  "export RTC_ASR_BASE_URL=${RTC_ASR_BASE_URL:-http://127.0.0.1:8080}",
  "export RTC_ASR_WS_URL=${RTC_ASR_WS_URL:-ws://127.0.0.1:8080/v1/stt/stream}",
  "export KOKORO_BASE_URL=${KOKORO_BASE_URL:-http://127.0.0.1:8880}",
  "export BROWSER_WEBRTC_BRIDGE_URL=${BROWSER_WEBRTC_BRIDGE_URL:-http://127.0.0.1:8766}",
  "npm start",
  "npm run pipecat:webrtc:check",
  "npm run browser-webrtc:check -- --url http://127.0.0.1:${PORT:-8026}/health",
  "npm run browser-webrtc:live-proof -- --evidence artifacts/browser-webrtc-live-proof/proof.json --require-review-ready",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readEvidence(filePath) {
  if (!filePath) {
    return { payload: null, readiness: "blocked", reason: "browser WebRTC live evidence file is not attached." };
  }

  try {
    const text = await readFile(filePath, "utf8");
    try {
      return { payload: JSON.parse(text), readiness: "ready", reason: "evidence file parsed." };
    } catch {
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const parsed = lines.map((line) => JSON.parse(line));
      return { payload: parsed, readiness: "ready", reason: "evidence file parsed." };
    }
  } catch (error) {
    return {
      payload: null,
      readiness: "blocked",
      reason: `browser WebRTC live evidence file is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function flattenRecords(payload) {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  const records = [payload];
  for (const key of ["events", "proof", "evidence", "timeline"]) {
    const nested = payload[key];
    if (Array.isArray(nested)) records.push(...nested.filter(isRecord));
    if (isRecord(nested)) records.push(nested);
  }
  return records;
}

function textIncludes(record, pattern) {
  const normalize = (value) => value.toLowerCase().replace(/[\s_]+/g, "-");
  return normalize(JSON.stringify(record)).includes(normalize(pattern));
}

function hasPlaceholderText(value) {
  return typeof value === "string" && /replace with|replace-with|placeholder/i.test(value);
}

function hasPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function transcriptText(record) {
  if (typeof record.transcript === "string") return record.transcript;
  if (typeof record.text === "string") return record.text;
  if (typeof record.finalTranscript === "string") return record.finalTranscript;
  const result = nestedRecord(record, "result");
  if (typeof result.transcript === "string") return result.transcript;
  if (typeof result.text === "string") return result.text;
  const alternatives = [
    ...nestedRecords(record, "alternatives"),
    ...nestedRecords(result, "alternatives"),
    ...nestedRecords(nestedRecord(record, "channel"), "alternatives"),
  ];
  const alternative = alternatives.find((entry) => typeof entry.transcript === "string" || typeof entry.text === "string");
  if (!alternative) return "";
  return typeof alternative.transcript === "string" ? alternative.transcript : alternative.text;
}

function currentGitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function evidenceHeadSha(record) {
  for (const key of ["gitHead", "headSha", "repoHead", "commit", "commitSha"]) {
    const value = record[key];
    if (typeof value === "string" && /^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase();
  }
  return null;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0) ?? "";
}

function pipecatSessionId(record) {
  return firstString(
    record.sessionId,
    record.session_id,
    nestedRecord(record, "answer").sessionId,
    nestedRecord(record, "answer").session_id,
    nestedRecord(record, "response").sessionId,
    nestedRecord(record, "response").session_id,
    nestedRecord(record, "bridgeResponse").sessionId,
    nestedRecord(record, "bridgeResponse").session_id,
    nestedRecord(record, "session").id,
    nestedRecord(record, "session").sessionId,
    nestedRecord(record, "session").session_id,
  );
}

function proofId(value) {
  return typeof value === "string" && value.trim().length > 0 && !hasPlaceholderText(value) ? value.trim() : "";
}

function hasWebrtcAnswerSdp(record) {
  const candidates = [
    record,
    nestedRecord(record, "answer"),
    nestedRecord(record, "response"),
    nestedRecord(record, "bridgeResponse"),
  ];
  return candidates.some((candidate) => {
    const type = typeof candidate.type === "string" ? candidate.type.toLowerCase() : "";
    const sdp = firstString(candidate.sdp, candidate.answerSdp, candidate.localDescriptionSdp);
    return type === "answer" && sdp.trim().startsWith("v=0") && !hasPlaceholderText(sdp);
  });
}

function uniqueProofIds(values) {
  return [...new Set(values.map(proofId).filter(Boolean))];
}

function hasConsistentProofCorrelation(payload, records) {
  const envelope = isRecord(payload) ? payload : {};
  const topCallIds = uniqueProofIds([envelope.callId, envelope.call_id]);
  const topSessionIds = uniqueProofIds([envelope.sessionId, envelope.session_id]);
  const recordCallIds = uniqueProofIds(records.flatMap((record) => [record.callId, record.call_id]));
  const recordSessionIds = uniqueProofIds(records.flatMap((record) => [record.sessionId, record.session_id, pipecatSessionId(record)]));

  const callIds = uniqueProofIds([...topCallIds, ...recordCallIds]);
  const sessionIds = uniqueProofIds([...topSessionIds, ...recordSessionIds]);

  return callIds.length <= 1 && sessionIds.length <= 1;
}

function nestedRecord(record, key) {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function nestedRecords(record, key) {
  const value = record[key];
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) return Object.values(value).filter(isRecord);
  return [];
}

function nestedCandidateRecords(record, keys) {
  return keys.map((key) => nestedRecord(record, key)).filter((value) => Object.keys(value).length > 0);
}

function rtcStatsFrom(...records) {
  return records.flatMap((record) => [
    ...nestedRecords(record, "rtcStats"),
    ...nestedRecords(record, "peerConnectionStats"),
    ...nestedRecords(record, "getStats"),
  ]);
}

function hasInboundAudioRtpStats(stats) {
  return stats.some((stat) => {
    const type = typeof stat.type === "string" ? stat.type.toLowerCase() : "";
    const kind = typeof stat.kind === "string" ? stat.kind.toLowerCase() : "";
    const mediaType = typeof stat.mediaType === "string" ? stat.mediaType.toLowerCase() : "";
    const trackKind = typeof stat.trackKind === "string" ? stat.trackKind.toLowerCase() : "";
    return (
      type === "inbound-rtp" &&
      [kind, mediaType, trackKind].includes("audio") &&
      (hasPositiveNumber(stat.packetsReceived) || hasPositiveNumber(stat.bytesReceived))
    );
  });
}

function hasOutboundAudioRtpStats(stats) {
  return stats.some((stat) => {
    const type = typeof stat.type === "string" ? stat.type.toLowerCase() : "";
    const kind = typeof stat.kind === "string" ? stat.kind.toLowerCase() : "";
    const mediaType = typeof stat.mediaType === "string" ? stat.mediaType.toLowerCase() : "";
    const trackKind = typeof stat.trackKind === "string" ? stat.trackKind.toLowerCase() : "";
    return (
      type === "outbound-rtp" &&
      [kind, mediaType, trackKind].includes("audio") &&
      (hasPositiveNumber(stat.packetsSent) || hasPositiveNumber(stat.bytesSent))
    );
  });
}

function hasAudioEnergyStats(stats) {
  return stats.some((stat) => {
    const type = typeof stat.type === "string" ? stat.type.toLowerCase() : "";
    const kind = typeof stat.kind === "string" ? stat.kind.toLowerCase() : "";
    const mediaType = typeof stat.mediaType === "string" ? stat.mediaType.toLowerCase() : "";
    const trackKind = typeof stat.trackKind === "string" ? stat.trackKind.toLowerCase() : "";
    return (
      [kind, mediaType, trackKind].includes("audio") &&
      (type === "media-source" || type === "track" || type === "receiver" || type === "sender") &&
      (hasPositiveNumber(stat.audioLevel) || hasPositiveNumber(stat.totalAudioEnergy) || hasPositiveNumber(stat.totalSamplesReceived) || hasPositiveNumber(stat.totalSamplesDuration))
    );
  });
}

function hasPlayableAudioElement(audioElement) {
  const readyState = audioElement.readyState;
  return (
    hasPositiveNumber(audioElement.currentTime) ||
    audioElement.paused === false ||
    readyState === "have_enough_data" ||
    readyState === "can_play" ||
    readyState === "can_play_through" ||
    (typeof readyState === "number" && readyState >= 3)
  );
}

function hasBrowserMicrophoneUplink(record) {
  const microphoneRecords = [
    record,
    ...nestedCandidateRecords(record, ["browserMicrophoneUplink", "microphone", "localMicrophone", "localAudio"]),
  ];
  const hasMicrophoneContext = (
    textIncludes(record, "browser") &&
    (textIncludes(record, "microphone") || textIncludes(record, "mic") || textIncludes(record, "local audio"))
  ) || microphoneRecords.length > 1;

  return (
    hasMicrophoneContext &&
    microphoneRecords.some((candidate) => {
      const outboundRtpAudio = nestedRecord(candidate, "outboundRtpAudio");
      const audioTrack = nestedRecord(candidate, "audioTrack");
      const rtcStats = rtcStatsFrom(record, candidate);
      return (
        hasPositiveNumber(candidate.sentMs) ||
        hasPositiveNumber(outboundRtpAudio.packetsSent) ||
        hasPositiveNumber(outboundRtpAudio.bytesSent) ||
        hasOutboundAudioRtpStats(rtcStats) ||
        (audioTrack.enabled === true && hasAudioEnergyStats(rtcStats))
      );
    })
  );
}

function hasBrowserRemoteAudioStats(record) {
  const remoteAudioRecords = [
    record,
    ...nestedCandidateRecords(record, ["browserRemoteAudio", "browserPlayback", "remoteAudio", "remoteAudioPlayback"]),
  ];
  const hasRemoteAudioContext = (
    textIncludes(record, "browser") &&
    textIncludes(record, "remote") &&
    textIncludes(record, "audio")
  ) || remoteAudioRecords.length > 1;

  return (
    hasRemoteAudioContext &&
    remoteAudioRecords.some((candidate) => {
      const inboundRtpAudio = nestedRecord(candidate, "inboundRtpAudio");
      const audioElement = nestedRecord(candidate, "audioElement");
      const rtcStats = rtcStatsFrom(record, candidate);
      return (
        (hasPositiveNumber(inboundRtpAudio.packetsReceived) || hasPositiveNumber(inboundRtpAudio.bytesReceived) || hasInboundAudioRtpStats(rtcStats) || hasAudioEnergyStats(rtcStats)) &&
        hasPlayableAudioElement(audioElement)
      );
    })
  );
}

function validateEvidence(payload, expectedGitHead) {
  const records = flattenRecords(payload);
  const expectedHead = typeof expectedGitHead === "string" ? expectedGitHead.toLowerCase() : null;
  const pipecatWebrtcAnswerSdp = records.some((record) => {
    return textIncludes(record, "pipecat") && textIncludes(record, "webrtc") && hasWebrtcAnswerSdp(record);
  });
  const checks = {
    evidenceCorrelation: hasConsistentProofCorrelation(payload, records),
    repoHeadEvidence: expectedHead ? records.some((record) => evidenceHeadSha(record) === expectedHead) : true,
    browserMicrophoneUplink: records.some((record) => hasBrowserMicrophoneUplink(record)),
    pipecatWebrtcBridge: records.some((record) => {
      const sessionId = pipecatSessionId(record);
      return textIncludes(record, "pipecat") && textIncludes(record, "webrtc") && sessionId.trim().length > 0 && !hasPlaceholderText(sessionId);
    }),
    rtcAsrFinalTranscript: records.some((record) => {
      const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
      const transcript = transcriptText(record);
      return textIncludes(record, "rtc-asr") && (type.includes("final") || record.final === true || record.isFinal === true || record.is_final === true) && transcript.trim().length > 0 && !hasPlaceholderText(transcript);
    }),
    kokoroAudio: records.some((record) => {
      const audioUrl = typeof record.audioUrl === "string" ? record.audioUrl : typeof record.url === "string" ? record.url : "";
      const audioSha256 = typeof record.audioSha256 === "string" ? record.audioSha256 : typeof record.sha256 === "string" ? record.sha256 : "";
      return (
        textIncludes(record, "kokoro") &&
        (textIncludes(record, "audio") || textIncludes(record, "tts")) &&
        (hasPositiveNumber(record.audioBytes) || (audioUrl.trim().length > 0 && !hasPlaceholderText(audioUrl)) || hasSha256(audioSha256))
      );
    }),
    browserRemoteAudio: records.some((record) => {
      return textIncludes(record, "browser") && textIncludes(record, "remote") && textIncludes(record, "audio") && hasBrowserRemoteAudioStats(record);
    }),
  };

  return {
    checks,
    evidenceSummary: {
      pipecatWebrtcAnswerSdp,
    },
    reviewReady: Object.values(checks).every(Boolean),
    missingProof: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

async function artifactIntegrity(filePath) {
  if (!filePath) return [];
  try {
    const bytes = await readFile(filePath);
    const info = await stat(filePath);
    return [{
      artifactId: "browser-webrtc-live-evidence",
      path: filePath,
      readiness: "ready",
      sizeBytes: info.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }];
  } catch {
    return [{ artifactId: "browser-webrtc-live-evidence", path: filePath, readiness: "blocked", sizeBytes: 0, sha256: null }];
  }
}

function sidecarUrl(label, value) {
  try {
    const url = new URL(value);
    const port = Number(url.port || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80));
    return { label, url: value, host: url.hostname, port };
  } catch {
    return { label, url: value, host: null, port: null, invalid: true };
  }
}

function probeTcp({ label, url, host, port, invalid }, timeoutMs = 250) {
  return new Promise((resolve) => {
    if (invalid || !host || !port) {
      resolve({ label, url, reachable: false, reason: "invalid sidecar URL" });
      return;
    }

    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ label, url, host, port, reachable: true }));
    socket.once("timeout", () => finish({ label, url, host, port, reachable: false, reason: "connection timed out" }));
    socket.once("error", (error) => finish({ label, url, host, port, reachable: false, reason: error.code ?? error.message }));
  });
}

async function sidecarConnectivity() {
  if (!probeSidecars) return null;
  const targets = [
    sidecarUrl("pipecatWebrtcBridge", process.env.BROWSER_WEBRTC_BRIDGE_URL ?? "http://127.0.0.1:8766"),
    sidecarUrl("rtcAsrHttp", process.env.RTC_ASR_BASE_URL ?? "http://127.0.0.1:8080"),
    sidecarUrl("rtcAsrWebsocket", process.env.RTC_ASR_WS_URL ?? "ws://127.0.0.1:8080/v1/stt/stream"),
    sidecarUrl("kokoro", process.env.KOKORO_BASE_URL ?? "http://127.0.0.1:8880"),
  ];
  return Promise.all(targets.map((target) => probeTcp(target)));
}

async function writeEvidenceTemplate(filePath) {
  if (!filePath) return null;
  await mkdir(path.dirname(filePath), { recursive: true });
  const template = {
    capturedAt: new Date().toISOString(),
    gitHead: currentGitHead(),
    captureNotes: "Replace placeholder values with one real local browser media turn.",
    events: [
      {
        type: "browser.microphone.uplink",
        target: "browser",
        track: "local microphone audio",
        sentMs: 0,
        outboundRtpAudio: {
          packetsSent: 0,
          bytesSent: 0,
        },
        rtcStats: [
          {
            type: "outbound-rtp",
            kind: "audio",
            packetsSent: 0,
            bytesSent: 0,
          },
        ],
        audioTrack: {
          enabled: false,
          muted: true,
        },
      },
      {
        type: "pipecat.webrtc.offer_answer",
        transport: "webrtc",
        bridge: "pipecat",
        bridgeUrl: process.env.BROWSER_WEBRTC_BRIDGE_URL ?? "http://127.0.0.1:8766",
        sessionId: "replace-with-browser-webrtc-session-id",
        answer: {
          type: "answer",
          sdp: "replace with the WebRTC answer SDP copied from /api/browser-webrtc/session",
        },
        bridgeResponse: {
          session_id: "replace-with-browser-webrtc-session-id",
          type: "answer",
        },
      },
      {
        type: "rtc-asr.transcript.final",
        engine: "rtc-asr",
        final: true,
        transcript: "replace with the final caller transcript heard from the browser microphone",
        source: process.env.RTC_ASR_WS_URL ?? "ws://127.0.0.1:8080/v1/stt/stream",
      },
      {
        type: "kokoro.tts.audio",
        engine: "kokoro",
        audioBytes: 0,
        source: process.env.KOKORO_BASE_URL ?? "http://127.0.0.1:8880",
      },
      {
        type: "browser.remote.audio.played",
        target: "browser",
        track: "remote audio",
        playedMs: 0,
        inboundRtpAudio: {
          packetsReceived: 0,
          bytesReceived: 0,
        },
        rtcStats: [
          {
            type: "inbound-rtp",
            kind: "audio",
            packetsReceived: 0,
            bytesReceived: 0,
          },
        ],
        audioElement: {
          currentTime: 0,
          paused: true,
          readyState: 0,
        },
      },
    ],
  };
  await writeFile(filePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  return filePath;
}

await mkdir(outDir, { recursive: true });
const evidenceTemplatePath = await writeEvidenceTemplate(templatePath);

const expectedGitHead = currentGitHead();
const evidence = await readEvidence(evidencePath);
const validation = evidence.payload ? validateEvidence(evidence.payload, expectedGitHead) : {
  checks: {
    evidenceCorrelation: true,
    repoHeadEvidence: expectedGitHead ? false : true,
    browserMicrophoneUplink: false,
    pipecatWebrtcBridge: false,
    rtcAsrFinalTranscript: false,
    kokoroAudio: false,
    browserRemoteAudio: false,
  },
  reviewReady: false,
  evidenceSummary: {
    pipecatWebrtcAnswerSdp: false,
  },
  missingProof: [
    ...(expectedGitHead ? ["repoHeadEvidence"] : []),
    "browserMicrophoneUplink",
    "pipecatWebrtcBridge",
    "rtcAsrFinalTranscript",
    "kokoroAudio",
    "browserRemoteAudio",
  ],
};

const blockers = [];
if (evidence.readiness !== "ready") blockers.push(evidence.reason);
for (const missing of validation.missingProof) blockers.push(`Missing browser WebRTC live proof: ${missing}.`);

const manifest = {
  generatedAt: new Date().toISOString(),
  issue: "agonza1/agentic-contact-center#213",
  reviewReady: validation.reviewReady,
  runtimeModeLabels: {
    browserTransport: "webrtc",
    browserCapture: validation.checks.browserMicrophoneUplink ? "browser_microphone_live" : "browser_microphone_unproven",
    pipecat: validation.checks.pipecatWebrtcBridge ? "pipecat_webrtc_live" : "pipecat_webrtc_unproven",
    rtcAsr: validation.checks.rtcAsrFinalTranscript ? "rtc_asr_live" : "rtc_asr_unproven",
    tts: validation.checks.kokoroAudio ? "kokoro_live" : "kokoro_unproven",
    browserPlayback: validation.checks.browserRemoteAudio ? "remote_audio_live" : "remote_audio_unproven",
  },
  requiredPath: "browser microphone -> WebRTC -> Pipecat bridge -> rtc-asr Local STT v1 -> ACC call API -> Kokoro TTS -> WebRTC/browser playback",
  evidence: {
    path: evidencePath ?? null,
    readiness: evidence.readiness,
    reason: evidence.reason,
  },
  setup: {
    gitHead: expectedGitHead,
    pipecatWebrtcBridgeUrl: process.env.BROWSER_WEBRTC_BRIDGE_URL ?? "http://127.0.0.1:8766",
    rtcAsrBaseUrl: process.env.RTC_ASR_BASE_URL ?? "http://127.0.0.1:8080",
    rtcAsrWsUrl: process.env.RTC_ASR_WS_URL ?? "ws://127.0.0.1:8080/v1/stt/stream",
    kokoroBaseUrl: process.env.KOKORO_BASE_URL ?? "http://127.0.0.1:8880",
    commands: setupCommands,
    evidenceTemplateCommand: "npm run browser-webrtc:live-proof -- --write-template artifacts/browser-webrtc-live-proof/proof.template.json",
    sidecarProbeCommand: "npm run browser-webrtc:live-proof -- --probe-sidecars --out-dir artifacts/browser-webrtc-live-proof/sidecar-preflight",
  },
  checks: validation.checks,
  evidenceSummary: validation.evidenceSummary,
  sidecarConnectivity: await sidecarConnectivity(),
  artifactIntegrity: await artifactIntegrity(evidencePath),
  reviewGate: {
    requiredLabels: ["browser_microphone_live", "pipecat_webrtc_live", "rtc_asr_live", "kokoro_live", "remote_audio_live"],
    missingProof: validation.missingProof,
    nextActions: validation.reviewReady ? [] : [
      "Start the Pipecat WebRTC bridge, rtc-asr, and Kokoro sidecars using manifest.setup.commands.",
      "Optionally write a fill-in evidence template with manifest.setup.evidenceTemplateCommand.",
      "Open /operator/console, connect browser voice, speak one caller turn, and capture bridge/browser proof JSON from this exact git head.",
      "Rerun npm run browser-webrtc:live-proof -- --evidence <proof.json> --require-review-ready.",
    ],
  },
  blockers,
};

if (evidenceTemplatePath) {
  manifest.setup.evidenceTemplatePath = evidenceTemplatePath;
}

const manifestPath = path.join(outDir, "browser-webrtc-live-proof-manifest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const summary = {
  reviewReady: manifest.reviewReady,
  manifestPath,
  blockers,
};
console.log(JSON.stringify(summary, null, 2));

if ((requireReviewReady || blockers.length > 0) && !manifest.reviewReady) {
  process.exit(2);
}
