// The forge's single in-memory store. REST, GraphQL, MCP and the git
// endpoints all read and write the records here, so an object created on one
// surface is the same object on every other. Identifiers are sequential
// counters and timestamps come from a logical clock seeded by the trial's
// opening time: identical request sequences produce identical state, with no
// randomness and no wall-clock leakage into anything observable.

import { ObjectStore } from './git.ts';
import { VIEWER, DEFAULT_BRANCH } from './identity.ts';

export interface LabelRecord {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRecord {
  globalId: number;
  body: string;
  seq: number;
}

export interface IssueRecord {
  globalId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  comments: CommentRecord[];
  createdSeq: number;
  updatedSeq: number;
}

export interface PullRecord {
  globalId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface RepoRecord {
  id: number;
  name: string;
  isPrivate: boolean;
  description: string;
  createdSeq: number;
  store: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, LabelRecord>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  /** Issue and pull numbers share one per-repository sequence. */
  nextNumber: number;
  /** Bumped whenever objects or refs change; invalidates pack caches. */
  generation: number;
}

const FALLBACK_EPOCH_SECONDS = 1735689600; // 2025-01-01T00:00:00Z

function trialEpochSeconds(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return FALLBACK_EPOCH_SECONDS;
}

export class Forge {
  readonly repos = new Map<string, RepoRecord>();
  private repoIdCounter = 0;
  private issueIdCounter = 0;
  private pullIdCounter = 0;
  private commentIdCounter = 0;
  private labelIdCounter = 0;
  private clock = 0;
  readonly epochBase = trialEpochSeconds();
  /** Where created comments live, for GraphQL node lookups. */
  readonly commentIndex = new Map<number, { repo: RepoRecord; issue: IssueRecord; comment: CommentRecord }>();

  /** The next logical timestamp, in seconds since the epoch. */
  tick(): number {
    this.clock += 1;
    return this.epochBase + this.clock;
  }

  isoAt(seconds: number): string {
    return new Date(seconds * 1000).toISOString();
  }

  nowIso(): string {
    return this.isoAt(this.tick());
  }

  // ------------------------------------------------------------ repositories

  createRepo(name: string, isPrivate: boolean, description: string): RepoRecord {
    this.repoIdCounter += 1;
    const repo: RepoRecord = {
      id: this.repoIdCounter,
      name,
      isPrivate,
      description,
      createdSeq: this.tick(),
      store: new ObjectStore(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      generation: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  repoByName(name: string): RepoRecord | undefined {
    return this.repos.get(name);
  }

  repoById(id: number): RepoRecord | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): RepoRecord[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  headRef(repo: RepoRecord): string {
    return `refs/heads/${DEFAULT_BRANCH}`;
  }

  /** The commit the default branch points at, or null when unborn. */
  defaultTip(repo: RepoRecord): string | null {
    return repo.refs.get(this.headRef(repo)) ?? null;
  }

  // ------------------------------------------------------------------ labels

  addLabel(repo: RepoRecord, name: string, color: string, description: string): LabelRecord {
    this.labelIdCounter += 1;
    const label: LabelRecord = { id: this.labelIdCounter, name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  // ------------------------------------------------------------------ issues

  openIssue(repo: RepoRecord, title: string, body: string, labelNames: string[]): IssueRecord {
    this.issueIdCounter += 1;
    const seq = this.tick();
    const issue: IssueRecord = {
      globalId: this.issueIdCounter,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labelNames: labelNames.slice(),
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: RepoRecord, issue: IssueRecord, body: string): CommentRecord {
    this.commentIdCounter += 1;
    const comment: CommentRecord = { globalId: this.commentIdCounter, body, seq: this.tick() };
    issue.comments.push(comment);
    issue.updatedSeq = comment.seq;
    this.commentIndex.set(comment.globalId, { repo, issue, comment });
    return comment;
  }

  // ------------------------------------------------------------------- pulls

  openPull(
    repo: RepoRecord,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): PullRecord {
    this.pullIdCounter += 1;
    const seq = this.tick();
    const pull: PullRecord = {
      globalId: this.pullIdCounter,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedSeq: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  findOpenPull(repo: RepoRecord, headRef: string, baseRef: string): PullRecord | undefined {
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
    }
    return undefined;
  }
}

// ------------------------------------------------------------- relay node ids

export type NodeKind = 'Repository' | 'Issue' | 'PullRequest' | 'Comment' | 'User';

export function nodeId(kind: NodeKind, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64url');
}

export function repoNodeId(repo: RepoRecord): string {
  return nodeId('Repository', String(repo.id));
}

export function issueNodeId(repo: RepoRecord, issue: IssueRecord): string {
  return nodeId('Issue', `${repo.id}:${issue.number}`);
}

export function pullNodeId(repo: RepoRecord, pull: PullRecord): string {
  return nodeId('PullRequest', `${repo.id}:${pull.number}`);
}

export function commentNodeId(comment: CommentRecord): string {
  return nodeId('Comment', String(comment.globalId));
}

export function userNodeId(): string {
  return nodeId('User', VIEWER.login);
}

export interface DecodedNode {
  kind: NodeKind;
  parts: string[];
}

export function decodeNodeId(id: string): DecodedNode | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon === -1) return null;
  const kind = text.slice(0, colon);
  if (
    kind !== 'Repository' &&
    kind !== 'Issue' &&
    kind !== 'PullRequest' &&
    kind !== 'Comment' &&
    kind !== 'User'
  ) {
    return null;
  }
  return { kind, parts: text.slice(colon + 1).split(':') };
}
