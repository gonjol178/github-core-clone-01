// pkt-line framing, the length-prefixed packet format the git smart-HTTP
// protocol is built from. A packet is four lowercase hex digits giving the
// total byte length including those digits, followed by the payload. Three
// lengths are control packets rather than data: 0000 flush, 0001 delimiter,
// 0002 response-end.

export const FLUSH = Buffer.alloc(0);
export const DELIM = Symbol('delim');
export const RESPEND = Symbol('respend');

export type PktItem = Buffer | typeof FLUSH | typeof DELIM | typeof RESPEND;

export function encodePkt(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  if (total > 0xffff) throw new Error(`pkt-line payload too large: ${body.length}`);
  const head = Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodeStream(parts: PktItem[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (part === FLUSH) chunks.push(encodeFlush());
    else if (part === DELIM) chunks.push(encodeDelim());
    else if (part === RESPEND) chunks.push(Buffer.from('0002', 'ascii'));
    else chunks.push(encodePkt(part));
  }
  return Buffer.concat(chunks);
}

/**
 * Parse a buffer of pkt-lines. Returns the packets in order (control packets
 * appear as the FLUSH/DELIM/RESPEND sentinels) plus whatever bytes followed
 * the final flush — receive-pack bodies carry a raw pack after the commands.
 */
export function parsePkts(buf: Buffer, startAt = 0): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let pos = startAt;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const lenText = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length: ${lenText}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      items.push(FLUSH);
      pos += 4;
      // A flush ends the packet stream; the remainder is raw data.
      return { items, rest: buf.subarray(pos) };
    }
    if (len === 1) {
      items.push(DELIM);
      pos += 4;
      continue;
    }
    if (len === 2) {
      items.push(RESPEND);
      pos += 4;
      continue;
    }
    if (len < 4) throw new Error(`pkt-line length too small: ${len}`);
    if (pos + len > buf.length) throw new Error('truncated pkt-line payload');
    items.push(Buffer.from(buf.subarray(pos + 4, pos + len)));
    pos += len;
  }
  return { items, rest: Buffer.alloc(0) };
}

/** Split one parsed stream into sections divided by delimiter packets. */
export function sectionsOf(items: PktItem[]): Buffer[][] {
  const sections: Buffer[][] = [[]];
  for (const item of items) {
    if (item === DELIM) sections.push([]);
    else if (Buffer.isBuffer(item)) sections[sections.length - 1].push(item);
  }
  return sections;
}

/** One packet's payload as text with a single trailing newline removed. */
export function pktText(pkt: Buffer): string {
  const text = pkt.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}
