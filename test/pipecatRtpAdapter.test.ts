import test from "node:test";
import assert from "node:assert/strict";

import { decodePcmuSample, rtpPcmuPacketToPipecatInputFrame } from "../src/core/pipecatRtpAdapter";

function rtpPacket(payload: number[]): Buffer {
  return Buffer.from([
    0x80,
    0x00,
    0x12,
    0x34,
    0x00,
    0x00,
    0x03,
    0x20,
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
