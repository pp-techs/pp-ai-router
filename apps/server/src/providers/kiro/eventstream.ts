// Adapted from lidge-jun/opencodex (MIT)
import { crc32 } from "node:zlib";

/**
 * `application/vnd.amazon.eventstream` decoder. Wire format (big-endian):
 *
 *   [total length u32][headers length u32][prelude CRC32 u32][headers][payload][message CRC32 u32]
 *
 * The prelude CRC covers the first 8 bytes, the message CRC everything before itself. Headers are a
 * sequence of `[name length u8][name][value type u8][value ...]`.
 */

const PRELUDE_LEN = 8;
const HEADER_BLOCK_OFFSET = PRELUDE_LEN + 4;
const MESSAGE_CRC_LEN = 4;
const MIN_MESSAGE_LEN = HEADER_BLOCK_OFFSET + MESSAGE_CRC_LEN;
const MAX_MESSAGE_LEN = 16 * 1024 * 1024;
const MAX_HEADERS_LEN = 128 * 1024;

export interface EventStreamMessage {
  /** Header values stringified; casing preserved (`:event-type`, `:message-type`, ...). */
  headers: Record<string, string>;
  payload: Uint8Array;
}

/** Decodes one fully buffered frame. Throws on malformed framing or a CRC mismatch. */
export function decodeMessage(frame: Buffer): EventStreamMessage {
  if (frame.length < MIN_MESSAGE_LEN) throw new Error("eventstream: frame too short");
  const total = frame.readUInt32BE(0);
  if (total !== frame.length)
    throw new Error(`eventstream: framed length ${total} != buffer ${frame.length}`);
  if (total > MAX_MESSAGE_LEN)
    throw new Error(`eventstream: total length ${total} exceeds maximum`);
  const headersLen = frame.readUInt32BE(4);
  if (crc32(frame.subarray(0, PRELUDE_LEN)) !== frame.readUInt32BE(8))
    throw new Error("eventstream: prelude CRC mismatch");
  if (headersLen > MAX_HEADERS_LEN)
    throw new Error(`eventstream: headers length ${headersLen} exceeds maximum`);
  if (headersLen > total - MIN_MESSAGE_LEN)
    throw new Error("eventstream: headers length exceeds frame payload");
  if (
    crc32(frame.subarray(0, total - MESSAGE_CRC_LEN)) !==
    frame.readUInt32BE(total - MESSAGE_CRC_LEN)
  )
    throw new Error("eventstream: message CRC mismatch");

  return {
    headers: parseHeaders(frame.subarray(HEADER_BLOCK_OFFSET, HEADER_BLOCK_OFFSET + headersLen)),
    payload: frame.subarray(HEADER_BLOCK_OFFSET + headersLen, total - MESSAGE_CRC_LEN),
  };
}

function parseHeaders(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  const need = (n: number, what: string) => {
    if (p + n > buf.length) throw new Error(`eventstream: truncated header ${what}`);
  };
  while (p < buf.length) {
    need(1, "name length");
    const nameLen = buf.readUInt8(p++);
    need(nameLen, "name");
    const name = buf.toString("utf8", p, p + nameLen);
    p += nameLen;
    need(1, "type");
    const type = buf.readUInt8(p++);
    switch (type) {
      case 0:
        out[name] = "true";
        break;
      case 1:
        out[name] = "false";
        break;
      case 2:
        need(1, "byte value");
        out[name] = String(buf.readInt8(p));
        p += 1;
        break;
      case 3:
        need(2, "short value");
        out[name] = String(buf.readInt16BE(p));
        p += 2;
        break;
      case 4:
        need(4, "integer value");
        out[name] = String(buf.readInt32BE(p));
        p += 4;
        break;
      case 5:
        need(8, "long value");
        out[name] = buf.readBigInt64BE(p).toString();
        p += 8;
        break;
      case 6:
      case 7: {
        need(2, "value length");
        const len = buf.readUInt16BE(p);
        p += 2;
        need(len, "value");
        out[name] =
          type === 6 ? buf.toString("base64", p, p + len) : buf.toString("utf8", p, p + len);
        p += len;
        break;
      }
      case 8:
        need(8, "timestamp value");
        out[name] = new Date(Number(buf.readBigInt64BE(p))).toISOString();
        p += 8;
        break;
      case 9: {
        need(16, "uuid value");
        const hex = buf.toString("hex", p, p + 16);
        out[name] =
          `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        p += 16;
        break;
      }
      default:
        throw new Error(`eventstream: unknown header value type ${type}`);
    }
  }
  return out;
}

/** Yields complete frames from a response body, whatever the chunk boundaries. */
export async function* decodeEventStream(
  source: ReadableStream<Uint8Array>,
): AsyncGenerator<EventStreamMessage> {
  let buf: Buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    buf = buf.length === 0 ? incoming : Buffer.concat([buf, incoming]);
    let offset = 0;
    while (buf.length - offset >= 4) {
      const total = buf.readUInt32BE(offset);
      if (total < MIN_MESSAGE_LEN)
        throw new Error(`eventstream: total length ${total} below minimum`);
      if (total > MAX_MESSAGE_LEN)
        throw new Error(`eventstream: total length ${total} exceeds maximum`);
      // Fail on a corrupt prelude as soon as it is complete instead of waiting for a bogus frame length to fill.
      if (
        buf.length - offset >= HEADER_BLOCK_OFFSET &&
        crc32(buf.subarray(offset, offset + PRELUDE_LEN)) !== buf.readUInt32BE(offset + 8)
      )
        throw new Error("eventstream: prelude CRC mismatch");
      if (buf.length - offset < total) break;
      yield decodeMessage(buf.subarray(offset, offset + total));
      offset += total;
    }
    buf = buf.subarray(offset);
  }
  if (buf.length > 0) throw new Error("eventstream: truncated message at end of stream");
}
