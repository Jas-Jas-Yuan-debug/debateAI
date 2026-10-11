// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exportMarkdown } from './engine.mjs';
import { SSEHub } from './sse-output.mjs';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'" };
function respond(res, status, value, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(value));
}
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
async function body(req, { bootstrap = false } = {}) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > (bootstrap ? 4096 : 65536)) fail(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!bytes) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (bootstrap && /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    const values = new URLSearchParams(raw);
    if (values.size !== 1 || !values.has('operatorToken')) fail(400, 'Invalid owner access form.');
    return { operatorToken: values.get('operatorToken') };
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'Use Content-Type: application/json.');
  try { return JSON.parse(raw); } catch { fail(400, 'Request body must contain valid JSON.'); }
}

export function createAppServer({ engine, owner, publicDirectory, port = 3417, hub = new SSEHub(), isReady = () => true }) {
  const server = http.createServer(async (req, res) => {
    try {
      const actualPort = server.address()?.port || port;
      const hosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
      const origins = new Set([...hosts].map(host => `http://${host}`));
      if (!hosts.has(req.headers.host?.toLowerCase())) fail(403, 'Use the local application URL.');
      if (!isReady()) fail(503, 'The local chamber is starting. Please retry shortly.');
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`), route = url.pathname;
      const requireOrigin = (bootstrap = false) => {
        // Only the capability-authenticated private-file form may cross from file://.
        if (bootstrap && req.headers.origin === 'null') return;
        if (req.headers.origin && !origins.has(req.headers.origin)) fail(403, 'This local app accepts changes only from its own browser origin.');
        if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site changes are not permitted.');
      };
      if (route.startsWith('/api/')) {
        if (req.method === 'POST' && route === '/api/session') {
          const form = /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] || '');
          const value = await body(req, { bootstrap: true });
          const token = owner.require(req, value?.operatorToken);
          requireOrigin(form);
          if (!form) return respond(res, 200, { ok: true });
          const html = (await readFile(path.join(publicDirectory, 'index.html'), 'utf8')).replace('<head>', `<head><meta name="operator-token" content="${token}">`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
          return res.end(html);
        }
        // All API reads and writes, including unknown routes, share the owner boundary.
        owner.require(req);
        if (req.method === 'POST') requireOrigin();
        if (req.method === 'GET' && route === '/api/config') return respond(res, 200, engine.config());
        if (req.method === 'GET' && route === '/api/models') return respond(res, 200, await engine.availableModels());
        if (req.method === 'GET' && route === '/api/health') return respond(res, 200, await engine.health());
        if (req.method === 'GET' && route === '/api/runs') return respond(res, 200, engine.list());
        if (req.method === 'POST' && route === '/api/runs') {
          const run = await engine.create(await body(req)); return respond(res, 202, { id: run.id, run });
        }
        const match = route.match(new RegExp(`^/api/runs/(${UUID})(?:/(events|export|cancel|resume))?$`));
        if (!match) return respond(res, 404, { error: 'API route not found.' });
        const [, id, action] = match;
        const run = engine.get(id);
        if (!run) return respond(res, 404, { error: 'Round not found.' });
        if (req.method === 'GET' && !action) return respond(res, 200, run);
        if (req.method === 'POST' && ['cancel', 'resume'].includes(action)) {
          await body(req); const updated = await engine[action](id);
          return respond(res, action === 'resume' ? 202 : 200, { id, run: updated });
        }
        if (req.method === 'GET' && action === 'events') {
          const connection = hub.open(req, res, id);
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
          res.flushHeaders();
          connection.addCleanup(engine.subscribeDeltas(id, packet => connection.send(hub.frame('delta', packet), `delta:${packet.stage}`)));
          connection.addCleanup(engine.subscribe(id, state => connection.send(hub.frame('state', state), 'state')));
          return;
        }
        if (req.method === 'GET' && action === 'export') {
          const format = url.searchParams.get('format') || 'md';
          if (!['md', 'json'].includes(format)) fail(400, 'Export format must be md or json.');
          res.writeHead(200, { 'Content-Type': format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="debate-${id}.${format}"`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
          return res.end(format === 'md' ? exportMarkdown(run) : JSON.stringify(run, null, 2));
        }
        return respond(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return respond(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
      if (route === '/ready') return respond(res, 200, { app: 'debate-ai-chamber', ownerAuthentication: true });
      if (route === '/' && req.headers.host?.toLowerCase() !== `127.0.0.1:${actualPort}`) {
        res.writeHead(302, { Location: `http://127.0.0.1:${actualPort}/`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); return res.end();
      }
      if (route === '/favicon.ico') { res.writeHead(204); return res.end(); }
      let decoded;
      try { decoded = decodeURIComponent(route); } catch { fail(400, 'Invalid URL.'); }
      const filename = path.resolve(publicDirectory, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (!filename.startsWith(`${publicDirectory}${path.sep}`) || filename.includes('\0')) fail(404, 'File not found.');
      let content;
      try { content = await readFile(filename); }
      catch (error) { if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) fail(404, 'File not found.'); throw error; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { respond(res, error.status || 400, { error: engine.safeError(error) }); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  return { server, hub };
}
