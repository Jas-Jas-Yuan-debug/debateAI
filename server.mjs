// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DebateEngine, exportMarkdown } from './lib/engine.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const fileEnv = {};
try {
  const source = await readFile(path.join(ROOT, '.env'), 'utf8');
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    fileEnv[match[1]] = value;
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const setting = (key, fallback) => process.env[key] ?? fileEnv[key] ?? fallback;
const PORT = Number(setting('PORT', '3417'));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const REQUEST_TIMEOUT_MS = Number(setting('REQUEST_TIMEOUT_MS', '300000'));
if (!Number.isInteger(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS < 1000 || REQUEST_TIMEOUT_MS > 1800000) throw new Error('REQUEST_TIMEOUT_MS must be an integer from 1000 to 1800000.');
const FIRST_TEXT_TIMEOUT_MS = Number(setting('FIRST_TEXT_TIMEOUT_MS', '1800000'));
const REQUEST_MAX_DURATION_MS = Number(setting('REQUEST_MAX_DURATION_MS', '2700000'));
if (!Number.isInteger(FIRST_TEXT_TIMEOUT_MS) || FIRST_TEXT_TIMEOUT_MS < 1000 || FIRST_TEXT_TIMEOUT_MS > 3600000) throw new Error('FIRST_TEXT_TIMEOUT_MS must be an integer from 1000 to 3600000.');
if (!Number.isInteger(REQUEST_MAX_DURATION_MS) || REQUEST_MAX_DURATION_MS < FIRST_TEXT_TIMEOUT_MS || REQUEST_MAX_DURATION_MS > 7200000) throw new Error('REQUEST_MAX_DURATION_MS must allow the first text deadline and be at most 7200000.');
const engine = await new DebateEngine({
  baseUrl: setting('BASE_URL', 'http://127.0.0.1:8317/v1'),
  apiKey: setting('API_KEY', ''),
  dataDir: path.resolve(ROOT, setting('DATA_DIR', 'data')),
  timeoutMs: REQUEST_TIMEOUT_MS,
  firstTextTimeoutMs: FIRST_TEXT_TIMEOUT_MS,
  maxDurationMs: REQUEST_MAX_DURATION_MS,
}).init();
const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const origins = new Set([...hosts].map(host => `http://${host}`));
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const streams = new Set();

function respond(res, status, value, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
async function body(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 65536) fail(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!bytes) return {};
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'Use Content-Type: application/json.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Request body must contain valid JSON.'); }
}
function requireOrigin(req) {
  if (req.headers.origin && !origins.has(req.headers.origin)) fail(403, 'This local app accepts changes only from its own browser origin.');
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site changes are not permitted.');
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hosts.has(req.headers.host?.toLowerCase())) fail(403, 'Use the local application URL.');
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const route = url.pathname;
    if (route.startsWith('/api/')) {
      if (req.method === 'POST') requireOrigin(req);
      if (req.method === 'GET' && route === '/api/config') return respond(res, 200, engine.config());
      if (req.method === 'GET' && route === '/api/models') return respond(res, 200, await engine.availableModels());
      if (req.method === 'GET' && route === '/api/health') return respond(res, 200, await engine.health());
      if (req.method === 'GET' && route === '/api/runs') return respond(res, 200, engine.list());
      if (req.method === 'POST' && route === '/api/runs') {
        const run = await engine.create(await body(req));
        return respond(res, 202, { id: run.id, run });
      }
      const match = route.match(new RegExp(`^/api/runs/(${UUID})(?:/(events|export|cancel|resume))?$`));
      if (!match) return respond(res, 404, { error: 'API route not found.' });
      const [, id, action] = match;
      const run = engine.get(id);
      if (!run) return respond(res, 404, { error: 'Round not found.' });
      if (req.method === 'GET' && !action) return respond(res, 200, run);
      if (req.method === 'POST' && ['cancel', 'resume'].includes(action)) {
        await body(req);
        const updated = await engine[action](id);
        return respond(res, action === 'resume' ? 202 : 200, { id, run: updated });
      }
      if (req.method === 'GET' && action === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        res.flushHeaders();
        streams.add(res);
        const unsubscribeDeltas = engine.subscribeDeltas(id, packet => {
          if (!res.destroyed && !res.writableEnded) res.write(`event: delta\ndata: ${JSON.stringify(packet)}\n\n`);
        });
        const unsubscribe = engine.subscribe(id, state => {
          if (!res.destroyed && !res.writableEnded) res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        });
        const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 15000);
        const cleanup = () => { clearInterval(heartbeat); unsubscribe?.(); unsubscribeDeltas?.(); streams.delete(res); };
        req.once('close', cleanup); res.once('error', cleanup);
        return;
      }
      if (req.method === 'GET' && action === 'export') {
        const format = url.searchParams.get('format') || 'md';
        if (!['md', 'json'].includes(format)) fail(400, 'Export format must be md or json.');
        res.writeHead(200, { 'Content-Type': format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="debate-${id}.${format}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(format === 'md' ? exportMarkdown(run) : JSON.stringify(run, null, 2));
      }
      return respond(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
    }
    if (!['GET', 'HEAD'].includes(req.method)) return respond(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
    if (route === '/favicon.ico') { res.writeHead(204); return res.end(); }
    let decoded;
    try { decoded = decodeURIComponent(route); } catch { fail(400, 'Invalid URL.'); }
    const filename = path.resolve(PUBLIC, `.${decoded === '/' ? '/index.html' : decoded}`);
    if (!filename.startsWith(`${PUBLIC}${path.sep}`) || filename.includes('\0')) fail(404, 'File not found.');
    let content;
    try { content = await readFile(filename); }
    catch (error) { if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) fail(404, 'File not found.'); throw error; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'self'; frame-ancestors 'self'" });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    respond(res, error.status || 400, { error: engine.safeError(error) });
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(PORT, '127.0.0.1', () => console.log(`Debate AI Chamber: http://localhost:${PORT}`));
server.on('error', error => { console.error(`Could not start the local debate server: ${error.code || error.message}`); process.exitCode = 1; });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const res of streams) res.end();
  server.close();
  await engine.close();
  server.closeAllConnections();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
