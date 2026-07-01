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
  const parsed = parseJsonOrJsonLines(await readFile(filePath, "utf8"));
  if (parsed.length === 0) {
    return {
      ready: false,
      blocker: "rtc-asr transcript/evidence file is not valid JSON.",
      nextAction: "Write valid rtc-asr transcript evidence JSON before marking the FreeSWITCH proof review-ready.",
    };
  }

  const transcript = parsed.flatMap(transcriptFragments).join(" ").trim();
  const final = parsed.some(isFinalTranscriptEvidence);
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
  return { ready: true, eventCount: parsed.length, transcript };
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
  const contentItems = [
    ...(Array.isArray(entry?.content) ? entry.content : []),
    ...(Array.isArray(entry?.item?.content) ? entry.item.content : []),
    ...(Array.isArray(entry?.response?.output)
      ? entry.response.output.flatMap((output) => Array.isArray(output?.content) ? output.content : [])
      : []),
  ];
  const channelAlternatives = [
    ...(Array.isArray(entry?.channel?.alternatives) ? entry.channel.alternatives : []),
    ...(Array.isArray(entry?.results?.channels)
      ? entry.results.channels.flatMap((channel) => Array.isArray(channel?.alternatives) ? channel.alternatives : [])
      : []),
    ...(Array.isArray(entry?.channels)
      ? entry.channels.flatMap((channel) => Array.isArray(channel?.alternatives) ? channel.alternatives : [])
      : []),
  ];
  return [
    typeof entry?.transcript === "string" ? entry.transcript : "",
    typeof entry?.transcript?.text === "string" ? entry.transcript.text : "",
    typeof entry?.text === "string" ? entry.text : "",
    typeof entry?.delta === "string" ? entry.delta : "",
    typeof entry?.result?.text === "string" ? entry.result.text : "",
    typeof entry?.result?.transcript === "string" ? entry.result.transcript : "",
    typeof entry?.alternatives?.[0]?.transcript === "string" ? entry.alternatives[0].transcript : "",
    typeof entry?.channel?.alternatives?.[0]?.transcript === "string" ? entry.channel.alternatives[0].transcript : "",
    ...channelAlternatives.map((alternative) => typeof alternative?.transcript === "string" ? alternative.transcript : ""),
    ...contentItems.flatMap((content) => [
      typeof content?.transcript === "string" ? content.transcript : "",
      typeof content?.text === "string" ? content.text : "",
      typeof content?.delta === "string" ? content.delta : "",
    ]),
    ...(Array.isArray(entry?.segments) ? entry.segments.map((segment) => typeof segment?.text === "string" ? segment.text : "") : []),
  ].filter(Boolean);
}

function isFinalTranscriptEvidence(entry) {
  return entry?.final === true
    || entry?.isFinal === true
    || entry?.is_final === true
    || entry?.transcript?.final === true
    || entry?.result?.final === true
    || entry?.result?.is_final === true
    || entry?.speech_final === true
    || entry?.status === "final"
    || entry?.status === "completed"
    || entry?.is_final === "true"
    || entry?.speech_final === "true"
    || entry?.type === "transcript.final"
    || entry?.type === "response.audio_transcript.done"
    || entry?.type === "response.output_text.done"
    || entry?.type === "conversation.item.input_audio_transcription.completed";
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
    if (index > 0) headers.set(line.slice(0, index).trim(), decodeHeaderValue(line.slice(index + 1).trim()));
  }
  return headers;
}

function decodeHeaderValue(value) {
  try {
    return decodeURIComponent(value.replaceAll("+", "%20"));
  } catch {
    return value;
  }
}

function headerSeparatorIndex(raw) {
  const crlfIndex = raw.indexOf("\r\n\r\n");
  const lfIndex = raw.indexOf("\n\n");
  if (crlfIndex === -1) return lfIndex;
  if (lfIndex === -1) return crlfIndex;
  return Math.min(crlfIndex, lfIndex);
}

function separatorLength(raw, index) {
  return raw.slice(index, index + 4) === "\r\n\r\n" ? 4 : 2;
}

export function nextEslFrame(raw) {
  const index = headerSeparatorIndex(raw);
  if (index === -1) return null;
  const length = separatorLength(raw, index);
  const envelope = raw.slice(0, index);
  const headers = parseHeaders(envelope);
  const contentLength = Number(headers.get("Content-Length") ?? 0);
  const bodyStart = index + length;
  if (Number.isFinite(contentLength) && contentLength > 0) {
    const bodyEnd = bodyStart + contentLength;
    if (raw.length < bodyEnd) return null;
    return { block: `${envelope}\n${raw.slice(bodyStart, bodyEnd)}`, rest: raw.slice(bodyEnd) };
  }
  return { block: envelope, rest: raw.slice(bodyStart) };
}

export function visibleRecordingPath(recordingDir, freeswitchRecordingDir, uuid) {
  const hostPath = path.join(recordingDir, `${uuid}.wav`);
  const freeswitchPath = freeswitchRecordingDir ? path.posix.join(freeswitchRecordingDir, `${uuid}.wav`) : hostPath;
  return { hostPath, freeswitchPath };
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
      hostRecordingPath: options.wavPath,
      freeswitchRecordingPath: options.freeswitchRecordingPath ?? options.wavPath,
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

export class EslBridge {
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
    while (true) {
      const frame = nextEslFrame(this.buffer);
      if (!frame) return;
      this.buffer = frame.rest;
      await this.handleBlock(frame.block);
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
    const { hostPath: wavPath, freeswitchPath } = visibleRecordingPath(this.options.recordingDir, this.options.freeswitchRecordingDir, uuid);
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
    this.callMap.set(uuid, { wavPath, freeswitchPath, startedAt: Date.now(), destination, accCallId: response?.body?.call?.session?.callId ?? null });
    this.send(`api uuid_record ${uuid} start ${freeswitchPath}`);
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
    } else if (this.options.rtcAsrEvidencePath) {
      const evidence = await inspectRtcAsrEvidence(this.options.rtcAsrEvidencePath, await stat(this.options.rtcAsrEvidencePath).catch(() => null));
      if (evidence.ready && evidence.transcript) {
        await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
          eventType: "media.transcript",
          timestamp: nowIso(),
          sipCallId: uuid,
          fsUuid: uuid,
          text: evidence.transcript,
          rtcAsrEvidencePath: this.options.rtcAsrEvidencePath,
        });
      }
    }
    await this.flushLog();
    const manifest = await buildFreeswitchLiveProofManifest({
      uuid,
      accCallId: call.accCallId,
      destination: call.destination,
      wavPath: call.wavPath,
      freeswitchRecordingPath: call.freeswitchPath,
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
    freeswitchRecordingDir: argValue("--freeswitch-recording-dir", process.env.FREESWITCH_RECORDING_DIR),
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
