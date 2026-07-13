import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);


function rtpPacket(payload: number[], sequenceNumber = 0x1234, timestamp = 0x00000320): number[] {
  return [
    0x80,
    0x00,
    (sequenceNumber >> 8) & 0xff,
    sequenceNumber & 0xff,
    (timestamp >> 24) & 0xff,
    (timestamp >> 16) & 0xff,
    (timestamp >> 8) & 0xff,
    timestamp & 0xff,
    0xca,
    0xfe,
    0xba,
    0xbe,
    ...payload,
  ];
}

function validWavFixture(packetCount = 4) {
  const payloadBytes = packetCount * 320;
  const buffer = Buffer.alloc(44 + payloadBytes, 1);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + payloadBytes, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(payloadBytes, 40);
  return buffer;
}



test("FreeSWITCH bridge collects live RTP into Pipecat frame-batch evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const script = `
    const { PipecatRtpFrameCollector } = await import(${JSON.stringify(moduleUrl)});
    const collector = new PipecatRtpFrameCollector({ maxFrames: 10 });
    collector.acceptPacket(Buffer.from(${JSON.stringify(rtpPacket([0xfe, 0x7e], 0xfffe, 160))}), "2026-07-11T19:00:00.000Z");
    collector.acceptPacket(Buffer.from(${JSON.stringify(rtpPacket([0xfe], 0xffff, 162))}), "2026-07-11T19:00:00.020Z");
    collector.acceptPacket(Buffer.from(${JSON.stringify(rtpPacket([0x7e], 0x0001, 163))}), "2026-07-11T19:00:00.040Z");
    collector.acceptPacket(Buffer.from([0x80, 0x08, 0x00, 0x01, 0, 0, 0, 1, 0xca, 0xfe, 0xba, 0xbe, 0xff]), "2026-07-11T19:00:00.060Z");
    console.log(JSON.stringify(collector.summary()));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const summary = JSON.parse(stdout) as {
    liveRtpCaptured: boolean;
    frameType: string;
    packetCount: number;
    totalDurationMs: number;
    sequenceGaps: Array<{ after: number; before: number }>;
    errors: Array<{ error: string }>;
    frames: Array<{ frameType: string; audioFormat: string; pcm16Base64: string }>;
  };

  assert.equal(summary.liveRtpCaptured, true);
  assert.equal(summary.frameType, "InputAudioRawFrameBatch");
  assert.equal(summary.packetCount, 3);
  assert.equal(summary.totalDurationMs, 0.5);
  assert.deepEqual(summary.sequenceGaps, [{ after: 0xffff, before: 0x0001 }]);
  assert.deepEqual(summary.errors.map((error) => error.error), ["rtp_payload_type_not_pcmu"]);
  assert.equal(summary.frames[0].frameType, "InputAudioRawFrame");
  assert.equal(summary.frames[0].audioFormat, "pcm_s16le");
  assert.match(summary.frames[0].pcm16Base64, /^[A-Za-z0-9+/]+=*$/);
});


test("FreeSWITCH bridge derives Pipecat input frames from recorded caller WAV fallback", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-wav-input-"));
  const audioPath = path.join(tempDir, "fs-call.wav");

  try {
    await writeFile(audioPath, validWavFixture(3));
    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { pipecatInputFrameBatchFromWav } = await import(${JSON.stringify(moduleUrl)});
      const batch = await pipecatInputFrameBatchFromWav(${JSON.stringify(audioPath)}, { maxFrames: 2, receivedAt: "2026-07-13T02:20:00.000Z" });
      console.log(JSON.stringify(batch));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const batch = JSON.parse(stdout) as {
      liveRtpCaptured: boolean;
      captureSource: string;
      packetCount: number;
      totalDurationMs: number;
      frames: Array<{ frameType: string; source: string; timestamp: number; durationMs: number; pcm16Base64: string }>;
    };

    assert.equal(batch.liveRtpCaptured, true);
    assert.equal(batch.captureSource, "freeswitch_recording_wav");
    assert.equal(batch.packetCount, 2);
    assert.equal(batch.totalDurationMs, 40);
    assert.deepEqual(batch.frames.map((frame) => frame.timestamp), [0, 160]);
    assert.equal(batch.frames[0].frameType, "InputAudioRawFrame");
    assert.equal(batch.frames[0].source, "freeswitch_recording_wav");
    assert.match(batch.frames[0].pcm16Base64, /^[A-Za-z0-9+/]+=*$/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("FreeSWITCH bridge packetizes Pipecat output audio into outbound RTP proof evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-outbound-rtp-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(logPath, `${JSON.stringify({ events: [{ headers: { "Event-Name": "CHANNEL_ANSWER" } }] })}\n`, "utf8");
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ transcript: { text: "hello from local sip", final: true } })}\n`, "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { PipecatRtpPlaybackSink, buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const pcm16 = Buffer.alloc(8);
      [0, 1200, -1200, 32000].forEach((sample, index) => pcm16.writeInt16LE(sample, index * 2));
      const sink = new PipecatRtpPlaybackSink({ remoteHost: "127.0.0.1", remotePort: 40002, sequenceNumber: 0xfffe, timestamp: 160, ssrc: 0x0badf00d, samplesPerPacket: 2 });
      const packets = sink.packetize({ frameType: "OutputAudioRawFrame", audioFormat: "pcm_s16le", sampleRateHz: 8000, channels: 1, pcm16 });
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-outbound-rtp",
        accCallId: "demo-call-outbound-rtp",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
        telephonyMode: "local_sip",
        remoteRtp: { address: "127.0.0.1", port: 40002 },
        pipecatOutboundRtpEvidence: sink.summary()
      });
      console.log(JSON.stringify({ packets: packets.map((packet) => ({ sequenceNumber: packet.readUInt16BE(2), timestamp: packet.readUInt32BE(4), ssrc: packet.readUInt32BE(8), payloadBytes: packet.length - 12 })), manifest }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout) as {
      packets: Array<{ sequenceNumber: number; timestamp: number; ssrc: number; payloadBytes: number }>;
      manifest: {
        reviewReady: boolean;
        pipecatMediaEngine: {
          realtimeDirection: string;
          outboundPlaybackAdapter: string;
          bidirectionalPlaybackReady: boolean;
          blocker: string;
          outboundRtpPlayback: { outboundRtpReady: boolean; rtpSocketSendReady: boolean; packetCount: number; sentPacketCount: number; totalDurationMs: number; nextSequenceNumber: number; nextTimestamp: number; remotePort: number; targetMatchedCallerRtp: boolean };
        };
      };
    };

    assert.deepEqual(parsed.packets, [
      { sequenceNumber: 0xfffe, timestamp: 160, ssrc: 0x0badf00d, payloadBytes: 2 },
      { sequenceNumber: 0xffff, timestamp: 162, ssrc: 0x0badf00d, payloadBytes: 2 },
    ]);
    assert.equal(parsed.manifest.reviewReady, false);
    assert.equal(parsed.manifest.pipecatMediaEngine.realtimeDirection, "sip_rtp_inbound_to_pipecat_input_frames_and_output_frames_to_rtp_packets");
    assert.equal(parsed.manifest.pipecatMediaEngine.outboundPlaybackAdapter, "packetized_output_audio_frames_to_pcmu_rtp");
    assert.equal(parsed.manifest.pipecatMediaEngine.bidirectionalPlaybackReady, false);
    assert.match(parsed.manifest.pipecatMediaEngine.blocker, /not been sent to a FreeSWITCH caller RTP target/);
    assert.equal(parsed.manifest.pipecatMediaEngine.outboundRtpPlayback.outboundRtpReady, true);
    assert.equal(parsed.manifest.pipecatMediaEngine.outboundRtpPlayback.packetCount, 2);
    assert.equal(parsed.manifest.pipecatMediaEngine.outboundRtpPlayback.sentPacketCount, 0);
    assert.equal(parsed.manifest.pipecatMediaEngine.outboundRtpPlayback.rtpSocketSendReady, false);
    assert.equal(parsed.manifest.pipecatMediaEngine.outboundRtpPlayback.totalDurationMs, 0.5);
    assert.equal(parsed.manifest.pipecatMediaEngine.outboundRtpPlayback.nextSequenceNumber, 0);
    assert.equal(parsed.manifest.pipecatMediaEngine.outboundRtpPlayback.nextTimestamp, 164);
    assert.equal(parsed.manifest.pipecatMediaEngine.outboundRtpPlayback.remotePort, 40002);
    assert.equal(parsed.manifest.pipecatMediaEngine.outboundRtpPlayback.targetMatchedCallerRtp, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("FreeSWITCH bridge sends fixture Pipecat output frames to RTP playback sink", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-send-rtp-"));
  const fixturePath = path.join(tempDir, "pipecat-output.jsonl");

  try {
    const pcm16 = Buffer.alloc(8);
    [0, 1200, -1200, 32000].forEach((sample, index) => pcm16.writeInt16LE(sample, index * 2));
    await writeFile(fixturePath, JSON.stringify({ frame: { frameType: "TTSAudioRawFrame", audioFormat: "pcm_s16le", sampleRateHz: 8000, channels: 1, pcm16Base64: pcm16.toString("base64") } }) + "\n", "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = [
      "const { EslBridge } = await import(" + JSON.stringify(moduleUrl) + ");",
      "const sent = [];",
      "const bridge = new EslBridge({" +
        "recordingDir:" + JSON.stringify(tempDir) + "," +
        "freeswitchRecordingDir:" + JSON.stringify(tempDir) + "," +
        "logPath:" + JSON.stringify(path.join(tempDir, "events.json")) + "," +
        "manifestPath:" + JSON.stringify(path.join(tempDir, "manifest.json")) + "," +
        "telephonyMode:\"local_sip\"," +
        "rtpPlaybackHost:\"127.0.0.1\"," +
        "rtpPlaybackPort:40002," +
        "rtpPlaybackSequenceNumber:0xfffe," +
        "rtpPlaybackTimestamp:160," +
        "rtpPlaybackSsrc:0x0badf00d," +
        "rtpPlaybackSamplesPerPacket:2," +
        "pipecatOutputFixturePath:" + JSON.stringify(fixturePath) +
      "});",
      "bridge.rtpPlaybackSocket = { send(packet, port, host, callback) { sent.push({ sequenceNumber: packet.readUInt16BE(2), timestamp: packet.readUInt32BE(4), marker: (packet[1] & 0x80) !== 0, ssrc: packet.readUInt32BE(8), payloadBytes: packet.length - 12, port, host }); callback(); } };",
      "await bridge.playPipecatOutputFixture();",
      "console.log(JSON.stringify({ sent, summary: bridge.rtpPlaybackSink.summary(), events: bridge.events }));"
    ].join("\n");
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout) as {
      sent: Array<{ sequenceNumber: number; timestamp: number; marker: boolean; ssrc: number; payloadBytes: number; port: number; host: string }>;
      summary: { outboundRtpReady: boolean; rtpSocketSendReady: boolean; frameType: string; packetCount: number; sentPacketCount: number; nextSequenceNumber: number; nextTimestamp: number; remotePort: number; totalDurationMs: number; ssrc: number; lastSentAt: string | null; errors: Array<{ error: string }> };
      events: Array<{ pipecatOutboundRtpPlayback?: { outboundRtpReady: boolean } }>;
    };

    assert.deepEqual(parsed.sent, [
      { sequenceNumber: 0xfffe, timestamp: 160, marker: true, ssrc: 0x0badf00d, payloadBytes: 2, port: 40002, host: "127.0.0.1" },
      { sequenceNumber: 0xffff, timestamp: 162, marker: false, ssrc: 0x0badf00d, payloadBytes: 2, port: 40002, host: "127.0.0.1" },
    ]);
    assert.equal(parsed.summary.outboundRtpReady, true);
    assert.equal(parsed.summary.frameType, "OutputAudioRawFrame|TTSAudioRawFrame");
    assert.equal(parsed.summary.packetCount, 2);
    assert.equal(parsed.summary.sentPacketCount, 2);
    assert.equal(parsed.summary.rtpSocketSendReady, true);
    assert.match(parsed.summary.lastSentAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(parsed.summary.nextSequenceNumber, 0);
    assert.equal(parsed.summary.nextTimestamp, 164);
    assert.equal(parsed.summary.remotePort, 40002);
    assert.equal(parsed.summary.totalDurationMs, 0.5);
    assert.equal(parsed.summary.ssrc, 0x0badf00d);
    assert.match(parsed.summary.lastSentAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(parsed.summary.errors, []);
    assert.equal(parsed.events.some((event) => event.pipecatOutboundRtpPlayback?.outboundRtpReady), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("FreeSWITCH bridge plays Pipecat TTS fixture on answered call remote RTP target", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-answer-playback-"));
  const fixturePath = path.join(tempDir, "pipecat-output.jsonl");

  try {
    const pcm16 = Buffer.alloc(8);
    [0, 1200, -1200, 32000].forEach((sample, index) => pcm16.writeInt16LE(sample, index * 2));
    await writeFile(fixturePath, JSON.stringify({ frame: { frameType: "TTSAudioRawFrame", audioFormat: "pcm_s16le", sampleRateHz: 8000, channels: 1, pcm16Base64: pcm16.toString("base64") } }) + "\n", "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = [
      "const { EslBridge } = await import(" + JSON.stringify(moduleUrl) + ");",
      "const sentRtp = [];",
      "const http = await import(\"node:http\");",
      "const { Writable, Readable } = await import(\"node:stream\");",
      "const originalRequest = http.default.request;",
      "http.default.request = (options, callback) => { const req = new Writable({ write(chunk, encoding, done) { done(); } }); req.on = req.addListener.bind(req); req.write = () => true; req.end = () => { const res = new Readable({ read() { this.push(JSON.stringify({ call: { session: { callId: \"acc-answer-playback\" } } })); this.push(null); } }); res.statusCode = 200; res.setEncoding = () => res; callback(res); }; return req; };",
      "const bridge = new EslBridge({" +
        "recordingDir:" + JSON.stringify(tempDir) + "," +
        "freeswitchRecordingDir:" + JSON.stringify(tempDir) + "," +
        "logPath:" + JSON.stringify(path.join(tempDir, "events.json")) + "," +
        "manifestPath:" + JSON.stringify(path.join(tempDir, "manifest.json")) + "," +
        "telephonyMode:\"local_sip\"," +
        "accBaseUrl:\"http://127.0.0.1:1\"," +
        "pipecatOutputFixturePath:" + JSON.stringify(fixturePath) + "," +
        "rtpPlaybackSequenceNumber:0xfffe," +
        "rtpPlaybackTimestamp:160," +
        "rtpPlaybackSsrc:0x0badf00d," +
        "rtpPlaybackSamplesPerPacket:2" +
      "});",
      "bridge.send = () => {};",
      "bridge.rtpPlaybackSocket = { send(packet, port, host, callback) { sentRtp.push({ sequenceNumber: packet.readUInt16BE(2), timestamp: packet.readUInt32BE(4), port, host }); callback(); } };",
      "const headers = new Map([[\"Caller-Destination-Number\", \"8600\"], [\"variable_remote_media_ip\", \"127.0.0.1\"], [\"variable_remote_media_port\", \"40002\"]]);",
      "try { await bridge.onAnswer(\"fs-answer-playback\", headers); await bridge.playPipecatOutputFixture(); } finally { http.default.request = originalRequest; }",
      "const call = bridge.callMap.get(\"fs-answer-playback\"); console.log(JSON.stringify({ sentRtp, playbackSummary: call.rtpPlaybackSink.summary(), played: call.pipecatOutputFixturePlayed, playbackEventPosted: call.pipecatPlaybackEventPosted, globalPlayed: bridge.pipecatOutputFixturePlayed, globalPlaybackEventPosted: bridge.pipecatPlaybackEventPosted, events: bridge.events }));"
    ].join("\n");
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout) as {
      sentRtp: Array<{ sequenceNumber: number; timestamp: number; port: number; host: string }>;
      playbackSummary: { rtpSocketSendReady: boolean; packetCount: number; sentPacketCount: number; remotePort: number };
      played: boolean;
      events: Array<{ pipecatOutboundRtpPlayback?: { sentPacketCount: number } }>;
      playbackEventPosted: boolean;
      globalPlayed: boolean;
      globalPlaybackEventPosted: boolean;
    };

    assert.deepEqual(parsed.sentRtp, [
      { sequenceNumber: 0xfffe, timestamp: 160, port: 40002, host: "127.0.0.1" },
      { sequenceNumber: 0xffff, timestamp: 162, port: 40002, host: "127.0.0.1" },
    ]);
    assert.equal(parsed.played, true);
    assert.equal(parsed.playbackEventPosted, true);
    assert.equal(parsed.globalPlayed, false);
    assert.equal(parsed.globalPlaybackEventPosted, false);
    assert.equal(parsed.playbackSummary.packetCount, 2);
    assert.equal(parsed.playbackSummary.sentPacketCount, 2);
    assert.equal(parsed.playbackSummary.rtpSocketSendReady, true);
    assert.equal(parsed.playbackSummary.remotePort, 40002);
    assert.equal(parsed.events.filter((event) => event.pipecatOutboundRtpPlayback).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("FreeSWITCH bridge scopes RTP capture and playback state per SIP call", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-per-call-state-"));
  const fixturePath = path.join(tempDir, "pipecat-output.jsonl");

  try {
    const pcm16 = Buffer.alloc(8);
    [0, 1200, -1200, 32000].forEach((sample, index) => pcm16.writeInt16LE(sample, index * 2));
    await writeFile(fixturePath, JSON.stringify({ frame: { frameType: "TTSAudioRawFrame", audioFormat: "pcm_s16le", sampleRateHz: 8000, channels: 1, pcm16Base64: pcm16.toString("base64") } }) + "\n", "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { EslBridge } = await import(${JSON.stringify(moduleUrl)});
      const http = await import("node:http");
      const { Writable, Readable } = await import("node:stream");
      const originalRequest = http.default.request;
      let started = 0;
      http.default.request = (options, callback) => {
        const req = new Writable({ write(chunk, encoding, done) { done(); } });
        req.on = req.addListener.bind(req);
        req.write = () => true;
        req.end = () => {
          const res = new Readable({ read() { this.push(JSON.stringify({ call: { session: { callId: "acc-call-" + (++started) } } })); this.push(null); } });
          res.statusCode = 200;
          res.setEncoding = () => res;
          callback(res);
        };
        return req;
      };
      const sentRtp = [];
      const bridge = new EslBridge({
        recordingDir: ${JSON.stringify(tempDir)},
        freeswitchRecordingDir: ${JSON.stringify(tempDir)},
        logPath: ${JSON.stringify(path.join(tempDir, "events.json"))},
        manifestPath: ${JSON.stringify(path.join(tempDir, "manifest.json"))},
        telephonyMode: "local_sip",
        accBaseUrl: "http://127.0.0.1:1",
        pipecatOutputFixturePath: ${JSON.stringify(fixturePath)},
        rtpPlaybackSamplesPerPacket: 2
      });
      bridge.send = () => {};
      bridge.rtpPlaybackSocket = { send(packet, port, host, callback) { sentRtp.push({ sequenceNumber: packet.readUInt16BE(2), port, host }); callback(); } };
      const headers1 = new Map([["Caller-Destination-Number", "8600"], ["variable_remote_media_ip", "127.0.0.1"], ["variable_remote_media_port", "40002"]]);
      const headers2 = new Map([["Caller-Destination-Number", "8600"], ["variable_remote_media_ip", "127.0.0.1"], ["variable_remote_media_port", "40004"]]);
      try {
        await bridge.onAnswer("fs-call-one", headers1);
        bridge.activeRtpCollector().acceptPacket(Buffer.from(${JSON.stringify(rtpPacket([0xfe], 0x1000, 160))}), "2026-07-12T18:00:00.000Z");
        const firstSummary = bridge.callMap.get("fs-call-one").rtpCollector.summary();
        const firstPlayback = bridge.callMap.get("fs-call-one").rtpPlaybackSink.summary();
        await bridge.onHangup("fs-call-one", new Map([["Hangup-Cause", "NORMAL_CLEARING"]]));
        await bridge.onAnswer("fs-call-two", headers2);
        bridge.activeRtpCollector().acceptPacket(Buffer.from(${JSON.stringify(rtpPacket([0x7e], 0x2000, 320))}), "2026-07-12T18:00:01.000Z");
        const secondSummary = bridge.callMap.get("fs-call-two").rtpCollector.summary();
        const secondPlayback = bridge.callMap.get("fs-call-two").rtpPlaybackSink.summary();
        console.log(JSON.stringify({ sentRtp, firstSummary, firstPlayback, secondSummary, secondPlayback, events: bridge.events }));
      } finally {
        http.default.request = originalRequest;
      }
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout) as {
      sentRtp: Array<{ sequenceNumber: number; port: number; host: string }>;
      firstSummary: { packetCount: number; frames: Array<{ sequenceNumber: number }> };
      firstPlayback: { sentPacketCount: number; remotePort: number };
      secondSummary: { packetCount: number; frames: Array<{ sequenceNumber: number }> };
      secondPlayback: { sentPacketCount: number; remotePort: number };
      events: Array<{ pipecatOutboundRtpPlayback?: { sentPacketCount: number; remotePort: number } }>;
    };

    assert.equal(parsed.firstSummary.packetCount, 1);
    assert.equal(parsed.firstSummary.frames[0].sequenceNumber, 0x1000);
    assert.equal(parsed.secondSummary.packetCount, 1);
    assert.equal(parsed.secondSummary.frames[0].sequenceNumber, 0x2000);
    assert.equal(parsed.firstPlayback.sentPacketCount, 2);
    assert.equal(parsed.firstPlayback.remotePort, 40002);
    assert.equal(parsed.secondPlayback.sentPacketCount, 2);
    assert.equal(parsed.secondPlayback.remotePort, 40004);
    assert.deepEqual(parsed.sentRtp.map((packet) => packet.port), [40002, 40002, 40004, 40004]);
    assert.deepEqual(parsed.events.filter((event) => event.pipecatOutboundRtpPlayback).map((event) => event.pipecatOutboundRtpPlayback?.remotePort), [40002, 40004]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("FreeSWITCH bridge streams captured Pipecat input frames to rtc-asr Local STT v1 evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-rtc-asr-stream-"));
  const evidencePath = path.join(tempDir, "rtc-asr-evidence.jsonl");

  try {
    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { RtcAsrPipecatStreamSink, PipecatRtpFrameCollector } = await import(${JSON.stringify(moduleUrl)});
      const sent = [];
      class FakeWebSocket {
        constructor(url) { this.url = url; this.readyState = 1; this.listeners = new Map(); }
        addEventListener(name, handler) { this.listeners.set(name, handler); }
        send(payload) {
          sent.push(Buffer.isBuffer(payload) ? { kind: "binary", bytes: payload.length, samples: [payload.readInt16LE(0), payload.readInt16LE(2)] } : { kind: "json", payload: JSON.parse(payload) });
          if (!Buffer.isBuffer(payload) && JSON.parse(payload).type === "finalize") {
            queueMicrotask(() => this.listeners.get("message")?.({ data: JSON.stringify({ type: "transcript", text: "hello from sip", is_final: true, speech_final: true }) }));
          }
        }
        close(code, reason) { this.closeCode = code; this.closeReason = reason; }
      }
      const collector = new PipecatRtpFrameCollector({ maxFrames: 10 });
      collector.acceptPacket(Buffer.from(${JSON.stringify(rtpPacket([0xfe, 0x7e], 100, 160))}), "2026-07-12T02:30:00.000Z");
      const sink = new RtcAsrPipecatStreamSink({ url: "ws://127.0.0.1:8080/v1/stt/stream", evidencePath: ${JSON.stringify(evidencePath)}, WebSocketImpl: FakeWebSocket, clientStreamId: "fs-call-rtc-asr" });
      const summary = await sink.transcribeFrameBatch(collector.summary(), { sipCallId: "fs-call-rtc-asr" });
      console.log(JSON.stringify({ sent, summary }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout) as {
      sent: Array<{ kind: string; bytes?: number; samples?: number[]; payload?: any }>;
      summary: { readiness: string; protocol: string; audioChunks: number; audioBytes: number; finalTranscriptReady: boolean; evidencePath: string };
    };
    const evidence = await readFile(evidencePath, "utf8");

    assert.equal(parsed.sent[0].kind, "json");
    assert.equal(parsed.sent[0].payload.type, "start");
    assert.equal(parsed.sent[0].payload.version, "local-stt.v1");
    assert.equal(parsed.sent[0].payload.audio.sample_rate, 16000);
    assert.equal(parsed.sent[1].kind, "binary");
    assert.equal(parsed.sent[1].bytes, 8);
    assert.deepEqual(parsed.sent[1].samples, [decodePcmuSampleForTest(0xfe), decodePcmuSampleForTest(0xfe)]);
    assert.equal(parsed.sent[2].payload.type, "finalize");
    assert.equal(parsed.summary.readiness, "ready");
    assert.equal(parsed.summary.protocol, "local-stt.v1");
    assert.equal(parsed.summary.audioChunks, 1);
    assert.equal(parsed.summary.audioBytes, 8);
    assert.equal(parsed.summary.finalTranscriptReady, true);
    assert.equal(parsed.summary.evidencePath, evidencePath);
    assert.match(evidence, /hello from sip/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("FreeSWITCH bridge sends live Kokoro TTS frames to RTP playback sink", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-kokoro-broadcast-"));
  const http = await import("node:http");
  const pcm16 = Buffer.alloc(8);
  [0, 1200, -1200, 32000].forEach((sample, index) => pcm16.writeInt16LE(sample, index * 2));
  const requests: Array<any> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ audio_base64: pcm16.toString("base64"), format: "pcm", sample_rate: 8000 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const script = [
      "const { EslBridge } = await import(" + JSON.stringify(moduleUrl) + ");",
      "const sentCommands = [];",
      "const sentRtp = [];",
      "const bridge = new EslBridge({" +
        "kokoroBaseUrl:" + JSON.stringify(`http://127.0.0.1:${address.port}`) + "," +
        "kokoroSpeechPath:\"/v1/audio/speech\"," +
        "kokoroVoice:\"af_heart\"," +
        "kokoroModel:\"kokoro\"," +
        "recordingDir:" + JSON.stringify(tempDir) + "," +
        "freeswitchRecordingDir:\"/var/log/freeswitch/acc/media\"," +
        "rtpPlaybackHost:\"127.0.0.1\"," +
        "rtpPlaybackPort:40002," +
        "rtpPlaybackSequenceNumber:0xfffe," +
        "rtpPlaybackTimestamp:160," +
        "rtpPlaybackSsrc:0x0badf00d," +
        "rtpPlaybackSamplesPerPacket:2" +
      "});",
      "bridge.pipecatPlaybackEventPosted = true;",
      "bridge.send = (command) => sentCommands.push(command);",
      "bridge.rtpPlaybackSocket = { send(packet, port, host, callback) { sentRtp.push({ sequenceNumber: packet.readUInt16BE(2), timestamp: packet.readUInt32BE(4), port, host }); callback(); } };",
      "const summary = await bridge.playLiveKokoroTts(\"Agent response from ACC\", \"fs-live-kokoro\");",
      "console.log(JSON.stringify({ sentRtp, sentCommands, summary, events: bridge.events }));"
    ].join("\n");
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], { cwd: repoRoot, encoding: "utf8" });
    const parsed = JSON.parse(stdout) as {
      sentRtp: Array<{ sequenceNumber: number; timestamp: number; port: number; host: string }>;
      sentCommands: string[];
      summary: { rtpSocketSendReady: boolean; packetCount: number; sentPacketCount: number; remotePort: number; totalDurationMs: number; ssrc: number; lastSentAt: string | null; freeswitchBroadcast: { mode: string; hostPath: string; freeswitchPath: string; audioBytes: number } };
      events: Array<{ pipecatLiveKokoroTtsPlayback?: { sourceText: string; tts: { engine: string; outputSampleRateHz: number }; freeswitchBroadcast: { mode: string; hostPath: string; freeswitchPath: string; audioBytes: number } } }>;
    };

    assert.deepEqual(requests, [{ model: "kokoro", voice: "af_heart", input: "Agent response from ACC", response_format: "wav", sample_rate: 8000 }]);
    assert.deepEqual(parsed.sentRtp, [
      { sequenceNumber: 0xfffe, timestamp: 160, port: 40002, host: "127.0.0.1" },
      { sequenceNumber: 0xffff, timestamp: 162, port: 40002, host: "127.0.0.1" },
    ]);
    assert.equal(parsed.summary.packetCount, 2);
    assert.equal(parsed.summary.sentPacketCount, 2);
    assert.equal(parsed.summary.rtpSocketSendReady, true);
    assert.equal(parsed.summary.remotePort, 40002);
    assert.equal(parsed.summary.totalDurationMs, 0.5);
    assert.equal(parsed.summary.ssrc, 0x0badf00d);
    assert.equal(parsed.sentCommands.length, 1);
    assert.equal(parsed.sentCommands[0].startsWith("api uuid_broadcast fs-live-kokoro /var/log/freeswitch/acc/media/fs-live-kokoro-kokoro-tts-"), true);
    assert.equal(parsed.sentCommands[0].endsWith(".wav aleg"), true);
    assert.equal(parsed.summary.freeswitchBroadcast.mode, "freeswitch_uuid_broadcast");
    assert.equal(parsed.summary.freeswitchBroadcast.freeswitchPath.startsWith("/var/log/freeswitch/acc/media/fs-live-kokoro-kokoro-tts-"), true);
    assert.equal(parsed.summary.freeswitchBroadcast.hostPath.startsWith(tempDir), true);
    assert.equal(parsed.summary.freeswitchBroadcast.audioBytes, 8);
    assert.match(parsed.summary.lastSentAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    const playback = parsed.events.find((event) => event.pipecatLiveKokoroTtsPlayback)?.pipecatLiveKokoroTtsPlayback;
    assert.equal(playback?.sourceText, "Agent response from ACC");
    assert.equal(playback?.tts.engine, "kokoro");
    assert.equal(playback?.tts.outputSampleRateHz, 8000);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("FreeSWITCH bridge broadcasts live Kokoro TTS even without caller RTP socket", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-kokoro-broadcast-no-rtp-"));
  const http = await import("node:http");
  const pcm16 = Buffer.alloc(8);
  [0, 1200, -1200, 32000].forEach((sample, index) => pcm16.writeInt16LE(sample, index * 2));
  const playbackEvents: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url === "/api/live-sip/events") {
        playbackEvents.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ audio_base64: pcm16.toString("base64"), format: "pcm", sample_rate: 8000 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const script = [
      "const { EslBridge } = await import(" + JSON.stringify(moduleUrl) + ");",
      "const sentCommands = [];",
      "const bridge = new EslBridge({" +
        "kokoroBaseUrl:" + JSON.stringify(`http://127.0.0.1:${address.port}`) + "," +
        "accBaseUrl:" + JSON.stringify(`http://127.0.0.1:${address.port}`) + "," +
        "recordingDir:" + JSON.stringify(tempDir) + "," +
        "freeswitchRecordingDir:\"/var/log/freeswitch/acc/media\"" +
      "});",
      "bridge.send = (command) => sentCommands.push(command);",
      "const summary = await bridge.playLiveKokoroTts(\"Agent response from ACC\", \"fs-live-kokoro-no-rtp\");",
      "console.log(JSON.stringify({ sentCommands, summary, events: bridge.events }));"
    ].join("\n");
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], { cwd: repoRoot, encoding: "utf8" });
    const parsed = JSON.parse(stdout) as {
      sentCommands: string[];
      summary: { outboundRtpReady: boolean; rtpSocketSendReady: boolean; packetCount: number; sentPacketCount: number; totalDurationMs: number; freeswitchBroadcast: { mode: string; audioBytes: number } };
      events: Array<{ pipecatLiveKokoroTtsPlayback?: { freeswitchBroadcast: { mode: string } } }>;
    };

    assert.equal(parsed.summary.outboundRtpReady, true);
    assert.equal(parsed.summary.rtpSocketSendReady, false);
    assert.equal(parsed.summary.packetCount, 1);
    assert.equal(parsed.summary.sentPacketCount, 0);
    assert.equal(parsed.summary.totalDurationMs, 0.5);
    assert.equal(parsed.summary.freeswitchBroadcast.mode, "freeswitch_uuid_broadcast");
    assert.equal(parsed.summary.freeswitchBroadcast.audioBytes, 8);
    assert.equal(parsed.sentCommands.length, 1);
    assert.equal(parsed.sentCommands[0].startsWith("api uuid_broadcast fs-live-kokoro-no-rtp /var/log/freeswitch/acc/media/fs-live-kokoro-no-rtp-kokoro-tts-"), true);
    assert.equal(parsed.events.some((event) => event.pipecatLiveKokoroTtsPlayback?.freeswitchBroadcast.mode === "freeswitch_uuid_broadcast"), true);
    assert.equal(playbackEvents.length, 1);
    assert.equal(playbackEvents[0].eventType, "media.playback");
    assert.equal(playbackEvents[0].outboundRtpReady, true);
    assert.equal(playbackEvents[0].rtpSocketSendReady, false);
    assert.equal(playbackEvents[0].packetCount, 1);
    assert.equal(playbackEvents[0].sentPacketCount, 0);
    assert.equal(playbackEvents[0].freeswitchBroadcast.mode, "freeswitch_uuid_broadcast");
    assert.equal(playbackEvents[0].freeswitchBroadcast.freeswitchPath.startsWith("/var/log/freeswitch/acc/media/fs-live-kokoro-no-rtp-kokoro-tts-"), true);
    assert.equal(playbackEvents[0].freeswitchBroadcast.audioBytes, 8);
    assert.equal(playbackEvents[0].freeswitchBroadcastMode, "freeswitch_uuid_broadcast");
    assert.equal(playbackEvents[0].freeswitchBroadcastPath.startsWith("/var/log/freeswitch/acc/media/fs-live-kokoro-no-rtp-kokoro-tts-"), true);
    assert.equal(playbackEvents[0].freeswitchBroadcastAudioBytes, 8);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

function decodePcmuSampleForTest(sample: number): number {
  const inverted = (~sample) & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude -= 0x84;
  return sign ? -magnitude : magnitude;
}

test("FreeSWITCH ESL frames keep content-length event bodies attached", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const script = `
    const { nextEslFrame } = await import(${JSON.stringify(moduleUrl)});
    const body = ["Event-Name: CHANNEL_ANSWER", "Unique-ID: fs-call-123", "Caller-Destination-Number: 8600", ""].join("\\n");
    const raw = ["Content-Type: text/event-plain", "Content-Length: " + Buffer.byteLength(body), "", body + "Content-Type: command/reply", "Reply-Text: +OK", "", ""].join("\\n");
    const first = nextEslFrame(raw);
    const second = nextEslFrame(first.rest);
    console.log(JSON.stringify({ first, second }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const parsed = JSON.parse(stdout) as {
    first: { block: string; rest: string };
    second: { block: string; rest: string };
  };
  assert.match(parsed.first.block, /Content-Type: text\/event-plain/);
  assert.match(parsed.first.block, /Event-Name: CHANNEL_ANSWER/);
  assert.match(parsed.first.block, /Unique-ID: fs-call-123/);
  assert.match(parsed.second.block, /Content-Type: command\/reply/);
  assert.equal(parsed.second.rest, "");
});

test("FreeSWITCH ESL frame parser waits for a complete CRLF content-length body", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const script = `
    const { nextEslFrame } = await import(${JSON.stringify(moduleUrl)});
    const body = ["Event-Name: RECORD_STOP", "Unique-ID: fs-call-456", "Record-File-Path: /var/log/freeswitch/acc/fs-call-456.wav", ""].join("\\r\\n");
    const header = ["Content-Type: text/event-plain", "Content-Length: " + Buffer.byteLength(body), "", ""].join("\\r\\n");
    const partial = nextEslFrame(header + body.slice(0, -5));
    const complete = nextEslFrame(header + body);
    console.log(JSON.stringify({ partial, complete }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const parsed = JSON.parse(stdout) as {
    partial: null;
    complete: { block: string; rest: string };
  };
  assert.equal(parsed.partial, null);
  assert.match(parsed.complete.block, /Event-Name: RECORD_STOP/);
  assert.match(parsed.complete.block, /Record-File-Path: \/var\/log\/freeswitch\/acc\/fs-call-456\.wav/);
  assert.equal(parsed.complete.rest, "");
});

test("FreeSWITCH bridge discovers caller RTP target from encoded SDP headers", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const script = `    const { remoteRtpFromHeaders, remoteRtpFromSdp } = await import(${JSON.stringify(moduleUrl)});
    const sdp = [
      "v=0",
      "o=FreeSWITCH 1718124800 1718124801 IN IP4 192.0.2.40",
      "s=FreeSWITCH",
      "c=IN IP4 192.0.2.40",
      "t=0 0",
      "m=audio 40002 RTP/AVP 0 101",
      "a=rtpmap:0 PCMU/8000"
    ].join("\\r\\n");
    const direct = remoteRtpFromSdp(sdp);
    const encoded = new Map([["variable_switch_r_sdp", encodeURIComponent(sdp)]]);
    const fallback = remoteRtpFromHeaders(encoded);
    console.log(JSON.stringify({ direct, fallback }));
`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const parsed = JSON.parse(stdout) as {
    direct: { address: string; port: number };
    fallback: { address: string; port: number };
  };

  assert.deepEqual(parsed.direct, { address: "192.0.2.40", port: 40002 });
  assert.deepEqual(parsed.fallback, { address: "192.0.2.40", port: 40002 });
});

test("FreeSWITCH bridge dispatches streamed content-length events after the body arrives", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const script = `
    const { EslBridge } = await import(${JSON.stringify(moduleUrl)});
    const sent = [];
    const body = [
      "Event-Name: CHANNEL_ANSWER",
      "Unique-ID: fs-call-streamed",
      "Caller-Destination-Number: 8600",
      "variable_remote_media_ip: 127.0.0.1",
      "variable_remote_media_port: 40002",
      ""
    ].join("\\r\\n");
    const raw = ["Content-Type: text/event-plain", "Content-Length: " + Buffer.byteLength(body), "", ""].join("\\r\\n") + body;
    const bridge = new EslBridge({
      recordingDir: "/host/acc/media",
      freeswitchRecordingDir: "/var/log/freeswitch/acc/media",
      telephonyMode: "local_sip",
      rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream"
    });
    bridge.send = (command) => sent.push(command);
    bridge.options.accBaseUrl = "http://127.0.0.1:1";
    const http = await import("node:http");
    const { Writable, Readable } = await import("node:stream");
    const originalRequest = http.default.request;
    http.default.request = (options, callback) => {
      const req = new Writable({ write(chunk, encoding, done) { done(); } });
      req.on = req.addListener.bind(req);
      req.write = () => true;
      req.end = () => {
        const res = new Readable({ read() { this.push(JSON.stringify({ call: { session: { callId: "acc-call-streamed" } } })); this.push(null); } });
        res.statusCode = 200;
        res.setEncoding = () => res;
        callback(res);
      };
      return req;
    };
    try {
      await bridge.handleData(raw.slice(0, raw.length - 7));
      await bridge.handleData(raw.slice(raw.length - 7));
    } finally {
      http.default.request = originalRequest;
    }
    const playbackSummary = bridge.rtpPlaybackSink.summary();
    bridge.rtpPlaybackSocket?.close();
    console.log(JSON.stringify({ sent, call: bridge.callMap.get("fs-call-streamed"), playbackSummary, events: bridge.events }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const parsed = JSON.parse(stdout) as {
    sent: string[];
    call: { destination: string; wavPath: string; freeswitchPath: string; accCallId: string; remoteRtp: { address: string; port: number } };
    playbackSummary: { remoteHost: string; remotePort: number };
    events: Array<{ remoteRtpPlaybackTarget?: { address: string; port: number } }>;
  };
  assert.deepEqual(parsed.sent, ["api uuid_record fs-call-streamed start /var/log/freeswitch/acc/media/fs-call-streamed.wav"]);
  assert.equal(parsed.call.destination, "8600");
  assert.equal(parsed.call.wavPath, "/host/acc/media/fs-call-streamed.wav");
  assert.equal(parsed.call.freeswitchPath, "/var/log/freeswitch/acc/media/fs-call-streamed.wav");
  assert.equal(parsed.call.accCallId, "acc-call-streamed");
  assert.deepEqual(parsed.call.remoteRtp, { address: "127.0.0.1", port: 40002 });
  assert.equal(parsed.playbackSummary.remoteHost, "127.0.0.1");
  assert.equal(parsed.playbackSummary.remotePort, 40002);
  assert.equal(parsed.events.some((event) => event.remoteRtpPlaybackTarget?.port === 40002), true);
});

test("FreeSWITCH bridge subscribes to required ESL events with one event command", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const script = `
    const { EslBridge } = await import(${JSON.stringify(moduleUrl)});
    const sent = [];
    const bridge = new EslBridge({ password: "ClueCon" });
    bridge.send = (command) => sent.push(command);
    await bridge.handleBlock(["Content-Type: auth/request", "", ""].join("\\n"));
    console.log(JSON.stringify(sent));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const sent = JSON.parse(stdout) as string[];
  assert.deepEqual(sent, ["auth ClueCon", "event plain CHANNEL_ANSWER CHANNEL_HANGUP_COMPLETE RECORD_STOP"]);
});

test("FreeSWITCH ESL parser keeps malformed percent header values", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const script = `
    const { EslBridge } = await import(${JSON.stringify(moduleUrl)});
    const bridge = new EslBridge({});
    await bridge.handleBlock([
      "Content-Type: text/event-plain",
      "Event-Name: CHANNEL_ANSWER",
      "Caller-Caller-ID-Name: 100%+Ready",
      ""
    ].join("\\n"));
    console.log(JSON.stringify(bridge.events[0].headers));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const headers = JSON.parse(stdout) as { "Caller-Caller-ID-Name": string };
  assert.equal(headers["Caller-Caller-ID-Name"], "100%+Ready");
});

test("FreeSWITCH recording path maps host artifacts to a container-visible mount", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
  const script = `
    const { visibleRecordingPath } = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify(visibleRecordingPath("/workspace/repo/artifacts/freeswitch-live/media", "/var/log/freeswitch/acc", "fs-call-123")));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const paths = JSON.parse(stdout) as { hostPath: string; freeswitchPath: string };
  assert.equal(paths.hostPath, "/workspace/repo/artifacts/freeswitch-live/media/fs-call-123.wav");
  assert.equal(paths.freeswitchPath, "/var/log/freeswitch/acc/fs-call-123.wav");
});


test("FreeSWITCH bridge manifest carries discovered remote RTP target evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-remote-rtp-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(logPath, `${JSON.stringify({ events: [{ headers: { "Event-Name": "CHANNEL_ANSWER" } }] })}\n`, "utf8");
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ transcript: { text: "hello from local sip", final: true } })}\n`, "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-remote-rtp",
        accCallId: "demo-call-remote-rtp",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
        telephonyMode: "local_sip",
        remoteRtp: { address: "127.0.0.1", port: 40002 }
      });
      console.log(JSON.stringify(manifest.localSip.remoteRtp));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    assert.deepEqual(JSON.parse(stdout), { address: "127.0.0.1", port: 40002 });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("FreeSWITCH bridge manifest carries optional live RTP Pipecat batch evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-bridge-rtp-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(logPath, `${JSON.stringify({ events: [{ headers: { "Event-Name": "CHANNEL_ANSWER" } }] })}\n`, "utf8");
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ transcript: { text: "hello from local sip", final: true } })}\n`, "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { PipecatRtpFrameCollector, buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const collector = new PipecatRtpFrameCollector();
      collector.acceptPacket(Buffer.from(${JSON.stringify(rtpPacket([0xfe, 0x7e], 0x1000, 160))}), "2026-07-11T19:00:00.000Z");
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-rtp",
        accCallId: "demo-call-rtp",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
        telephonyMode: "local_sip",
        pipecatRtpEvidence: collector.summary()
      });
      console.log(JSON.stringify(manifest));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const manifest = JSON.parse(stdout) as {
      reviewReady: boolean;
      pipecatMediaEngine: {
        liveRtpAdapter: string;
        realtimeDirection: string;
        bidirectionalPlaybackReady: boolean;
        blocker: string;
        rtpFrameBatch: { liveRtpCaptured: boolean; packetCount: number };
      };
    };

    assert.equal(manifest.reviewReady, false);
    assert.equal(manifest.pipecatMediaEngine.liveRtpAdapter, "captured_pcmu_to_input_audio_frames");
    assert.equal(manifest.pipecatMediaEngine.realtimeDirection, "sip_rtp_inbound_to_pipecat_input_frames");
    assert.equal(manifest.pipecatMediaEngine.bidirectionalPlaybackReady, false);
    assert.match(manifest.pipecatMediaEngine.blocker, /not yet connected to the FreeSWITCH RTP playback socket/);
    assert.equal(manifest.pipecatMediaEngine.rtpFrameBatch.liveRtpCaptured, true);
    assert.equal(manifest.pipecatMediaEngine.rtpFrameBatch.packetCount, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("FreeSWITCH bridge manifest is bundle-compatible and blocks missing rtc-asr evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-bridge-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(logPath, `${JSON.stringify({ events: [{ headers: { "Event-Name": "CHANNEL_ANSWER" } }] })}\n`, "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-1",
        accCallId: "demo-call-0001",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        freeswitchRecordingPath: "/var/log/freeswitch/acc/media/fs-proof-1.wav",
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        telephonyMode: "local_sip"
      });
      console.log(JSON.stringify(manifest));
    `;

    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const manifest = JSON.parse(stdout) as {
      reviewReady: boolean;
      runtimeModeLabels: { telephony: string; media: string; rtcAsr: string; credentialsMode: string };
      localSip: { acceptedInvite: boolean; rtpPacketCount: number; destination: string; hostRecordingPath: string; freeswitchRecordingPath: string };
      artifacts: { audioWav: string; sipLog: string; rtcAsrEvidence: string | null };
      artifactIntegrity: Array<{ artifactId: string; readiness: string; sha256: string; sizeBytes: number }>;
      blockers: string[];
      reviewGate: { missingLabels: string[]; nextActions: string[] };
    };

    assert.equal(manifest.reviewReady, false);
    assert.deepEqual(manifest.runtimeModeLabels, {
      telephony: "local_sip",
      media: "live_capture",
      rtcAsr: "rtc_asr_live",
      credentialsMode: "mocked",
    });
    assert.equal(manifest.localSip.acceptedInvite, true);
    assert.equal(manifest.localSip.destination, "8600");
    assert.equal(manifest.localSip.rtpPacketCount, 4);
    assert.equal(manifest.localSip.hostRecordingPath, audioPath);
    assert.equal(manifest.localSip.freeswitchRecordingPath, "/var/log/freeswitch/acc/media/fs-proof-1.wav");
    assert.equal(manifest.artifacts.audioWav, audioPath);
    assert.equal(manifest.artifacts.sipLog, logPath);
    assert.equal(manifest.artifacts.rtcAsrEvidence, null);
    assert.equal(manifest.artifactIntegrity.length, 2);
    assert.ok(manifest.artifactIntegrity.every((artifact) => artifact.readiness === "ready"));
    assert.ok(manifest.artifactIntegrity.every((artifact) => artifact.sha256.match(/^[a-f0-9]{64}$/)));
    assert.ok(manifest.artifactIntegrity.every((artifact) => artifact.sizeBytes > 0));
    assert.deepEqual(manifest.reviewGate.missingLabels, []);
    assert.ok(manifest.blockers.some((blocker) => blocker.includes("no transcript/evidence path")));
    assert.deepEqual(manifest.reviewGate.nextActions, [
      "Attach rtc-asr transcript evidence with --rtc-asr-evidence before marking the FreeSWITCH proof review-ready.",
      "Send Kokoro/Pipecat RTP playback to the FreeSWITCH caller target before marking the proof review-ready.",
    ]);

    const bundleDir = path.join(tempDir, "bundle");
    const manifestPath = path.join(tempDir, "freeswitch-live-proof-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const bundle = await execFileAsync(
      process.execPath,
      ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", manifestPath, "--out-dir", bundleDir],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const bundleSummary = JSON.parse(bundle.stdout) as { reviewGatePassed: boolean; validationStatus: string };
    assert.equal(bundleSummary.reviewGatePassed, false);
    assert.equal(bundleSummary.validationStatus, "blocked_before_review");

    const bundleManifest = JSON.parse(await readFile(path.join(bundleDir, "proof-bundle-manifest.json"), "utf8")) as {
      artifacts: { audioCapture: string; sipLogs: string; rtcAsrEvidence: string | null };
      reviewGate: { failureReasons: Record<string, string> };
      validationSummary: { blockers: string[]; nextActions: string[] };
    };
    assert.equal(bundleManifest.artifacts.audioCapture, path.relative(repoRoot, audioPath).replaceAll(path.sep, "/"));
    assert.equal(bundleManifest.artifacts.sipLogs, path.relative(repoRoot, logPath).replaceAll(path.sep, "/"));
    assert.equal(bundleManifest.artifacts.rtcAsrEvidence, null);
    assert.ok(bundleManifest.validationSummary.blockers.some((blocker) => blocker.includes("no transcript/evidence path")));
    assert.match(bundleManifest.reviewGate.failureReasons.sourceManifestReviewReady, /Source live proof manifest is not review-ready/);
    assert.deepEqual(bundleManifest.validationSummary.nextActions, [
      "Attach rtc-asr transcript evidence with --rtc-asr-evidence before marking the FreeSWITCH proof review-ready.",
      "Send Kokoro/Pipecat RTP playback to the FreeSWITCH caller target before marking the proof review-ready.",
    ]);

    const invalidRtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence-empty.json");
    await writeFile(invalidRtcAsrEvidencePath, `${JSON.stringify({ transcript: "   ", final: true })}\n`, "utf8");
    const invalidEvidenceScript = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-invalid-evidence",
        accCallId: "demo-call-invalid-evidence",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(invalidRtcAsrEvidencePath)},
        telephonyMode: "local_sip"
      });
      console.log(JSON.stringify(manifest));
    `;
    const invalidEvidenceResult = await execFileAsync(process.execPath, ["--input-type=module", "--eval", invalidEvidenceScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const invalidEvidenceManifest = JSON.parse(invalidEvidenceResult.stdout) as typeof manifest;
    assert.equal(invalidEvidenceManifest.reviewReady, false);
    assert.ok(invalidEvidenceManifest.blockers.some((blocker) => blocker.includes("non-empty transcript")));
    assert.ok(invalidEvidenceManifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "blocked"));

    const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ transcript: { text: "hello from local sip", final: true } })}\n`, "utf8");
    const readyScript = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-2",
        accCallId: "demo-call-0002",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
        telephonyMode: "local_sip",
        remoteRtp: { address: "127.0.0.1", port: 40002 },
        pipecatOutboundRtpEvidence: {
          outboundRtpReady: true,
          rtpSocketSendReady: true,
          packetCount: 3,
          sentPacketCount: 3,
          remoteHost: "127.0.0.1",
          remotePort: 40002,
          totalDurationMs: 60,
          nextSequenceNumber: 3,
          nextTimestamp: 480,
          ssrc: 0xacc0ffee,
          lastSentAt: "2026-06-30T10:00:02.220Z",
          callerPlaybackConfirmed: true,
          callerPlaybackEvidencePath: "artifacts/freeswitch-live/caller-playback-proof.json"
        }
      });
      console.log(JSON.stringify(manifest));
    `;
    const readyResult = await execFileAsync(process.execPath, ["--input-type=module", "--eval", readyScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const readyManifest = JSON.parse(readyResult.stdout) as typeof manifest;
    assert.equal(readyManifest.reviewReady, true);
    assert.equal(readyManifest.artifacts.rtcAsrEvidence, rtcAsrEvidencePath);

    const socketOnlyScript = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-socket-only",
        accCallId: "demo-call-socket-only",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
        telephonyMode: "local_sip",
        remoteRtp: { address: "127.0.0.1", port: 40002 },
        pipecatOutboundRtpEvidence: {
          outboundRtpReady: true,
          rtpSocketSendReady: true,
          packetCount: 3,
          sentPacketCount: 3,
          remoteHost: "127.0.0.1",
          remotePort: 40002,
          totalDurationMs: 60,
          nextSequenceNumber: 3,
          nextTimestamp: 480,
          ssrc: 0xacc0ffee,
          lastSentAt: "2026-06-30T10:00:02.220Z"
        }
      });
      console.log(JSON.stringify(manifest));
    `;
    const socketOnlyResult = await execFileAsync(process.execPath, ["--input-type=module", "--eval", socketOnlyScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const socketOnlyManifest = JSON.parse(socketOnlyResult.stdout) as typeof manifest;
    assert.equal(socketOnlyManifest.reviewReady, false);
    assert.ok(socketOnlyManifest.blockers.some((blocker) => blocker.includes("caller-audible playback proof")));
    assert.ok(readyManifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "ready"));

    const readyBundleDir = path.join(tempDir, "ready-bundle");
    const readyManifestPath = path.join(tempDir, "freeswitch-ready-live-proof-manifest.json");
    await writeFile(readyManifestPath, `${JSON.stringify(readyManifest, null, 2)}\n`, "utf8");
    const readyBundle = await execFileAsync(
      process.execPath,
      ["scripts/live-sip-proof-bundle.mjs", "--live-manifest", readyManifestPath, "--out-dir", readyBundleDir],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const readyBundleSummary = JSON.parse(readyBundle.stdout) as { reviewGateReportJson: string; reviewGatePassed: boolean; validationStatus: string };
    assert.equal(readyBundleSummary.reviewGatePassed, true);
    assert.equal(readyBundleSummary.validationStatus, "ready_for_review");
    const readyBundleManifest = JSON.parse(await readFile(path.join(readyBundleDir, "proof-bundle-manifest.json"), "utf8")) as {
      artifacts: { rtcAsrEvidence: string | null };
      artifactIntegrity: Array<{ artifactId: string; readiness: string }>;
    };
    assert.equal(readyBundleManifest.artifacts.rtcAsrEvidence, path.relative(repoRoot, rtcAsrEvidencePath).replaceAll(path.sep, "/"));
    assert.ok(readyBundleManifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "ready"));
    assert.match(readyBundleSummary.reviewGateReportJson, /review-gate-report\.json$/);
    const readyReviewGateReport = JSON.parse(await readFile(path.join(readyBundleDir, "review-gate-report.json"), "utf8")) as {
      status: string;
      reviewGatePassed: boolean;
      missingLabels: string[];
      failureReasons: Record<string, string>;
      nextActions: string[];
    };
    assert.equal(readyReviewGateReport.status, "ready_for_review");
    assert.equal(readyReviewGateReport.reviewGatePassed, true);
    assert.deepEqual(readyReviewGateReport.missingLabels, []);
    assert.deepEqual(readyReviewGateReport.failureReasons, {});
    assert.deepEqual(readyReviewGateReport.nextActions, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("FreeSWITCH bridge forwards attached rtc-asr evidence to ACC", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-forward-rtc-asr-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");
  const manifestPath = path.join(tempDir, "freeswitch-live-proof-manifest.json");
  const receivedEvents: any[] = [];

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const http = require("node:http") as typeof import("node:http");
    const instance = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        receivedEvents.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, call: { session: { callId: "acc-call-123" } } }));
      });
    });
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(rtcAsrEvidencePath, `${JSON.stringify({ transcript: "I need billing help.", final: true })}\n`, "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { EslBridge } = await import(${JSON.stringify(moduleUrl)});
      const bridge = new EslBridge({
        accBaseUrl: ${JSON.stringify(`http://127.0.0.1:${(server.address() as any).port}`)},
        logPath: ${JSON.stringify(logPath)},
        manifestPath: ${JSON.stringify(manifestPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
        telephonyMode: "local_sip"
      });
      bridge.events = [{ at: "2026-06-30T10:00:00.000Z", headers: { "Event-Name": "CHANNEL_ANSWER" } }];
      bridge.callMap.set("fs-call-forward", {
        wavPath: ${JSON.stringify(audioPath)},
        freeswitchPath: ${JSON.stringify(audioPath)},
        startedAt: Date.now(),
        destination: "8600",
        accCallId: "acc-call-123"
      });
      await bridge.onRecordStop("fs-call-forward");
    `;
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    assert.equal(receivedEvents.some((event) => event.eventType === "media.capture"), true);
    const transcriptEvent = receivedEvents.find((event) => event.eventType === "media.transcript");
    assert.equal(transcriptEvent?.text ?? transcriptEvent?.transcript, "I need billing help.");
    assert.equal(transcriptEvent?.rtcAsrEvidencePath, rtcAsrEvidencePath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { reviewReady: boolean; blockers: string[] };
    assert.equal(manifest.reviewReady, false);
    assert.ok(manifest.blockers.some((blocker) => blocker.includes("caller playback RTP was not sent")));
  } finally {
    server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("FreeSWITCH bridge manifest accepts nested OpenAI realtime transcript evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-openai-realtime-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(logPath, `${JSON.stringify({ events: [{ headers: { "Event-Name": "CHANNEL_ANSWER" } }] })}\n`, "utf8");
    await writeFile(
      rtcAsrEvidencePath,
      `${JSON.stringify({
        type: "response.audio_transcript.done",
        delta: "hello from",
        response: {
          output: [
            { content: [{ type: "output_text", delta: "local sip" }] },
          ],
        },
      })}\n`,
      "utf8",
    );

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-openai-realtime",
        accCallId: "demo-call-openai-realtime",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
        telephonyMode: "local_sip",
        remoteRtp: { address: "127.0.0.1", port: 40002 },
        pipecatOutboundRtpEvidence: {
          outboundRtpReady: true,
          rtpSocketSendReady: true,
          packetCount: 3,
          sentPacketCount: 3,
          remoteHost: "127.0.0.1",
          remotePort: 40002,
          totalDurationMs: 60,
          nextSequenceNumber: 3,
          nextTimestamp: 480,
          ssrc: 0xacc0ffee,
          lastSentAt: "2026-06-30T10:00:02.220Z",
          callerPlaybackConfirmed: true,
          callerPlaybackEvidencePath: "artifacts/freeswitch-live/caller-playback-proof.json"
        }
      });
      console.log(JSON.stringify(manifest));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const manifest = JSON.parse(stdout) as {
      reviewReady: boolean;
      artifactIntegrity: Array<{ artifactId: string; readiness: string }>;
      blockers: string[];
    };
    assert.equal(manifest.reviewReady, true);
    assert.deepEqual(manifest.blockers, []);
    assert.ok(manifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "ready"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("FreeSWITCH bridge manifest accepts string-wrapped rtc-asr evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-wrapped-asr-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(logPath, JSON.stringify({ events: [{ headers: { "Event-Name": "CHANNEL_ANSWER" } }] }) + "\n", "utf8");
    await writeFile(rtcAsrEvidencePath, JSON.stringify({
      event: JSON.stringify({
        type: "response.audio_transcript.done",
        transcript: "wrapped local sip evidence",
      }),
    }) + "\n", "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-wrapped-asr",
        accCallId: "demo-call-wrapped-asr",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
        telephonyMode: "local_sip",
        remoteRtp: { address: "127.0.0.1", port: 40002 },
        pipecatOutboundRtpEvidence: {
          outboundRtpReady: true,
          rtpSocketSendReady: true,
          packetCount: 3,
          sentPacketCount: 3,
          remoteHost: "127.0.0.1",
          remotePort: 40002,
          totalDurationMs: 60,
          nextSequenceNumber: 3,
          nextTimestamp: 480,
          ssrc: 0xacc0ffee,
          lastSentAt: "2026-06-30T10:00:02.220Z",
          callerPlaybackConfirmed: true,
          callerPlaybackEvidencePath: "artifacts/freeswitch-live/caller-playback-proof.json"
        }
      });
      console.log(JSON.stringify(manifest));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const manifest = JSON.parse(stdout) as {
      reviewReady: boolean;
      blockers: string[];
    };
    assert.equal(manifest.reviewReady, true);
    assert.deepEqual(manifest.blockers, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("FreeSWITCH bridge manifest accepts wrapped channel ASR evidence", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-contact-center-fs-channel-asr-"));
  const audioPath = path.join(tempDir, "fs-call.wav");
  const logPath = path.join(tempDir, "freeswitch-esl-events.json");
  const rtcAsrEvidencePath = path.join(tempDir, "rtc-asr-evidence.json");

  try {
    await writeFile(audioPath, validWavFixture());
    await writeFile(logPath, JSON.stringify({ events: [{ headers: { "Event-Name": "CHANNEL_ANSWER" } }] }) + "\n", "utf8");
    await writeFile(rtcAsrEvidencePath, JSON.stringify({
      type: "Results",
      is_final: "true",
      results: { channels: [{ alternatives: [{ transcript: "hello from local sip" }] }] },
    }) + "\n", "utf8");

    const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts/freeswitch-acc-bridge.mjs")).href;
    const script = `
      const { buildFreeswitchLiveProofManifest } = await import(${JSON.stringify(moduleUrl)});
      const manifest = await buildFreeswitchLiveProofManifest({
        uuid: "fs-proof-channel-asr",
        accCallId: "demo-call-channel-asr",
        destination: "8600",
        wavPath: ${JSON.stringify(audioPath)},
        logPath: ${JSON.stringify(logPath)},
        rtcAsrUrl: "ws://127.0.0.1:8080/v1/stt/stream",
        rtcAsrEvidencePath: ${JSON.stringify(rtcAsrEvidencePath)},
        telephonyMode: "local_sip",
        remoteRtp: { address: "127.0.0.1", port: 40002 },
        pipecatOutboundRtpEvidence: {
          outboundRtpReady: true,
          rtpSocketSendReady: true,
          packetCount: 3,
          sentPacketCount: 3,
          remoteHost: "127.0.0.1",
          remotePort: 40002,
          totalDurationMs: 60,
          nextSequenceNumber: 3,
          nextTimestamp: 480,
          ssrc: 0xacc0ffee,
          lastSentAt: "2026-06-30T10:00:02.220Z",
          callerPlaybackConfirmed: true,
          callerPlaybackEvidencePath: "artifacts/freeswitch-live/caller-playback-proof.json"
        }
      });
      console.log(JSON.stringify(manifest));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const manifest = JSON.parse(stdout) as {
      reviewReady: boolean;
      artifactIntegrity: Array<{ artifactId: string; readiness: string }>;
      blockers: string[];
    };
    assert.equal(manifest.reviewReady, true);
    assert.deepEqual(manifest.blockers, []);
    assert.ok(manifest.artifactIntegrity.some((artifact) => artifact.artifactId === "rtc-asr-transcript-evidence" && artifact.readiness === "ready"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
