export type PipecatInputAudioFrameFixture = {
  frameType: "InputAudioRawFrame";
  audioFormat: "pcm_s16le";
  sampleRateHz: 8000;
  channels: 1;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  pcm16: Buffer;
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

  return {
    frameType: "InputAudioRawFrame",
    audioFormat: "pcm_s16le",
    sampleRateHz: 8000,
    channels: 1,
    sequenceNumber: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    pcm16: decodePcmuToPcm16(packet.subarray(headerBytes, payloadEnd)),
  };
}
