export type PipecatInputAudioFrameFixture = {
  frameType: "InputAudioRawFrame";
  audioFormat: "pcm_s16le";
  sampleRateHz: 8000;
  channels: 1;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  durationMs: number;
  pcm16: Buffer;
};

export type PipecatRtpFrameBatch = {
  frameType: "InputAudioRawFrameBatch";
  audioFormat: "pcm_s16le";
  sampleRateHz: 8000;
  channels: 1;
  packetCount: number;
  totalDurationMs: number;
  frames: PipecatInputAudioFrameFixture[];
  sequenceGaps: Array<{ after: number; before: number }>;
};

export type PipecatOutputAudioFrameFixture = {
  frameType: "OutputAudioRawFrame" | "TTSAudioRawFrame";
  audioFormat: "pcm_s16le";
  sampleRateHz: 8000;
  channels: 1;
  pcm16: Buffer;
};

export type RtpPcmuPacketizeOptions = {
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  markerFirstPacket?: boolean;
  samplesPerPacket?: number;
};

export function decodePcmuSample(sample: number): number {
  const inverted = (~sample) & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude -= 0x84;
  return sign ? -magnitude : magnitude;
}

export function decodePcmuToPcm16(payload: Buffer): Buffer {
  const pcm16 = Buffer.alloc(payload.length * 2);
  payload.forEach((sample, index) => pcm16.writeInt16LE(decodePcmuSample(sample), index * 2));
  return pcm16;
}

export function encodePcm16SampleToPcmu(sample: number): number {
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

export function encodePcm16ToPcmu(pcm16: Buffer): Buffer {
  if (pcm16.length === 0 || pcm16.length % 2 !== 0) {
    throw new Error("pcm16_payload_invalid");
  }
  const pcmu = Buffer.alloc(pcm16.length / 2);
  for (let offset = 0; offset < pcm16.length; offset += 2) {
    pcmu[offset / 2] = encodePcm16SampleToPcmu(pcm16.readInt16LE(offset));
  }
  return pcmu;
}

export function pipecatOutputFrameToRtpPcmuPackets(
  frame: PipecatOutputAudioFrameFixture,
  options: RtpPcmuPacketizeOptions,
): Buffer[] {
  if (frame.frameType !== "OutputAudioRawFrame" && frame.frameType !== "TTSAudioRawFrame") {
    throw new Error("pipecat_frame_type_not_output_audio");
  }
  if (frame.audioFormat !== "pcm_s16le" || frame.sampleRateHz !== 8000 || frame.channels !== 1) {
    throw new Error("pipecat_audio_format_not_pcm16_8khz_mono");
  }
  const samplesPerPacket = options.samplesPerPacket ?? 160;
  if (!Number.isInteger(samplesPerPacket) || samplesPerPacket <= 0) {
    throw new Error("rtp_samples_per_packet_invalid");
  }

  const pcmu = encodePcm16ToPcmu(frame.pcm16);
  const packets: Buffer[] = [];
  for (let payloadOffset = 0; payloadOffset < pcmu.length; payloadOffset += samplesPerPacket) {
    const payload = pcmu.subarray(payloadOffset, payloadOffset + samplesPerPacket);
    const packet = Buffer.alloc(12 + payload.length);
    packet[0] = 0x80;
    packet[1] = options.markerFirstPacket === true && packets.length === 0 ? 0x80 : 0x00;
    packet.writeUInt16BE((options.sequenceNumber + packets.length) & 0xffff, 2);
    packet.writeUInt32BE((options.timestamp + payloadOffset) >>> 0, 4);
    packet.writeUInt32BE(options.ssrc >>> 0, 8);
    payload.copy(packet, 12);
    packets.push(packet);
  }
  return packets;
}

export function rtpPcmuPacketToPipecatInputFrame(packet: Buffer): PipecatInputAudioFrameFixture {
  if (packet.length < 12) {
    throw new Error("rtp_packet_too_short");
  }

  const version = packet[0] >> 6;
  const hasPadding = (packet[0] & 0x20) !== 0;
  const hasExtension = (packet[0] & 0x10) !== 0;
  const csrcCount = packet[0] & 0x0f;
  const payloadType = packet[1] & 0x7f;
  let headerBytes = 12 + csrcCount * 4;
  if (version !== 2) {
    throw new Error("rtp_version_unsupported");
  }
  if (payloadType !== 0) {
    throw new Error("rtp_payload_type_not_pcmu");
  }
  if (packet.length < headerBytes) {
    throw new Error("rtp_header_truncated");
  }

  if (hasExtension) {
    if (packet.length < headerBytes + 4) {
      throw new Error("rtp_extension_header_truncated");
    }
    const extensionLengthBytes = packet.readUInt16BE(headerBytes + 2) * 4;
    if (packet.length < headerBytes + 4 + extensionLengthBytes) {
      throw new Error("rtp_extension_body_truncated");
    }
    headerBytes += 4 + extensionLengthBytes;
  }

  let payloadEnd = packet.length;
  if (hasPadding) {
    const paddingBytes = packet[packet.length - 1];
    if (paddingBytes === 0 || paddingBytes > packet.length - headerBytes) {
      throw new Error("rtp_padding_invalid");
    }
    payloadEnd -= paddingBytes;
  }

  if (payloadEnd <= headerBytes) {
    throw new Error("rtp_payload_missing");
  }

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
    pcm16: decodePcmuToPcm16(payload),
  };
}

export function rtpPcmuPacketsToPipecatInputFrameBatch(packets: Buffer[]): PipecatRtpFrameBatch {
  if (packets.length === 0) {
    throw new Error("rtp_packet_batch_empty");
  }

  const frames = packets.map((packet) => rtpPcmuPacketToPipecatInputFrame(packet));
  const sequenceGaps: Array<{ after: number; before: number }> = [];
  frames.forEach((frame, index) => {
    if (index === 0) return;
    const previous = frames[index - 1];
    const expected = (previous.sequenceNumber + 1) & 0xffff;
    if (frame.sequenceNumber !== expected) {
      sequenceGaps.push({ after: previous.sequenceNumber, before: frame.sequenceNumber });
    }
  });

  return {
    frameType: "InputAudioRawFrameBatch",
    audioFormat: "pcm_s16le",
    sampleRateHz: 8000,
    channels: 1,
    packetCount: frames.length,
    totalDurationMs: frames.reduce((total, frame) => total + frame.durationMs, 0),
    frames,
    sequenceGaps,
  };
}
