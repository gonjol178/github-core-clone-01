// A small GraphQL engine for the documents gh and github-mcp-server send:
// a hand-written lexer and parser (operations, variables, fragments,
// directives, input objects), and an executor driven by per-type resolver
// tables over the same store the REST surface uses. Unknown fields are field
// errors that name the field, with HTTP still 200, as the API behaves.

import { decodeNodeId, repoNodeId, issueNodeId, pullNodeId, commentNodeId, userNodeId } from './store.ts';
import type { CommentRecord, Forge, IssueRecord, LabelRecord, PullRecord, RepoRecord } from './store.ts';
import { VIEWER } from './identity.ts';
import { branchTip, createPull, performMerge, pullFiles, pullWouldConflict } from './api.ts';
import { jsonReply } from './web.ts';
import type { Reply } from './web.ts';

// --------------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let text = '';
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) {
        text += source[j];
        j += 1;
      }
      const value = Number(text);
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value } : { kind: 'int', value });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// -------------------------------------------------------------------- parser

type ValueAst =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueAst[] }
  | { kind: 'object'; fields: { name: string; value: ValueAst }[] };

interface FieldAst {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueAst }[];
  directives: { name: string; args: { name: string; value: ValueAst }[] }[];
  selection: SelectionAst[] | null;
}

type SelectionAst =
  | { kind: 'field'; field: FieldAst }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionAst[] }
  | { kind: 'spread'; name: string };

interface OperationAst {
  type: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; defaultValue: ValueAst | null }[];
  selection: SelectionAst[];
}

interface DocumentAst {
  operations: OperationAst[];
  fragments: Map<string, { typeCondition: string | null; selection: SelectionAst[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private take(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.atPunct(value)) throw new Error(`expected "${value}"`);
    this.pos += 1;
  }

  private expectName(): string {
    const token = this.take();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentAst {
    const operations: OperationAst[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selection: SelectionAst[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (this.atPunct('{')) {
        operations.push({ type: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = token.value as 'query' | 'mutation';
        this.take();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const variables: OperationAst['variables'] = [];
        if (this.atPunct('(')) {
          this.take();
          while (!this.atPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            let defaultValue: ValueAst | null = null;
            if (this.atPunct('=')) {
              this.take();
              defaultValue = this.parseValue();
            }
            variables.push({ name: varName, defaultValue });
          }
          this.expectPunct(')');
        }
        this.parseDirectives();
        operations.push({ type, name, variables, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.take();
        const fragName = this.expectName();
        const onToken = this.take();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('fragment needs "on"');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error('unexpected token in document');
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.take();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.take();
  }

  private parseDirectives(): { name: string; args: { name: string; value: ValueAst }[] }[] {
    const directives: FieldAst['directives'] = [];
    while (this.atPunct('@')) {
      this.take();
      const name = this.expectName();
      const args = this.atPunct('(') ? this.parseArgs() : [];
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArgs(): { name: string; value: ValueAst }[] {
    const args: { name: string; value: ValueAst }[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueAst {
    const token = this.peek();
    if (this.atPunct('$')) {
      this.take();
      return { kind: 'var', name: this.expectName() };
    }
    if (token.kind === 'string') {
      this.take();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'int' || token.kind === 'float') {
      this.take();
      return { kind: 'number', value: token.value };
    }
    if (token.kind === 'name') {
      this.take();
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (this.atPunct('[')) {
      this.take();
      const items: ValueAst[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (this.atPunct('{')) {
      this.take();
      const fields: { name: string; value: ValueAst }[] = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }

  private parseSelectionSet(): SelectionAst[] {
    this.expectPunct('{');
    const selections: SelectionAst[] = [];
    while (!this.atPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionAst {
    if (this.peek().kind === 'spread') {
      this.take();
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
        this.take();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.parseDirectives();
      return { kind: 'spread', name };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.atPunct(':')) {
      this.take();
      alias = name;
      name = this.expectName();
    }
    const args = this.atPunct('(') ? this.parseArgs() : [];
    const directives = this.parseDirectives();
    const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', field: { alias, name, args, directives, selection } };
  }
}

// ------------------------------------------------------------------ executor

type GqlObject = { __gqlType: string; [key: string]: unknown };
type Resolver = (obj: GqlObject, args: Record<string, unknown>, ctx: Ctx) => unknown;

interface Ctx {
  forge: Forge;
  fragments: DocumentAst['fragments'];
  errors: { message: string }[];
  variables: Record<string, unknown>;
}

function resolveValue(ast: ValueAst, variables: Record<string, unknown>): unknown {
  switch (ast.kind) {
    case 'var':
      return variables[ast.name];
    case 'string':
    case 'number':
    case 'bool':
    case 'enum':
      return ast.value;
    case 'null':
      return null;
    case 'list':
      return ast.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of ast.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValues(field: FieldAst, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

function directiveSkips(field: FieldAst, ctx: Ctx): boolean {
  for (const directive of field.directives) {
    const args: Record<string, unknown> = {};
    for (const arg of directive.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
    if (directive.name === 'skip' && args.if === true) return true;
    if (directive.name === 'include' && args.if === false) return true;
  }
  return false;
}

function completeValue(value: unknown, selection: SelectionAst[] | null, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selection, ctx));
  if (typeof value === 'object' && selection) {
    const obj = value as GqlObject;
    if (typeof obj.__gqlType === 'string') {
      const out: Record<string, unknown> = {};
      executeInto(obj.__gqlType, obj, selection, ctx, out);
      return out;
    }
  }
  return value;
}

function executeInto(
  typeName: string,
  obj: GqlObject,
  selections: SelectionAst[],
  ctx: Ctx,
  out: Record<string, unknown>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        executeInto(typeName, obj, selection.selection, ctx, out);
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && (fragment.typeCondition === null || fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        executeInto(typeName, obj, fragment.selection, ctx, out);
      }
      continue;
    }
    const field = selection.field;
    if (directiveSkips(field, ctx)) continue;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const table = RESOLVERS[typeName];
    const resolver = table ? table[field.name] : undefined;
    if (!resolver) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    try {
      const value = resolver(obj, argValues(field, ctx), ctx);
      out[key] = completeValue(value, field.selection, ctx);
    } catch (error) {
      ctx.errors.push({ message: (error as Error).message });
      out[key] = null;
    }
  }
}

// ------------------------------------------------------------------- objects

const userObj = (): GqlObject => ({ __gqlType: 'User' });
const repoObj = (repo: RepoRecord): GqlObject => ({ __gqlType: 'Repository', repo });
const issueObj = (repo: RepoRecord, issue: IssueRecord): GqlObject => ({ __gqlType: 'Issue', repo, issue });
const pullObj = (repo: RepoRecord, pull: PullRecord): GqlObject => ({ __gqlType: 'PullRequest', repo, pull });
const commentObj = (repo: RepoRecord, issue: IssueRecord, comment: CommentRecord): GqlObject => ({
  __gqlType: 'IssueComment',
  repo,
  issue,
  comment,
});
const typeObj = (name: string): GqlObject => ({ __gqlType: '__Type', name });
const fieldObj = (name: string): GqlObject => ({ __gqlType: '__Field', name });
const enumObj = (name: string): GqlObject => ({ __gqlType: '__EnumValue', name });
const pageInfoObj = (info: { hasNextPage: boolean; endCursor: string | null }): GqlObject => ({
  __gqlType: 'PageInfo',
  hasNextPage: info.hasNextPage,
  hasPreviousPage: false,
  startCursor: null,
  endCursor: info.endCursor,
});

function cursorFor(kind: string, number: number): string {
  return Buffer.from(`${kind}:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const value = Number.parseInt(text.slice(text.lastIndexOf(':') + 1), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

interface ConnectionItem {
  number: number;
  node: GqlObject;
}

function connection(
  kind: string,
  items: ConnectionItem[],
  args: Record<string, unknown>,
): GqlObject {
  const after = cursorNumber(args.after);
  let start = 0;
  if (after !== null) {
    const at = items.findIndex((item) => item.number === after);
    if (at >= 0) start = at + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : items.length;
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length > 0 ? cursorFor(kind, page[page.length - 1].number) : null;
  return {
    __gqlType: kind,
    nodes: page.map((item) => item.node),
    edges: page.map((item) => ({ __gqlType: `${kind}Edge`, node: item.node, cursor: cursorFor(kind, item.number) })),
    pageInfo: pageInfoObj({ hasNextPage, endCursor }),
    totalCount: items.length,
  };
}

// ----------------------------------------------------------------- resolvers

function graphState(pull: PullRecord): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function findRepoByNode(ctx: Ctx, id: unknown): RepoRecord | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeNodeId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  return ctx.forge.repoById(Number.parseInt(decoded.parts[0], 10)) ?? null;
}

function findIssueByNode(ctx: Ctx, id: unknown): { repo: RepoRecord; issue: IssueRecord } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeNodeId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const repo = ctx.forge.repoById(Number.parseInt(decoded.parts[0], 10));
  const issue = repo?.issues.get(Number.parseInt(decoded.parts[1], 10));
  return repo && issue ? { repo, issue } : null;
}

function findPullByNode(ctx: Ctx, id: unknown): { repo: RepoRecord; pull: PullRecord } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeNodeId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const repo = ctx.forge.repoById(Number.parseInt(decoded.parts[0], 10));
  const pull = repo?.pulls.get(Number.parseInt(decoded.parts[1], 10));
  return repo && pull ? { repo, pull } : null;
}

function nodeById(ctx: Ctx, id: unknown): GqlObject | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeNodeId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') {
    const repo = ctx.forge.repoById(Number.parseInt(decoded.parts[0], 10));
    return repo ? repoObj(repo) : null;
  }
  if (decoded.kind === 'Issue') {
    const found = findIssueByNode(ctx, id);
    return found ? issueObj(found.repo, found.issue) : null;
  }
  if (decoded.kind === 'PullRequest') {
    const found = findPullByNode(ctx, id);
    return found ? pullObj(found.repo, found.pull) : null;
  }
  if (decoded.kind === 'Comment') {
    const found = ctx.forge.commentIndex.get(Number.parseInt(decoded.parts[0], 10));
    return found ? commentObj(found.repo, found.issue, found.comment) : null;
  }
  if (decoded.kind === 'User') return userObj();
  return null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObj(),
    repository: (_obj, args, ctx) => {
      if (args.owner !== VIEWER.login || typeof args.name !== 'string') return null;
      const repo = ctx.forge.repoByName(args.name);
      return repo ? repoObj(repo) : null;
    },
    node: (_obj, args, ctx) => nodeById(ctx, args.id),
    __type: (_obj, args) => (typeof args.name === 'string' && TYPE_DEFS[args.name] ? typeObj(args.name) : null),
    __schema: () => ({ __gqlType: '__Schema' }),
  },
  Mutation: {
    createIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByNode(ctx, input.repositoryId);
      if (!repo) throw new Error('repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = ctx.forge.openIssue(repo, title, body, []);
      return { __gqlType: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: null };
    },
    closeIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByNode(ctx, input.issueId);
      if (!found) throw new Error('issue not found');
      found.issue.state = 'closed';
      found.issue.updatedSeq = ctx.forge.tick();
      return { __gqlType: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: null };
    },
    createPullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByNode(ctx, input.repositoryId);
      if (!repo) throw new Error('repository not found');
      const created = createPull(
        ctx.forge,
        repo,
        typeof input.title === 'string' ? input.title : '',
        typeof input.body === 'string' ? input.body : '',
        typeof input.headRefName === 'string' ? input.headRefName : '',
        typeof input.baseRefName === 'string' ? input.baseRefName : '',
      );
      if (!created.ok) throw new Error(created.message);
      return { __gqlType: 'CreatePullRequestPayload', pullRequest: pullObj(repo, created.value), clientMutationId: null };
    },
    mergePullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullByNode(ctx, input.pullRequestId);
      if (!found) throw new Error('pull request not found');
      const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
      const method = methodRaw === 'SQUASH' ? 'squash' : methodRaw === 'REBASE' ? 'rebase' : 'merge';
      const merged = performMerge(ctx.forge, found.repo, found.pull, method);
      if (!merged.ok) throw new Error(merged.message);
      return { __gqlType: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: null };
    },
    addComment: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByNode(ctx, input.subjectId);
      if (!found) throw new Error('subject not found');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = ctx.forge.addComment(found.repo, found.issue, body);
      const node = commentObj(found.repo, found.issue, comment);
      return {
        __gqlType: 'AddCommentPayload',
        commentEdge: { __gqlType: 'IssueCommentEdge', node, cursor: cursorFor('comment', comment.globalId) },
        subject: issueObj(found.repo, found.issue),
        clientMutationId: null,
      };
    },
  },
  User: {
    login: () => VIEWER.login,
    id: () => userNodeId(),
    databaseId: () => VIEWER.numericId,
    name: () => VIEWER.displayName,
    email: () => VIEWER.email,
    url: () => '',
  },
  Repository: {
    id: (obj) => repoNodeId(obj.repo as RepoRecord),
    databaseId: (obj) => (obj.repo as RepoRecord).id,
    name: (obj) => (obj.repo as RepoRecord).name,
    nameWithOwner: (obj) => `${VIEWER.login}/${(obj.repo as RepoRecord).name}`,
    description: (obj) => (obj.repo as RepoRecord).description,
    isPrivate: (obj) => (obj.repo as RepoRecord).isPrivate,
    createdAt: (obj, _args, ctx) => ctx.forge.isoAt((obj.repo as RepoRecord).createdSeq),
    updatedAt: (obj, _args, ctx) => ctx.forge.isoAt((obj.repo as RepoRecord).createdSeq),
    url: () => '',
    owner: () => userObj(),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    defaultBranchRef: (obj) => {
      const repo = obj.repo as RepoRecord;
      const tip = repo.refs.get(`refs/heads/main`);
      if (!tip) return null;
      return { __gqlType: 'Ref', name: 'main', oid: tip };
    },
    issue: (obj, args) => {
      const repo = obj.repo as RepoRecord;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue ? issueObj(repo, issue) : null;
    },
    issues: (obj, args) => {
      const repo = obj.repo as RepoRecord;
      let issues = [...repo.issues.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const descending = orderBy.direction === 'DESC';
      issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      return connection('IssueConnection', issues.map((issue) => ({ number: issue.number, node: issueObj(repo, issue) })), args);
    },
    pullRequest: (obj, args) => {
      const repo = obj.repo as RepoRecord;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull ? pullObj(repo, pull) : null;
    },
    pullRequests: (obj, args) => {
      const repo = obj.repo as RepoRecord;
      let pulls = [...repo.pulls.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((s) => String(s)));
        pulls = pulls.filter((pull) => wanted.has(graphState(pull)));
      }
      pulls.sort((a, b) => a.number - b.number);
      return connection('PullRequestConnection', pulls.map((pull) => ({ number: pull.number, node: pullObj(repo, pull) })), args);
    },
  },
  Ref: {
    name: (obj) => obj.name as string,
    prefix: () => 'refs/heads/',
    target: (obj) => ({ __gqlType: 'Commit', oid: obj.oid as string }),
  },
  Commit: {
    oid: (obj) => obj.oid as string,
    id: (obj) => obj.oid as string,
  },
  Issue: {
    id: (obj) => issueNodeId(obj.repo as RepoRecord, obj.issue as IssueRecord),
    number: (obj) => (obj.issue as IssueRecord).number,
    title: (obj) => (obj.issue as IssueRecord).title,
    body: (obj) => (obj.issue as IssueRecord).body,
    state: (obj) => ((obj.issue as IssueRecord).state === 'open' ? 'OPEN' : 'CLOSED'),
    closed: (obj) => (obj.issue as IssueRecord).state === 'closed',
    url: () => '',
    createdAt: (obj, _args, ctx) => ctx.forge.isoAt((obj.issue as IssueRecord).createdSeq),
    updatedAt: (obj, _args, ctx) => ctx.forge.isoAt((obj.issue as IssueRecord).updatedSeq),
    author: () => userObj(),
    repository: (obj) => repoObj(obj.repo as RepoRecord),
    labels: (obj) => {
      const repo = obj.repo as RepoRecord;
      const issue = obj.issue as IssueRecord;
      const nodes: GqlObject[] = [];
      for (const name of issue.labelNames) {
        const label = repo.labels.get(name);
        if (label) nodes.push({ __gqlType: 'Label', label });
      }
      return {
        __gqlType: 'LabelConnection',
        nodes,
        edges: nodes.map((node) => ({ __gqlType: 'LabelConnectionEdge', node, cursor: '' })),
        pageInfo: pageInfoObj({ hasNextPage: false, endCursor: null }),
        totalCount: nodes.length,
      };
    },
  },
  Label: {
    id: (obj) => `label-${(obj.label as LabelRecord).id}`,
    name: (obj) => (obj.label as LabelRecord).name,
    color: (obj) => (obj.label as LabelRecord).color,
    description: (obj) => (obj.label as LabelRecord).description,
  },
  PullRequest: {
    id: (obj) => pullNodeId(obj.repo as RepoRecord, obj.pull as PullRecord),
    number: (obj) => (obj.pull as PullRecord).number,
    title: (obj) => (obj.pull as PullRecord).title,
    body: (obj) => (obj.pull as PullRecord).body,
    state: (obj) => graphState(obj.pull as PullRecord),
    merged: (obj) => (obj.pull as PullRecord).merged,
    mergeable: (obj) => (pullWouldConflict(obj.repo as RepoRecord, obj.pull as PullRecord) ? 'CONFLICTING' : 'MERGEABLE'),
    headRefName: (obj) => (obj.pull as PullRecord).headRef,
    baseRefName: (obj) => (obj.pull as PullRecord).baseRef,
    headRefOid: (obj) => branchTip(obj.repo as RepoRecord, (obj.pull as PullRecord).headRef) ?? '',
    baseRefOid: (obj) => branchTip(obj.repo as RepoRecord, (obj.pull as PullRecord).baseRef) ?? '',
    url: () => '',
    createdAt: (obj, _args, ctx) => ctx.forge.isoAt((obj.pull as PullRecord).createdSeq),
    updatedAt: (obj, _args, ctx) => ctx.forge.isoAt((obj.pull as PullRecord).updatedSeq),
    author: () => userObj(),
    repository: (obj) => repoObj(obj.repo as RepoRecord),
    files: (obj, args) => {
      const repo = obj.repo as RepoRecord;
      const pull = obj.pull as PullRecord;
      const files = pullFiles(repo, pull);
      const items: ConnectionItem[] = files.map((file, index) => ({
        number: index,
        node: {
          __gqlType: 'PullRequestChangedFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status.toUpperCase(),
        },
      }));
      return connection('PullRequestChangedFileConnection', items, args);
    },
  },
  PullRequestChangedFile: {
    path: (obj) => obj.path as string,
    additions: (obj) => obj.additions as number,
    deletions: (obj) => obj.deletions as number,
    changeType: (obj) => obj.changeType as string,
  },
  IssueComment: {
    id: (obj) => commentNodeId(obj.comment as CommentRecord),
    body: (obj) => (obj.comment as CommentRecord).body,
    createdAt: (obj, _args, ctx) => ctx.forge.isoAt((obj.comment as CommentRecord).seq),
    updatedAt: (obj, _args, ctx) => ctx.forge.isoAt((obj.comment as CommentRecord).seq),
    author: () => userObj(),
    url: () => '',
  },
  Node: {
    id: (obj) => {
      const inner = obj as unknown as GqlObject;
      void inner;
      return '';
    },
  },
  __Type: {
    name: (obj) => obj.name as string,
    kind: (obj) => TYPE_DEFS[obj.name as string]?.kind ?? 'OBJECT',
    description: () => null,
    fields: (obj) => {
      const def = TYPE_DEFS[obj.name as string];
      if (!def || def.kind !== 'OBJECT' && def.kind !== 'INTERFACE') return null;
      return (def.fields ?? []).map((name) => fieldObj(name));
    },
    enumValues: (obj) => {
      const def = TYPE_DEFS[obj.name as string];
      if (!def || def.kind !== 'ENUM') return null;
      return (def.values ?? []).map((name) => enumObj(name));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    interfaces: () => [],
    specifiedByURL: () => null,
    ofType: () => null,
  },
  __Field: {
    name: (obj) => obj.name as string,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (obj) => obj.name as string,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    queryType: () => typeObj('Query'),
    mutationType: () => typeObj('Mutation'),
    subscriptionType: () => null,
    types: () => Object.keys(TYPE_DEFS).map((name) => typeObj(name)),
    directives: () => [],
  },
  PageInfo: {
    hasNextPage: (obj) => obj.hasNextPage as boolean,
    hasPreviousPage: (obj) => obj.hasPreviousPage as boolean,
    startCursor: (obj) => obj.startCursor as string | null,
    endCursor: (obj) => obj.endCursor as string | null,
  },
};

// Connections and payloads resolve structurally: nodes/edges/pageInfo plus
// whichever payload field they carry.
for (const kind of ['IssueConnection', 'PullRequestConnection', 'PullRequestChangedFileConnection', 'LabelConnection']) {
  RESOLVERS[kind] = {
    nodes: (obj) => obj.nodes as GqlObject[],
    edges: (obj) => obj.edges as GqlObject[],
    pageInfo: (obj) => obj.pageInfo as GqlObject,
    totalCount: (obj) => obj.totalCount as number,
  };
  RESOLVERS[`${kind}Edge`] = {
    node: (obj) => obj.node as GqlObject,
    cursor: (obj) => obj.cursor as string,
  };
}
RESOLVERS.IssueCommentEdge = {
  node: (obj) => obj.node as GqlObject,
  cursor: (obj) => obj.cursor as string,
};
for (const kind of ['CreateIssuePayload', 'CloseIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload']) {
  RESOLVERS[kind] = {
    issue: (obj) => (obj.issue as GqlObject | undefined) ?? null,
    pullRequest: (obj) => (obj.pullRequest as GqlObject | undefined) ?? null,
    commentEdge: (obj) => (obj.commentEdge as GqlObject | undefined) ?? null,
    subject: (obj) => (obj.subject as GqlObject | undefined) ?? null,
    clientMutationId: (obj) => (obj.clientMutationId as string | null) ?? null,
  };
}

// ------------------------------------------------------------------ the schema

interface TypeDef {
  kind: string;
  fields?: string[];
  values?: string[];
}

const TYPE_DEFS: Record<string, TypeDef> = {};
function defObject(name: string): void {
  TYPE_DEFS[name] = { kind: 'OBJECT', fields: Object.keys(RESOLVERS[name] ?? {}) };
}
for (const name of [
  'Query', 'Mutation', 'User', 'Repository', 'Ref', 'Commit', 'Issue', 'Label',
  'PullRequest', 'PullRequestChangedFile', 'IssueComment',
  'IssueConnection', 'PullRequestConnection', 'PullRequestChangedFileConnection', 'LabelConnection',
  '__Type', '__Field', '__EnumValue', '__Schema', 'PageInfo',
]) {
  defObject(name);
}
TYPE_DEFS.Node = { kind: 'INTERFACE', fields: ['id'] };
TYPE_DEFS.SearchType = { kind: 'ENUM', values: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'CODE', 'COMMIT'] };
TYPE_DEFS.IssueState = { kind: 'ENUM', values: ['OPEN', 'CLOSED'] };
TYPE_DEFS.PullRequestState = { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] };
TYPE_DEFS.MergeableState = { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] };
TYPE_DEFS.MergeMethod = { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] };
TYPE_DEFS.OrderDirection = { kind: 'ENUM', values: ['ASC', 'DESC'] };
TYPE_DEFS.IssueOrderField = { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] };

// ------------------------------------------------------------------ HTTP entry

function executeOne(forge: Forge, op: unknown): Record<string, unknown> {
  const record = (typeof op === 'object' && op !== null ? op : {}) as Record<string, unknown>;
  const queryText = typeof record.query === 'string' ? record.query : '';
  const variables = (typeof record.variables === 'object' && record.variables !== null
    ? record.variables
    : {}) as Record<string, unknown>;
  const ctx: Ctx = { forge, fragments: new Map(), errors: [], variables };
  try {
    const document = new Parser(lex(queryText)).parseDocument();
    ctx.fragments = document.fragments;
    let operation: OperationAst | undefined;
    const wanted = typeof record.operationName === 'string' ? record.operationName : null;
    if (wanted) operation = document.operations.find((o) => o.name === wanted);
    if (!operation) operation = document.operations[0];
    if (!operation) throw new Error('no operation in document');
    for (const def of operation.variables) {
      if (ctx.variables[def.name] === undefined && def.defaultValue) {
        ctx.variables[def.name] = resolveValue(def.defaultValue, ctx.variables);
      }
    }
    const root: GqlObject = { __gqlType: operation.type === 'mutation' ? 'Mutation' : 'Query' };
    const data: Record<string, unknown> = {};
    executeInto(root.__gqlType, root, operation.selection, ctx, data);
    const out: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) out.errors = ctx.errors;
    return out;
  } catch (error) {
    return { data: null, errors: [{ message: (error as Error).message }] };
  }
}

export function handleGraphQL(forge: Forge, body: unknown): Reply {
  if (Array.isArray(body)) {
    return jsonReply(200, body.map((op) => executeOne(forge, op)));
  }
  return jsonReply(200, executeOne(forge, body));
}
