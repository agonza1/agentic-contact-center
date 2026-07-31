#!/usr/bin/env node
import { createHash } from "node:crypto";
import dgram from "node:dgram";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import process from "node:process";

function argValue(flag, fallback = undefined) {
  const index = process.argv.lastIndexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function nowIso() {
  return new Date().toISOString();
}

function isLoopbackAddress(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function resolveLocalHost({ explicitHost, interfaces = networkInterfaces() } = {}) {
  const requested = String(explicitHost || "").trim();
  if (requested) {
    if (isIP(requested) !== 4 || isLoopbackAddress(requested)) {
      throw new Error(
        `--local-host must be a non-loopback IPv4 address reachable from FreeSWITCH; received ${requested}`,
      );
    }
    return { host: requested, source: "explicit" };
  }

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      const family = typeof entry.family === "string" ? entry.family : String(entry.family);
      if (family === "IPv4" || family === "4") {
        if (!entry.internal && isIP(entry.address) === 4 && !isLoopbackAddress(entry.address)) {
          return { host: entry.address, source: "network_interface" };
        }
      }
    }
  }

  throw new Error(
    "Could not infer a non-loopback IPv4 address reachable from FreeSWITCH; pass --local-host or ACC_SIP_PROOF_LOCAL_HOST",
  );
}

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

function parseSipMessage(buffer) {
  const text = buffer.toString("utf8");
  const [head, body = ""] = text.split(/\r?\n\r?\n/, 2);
  const lines = head.split(/\r?\n/);
  const startLine = lines.shift() ?? "";
  const headers = new Map();
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
  }
  return { text, startLine, headers, body };
}

function header(message, name) {
  return message.headers.get(name.toLowerCase()) ?? "";
}

function parseDigestChallenge(value) {
  const challenge = {};
  for (const match of value.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    challenge[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return challenge;
}

function digestAuthorization({ username, password, method, uri, challenge, nc = "00000001", cnonce = "accproof" }) {
  const realm = challenge.realm;
  const nonce = challenge.nonce;
  const qop = (challenge.qop || "auth").split(",")[0].replaceAll("\"", "").trim() || "auth";
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=MD5`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(",")}`;
}

function parseRtpTargetFromSdp(sdp, fallbackHost) {
  const port = Number(sdp.match(/^m=audio\s+(\d+)\s+/m)?.[1] ?? 0);
  const host = sdp.match(/^c=IN\s+IP4\s+([^\s]+)\s*$/m)?.[1] ?? fallbackHost;
  return port > 0 ? { host, port } : null;
}

function pcm16ToUlaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = 0;
  let pcm = sample;
  if (pcm < 0) {
    pcm = -pcm;
    sign = 0x80;
  }
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function ulawToPcm16(uLawByte) {
  const BIAS = 0x84;
  let uLaw = (~uLawByte) & 0xff;
  const sign = uLaw & 0x80;
  const exponent = (uLaw >> 4) & 0x07;
  const mantissa = uLaw & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}

function wavHeader(dataBytes, sampleRate = 8000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function tonePcm16({ durationMs, sampleRate = 8000, frequency = 440 }) {
  const samples = Math.floor((durationMs / 1000) * sampleRate);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / (sampleRate * 0.08), (samples - index) / (sampleRate * 0.08));
    const sample = Math.round(Math.sin(2 * Math.PI * frequency * (index / sampleRate)) * 10000 * Math.max(0, envelope));
    pcm.writeInt16LE(sample, index * 2);
  }
  return pcm;
}

function pcm16Rms(pcm) {
  if (!pcm.length) return 0;
  let sumSquares = 0;
  const sampleCount = Math.floor(pcm.length / 2);
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    sumSquares += sample * sample;
  }
  return Math.round(Math.sqrt(sumSquares / Math.max(sampleCount, 1)));
}

function playbackAfterTimestamp(chunks, timestamp) {
  const thresholdMs = Date.parse(timestamp || "");
  const matchedChunks = Number.isFinite(thresholdMs)
    ? chunks.filter((chunk) => chunk.receivedAtMs >= thresholdMs)
    : [];
  const pcm = Buffer.concat(matchedChunks.map((chunk) => chunk.pcm));
  const packetCount = matchedChunks.length;
  const rms = pcm16Rms(pcm);
  return {
    timestamp: Number.isFinite(thresholdMs) ? new Date(thresholdMs).toISOString() : null,
    packetCount,
    rms,
    audioBytes: pcm.length,
    confirmed: packetCount >= 10 && rms >= 50,
  };
}

function playbackBeforeTimestamp(chunks, timestamp) {
  const thresholdMs = Date.parse(timestamp || "");
  const matchedChunks = Number.isFinite(thresholdMs)
    ? chunks.filter((chunk) => chunk.receivedAtMs < thresholdMs)
    : chunks;
  const pcm = Buffer.concat(matchedChunks.map((chunk) => chunk.pcm));
  return {
    timestamp: Number.isFinite(thresholdMs) ? new Date(thresholdMs).toISOString() : null,
    packetCount: matchedChunks.length,
    rms: pcm16Rms(pcm),
    audioBytes: pcm.length,
  };
}

function latestTimestamp(...timestamps) {
  const parsed = timestamps
    .map((timestamp) => Date.parse(timestamp || ""))
    .filter((timestamp) => Number.isFinite(timestamp));
  return parsed.length ? new Date(Math.max(...parsed)).toISOString() : null;
}

function pcm16MonoFromWav(wav, targetSampleRate = 8000) {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("caller audio must be a RIFF/WAVE file");
  }
  let offset = 12;
  let format = null;
  let audio = null;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const declaredSize = wav.readUInt32LE(offset + 4);
    const availableSize = Math.min(declaredSize, wav.length - offset - 8);
    const chunk = wav.subarray(offset + 8, offset + 8 + availableSize);
    if (chunkId === "fmt " && chunk.length >= 16) {
      format = {
        encoding: chunk.readUInt16LE(0),
        channels: chunk.readUInt16LE(2),
        sampleRate: chunk.readUInt32LE(4),
        bitsPerSample: chunk.readUInt16LE(14),
      };
    } else if (chunkId === "data") {
      audio = chunk;
      break;
    }
    if (declaredSize === 0xffffffff) break;
    offset += 8 + declaredSize + (declaredSize % 2);
  }
  if (!format || !audio) throw new Error("caller WAV is missing fmt or data audio");
  if (format.encoding !== 1 || format.bitsPerSample !== 16 || ![1, 2].includes(format.channels)) {
    throw new Error(`caller WAV must be PCM16 mono/stereo; got format=${format.encoding} bits=${format.bitsPerSample} channels=${format.channels}`);
  }
  const frameBytes = format.channels * 2;
  const sourceSamples = Math.floor(audio.length / frameBytes);
  const mono = new Int16Array(sourceSamples);
  for (let index = 0; index < sourceSamples; index += 1) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      sum += audio.readInt16LE(index * frameBytes + channel * 2);
    }
    mono[index] = Math.round(sum / format.channels);
  }
  const targetSamples = Math.floor((sourceSamples * targetSampleRate) / format.sampleRate);
  const pcm = Buffer.alloc(targetSamples * 2);
  for (let index = 0; index < targetSamples; index += 1) {
    const sourceIndex = Math.min(sourceSamples - 1, Math.floor((index * format.sampleRate) / targetSampleRate));
    pcm.writeInt16LE(mono[sourceIndex], index * 2);
  }
  return pcm;
}

function extractVertoCallId(snapshot) {
  const explicit = String(snapshot?.vertoCallId || "").trim();
  if (explicit) return explicit;
  const correlationId = String(snapshot?.correlationId || snapshot?.lastEvidence?.acc?.correlationId || "").trim();
  const match = correlationId.match(/^acc-pipecat-(.+)$/);
  if (match?.[1]) return match[1];
  return String(snapshot?.callId || "").trim();
}

function evidenceCorrelationIds(snapshot) {
  return new Set([
    extractVertoCallId(snapshot),
    snapshot?.vertoCallId,
    snapshot?.sipCallId,
    snapshot?.linkedSipCallId,
    snapshot?.proofSipCallId,
    snapshot?.harnessSipCallId,
    snapshot?.accCallId,
    snapshot?.callId,
  ].map((value) => String(value || "").trim()).filter(Boolean));
}

async function readEvidenceCallIds(evidencePath) {
  if (!evidencePath) return new Set();
  try {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    const snapshots = Array.isArray(evidence.pipelineEvidence) ? evidence.pipelineEvidence : [evidence];
    return new Set(snapshots.flatMap((snapshot) => [...evidenceCorrelationIds(snapshot)]));
  } catch {
    return new Set();
  }
}

async function loadRtcAsrEvidence(evidencePath, { startedAtMs, baselineCallIds, expectedSipCallId }) {
  if (!evidencePath) return { ready: false, transcript: "", ttsReady: false, evidence: null };
  try {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    const snapshots = Array.isArray(evidence.pipelineEvidence) ? evidence.pipelineEvidence : [evidence];
    const expectedCorrelationId = String(expectedSipCallId || "").trim();
    let fallbackReadyEvidence = null;
    for (const snapshot of snapshots) {
      const evidenceCallId = extractVertoCallId(snapshot);
      if (!evidenceCallId || baselineCallIds.has(evidenceCallId)) continue;
      const correlationIds = evidenceCorrelationIds(snapshot);
      const matchesExpectedCall = Boolean(expectedCorrelationId) && correlationIds.has(expectedCorrelationId);
      const accCallId = String(snapshot?.accCallId || snapshot?.callId || "");
      const sipCallId = String(snapshot?.sipCallId || evidenceCallId);
      const linkedSipCallId = String(snapshot?.linkedSipCallId || "");
      const proofSipCallId = String(snapshot?.proofSipCallId || snapshot?.harnessSipCallId || "");
      const stages = Array.isArray(snapshot?.stageEvents) ? snapshot.stageEvents : [];
      const isCurrentCallEvent = (event) => Number.isFinite(Date.parse(event?.timestamp)) && Date.parse(event.timestamp) >= startedAtMs;
      const finalTranscriptSource = String(snapshot?.lastEvidence?.stt?.finalTranscriptSource || "");
      const lastEvidenceTranscriptIsValidated = finalTranscriptSource === "rtc_asr_final"
        || (
          finalTranscriptSource === "rtc_asr_interim_fallback"
          && snapshot?.lastEvidence?.stt?.finalEventObserved === true
        );
      const finalTranscript = [...stages].reverse().find((event) => isCurrentCallEvent(event) && event?.stage === "stt.transcript_final" && event?.ok !== false && String(event?.transcript || "").trim())
        || (String(snapshot?.lastEvidence?.callerTranscript || "").trim()
          && snapshot?.lastEvidence?.stt?.engine === "rtc-asr"
          && lastEvidenceTranscriptIsValidated
          && isCurrentCallEvent(snapshot?.lastEvidence?.acc)
          ? {
              transcript: String(snapshot.lastEvidence.callerTranscript).trim(),
              timestamp: snapshot.lastEvidence.acc.timestamp,
            }
          : null);
      const finalTranscriptMs = Date.parse(finalTranscript?.timestamp || "");
      const isResponseTtsEvent = (event) => isCurrentCallEvent(event)
        && (!Number.isFinite(finalTranscriptMs) || Date.parse(event.timestamp) >= finalTranscriptMs);
      const responseStartedEvent = stages.find((event) => isResponseTtsEvent(event) && (event?.stage === "tts.stream_started" || event?.stage === "tts.audio_chunk") && event?.ok !== false)
        || null;
      const ttsReadyEvent = stages.find((event) => isResponseTtsEvent(event) && (event?.stage === "tts.audio_ready" || event?.stage === "tts.stream_completed") && event?.ok !== false)
        || (isCurrentCallEvent(snapshot?.lastTtsEvidence)
          && (!Number.isFinite(finalTranscriptMs) || Date.parse(snapshot.lastTtsEvidence.timestamp) >= finalTranscriptMs)
          && snapshot?.lastTtsEvidence?.stage === "tts.stream_completed"
          && snapshot?.lastTtsEvidence?.ok !== false
          && Number(snapshot?.lastTtsEvidence?.audioBytesEnqueued || 0) > 0
          ? snapshot.lastTtsEvidence
          : null);
      if (finalTranscript && ttsReadyEvent) {
        const readyEvidence = {
          ready: true,
          transcript: String(finalTranscript.transcript).trim(),
          transcriptAt: finalTranscript.timestamp,
          ttsReady: true,
          ttsReadyAt: ttsReadyEvent.timestamp,
          responseStartedAt: responseStartedEvent?.timestamp || ttsReadyEvent.timestamp,
          responseStartedStage: responseStartedEvent?.stage || ttsReadyEvent.stage || null,
          evidenceCallId,
          accCallId,
          sipCallId,
          linkedSipCallId,
          proofSipCallId,
          correlationMode: matchesExpectedCall ? "expected_sip_call_id" : "fresh_non_baseline_current_window",
          evidence,
        };
        if (matchesExpectedCall) return readyEvidence;
        fallbackReadyEvidence ??= readyEvidence;
      }
    }
    if (!expectedCorrelationId && fallbackReadyEvidence) return fallbackReadyEvidence;
    return { ready: false, transcript: "", ttsReady: false, evidence };
  } catch {
    return { ready: false, transcript: "", ttsReady: false, evidence: null };
  }
}

async function waitForRtcAsrEvidence(evidencePath, options, { timeoutMs = 8_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = await loadRtcAsrEvidence(evidencePath, options);
  while (!latest.ready && evidencePath && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    latest = await loadRtcAsrEvidence(evidencePath, options);
  }
  return latest;
}

function ulawPacketsFromPcm(pcm, { payloadSamples = 160, ssrc = 0xacc222 }) {
  const packets = [];
  let sequence = 1;
  let timestamp = 0;
  for (let offset = 0; offset < pcm.length; offset += payloadSamples * 2) {
    const slice = pcm.subarray(offset, offset + payloadSamples * 2);
    const payload = Buffer.alloc(Math.ceil(slice.length / 2));
    for (let index = 0; index < payload.length; index += 1) {
      const sampleOffset = index * 2;
      const sample = sampleOffset + 1 < slice.length ? slice.readInt16LE(sampleOffset) : 0;
      payload[index] = pcm16ToUlaw(sample);
    }
    const packet = Buffer.alloc(12 + payload.length);
    packet[0] = 0x80;
    packet[1] = 0x00;
    packet.writeUInt16BE(sequence & 0xffff, 2);
    packet.writeUInt32BE(timestamp >>> 0, 4);
    packet.writeUInt32BE(ssrc, 8);
    payload.copy(packet, 12);
    packets.push(packet);
    sequence += 1;
    timestamp += payloadSamples;
  }
  return packets;
}

class SipProofCall {
  constructor(options) {
    this.options = options;
    this.events = [];
    this.returnPcmChunks = [];
    this.returnRtpChunks = [];
    this.returnPacketCount = 0;
    this.callId = `acc-proof-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.fromTag = `acc${Date.now()}`;
    this.toTag = "";
    this.cseq = 1;
    this.remoteRtp = null;
    this.completed = false;
    this.accepted = false;
    this.authInviteSent = false;
    this.challengeAckSent = false;
    this.mediaTasks = new Set();
    this.callerAudioStartedAtMs = null;
    this.introNonSilentPacketCount = 0;
    this.introConsecutiveSilentPacketCount = 0;
    this.observableIntroCompletedAt = null;
  }

  async run() {
    await mkdir(this.options.outDir, { recursive: true });
    this.startedAtMs = Date.now();
    this.rtcAsrBaselineCallIds = await readEvidenceCallIds(this.options.rtcAsrEvidencePath);
    const callerSpeechPcm = this.options.callerAudioPath
      ? pcm16MonoFromWav(await readFile(this.options.callerAudioPath))
      : tonePcm16({ durationMs: this.options.toneMs, frequency: this.options.frequency });
    this.callerPcm = Buffer.concat([
      callerSpeechPcm,
      Buffer.alloc(Math.max(0, Math.round(this.options.tailSilenceMs * 8)) * 2),
    ]);
    this.sipSocket = dgram.createSocket("udp4");
    this.rtpSocket = dgram.createSocket("udp4");
    this.sipSocket.on("message", (msg, rinfo) => void this.handleSip(msg, rinfo));
    this.rtpSocket.on("message", (msg, rinfo) => this.handleRtp(msg, rinfo));
    await Promise.all([
      new Promise((resolve) => this.sipSocket.bind(this.options.localSipPort, this.options.localBindHost, resolve)),
      new Promise((resolve) => this.rtpSocket.bind(this.options.localRtpPort, this.options.localBindHost, resolve)),
    ]);
    await this.sendInvite();
    await new Promise((resolve) => setTimeout(resolve, this.options.callMs));
    await Promise.allSettled([...this.mediaTasks]);
    await this.sendBye().catch((error) => this.record("sip.bye_failed", { error: String(error) }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.sipSocket.close();
    this.rtpSocket.close();
    return await this.writeArtifacts();
  }

  record(type, detail = {}) {
    const event = { at: nowIso(), type, ...detail };
    this.events.push(event);
    return event;
  }

  inviteRequest({ authorization = null, cseq = this.cseq } = {}) {
    const uri = `sip:${this.options.destination}@${this.options.remoteHost}:${this.options.remoteSipPort}`;
    const sdp = [
      "v=0",
      `o=acc-proof 0 0 IN IP4 ${this.options.localHost}`,
      "s=ACC Verto SIP live proof",
      `c=IN IP4 ${this.options.localHost}`,
      "t=0 0",
      `m=audio ${this.options.localRtpPort} RTP/AVP 0`,
      "a=rtpmap:0 PCMU/8000",
      "a=sendrecv",
      "",
    ].join("\r\n");
    const headers = [
      `INVITE ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.options.localHost}:${this.options.localSipPort};branch=z9hG4bK-${this.callId}-${cseq}`,
      "Max-Forwards: 70",
      `From: "ACC SIP Proof" <sip:${this.options.username}@${this.options.domain}>;tag=${this.fromTag}`,
      `To: <sip:${this.options.destination}@${this.options.domain}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} INVITE`,
      `Contact: <sip:${this.options.username}@${this.options.localHost}:${this.options.localSipPort}>`,
      `X-ACC-Proof-Call-ID: ${this.callId}`,
      ...(authorization ? [`Proxy-Authorization: ${authorization}`] : []),
      "Content-Type: application/sdp",
      `Content-Length: ${Buffer.byteLength(sdp)}`,
      "",
      sdp,
    ];
    return Buffer.from(headers.join("\r\n"));
  }

  async sendInvite({ authorization = null } = {}) {
    const packet = this.inviteRequest({ authorization, cseq: this.cseq });
    this.record("sip.send", { startLine: packet.toString("utf8").split(/\r?\n/, 1)[0], cseq: this.cseq, authorized: Boolean(authorization) });
    await this.sendSip(packet);
  }

  async sendSip(packet) {
    await new Promise((resolve, reject) => {
      this.sipSocket.send(packet, this.options.remoteSipPort, this.options.remoteHost, (error) => error ? reject(error) : resolve());
    });
  }

  async handleSip(msg, rinfo) {
    const message = parseSipMessage(msg);
    this.record("sip.recv", { remote: `${rinfo.address}:${rinfo.port}`, startLine: message.startLine, cseq: header(message, "cseq") });
    if (message.startLine.startsWith("SIP/2.0 407") && header(message, "cseq").includes("INVITE")) {
      if (header(message, "cseq").startsWith("1 ")) {
        if (!this.challengeAckSent) {
          this.challengeAckSent = true;
          await this.sendAck({ cseq: 1, toHeader: header(message, "to"), transactionBranch: `${this.callId}-1` });
        }
        if (this.authInviteSent) return;
        this.authInviteSent = true;
        const challenge = parseDigestChallenge(header(message, "proxy-authenticate"));
        const uri = `sip:${this.options.destination}@${this.options.remoteHost}:${this.options.remoteSipPort}`;
        const authorization = digestAuthorization({
          username: this.options.username,
          password: this.options.password,
          method: "INVITE",
          uri,
          challenge,
        });
        this.cseq = 2;
        await this.sendInvite({ authorization });
      }
      return;
    }
    if (message.startLine.startsWith("SIP/2.0 200") && header(message, "cseq").includes("INVITE")) {
      this.toTag = header(message, "to").match(/;tag=([^;>\s]+)/)?.[1] ?? this.toTag;
      await this.sendAck({ cseq: this.cseq, toHeader: header(message, "to") });
      if (this.accepted) return;
      this.accepted = true;
      this.remoteRtp = parseRtpTargetFromSdp(message.body, rinfo.address);
      const task = this.sendCallerAudio()
        .catch((error) => this.record("rtp.caller_audio_failed", { error: String(error) }))
        .finally(() => this.mediaTasks.delete(task));
      this.mediaTasks.add(task);
      return;
    }
    if (message.startLine.startsWith("SIP/2.0 200") && header(message, "cseq").includes("BYE")) {
      this.completed = true;
    }
  }

  async sendAck({ cseq = this.cseq, toHeader = "", transactionBranch = null } = {}) {
    const uri = `sip:${this.options.destination}@${this.options.remoteHost}:${this.options.remoteSipPort}`;
    const resolvedTo = toHeader || `<sip:${this.options.destination}@${this.options.domain}>${this.toTag ? `;tag=${this.toTag}` : ""}`;
    const branch = transactionBranch || `${this.callId}-ack-${cseq}`;
    const packet = Buffer.from([
      `ACK ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.options.localHost}:${this.options.localSipPort};branch=z9hG4bK-${branch}`,
      "Max-Forwards: 70",
      `From: "ACC SIP Proof" <sip:${this.options.username}@${this.options.domain}>;tag=${this.fromTag}`,
      `To: ${resolvedTo}`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} ACK`,
      `Contact: <sip:${this.options.username}@${this.options.localHost}:${this.options.localSipPort}>`,
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n"));
    this.record("sip.send", { startLine: "ACK", cseq, transactionBranch: branch });
    await this.sendSip(packet);
  }

  async sendBye() {
    const uri = `sip:${this.options.destination}@${this.options.remoteHost}:${this.options.remoteSipPort}`;
    const packet = Buffer.from([
      `BYE ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.options.localHost}:${this.options.localSipPort};branch=z9hG4bK-${this.callId}-bye`,
      "Max-Forwards: 70",
      `From: "ACC SIP Proof" <sip:${this.options.username}@${this.options.domain}>;tag=${this.fromTag}`,
      `To: <sip:${this.options.destination}@${this.options.domain}>${this.toTag ? `;tag=${this.toTag}` : ""}`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq + 1} BYE`,
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n"));
    this.record("sip.send", { startLine: "BYE", cseq: this.cseq + 1 });
    await this.sendSip(packet);
  }

  async sendCallerAudio() {
    if (!this.remoteRtp) {
      this.record("rtp.caller_audio_blocked", { blocker: "No remote RTP target was discovered from FreeSWITCH answer SDP." });
      return;
    }
    if (this.options.mediaDelayMs > 0) {
      this.record("rtp.caller_audio_waiting", { mediaDelayMs: this.options.mediaDelayMs });
      await new Promise((resolve) => setTimeout(resolve, this.options.mediaDelayMs));
    }
    await this.waitForObservableIntroCompletion();
    this.callerAudioStartedAtMs = Date.now();
    const packets = ulawPacketsFromPcm(this.callerPcm, { ssrc: this.options.ssrc });
    this.record("rtp.caller_audio_started", { packetCount: packets.length, remoteRtp: this.remoteRtp, audioBytes: this.callerPcm.length });
    for (const packet of packets) {
      await new Promise((resolve, reject) => {
        this.rtpSocket.send(packet, this.remoteRtp.port, this.remoteRtp.host, (error) => error ? reject(error) : resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.record("rtp.caller_audio_finished", { packetCount: packets.length });
  }

  async waitForObservableIntroCompletion() {
    const deadline = Date.now() + this.options.introWaitTimeoutMs;
    while (!this.observableIntroCompletedAt && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!this.observableIntroCompletedAt) {
      this.record("rtp.prerecorded_intro_completion_timeout", {
        timeoutMs: this.options.introWaitTimeoutMs,
        nonSilentPacketCount: this.introNonSilentPacketCount,
        consecutiveSilentPacketCount: this.introConsecutiveSilentPacketCount,
      });
    }
    return this.observableIntroCompletedAt;
  }

  handleRtp(msg, rinfo) {
    if (msg.length < 12) return;
    const payloadType = msg[1] & 0x7f;
    if (payloadType !== 0) return;
    const receivedAtMs = Date.now();
    const payload = msg.subarray(12);
    const pcm = Buffer.alloc(payload.length * 2);
    for (let index = 0; index < payload.length; index += 1) pcm.writeInt16LE(ulawToPcm16(payload[index]), index * 2);
    this.returnPcmChunks.push(pcm);
    this.returnRtpChunks.push({ pcm, receivedAtMs, receivedAt: new Date(receivedAtMs).toISOString() });
    this.returnPacketCount += 1;
    if (this.returnPacketCount === 1) this.record("rtp.return_audio_started", { remote: `${rinfo.address}:${rinfo.port}` });
    if (!this.callerAudioStartedAtMs && !this.observableIntroCompletedAt) {
      const packetRms = pcm16Rms(pcm);
      if (packetRms >= 50) {
        this.introNonSilentPacketCount += 1;
        this.introConsecutiveSilentPacketCount = 0;
      } else if (this.introNonSilentPacketCount >= 10) {
        this.introConsecutiveSilentPacketCount += 1;
        if (this.introConsecutiveSilentPacketCount >= 12) {
          this.observableIntroCompletedAt = new Date(receivedAtMs).toISOString();
          this.record("rtp.prerecorded_intro_completed", {
            observedAt: this.observableIntroCompletedAt,
            method: "caller_rtp_non_silent_then_240ms_silence",
            nonSilentPacketCount: this.introNonSilentPacketCount,
            consecutiveSilentPacketCount: this.introConsecutiveSilentPacketCount,
          });
        }
      }
    }
  }

  async writeArtifacts() {
    const callerWavPath = path.join(this.options.outDir, "caller-input.wav");
    const playbackWavPath = path.join(this.options.outDir, "caller-playback-capture.wav");
    const sipLogPath = path.join(this.options.outDir, "sip-events.json");
    const playbackEvidencePath = path.join(this.options.outDir, "caller-playback-evidence.json");
    const normalizedRtcAsrEvidencePath = path.join(this.options.outDir, "rtc-asr-transcript-evidence.json");
    const rtcAsrEvidencePath = this.options.rtcAsrEvidencePath ? path.resolve(this.options.rtcAsrEvidencePath) : null;
    const manifestPath = path.join(this.options.outDir, "verto-sip-live-proof-manifest.json");
    const callerWav = Buffer.concat([wavHeader(this.callerPcm.length), this.callerPcm]);
    const playbackPcm = Buffer.concat(this.returnPcmChunks);
    const playbackWav = Buffer.concat([wavHeader(playbackPcm.length), playbackPcm]);
    await writeFile(callerWavPath, callerWav);
    await writeFile(playbackWavPath, playbackWav);
    await writeFile(sipLogPath, `${JSON.stringify(this.events, null, 2)}\n`, "utf8");
    const rtcAsrEvidence = await waitForRtcAsrEvidence(rtcAsrEvidencePath, {
      startedAtMs: this.startedAtMs,
      baselineCallIds: this.rtcAsrBaselineCallIds,
      expectedSipCallId: this.callId,
    });
    const rtcAsrReady = rtcAsrEvidence.ready;
    const playbackRms = pcm16Rms(playbackPcm);
    const responsePlaybackBoundaryAt = latestTimestamp(
      rtcAsrEvidence.responseStartedAt || rtcAsrEvidence.ttsReadyAt,
      this.observableIntroCompletedAt,
    );
    const introPlayback = playbackBeforeTimestamp(this.returnRtpChunks, responsePlaybackBoundaryAt);
    const responsePlayback = playbackAfterTimestamp(this.returnRtpChunks, responsePlaybackBoundaryAt);
    const anyPlaybackConfirmed = this.returnPacketCount >= 10 && playbackRms >= 50;
    const callerPlaybackConfirmed = rtcAsrReady && Boolean(this.observableIntroCompletedAt) && responsePlayback.confirmed;
    await writeFile(
      playbackEvidencePath,
      `${JSON.stringify({
        status: callerPlaybackConfirmed ? "caller_playback_confirmed" : "caller_playback_blocked",
        callerPlaybackConfirmed,
        method: "repo_sip_uac_rtp_capture",
        callId: this.callId,
        packetCount: this.returnPacketCount,
        playbackRms,
        anyPlaybackConfirmed,
        playbackWavPath,
        playbackAudioBytes: playbackPcm.length,
        responsePlaybackBoundaryAt: responsePlayback.timestamp,
        responsePlaybackBoundaryStage: rtcAsrEvidence.responseStartedStage || null,
        observableIntroCompletedAt: this.observableIntroCompletedAt,
        observableIntroCompletionMethod: "caller_rtp_non_silent_then_240ms_silence",
        responseTtsStartedAt: rtcAsrEvidence.responseStartedAt || null,
        responseTtsReadyAt: rtcAsrEvidence.ttsReadyAt || null,
        responsePlaybackConfirmed: responsePlayback.confirmed,
        responsePlaybackPacketCount: responsePlayback.packetCount,
        responsePlaybackRms: responsePlayback.rms,
        responsePlaybackAudioBytes: responsePlayback.audioBytes,
        introPlaybackPacketCount: introPlayback.packetCount,
        introPlaybackRms: introPlayback.rms,
        introPlaybackAudioBytes: introPlayback.audioBytes,
        generatedAt: nowIso(),
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      normalizedRtcAsrEvidencePath,
      `${JSON.stringify({
        schemaVersion: 1,
        type: rtcAsrReady ? "transcript.final" : "transcript.blocked",
        status: rtcAsrReady ? "final" : "blocked",
        final: rtcAsrReady,
        callId: this.callId,
        sipCallId: this.callId,
        vertoCallId: rtcAsrEvidence.evidenceCallId || null,
        accCallId: rtcAsrEvidence.accCallId || null,
        evidenceSipCallId: rtcAsrEvidence.sipCallId || null,
        proofSipCallId: rtcAsrEvidence.proofSipCallId || null,
        linkedSipCallId: rtcAsrEvidence.linkedSipCallId || null,
        correlationMode: rtcAsrEvidence.correlationMode || null,
        transcript: rtcAsrEvidence.transcript,
        transcriptAt: rtcAsrEvidence.transcriptAt || null,
        ttsAudioReady: rtcAsrEvidence.ttsReady,
        ttsAudioReadyAt: rtcAsrEvidence.ttsReadyAt || null,
        ttsResponseStartedAt: rtcAsrEvidence.responseStartedAt || null,
        ttsResponseStartedStage: rtcAsrEvidence.responseStartedStage || null,
        currentCallWindowStartedAt: new Date(this.startedAtMs).toISOString(),
        sourcePipecatEvidence: rtcAsrEvidencePath,
        generatedAt: nowIso(),
      }, null, 2)}\n`,
      "utf8",
    );
    const blockers = [];
    if (!this.remoteRtp) blockers.push("FreeSWITCH did not return an RTP target in the accepted INVITE SDP.");
    if (!anyPlaybackConfirmed) blockers.push("No caller-side return RTP audio was captured.");
    if (!this.observableIntroCompletedAt) blockers.push("Caller-side RTP did not expose a non-silent intro followed by 240 ms of silence before caller audio.");
    if (rtcAsrReady && !responsePlayback.confirmed) blockers.push("No caller-side return RTP audio was captured after the response TTS start event.");
    if (!rtcAsrReady) blockers.push("rtc-asr transcript evidence path was not attached or is empty.");
    const manifest = {
      schemaVersion: 1,
      generatedAt: nowIso(),
      workboardCard: "e10f92c2-7b71-4956-9410-1f84f253dd3d",
      callId: this.options.accCallId ?? null,
      sipCallId: this.callId,
      runtimeModeLabels: {
        telephony: "local_sip",
        media: "live_capture",
        rtcAsr: rtcAsrReady ? "rtc_asr_live" : "rtc_asr_blocked",
        pipecat: "pipecat_verto_webrtc",
        playback: callerPlaybackConfirmed ? "caller_audible_playback" : "caller_playback_blocked",
      },
      localSip: {
        bind: `sip:${this.options.username}@${this.options.localHost}:${this.options.localSipPort}`,
        socketBind: `${this.options.localBindHost}:${this.options.localSipPort}`,
        advertisedRtpHost: this.options.localHost,
        destination: this.options.destination,
        acceptedInvite: Boolean(this.remoteRtp),
        remoteRtp: this.remoteRtp,
        rtpPacketCount: Math.ceil(this.callerPcm.length / 320),
        callerInputPacketCount: Math.ceil(this.callerPcm.length / 320),
        callerPlaybackPacketCount: this.returnPacketCount,
        callerPlaybackRms: playbackRms,
        introPlaybackPacketCount: introPlayback.packetCount,
        introPlaybackRms: introPlayback.rms,
        responsePlaybackPacketCount: responsePlayback.packetCount,
        responsePlaybackRms: responsePlayback.rms,
      },
      artifacts: {
        audioWav: callerWavPath,
        callerInputWav: callerWavPath,
        callerPlaybackWav: playbackWavPath,
        sipLog: sipLogPath,
        rtcAsrEvidence: normalizedRtcAsrEvidencePath,
        pipecatVertoEvidence: rtcAsrEvidencePath,
        callerPlaybackEvidence: playbackEvidencePath,
      },
      artifactIntegrity: [
        { artifactId: "caller-input-wav", kind: "call_media", path: callerWavPath, sha256: await sha256File(callerWavPath), sizeBytes: callerWav.length, readiness: "ready" },
        { artifactId: "caller-playback-capture-wav", kind: "playback_media", path: playbackWavPath, sha256: await sha256File(playbackWavPath), sizeBytes: playbackWav.length, readiness: callerPlaybackConfirmed ? "ready" : "blocked" },
        { artifactId: "sip-events", kind: "sip_log", path: sipLogPath, sha256: await sha256File(sipLogPath), sizeBytes: (await stat(sipLogPath)).size, readiness: "ready" },
        { artifactId: "rtc-asr-transcript-evidence", kind: "transcript_evidence", path: normalizedRtcAsrEvidencePath, sha256: await sha256File(normalizedRtcAsrEvidencePath), sizeBytes: (await stat(normalizedRtcAsrEvidencePath)).size, readiness: rtcAsrReady ? "ready" : "blocked" },
        { artifactId: "caller-audible-playback-proof", kind: "playback_evidence", path: playbackEvidencePath, sha256: await sha256File(playbackEvidencePath), sizeBytes: (await stat(playbackEvidencePath)).size, readiness: callerPlaybackConfirmed ? "ready" : "blocked" },
      ],
      reviewReady: blockers.length === 0,
      reviewGate: {
        requiredLabels: ["local_sip", "live_capture", "rtc_asr_live", "pipecat_verto_webrtc", "caller_audible_playback"],
        missingLabels: [
          ...(!rtcAsrReady ? ["rtc_asr_live"] : []),
          ...(!callerPlaybackConfirmed ? ["caller_audible_playback"] : []),
        ],
        nextActions: blockers.length === 0 ? [] : [
          "Run the Pipecat Verto bridge with ACC_PIPECAT_AGENT_TEXT_OVERRIDE and rtc-asr/Kokoro sidecars, then rerun this caller proof.",
          "Attach the Pipecat bridge rtc-asr/stage evidence path with --rtc-asr-evidence.",
        ],
      },
      callerPlaybackEvidence: {
        callerPlaybackConfirmed,
        packetCount: this.returnPacketCount,
        playbackRms,
        playbackWavPath,
        anyPlaybackConfirmed,
        responsePlaybackBoundaryAt: responsePlayback.timestamp,
        responsePlaybackBoundaryStage: rtcAsrEvidence.responseStartedStage || null,
        observableIntroCompletedAt: this.observableIntroCompletedAt,
        responseTtsStartedAt: rtcAsrEvidence.responseStartedAt || null,
        responseTtsReadyAt: rtcAsrEvidence.ttsReadyAt || null,
        responsePlaybackConfirmed: responsePlayback.confirmed,
        responsePlaybackPacketCount: responsePlayback.packetCount,
        responsePlaybackRms: responsePlayback.rms,
        introPlaybackPacketCount: introPlayback.packetCount,
        introPlaybackRms: introPlayback.rms,
      },
      rtcAsrEvidence: {
        transcriptCaptured: rtcAsrReady,
        transcript: rtcAsrEvidence.transcript,
        ttsAudioReady: rtcAsrEvidence.ttsReady,
        ttsResponseStartedAt: rtcAsrEvidence.responseStartedAt || null,
        ttsResponseStartedStage: rtcAsrEvidence.responseStartedStage || null,
        vertoCallId: rtcAsrEvidence.evidenceCallId || null,
        accCallId: rtcAsrEvidence.accCallId || null,
        sipCallId: rtcAsrEvidence.sipCallId || null,
        proofSipCallId: rtcAsrEvidence.proofSipCallId || null,
        linkedSipCallId: rtcAsrEvidence.linkedSipCallId || null,
        correlationMode: rtcAsrEvidence.correlationMode || null,
        currentCallWindowStartedAt: new Date(this.startedAtMs).toISOString(),
      },
      blockers,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }
}

function runSelfTest() {
  const challenge = parseDigestChallenge('Digest realm="192.168.86.28", nonce="abc", algorithm=MD5, qop="auth"');
  const requestUri = "sip:8600@192.168.86.28:5060";
  const authorization = digestAuthorization({
    username: "1000",
    password: "local-sip-pass",
    method: "INVITE",
    uri: requestUri,
    challenge,
  });
  const sdpTarget = parseRtpTargetFromSdp("v=0\r\nc=IN IP4 127.0.0.1\r\nm=audio 29790 RTP/AVP 0\r\n", "fallback");
  const pcm = tonePcm16({ durationMs: 40 });
  const packets = ulawPacketsFromPcm(pcm, { ssrc: 1 });
  const loudIntroPcm = Buffer.alloc(160 * 2 * 10);
  for (let offset = 0; offset < loudIntroPcm.length; offset += 2) loudIntroPcm.writeInt16LE(5000, offset);
  const introObserver = new SipProofCall({});
  for (const packet of ulawPacketsFromPcm(loudIntroPcm, { ssrc: 2 })) {
    introObserver.handleRtp(packet, { address: "127.0.0.1", port: 1234 });
  }
  for (const packet of ulawPacketsFromPcm(Buffer.alloc(160 * 2 * 12), { ssrc: 2 })) {
    introObserver.handleRtp(packet, { address: "127.0.0.1", port: 1234 });
  }
  const responsePlayback = playbackAfterTimestamp([
    { receivedAtMs: Date.parse("2026-07-27T10:00:00.000Z"), pcm: Buffer.alloc(160 * 2) },
    ...Array.from({ length: 10 }, (_, index) => ({
      receivedAtMs: Date.parse("2026-07-27T10:00:01.000Z") + index * 20,
      pcm,
    })),
  ], "2026-07-27T10:00:00.500Z");
  const inferredLocalHost = resolveLocalHost({
    interfaces: {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [{ address: "192.168.86.28", family: "IPv4", internal: false }],
    },
  });
  let loopbackRejected = false;
  try {
    resolveLocalHost({ explicitHost: "127.0.0.1", interfaces: {} });
  } catch {
    loopbackRejected = true;
  }
  const authorizationUriReady = authorization.includes(`uri="${requestUri}"`);
  const ok = authorization.includes('username="1000"')
    && authorization.includes('response="')
    && authorizationUriReady
    && sdpTarget?.port === 29790
    && packets.length > 0
    && responsePlayback.packetCount === 10
    && responsePlayback.confirmed === true
    && Boolean(introObserver.observableIntroCompletedAt)
    && introObserver.introNonSilentPacketCount === 10
    && introObserver.introConsecutiveSilentPacketCount === 12
    && inferredLocalHost.host === "192.168.86.28"
    && loopbackRejected;
  console.log(JSON.stringify({
    ok,
    authorizationReady: authorization.includes("Digest "),
    authorizationUriReady,
    sdpTarget,
    packetCount: packets.length,
    responsePlayback,
    observableIntroCompletion: {
      completedAt: introObserver.observableIntroCompletedAt,
      nonSilentPacketCount: introObserver.introNonSilentPacketCount,
      consecutiveSilentPacketCount: introObserver.introConsecutiveSilentPacketCount,
    },
    inferredLocalHost,
    loopbackRejected,
  }, null, 2));
  return ok ? 0 : 2;
}

async function runCorrelationSelfTest() {
  const startedAtMs = Date.parse("2026-07-31T10:00:00.000Z");
  const unrelated = {
    callId: "other-call",
    sipCallId: "other-sip",
    stageEvents: [
      {
        stage: "stt.transcript_final",
        ok: true,
        transcript: "wrong call",
        timestamp: "2026-07-31T10:00:01.000Z",
      },
      {
        stage: "tts.stream_completed",
        ok: true,
        timestamp: "2026-07-31T10:00:02.000Z",
      },
    ],
  };
  const expected = {
    callId: "expected-verto",
    sipCallId: "expected-verto",
    linkedSipCallId: "expected-sip",
    stageEvents: [
      {
        stage: "stt.transcript_final",
        ok: true,
        transcript: "right call",
        timestamp: "2026-07-31T10:00:03.000Z",
      },
      {
        stage: "tts.stream_completed",
        ok: true,
        timestamp: "2026-07-31T10:00:04.000Z",
      },
    ],
  };
  const dir = await mkdtemp(path.join(process.cwd(), ".tmp-verto-correlation-"));
  const evidencePath = path.join(dir, "evidence.json");
  try {
    await writeFile(evidencePath, `${JSON.stringify({ pipelineEvidence: [unrelated] })}\n`, "utf8");
    const blocked = await loadRtcAsrEvidence(evidencePath, {
      startedAtMs,
      baselineCallIds: new Set(),
      expectedSipCallId: "expected-sip",
    });
    await writeFile(evidencePath, `${JSON.stringify({ pipelineEvidence: [unrelated, expected] })}\n`, "utf8");
    const correlated = await loadRtcAsrEvidence(evidencePath, {
      startedAtMs,
      baselineCallIds: new Set(),
      expectedSipCallId: "expected-sip",
    });
    const fallback = await loadRtcAsrEvidence(evidencePath, {
      startedAtMs,
      baselineCallIds: new Set(["baseline-call"]),
      expectedSipCallId: "",
    });
    const ok = blocked.ready === false
      && correlated.ready === true
      && correlated.transcript === "right call"
      && correlated.correlationMode === "expected_sip_call_id"
      && fallback.ready === true
      && fallback.transcript === "wrong call"
      && fallback.correlationMode === "fresh_non_baseline_current_window";
    console.log(JSON.stringify({ ok, blocked, correlated, fallback }, null, 2));
    return ok ? 0 : 2;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (hasFlag("--self-test")) return runSelfTest();
  if (hasFlag("--correlation-self-test")) return runCorrelationSelfTest();
  const remoteHost = argValue("--remote-host", process.env.FREESWITCH_SIP_HOST || "127.0.0.1");
  const remoteSipPort = Number(argValue("--remote-sip-port", process.env.FREESWITCH_SIP_PORT || "5060"));
  const localHostResolution = resolveLocalHost({
    explicitHost: argValue("--local-host", process.env.ACC_SIP_PROOF_LOCAL_HOST),
  });
  const localHost = localHostResolution.host;
  console.error(`[verto-sip-live-proof] advertising caller RTP on ${localHost} (${localHostResolution.source})`);
  const outDir = path.resolve(process.cwd(), argValue("--out-dir", `artifacts/verto-sip-live-${new Date().toISOString().replaceAll(":", "-")}`));
  const call = new SipProofCall({
    outDir,
    remoteHost,
    remoteSipPort,
    localHost,
    localBindHost: argValue("--local-bind-host", process.env.ACC_SIP_PROOF_LOCAL_BIND_HOST || "0.0.0.0"),
    localSipPort: Number(argValue("--local-sip-port", process.env.ACC_SIP_PROOF_LOCAL_SIP_PORT || "5094")),
    localRtpPort: Number(argValue("--local-rtp-port", process.env.ACC_SIP_PROOF_LOCAL_RTP_PORT || "6002")),
    username: argValue("--username", process.env.FREESWITCH_SIP_USERNAME || "1000"),
    password: argValue("--password", process.env.FREESWITCH_SIP_PASSWORD || "local-sip-pass"),
    domain: argValue("--domain", process.env.FREESWITCH_SIP_DOMAIN || remoteHost),
    destination: argValue("--destination", process.env.FREESWITCH_SIP_DESTINATION || "8600"),
    toneMs: Number(argValue("--tone-ms", "1800")),
    tailSilenceMs: Number(argValue("--tail-silence-ms", process.env.ACC_SIP_PROOF_TAIL_SILENCE_MS || "10000")),
    mediaDelayMs: Number(argValue("--media-delay-ms", process.env.ACC_SIP_PROOF_MEDIA_DELAY_MS || "1000")),
    introWaitTimeoutMs: Number(argValue("--intro-wait-timeout-ms", process.env.ACC_SIP_PROOF_INTRO_WAIT_TIMEOUT_MS || "8000")),
    callMs: Number(argValue("--call-ms", "10000")),
    frequency: Number(argValue("--frequency", "440")),
    callerAudioPath: argValue("--caller-audio", process.env.ACC_SIP_PROOF_CALLER_AUDIO),
    ssrc: Number(argValue("--ssrc", "11324962")),
    rtcAsrEvidencePath: argValue("--rtc-asr-evidence", process.env.RTC_ASR_EVIDENCE_PATH),
    accCallId: argValue("--acc-call-id", process.env.ACC_CALL_ID),
  });
  const manifest = await call.run();
  console.log(JSON.stringify({
    manifest: path.join(outDir, "verto-sip-live-proof-manifest.json"),
    reviewReady: manifest.reviewReady,
    blockers: manifest.blockers,
    callerPlaybackConfirmed: manifest.callerPlaybackEvidence.callerPlaybackConfirmed,
    callerPlaybackPackets: manifest.callerPlaybackEvidence.packetCount,
  }, null, 2));
  if (hasFlag("--require-review-ready") && !manifest.reviewReady) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
