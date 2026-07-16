#!/usr/bin/env node
import { createHash } from "node:crypto";
import dgram from "node:dgram";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
    this.returnPacketCount = 0;
    this.callId = `acc-proof-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.fromTag = `acc${Date.now()}`;
    this.toTag = "";
    this.cseq = 1;
    this.remoteRtp = null;
    this.completed = false;
    this.accepted = false;
    this.mediaTasks = new Set();
  }

  async run() {
    await mkdir(this.options.outDir, { recursive: true });
    this.callerPcm = tonePcm16({ durationMs: this.options.toneMs, frequency: this.options.frequency });
    this.sipSocket = dgram.createSocket("udp4");
    this.rtpSocket = dgram.createSocket("udp4");
    this.sipSocket.on("message", (msg, rinfo) => void this.handleSip(msg, rinfo));
    this.rtpSocket.on("message", (msg, rinfo) => this.handleRtp(msg, rinfo));
    await Promise.all([
      new Promise((resolve) => this.sipSocket.bind(this.options.localSipPort, this.options.localHost, resolve)),
      new Promise((resolve) => this.rtpSocket.bind(this.options.localRtpPort, this.options.localHost, resolve)),
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
        const challenge = parseDigestChallenge(header(message, "proxy-authenticate"));
        const uri = `sip:${this.options.remoteHost}:${this.options.remoteSipPort}`;
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
      if (this.accepted) return;
      this.accepted = true;
      this.toTag = header(message, "to").match(/;tag=([^;>\s]+)/)?.[1] ?? this.toTag;
      this.remoteRtp = parseRtpTargetFromSdp(message.body, rinfo.address);
      await this.sendAck();
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

  async sendAck() {
    const uri = `sip:${this.options.destination}@${this.options.remoteHost}:${this.options.remoteSipPort}`;
    const packet = Buffer.from([
      `ACK ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.options.localHost}:${this.options.localSipPort};branch=z9hG4bK-${this.callId}-ack`,
      "Max-Forwards: 70",
      `From: "ACC SIP Proof" <sip:${this.options.username}@${this.options.domain}>;tag=${this.fromTag}`,
      `To: <sip:${this.options.destination}@${this.options.domain}>${this.toTag ? `;tag=${this.toTag}` : ""}`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq} ACK`,
      `Contact: <sip:${this.options.username}@${this.options.localHost}:${this.options.localSipPort}>`,
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n"));
    this.record("sip.send", { startLine: "ACK", cseq: this.cseq });
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

  handleRtp(msg, rinfo) {
    if (msg.length < 12) return;
    const payloadType = msg[1] & 0x7f;
    if (payloadType !== 0) return;
    const payload = msg.subarray(12);
    const pcm = Buffer.alloc(payload.length * 2);
    for (let index = 0; index < payload.length; index += 1) pcm.writeInt16LE(ulawToPcm16(payload[index]), index * 2);
    this.returnPcmChunks.push(pcm);
    this.returnPacketCount += 1;
    if (this.returnPacketCount === 1) this.record("rtp.return_audio_started", { remote: `${rinfo.address}:${rinfo.port}` });
  }

  async writeArtifacts() {
    const callerWavPath = path.join(this.options.outDir, "caller-input.wav");
    const playbackWavPath = path.join(this.options.outDir, "caller-playback-capture.wav");
    const sipLogPath = path.join(this.options.outDir, "sip-events.json");
    const playbackEvidencePath = path.join(this.options.outDir, "caller-playback-evidence.json");
    const rtcAsrEvidencePath = this.options.rtcAsrEvidencePath ? path.resolve(this.options.rtcAsrEvidencePath) : null;
    const manifestPath = path.join(this.options.outDir, "verto-sip-live-proof-manifest.json");
    const callerWav = Buffer.concat([wavHeader(this.callerPcm.length), this.callerPcm]);
    const playbackPcm = Buffer.concat(this.returnPcmChunks);
    const playbackWav = Buffer.concat([wavHeader(playbackPcm.length), playbackPcm]);
    await writeFile(callerWavPath, callerWav);
    await writeFile(playbackWavPath, playbackWav);
    await writeFile(sipLogPath, `${JSON.stringify(this.events, null, 2)}\n`, "utf8");
    const callerPlaybackConfirmed = this.returnPacketCount > 0 && playbackPcm.length > 0;
    await writeFile(
      playbackEvidencePath,
      `${JSON.stringify({
        status: callerPlaybackConfirmed ? "caller_playback_confirmed" : "caller_playback_blocked",
        callerPlaybackConfirmed,
        method: "repo_sip_uac_rtp_capture",
        callId: this.callId,
        packetCount: this.returnPacketCount,
        playbackWavPath,
        playbackAudioBytes: playbackPcm.length,
        generatedAt: nowIso(),
      }, null, 2)}\n`,
      "utf8",
    );
    const rtcAsrReady = rtcAsrEvidencePath ? await stat(rtcAsrEvidencePath).then((stats) => stats.size > 0, () => false) : false;
    const blockers = [];
    if (!this.remoteRtp) blockers.push("FreeSWITCH did not return an RTP target in the accepted INVITE SDP.");
    if (!callerPlaybackConfirmed) blockers.push("No caller-side return RTP audio was captured.");
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
        destination: this.options.destination,
        acceptedInvite: Boolean(this.remoteRtp),
        remoteRtp: this.remoteRtp,
        rtpPacketCount: Math.ceil(this.callerPcm.length / 320),
        callerInputPacketCount: Math.ceil(this.callerPcm.length / 320),
        callerPlaybackPacketCount: this.returnPacketCount,
      },
      artifacts: {
        audioWav: callerWavPath,
        callerInputWav: callerWavPath,
        callerPlaybackWav: playbackWavPath,
        sipLog: sipLogPath,
        rtcAsrEvidence: rtcAsrEvidencePath,
        callerPlaybackEvidence: playbackEvidencePath,
      },
      artifactIntegrity: [
        { artifactId: "caller-input-wav", kind: "call_media", path: callerWavPath, sha256: await sha256File(callerWavPath), sizeBytes: callerWav.length, readiness: "ready" },
        { artifactId: "caller-playback-capture-wav", kind: "playback_media", path: playbackWavPath, sha256: await sha256File(playbackWavPath), sizeBytes: playbackWav.length, readiness: callerPlaybackConfirmed ? "ready" : "blocked" },
        { artifactId: "sip-events", kind: "sip_log", path: sipLogPath, sha256: await sha256File(sipLogPath), sizeBytes: (await stat(sipLogPath)).size, readiness: "ready" },
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
        playbackWavPath,
      },
      blockers,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }
}

function runSelfTest() {
  const challenge = parseDigestChallenge('Digest realm="192.168.86.28", nonce="abc", algorithm=MD5, qop="auth"');
  const authorization = digestAuthorization({
    username: "1000",
    password: "local-sip-pass",
    method: "INVITE",
    uri: "sip:192.168.86.28:5060",
    challenge,
  });
  const sdpTarget = parseRtpTargetFromSdp("v=0\r\nc=IN IP4 127.0.0.1\r\nm=audio 29790 RTP/AVP 0\r\n", "fallback");
  const pcm = tonePcm16({ durationMs: 40 });
  const packets = ulawPacketsFromPcm(pcm, { ssrc: 1 });
  const ok = authorization.includes('username="1000"') && authorization.includes('response="') && sdpTarget?.port === 29790 && packets.length > 0;
  console.log(JSON.stringify({ ok, authorizationReady: authorization.includes("Digest "), sdpTarget, packetCount: packets.length }, null, 2));
  return ok ? 0 : 2;
}

async function main() {
  if (hasFlag("--self-test")) return runSelfTest();
  const remoteHost = argValue("--remote-host", process.env.FREESWITCH_SIP_HOST || "127.0.0.1");
  const remoteSipPort = Number(argValue("--remote-sip-port", process.env.FREESWITCH_SIP_PORT || "5060"));
  const localHost = argValue("--local-host", process.env.ACC_SIP_PROOF_LOCAL_HOST || remoteHost);
  const outDir = path.resolve(process.cwd(), argValue("--out-dir", `artifacts/verto-sip-live-${new Date().toISOString().replaceAll(":", "-")}`));
  const call = new SipProofCall({
    outDir,
    remoteHost,
    remoteSipPort,
    localHost,
    localSipPort: Number(argValue("--local-sip-port", process.env.ACC_SIP_PROOF_LOCAL_SIP_PORT || "5094")),
    localRtpPort: Number(argValue("--local-rtp-port", process.env.ACC_SIP_PROOF_LOCAL_RTP_PORT || "6002")),
    username: argValue("--username", process.env.FREESWITCH_SIP_USERNAME || "1000"),
    password: argValue("--password", process.env.FREESWITCH_SIP_PASSWORD || "local-sip-pass"),
    domain: argValue("--domain", process.env.FREESWITCH_SIP_DOMAIN || remoteHost),
    destination: argValue("--destination", process.env.FREESWITCH_SIP_DESTINATION || "8600"),
    toneMs: Number(argValue("--tone-ms", "1800")),
    callMs: Number(argValue("--call-ms", "10000")),
    frequency: Number(argValue("--frequency", "440")),
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
