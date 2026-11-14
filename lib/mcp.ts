// MCP over Streamable HTTP: JSON-RPC 2.0 answered as plain JSON. The server
// speaks the 2026-07-28 revision through server/discover and still answers
// the older initialize handshake. It issues no session id, so it stays
// stateless. The six tools act on the same store as REST and GraphQL, and
// the tools/list payload is built once and served byte-identically forever.

import type { Forge, RepoRecord } from './store.ts';
import { VIEWER } from './identity.ts';
import { createPull, issueJson, performMerge, pullJson, repoJson } from './api.ts';
import { jsonReply, textReply } from './web.ts';
import type { Reply } from './web.ts';

const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated account.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function rpcResult(id: unknown, result: unknown): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200): Reply {
  return jsonReply(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function lookupRepo(forge: Forge, args: Record<string, unknown>): RepoRecord | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  let repoName = typeof args.repo === 'string' ? args.repo : '';
  if (repoName.includes('/')) repoName = repoName.split('/').pop() as string;
  if (owner !== '' && owner !== VIEWER.login) return null;
  return forge.repoByName(repoName) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>, base: string): Record<string, unknown> {
  const def = TOOLS_BY_NAME.get(name);
  if (!def) throw new Error(`unknown tool ${name}`);
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolFailure(`missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (forge.repoByName(repoName)) return toolFailure(`repository ${repoName} already exists`);
      const repo = forge.createRepo(
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return toolSuccess(repoJson(forge, repo, base));
    }
    case 'get_repo': {
      const repo = lookupRepo(forge, args);
      if (!repo) return toolFailure('repository not found');
      return toolSuccess(repoJson(forge, repo, base));
    }
    case 'create_issue': {
      const repo = lookupRepo(forge, args);
      if (!repo) return toolFailure('repository not found');
      const issue = forge.openIssue(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        [],
      );
      return toolSuccess(issueJson(forge, repo, issue, base));
    }
    case 'list_issues': {
      const repo = lookupRepo(forge, args);
      if (!repo) return toolFailure('repository not found');
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return toolSuccess(issues.map((issue) => issueJson(forge, repo, issue, base)));
    }
    case 'create_pull_request': {
      const repo = lookupRepo(forge, args);
      if (!repo) return toolFailure('repository not found');
      const created = createPull(
        forge,
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        String(args.head),
        String(args.base),
      );
      if (!created.ok) return toolFailure(created.message);
      return toolSuccess(pullJson(forge, repo, created.value, base));
    }
    case 'merge_pull_request': {
      const repo = lookupRepo(forge, args);
      if (!repo) return toolFailure('repository not found');
      const number = Number(args.pull_number);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (!pull) return toolFailure('pull request not found');
      const merged = performMerge(forge, repo, pull, 'squash');
      if (!merged.ok) return toolFailure(merged.message);
      return toolSuccess(pullJson(forge, repo, pull, base));
    }
    default:
      return toolFailure(`unimplemented tool ${name}`);
  }
}

function handleOne(forge: Forge, message: Record<string, unknown>, base: string): Reply | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const id = message.id;
  if (!hasId) {
    // A notification: accepted, never answered.
    return null;
  }
  const params = (typeof message.params === 'object' && message.params !== null
    ? message.params
    : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_REVISIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const revision = SUPPORTED_REVISIONS.includes(asked) ? asked : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: revision,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      if (!TOOLS_BY_NAME.has(toolName)) return rpcError(id, -32602, `unknown tool: ${toolName}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null
        ? params.arguments
        : {}) as Record<string, unknown>;
      try {
        return rpcResult(id, callTool(forge, toolName, args, base));
      } catch (error) {
        return rpcResult(id, toolFailure((error as Error).message));
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export function handleMcp(forge: Forge, rawBody: Buffer, base: string): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return jsonReply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const item of parsed) {
      const reply = handleOne(forge, (item ?? {}) as Record<string, unknown>, base);
      if (reply) replies.push(JSON.parse(reply.body.toString('utf8')));
    }
    return jsonReply(200, replies);
  }
  const reply = handleOne(forge, (parsed ?? {}) as Record<string, unknown>, base);
  if (!reply) return textReply(202, '');
  return reply;
}
