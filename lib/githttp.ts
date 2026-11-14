// Git smart HTTP, spoken by hand: the reference advertisement, protocol v2
// ls-refs and fetch, a v0 fetch fallback framed with side-band-64k, and v0
// receive-pack with report-status. References live in the repo record; the
// objects live in its ObjectStore.

import {
  ZERO_OID,
  isAncestor,
  isOid,
  peel,
  peelToCommit,
} from './git.ts';
import type { ObjectStore } from './git.ts';
import { buildPack, emptyPack, parsePack, planFetch } from './pack.ts';
import { FLUSH, encodePkt, encodeStream, parsePkts, pktText, sectionsOf } from './pktline.ts';
import type { Forge, RepoRecord } from './store.ts';
import { DEFAULT_BRANCH, VIEWER } from './identity.ts';
import { bufferReply, messageReply, textReply } from './web.ts';
import type { Reply } from './web.ts';

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

interface Located {
  repo: RepoRecord | null;
}

function locate(forge: Forge, owner: string, name: string): Located {
  if (owner !== VIEWER.login) return { repo: null };
  return { repo: forge.repoByName(name) ?? null };
}

function sortedRefs(repo: RepoRecord): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peeledCommit(store: ObjectStore, oid: string): string | null {
  const found = peel(store, oid);
  return found && found.type !== 'tag' ? found.oid : null;
}

// ------------------------------------------------------------- advertisement

export function infoRefs(
  forge: Forge,
  owner: string,
  name: string,
  service: string,
  version2: boolean,
): Reply {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return textReply(400, 'invalid service');
  }
  const { repo } = locate(forge, owner, name);
  if (!repo) return messageReply(404, 'Not Found');
  const short = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
  if (version2 && service === 'git-upload-pack') {
    const lines = [
      'version 2',
      `agent=${AGENT}`,
      'ls-refs=unborn',
      'fetch=shallow',
      'object-format=sha1',
    ];
    const body = encodeStream([...lines.map((l) => Buffer.from(`${l}\n`)), FLUSH]);
    return bufferReply(200, 'application/x-git-upload-pack-advertisement', body);
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const headRef = forge.headRef(repo);
  const headOid = repo.refs.get(headRef);
  const refs = sortedRefs(repo);
  const parts: (Buffer | typeof FLUSH)[] = [Buffer.from(`# service=${service}\n`), FLUSH];
  if (refs.length === 0) {
    parts.push(Buffer.from(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(Buffer.from(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(Buffer.from(`${oid} ${ref}\n`));
      const obj = repo.store.get(oid);
      if (obj && obj.type === 'tag') {
        const target = peeledCommit(repo.store, oid);
        if (target) parts.push(Buffer.from(`${target} ${ref}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return bufferReply(200, `application/x-git-${short}-advertisement`, encodeStream(parts));
}

// ----------------------------------------------------------------- ls-refs

function lsRefs(repo: RepoRecord, args: Buffer[]): Buffer {
  let wantPeel = false;
  let wantSymrefs = false;
  let wantUnborn = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = pktText(raw);
    if (line === 'peel') wantPeel = true;
    else if (line === 'symrefs') wantSymrefs = true;
    else if (line === 'unborn') wantUnborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const headRef = `refs/heads/${DEFAULT_BRANCH}`;
  const headOid = repo.refs.get(headRef);
  const lines: string[] = [];
  if (matches('HEAD')) {
    if (headOid) {
      lines.push(`${headOid} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (wantUnborn) {
      lines.push(`unborn HEAD symref-target:${headRef}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (wantPeel) {
      const obj = repo.store.get(oid);
      if (obj && obj.type === 'tag') {
        const target = peeledCommit(repo.store, oid);
        if (target) line += ` peeled:${target}`;
      }
    }
    lines.push(line);
  }
  return encodeStream([...lines.map((l) => Buffer.from(`${l}\n`)), FLUSH]);
}

// -------------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: Set<string>;
  depth: number | null;
}

const packCache = new Map<string, Buffer>();

function fetchPack(repo: RepoRecord, plan: ReturnType<typeof planFetch>): Buffer {
  const key = [
    repo.generation,
    plan.objects.join(','),
    plan.shallow.join(','),
    plan.unshallow.join(','),
  ].join('|');
  const hit = packCache.get(key);
  if (hit) return hit;
  let pack: Buffer;
  if (plan.objects.length === 0) {
    pack = emptyPack();
  } else {
    const entries = [];
    for (const oid of plan.objects) {
      const obj = repo.store.get(oid);
      if (obj) entries.push({ oid, type: obj.type, body: obj.body });
    }
    pack = buildPack(entries);
  }
  if (packCache.size > 128) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const slice = pack.subarray(at, Math.min(pack.length, at + CHUNK));
    packets.push(Buffer.concat([Buffer.from([1]), slice]));
  }
  if (packets.length === 0) packets.push(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)]));
  return packets;
}

function runFetch(repo: RepoRecord, args: FetchArgs): { shallow: string[]; unshallow: string[]; pack: Buffer } {
  const plan = planFetch(repo.store, args.wants, args.haves, args.shallow, args.depth);
  return { shallow: plan.shallow, unshallow: plan.unshallow, pack: fetchPack(repo, plan) };
}

function fetchV2(repo: RepoRecord, args: Buffer[]): Buffer {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: new Set(), depth: null };
  for (const raw of args) {
    const line = pktText(raw);
    const [head, tail] = [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)];
    if (head === 'want' && isOid(tail)) parsed.wants.push(tail);
    else if (head === 'have' && isOid(tail)) parsed.haves.push(tail);
    else if (head === 'shallow' && isOid(tail)) parsed.shallow.add(tail);
    else if (head === 'deepen') parsed.depth = Number.parseInt(tail, 10) || null;
  }
  const result = runFetch(repo, parsed);
  const parts: (Buffer | typeof FLUSH)[] = [];
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    parts.push(Buffer.from('shallow-info\n'));
    for (const oid of result.shallow) parts.push(Buffer.from(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(Buffer.from(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(Buffer.from('packfile\n'));
  for (const packet of sidebandPackets(result.pack)) parts.push(packet);
  parts.push(FLUSH);
  return encodeStream(parts);
}

function fetchV0(repo: RepoRecord, body: Buffer): Buffer {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: new Set(), depth: null };
  const first = parsePkts(body);
  for (const item of first.items) {
    if (!Buffer.isBuffer(item)) continue;
    const line = pktText(item);
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) parsed.wants.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (isOid(oid)) parsed.shallow.add(oid);
    } else if (line.startsWith('deepen ')) {
      parsed.depth = Number.parseInt(line.slice(7), 10) || null;
    }
  }
  if (first.rest.length > 0) {
    const second = parsePkts(first.rest);
    for (const item of second.items) {
      if (!Buffer.isBuffer(item)) continue;
      const line = pktText(item);
      if (line.startsWith('have ')) {
        const oid = line.slice(5, 45);
        if (isOid(oid)) parsed.haves.push(oid);
      }
    }
  }
  const result = runFetch(repo, parsed);
  const parts: (Buffer | typeof FLUSH)[] = [];
  for (const oid of result.shallow) parts.push(Buffer.from(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(Buffer.from(`unshallow ${oid}\n`));
  parts.push(Buffer.from('NAK\n'));
  for (const packet of sidebandPackets(result.pack)) parts.push(packet);
  parts.push(FLUSH);
  return encodeStream(parts);
}

export function uploadPack(
  forge: Forge,
  owner: string,
  name: string,
  version2: boolean,
  body: Buffer,
): Reply {
  const { repo } = locate(forge, owner, name);
  if (!repo) return messageReply(404, 'Not Found');
  try {
    if (!version2) {
      return bufferReply(200, 'application/x-git-upload-pack-result', fetchV0(repo, body));
    }
    const { items } = parsePkts(body);
    const groups = sectionsOf(items);
    const commandLines = (groups[0] ?? []).map((b) => pktText(b));
    const command = commandLines.find((l) => l.startsWith('command='));
    if (!command) return textReply(400, 'no command given');
    const verb = command.slice('command='.length);
    const argLines = groups[1] ?? [];
    if (verb === 'ls-refs') {
      return bufferReply(200, 'application/x-git-upload-pack-result', lsRefs(repo, argLines));
    }
    if (verb === 'fetch') {
      return bufferReply(200, 'application/x-git-upload-pack-result', fetchV2(repo, argLines));
    }
    return textReply(400, `unsupported command ${verb}`);
  } catch (error) {
    return textReply(400, `bad upload-pack request: ${(error as Error).message}`);
  }
}

// -------------------------------------------------------------- receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(forge: Forge, owner: string, name: string, body: Buffer): Reply {
  const { repo } = locate(forge, owner, name);
  if (!repo) return messageReply(404, 'Not Found');
  let commands: RefCommand[] = [];
  let packBytes = Buffer.alloc(0);
  let clientCaps = '';
  try {
    const { items, rest } = parsePkts(body);
    packBytes = rest;
    let first = true;
    for (const item of items) {
      if (!Buffer.isBuffer(item)) continue;
      let line = pktText(item);
      if (first) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          clientCaps = line.slice(nul + 1);
          line = line.slice(0, nul);
        }
        first = false;
      }
      const fields = line.split(' ');
      if (fields.length < 3) continue;
      const [oldOid, newOid, ...rest2] = fields;
      commands.push({ oldOid, newOid, ref: rest2.join(' ') });
    }
  } catch (error) {
    return textReply(400, `bad receive-pack request: ${(error as Error).message}`);
  }

  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(repo.store, packBytes);
      for (const obj of objects) repo.store.putKnown(obj.oid, obj.type, obj.body);
      repo.generation += 1;
    } catch (error) {
      unpackError = (error as Error).message;
    }
  }

  const report: string[] = [unpackError ? `unpack ${unpackError}` : 'unpack ok'];
  const headRef = forge.headRef(repo);
  for (const command of commands) {
    const refuse = (reason: string): void => {
      report.push(`ng ${command.ref} ${reason}`);
    };
    if (unpackError) {
      refuse('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      refuse('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (command.ref === headRef) {
        refuse('deletion of the current branch prohibited');
        continue;
      }
      repo.refs.delete(command.ref);
      repo.generation += 1;
      report.push(`ok ${command.ref}`);
      continue;
    }
    const target = repo.store.get(command.newOid);
    if (!target) {
      refuse('bad object');
      continue;
    }
    if (command.oldOid !== ZERO_OID) {
      const oldCommit = peelToCommit(repo.store, command.oldOid);
      const newCommit = peelToCommit(repo.store, command.newOid);
      if (oldCommit && newCommit && !isAncestor(repo.store, oldCommit, newCommit)) {
        refuse('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    repo.generation += 1;
    report.push(`ok ${command.ref}`);
  }

  const caps = new Set(clientCaps.split(' ').filter((c) => c.length > 0));
  let responseBody = Buffer.alloc(0);
  if (caps.has('report-status')) {
    const inner = encodeStream([...report.map((l) => Buffer.from(`${l}\n`)), FLUSH]);
    if (caps.has('side-band-64k')) {
      const wrapped: Buffer[] = [];
      const CHUNK = 65515;
      for (let at = 0; at < inner.length; at += CHUNK) {
        wrapped.push(encodePkt(Buffer.concat([Buffer.from([1]), inner.subarray(at, at + CHUNK)])));
      }
      wrapped.push(Buffer.from('0000', 'ascii'));
      responseBody = Buffer.concat(wrapped);
    } else {
      responseBody = inner;
    }
  }
  return bufferReply(200, 'application/x-git-receive-pack-result', responseBody);
}
