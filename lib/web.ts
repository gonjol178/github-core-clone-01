// Shared plumbing for the HTTP surfaces: every handler answers with a
// status, a content type and a body buffer, and the server in app.ts is the
// only place that touches the wire.

export interface Reply {
  status: number;
  type: string;
  body: Buffer;
  headers?: Record<string, string>;
}

export function jsonReply(status: number, value: unknown, headers?: Record<string, string>): Reply {
  return {
    status,
    type: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify(value), 'utf8'),
    headers,
  };
}

export function messageReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

export function bufferReply(status: number, type: string, body: Buffer): Reply {
  return { status, type, body };
}

export function textReply(status: number, text: string): Reply {
  return { status, type: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}
