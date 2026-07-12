#!/usr/bin/env node
import net from "node:net";
import dgram from "node:dgram";
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
  const evidence = parsed.flatMap(expandEvidenceEntries);
  if (evidence.length === 0) {
    return {
      ready: false,
      blocker: "rtc-asr transcript/evidence file is not valid JSON.",
      nextAction: "Write valid rtc-asr transcript evidence JSON before marking the FreeSWITCH proof review-ready.",
    };
  }

  const transcript = evidence.flatMap(transcriptFragments).join(" ").trim();
  const final = evidence.some(isFinalTranscriptEvidence);
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
  return { ready: true, eventCount: evidence.length, transcript };
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

function expandEvidenceEntries(entry, depth = 0) {
  if (depth > 4 || entry === null || typeof entry !== "object") return [];
  const wrappedEntries = [entry?.event, entry?.data, entry?.payload, entry?.message]
    .flatMap((value) => {
      if (value === null || value === undefined) return [];
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      }
      return typeof value === "object" ? [value] : [];
    });
  return [entry, ...wrappedEntries.flatMap((value) => expandEvidenceEntries(value, depth + 1))];
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

function decodePcmuSample(sample) {
  const inverted = (~sample) & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude -= 0x84;
  return sign ? -magnitude : magnitude;
}

function decodePcmuToPcm16Base64(payload) {
  const pcm16 = Buffer.alloc(payload.length * 2);
  payload.forEach((sample, index) => pcm16.writeInt16LE(decodePcmuSample(sample), index * 2));
  return pcm16.toString("base64");
}

export function rtpPcmuPacketToPipecatFrameSummary(packet, receivedAt = nowIso()) {
  if (packet.length < 12) throw new Error("rtp_packet_too_short");
  const version = packet[0] >> 6;
  const hasPadding = (packet[0] & 0x20) !== 0;
  const hasExtension = (packet[0] & 0x10) !== 0;
  const csrcCount = packet[0] & 0x0f;
  const payloadType = packet[1] & 0x7f;
  let headerBytes = 12 + csrcCount * 4;
  if (version !== 2) throw new Error("rtp_version_unsupported");
  if (payloadType !== 0) throw new Error("rtp_payload_type_not_pcmu");
  if (packet.length < headerBytes) throw new Error("rtp_header_truncated");
  if (hasExtension) {
    if (packet.length < headerBytes + 4) throw new Error("rtp_extension_header_truncated");
    const extensionLengthBytes = packet.readUInt16BE(headerBytes + 2) * 4;
    if (packet.length < headerBytes + 4 + extensionLengthBytes) throw new Error("rtp_extension_body_truncated");
    headerBytes += 4 + extensionLengthBytes;
  }
  let payloadEnd = packet.length;
  if (hasPadding) {
    const paddingBytes = packet[packet.length - 1];
    if (paddingBytes === 0 || paddingBytes > packet.length - headerBytes) throw new Error("rtp_padding_invalid");
    payloadEnd -= paddingBytes;
  }
  if (payloadEnd <= headerBytes) throw new Error("rtp_payload_missing");
  const payload = packet.subarray(headerBytes, payloadEnd);
  return {
    frameType: "InputAudioRawFrame",
    audioFormat: "pcm_s16le",
    sampleRateHz: 8000,
    channels: 1,
    sequenceNumber: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    durationMs: (payload.length / 8000) * 1000,
    receivedAt,
    pcm16Base64: decodePcmuToPcm16Base64(payload),
  };
}

export class PipecatRtpFrameCollector {
  constructor(options = {}) {
    this.maxFrames = options.maxFrames ?? 200;
    this.frames = [];
    this.errors = [];
  }

  acceptPacket(packet, receivedAt = nowIso()) {
    try {
      const frame = rtpPcmuPacketToPipecatFrameSummary(packet, receivedAt);
      if (this.frames.length < this.maxFrames) this.frames.push(frame);
      return frame;
    } catch (error) {
      this.errors.push({ at: receivedAt, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  summary() {
    const sequenceGaps = [];
    this.frames.forEach((frame, index) => {
      if (index === 0) return;
      const previous = this.frames[index - 1];
      const expected = (previous.sequenceNumber + 1) & 0xffff;
      if (frame.sequenceNumber !== expected) sequenceGaps.push({ after: previous.sequenceNumber, before: frame.sequenceNumber });
    });
    return {
      liveRtpCaptured: this.frames.length > 0,
      frameType: "InputAudioRawFrameBatch",
      audioFormat: "pcm_s16le",
      sampleRateHz: 8000,
      channels: 1,
      packetCount: this.frames.length,
      totalDurationMs: this.frames.reduce((total, frame) => total + frame.durationMs, 0),
      sequenceGaps,
      errors: this.errors,
      frames: this.frames,
    };
  }
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
  const pipecatRtpEvidence = options.pipecatRtpEvidence ?? null;
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
    pipecatMediaEngine: {
      liveRtpAdapter: pipecatRtpEvidence?.liveRtpCaptured ? "captured_pcmu_to_input_audio_frames" : "not_connected",
      realtimeDirection: "sip_rtp_inbound_to_pipecat_input_frames",
      bidirectionalPlaybackReady: false,
      blocker: "Kokoro/Pipecat TTSAudioRawFrame output is not yet encoded back to FreeSWITCH RTP for SIP caller playback.",
      rtpFrameBatch: pipecatRtpEvidence,
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
    this.rtpCollector = new PipecatRtpFrameCollector({ maxFrames: options.rtpMaxFrames ?? 200 });
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
    this.startRtpReceiver();
  }

  send(command) {
    this.socket.write(`${command}\n\n`);
  }

  startRtpReceiver() {
    if (!this.options.rtpListenPort) return;
    this.rtpSocket = dgram.createSocket("udp4");
    this.rtpSocket.on("message", (message) => {
      const frame = this.rtpCollector.acceptPacket(message);
      if (frame) this.events.push({ at: frame.receivedAt, rtpFrame: { sequenceNumber: frame.sequenceNumber, timestamp: frame.timestamp, durationMs: frame.durationMs } });
    });
    this.rtpSocket.on("error", (error) => {
      this.rtpCollector.errors.push({ at: nowIso(), error: error.message });
    });
    this.rtpSocket.bind(this.options.rtpListenPort, this.options.rtpListenHost ?? "127.0.0.1");
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
      pipecatRtpFrameBatch: this.rtpCollector.summary(),
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
      pipecatRtpEvidence: this.rtpCollector.summary(),
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
    rtpListenHost: argValue("--rtp-listen-host", process.env.ACC_FREESWITCH_RTP_LISTEN_HOST || "127.0.0.1"),
    rtpListenPort: Number(argValue("--rtp-listen-port", process.env.ACC_FREESWITCH_RTP_LISTEN_PORT || "0")) || undefined,
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
