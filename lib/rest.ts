// REST v3 under /api/v3. Every route answers JSON; the dispatcher in app.ts
// has already checked the bearer token and stamps the request id. A repo
// addressed under any owner but the token's account is a 404, never a 403,
// matching how GitHub answers for repositories the caller cannot see.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  flattenTree,
  isOid,
  listHistory,
  parseCommit,
  subtreeOid,
} from './git.ts';
import type { FlatEntry } from './git.ts';
import type { Forge, RepoRecord } from './store.ts';
import { DEFAULT_BRANCH, VIEWER } from './identity.ts';
import {
  branchTip,
  commentJson,
  createPull,
  issueJson,
  labelJson,
  performMerge,
  pullFiles,
  pullJson,
  repoJson,
  userJson,
} from './api.ts';
import { jsonReply, messageReply } from './web.ts';
import type { Reply } from './web.ts';

type Query = URLSearchParams;

function record(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function textField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function pageParams(query: Query): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function paged<T>(
  items: T[],
  query: Query,
  urlFor: (page: number, perPage: number) => string,
): { slice: T[]; headers?: Record<string, string> } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  if (items.length <= perPage && page === 1) return { slice };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1, perPage)}>; rel="next"`);
    links.push(`<${urlFor(totalPages, perPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1, perPage)}>; rel="first"`);
    links.push(`<${urlFor(page - 1, perPage)}>; rel="prev"`);
  }
  return links.length > 0 ? { slice, headers: { Link: links.join(', ') } } : { slice };
}

function findRepo(forge: Forge, owner: string, name: string): RepoRecord | null {
  if (owner !== VIEWER.login) return null;
  return forge.repoByName(name) ?? null;
}

function commitJson(forge: Forge, repo: RepoRecord, oid: string): Record<string, unknown> {
  const obj = repo.store.get(oid);
  const info = obj && obj.type === 'commit'
    ? parseCommit(obj.body)
    : { tree: ZERO_OID, parents: [] as string[], author: { name: '', email: '', time: 0, zone: '+0000' }, committer: { name: '', email: '', time: 0, zone: '+0000' }, message: '' };
  const person = (who: { name: string; email: string; time: number }): Record<string, unknown> => ({
    name: who.name,
    email: who.email,
    date: new Date(who.time * 1000).toISOString(),
  });
  return {
    sha: oid,
    node_id: '',
    commit: {
      author: person(info.author),
      committer: person(info.committer),
      message: info.message,
      tree: { sha: info.tree },
      comment_count: 0,
    },
    parents: info.parents.map((sha) => ({ sha })),
    author: null,
    committer: null,
  };
}

export function handleRest(
  forge: Forge,
  method: string,
  segments: string[],
  query: Query,
  body: unknown,
  base: string,
): Reply {
  const data = record(body);

  // ---- root, meta, the viewer -------------------------------------------
  if (segments.length === 0) {
    if (method !== 'GET') return messageReply(404, 'Not Found');
    return jsonReply(200, {
      current_user_url: `${base}/api/v3/user`,
      current_user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
      repository_url: `${base}/api/v3/repos/${VIEWER.login}/{repo}`,
      issues_url: `${base}/api/v3/issues`,
      user_url: `${base}/api/v3/users/${VIEWER.login}`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
    });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return messageReply(404, 'Not Found');
    return jsonReply(200, { installed_version: 'forge-1.0.0', verifiable_password_authentication: false });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return messageReply(404, 'Not Found');
    return jsonReply(200, {
      ...userJson(base),
      name: VIEWER.displayName,
      email: VIEWER.email,
      public_repos: forge.listRepos().filter((r) => !r.isPrivate).length,
      total_private_repos: forge.listRepos().filter((r) => r.isPrivate).length,
    });
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const mine = forge.listRepos().map((repo) => repoJson(forge, repo, base));
      const { slice, headers } = paged(mine, query, (p, pp) => `${base}/api/v3/user/repos?per_page=${pp}&page=${p}`);
      return jsonReply(200, slice, headers);
    }
    if (method === 'POST') return createRepo(forge, data, base);
    return messageReply(404, 'Not Found');
  }

  // ---- everything under /repos/{owner}/{repo} ----------------------------
  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = findRepo(forge, segments[1], segments[2]);
    if (!repo) return messageReply(404, 'Not Found');
    const rest = segments.slice(3);
    return repoRoute(forge, repo, method, rest, query, data, base);
  }
  return messageReply(404, 'Not Found');
}

function createRepo(forge: Forge, data: Record<string, unknown>, base: string): Reply {
  const name = textField(data, 'name');
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return jsonReply(422, {
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is not valid' }],
    });
  }
  if (forge.repoByName(name)) {
    return jsonReply(422, {
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
  }
  const repo = forge.createRepo(name, data.private === true, textField(data, 'description') ?? '');
  return jsonReply(201, repoJson(forge, repo, base));
}

function repoRoute(
  forge: Forge,
  repo: RepoRecord,
  method: string,
  rest: string[],
  query: Query,
  data: Record<string, unknown>,
  base: string,
): Reply {
  if (rest.length === 0) {
    if (method === 'GET') return jsonReply(200, repoJson(forge, repo, base));
    if (method === 'PATCH') {
      const description = textField(data, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof data.private === 'boolean') repo.isPrivate = data.private;
      return jsonReply(200, repoJson(forge, repo, base));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.name);
      return { status: 204, type: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
    }
    return messageReply(404, 'Not Found');
  }
  const head = rest[0];
  if (head === 'git' && rest[1] === 'refs') return refsRoute(forge, repo, method, rest.slice(2), data, base);
  if (head === 'branches') return branchesRoute(forge, repo, method, rest.slice(1), base);
  if (head === 'commits') return commitsRoute(forge, repo, method, rest.slice(1), query, base);
  if (head === 'contents') return contentsRoute(forge, repo, method, rest.slice(1), query, data, base);
  if (head === 'labels') return labelsRoute(forge, repo, method, rest.slice(1), data, base);
  if (head === 'issues') return issuesRoute(forge, repo, method, rest.slice(1), query, data, base);
  if (head === 'pulls') return pullsRoute(forge, repo, method, rest.slice(1), query, data, base);
  return messageReply(404, 'Not Found');
}

// ------------------------------------------------------------------ git refs

function refsRoute(
  forge: Forge,
  repo: RepoRecord,
  method: string,
  tail: string[],
  data: Record<string, unknown>,
  base: string,
): Reply {
  if (method === 'POST' && tail.length === 0) {
    const ref = textField(data, 'ref');
    const sha = textField(data, 'sha');
    if (!ref || !ref.startsWith('refs/') || !sha) return messageReply(422, 'ref and sha are required');
    const target = repo.store.get(sha);
    if (!target || target.type !== 'commit') return messageReply(422, 'Invalid sha');
    if (repo.refs.has(ref)) return messageReply(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    repo.generation += 1;
    return jsonReply(201, {
      ref,
      node_id: '',
      url: `${base}/api/v3/repos/${VIEWER.login}/${repo.name}/git/refs/${ref.slice('refs/'.length)}`,
      object: { type: 'commit', sha, url: '' },
    });
  }
  if (method === 'GET' && tail.length > 0) {
    const ref = `refs/${tail.join('/')}`;
    const oid = repo.refs.get(ref);
    if (!oid) return messageReply(404, 'Not Found');
    const obj = repo.store.get(oid);
    return jsonReply(200, { ref, node_id: '', object: { type: obj?.type ?? 'commit', sha: oid } });
  }
  return messageReply(404, 'Not Found');
}

function branchesRoute(
  forge: Forge,
  repo: RepoRecord,
  method: string,
  tail: string[],
  base: string,
): Reply {
  if (method !== 'GET') return messageReply(404, 'Not Found');
  if (tail.length === 0) {
    const names = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort();
    return jsonReply(200, names.map((name) => ({
      name,
      commit: { sha: repo.refs.get(`refs/heads/${name}`) as string },
      protected: false,
    })));
  }
  const name = tail.join('/');
  const oid = repo.refs.get(`refs/heads/${name}`);
  if (!oid) return messageReply(404, 'Not Found');
  return jsonReply(200, { name, commit: { sha: oid }, protected: false });
}

// ------------------------------------------------------------------- commits

function resolveCommitRef(repo: RepoRecord, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch) return byBranch;
  if (isOid(ref)) {
    const obj = repo.store.get(ref);
    if (obj && obj.type === 'commit') return ref;
  }
  return null;
}

function commitsRoute(
  forge: Forge,
  repo: RepoRecord,
  method: string,
  tail: string[],
  query: Query,
  base: string,
): Reply {
  if (method !== 'GET') return messageReply(404, 'Not Found');
  if (tail.length === 1) {
    const oid = tail[0];
    const obj = repo.store.get(oid);
    if (!obj || obj.type !== 'commit') return messageReply(404, 'Not Found');
    return jsonReply(200, commitJson(forge, repo, oid));
  }
  if (tail.length > 1) return messageReply(404, 'Not Found');
  const tip = resolveCommitRef(repo, query.get('sha') ?? undefined);
  if (!tip) {
    // No such ref — but an empty repository simply has no commits yet.
    if ((query.get('sha') ?? '') === '' || query.get('sha') === DEFAULT_BRANCH) return jsonReply(200, []);
    return messageReply(422, 'No commit found for SHA');
  }
  const history = listHistory(repo.store, tip).map((oid) => commitJson(forge, repo, oid));
  const { slice, headers } = paged(history, query, (p, pp) => `${base}/api/v3/repos/${VIEWER.login}/${repo.name}/commits?per_page=${pp}&page=${p}`);
  return jsonReply(200, slice, headers);
}

// ------------------------------------------------------------------ contents

function wrapBase64(bytes: Buffer): string {
  const raw = bytes.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 60) lines.push(raw.slice(i, i + 60));
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

interface ContentsTarget {
  tip: string | null;
  flat: Map<string, FlatEntry>;
}

function contentsTarget(repo: RepoRecord, branch: string): ContentsTarget {
  const tip = branchTip(repo, branch) ?? repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? null;
  if (!tip) return { tip: null, flat: new Map() };
  const obj = repo.store.get(tip);
  if (!obj || obj.type !== 'commit') return { tip: null, flat: new Map() };
  return { tip, flat: flattenTree(repo.store, parseCommit(obj.body).tree) };
}

function writeContentsCommit(
  forge: Forge,
  repo: RepoRecord,
  branch: string,
  parentTip: string | null,
  flat: Map<string, FlatEntry>,
  message: string,
): string {
  const tree = buildTreeFromFlat(repo.store, flat);
  const identity = { name: VIEWER.displayName, email: VIEWER.email, time: forge.tick(), zone: '+0000' };
  const oid = repo.store.put('commit', buildCommit({
    tree,
    parents: parentTip ? [parentTip] : [],
    author: identity,
    committer: identity,
    message,
  }));
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.generation += 1;
  return oid;
}

function contentsRoute(
  forge: Forge,
  repo: RepoRecord,
  method: string,
  tail: string[],
  query: Query,
  data: Record<string, unknown>,
  base: string,
): Reply {
  const path = tail.join('/');
  if (method === 'GET') return contentsGet(forge, repo, path, query.get('ref') ?? undefined);
  if (method === 'PUT') return contentsPut(forge, repo, path, data);
  if (method === 'DELETE') return contentsDelete(forge, repo, path, data);
  return messageReply(404, 'Not Found');
}

function contentsGet(forge: Forge, repo: RepoRecord, path: string, ref: string | undefined): Reply {
  const tip = resolveCommitRef(repo, ref);
  if (!tip) return messageReply(404, 'Not Found');
  const commit = repo.store.get(tip);
  if (!commit || commit.type !== 'commit') return messageReply(404, 'Not Found');
  const treeOid = parseCommit(commit.body).tree;
  const flat = flattenTree(repo.store, treeOid);
  const prefix = path === '' ? '' : `${path}/`;
  const entry = path === '' ? undefined : flat.get(path);
  if (entry) {
    const blob = repo.store.get(entry.oid);
    if (!blob) return messageReply(404, 'Not Found');
    return jsonReply(200, {
      type: 'file',
      encoding: 'base64',
      content: wrapBase64(blob.body),
      name: path.split('/').pop() as string,
      path,
      sha: entry.oid,
      size: blob.body.length,
    });
  }
  const children = new Map<string, { entry: FlatEntry | null; file: boolean }>();
  for (const [key, value] of flat) {
    if (path !== '' && !key.startsWith(prefix)) continue;
    const rest = path === '' ? key : key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) children.set(rest, { entry: value, file: true });
    else if (!children.has(rest.slice(0, slash))) children.set(rest.slice(0, slash), { entry: null, file: false });
  }
  if (path !== '' && children.size === 0) return messageReply(404, 'Not Found');
  const listing: Record<string, unknown>[] = [];
  for (const name of [...children.keys()].sort()) {
    const child = children.get(name) as { entry: FlatEntry | null; file: boolean };
    const childPath = path === '' ? name : `${path}/${name}`;
    if (child.file && child.entry) {
      const blob = repo.store.get(child.entry.oid);
      listing.push({ type: 'file', name, path: childPath, sha: child.entry.oid, size: blob ? blob.body.length : 0 });
    } else {
      listing.push({ type: 'dir', name, path: childPath, sha: subtreeOid(repo.store, treeOid, childPath) ?? ZERO_OID, size: 0 });
    }
  }
  return jsonReply(200, listing);
}

function contentsPut(forge: Forge, repo: RepoRecord, path: string, data: Record<string, unknown>): Reply {
  if (path === '') return messageReply(422, 'path is required');
  const branch = textField(data, 'branch') ?? DEFAULT_BRANCH;
  const encoded = textField(data, 'content');
  if (encoded === undefined) return messageReply(422, 'content is required');
  const bytes = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
  const target = contentsTarget(repo, branch);
  const existing = target.flat.get(path);
  const givenSha = textField(data, 'sha');
  if (existing) {
    if (givenSha === undefined) return messageReply(422, '"sha" wasn\'t supplied.');
    if (givenSha !== existing.oid) return messageReply(409, 'sha does not match the current content');
  } else {
    if (givenSha !== undefined) return messageReply(422, 'sha supplied for a file that does not exist');
    for (const key of target.flat.keys()) {
      if (key.startsWith(`${path}/`) || path.startsWith(`${key}/`)) {
        return messageReply(422, 'a path component conflicts with an existing entry');
      }
    }
  }
  const blobOid = repo.store.put('blob', bytes);
  const flat = new Map(target.flat);
  flat.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
  const commitOid = writeContentsCommit(forge, repo, branch, target.tip, flat, textField(data, 'message') ?? '');
  return jsonReply(existing ? 200 : 201, {
    content: {
      name: path.split('/').pop() as string,
      path,
      sha: blobOid,
      size: bytes.length,
      type: 'file',
      encoding: 'base64',
    },
    commit: commitJson(forge, repo, commitOid),
  });
}

function contentsDelete(forge: Forge, repo: RepoRecord, path: string, data: Record<string, unknown>): Reply {
  const branch = textField(data, 'branch') ?? DEFAULT_BRANCH;
  const target = contentsTarget(repo, branch);
  const existing = target.flat.get(path);
  if (!existing) return messageReply(404, 'Not Found');
  const givenSha = textField(data, 'sha');
  if (givenSha !== undefined && givenSha !== existing.oid) return messageReply(409, 'sha does not match the current content');
  const flat = new Map(target.flat);
  flat.delete(path);
  const commitOid = writeContentsCommit(forge, repo, branch, target.tip, flat, textField(data, 'message') ?? '');
  return jsonReply(200, { content: null, commit: commitJson(forge, repo, commitOid) });
}

// -------------------------------------------------------------------- labels

function labelsRoute(
  forge: Forge,
  repo: RepoRecord,
  method: string,
  tail: string[],
  data: Record<string, unknown>,
  base: string,
): Reply {
  if (method === 'GET' && tail.length === 0) {
    return jsonReply(200, [...repo.labels.values()].map((label) => labelJson(label, repo, base)));
  }
  if (method === 'GET' && tail.length === 1) {
    const label = repo.labels.get(tail[0]);
    if (!label) return messageReply(404, 'Not Found');
    return jsonReply(200, labelJson(label, repo, base));
  }
  if (method === 'POST' && tail.length === 0) {
    const name = textField(data, 'name');
    if (!name) return messageReply(422, 'name is required');
    if (repo.labels.has(name)) {
      return jsonReply(422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
    }
    const color = (textField(data, 'color') ?? 'ededed').replace(/^#/, '');
    const label = forge.addLabel(repo, name, color, textField(data, 'description') ?? '');
    return jsonReply(201, labelJson(label, repo, base));
  }
  return messageReply(404, 'Not Found');
}

// -------------------------------------------------------------------- issues

function issuesRoute(
  forge: Forge,
  repo: RepoRecord,
  method: string,
  tail: string[],
  query: Query,
  data: Record<string, unknown>,
  base: string,
): Reply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = textField(data, 'title');
      if (!title) return messageReply(422, 'title is required');
      const labelNames: string[] = [];
      if (Array.isArray(data.labels)) {
        for (const raw of data.labels) {
          const name = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? textField(raw as Record<string, unknown>, 'name') : undefined;
          if (!name) return messageReply(422, 'labels must be names');
          if (!repo.labels.has(name)) return messageReply(422, `label "${name}" does not exist in this repository`);
          labelNames.push(name);
        }
      }
      const issue = forge.openIssue(repo, title, textField(data, 'body') ?? '', labelNames);
      return jsonReply(201, issueJson(forge, repo, issue, base));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      const direction = query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const items = issues.map((issue) => issueJson(forge, repo, issue, base));
      const { slice, headers } = paged(items, query, (p, pp) => `${base}/api/v3/repos/${VIEWER.login}/${repo.name}/issues?per_page=${pp}&page=${p}`);
      return jsonReply(200, slice, headers);
    }
    return messageReply(404, 'Not Found');
  }
  const number = Number.parseInt(tail[0], 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (tail.length === 1) {
    if (!issue) return messageReply(404, 'Not Found');
    if (method === 'GET') return jsonReply(200, issueJson(forge, repo, issue, base));
    if (method === 'PATCH') {
      const state = textField(data, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = textField(data, 'title');
      if (title !== undefined) issue.title = title;
      const bodyText = textField(data, 'body');
      if (bodyText !== undefined) issue.body = bodyText;
      if (Array.isArray(data.labels)) {
        const names: string[] = [];
        for (const raw of data.labels) {
          if (typeof raw !== 'string') return messageReply(422, 'labels must be names');
          if (!repo.labels.has(raw)) return messageReply(422, `label "${raw}" does not exist in this repository`);
          names.push(raw);
        }
        issue.labelNames = names;
      }
      issue.updatedSeq = forge.tick();
      return jsonReply(200, issueJson(forge, repo, issue, base));
    }
    return messageReply(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (!issue) return messageReply(404, 'Not Found');
    if (method === 'GET') {
      return jsonReply(200, issue.comments.map((comment) => commentJson(forge, repo, issue, comment, base)));
    }
    if (method === 'POST') {
      const bodyText = textField(data, 'body');
      if (bodyText === undefined) return messageReply(422, 'body is required');
      const comment = forge.addComment(repo, issue, bodyText);
      return jsonReply(201, commentJson(forge, repo, issue, comment, base));
    }
    return messageReply(404, 'Not Found');
  }
  return messageReply(404, 'Not Found');
}

// --------------------------------------------------------------------- pulls

function pullsRoute(
  forge: Forge,
  repo: RepoRecord,
  method: string,
  tail: string[],
  query: Query,
  data: Record<string, unknown>,
  base: string,
): Reply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = textField(data, 'title');
      const head = textField(data, 'head');
      const baseName = textField(data, 'base');
      if (!title || !head || !baseName) return messageReply(422, 'title, head and base are required');
      const created = createPull(forge, repo, title, textField(data, 'body') ?? '', head, baseName);
      if (!created.ok) return messageReply(created.status, created.message);
      return jsonReply(201, pullJson(forge, repo, created.value, base));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const items = pulls.map((pull) => pullJson(forge, repo, pull, base));
      const { slice, headers } = paged(items, query, (p, pp) => `${base}/api/v3/repos/${VIEWER.login}/${repo.name}/pulls?per_page=${pp}&page=${p}`);
      return jsonReply(200, slice, headers);
    }
    return messageReply(404, 'Not Found');
  }
  const number = Number.parseInt(tail[0], 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (tail.length === 1) {
    if (!pull) return messageReply(404, 'Not Found');
    if (method === 'GET') return jsonReply(200, pullJson(forge, repo, pull, base));
    return messageReply(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'files') {
    if (!pull) return messageReply(404, 'Not Found');
    if (method !== 'GET') return messageReply(404, 'Not Found');
    return jsonReply(200, pullFiles(repo, pull).map((file) => ({
      sha: file.sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    })));
  }
  if (tail.length === 2 && tail[1] === 'merge') {
    if (!pull) return messageReply(404, 'Not Found');
    if (method !== 'PUT') return messageReply(404, 'Not Found');
    const merged = performMerge(
      forge,
      repo,
      pull,
      textField(data, 'merge_method') ?? 'merge',
      textField(data, 'commit_title'),
      textField(data, 'commit_message'),
    );
    if (!merged.ok) return messageReply(merged.status, merged.message);
    return jsonReply(200, { sha: merged.value.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return messageReply(404, 'Not Found');
}
