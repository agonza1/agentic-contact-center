#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);

function getArg(name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const outDir = getArg("--out-dir", "artifacts/browser-webrtc-live-proof");
const evidencePath = getArg("--evidence");
const requireReviewReady = args.includes("--require-review-ready");

const setupCommands = [
  "export RTC_ASR_BASE_URL=${RTC_ASR_BASE_URL:-http://127.0.0.1:8080}",
  "export RTC_ASR_WS_URL=${RTC_ASR_WS_URL:-ws://127.0.0.1:8080/v1/stt/stream}",
  "export KOKORO_BASE_URL=${KOKORO_BASE_URL:-http://127.0.0.1:8880}",
  "export BROWSER_WEBRTC_BRIDGE_URL=${BROWSER_WEBRTC_BRIDGE_URL:-http://127.0.0.1:8766}",
  "npm run pipecat:voice:check",
  "npm start",
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
  return JSON.stringify(record).toLowerCase().includes(pattern);
}

function validateEvidence(payload) {
  const records = flattenRecords(payload);
  const checks = {
    pipecatWebrtcBridge: records.some((record) => textIncludes(record, "pipecat") && textIncludes(record, "webrtc")),
    rtcAsrFinalTranscript: records.some((record) => {
      const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
      const transcript = typeof record.transcript === "string" ? record.transcript : typeof record.text === "string" ? record.text : "";
      return textIncludes(record, "rtc-asr") && (type.includes("final") || record.final === true || record.isFinal === true) && transcript.trim().length > 0;
    }),
    kokoroAudio: records.some((record) => textIncludes(record, "kokoro") && (textIncludes(record, "audio") || textIncludes(record, "tts"))),
    browserRemoteAudio: records.some((record) => textIncludes(record, "browser") && textIncludes(record, "remote") && textIncludes(record, "audio")),
  };

  return {
    checks,
    reviewReady: Object.values(checks).every(Boolean),
    missingProof: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

async function artifactIntegrity(filePath) {
  if (!filePath) return [];
  try {
    const info = await stat(filePath);
    return [{ artifactId: "browser-webrtc-live-evidence", path: filePath, readiness: "ready", sizeBytes: info.size }];
  } catch {
    return [{ artifactId: "browser-webrtc-live-evidence", path: filePath, readiness: "blocked", sizeBytes: 0 }];
  }
}

await mkdir(outDir, { recursive: true });

const evidence = await readEvidence(evidencePath);
const validation = evidence.payload ? validateEvidence(evidence.payload) : {
  checks: {
    pipecatWebrtcBridge: false,
    rtcAsrFinalTranscript: false,
    kokoroAudio: false,
    browserRemoteAudio: false,
  },
  reviewReady: false,
  missingProof: ["pipecatWebrtcBridge", "rtcAsrFinalTranscript", "kokoroAudio", "browserRemoteAudio"],
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
    pipecatWebrtcBridgeUrl: process.env.BROWSER_WEBRTC_BRIDGE_URL ?? "http://127.0.0.1:8766",
    rtcAsrBaseUrl: process.env.RTC_ASR_BASE_URL ?? "http://127.0.0.1:8080",
    rtcAsrWsUrl: process.env.RTC_ASR_WS_URL ?? "ws://127.0.0.1:8080/v1/stt/stream",
    kokoroBaseUrl: process.env.KOKORO_BASE_URL ?? "http://127.0.0.1:8880",
    commands: setupCommands,
  },
  checks: validation.checks,
  artifactIntegrity: await artifactIntegrity(evidencePath),
  reviewGate: {
    requiredLabels: ["pipecat_webrtc_live", "rtc_asr_live", "kokoro_live", "remote_audio_live"],
    missingProof: validation.missingProof,
    nextActions: validation.reviewReady ? [] : [
      "Start the Pipecat WebRTC bridge, rtc-asr, and Kokoro sidecars using manifest.setup.commands.",
      "Open /operator/console, connect browser voice, speak one caller turn, and capture bridge/browser proof JSON.",
      "Rerun npm run browser-webrtc:live-proof -- --evidence <proof.json> --require-review-ready.",
    ],
  },
  blockers,
};

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
