// Serializers and shared operations for the API surfaces. REST, GraphQL and
// MCP all present the same records; the JSON shapes below are the REST v3
// presentation, and the merge/create operations live here so every surface
// performs them identically.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  diffFlat,
  flattenTree,
  listHistory,
  mergeBase,
  mergeFlat3Way,
  parseCommit,
} from './git.ts';
import type { FlatEntry } from './git.ts';
import {
  commentNodeId,
  issueNodeId,
  pullNodeId,
  repoNodeId,
  userNodeId,
} from './store.ts';
import type {
  CommentRecord,
  Forge,
  IssueRecord,
  LabelRecord,
  PullRecord,
  RepoRecord,
} from './store.ts';
import { VIEWER } from './identity.ts';

export function userJson(base: string): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.numericId,
    node_id: userNodeId(),
    type: 'User',
    site_admin: false,
    avatar_url: '',
    html_url: `${base}/${VIEWER.login}`,
    url: `${base}/api/v3/users/${VIEWER.login}`,
  };
}

export function repoJson(forge: Forge, repo: RepoRecord, base: string): Record<string, unknown> {
  const fullName = `${VIEWER.login}/${repo.name}`;
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: fullName,
    owner: userJson(base),
    private: repo.isPrivate,
    description: repo.description,
    html_url: `${base}/${fullName}`,
    url: `${base}/api/v3/repos/${fullName}`,
    created_at: forge.isoAt(repo.createdSeq),
    updated_at: forge.isoAt(repo.createdSeq),
    default_branch: 'main',
    has_issues: true,
    open_issues_count: openIssues,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
  };
}

export function labelJson(label: LabelRecord, repo: RepoRecord, base: string): Record<string, unknown> {
  return {
    id: label.id,
    node_id: '',
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: `${base}/api/v3/repos/${VIEWER.login}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

export function issueJson(forge: Forge, repo: RepoRecord, issue: IssueRecord, base: string): Record<string, unknown> {
  const labels: Record<string, unknown>[] = [];
  for (const name of issue.labelNames) {
    const label = repo.labels.get(name);
    if (label) labels.push(labelJson(label, repo, base));
  }
  return {
    id: issue.globalId,
    node_id: issueNodeId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: userJson(base),
    comments: issue.comments.length,
    created_at: forge.isoAt(issue.createdSeq),
    updated_at: forge.isoAt(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? forge.isoAt(issue.updatedSeq) : null,
    state_reason: null,
    html_url: `${base}/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${VIEWER.login}/${repo.name}`,
  };
}

export function commentJson(forge: Forge, repo: RepoRecord, issue: IssueRecord, comment: CommentRecord, base: string): Record<string, unknown> {
  return {
    id: comment.globalId,
    node_id: commentNodeId(comment),
    body: comment.body,
    user: userJson(base),
    created_at: forge.isoAt(comment.seq),
    updated_at: forge.isoAt(comment.seq),
    html_url: `${base}/${VIEWER.login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.globalId}`,
    url: `${base}/api/v3/repos/${VIEWER.login}/${repo.name}/issues/comments/${comment.globalId}`,
    issue_url: `${base}/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
  };
}

export function branchTip(repo: RepoRecord, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function pullJson(forge: Forge, repo: RepoRecord, pull: PullRecord, base: string): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = branchTip(repo, pull.baseRef) ?? ZERO_OID;
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${VIEWER.login}:${ref}`,
    ref,
    sha,
    user: userJson(base),
    repo: repoJson(forge, repo, base),
  });
  return {
    id: pull.globalId,
    node_id: pullNodeId(repo, pull),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(base),
    draft: false,
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    merged: pull.merged,
    merged_at: pull.mergedSeq !== null ? forge.isoAt(pull.mergedSeq) : null,
    merged_by: pull.merged ? userJson(base) : null,
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: pull.state === 'closed' ? forge.isoAt(pull.updatedSeq) : null,
    created_at: forge.isoAt(pull.createdSeq),
    updated_at: forge.isoAt(pull.updatedSeq),
    html_url: `${base}/${VIEWER.login}/${repo.name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${VIEWER.login}/${repo.name}/pulls/${pull.number}`,
  };
}

// ------------------------------------------------------------- pull requests

export type OpError = { ok: false; status: number; message: string };
export type OpOk<T> = { ok: true; value: T };

/** Strip an "owner:" label prefix and any refs/heads/ dressing from a ref name. */
export function cleanRefName(raw: string): string {
  let name = raw;
  const colon = name.indexOf(':');
  if (colon > 0 && !name.slice(0, colon).includes('/')) name = name.slice(colon + 1);
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  return name;
}

export function createPull(
  forge: Forge,
  repo: RepoRecord,
  title: string,
  body: string,
  headRaw: string,
  baseRaw: string,
): OpOk<PullRecord> | OpError {
  const head = cleanRefName(headRaw);
  const base = cleanRefName(baseRaw);
  if (!branchTip(repo, head)) return { ok: false, status: 422, message: `head branch "${head}" does not exist` };
  if (!branchTip(repo, base)) return { ok: false, status: 422, message: `base branch "${base}" does not exist` };
  if (head === base) return { ok: false, status: 422, message: 'head and base must differ' };
  if (forge.findOpenPull(repo, head, base)) {
    return { ok: false, status: 422, message: `a pull request already exists for ${head} into ${base}` };
  }
  return { ok: true, value: forge.openPull(repo, title, body, head, base) };
}

function treeOfCommit(repo: RepoRecord, commitOid: string | null): Map<string, FlatEntry> {
  if (!commitOid) return new Map();
  const obj = repo.store.get(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(repo.store, parseCommit(obj.body).tree);
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

function lineCounts(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const a = before ? before.toString('utf8').split('\n') : [];
  const b = after ? after.toString('utf8').split('\n') : [];
  if (before && after && before.equals(after)) return { additions: 0, deletions: 0 };
  // Longest-common-subsequence over lines; forge files are small.
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j], dp[j - 1]);
      diagonal = above;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

/** The files a pull request changes: merge-base tree versus head tree. */
export function pullFiles(repo: RepoRecord, pull: PullRecord): ChangedFile[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (!headTip) return [];
  const ancestor = baseTip ? mergeBase(repo.store, headTip, baseTip) : null;
  const fromFlat = treeOfCommit(repo, ancestor);
  const toFlat = treeOfCommit(repo, headTip);
  const out: ChangedFile[] = [];
  for (const diff of diffFlat(fromFlat, toFlat)) {
    const beforeBody = diff.from ? repo.store.get(diff.from.oid)?.body ?? null : null;
    const afterBody = diff.to ? repo.store.get(diff.to.oid)?.body ?? null : null;
    const counts = lineCounts(beforeBody, afterBody);
    out.push({
      filename: diff.path,
      status: diff.from === null ? 'added' : diff.to === null ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: (diff.to ?? diff.from)?.oid ?? ZERO_OID,
    });
  }
  return out;
}

/** Would merging this pull conflict? Mirrors performMerge's test. */
export function pullWouldConflict(repo: RepoRecord, pull: PullRecord): boolean {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return false;
  const ancestor = mergeBase(repo.store, headTip, baseTip);
  const result = mergeFlat3Way(
    treeOfCommit(repo, ancestor),
    treeOfCommit(repo, baseTip),
    treeOfCommit(repo, headTip),
  );
  return result.conflicts.length > 0;
}

export function performMerge(
  forge: Forge,
  repo: RepoRecord,
  pull: PullRecord,
  method: string,
  commitTitle?: string,
  commitMessage?: string,
): OpOk<{ sha: string }> | OpError {
  if (pull.merged || pull.state !== 'open') {
    return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
  }
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) {
    return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
  }
  const ancestor = mergeBase(repo.store, headTip, baseTip);
  const ancestorFlat = treeOfCommit(repo, ancestor);
  const baseFlat = treeOfCommit(repo, baseTip);
  const headFlat = treeOfCommit(repo, headTip);
  const combined = mergeFlat3Way(ancestorFlat, baseFlat, headFlat);
  if (combined.conflicts.length > 0) {
    return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
  }
  const stamp = (): { name: string; email: string; time: number; zone: string } => ({
    name: VIEWER.displayName,
    email: VIEWER.email,
    time: forge.tick(),
    zone: '+0000',
  });
  let newTip: string;
  if (method === 'rebase') {
    // Replay each head-only commit onto the base, oldest first.
    const only: string[] = [];
    for (const oid of listHistory(repo.store, headTip)) {
      if (ancestor && oid === ancestor) break;
      only.push(oid);
    }
    only.reverse();
    let currentTip: string = baseTip;
    let currentFlat = baseFlat;
    for (const oid of only) {
      const info = parseCommit(repo.store.get(oid)?.body ?? Buffer.alloc(0));
      const parentFlat = treeOfCommit(repo, info.parents[0] ?? null);
      const commitFlat = treeOfCommit(repo, oid);
      const stepResult = mergeFlat3Way(parentFlat, currentFlat, commitFlat);
      if (stepResult.conflicts.length > 0) {
        return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
      }
      const tree = buildTreeFromFlat(repo.store, stepResult.merged);
      const identity = stamp();
      newTip = repo.store.put('commit', buildCommit({
        tree,
        parents: [currentTip],
        author: info.author,
        committer: identity,
        message: info.message,
      }));
      currentTip = newTip;
      currentFlat = stepResult.merged;
    }
    newTip = currentTip;
  } else if (method === 'merge') {
    const tree = buildTreeFromFlat(repo.store, combined.merged);
    const identity = stamp();
    newTip = repo.store.put('commit', buildCommit({
      tree,
      parents: [baseTip, headTip],
      author: identity,
      committer: identity,
      message: commitMessage ?? `Merge pull request #${pull.number} from ${pull.headRef}`,
    }));
  } else {
    // Squash (the default, and what the suite asks for): one commit carrying
    // the combined tree on top of the base tip.
    const tree = buildTreeFromFlat(repo.store, combined.merged);
    const identity = stamp();
    const title = commitTitle ?? pull.title;
    const message = commitMessage ? `${title}\n\n${commitMessage}` : `${title} (#${pull.number})`;
    newTip = repo.store.put('commit', buildCommit({
      tree,
      parents: [baseTip],
      author: identity,
      committer: identity,
      message,
    }));
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, newTip);
  repo.generation += 1;
  const seq = forge.tick();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSeq = seq;
  pull.mergeCommitSha = newTip;
  pull.updatedSeq = seq;
  return { ok: true, value: { sha: newTip } };
}
