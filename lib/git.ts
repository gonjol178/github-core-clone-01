// The git object model on plain buffers: objects are SHA-1 addressed blobs of
// "<type> <length>\0<body>", with commit, tree, blob and tag bodies parsed and
// built by hand. Everything the forge stores lives in one ObjectStore per
// repository; nothing here touches the filesystem.

import { createHash } from 'node:crypto';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0000000000000000000000000000000000000000';

export function isOid(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

export function hashObject(type: ObjectType, body: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${body.length}\0`, 'utf8');
  hash.update(body);
  return hash.digest('hex');
}

export interface StoredObject {
  type: ObjectType;
  body: Buffer;
}

export class ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  put(type: ObjectType, body: Buffer): string {
    const oid = hashObject(type, body);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, body });
    return oid;
  }

  putKnown(oid: string, type: ObjectType, body: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, body });
  }

  get size(): number {
    return this.objects.size;
  }
}

// ------------------------------------------------------------------ commits

export interface Identity {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
  /** Timezone suffix as git writes it, e.g. "+0000". */
  zone: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  message: string;
}

function parseIdentity(text: string): Identity {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(text);
  if (!match) return { name: text, email: '', time: 0, zone: '+0000' };
  return { name: match[1], email: match[2], time: Number(match[3]), zone: match[4] };
}

function formatIdentity(who: Identity): string {
  return `${who.name} <${who.email}> ${who.time} ${who.zone}`;
}

export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const splitAt = text.indexOf('\n\n');
  const header = splitAt === -1 ? text : text.slice(0, splitAt);
  const message = splitAt === -1 ? '' : text.slice(splitAt + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author: Identity = { name: '', email: '', time: 0, zone: '+0000' };
  let committer: Identity = author;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseIdentity(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseIdentity(line.slice(10));
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatIdentity(info.author)}`);
  lines.push(`committer ${formatIdentity(info.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

// -------------------------------------------------------------------- trees

export interface TreeEntry {
  /** Octal mode exactly as stored: "100644", "100755", "120000", "40000", "160000". */
  mode: string;
  name: string;
  oid: string;
}

/** Tree entries sort by name, directories as if their name ended in "/". */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const ka = a.mode === '40000' ? `${a.name}/` : a.name;
  const kb = b.mode === '40000' ? `${b.name}/` : b.name;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    const mode = body.toString('ascii', pos, space);
    const nul = body.indexOf(0x00, space + 1);
    const name = body.toString('utf8', space + 1, nul);
    const oid = body.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort(compareTreeEntries);
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

// --------------------------------------------------------------------- tags

export interface TagInfo {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: Identity | null;
  message: string;
}

export function parseTag(body: Buffer): TagInfo {
  const text = body.toString('utf8');
  const splitAt = text.indexOf('\n\n');
  const header = splitAt === -1 ? text : text.slice(0, splitAt);
  const message = splitAt === -1 ? '' : text.slice(splitAt + 2);
  let object = ZERO_OID;
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger: Identity | null = null;
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = parseIdentity(line.slice(7));
  }
  return { object, type, tag, tagger, message };
}

/** Follow tag objects until a non-tag object; null if the chain breaks. */
export function peel(store: ObjectStore, oid: string): { oid: string; type: ObjectType } | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const obj = store.get(current);
    if (!obj) return null;
    if (obj.type !== 'tag') return { oid: current, type: obj.type };
    current = parseTag(obj.body).object;
  }
  return null;
}

/** The commit an object names, following tags; null when it names none. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  const found = peel(store, oid);
  return found && found.type === 'commit' ? found.oid : null;
}

// ------------------------------------------------------- flattened tree maps

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Every file (and gitlink) under a tree, keyed by slash-joined path. */
export function flattenTree(store: ObjectStore, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const obj = store.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.body)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Rebuild nested tree objects from a flattened map; returns the root tree id. */
export function buildTreeFromFlat(store: ObjectStore, flat: Map<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: emit(dir) });
    return store.put('tree', buildTree(entries));
  };
  return emit(root);
}

/** The subtree id at a directory prefix inside a flattened walk, or null. */
export function subtreeOid(store: ObjectStore, treeOid: string, dirPath: string): string | null {
  let current = treeOid;
  for (const part of dirPath.split('/')) {
    const obj = store.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.body).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

export interface TreeDiffEntry {
  path: string;
  from: FlatEntry | null;
  to: FlatEntry | null;
}

/** Paths whose blob id or mode differs between two flattened trees. */
export function diffFlat(a: Map<string, FlatEntry>, b: Map<string, FlatEntry>): TreeDiffEntry[] {
  const out: TreeDiffEntry[] = [];
  const paths = new Set<string>([...a.keys(), ...b.keys()]);
  for (const path of paths) {
    const from = a.get(path) ?? null;
    const to = b.get(path) ?? null;
    if (from && to && from.oid === to.oid && from.mode === to.mode) continue;
    if (!from && !to) continue;
    out.push({ path, from, to });
  }
  out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return out;
}

/**
 * Three-way merge of flattened trees. A path conflicts when both sides moved
 * it away from the ancestor in different ways; otherwise the moved side wins.
 */
export function mergeFlat3Way(
  ancestor: Map<string, FlatEntry>,
  ours: Map<string, FlatEntry>,
  theirs: Map<string, FlatEntry>,
): { merged: Map<string, FlatEntry>; conflicts: string[] } {
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const same = (x: FlatEntry | null, y: FlatEntry | null): boolean =>
    x === y || (x !== null && y !== null && x.oid === y.oid && x.mode === y.mode);
  const paths = new Set<string>([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const base = ancestor.get(path) ?? null;
    const our = ours.get(path) ?? null;
    const their = theirs.get(path) ?? null;
    if (same(our, their)) {
      if (our) merged.set(path, our);
    } else if (same(base, our)) {
      if (their) merged.set(path, their);
    } else if (same(base, their)) {
      if (our) merged.set(path, our);
    } else {
      conflicts.push(path);
    }
  }
  return { merged, conflicts };
}

// ------------------------------------------------------------------ history

/** Every commit reachable from a tip, with its generation distance (BFS). */
export function commitDistances(store: ObjectStore, tip: string): Map<string, number> {
  const distances = new Map<string, number>();
  const start = peelToCommit(store, tip);
  if (!start) return distances;
  distances.set(start, 0);
  let frontier = [start];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      const obj = store.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.body).parents) {
        if (!distances.has(parent)) {
          distances.set(parent, depth);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return distances;
}

/** True when `ancestor` is reachable from `descendant` through parents. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.body).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** A nearest common ancestor of two commits, or null when unrelated. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const fromA = commitDistances(store, a);
  const fromB = commitDistances(store, b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, distA] of fromA) {
    const distB = fromB.get(oid);
    if (distB === undefined) continue;
    const score = distA + distB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/**
 * Commits reachable from a tip in history order: newest first, parents always
 * after their children. Used for the REST commit list.
 */
export function listHistory(store: ObjectStore, tip: string): string[] {
  const start = peelToCommit(store, tip);
  if (!start) return [];
  const reachable = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (reachable.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    reachable.add(oid);
    for (const parent of parseCommit(obj.body).parents) stack.push(parent);
  }
  const childCount = new Map<string, number>();
  for (const oid of reachable) childCount.set(oid, 0);
  for (const oid of reachable) {
    const obj = store.get(oid);
    if (!obj) continue;
    for (const parent of parseCommit(obj.body).parents) {
      if (childCount.has(parent)) childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
    }
  }
  const timeOf = (oid: string): number => {
    const obj = store.get(oid);
    return obj ? parseCommit(obj.body).committer.time : 0;
  };
  const ready: string[] = [];
  for (const [oid, count] of childCount) if (count === 0) ready.push(oid);
  const out: string[] = [];
  while (ready.length > 0) {
    let pick = 0;
    for (let i = 1; i < ready.length; i += 1) {
      if (timeOf(ready[i]) > timeOf(ready[pick])) pick = i;
    }
    const oid = ready.splice(pick, 1)[0];
    out.push(oid);
    const obj = store.get(oid);
    if (!obj) continue;
    for (const parent of parseCommit(obj.body).parents) {
      if (!childCount.has(parent)) continue;
      const left = (childCount.get(parent) ?? 0) - 1;
      childCount.set(parent, left);
      if (left === 0) ready.push(parent);
    }
  }
  return out;
}
