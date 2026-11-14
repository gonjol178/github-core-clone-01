// The HTTP server: one listener routing to the git endpoints, REST v3,
// GraphQL and MCP, all backed by a single Forge store. The bearer token is
// checked here for the three API surfaces; every REST reply, errors
// included, is JSON carrying a request id.

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { Forge } from './lib/store.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { infoRefs, receivePack, uploadPack } from './lib/githttp.ts';
import { jsonReply, messageReply, textReply } from './lib/web.ts';
import type { Reply } from './lib/web.ts';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  const headers: Record<string, string | number> = {
    'Content-Type': reply.type,
    'Content-Length': reply.body.length,
    'X-GitHub-Request-Id': requestId,
    ...(reply.headers ?? {}),
  };
  res.writeHead(reply.status, headers);
  res.end(reply.body);
}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function createForgeServer(token: string): Server {
  const forge = new Forge();
  let requestCounter = 0;
  const expectedAuth = `Bearer ${token}`;

  const route = async (req: IncomingMessage): Promise<Reply> => {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://forge.invalid');
    const segments = url.pathname.split('/').filter((s) => s.length > 0).map(decodeSegment);
    const host = req.headers.host ?? 'localhost';
    const base = `http://${host}`;
    const body = await readBody(req);

    if (segments.length === 1 && segments[0] === 'healthz') {
      if (method !== 'GET') return textReply(404, 'not found');
      return jsonReply(200, { ok: true });
    }

    if (segments[0] === 'api' && segments[1] === 'v3') {
      if (req.headers.authorization !== expectedAuth) return messageReply(401, 'Bad credentials');
      let parsed: unknown;
      if (body.length > 0) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          return messageReply(400, 'Problems parsing JSON');
        }
      }
      const reply = handleRest(forge, method, segments.slice(2), url.searchParams, parsed, base);
      if (segments.length === 2 && method === 'GET') {
        reply.headers = { ...(reply.headers ?? {}), 'X-OAuth-Scopes': 'repo, read:org' };
      }
      return reply;
    }

    if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
      if (req.headers.authorization !== expectedAuth) return messageReply(401, 'Bad credentials');
      if (method !== 'POST') return messageReply(404, 'Not Found');
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return messageReply(400, 'Problems parsing JSON');
      }
      return handleGraphQL(forge, parsed);
    }

    if (segments[0] === 'mcp' && segments.length === 1) {
      if (req.headers.authorization !== expectedAuth) return messageReply(401, 'Unauthorized');
      if (method === 'DELETE') return textReply(200, '');
      if (method !== 'POST') return textReply(405, 'method not allowed');
      return handleMcp(forge, body, base);
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    if (segments.length >= 2 && segments[1].endsWith('.git')) {
      const owner = segments[0];
      const repoName = segments[1].slice(0, -'.git'.length);
      const protocol = req.headers['git-protocol'];
      const version2 = typeof protocol === 'string' && protocol.includes('version=2');
      if (method === 'GET' && segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
        return infoRefs(forge, owner, repoName, url.searchParams.get('service') ?? '', version2);
      }
      if (method === 'POST' && segments.length === 3 && segments[2] === 'git-upload-pack') {
        return uploadPack(forge, owner, repoName, version2, body);
      }
      if (method === 'POST' && segments.length === 3 && segments[2] === 'git-receive-pack') {
        return receivePack(forge, owner, repoName, body);
      }
      return messageReply(404, 'Not Found');
    }

    return messageReply(404, 'Not Found');
  };

  const server = createServer((req, res) => {
    requestCounter += 1;
    const requestId = `forge-${requestCounter.toString(16).padStart(8, '0')}`;
    route(req)
      .then((reply) => send(res, reply, requestId))
      .catch(() => {
        if (!res.headersSent) send(res, messageReply(500, 'Internal Server Error'), requestId);
        else res.end();
      });
  });
  return server;
}
