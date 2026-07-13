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

async function inspectCallerPlaybackEvidence(filePath, stats) {
  if (!filePath) return { ready: false };
  if (!stats || stats.size === 0) {
    return {
      ready: false,
      blocker: "Caller-audible playback proof path was attached, but the artifact is missing or empty.",
      nextAction: "Write the caller-audible playback proof artifact before marking the FreeSWITCH proof review-ready.",
    };
  }
  const evidence = parseJsonOrJsonLines(await readFile(filePath, "utf8")).flatMap(expandEvidenceEntries);
  if (evidence.length === 0) {
    return {
      ready: false,
      blocker: "Caller-audible playback proof artifact is not valid JSON.",
      nextAction: "Write valid caller-audible playback proof JSON before marking the FreeSWITCH proof review-ready.",
    };
  }
  if (!evidence.some(hasCallerPlaybackConfirmation)) {
    return {
      ready: false,
      blocker: "Caller-audible playback proof does not contain playback-specific confirmation.",
      nextAction: "Attach caller-audible playback proof with callerPlaybackConfirmed, caller_playback_confirmed, or status \"caller_playback_confirmed\" before marking the FreeSWITCH proof review-ready.",
    };
  }
  return { ready: true, eventCount: evidence.length };
}

async function resetRtcAsrEvidence(filePath) {
  if (!filePath) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "", "utf8");
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

function hasCallerPlaybackConfirmation(entry) {
  return nestedEvidenceObjects(entry).some((candidate) =>
    candidate?.callerPlaybackConfirmed === true ||
    candidate?.caller_playback_confirmed === true ||
    candidate?.status === "caller_playback_confirmed"
  );
}

function nestedEvidenceObjects(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return [];
  const children = Array.isArray(value) ? value : Object.values(value);
  return [value, ...children.flatMap((child) => nestedEvidenceObjects(child, depth + 1))];
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


function latestAgentText(callPayload) {
  const transcript = Array.isArray(callPayload?.call?.transcript)
    ? callPayload.call.transcript
    : Array.isArray(callPayload?.transcript)
      ? callPayload.transcript
      : [];
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const turn = transcript[index];
    if (turn?.speaker === "agent" && typeof turn.text === "string" && turn.text.trim()) return turn.text.trim();
  }
  return "";
}

async function postRawJson(url, body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": rawBody.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, contentType: res.headers["content-type"] ?? "application/octet-stream", body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

function pcm16MonoFromWav(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("kokoro_wav_invalid");
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      format = {
        audioFormat: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4),
        bitsPerSample: wav.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data) throw new Error("kokoro_wav_missing_chunks");
  if (format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) throw new Error("kokoro_wav_not_pcm16_mono");
  return { pcm16: data, sampleRateHz: format.sampleRate };
}

function downsamplePcm16MonoTo8k(pcm16, sampleRateHz) {
  if (sampleRateHz === 8000) return pcm16;
  if (!Number.isInteger(sampleRateHz) || sampleRateHz < 8000 || sampleRateHz % 8000 !== 0) throw new Error("kokoro_sample_rate_not_8khz_compatible");
  const ratio = sampleRateHz / 8000;
  const sourceSamples = pcm16.length / 2;
  const targetSamples = Math.floor(sourceSamples / ratio);
  const target = Buffer.alloc(targetSamples * 2);
  for (let index = 0; index < targetSamples; index += 1) {
    target.writeInt16LE(pcm16.readInt16LE(Math.floor(index * ratio) * 2), index * 2);
  }
  return target;
}

function pcm16MonoWav(pcm16, sampleRateHz = 8000) {
  if (!Buffer.isBuffer(pcm16) || pcm16.length === 0 || pcm16.length % 2 !== 0) throw new Error("pcm16_payload_invalid");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([header, pcm16]);
}

function visiblePlaybackPath(recordingDir, freeswitchRecordingDir, uuid) {
  const filename = String(uuid) + "-kokoro-tts-" + Date.now() + ".wav";
  const hostPath = path.join(recordingDir, filename);
  const freeswitchPath = freeswitchRecordingDir ? path.posix.join(freeswitchRecordingDir, filename) : hostPath;
  return { hostPath, freeswitchPath };
}

function decodeKokoroAudioResponse(response) {
  const contentType = String(response.contentType ?? "").toLowerCase();
  if (contentType.includes("json")) {
    const payload = JSON.parse(response.body.toString("utf8"));
    let encoded = payload.audio_base64 ?? payload.audioContent ?? payload.audio ?? payload.data;
    if (encoded && typeof encoded === "object") encoded = encoded.base64 ?? encoded.audio_base64;
    if (typeof encoded !== "string" || !encoded) throw new Error("kokoro_json_audio_missing");
    const audio = Buffer.from(encoded, "base64");
    const responseFormat = String(payload.format ?? payload.response_format ?? "wav").toLowerCase();
    const sampleRateHz = Number(payload.sample_rate ?? payload.sampleRate ?? 8000);
    if (responseFormat === "wav" || audio.toString("ascii", 0, 4) === "RIFF") return pcm16MonoFromWav(audio);
    return { pcm16: audio, sampleRateHz };
  }
  if (response.body.toString("ascii", 0, 4) === "RIFF") return pcm16MonoFromWav(response.body);
  return { pcm16: response.body, sampleRateHz: 8000 };
}

export async function synthesizeKokoroTtsFrame(text, options = {}) {
  if (!text || !String(text).trim()) throw new Error("kokoro_tts_text_missing");
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:8880";
  const speechPath = options.speechPath ?? "/v1/audio/speech";
  const url = new URL(speechPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  const response = await postRawJson(url, {
    model: options.model ?? "kokoro",
    voice: options.voice ?? "af_heart",
    input: String(text),
    response_format: "wav",
    sample_rate: 8000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`kokoro_tts_http_${response.statusCode}`);
  const decoded = decodeKokoroAudioResponse(response);
  const pcm16 = downsamplePcm16MonoTo8k(decoded.pcm16, decoded.sampleRateHz);
  return {
    frameType: "TTSAudioRawFrame",
    audioFormat: "pcm_s16le",
    sampleRateHz: 8000,
    channels: 1,
    pcm16Base64: pcm16.toString("base64"),
    sourceText: String(text),
    tts: { engine: "kokoro", voice: options.voice ?? "af_heart", model: options.model ?? "kokoro", sourceSampleRateHz: decoded.sampleRateHz, outputSampleRateHz: 8000, audioBytes: pcm16.length },
  };
}

function outputAudioFrameDurationMs(frame) {
  const sampleRateHz = Number(frame?.sampleRateHz ?? 8000) || 8000;
  const pcm16 = Buffer.from(frame?.pcm16Base64 ?? "", "base64");
  return (pcm16.length / 2 / sampleRateHz) * 1000;
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

function upsamplePcm16Mono8kTo16k(pcm16) {
  if (!Buffer.isBuffer(pcm16) || pcm16.length === 0 || pcm16.length % 2 !== 0) {
    throw new Error("pcm16_payload_invalid");
  }
  const upsampled = Buffer.alloc(pcm16.length * 2);
  for (let sourceOffset = 0; sourceOffset < pcm16.length; sourceOffset += 2) {
    const sample = pcm16.readInt16LE(sourceOffset);
    const targetOffset = sourceOffset * 2;
    upsampled.writeInt16LE(sample, targetOffset);
    upsampled.writeInt16LE(sample, targetOffset + 2);
  }
  return upsampled;
}

function pipecatInputFrameSummaryToLocalSttPcm16(frame) {
  if (frame?.frameType !== "InputAudioRawFrame") throw new Error("pipecat_frame_type_not_input_audio");
  if (frame.audioFormat !== "pcm_s16le" || frame.sampleRateHz !== 8000 || frame.channels !== 1) {
    throw new Error("pipecat_input_audio_format_not_pcm16_8khz_mono");
  }
  return upsamplePcm16Mono8kTo16k(Buffer.from(frame.pcm16Base64 ?? "", "base64"));
}

export class RtcAsrPipecatStreamSink {
  constructor(options = {}) {
    this.options = {
      url: options.url,
      WebSocketImpl: options.WebSocketImpl ?? globalThis.WebSocket,
      evidencePath: options.evidencePath,
      clientStreamId: options.clientStreamId ?? `freeswitch-${Date.now()}`,
      partialIntervalMs: options.partialIntervalMs ?? 100,
      partialWindowSeconds: options.partialWindowSeconds ?? 1.5,
      maxBufferSeconds: options.maxBufferSeconds ?? 10,
    };
    this.events = [];
    this.errors = [];
    this.audioChunks = 0;
    this.audioBytes = 0;
  }

  async transcribeFrameBatch(batch, metadata = {}) {
    if (!this.options.url) return this.summary("blocked", "rtc_asr_url_missing");
    if (!this.options.WebSocketImpl) return this.summary("blocked", "websocket_client_unavailable");
    const frames = Array.isArray(batch?.frames) ? batch.frames : [];
    if (frames.length === 0) return this.summary("blocked", "pipecat_input_frame_batch_empty");

    const ws = new this.options.WebSocketImpl(this.options.url);
    await this.waitForOpen(ws);
    ws.send(JSON.stringify({
      type: "start",
      version: "local-stt.v1",
      audio: { sample_rate: 16000, channels: 1, format: "pcm_s16le", frame_ms: 20, bytes_per_frame: 640 },
      language: "en",
      interim_results: true,
      partial_interval_ms: this.options.partialIntervalMs,
      partial_window_seconds: this.options.partialWindowSeconds,
      max_buffer_seconds: this.options.maxBufferSeconds,
      client_stream_id: this.options.clientStreamId,
      metadata: { source: "freeswitch_rtp_pipecat", ...metadata },
    }));

    for (const frame of frames) {
      const audio = pipecatInputFrameSummaryToLocalSttPcm16(frame);
      ws.send(audio);
      this.audioChunks += 1;
      this.audioBytes += audio.length;
    }
    ws.send(JSON.stringify({ type: "finalize" }));
    await this.collectUntilFinal(ws);
    if (typeof ws.close === "function") ws.close(1000, "freeswitch_rtc_asr_complete");
    await this.writeEvidence();
    return this.summary(this.hasFinalTranscript() ? "ready" : "blocked", this.hasFinalTranscript() ? null : "rtc_asr_final_transcript_missing");
  }

  waitForOpen(ws) {
    if (ws.readyState === 1 || ws.readyState === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("rtc_asr_websocket_open_timeout")), 5000);
      this.addWsListener(ws, "open", () => { clearTimeout(timeout); resolve(); });
      this.addWsListener(ws, "error", (error) => { clearTimeout(timeout); reject(error instanceof Error ? error : new Error(String(error))); });
    });
  }

  collectUntilFinal(ws) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 10000);
      this.addWsListener(ws, "message", (message) => {
        const event = parseRtcAsrMessage(message);
        if (!event) return;
        this.events.push(event);
        if (isFinalTranscriptEvidence(event)) {
          clearTimeout(timeout);
          resolve();
        }
      });
      this.addWsListener(ws, "error", (error) => {
        clearTimeout(timeout);
        this.errors.push({ at: nowIso(), error: error instanceof Error ? error.message : String(error) });
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      this.addWsListener(ws, "close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  addWsListener(ws, eventName, handler) {
    if (typeof ws.addEventListener === "function") ws.addEventListener(eventName, (event) => handler(event?.data ?? event));
    else if (typeof ws.on === "function") ws.on(eventName, handler);
    else ws[`on${eventName}`] = handler;
  }

  hasFinalTranscript() {
    return this.events.some(isFinalTranscriptEvidence) && this.events.flatMap(transcriptFragments).join(" ").trim().length > 0;
  }

  async writeEvidence() {
    if (!this.options.evidencePath) return;
    await mkdir(path.dirname(this.options.evidencePath), { recursive: true });
    const lines = this.events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(this.options.evidencePath, lines ? `${lines}\n` : "", "utf8");
  }

  summary(readiness = this.hasFinalTranscript() ? "ready" : "blocked", reason = null) {
    return {
      readiness,
      url: this.options.url ?? null,
      evidencePath: this.options.evidencePath ?? null,
      protocol: "local-stt.v1",
      inputAudioFormat: "pcm_s16le_8khz_mono_pipecat_frames",
      streamedAudioFormat: "pcm_s16le_16khz_mono_binary_ws",
      audioChunks: this.audioChunks,
      audioBytes: this.audioBytes,
      eventCount: this.events.length,
      finalTranscriptReady: this.hasFinalTranscript(),
      reason,
      errors: this.errors,
    };
  }
}

function parseRtcAsrMessage(message) {
  const raw = Buffer.isBuffer(message) ? message.toString("utf8") : typeof message === "string" ? message : message?.data;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function encodePcm16SampleToPcmu(sample) {
  const clipped = Math.max(-32635, Math.min(32635, sample));
  const sign = clipped < 0 ? 0x80 : 0x00;
  const magnitude = Math.abs(clipped) + 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (magnitude & mask) === 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function encodePcm16ToPcmu(pcm16) {
  if (!Buffer.isBuffer(pcm16) || pcm16.length === 0 || pcm16.length % 2 !== 0) {
    throw new Error("pcm16_payload_invalid");
  }
  const pcmu = Buffer.alloc(pcm16.length / 2);
  for (let offset = 0; offset < pcm16.length; offset += 2) {
    pcmu[offset / 2] = encodePcm16SampleToPcmu(pcm16.readInt16LE(offset));
  }
  return pcmu;
}

export function pipecatOutputFrameSummaryToRtpPcmuPackets(frame, options = {}) {
  if (frame?.frameType !== "OutputAudioRawFrame" && frame?.frameType !== "TTSAudioRawFrame") throw new Error("pipecat_frame_type_not_output_audio");
  if (frame.audioFormat !== "pcm_s16le" || frame.sampleRateHz !== 8000 || frame.channels !== 1) {
    throw new Error("pipecat_audio_format_not_pcm16_8khz_mono");
  }
  const pcm16 = Buffer.isBuffer(frame.pcm16)
    ? frame.pcm16
    : Buffer.from(frame.pcm16Base64 ?? "", "base64");
  const samplesPerPacket = options.samplesPerPacket ?? 160;
  if (!Number.isInteger(samplesPerPacket) || samplesPerPacket <= 0) throw new Error("rtp_samples_per_packet_invalid");

  const pcmu = encodePcm16ToPcmu(pcm16);
  const packets = [];
  for (let payloadOffset = 0; payloadOffset < pcmu.length; payloadOffset += samplesPerPacket) {
    const payload = pcmu.subarray(payloadOffset, payloadOffset + samplesPerPacket);
    const packet = Buffer.alloc(12 + payload.length);
    packet[0] = 0x80;
    packet[1] = options.markerFirstPacket === true && packets.length === 0 ? 0x80 : 0x00;
    packet.writeUInt16BE(((options.sequenceNumber ?? 0) + packets.length) & 0xffff, 2);
    packet.writeUInt32BE(((options.timestamp ?? 0) + payloadOffset) >>> 0, 4);
    packet.writeUInt32BE((options.ssrc ?? 0xacc0ffee) >>> 0, 8);
    payload.copy(packet, 12);
    packets.push(packet);
  }
  return packets;
}

export class PipecatRtpPlaybackSink {
  constructor(options = {}) {
    this.options = {
      remoteHost: options.remoteHost ?? "127.0.0.1",
      remotePort: options.remotePort,
      sequenceNumber: options.sequenceNumber ?? 0,
      timestamp: options.timestamp ?? 0,
      ssrc: options.ssrc ?? 0xacc0ffee,
      samplesPerPacket: options.samplesPerPacket ?? 160,
    };
    this.packetCount = 0;
    this.sentPacketCount = 0;
    this.audioDurationMs = 0;
    this.errors = [];
    this.lastPacket = null;
    this.lastSentAt = null;
  }

  packetize(frame) {
    try {
      const packets = pipecatOutputFrameSummaryToRtpPcmuPackets(frame, {
        sequenceNumber: this.options.sequenceNumber,
        timestamp: this.options.timestamp,
        ssrc: this.options.ssrc,
        samplesPerPacket: this.options.samplesPerPacket,
        markerFirstPacket: this.packetCount === 0,
      });
      this.options.sequenceNumber = (this.options.sequenceNumber + packets.length) & 0xffff;
      this.options.timestamp = (this.options.timestamp + packets.reduce((total, packet) => total + packet.length - 12, 0)) >>> 0;
      this.packetCount += packets.length;
      this.audioDurationMs += packets.reduce((total, packet) => total + ((packet.length - 12) / 8000) * 1000, 0);
      this.lastPacket = packets.at(-1) ?? this.lastPacket;
      return packets;
    } catch (error) {
      this.errors.push({ at: nowIso(), error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  async sendFrame(socket, frame) {
    const packets = this.packetize(frame);
    if (packets.length === 0) return packets;
    if (!this.options.remotePort) {
      this.errors.push({ at: nowIso(), error: "rtp_playback_remote_port_missing" });
      return [];
    }
    const packetIntervalMs = (this.options.samplesPerPacket / 8000) * 1000;
    for (const [index, packet] of packets.entries()) {
      if (index > 0) await sleep(packetIntervalMs);
      await new Promise((resolve) => {
        socket.send(packet, this.options.remotePort, this.options.remoteHost, (error) => {
          if (error) this.errors.push({ at: nowIso(), error: error instanceof Error ? error.message : String(error) });
          else {
            this.sentPacketCount += 1;
            this.lastSentAt = nowIso();
          }
          resolve();
        });
      });
    }
    return packets;
  }

  summary() {
    return {
      outboundRtpReady: this.packetCount > 0,
      frameType: "OutputAudioRawFrame|TTSAudioRawFrame",
      audioFormat: "pcm_s16le",
      sampleRateHz: 8000,
      channels: 1,
      packetCount: this.packetCount,
      sentPacketCount: this.sentPacketCount,
      rtpSocketSendReady: this.sentPacketCount > 0,
      totalDurationMs: this.audioDurationMs,
      nextSequenceNumber: this.options.sequenceNumber,
      nextTimestamp: this.options.timestamp,
      ssrc: this.options.ssrc,
      remoteHost: this.options.remoteHost,
      remotePort: this.options.remotePort ?? null,
      lastSentAt: this.lastSentAt,
      errors: this.errors,
    };
  }

}

export async function loadPipecatOutputFrameSummaries(filePath) {
  if (!filePath) return [];
  const entries = parseJsonOrJsonLines(await readFile(filePath, "utf8"));
  return entries.flatMap((entry) => {
    const frame = entry?.frame ?? entry?.payload ?? entry;
    if (frame?.frameType !== "OutputAudioRawFrame" && frame?.frameType !== "TTSAudioRawFrame") return [];
    return [frame];
  });
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

export async function pipecatInputFrameBatchFromWav(filePath, options = {}) {
  const { pcm16, sampleRateHz } = pcm16MonoFromWav(await readFile(filePath));
  const pcm16At8k = downsamplePcm16MonoTo8k(pcm16, sampleRateHz);
  const samplesPerFrame = options.samplesPerFrame ?? 160;
  const bytesPerFrame = samplesPerFrame * 2;
  const maxFrames = options.maxFrames ?? 200;
  const startOffsetMs = Math.max(0, Number(options.startOffsetMs ?? 0) || 0);
  const startByteOffset = Math.min(pcm16At8k.length, Math.floor((startOffsetMs / 1000) * 8000) * 2);
  const alignedStartOffset = Math.floor(startByteOffset / bytesPerFrame) * bytesPerFrame;
  const sourceFrameCount = Math.floor(pcm16At8k.length / bytesPerFrame);
  const alignedStartFrameIndex = Math.floor(alignedStartOffset / bytesPerFrame);
  const frames = [];
  for (let offset = alignedStartOffset; offset + bytesPerFrame <= pcm16At8k.length && frames.length < maxFrames; offset += bytesPerFrame) {
    const index = frames.length;
    frames.push({
      frameType: "InputAudioRawFrame",
      audioFormat: "pcm_s16le",
      sampleRateHz: 8000,
      channels: 1,
      sequenceNumber: index,
      timestamp: index * samplesPerFrame,
      durationMs: (samplesPerFrame / 8000) * 1000,
      receivedAt: options.receivedAt ?? nowIso(),
      pcm16Base64: pcm16At8k.subarray(offset, offset + bytesPerFrame).toString("base64"),
      source: "freeswitch_recording_wav",
      sourceStartOffsetMs: startOffsetMs,
    });
  }
  const sourceDurationMs = (pcm16At8k.length / 2 / 8000) * 1000;
  const errors = [];
  if (frames.length === 0 && pcm16At8k.length > 0) {
    errors.push({
      at: options.receivedAt ?? nowIso(),
      error: "wav_fallback_start_offset_exhausted_recording",
      source: "freeswitch_recording_wav",
      sourceDurationMs,
      sourceStartOffsetMs: startOffsetMs,
    });
  }
  return {
    liveRtpCaptured: false,
    frameType: "InputAudioRawFrameBatch",
    audioFormat: "pcm_s16le",
    sampleRateHz: 8000,
    channels: 1,
    packetCount: frames.length,
    totalDurationMs: frames.reduce((total, frame) => total + frame.durationMs, 0),
    sequenceGaps: [],
    errors,
    captureSource: "freeswitch_recording_wav",
    sourceSampleRateHz: sampleRateHz,
    sourceDurationMs,
    sourceFrameCount,
    sourceStartOffsetMs: startOffsetMs,
    alignedSourceStartOffsetMs: (alignedStartOffset / 2 / 8000) * 1000,
    sourceFramesSkipped: Math.min(alignedStartFrameIndex, sourceFrameCount),
    frames,
  };
}

export function wavFallbackStartOffsetMs(call) {
  const greetingDurationMs = playbackHasCompleteFreeswitchBroadcastEvidence(call) ? Math.max(0, Number(call?.initialGreetingPlaybackDurationMs ?? 0) || 0) : 0;
  const recordingStartedAtMs = Number(call?.recordingStartedAtMs ?? call?.startedAt ?? 0) || 0;
  const broadcastIssuedAtMs = Number(call?.freeswitchBroadcast?.issuedAtMs ?? 0) || 0;
  const broadcastStartDelayMs = recordingStartedAtMs > 0 && broadcastIssuedAtMs > recordingStartedAtMs
    ? broadcastIssuedAtMs - recordingStartedAtMs
    : 0;
  return broadcastStartDelayMs + greetingDurationMs;
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

function firstHeader(headers, names) {
  for (const name of names) {
    const value = headers.get(name);
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

export function remoteRtpFromHeaders(headers) {
  const address = firstHeader(headers, [
    "variable_remote_media_ip",
    "variable_rtp_remote_audio_ip",
    "Remote-Media-IP",
    "RTP-Remote-Audio-IP",
  ]);
  const rawPort = firstHeader(headers, [
    "variable_remote_media_port",
    "variable_rtp_remote_audio_port",
    "Remote-Media-Port",
    "RTP-Remote-Audio-Port",
  ]);
  const port = Number(rawPort);
  if (!address || !Number.isInteger(port) || port <= 0 || port > 65535) {
    const sdp = firstHeader(headers, [
      "variable_switch_r_sdp",
      "variable_rtp_remote_sdp",
      "variable_remote_sdp",
      "Remote-SDP",
    ]);
    return remoteRtpFromSdp(sdp);
  }
  return { address, port };
}

export function remoteRtpFromSdp(sdp) {
  if (!sdp || typeof sdp !== "string") return null;
  const rawSdp = sdp.includes("%0A") || sdp.includes("%0D") ? decodeHeaderValue(sdp) : sdp;
  const lines = rawSdp.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const audio = lines.find((line) => line.startsWith("m=audio "));
  const connection = lines.find((line) => line.startsWith("c=IN IP4 ") || line.startsWith("c=IN IP6 "));
  const port = Number(audio?.split(/\s+/)[1]);
  const address = connection?.split(/\s+/)[2];
  if (!address || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { address, port };
}

function playbackTargetMatchesCallerRtp(remoteRtp, playbackEvidence) {
  if (!remoteRtp || !playbackEvidence) return false;
  return playbackEvidence.remoteHost === remoteRtp.address && playbackEvidence.remotePort === remoteRtp.port;
}

function playbackHasCallerAudibleProof(playbackEvidence, broadcastStats = null, callerPlaybackEvidenceInspection = null) {
  const hasEvidencePath = typeof playbackEvidence?.callerPlaybackEvidencePath === "string" && playbackEvidence.callerPlaybackEvidencePath.trim().length > 0;
  const hasSocketSend = playbackEvidence?.rtpSocketSendReady === true;
  const hasBroadcast = playbackHasVerifiedFreeswitchBroadcastEvidence(playbackEvidence, broadcastStats);
  return playbackEvidence?.callerPlaybackConfirmed === true && hasEvidencePath && callerPlaybackEvidenceInspection?.ready === true && (hasSocketSend || hasBroadcast);
}

function playbackHasCompleteFreeswitchBroadcastEvidence(playbackEvidence) {
  const broadcast = playbackEvidence?.freeswitchBroadcast;
  const hasHostPath = typeof broadcast?.hostPath === "string" && broadcast.hostPath.trim().length > 0;
  const hasFreeswitchPath = typeof broadcast?.freeswitchPath === "string" && broadcast.freeswitchPath.trim().length > 0;
  const hasAudioBytes = Number.isFinite(broadcast?.audioBytes) && broadcast.audioBytes > 0;
  return broadcast?.mode === "freeswitch_uuid_broadcast" && hasHostPath && hasFreeswitchPath && hasAudioBytes;
}

function playbackHasVerifiedFreeswitchBroadcastEvidence(playbackEvidence, broadcastStats = null) {
  return playbackHasCompleteFreeswitchBroadcastEvidence(playbackEvidence) && Boolean(broadcastStats && broadcastStats.size > 0);
}

function playbackHasPacketizedEvidence(playbackEvidence) {
  return playbackEvidence?.outboundRtpReady === true && Number.isFinite(playbackEvidence?.packetCount) && playbackEvidence.packetCount > 0;
}

function callerPlaybackEvidencePath(playbackEvidence) {
  const evidencePath = playbackEvidence?.callerPlaybackEvidencePath;
  return typeof evidencePath === "string" && evidencePath.trim().length > 0 ? evidencePath : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const pipecatOutboundRtpEvidence = options.pipecatOutboundRtpEvidence ?? null;
  const callerPlaybackPath = callerPlaybackEvidencePath(pipecatOutboundRtpEvidence);
  const callerPlaybackStats = callerPlaybackPath ? await stat(callerPlaybackPath).catch(() => null) : null;
  const callerPlaybackEvidenceInspection = await inspectCallerPlaybackEvidence(callerPlaybackPath, callerPlaybackStats);
  const broadcastHostPath = typeof pipecatOutboundRtpEvidence?.freeswitchBroadcast?.hostPath === "string"
    ? pipecatOutboundRtpEvidence.freeswitchBroadcast.hostPath.trim()
    : "";
  const broadcastStats = broadcastHostPath ? await stat(broadcastHostPath).catch(() => null) : null;
  const outboundPlaybackTargetMatchedCallerRtp = playbackTargetMatchesCallerRtp(options.remoteRtp, pipecatOutboundRtpEvidence);
  const outboundBroadcastPlaybackAttempted = pipecatOutboundRtpEvidence?.freeswitchBroadcast?.mode === "freeswitch_uuid_broadcast";
  const outboundBroadcastEvidenceComplete = playbackHasVerifiedFreeswitchBroadcastEvidence(pipecatOutboundRtpEvidence, broadcastStats);
  const outboundSocketPlaybackReviewReady =
    pipecatOutboundRtpEvidence?.rtpSocketSendReady === true &&
    outboundPlaybackTargetMatchedCallerRtp &&
    playbackHasCallerAudibleProof(pipecatOutboundRtpEvidence, broadcastStats, callerPlaybackEvidenceInspection);
  const outboundBroadcastReviewReady =
    outboundBroadcastPlaybackAttempted &&
    outboundBroadcastEvidenceComplete &&
    playbackHasPacketizedEvidence(pipecatOutboundRtpEvidence) &&
    playbackHasCallerAudibleProof(pipecatOutboundRtpEvidence, broadcastStats, callerPlaybackEvidenceInspection);
  const outboundPlaybackReviewReady = outboundSocketPlaybackReviewReady || outboundBroadcastReviewReady;
  const callerPlaybackProofBlocker = callerPlaybackPath && callerPlaybackEvidenceInspection.blocker
    ? callerPlaybackEvidenceInspection.blocker
    : null;
  const callerPlaybackProofNextAction = callerPlaybackPath && callerPlaybackEvidenceInspection.nextAction
    ? callerPlaybackEvidenceInspection.nextAction
    : null;
  const outboundPlaybackBlocker = outboundPlaybackReviewReady
    ? null
    : outboundBroadcastPlaybackAttempted && !outboundBroadcastEvidenceComplete
      ? "FreeSWITCH uuid_broadcast playback evidence is incomplete: host path, FreeSWITCH path, positive audio byte count, and a readable broadcast WAV artifact are required."
      : outboundBroadcastPlaybackAttempted && !playbackHasPacketizedEvidence(pipecatOutboundRtpEvidence)
        ? "FreeSWITCH uuid_broadcast playback evidence is missing packetized Pipecat/Kokoro RTP evidence."
        : callerPlaybackProofBlocker
          ? callerPlaybackProofBlocker
        : outboundBroadcastPlaybackAttempted
          ? "FreeSWITCH uuid_broadcast playback was issued, but no caller-audible playback proof is attached."
          : pipecatOutboundRtpEvidence?.rtpSocketSendReady
            ? outboundPlaybackTargetMatchedCallerRtp
              ? "Pipecat/Kokoro TTSAudioRawFrame output was sent to the caller RTP target, but no caller-audible playback proof is attached."
              : "Pipecat/Kokoro TTSAudioRawFrame output was sent, but not to the discovered FreeSWITCH caller RTP target."
            : pipecatOutboundRtpEvidence?.outboundRtpReady
              ? "Kokoro/Pipecat output and TTSAudioRawFrame fixtures can be packetized as RTP, but they have not been sent to a FreeSWITCH caller RTP target yet."
              : "Kokoro/Pipecat TTSAudioRawFrame output is not yet connected to the FreeSWITCH RTP playback socket for SIP caller playback.";
  const rtcAsrStreamEvidence = options.rtcAsrStreamEvidence ?? null;
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
  if (!pipecatOutboundRtpEvidence?.rtpSocketSendReady && !outboundBroadcastPlaybackAttempted) {
    blockers.push("FreeSWITCH caller playback RTP was not sent, so SIP bidirectional playback is not proven.");
  } else if (outboundBroadcastPlaybackAttempted && !outboundBroadcastEvidenceComplete) {
    blockers.push("FreeSWITCH uuid_broadcast playback evidence is incomplete: host path, FreeSWITCH path, positive audio byte count, and a readable broadcast WAV artifact are required.");
  } else if (outboundBroadcastPlaybackAttempted && !playbackHasPacketizedEvidence(pipecatOutboundRtpEvidence)) {
    blockers.push("FreeSWITCH uuid_broadcast playback evidence is missing packetized Pipecat/Kokoro RTP evidence.");
  } else if (pipecatOutboundRtpEvidence?.rtpSocketSendReady === true && !outboundPlaybackTargetMatchedCallerRtp && !outboundBroadcastReviewReady) {
    blockers.push("FreeSWITCH caller playback RTP was sent, but the playback target did not match the caller RTP target.");
  } else if (!playbackHasCallerAudibleProof(pipecatOutboundRtpEvidence, broadcastStats, callerPlaybackEvidenceInspection)) {
    blockers.push(
      callerPlaybackProofBlocker
        ? callerPlaybackProofBlocker
        : outboundBroadcastPlaybackAttempted
        ? "FreeSWITCH uuid_broadcast playback was issued, but no caller-audible playback proof is attached."
        : "FreeSWITCH caller playback RTP was sent to the caller target, but no caller-audible playback proof is attached.",
    );
  }

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
  if (!pipecatOutboundRtpEvidence?.rtpSocketSendReady && !outboundBroadcastPlaybackAttempted) {
    nextActions.push("Send Kokoro/Pipecat RTP playback to the FreeSWITCH caller target before marking the proof review-ready.");
  } else if (outboundBroadcastPlaybackAttempted && !outboundBroadcastEvidenceComplete) {
    nextActions.push("Attach complete FreeSWITCH uuid_broadcast playback evidence with host path, FreeSWITCH path, positive audio byte count, and a readable broadcast WAV artifact before marking the proof review-ready.");
  } else if (pipecatOutboundRtpEvidence?.rtpSocketSendReady === true && !outboundPlaybackTargetMatchedCallerRtp && !outboundBroadcastReviewReady) {
    nextActions.push("Discover the caller RTP target from FreeSWITCH media headers and send playback RTP to that target.");
  } else if (!playbackHasCallerAudibleProof(pipecatOutboundRtpEvidence, broadcastStats, callerPlaybackEvidenceInspection)) {
    nextActions.push(
      callerPlaybackProofNextAction
        ? callerPlaybackProofNextAction
        : outboundBroadcastPlaybackAttempted
        ? "Attach caller-audible playback proof for the FreeSWITCH uuid_broadcast path before marking the proof review-ready."
        : "Attach caller-audible playback proof, such as a softphone capture/check artifact, before marking the proof review-ready.",
    );
  }

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
  if (callerPlaybackPath) {
    artifactIntegrity.push({
      artifactId: "caller-audible-playback-proof",
      kind: "playback_evidence",
      path: callerPlaybackPath,
      sha256: callerPlaybackStats ? await sha256File(callerPlaybackPath) : null,
      sizeBytes: callerPlaybackStats?.size ?? 0,
      readiness: callerPlaybackEvidenceInspection.ready ? "ready" : "blocked",
    });
  }
  if (outboundBroadcastPlaybackAttempted && broadcastHostPath) {
    artifactIntegrity.push({
      artifactId: "freeswitch-uuid-broadcast-wav",
      kind: "playback_media",
      path: broadcastHostPath,
      freeswitchPath: pipecatOutboundRtpEvidence.freeswitchBroadcast.freeswitchPath ?? null,
      sha256: broadcastStats ? await sha256File(broadcastHostPath) : null,
      sizeBytes: broadcastStats?.size ?? 0,
      readiness: broadcastStats && broadcastStats.size > 0 ? "ready" : "blocked",
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
      remoteRtp: options.remoteRtp ?? null,
      hostRecordingPath: options.wavPath,
      freeswitchRecordingPath: options.freeswitchRecordingPath ?? options.wavPath,
    },
    pipecatMediaEngine: {
      liveRtpAdapter: pipecatRtpEvidence?.liveRtpCaptured ? "captured_pcmu_to_input_audio_frames" : "not_connected",
      realtimeDirection: pipecatOutboundRtpEvidence?.outboundRtpReady
        ? "sip_rtp_inbound_to_pipecat_input_frames_and_output_frames_to_rtp_packets"
        : "sip_rtp_inbound_to_pipecat_input_frames",
      outboundPlaybackAdapter: pipecatOutboundRtpEvidence?.outboundRtpReady ? "packetized_output_audio_frames_to_pcmu_rtp" : "not_connected",
      bidirectionalPlaybackReady: outboundPlaybackReviewReady,
      blocker: outboundPlaybackBlocker,
      rtpFrameBatch: pipecatRtpEvidence,
      rtcAsrLiveStream: rtcAsrStreamEvidence,
      outboundRtpPlayback: pipecatOutboundRtpEvidence
        ? { ...pipecatOutboundRtpEvidence, targetMatchedCallerRtp: outboundPlaybackTargetMatchedCallerRtp }
        : null,
    },
    artifacts: { audioWav: options.wavPath, sipLog: options.logPath, rtcAsrEvidence: options.rtcAsrEvidencePath ?? null, callerPlaybackEvidence: callerPlaybackPath },
    artifactIntegrity,
    reviewReady:
      blockers.length === 0 &&
      runtimeModeLabels.telephony === "local_sip" &&
      rtcAsrEvidenceInspection.ready &&
      outboundPlaybackReviewReady &&
      callerPlaybackEvidenceInspection.ready &&
      !generatedMedia,
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
    this.currentRtpCallUuid = null;
    this.rtpCollector = this.createRtpCollector();
    this.rtpPlaybackSink = this.createRtpPlaybackSink();
    this.pipecatOutputFixturePlayed = false;
    this.pipecatPlaybackEventPosted = false;
    this.pipecatPlaybackEventSignature = null;
    this.freeswitchBroadcast = null;
  }

  createRtpPlaybackSink() {
    return new PipecatRtpPlaybackSink({
      remoteHost: this.options.rtpPlaybackHost ?? "127.0.0.1",
      remotePort: this.options.rtpPlaybackPort,
      sequenceNumber: this.options.rtpPlaybackSequenceNumber ?? 0,
      timestamp: this.options.rtpPlaybackTimestamp ?? 0,
      ssrc: this.options.rtpPlaybackSsrc ?? 0xacc0ffee,
      samplesPerPacket: this.options.rtpPlaybackSamplesPerPacket ?? 160,
    });
  }

  createRtpCollector() {
    return new PipecatRtpFrameCollector({ maxFrames: this.options.rtpMaxFrames ?? 200 });
  }

  activeRtpCollector() {
    if (!this.currentRtpCallUuid) return this.rtpCollector;
    return this.callMap.get(this.currentRtpCallUuid)?.rtpCollector ?? this.rtpCollector;
  }

  callPlaybackState(uuid) {
    const resolvedUuid = uuid ?? this.currentRtpCallUuid;
    const call = resolvedUuid ? this.callMap.get(resolvedUuid) : null;
    return {
      call,
      sink: call?.rtpPlaybackSink ?? this.rtpPlaybackSink,
      played: call ? call.pipecatOutputFixturePlayed === true : this.pipecatOutputFixturePlayed,
      posted: call ? call.pipecatPlaybackEventPosted === true : this.pipecatPlaybackEventPosted,
      postedSignature: call ? call.pipecatPlaybackEventSignature ?? null : this.pipecatPlaybackEventSignature,
      freeswitchBroadcast: call?.freeswitchBroadcast ?? this.freeswitchBroadcast,
    };
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
    this.startRtpPlaybackSocket();
  }

  send(command) {
    this.socket.write(`${command}\n\n`);
  }

  startRtpReceiver() {
    if (!this.options.rtpListenPort) return;
    this.rtpSocket = dgram.createSocket("udp4");
    this.rtpSocket.on("message", (message) => {
      const collector = this.activeRtpCollector();
      const frame = collector.acceptPacket(message);
      if (frame) this.events.push({ at: frame.receivedAt, rtpFrame: { sequenceNumber: frame.sequenceNumber, timestamp: frame.timestamp, durationMs: frame.durationMs } });
    });
    this.rtpSocket.on("error", (error) => {
      this.activeRtpCollector().errors.push({ at: nowIso(), error: error.message });
    });
    this.rtpSocket.bind(this.options.rtpListenPort, this.options.rtpListenHost ?? "127.0.0.1");
  }

  startRtpPlaybackSocket() {
    if (!this.rtpPlaybackSink.options.remotePort || this.rtpPlaybackSocket) return;
    this.rtpPlaybackSocket = dgram.createSocket("udp4");
    this.rtpPlaybackSocket.on("error", (error) => {
      this.rtpPlaybackSink.errors.push({ at: nowIso(), error: error.message });
    });
  }

  configureRtpPlaybackFromHeaders(headers, sink = this.rtpPlaybackSink) {
    if (this.options.rtpPlaybackPort) return null;
    const remoteRtp = remoteRtpFromHeaders(headers);
    if (!remoteRtp) return null;
    sink.options.remoteHost = remoteRtp.address;
    sink.options.remotePort = remoteRtp.port;
    this.startRtpPlaybackSocket();
    this.events.push({ at: nowIso(), remoteRtpPlaybackTarget: remoteRtp });
    return remoteRtp;
  }

  async playPipecatOutputFixture(uuid = null) {
    const state = this.callPlaybackState(uuid);
    if (!this.options.pipecatOutputFixturePath || !this.rtpPlaybackSocket || state.played) return;
    const frames = await loadPipecatOutputFrameSummaries(this.options.pipecatOutputFixturePath);
    for (const frame of frames) await state.sink.sendFrame(this.rtpPlaybackSocket, frame);
    if (frames.length > 0) {
      if (state.call) state.call.pipecatOutputFixturePlayed = true;
      else this.pipecatOutputFixturePlayed = true;
      this.events.push({ at: nowIso(), pipecatOutboundRtpPlayback: state.sink.summary(), source: "fixture", sipCallId: uuid ?? undefined });
    }
  }

  async playLiveKokoroTts(agentText, uuid) {
    const state = this.callPlaybackState(uuid);
    if (!this.options.kokoroBaseUrl || !agentText) return null;
    try {
      const frame = await synthesizeKokoroTtsFrame(agentText, {
        baseUrl: this.options.kokoroBaseUrl,
        speechPath: this.options.kokoroSpeechPath,
        voice: this.options.kokoroVoice,
        model: this.options.kokoroModel,
      });
      let broadcast = null;
      try {
        broadcast = await this.broadcastKokoroFrame(uuid, frame);
      } catch (error) {
        broadcast = {
          mode: "freeswitch_uuid_broadcast_failed",
          error: error instanceof Error ? error.message : String(error),
        };
        state.sink.errors.push({ at: nowIso(), error: broadcast.error, source: "freeswitch_uuid_broadcast" });
      }
      if (this.rtpPlaybackSocket) await state.sink.sendFrame(this.rtpPlaybackSocket, frame);
      else state.sink.packetize(frame);
      const summary = state.sink.summary();
      if (state.call) state.call.freeswitchBroadcast = broadcast;
      else this.freeswitchBroadcast = broadcast;
      const playbackEvidence = { ...summary, ttsFrameDurationMs: outputAudioFrameDurationMs(frame), freeswitchBroadcast: broadcast };
      this.events.push({ at: nowIso(), pipecatLiveKokoroTtsPlayback: { ...playbackEvidence, sourceText: agentText, tts: frame.tts } });
      await this.postPipecatPlaybackEvent(uuid);
      return playbackEvidence;
    } catch (error) {
      const failure = { at: nowIso(), error: error instanceof Error ? error.message : String(error) };
      state.sink.errors.push(failure);
      this.events.push({ at: failure.at, pipecatLiveKokoroTtsPlaybackBlocked: failure });
      return null;
    }
  }

  async broadcastKokoroFrame(uuid, frame) {
    if (!uuid || !this.options.freeswitchRecordingDir) return { mode: "rtp_socket_only", reason: "freeswitch_recording_dir_unset" };
    const pcm16 = Buffer.from(frame.pcm16Base64 ?? "", "base64");
    const { hostPath, freeswitchPath } = visiblePlaybackPath(this.options.recordingDir, this.options.freeswitchRecordingDir, uuid);
    await mkdir(path.dirname(hostPath), { recursive: true });
    await writeFile(hostPath, pcm16MonoWav(pcm16, frame.sampleRateHz ?? 8000));
    this.send("api uuid_broadcast " + uuid + " " + freeswitchPath + " aleg");
    const issuedAtMs = Date.now();
    return { mode: "freeswitch_uuid_broadcast", hostPath, freeswitchPath, sampleRateHz: frame.sampleRateHz ?? 8000, audioBytes: pcm16.length, issuedAtMs };
  }

  async postPipecatPlaybackEvent(uuid) {
    const state = this.callPlaybackState(uuid);
    const playbackSummary = state.sink.summary();
    if (!playbackSummary.outboundRtpReady) return;
    const freeswitchBroadcast = state.call?.freeswitchBroadcast ?? this.freeswitchBroadcast;
    if (!this.options.accBaseUrl) return;
    const eventSignature = JSON.stringify({
      packetCount: playbackSummary.packetCount,
      sentPacketCount: playbackSummary.sentPacketCount,
      rtpSocketSendReady: playbackSummary.rtpSocketSendReady,
      freeswitchBroadcastPath: freeswitchBroadcast?.freeswitchPath ?? null,
      freeswitchBroadcastAudioBytes: freeswitchBroadcast?.audioBytes ?? null,
    });
    if (state.postedSignature === eventSignature) return;
    await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
      eventType: "media.playback",
      timestamp: nowIso(),
      sipCallId: uuid,
      fsUuid: uuid,
      outboundRtpReady: playbackSummary.outboundRtpReady,
      rtpSocketSendReady: playbackSummary.rtpSocketSendReady,
      packetCount: playbackSummary.packetCount,
      sentPacketCount: playbackSummary.sentPacketCount,
      remoteHost: playbackSummary.remoteHost,
      remotePort: playbackSummary.remotePort,
      totalDurationMs: playbackSummary.totalDurationMs,
      ssrc: playbackSummary.ssrc,
      lastSentAt: playbackSummary.lastSentAt,
      evidencePath: this.options.manifestPath,
      freeswitchBroadcast: freeswitchBroadcast ?? null,
      freeswitchBroadcastMode: freeswitchBroadcast?.mode ?? null,
      freeswitchBroadcastHostPath: freeswitchBroadcast?.hostPath ?? null,
      freeswitchBroadcastPath: freeswitchBroadcast?.freeswitchPath ?? null,
      freeswitchBroadcastSampleRateHz: freeswitchBroadcast?.sampleRateHz ?? null,
      freeswitchBroadcastAudioBytes: freeswitchBroadcast?.audioBytes ?? null,
    });
    if (state.call) {
      state.call.pipecatPlaybackEventPosted = true;
      state.call.pipecatPlaybackEventSignature = eventSignature;
    } else {
      this.pipecatPlaybackEventPosted = true;
      this.pipecatPlaybackEventSignature = eventSignature;
    }
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
    this.rtpCollector = this.createRtpCollector();
    const rtpCollector = this.createRtpCollector();
    const rtpPlaybackSink = this.createRtpPlaybackSink();
    this.rtpPlaybackSink = rtpPlaybackSink;
    const remoteRtp = this.configureRtpPlaybackFromHeaders(headers, rtpPlaybackSink);
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
    this.callMap.set(uuid, {
      wavPath,
      freeswitchPath,
      startedAt: Date.now(),
      recordingStartedAtMs: Date.now(),
      destination,
      remoteRtp,
      accCallId: response?.body?.call?.session?.callId ?? null,
      rtpCollector,
      rtpPlaybackSink,
      pipecatOutputFixturePlayed: false,
      pipecatPlaybackEventPosted: false,
      pipecatPlaybackEventSignature: null,
      freeswitchBroadcast: null,
      initialGreetingPlaybackDurationMs: 0,
    });
    this.currentRtpCallUuid = uuid;
    this.send(`api uuid_record ${uuid} start ${freeswitchPath}`);
    await this.playPipecatOutputFixture(uuid);
    const greetingPlayback = await this.playLiveKokoroTts(latestAgentText(response.body) || this.options.initialGreetingText, uuid);
    const call = this.callMap.get(uuid);
    if (call) {
      const greetingWasRecordedInCallerWav = playbackHasCompleteFreeswitchBroadcastEvidence(greetingPlayback);
      call.initialGreetingPlaybackDurationMs = greetingWasRecordedInCallerWav ? greetingPlayback.ttsFrameDurationMs : 0;
    }
    await this.postPipecatPlaybackEvent(uuid);
  }

  async onRecordStop(uuid) {
    const call = this.callMap.get(uuid);
    if (!call) return;
    await this.playPipecatOutputFixture(uuid);
    let pipecatRtpFrameBatch = (call.rtpCollector ?? this.rtpCollector).summary();
    if (pipecatRtpFrameBatch.frames.length === 0) {
      try {
        pipecatRtpFrameBatch = await pipecatInputFrameBatchFromWav(call.wavPath, {
          maxFrames: this.options.rtpMaxFrames ?? 200,
          startOffsetMs: wavFallbackStartOffsetMs(call),
        });
        this.events.push({ at: nowIso(), pipecatRecordingFrameBatch: { packetCount: pipecatRtpFrameBatch.packetCount, captureSource: pipecatRtpFrameBatch.captureSource } });
      } catch (error) {
        pipecatRtpFrameBatch.errors.push({ at: nowIso(), error: error instanceof Error ? error.message : String(error), source: "freeswitch_recording_wav" });
      }
    }
    await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
      eventType: "media.capture",
      timestamp: nowIso(),
      sipCallId: uuid,
      fsUuid: uuid,
      audioWavPath: call.wavPath,
      sipLogPath: this.options.logPath,
      generatedMedia: false,
      pipecatRtpFrameBatch,
    });
    let rtcAsrStreamEvidence = null;
    if (this.options.rtcAsrUrl) {
      await resetRtcAsrEvidence(this.options.rtcAsrEvidencePath);
      const sink = new RtcAsrPipecatStreamSink({
        url: this.options.rtcAsrUrl,
        evidencePath: this.options.rtcAsrEvidencePath,
        WebSocketImpl: this.options.rtcAsrWebSocketImpl,
        clientStreamId: `${uuid}-local-sip`,
      });
      try {
        rtcAsrStreamEvidence = await sink.transcribeFrameBatch(pipecatRtpFrameBatch, { sipCallId: uuid, fsUuid: uuid, accCallId: call.accCallId });
        this.events.push({ at: nowIso(), rtcAsrPipecatStream: rtcAsrStreamEvidence });
      } catch (error) {
        rtcAsrStreamEvidence = sink.summary("blocked", error instanceof Error ? error.message : String(error));
        this.events.push({ at: nowIso(), rtcAsrPipecatStream: rtcAsrStreamEvidence });
      }
    }
    await this.postPipecatPlaybackEvent(uuid);

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
        const transcriptResponse = await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
          eventType: "media.transcript",
          timestamp: nowIso(),
          sipCallId: uuid,
          fsUuid: uuid,
          text: evidence.transcript,
          rtcAsrEvidencePath: this.options.rtcAsrEvidencePath,
        });
        await this.playLiveKokoroTts(latestAgentText(transcriptResponse.body), uuid);
      }
    }
    await this.flushLog();
    const manifest = await buildFreeswitchLiveProofManifest({
      uuid,
      accCallId: call.accCallId,
      destination: call.destination,
      wavPath: call.wavPath,
      freeswitchRecordingPath: call.freeswitchPath,
      remoteRtp: call.remoteRtp,
      logPath: this.options.logPath,
      rtcAsrUrl: this.options.rtcAsrUrl,
      rtcAsrEvidencePath: this.options.rtcAsrEvidencePath,
      telephonyMode: this.options.telephonyMode,
      pipecatRtpEvidence: pipecatRtpFrameBatch,
      rtcAsrStreamEvidence,
      pipecatOutboundRtpEvidence: { ...(call.rtpPlaybackSink ?? this.rtpPlaybackSink).summary(), freeswitchBroadcast: call.freeswitchBroadcast ?? null },
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
    if (this.currentRtpCallUuid === uuid) this.currentRtpCallUuid = null;
    if (this.callMap.size === 0) {
      this.rtpCollector = this.createRtpCollector();
      this.pipecatOutputFixturePlayed = false;
      this.pipecatPlaybackEventPosted = false;
      this.pipecatPlaybackEventSignature = null;
    }
  }

  async flushLog() {
    await mkdir(path.dirname(this.options.logPath), { recursive: true });
    await writeFile(this.options.logPath, `${JSON.stringify({ generatedAt: nowIso(), events: this.events }, null, 2)}\n`, "utf8");
  }
}

async function main() {
  const rtcAsrUrl = argValue("--rtc-asr-url", process.env.RTC_ASR_WS_URL);
  const rtcAsrEvidencePath = argValue(
    "--rtc-asr-evidence",
    process.env.RTC_ASR_EVIDENCE_PATH || (rtcAsrUrl ? "artifacts/freeswitch-live/rtc-asr-evidence.jsonl" : undefined),
  );
  const bridge = new EslBridge({
    eslHost: argValue("--esl-host", process.env.FREESWITCH_ESL_HOST || "127.0.0.1"),
    eslPort: Number(argValue("--esl-port", process.env.FREESWITCH_ESL_PORT || "8021")),
    password: argValue("--esl-password", process.env.FREESWITCH_ESL_PASSWORD || "ClueCon"),
    accBaseUrl: argValue("--acc-url", process.env.ACC_BASE_URL || "http://127.0.0.1:8026"),
    recordingDir: path.resolve(process.cwd(), argValue("--recording-dir", "artifacts/freeswitch-live/media")),
    freeswitchRecordingDir: argValue("--freeswitch-recording-dir", process.env.FREESWITCH_RECORDING_DIR),
    logPath: path.resolve(process.cwd(), argValue("--log", "artifacts/freeswitch-live/freeswitch-esl-events.json")),
    manifestPath: path.resolve(process.cwd(), argValue("--manifest", "artifacts/freeswitch-live/freeswitch-live-proof-manifest.json")),
    rtcAsrUrl,
    rtcAsrEvidencePath,
    telephonyMode: argValue("--telephony-mode", process.env.ACC_TELEPHONY_MODE || "local_sip"),
    rtpListenHost: argValue("--rtp-listen-host", process.env.ACC_FREESWITCH_RTP_LISTEN_HOST || "127.0.0.1"),
    rtpListenPort: Number(argValue("--rtp-listen-port", process.env.ACC_FREESWITCH_RTP_LISTEN_PORT || "0")) || undefined,
    rtpPlaybackHost: argValue("--rtp-playback-host", process.env.ACC_FREESWITCH_RTP_PLAYBACK_HOST || "127.0.0.1"),
    rtpPlaybackPort: Number(argValue("--rtp-playback-port", process.env.ACC_FREESWITCH_RTP_PLAYBACK_PORT || "0")) || undefined,
    pipecatOutputFixturePath: argValue("--pipecat-output-fixture", process.env.ACC_PIPECAT_OUTPUT_FIXTURE),
    kokoroBaseUrl: argValue("--kokoro-base-url", process.env.KOKORO_BASE_URL),
    kokoroSpeechPath: argValue("--kokoro-speech-path", process.env.KOKORO_SPEECH_PATH || process.env.KOKORO_TTS_PATH || "/v1/audio/speech"),
    kokoroVoice: argValue("--kokoro-voice", process.env.KOKORO_VOICE || "af_heart"),
    kokoroModel: argValue("--kokoro-model", process.env.KOKORO_MODEL || "kokoro"),
    initialGreetingText: argValue("--initial-greeting", process.env.ACC_SIP_INITIAL_GREETING || "Hello, this is the agentic contact center. I can hear you now."),
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
