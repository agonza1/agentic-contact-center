#!/usr/bin/env node
import { createHash } from "node:crypto";
import dgram from "node:dgram";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
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

function parseSipMessage(raw) {
  const text = raw.toString("utf8");
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

function parseRtpPort(sdp) {
  const match = sdp.match(/^m=audio\s+(\d+)\s+/m);
  return match ? Number(match[1]) : null;
}

function parseConnectionAddress(sdp, fallback) {
  const match = sdp.match(/^c=IN\s+IP4\s+([^\s]+)\s*$/m);
  return match ? match[1] : fallback;
}

function responseFor(message, statusLine, body = "", extraHeaders = []) {
  const headers = [
    `Via: ${header(message, "via")}`,
    `From: ${header(message, "from")}`,
    `To: ${header(message, "to")}${header(message, "to").includes("tag=") ? "" : ";tag=acc"}`,
    `Call-ID: ${header(message, "call-id")}`,
    `CSeq: ${header(message, "cseq")}`,
    "Server: agentic-contact-center-local-sip",
    ...extraHeaders,
    `Content-Length: ${Buffer.byteLength(body)}`,
  ];
  return Buffer.from([statusLine, ...headers, "", body].join("\r\n"));
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

async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function postJson(baseUrl, route, body) {
  if (!baseUrl) return null;
  const url = new URL(route, baseUrl);
  const rawBody = Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": rawBody.length },
      },
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

class LocalSipProofServer {
  constructor(options) {
    this.options = options;
    this.sipLog = [];
    this.pcmChunks = [];
    this.rtpPacketCount = 0;
    this.callId = null;
    this.remoteRtp = null;
    this.startedAt = null;
    this.endedAt = null;
    this.accCallId = null;
  }

  async start() {
    await mkdir(this.options.outDir, { recursive: true });
    this.sipSocket = dgram.createSocket("udp4");
    this.rtpSocket = dgram.createSocket("udp4");
    this.sipSocket.on("message", (msg, rinfo) => void this.handleSip(msg, rinfo));
    this.rtpSocket.on("message", (msg) => this.handleRtp(msg));
    await Promise.all([
      new Promise((resolve) => this.sipSocket.bind(this.options.sipPort, this.options.host, resolve)),
      new Promise((resolve) => this.rtpSocket.bind(this.options.rtpPort, this.options.host, resolve)),
    ]);
  }

  async stop() {
    this.sipSocket?.close();
    this.rtpSocket?.close();
  }

  async handleSip(msg, rinfo) {
    const message = parseSipMessage(msg);
    this.sipLog.push({ at: nowIso(), direction: "in", remote: `${rinfo.address}:${rinfo.port}`, startLine: message.startLine, text: message.text });

    if (message.startLine.startsWith("INVITE ")) {
      this.startedAt = nowIso();
      this.callId = header(message, "call-id") || `local-sip-${Date.now()}`;
      const remoteRtpPort = parseRtpPort(message.body);
      this.remoteRtp = remoteRtpPort ? { address: parseConnectionAddress(message.body, rinfo.address), port: remoteRtpPort } : null;
      await this.sendSip(responseFor(message, "SIP/2.0 100 Trying"), rinfo);
      await this.sendSip(responseFor(message, "SIP/2.0 180 Ringing"), rinfo);
      const sdp = [
        "v=0",
        `o=acc 0 0 IN IP4 ${this.options.host}`,
        "s=Agentic Contact Center Local SIP Proof",
        `c=IN IP4 ${this.options.host}`,
        "t=0 0",
        `m=audio ${this.options.rtpPort} RTP/AVP 0`,
        "a=rtpmap:0 PCMU/8000",
        "a=sendrecv",
        "",
      ].join("\r\n");
      await this.sendSip(
        responseFor(message, "SIP/2.0 200 OK", sdp, ["Contact: <sip:acc@127.0.0.1>", "Content-Type: application/sdp"]),
        rinfo,
      );
      const response = await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
        eventType: "call.started",
        timestamp: this.startedAt,
        sipCallId: this.callId,
        source: "local_sip_harness",
        telephonyMode: "local_sip",
        rtcAsrMode: this.options.rtcAsrUrl ? "rtc_asr_live" : "rtc_asr_blocked",
      });
      this.accCallId = response?.body?.call?.session?.callId ?? null;
      return;
    }

    if (message.startLine.startsWith("BYE ")) {
      this.endedAt = nowIso();
      await this.sendSip(responseFor(message, "SIP/2.0 200 OK"), rinfo);
      await this.finish("remote_bye");
      return;
    }

    if (message.startLine.startsWith("OPTIONS ")) {
      await this.sendSip(responseFor(message, "SIP/2.0 200 OK", "", ["Allow: INVITE, ACK, BYE, OPTIONS"]), rinfo);
    }
  }

  async sendSip(buffer, rinfo) {
    this.sipLog.push({ at: nowIso(), direction: "out", remote: `${rinfo.address}:${rinfo.port}`, startLine: buffer.toString("utf8").split(/\r?\n/, 1)[0], text: buffer.toString("utf8") });
    await new Promise((resolve, reject) => this.sipSocket.send(buffer, rinfo.port, rinfo.address, (err) => err ? reject(err) : resolve()));
  }

  handleRtp(msg) {
    if (msg.length < 12) return;
    const payloadType = msg[1] & 0x7f;
    const payload = msg.subarray(12);
    if (payloadType !== 0) return;
    const pcm = Buffer.alloc(payload.length * 2);
    for (let index = 0; index < payload.length; index += 1) pcm.writeInt16LE(ulawToPcm16(payload[index]), index * 2);
    this.pcmChunks.push(pcm);
    this.rtpPacketCount += 1;
  }

  async finish(hangupCause = "timeout") {
    if (this.finished) return;
    this.finished = true;
    this.endedAt ??= nowIso();
    const pcm = Buffer.concat(this.pcmChunks);
    const sipLogPath = path.join(this.options.outDir, "sip.log.json");
    const wavPath = path.join(this.options.outDir, "caller-capture.wav");
    const manifestPath = path.join(this.options.outDir, "local-sip-live-proof-manifest.json");
    await writeFile(sipLogPath, `${JSON.stringify(this.sipLog, null, 2)}\n`, "utf8");
    await writeFile(wavPath, Buffer.concat([wavHeader(pcm.length), pcm]));

    const blockers = [];
    if (this.options.generatedMedia) blockers.push("Self-test generated RTP audio; rerun with a real local SIP softphone call before review.");
    if (this.rtpPacketCount === 0) blockers.push("No RTP packets were captured.");
    if (!this.options.rtcAsrUrl) blockers.push("RTC_ASR_WS_URL was not set, so rtc-asr live transcription was not attempted.");
    const runtimeModeLabels = {
      telephony: "local_sip",
      media: this.options.generatedMedia ? "generated_media" : "live_capture",
      rtcAsr: this.options.rtcAsrUrl ? "rtc_asr_live" : "rtc_asr_blocked",
      credentialsMode: "mocked",
    };
    const requiredReviewLabels = ["local_sip", "live_capture", "rtc_asr_live"];
    const presentReviewLabels = new Set(Object.values(runtimeModeLabels));
    const missingReviewLabels = requiredReviewLabels.filter((label) => !presentReviewLabels.has(label));
    const nextActions = [];
    if (this.options.generatedMedia || this.rtpPacketCount === 0) {
      nextActions.push("Place a real local SIP/FreeSWITCH softphone call and rerun the live proof without --self-test.");
    }
    if (!this.options.rtcAsrUrl) {
      nextActions.push("Start rtc-asr, set RTC_ASR_WS_URL, and rerun the live proof to capture a websocket-backed transcript.");
    }

    await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
      eventType: "media.capture",
      timestamp: this.endedAt,
      sipCallId: this.callId,
      audioWavPath: wavPath,
      sipLogPath,
      rtpPacketCount: this.rtpPacketCount,
      generatedMedia: this.options.generatedMedia,
    });
    if (!this.options.rtcAsrUrl) {
      await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
        eventType: "rtc_asr.blocked",
        timestamp: this.endedAt,
        sipCallId: this.callId,
        blocker: "RTC_ASR_WS_URL unset or rtc-asr sidecar unavailable",
        nextAction: "Run rtc-asr and set RTC_ASR_WS_URL=ws://127.0.0.1:8080/v1/stt/stream, then rerun scripts/local-sip-live-proof.mjs.",
      });
    }
    await postJson(this.options.accBaseUrl, "/api/live-sip/events", {
      eventType: "call.ended",
      timestamp: this.endedAt,
      sipCallId: this.callId,
      hangupCause,
      durationSeconds: this.startedAt ? Math.round((Date.parse(this.endedAt) - Date.parse(this.startedAt)) / 1000) : null,
    });

    const audioStats = await stat(wavPath);
    const manifest = {
      schemaVersion: 1,
      generatedAt: nowIso(),
      workboardCard: "872af947-ef57-47bd-a4f3-3750f54e1948",
      callId: this.accCallId,
      sipCallId: this.callId,
      runtimeModeLabels,
      localSip: {
        bind: `sip:${this.options.host}:${this.options.sipPort}`,
        rtpPort: this.options.rtpPort,
        acceptedInvite: Boolean(this.callId),
        rtpPacketCount: this.rtpPacketCount,
        remoteRtp: this.remoteRtp,
      },
      artifacts: { audioWav: wavPath, sipLog: sipLogPath },
      artifactIntegrity: [
        { artifactId: "local-sip-caller-capture-wav", kind: "call_media", path: wavPath, sha256: await sha256File(wavPath), sizeBytes: audioStats.size, readiness: this.rtpPacketCount > 0 ? "ready" : "blocked" },
        { artifactId: "local-sip-sip-log", kind: "sip_log", path: sipLogPath, sha256: await sha256File(sipLogPath), sizeBytes: (await stat(sipLogPath)).size, readiness: "ready" },
      ],
      reviewReady: blockers.length === 0 && !this.options.generatedMedia,
      reviewGate: {
        requiredLabels: requiredReviewLabels,
        missingLabels: missingReviewLabels,
        nextActions,
      },
      blockers,
    };
    this.lastManifest = manifest;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ manifest: manifestPath, reviewReady: manifest.reviewReady, blockers }, null, 2));
  }
}

async function runSelfCall({ host, sipPort, rtpPort, durationMs }) {
  const socket = dgram.createSocket("udp4");
  const callId = `selftest-${Date.now()}`;
  const localRtpPort = rtpPort + 2;
  const invite = [
    `INVITE sip:8600@${host}:${sipPort} SIP/2.0`,
    `Via: SIP/2.0/UDP ${host}:5070;branch=z9hG4bK-selftest`,
    `Max-Forwards: 70`,
    `From: <sip:1000@${host}>;tag=selftest`,
    `To: <sip:8600@${host}>`,
    `Call-ID: ${callId}`,
    `CSeq: 1 INVITE`,
    `Contact: <sip:1000@${host}:5070>`,
    `Content-Type: application/sdp`,
    `Content-Length: 144`,
    "",
    `v=0\r\no=selftest 0 0 IN IP4 ${host}\r\ns=Self Test\r\nc=IN IP4 ${host}\r\nt=0 0\r\nm=audio ${localRtpPort} RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=sendrecv\r\n`,
  ].join("\r\n");
  const responses = [];
  socket.on("message", (msg) => responses.push(msg.toString("utf8")));
  await new Promise((resolve) => socket.bind(5070, host, resolve));
  await new Promise((resolve, reject) => socket.send(Buffer.from(invite), sipPort, host, (err) => err ? reject(err) : resolve()));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const ok = responses.find((text) => text.startsWith("SIP/2.0 200"));
  if (!ok) throw new Error("Self-test did not receive SIP 200 OK");
  const ack = [
    `ACK sip:8600@${host}:${sipPort} SIP/2.0`,
    `Via: SIP/2.0/UDP ${host}:5070;branch=z9hG4bK-selftest-ack`,
    `From: <sip:1000@${host}>;tag=selftest`,
    `To: <sip:8600@${host}>;tag=acc`,
    `Call-ID: ${callId}`,
    `CSeq: 1 ACK`,
    `Content-Length: 0`,
    "",
    "",
  ].join("\r\n");
  await new Promise((resolve, reject) => socket.send(Buffer.from(ack), sipPort, host, (err) => err ? reject(err) : resolve()));
  let sequence = 1;
  let timestamp = 0;
  const ssrc = 0xacc2026;
  const started = Date.now();
  while (Date.now() - started < durationMs) {
    const payload = Buffer.alloc(160);
    for (let i = 0; i < payload.length; i += 1) {
      const t = (timestamp + i) / 8000;
      payload[i] = pcm16ToUlaw(Math.round(Math.sin(2 * Math.PI * 440 * t) * 10000));
    }
    const packet = Buffer.alloc(12 + payload.length);
    packet[0] = 0x80;
    packet[1] = 0x00;
    packet.writeUInt16BE(sequence & 0xffff, 2);
    packet.writeUInt32BE(timestamp >>> 0, 4);
    packet.writeUInt32BE(ssrc, 8);
    payload.copy(packet, 12);
    await new Promise((resolve, reject) => socket.send(packet, rtpPort, host, (err) => err ? reject(err) : resolve()));
    sequence += 1;
    timestamp += 160;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const bye = [
    `BYE sip:8600@${host}:${sipPort} SIP/2.0`,
    `Via: SIP/2.0/UDP ${host}:5070;branch=z9hG4bK-selftest-bye`,
    `From: <sip:1000@${host}>;tag=selftest`,
    `To: <sip:8600@${host}>;tag=acc`,
    `Call-ID: ${callId}`,
    `CSeq: 2 BYE`,
    `Content-Length: 0`,
    "",
    "",
  ].join("\r\n");
  await new Promise((resolve, reject) => socket.send(Buffer.from(bye), sipPort, host, (err) => err ? reject(err) : resolve()));
  await new Promise((resolve) => setTimeout(resolve, 200));
  socket.close();
}

async function main() {
  const host = argValue("--host", "127.0.0.1");
  const sipPort = Number(argValue("--sip-port", "5066"));
  const rtpPort = Number(argValue("--rtp-port", "40000"));
  const outDir = path.resolve(process.cwd(), argValue("--out-dir", `artifacts/local-sip-live-${new Date().toISOString().replaceAll(":", "-")}`));
  const listenSeconds = Number(argValue("--listen-seconds", hasFlag("--self-test") ? "5" : "120"));
  const server = new LocalSipProofServer({
    host,
    sipPort,
    rtpPort,
    outDir,
    accBaseUrl: argValue("--acc-url", process.env.ACC_BASE_URL),
    rtcAsrUrl: argValue("--rtc-asr-url", process.env.RTC_ASR_WS_URL),
    generatedMedia: hasFlag("--self-test"),
  });
  await server.start();
  console.log(`Listening for local SIP at sip:8600@${host}:${sipPort}, RTP ${rtpPort}; artifacts ${outDir}`);
  if (hasFlag("--self-test")) {
    await runSelfCall({ host, sipPort, rtpPort, durationMs: Number(argValue("--duration-ms", "1200")) });
  }
  await new Promise((resolve) => setTimeout(resolve, listenSeconds * 1000));
  await server.finish(hasFlag("--self-test") ? "self_test_complete" : "listen_timeout");
  await server.stop();
  if (hasFlag("--require-live-caller") && server.lastManifest?.reviewReady !== true) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
