// Packfiles: reading packs that arrive over receive-pack (plain entries plus
// ofs-delta and ref-delta chains, including thin packs whose bases live in
// the local store) and writing packs for upload-pack fetches, with simple
// delta compression against earlier same-type objects in the same pack.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  hashObject,
  parseCommit,
  parseTag,
  peelToCommit,
} from './git.ts';
import type { ObjectStore, ObjectType } from './git.ts';

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OFS_DELTA = 6;
const REF_DELTA = 7;

// ------------------------------------------------------------------- deltas

/** Apply a git delta buffer to a base body. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} vs ${base.length}`);
  const targetSize = readVarint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= delta[pos] << (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= delta[pos] << (8 * bit);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      chunks.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${out.length}, expected ${targetSize}`);
  }
  return out;
}

function writeVarint(out: number[], value: number): void {
  let rest = value;
  for (;;) {
    const byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest === 0) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

/**
 * Build a delta that turns `base` into `target`: copy the shared prefix,
 * insert (or copy a matching chunk of) the changed middle, copy the shared
 * suffix. Good enough for the append-heavy revisions this forge serves.
 */
export function createDelta(base: Buffer, target: Buffer): Buffer {
  let prefix = 0;
  const prefixCap = Math.min(base.length, target.length);
  while (prefix < prefixCap && base[prefix] === target[prefix]) prefix += 1;
  let suffix = 0;
  const suffixCap = Math.min(base.length - prefix, target.length - prefix);
  while (
    suffix < suffixCap &&
    base[base.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const bytes: number[] = [];
  writeVarint(bytes, base.length);
  writeVarint(bytes, target.length);
  const emitCopy = (offset: number, size: number): void => {
    let remaining = size;
    let at = offset;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 0xffffff);
      let op = 0x80;
      const args: number[] = [];
      for (let bit = 0; bit < 4; bit += 1) {
        const byte = (at >> (8 * bit)) & 0xff;
        if (byte !== 0) {
          op |= 1 << bit;
          args.push(byte);
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        const byte = (chunk >> (8 * bit)) & 0xff;
        if (byte !== 0 || (bit === 2 && chunk === 0x10000)) {
          op |= 0x10 << bit;
          args.push(byte);
        }
      }
      bytes.push(op, ...args);
      at += chunk;
      remaining -= chunk;
    }
  };
  const emitInsert = (data: Buffer): void => {
    let at = 0;
    while (at < data.length) {
      const chunk = Math.min(data.length - at, 0x7f);
      bytes.push(chunk);
      for (let i = 0; i < chunk; i += 1) bytes.push(data[at + i]);
      at += chunk;
    }
  };
  if (prefix > 0) emitCopy(0, prefix);
  const midTarget = target.subarray(prefix, target.length - suffix);
  if (midTarget.length > 0) {
    // Try to find the middle inside the base's middle as one copy; fall back
    // to literal insertion when it does not occur there.
    const midBase = base.subarray(prefix, base.length - suffix);
    const found = midTarget.length <= midBase.length ? midBase.indexOf(midTarget) : -1;
    if (found >= 0) emitCopy(prefix + found, midTarget.length);
    else emitInsert(midTarget);
  }
  if (suffix > 0) emitCopy(base.length - suffix, suffix);
  return Buffer.from(bytes);
}

// -------------------------------------------------------------- pack reading

export interface ParsedEntry {
  oid: string;
  type: ObjectType;
  body: Buffer;
}

interface RawEntry {
  typeCode: number;
  /** Inflated payload (raw body for plain entries, delta bytes for deltas). */
  data: Buffer;
  ofsBaseIndex: number;
  refBase: string | null;
}

/**
 * Parse a whole pack. Delta bases may come from earlier in the pack or, for
 * thin packs, from `store`. Returns the resolved objects; the pack trailer
 * checksum is verified.
 */
export function parsePack(store: ObjectStore, pack: Buffer): ParsedEntry[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack signature missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  let pos = 12;
  const raw: RawEntry[] = [];
  const entryOffsets: number[] = [];
  const indexByOid = new Map<string, number>();
  for (let i = 0; i < count; i += 1) {
    const entryStart = pos;
    let byte = pack[pos];
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let ofsBaseIndex = -1;
    let refBase: string | null = null;
    if (typeCode === OFS_DELTA) {
      byte = pack[pos];
      pos += 1;
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      const basePos = entryStart - offset;
      const found = raw.findIndex((_, idx) => entryOffsets[idx] === basePos);
      ofsBaseIndex = found;
      if (found === -1) throw new Error('ofs-delta base not in pack');
    } else if (typeCode === REF_DELTA) {
      refBase = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateSync(pack.subarray(pos), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesRead: number };
    };
    pos += inflated.engine.bytesRead;
    if (inflated.buffer.length !== size) {
      throw new Error(`pack entry size mismatch: header ${size}, inflated ${inflated.buffer.length}`);
    }
    entryOffsets.push(entryStart);
    raw.push({ typeCode, data: inflated.buffer, ofsBaseIndex, refBase });
  }
  // Plain entries can be identified immediately; register them so ref-delta
  // entries pointing at an in-pack base resolve without touching the store.
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (entry.typeCode !== OFS_DELTA && entry.typeCode !== REF_DELTA) {
      const type = CODE_TYPES[entry.typeCode];
      if (type) indexByOid.set(hashObject(type, entry.data), i);
    }
  }
  // Resolve deltas (possibly chained) with memoization.
  const resolved: (ParsedEntry | null)[] = raw.map(() => null);
  const resolve = (index: number): ParsedEntry => {
    const done = resolved[index];
    if (done) return done;
    const entry = raw[index];
    let result: ParsedEntry;
    if (entry.typeCode === OFS_DELTA || entry.typeCode === REF_DELTA) {
      let baseType: ObjectType;
      let baseBody: Buffer;
      if (entry.typeCode === OFS_DELTA) {
        const base = resolve(entry.ofsBaseIndex);
        baseType = base.type;
        baseBody = base.body;
      } else {
        const inPack = indexByOid.get(entry.refBase as string);
        if (inPack !== undefined) {
          const base = resolve(inPack);
          baseType = base.type;
          baseBody = base.body;
        } else {
          const stored = store.get(entry.refBase as string);
          if (!stored) throw new Error(`ref-delta base ${entry.refBase} not available`);
          baseType = stored.type;
          baseBody = stored.body;
        }
      }
      const body = applyDelta(baseBody, entry.data);
      result = { oid: '', type: baseType, body };
    } else {
      const type = CODE_TYPES[entry.typeCode];
      if (!type) throw new Error(`unknown pack object type ${entry.typeCode}`);
      result = { oid: '', type, body: entry.data };
    }
    result.oid = hashObject(result.type, result.body);
    indexByOid.set(result.oid, index);
    resolved[index] = result;
    return result;
  };
  const out: ParsedEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) out.push(resolve(i));
  return out;
}

// -------------------------------------------------------------- pack writing

interface PackCandidate {
  oid: string;
  type: ObjectType;
  body: Buffer;
}

function encodeObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let rest = size;
  let first = (typeCode << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

function encodeOfsOffset(distance: number): Buffer {
  const bytes: number[] = [distance & 0x7f];
  let rest = Math.floor(distance / 128);
  while (rest > 0) {
    rest -= 1;
    bytes.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return Buffer.from(bytes);
}

/**
 * Serialize objects into a packfile. Within a small window of earlier
 * same-type entries, an object is delta-compressed when the delta clearly
 * beats storing the object whole.
 */
export function buildPack(entries: PackCandidate[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  chunks.push(header);
  let written = 12;
  const positions: number[] = [];
  const window: { index: number; type: ObjectType; body: Buffer }[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    let bestDelta: Buffer | null = null;
    let bestBase = -1;
    if (entry.body.length >= 32) {
      for (const prior of window) {
        if (prior.type !== entry.type) continue;
        const ratio = prior.body.length / entry.body.length;
        if (ratio < 0.4 || ratio > 2.5) continue;
        const delta = createDelta(prior.body, entry.body);
        if (delta.length + 10 < entry.body.length && (bestDelta === null || delta.length < bestDelta.length)) {
          bestDelta = delta;
          bestBase = prior.index;
        }
      }
    }
    positions.push(written);
    if (bestDelta !== null && bestBase >= 0) {
      const distance = written - positions[bestBase];
      const head = encodeObjectHeader(OFS_DELTA, bestDelta.length);
      const ofs = encodeOfsOffset(distance);
      const packed = deflateSync(bestDelta);
      chunks.push(head, ofs, packed);
      written += head.length + ofs.length + packed.length;
    } else {
      const head = encodeObjectHeader(TYPE_CODES[entry.type], entry.body.length);
      const packed = deflateSync(entry.body);
      chunks.push(head, packed);
      written += head.length + packed.length;
    }
    window.push({ index: i, type: entry.type, body: entry.body });
    if (window.length > 12) window.shift();
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** A valid pack with zero objects (header + trailer), 32 bytes. */
export function emptyPack(): Buffer {
  return buildPack([]);
}

// --------------------------------------------------------- fetch set planning

const treeClosureCache = new WeakMap<ObjectStore, Map<string, string[]>>();

/** Every object under a tree (subtrees and files), including the tree itself. */
export function treeClosure(store: ObjectStore, treeOid: string): string[] {
  let perStore = treeClosureCache.get(store);
  if (!perStore) {
    perStore = new Map();
    treeClosureCache.set(store, perStore);
  }
  const cached = perStore.get(treeOid);
  if (cached) return cached;
  const out: string[] = [];
  const visit = (oid: string): void => {
    const obj = store.get(oid);
    if (!obj || obj.type !== 'tree') return;
    out.push(oid);
    const text = obj.body;
    let pos = 0;
    while (pos < text.length) {
      const space = text.indexOf(0x20, pos);
      const mode = text.toString('ascii', pos, space);
      const nul = text.indexOf(0x00, space + 1);
      const child = text.toString('hex', nul + 1, nul + 21);
      if (mode === '40000') visit(child);
      else if (mode !== '160000') out.push(child);
      pos = nul + 21;
    }
  };
  visit(treeOid);
  perStore.set(treeOid, out);
  return out;
}

export interface FetchPlan {
  /** Object ids to pack, commits first then trees/blobs in discovery order. */
  objects: string[];
  /** Commits at the shallow boundary to report as `shallow`. */
  shallow: string[];
  /** Client-shallow commits to report as `unshallow`. */
  unshallow: string[];
}

/**
 * Decide what a fetch sends: the closure of the wants minus the closure of
 * the haves. The client's shallow commits are treated as parentless when the
 * have-closure is computed, mirroring what the client itself believes.
 */
export function planFetch(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  clientShallow: ReadonlySet<string>,
  depth: number | null,
): FetchPlan {
  // Objects the client provably has: closure of haves, not crossing the
  // parents of commits the client lists as shallow.
  const have = new Set<string>();
  const addHaveTree = (treeOid: string): void => {
    for (const oid of treeClosure(store, treeOid)) have.add(oid);
  };
  const haveQueue: string[] = [];
  for (const oid of haves) {
    const start = peelToCommit(store, oid);
    if (start && !have.has(start)) {
      have.add(start);
      haveQueue.push(start);
    } else if (store.has(oid)) {
      have.add(oid);
    }
  }
  while (haveQueue.length > 0) {
    const oid = haveQueue.pop() as string;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    addHaveTree(parseCommit(obj.body).tree);
    if (clientShallow.has(oid)) continue;
    for (const parent of parseCommit(obj.body).parents) {
      if (!have.has(parent)) {
        have.add(parent);
        haveQueue.push(parent);
      }
    }
  }
  for (const oid of haves) {
    const obj = store.get(oid);
    if (obj && obj.type === 'tag') {
      // A have naming a tag gives the client the tag and its target chain.
      let current = oid;
      for (let hops = 0; hops < 32; hops += 1) {
        const found = store.get(current);
        if (!found) break;
        have.add(current);
        if (found.type !== 'tag') break;
        current = parseTag(found.body).object;
      }
    }
  }

  // Distances of commits from the wants (tags drape over their commit at 0).
  const distance = new Map<string, number>();
  const extraRoots: string[] = []; // tag objects themselves, always included
  let frontier: string[] = [];
  for (const oid of wants) {
    const obj = store.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extraRoots.push(oid);
      const target = peelToCommit(store, oid);
      if (target && !distance.has(target)) {
        distance.set(target, 0);
        frontier.push(target);
      }
    } else if (obj.type === 'commit') {
      if (!distance.has(oid)) {
        distance.set(oid, 0);
        frontier.push(oid);
      }
    } else {
      extraRoots.push(oid);
    }
  }
  let step = 0;
  while (frontier.length > 0) {
    step += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      const obj = store.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.body).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, step);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }

  const included = new Set<string>();
  const shallow: string[] = [];
  for (const [oid, dist] of distance) {
    if (depth !== null && dist >= depth) continue;
    included.add(oid);
    if (depth !== null && dist === depth - 1) {
      const obj = store.get(oid);
      if (obj && obj.type === 'commit') {
        const parents = parseCommit(obj.body).parents;
        if (parents.some((p) => store.has(p) && !included.has(p))) shallow.push(oid);
      }
    }
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (included.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
  }

  const objects: string[] = [];
  const emitted = new Set<string>();
  const emit = (oid: string): void => {
    if (emitted.has(oid) || have.has(oid)) return;
    if (!store.has(oid)) return;
    emitted.add(oid);
    objects.push(oid);
  };
  // Commits in distance order (tips first), then each commit's trees/blobs.
  const commitsByDistance = [...included].sort((a, b) => (distance.get(a) ?? 0) - (distance.get(b) ?? 0));
  for (const oid of commitsByDistance) emit(oid);
  for (const oid of extraRoots) emit(oid);
  for (const oid of commitsByDistance) {
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const treeOid of treeClosure(store, parseCommit(obj.body).tree)) emit(treeOid);
  }
  return { objects, shallow, unshallow };
}
