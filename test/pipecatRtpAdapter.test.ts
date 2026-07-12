import test from "node:test";
import assert from "node:assert/strict";

import {
  decodePcmuSample,
  encodePcm16ToPcmu,
  pipecatOutputFrameToRtpPcmuPackets,
  rtpPcmuPacketToPipecatInputFrame,
  rtpPcmuPacketsToPipecatInputFrameBatch,
} from "../src/core/pipecatRtpAdapter";

function rtpPacket(payload: number[], sequenceNumber = 0x1234, timestamp = 0x00000320): Buffer {
  return Buffer.from([
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
  ]);
}

test("RTP PCMU packets decode into Pipecat-compatible PCM16 input frames", () => {
  const frame = rtpPcmuPacketToPipecatInputFrame(rtpPacket([0xfe, 0x7e, 0x80]));

  assert.equal(frame.frameType, "InputAudioRawFrame");
  assert.equal(frame.audioFormat, "pcm_s16le");
  assert.equal(frame.sampleRateHz, 8000);
  assert.equal(frame.channels, 1);
  assert.equal(frame.sequenceNumber, 0x1234);
  assert.equal(frame.timestamp, 800);
  assert.equal(frame.ssrc, 0xcafebabe);
  assert.equal(frame.durationMs, 0.375);
  assert.deepEqual(
    [frame.pcm16.readInt16LE(0), frame.pcm16.readInt16LE(2), frame.pcm16.readInt16LE(4)],
    [decodePcmuSample(0xfe), decodePcmuSample(0x7e), decodePcmuSample(0x80)],
  );
});

test("RTP PCMU adapter skips RTP extension headers and padding bytes", () => {
  const packet = rtpPacket([0xbe, 0xde, 0x00, 0x01, 0x99, 0x88, 0x77, 0x66, 0xfe, 0x7e, 0x00, 0x00, 0x03]);
  packet[0] = 0xb0;

  const frame = rtpPcmuPacketToPipecatInputFrame(packet);

  assert.equal(frame.pcm16.length, 4);
  assert.deepEqual(
    [frame.pcm16.readInt16LE(0), frame.pcm16.readInt16LE(2)],
    [decodePcmuSample(0xfe), decodePcmuSample(0x7e)],
  );
});

test("RTP PCMU adapter batches frames and reports sequence gaps before bridge handoff", () => {
  const batch = rtpPcmuPacketsToPipecatInputFrameBatch([
    rtpPacket([0xfe, 0x7e], 0xfffe, 160),
    rtpPacket([0xfe], 0xffff, 162),
    rtpPacket([0x7e], 0x0001, 163),
  ]);

  assert.equal(batch.frameType, "InputAudioRawFrameBatch");
  assert.equal(batch.packetCount, 3);
  assert.equal(batch.totalDurationMs, 0.5);
  assert.deepEqual(batch.frames.map((frame) => frame.sequenceNumber), [0xfffe, 0xffff, 0x0001]);
  assert.deepEqual(batch.sequenceGaps, [{ after: 0xffff, before: 0x0001 }]);
});

test("RTP PCMU adapter rejects non-PCMU and empty media packets before Pipecat handoff", () => {
  const nonPcmu = rtpPacket([0xff]);
  nonPcmu[1] = 0x08;
  assert.throws(() => rtpPcmuPacketToPipecatInputFrame(nonPcmu), /rtp_payload_type_not_pcmu/);
  assert.throws(() => rtpPcmuPacketToPipecatInputFrame(Buffer.from([0x80, 0x00])), /rtp_packet_too_short/);
  assert.throws(() => rtpPcmuPacketToPipecatInputFrame(rtpPacket([])), /rtp_payload_missing/);
});

test("RTP PCMU adapter rejects truncated extension bodies", () => {
  const packet = rtpPacket([0xbe, 0xde, 0x00, 0x02, 0x99, 0x88, 0x77, 0x66]);
  packet[0] = 0x90;

  assert.throws(() => rtpPcmuPacketToPipecatInputFrame(packet), /rtp_extension_body_truncated/);
});


test("Pipecat output PCM16 frames packetize into outbound RTP PCMU packets", () => {
  const pcm16 = Buffer.alloc(10);
  [0, 1200, -1200, 32000, -32000].forEach((sample, index) => pcm16.writeInt16LE(sample, index * 2));

  const packets = pipecatOutputFrameToRtpPcmuPackets(
    {
      frameType: "OutputAudioRawFrame",
      audioFormat: "pcm_s16le",
      sampleRateHz: 8000,
      channels: 1,
      pcm16,
    },
    { sequenceNumber: 0xfffe, timestamp: 0x00000320, ssrc: 0x0badf00d, markerFirstPacket: true, samplesPerPacket: 2 },
  );

  assert.equal(packets.length, 3);
  assert.deepEqual(packets.map((packet) => packet.readUInt16BE(2)), [0xfffe, 0xffff, 0x0000]);
  assert.deepEqual(packets.map((packet) => packet.readUInt32BE(4)), [800, 802, 804]);
  assert.deepEqual(packets.map((packet) => packet.readUInt32BE(8)), [0x0badf00d, 0x0badf00d, 0x0badf00d]);
  assert.deepEqual(packets.map((packet) => (packet[1] & 0x80) !== 0), [true, false, false]);
  assert.deepEqual([...Buffer.concat(packets.map((packet) => packet.subarray(12)))], [...encodePcm16ToPcmu(pcm16)]);
});

test("Pipecat TTS audio frames packetize into outbound RTP PCMU packets", () => {
  const pcm16 = Buffer.alloc(4);
  [0, -1200].forEach((sample, index) => pcm16.writeInt16LE(sample, index * 2));

  const packets = pipecatOutputFrameToRtpPcmuPackets(
    {
      frameType: "TTSAudioRawFrame",
      audioFormat: "pcm_s16le",
      sampleRateHz: 8000,
      channels: 1,
      pcm16,
    },
    { sequenceNumber: 10, timestamp: 160, ssrc: 0x0badf00d, samplesPerPacket: 2 },
  );

  assert.equal(packets.length, 1);
  assert.equal(packets[0].readUInt16BE(2), 10);
  assert.equal(packets[0].readUInt32BE(4), 160);
  assert.deepEqual([...packets[0].subarray(12)], [...encodePcm16ToPcmu(pcm16)]);
});

test("Pipecat output RTP packetizer rejects incompatible output audio", () => {
  const pcm16 = Buffer.from([0x00, 0x00]);
  assert.throws(
    () => pipecatOutputFrameToRtpPcmuPackets(
      { frameType: "OutputAudioRawFrame", audioFormat: "pcm_s16le", sampleRateHz: 16000 as 8000, channels: 1, pcm16 },
      { sequenceNumber: 1, timestamp: 1, ssrc: 1 },
    ),
    /pipecat_audio_format_not_pcm16_8khz_mono/,
  );
  assert.throws(() => encodePcm16ToPcmu(Buffer.from([0x00])), /pcm16_payload_invalid/);
});
