// app.ts — the HTTP server: routing, auth, body parsing, request ids.
// Routes: /healthz, /api/v3/*, /api/graphql, /mcp, /{owner}/{repo}.git/*.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { ForgeStore } from './store.ts';
import { handleRest } from './rest.ts';
import type { RestContext } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createApp(): Server {
  const store = new ForgeStore();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const isAuthorized = (req: IncomingMessage): boolean => {
    if (token === '') return false;
    const header = req.headers.authorization;
    return header === `Bearer ${token}`;
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void => {
    const payload = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': store.nextRequestId(),
      ...extraHeaders,
    });
    res.end(payload);
  };

  const sendBuffer = (res: ServerResponse, status: number, body: Buffer, contentType: string): void => {
    res.writeHead(status, {
      'content-type': contentType,
      'x-github-request-id': store.nextRequestId(),
    });
    res.end(body);
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        // ---- healthz (no auth)
        if (pathname === '/healthz') {
          if (method !== 'GET') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        // ---- GraphQL
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const result = handleGraphQL(store, parsed);
          sendJson(res, result.status, result.body);
          return;
        }

        // ---- MCP
        if (pathname === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          const result = handleMcp(store, raw.toString('utf8'), isAuthorized(req));
          if (result === null) {
            // A notification: no JSON-RPC response is due.
            res.writeHead(202, { 'x-github-request-id': store.nextRequestId() });
            res.end();
            return;
          }
          if (result.status === 401) {
            sendJson(res, 401, result.body);
            return;
          }
          sendJson(res, result.status, result.body);
          return;
        }

        // ---- REST v3
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const segments = pathname === '/api/v3' ? [] : pathname.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
          let body: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' });
                return;
              }
            }
          }
          const ctx: RestContext = {
            store,
            method,
            segments,
            query: url.searchParams,
            url: `http://${req.headers.host ?? 'localhost'}${pathname}${url.search}`,
            body,
          };
          const result = handleRest(ctx);
          const headers: Record<string, string> = { ...(result.headers ?? {}) };
          if (result.status === 204 || result.body === null) {
            res.writeHead(204, { 'x-github-request-id': store.nextRequestId(), ...headers });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, headers);
          return;
        }

        // ---- git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
        if (gitMatch !== null) {
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const action = gitMatch[3];
          if (action === 'info/refs') {
            const service = url.searchParams.get('service') ?? '';
            const result = handleInfoRefs(store, owner, repoName, service);
            if (result.status === 404) {
              sendJson(res, 404, JSON.parse(result.body.toString('utf8')));
              return;
            }
            if (result.status !== 200) {
              sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
              return;
            }
            sendBuffer(res, 200, result.body, result.contentType);
            return;
          }
          if (action === 'git-upload-pack' && method === 'POST') {
            const raw = await readBody(req);
            const result = handleUploadPack(store, owner, repoName, raw);
            if (result.status !== 200) {
              sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
              return;
            }
            sendBuffer(res, 200, result.body, result.contentType);
            return;
          }
          if (action === 'git-receive-pack' && method === 'POST') {
            const raw = await readBody(req);
            const result = handleReceivePack(store, owner, repoName, raw);
            if (result.status !== 200) {
              sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
              return;
            }
            sendBuffer(res, 200, result.body, result.contentType);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // ---- anything else
        sendJson(res, 404, { message: 'Not Found' });
      } catch (e) {
        process.stderr.write(`[entry] handler error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The response may already be gone; nothing more to do.
        }
      }
    })();
  });

  return server;
}
