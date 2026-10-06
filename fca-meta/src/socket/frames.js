"use strict";

const FRAME_TYPE = {
  EMPTY: 2,
  DRAIN: 3,
  DEAUTH: 4,
  DEPRECATED_ESTAB_STREAM: 5,
  DEPRECATED_DATA: 6,
  SMALL_ACK: 7,
  DEPRECATED_END_OF_DATA: 8,
  PING: 9,
  PONG: 10,
  ACK: 12,
  DATA: 13,
  END_OF_DATA: 14,
  ESTAB_STREAM: 15,
  END_OF_DATA_WITH_REASON: 16,
  EXTENDED_DATA: 17,
};

const MAX_STREAM_ID = 65535;

function readUInt24LE(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

function writeUInt24LE(buf, value, offset) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
}

function checkFrameType(buf) {
  return buf[0];
}

function decodeFrame(buf) {
  const type = buf[0];
  switch (type) {
    case FRAME_TYPE.DRAIN: {
      if (buf.length < 5) return { frame: null, rest: Buffer.alloc(0) };
      return { frame: { type, reason: buf[4] }, rest: buf.slice(5) };
    }
    case FRAME_TYPE.DEAUTH:
      return { frame: { type }, rest: buf.slice(1) };
    case FRAME_TYPE.PING:
      return { frame: { type }, rest: buf.slice(1) };
    case FRAME_TYPE.PONG:
      return { frame: { type }, rest: buf.slice(1) };
    case FRAME_TYPE.ACK: {
      if (buf.length < 8) return { frame: null, rest: Buffer.alloc(0) };
      const streamID = buf.readUInt16LE(1);
      const ackID = buf.readUInt16LE(6);
      return { frame: { type, streamID, ackID }, rest: buf.slice(8) };
    }
    case FRAME_TYPE.DATA:
    case FRAME_TYPE.EXTENDED_DATA: {
      if (buf.length < 8) return { frame: null, rest: Buffer.alloc(0) };
      const streamID = buf.readUInt16LE(1);
      const length = readUInt24LE(buf, 3);
      const headerSize = type === FRAME_TYPE.EXTENDED_DATA ? 9 : 8;
      if (length < headerSize - 6 || buf.length < 6 + length) return { frame: null, rest: Buffer.alloc(0) };
      const ackID = buf.readUInt16LE(6) & 0x7fff;
      const requiresAck = (buf[7] & 0x80) > 0;
      const contentType = type === FRAME_TYPE.EXTENDED_DATA ? buf[8] : undefined;
      const payload = buf.slice(headerSize, 6 + length);
      return { frame: { type, streamID, ackID, requiresAck, contentType, payload }, rest: buf.slice(6 + length) };
    }
    case FRAME_TYPE.ESTAB_STREAM: {
      if (buf.length < 6) return { frame: null, rest: Buffer.alloc(0) };
      const streamID = buf.readUInt16LE(1);
      const length = readUInt24LE(buf, 3);
      if (buf.length < 6 + length) return { frame: null, rest: Buffer.alloc(0) };
      return { frame: { type, streamID, parameters: buf.slice(6, 6 + length) }, rest: buf.slice(6 + length) };
    }
    case FRAME_TYPE.END_OF_DATA: {
      if (buf.length < 3) return { frame: null, rest: Buffer.alloc(0) };
      const streamID = buf.readUInt16LE(1);
      return { frame: { type, streamID }, rest: buf.slice(3) };
    }
    case FRAME_TYPE.END_OF_DATA_WITH_REASON: {
      if (buf.length < 7) return { frame: null, rest: Buffer.alloc(0) };
      const streamID = buf.readUInt16LE(1);
      const length = readUInt24LE(buf, 3);
      if (length < 1) return { frame: null, rest: Buffer.alloc(0) };
      return { frame: { type, streamID, reason: buf[6] }, rest: buf.slice(6 + length) };
    }
    default:
      return { frame: { type, raw: buf }, rest: Buffer.alloc(0) };
  }
}

function encodePing() {
  return Buffer.from([FRAME_TYPE.PING]);
}

function encodePong() {
  return Buffer.from([FRAME_TYPE.PONG]);
}

function encodeEndOfData(streamID) {
  const buf = Buffer.alloc(3);
  buf[0] = FRAME_TYPE.END_OF_DATA;
  buf.writeUInt16LE(streamID, 1);
  return buf;
}

function encodeAck(streamID, ackID) {
  const buf = Buffer.alloc(8);
  buf[0] = FRAME_TYPE.ACK;
  buf.writeUInt16LE(streamID, 1);
  writeUInt24LE(buf, 2, 3);
  buf.writeUInt16LE(ackID, 6);
  return buf;
}

function encodeEstablishStream(streamID, parameters) {
  const params = Buffer.isBuffer(parameters) ? parameters : Buffer.from(JSON.stringify(parameters || {}));
  const buf = Buffer.alloc(6 + params.length);
  buf[0] = FRAME_TYPE.ESTAB_STREAM;
  buf.writeUInt16LE(streamID, 1);
  writeUInt24LE(buf, params.length, 3);
  params.copy(buf, 6);
  return buf;
}

function encodeDataFrame(streamID, payload, { requiresAck = false, ackID = 0, extended = false, contentType = 0 } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");
  const headerSize = extended ? 9 : 8;
  const buf = Buffer.alloc(headerSize + body.length);
  buf[0] = extended ? FRAME_TYPE.EXTENDED_DATA : FRAME_TYPE.DATA;
  buf.writeUInt16LE(streamID, 1);
  writeUInt24LE(buf, headerSize - 6 + body.length, 3);
  buf.writeUInt16LE(ackID & 0x7fff, 6);
  if (requiresAck) buf[7] |= 0x80;
  if (extended) buf[8] = contentType;
  body.copy(buf, headerSize);
  return buf;
}

module.exports = {
  FRAME_TYPE,
  MAX_STREAM_ID,
  checkFrameType,
  decodeFrame,
  encodePing,
  encodePong,
  encodeAck,
  encodeEndOfData,
  encodeEstablishStream,
  encodeDataFrame,
};
