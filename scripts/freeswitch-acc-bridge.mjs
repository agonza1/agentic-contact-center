#!/usr/bin/env node
import net from "node:net";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function argValue(flag, fallback = undefined) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

async function inspectRtcAsrEvidence(filePath, stats) {
  if (!filePath || !stats || stats.size === 0) return { ready: false };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {
      ready: false,
      blocker: "rtc-asr transcript/evidence file is not valid JSON.",
      nextAction: "Write valid rtc-asr transcript evidence JSON before marking the FreeSWITCH proof review-ready.",
    };
  }

  const transcript = [
    typeof parsed.transcript === "string" ? parsed.transcript : "",
    typeof parsed.text === "string" ? parsed.text : "",
    ...(Array.isArray(parsed.segments) ? parsed.segments.map((segment) => typeof segment?.text === "string" ? segment.text : "") : []),
  ].join(" ").trim();
  const final = parsed.final === true || parsed.isFinal === true || parsed.status === "final";
  if (!transcript) {
    return {
      ready: false,
      blocker: "rtc-asr transcript/evidence JSON does not contain a non-empty transcript.",
      nextAction: "Rerun rtc-asr until transcript evidence includes non-empty final text before marking the proof review-ready.",
    };
  }
  if (!final) {
    return {
      ready: false,
      blocker: "rtc-asr transcript/evidence JSON is missing a final transcript marker.",
      nextAction: "Rerun rtc-asr until transcript evidence is final before marking the proof review-ready.",
    };
  }
  return { ready: true };
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function postJson(baseUrl, route, body) {
  const url = new URL(route, baseUrl);
  const rawBody = Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port || 80, path: url.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": rawBody.length } },
      (res) => {
        let collected = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { collected += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: collected ? JSON.parse(collected) : null }));
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

function parseHeaders(block) {
  const headers = new Map();
  for (const line of block.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index > 0) headers.set(line.slice(0, index).trim(), decodeURIComponent(line.slice(index + 1).trim().replaceAll("+", "%20")));
  }
  return headers;
}

export async function buildFreeswitchLiveProofManifest(options) {
  const audioStats = await stat(options.wavPath).catch(() => null);
  const logStats = await stat(options.logPath).catch(() => null);
  const rtcAsrEvidenceStats = options.rtcAsrEvidencePath ? await stat(options.rtcAsrEvidencePath).catch(() => null) : null;
  const rtcAsrEvidenceInspection = await inspectRtcAsrEvidence(options.rtcAsrEvidencePath, rtcAsrEvidenceStats);
  const audioBytes = audioStats?.size ?? 0;
  const generatedMedia = false;
  const rtpPacketCountEstimate = audioBytes > 44 ? Math.floor((audioBytes - 44) / 320) : 0;
  const runtimeModeLabels = {
    telephony: options.telephonyMode,
    media: "live_capture",
    rtcAsr: options.rtcAsrUrl ? "rtc_asr_live" : "rtc_asr_blocked",
    credentialsMode: options.telephonyMode === "signalwire_live" ? "signalwire_live" : "mocked",
  };
  const requiredReviewLabels = ["local_sip", "live_capture", "rtc_asr_live"];
  const presentReviewLabels = new Set(Object.values(runtimeModeLabels));
  const missingReviewLabels = requiredReviewLabels.filter((label) => !presentReviewLabels.has(label));
  const blockers = [];

  if (!audioStats || audioBytes === 0) blockers.push("FreeSWITCH did not write a caller WAV for this call.");
  if (rtpPacketCountEstimate === 0) blockers.push("Captured WAV is empty or too small to prove RTP caller audio.");
  if (!logStats || logStats.size === 0) blockers.push("FreeSWITCH ESL event log is missing or empty.");
  if (!options.rtcAsrUrl) blockers.push("RTC_ASR_WS_URL was not set, so rtc-asr live transcription was not attempted.");
  if (options.rtcAsrUrl && !options.rtcAsrEvidencePath) blockers.push("rtc-asr URL was configured, but no transcript/evidence path was attached to this FreeSWITCH proof.");
  if (options.rtcAsrEvidencePath && !rtcAsrEvidenceStats) blockers.push("rtc-asr transcript/evidence path was configured, but the evidence file is missing.");
  if (rtcAsrEvidenceStats && rtcAsrEvidenceStats.size === 0) blockers.push("rtc-asr transcript/evidence file is empty.");
  if (rtcAsrEvidenceInspection.blocker) blockers.push(rtcAsrEvidenceInspection.blocker);

  const nextActions = [];
  if (rtpPacketCountEstimate === 0) {
    nextActions.push("Place a real local SIP/FreeSWITCH softphone call, speak into the call, and rerun until caller audio is captured.");
  }
  if (!options.rtcAsrUrl) {
    nextActions.push("Start rtc-asr, set RTC_ASR_WS_URL, and rerun the FreeSWITCH bridge proof to capture a websocket-backed transcript.");
  }
  if (options.rtcAsrUrl && !options.rtcAsrEvidencePath) {
    nextActions.push("Attach rtc-asr transcript evidence with --rtc-asr-evidence before marking the FreeSWITCH proof review-ready.");
  }
  if (options.rtcAsrEvidencePath && !rtcAsrEvidenceStats) {
    nextActions.push("Write the rtc-asr transcript evidence file before rerunning the FreeSWITCH bridge proof.");
  }
  if (rtcAsrEvidenceStats && rtcAsrEvidenceStats.size === 0) {
    nextActions.push("Rerun rtc-asr until transcript evidence is non-empty before marking the proof review-ready.");
  }
  if (rtcAsrEvidenceInspection.nextAction) nextActions.push(rtcAsrEvidenceInspection.nextAction);

  const artifactIntegrity = [];
  if (audioStats) {
    artifactIntegrity.push({
      artifactId: "freeswitch-caller-capture-wav",
      kind: "call_media",
      path: options.wavPath,
      sha256: await sha256File(options.wavPath),
      sizeBytes: audioStats.size,
      readiness: audioStats.size > 0 ? "ready" : "blocked",
    });
  }
  if (logStats) {
    artifactIntegrity.push({
      artifactId: "freeswitch-esl-event-log",
      kind: "sip_log",
      path: options.logPath,
      sha256: await sha256File(options.logPath),
      sizeBytes: logStats.size,
      readiness: logStats.size > 0 ? "ready" : "blocked",
    });
  }
  if (rtcAsrEvidenceStats && options.rtcAsrEvidencePath) {
    artifactIntegrity.push({
      artifactId: "rtc-asr-transcript-evidence",
      kind: "transcript_evidence",
      path: options.rtcAsrEvidencePath,
      sha256: await sha256File(options.rtcAsrEvidencePath),
      sizeBytes: rtcAsrEvidenceStats.size,
      readiness: rtcAsrEvidenceInspection.ready ? "ready" : "blocked",
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    workboardCard: "872af947-ef57-47bd-a4f3-3750f54e1948",
    callId: options.accCallId ?? null,
    sipCallId: options.uuid,
    fsUuid: options.uuid,
    runtimeModeLabels,
    localSip: {
      bind: options.telephonyMode === "signalwire_live" ? "signalwire_sip_trunk_to_freeswitch" : "sip:1000@127.0.0.1:5060",
      destination: options.destination ?? "8600",
      acceptedInvite: true,
      rtpPacketCount: rtpPacketCountEstimate,
      remoteRtp: null,
      freeswitchRecordingPath: options.wavPath,
    },
    artifacts: { audioWav: options.wavPath, sipLog: options.logPath, rtcAsrEvidence: options.rtcAsrEvidencePath ?? null },
    artifactIntegrity,
    reviewReady: blockers.length === 0 && runtimeModeLabels.telephony === "local_sip" && rtcAsrEvidenceInspection.ready && !generatedMedia,
    reviewGate: {
      requiredLabels: requiredReviewLabels,
      missingLabels: missingReviewLabels,
      nextActions,
    },
    blockers,
  };
}

class EslBridge {
  constructor(options) {
    this.options = options;
    this.buffer = "";
    this.events = [];
    this.callMap = new Map();
  }

  async start() {
    await mkdir(this.options.recordingDir, { recursive: true });
    this.socket = net.createConnection({ host: this.options.eslHost, port: this.options.eslPort });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => void this.handleData(chunk));
    this.socket.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    this.socket.on("close", () => void this.flushLog());
  }

  send(command) {
    this.socket.write(`${command}\n\n`);
  }

  async handleData(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes("\n\n")) {
      const index = this.buffer.indexOf("\n\n");
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      await this.handleBlock(block);
    }
  }

  async handleBlock(block) {
    const headers = parseHeaders(block);
    const contentType = headers.get("Content-Type");
    this.events.push({ at: nowIso(), headers: Object.fromEntries(headers) });
    if (contentType === "auth/request") {
      this.send(`auth ${this.options.password}`);
      this.send("event plain CHANNEL_ANSWER CHANNEL_HANGUP_COMPLETE RECORD_STOP");
      this.send("filter Event-Name CHANNEL_ANSWER");
      this.send("filter Event-Name CHANNEL_HANGUP_COMPLETE");
      this.send("filter Event-Name RECORD_STOP");
      return;
    }
    if (contentType !== "text/event-plain") return;
    const eventName = headers.get("Event-Name");
    const uuid = headers.get("Unique-ID");
    if (!uuid) return;
    if (eventName === "CHANNEL_ANSWER") await this.onAnswer(uuid, headers);
    if (eventName === "RECORD_STOP") await this.onRecordStop(uuid, headers);
    if (eventName === "CHANNEL_HANGUP_COMPLETE") await this.onHangup(uuid, headers);
  }

  async onAnswer(uuid, headers) {
    if (this.callMap.has(uuid)) return;
    const destination = headers.get("Caller-Destination-Number") ?? "8600";
    const wavPath = path.join(this.options.recordingDir, `${uuid}.wav`);
    const response = await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
      eventType: "call.started",
      timestamp: nowIso(),
      sipCallId: uuid,
      fsUuid: uuid,
      source: "freeswitch_esl",
      telephonyMode: this.options.telephonyMode,
      rtcAsrMode: this.options.rtcAsrUrl ? "rtc_asr_live" : "rtc_asr_blocked",
      destination,
    });
    this.callMap.set(uuid, { wavPath, startedAt: Date.now(), destination, accCallId: response?.body?.call?.session?.callId ?? null });
    this.send(`api uuid_record ${uuid} start ${wavPath}`);
  }

  async onRecordStop(uuid) {
    const call = this.callMap.get(uuid);
    if (!call) return;
    await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
      eventType: "media.capture",
      timestamp: nowIso(),
      sipCallId: uuid,
      fsUuid: uuid,
      audioWavPath: call.wavPath,
      sipLogPath: this.options.logPath,
      generatedMedia: false,
    });
    if (!this.options.rtcAsrUrl) {
      await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
        eventType: "rtc_asr.blocked",
        timestamp: nowIso(),
        sipCallId: uuid,
        fsUuid: uuid,
        blocker: "RTC_ASR_WS_URL unset or rtc-asr sidecar unavailable",
        nextAction: "Start rtc-asr and set RTC_ASR_WS_URL before rerunning FreeSWITCH bridge proof.",
      });
    }
    await this.flushLog();
    const manifest = await buildFreeswitchLiveProofManifest({
      uuid,
      accCallId: call.accCallId,
      destination: call.destination,
      wavPath: call.wavPath,
      logPath: this.options.logPath,
      rtcAsrUrl: this.options.rtcAsrUrl,
      rtcAsrEvidencePath: this.options.rtcAsrEvidencePath,
      telephonyMode: this.options.telephonyMode,
    });
    await mkdir(path.dirname(this.options.manifestPath), { recursive: true });
    await writeFile(this.options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  async onHangup(uuid, headers) {
    const call = this.callMap.get(uuid);
    await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: nowIso(),
      sipCallId: uuid,
      fsUuid: uuid,
      hangupCause: headers.get("Hangup-Cause") ?? null,
      durationSeconds: call ? Math.round((Date.now() - call.startedAt) / 1000) : null,
    });
    this.callMap.delete(uuid);
  }

  async flushLog() {
    await mkdir(path.dirname(this.options.logPath), { recursive: true });
    await writeFile(this.options.logPath, `${JSON.stringify({ generatedAt: nowIso(), events: this.events }, null, 2)}\n`, "utf8");
  }
}

async function main() {
  const bridge = new EslBridge({
    eslHost: argValue("--esl-host", process.env.FREESWITCH_ESL_HOST || "127.0.0.1"),
    eslPort: Number(argValue("--esl-port", process.env.FREESWITCH_ESL_PORT || "8021")),
    password: argValue("--esl-password", process.env.FREESWITCH_ESL_PASSWORD || "ClueCon"),
    accBaseUrl: argValue("--acc-url", process.env.ACC_BASE_URL || "http://127.0.0.1:8026"),
    recordingDir: path.resolve(process.cwd(), argValue("--recording-dir", "artifacts/freeswitch-live/media")),
    logPath: path.resolve(process.cwd(), argValue("--log", "artifacts/freeswitch-live/freeswitch-esl-events.json")),
    manifestPath: path.resolve(process.cwd(), argValue("--manifest", "artifacts/freeswitch-live/freeswitch-live-proof-manifest.json")),
    rtcAsrUrl: argValue("--rtc-asr-url", process.env.RTC_ASR_WS_URL),
    rtcAsrEvidencePath: argValue("--rtc-asr-evidence", process.env.RTC_ASR_EVIDENCE_PATH),
    telephonyMode: argValue("--telephony-mode", process.env.ACC_TELEPHONY_MODE || "local_sip"),
  });
  await bridge.start();
  console.log(`FreeSWITCH ACC bridge connected target ${bridge.options.eslHost}:${bridge.options.eslPort}; ACC ${bridge.options.accBaseUrl}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
