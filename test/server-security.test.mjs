// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DebateEngine } from '../lib/engine.mjs';
import { createOwnerAccess } from '../lib/owner-access.mjs';
import { createAppServer } from '../lib/server.mjs';
import { SSEHub } from '../lib/sse-output.mjs';
import { DEFAULTS, JUDGES, SPEAKERS, TEAMS } from '../lib/debate.mjs';
import { connectLiveEvents } from '../public/live-events.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t, hubOptions) {
  const directory = await mkdtemp(path.join(tmpdir(), 'chamber-auth-'));
  let hold = true, gatewayCalls = 0;
  const engine = await new DebateEngine({ dataDir: path.join(directory, 'data'), apiKey: 'gateway-fixture-secret',
    fetchImpl: async (url, options) => {
      gatewayCalls++;
      if (url.endsWith('/models')) return Response.json({ data: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-image-1'].map(id => ({ id })) });
      if (hold) return new Promise((resolve, reject) => { if (options.signal.aborted) reject(options.signal.reason); else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
      const body = JSON.parse(options.body), stage = body.messages[1].content.match(/^\[stage:([^\]]+)\]/)[1].split(':')[0];
      const values = { motion: { text: 'This House would make transit free.', infoSlide: '', rationale: 'Compare costs and access.' }, preparation: { plan: 'PRIVATE_AUTH_PLAN' }, opening: { text: 'Transit improves access.' }, poi: { text: 'How is this funded?' }, middle: { accepted: true, response: 'Through public budgets.', text: 'Compare costs and access.' }, closing: { text: 'Access gains outweigh costs.' }, ballot: { ranking: ['OG', 'OO', 'CG', 'CO'], reasoning: 'OG wins the S1 versus S2 comparison; S5 and S6 add less.' } };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(values[stage]) } }] });
    },
  }).init();
  const owner = await createOwnerAccess(path.join(directory, 'owner'), 'http://127.0.0.1:3417');
  const token = (await readFile(path.join(directory, 'owner/operator-token'), 'utf8')).trim();
  const hub = new SSEHub(hubOptions), { server } = createAppServer({ engine, owner, publicDirectory: path.join(root, 'public'), port: 0, hub });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { hub.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options = {}) => fetch(url + route, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  const post = (route, value = {}, headers = {}) => request(route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  return { directory, engine, owner, token, hub, url, request, post, get gatewayCalls() { return gatewayCalls; }, release() { hold = false; } };
}

test('every local API route rejects absent/spoofed owner capability before engine access', async t => {
  const app = await fixture(t), id = '00000000-0000-4000-8000-000000000000';
  const paths = ['/api/config', '/api/models', '/api/health', '/api/runs', `/api/runs/${id}`, `/api/runs/${id}/export`, `/api/runs/${id}/events`, '/api/session', '/api/unknown'];
  for (const pathname of paths) for (const headers of [{}, { Authorization: 'Bearer ' + '0'.repeat(64) }, { Cookie: 'operator=' + app.token }]) {
    const response = await fetch(app.url + pathname, { headers });
    assert.equal(response.status, 401, pathname); assert.doesNotMatch(await response.text(), /gateway-fixture-secret|PRIVATE_AUTH_PLAN/);
  }
  for (const pathname of ['/api/runs', `/api/runs/${id}/cancel`, `/api/runs/${id}/resume`, '/api/session']) {
    const response = await fetch(app.url + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401, pathname);
  }
  assert.equal(app.gatewayCalls, 0); assert.equal(app.engine.runs.size, 0); assert.equal(app.hub.connections.size, 0);
  const query = await fetch(app.url + '/api/config?operatorToken=' + app.token); assert.equal(query.status, 401);
  const html = await (await fetch(app.url + '/')).text(); assert.equal(html.includes(app.token), false);
  const privateFile = await fetch(app.url + '/.runtime/operator-token'); assert.equal(privateFile.status, 404);
  const ready = await (await fetch(app.url + '/ready')).json(); assert.deepEqual(ready, { app: 'debate-ai-chamber', ownerAuthentication: true });
});

test('only an owner-authenticated bounded bootstrap returns secret-bearing app HTML', async t => {
  const app = await fixture(t);
  for (const pathname of ['owner', 'owner/operator-token', 'owner/operator-login.html']) assert.equal((await stat(path.join(app.directory, pathname))).mode & 0o077, 0);
  const invalid = await fetch(app.url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, body: 'operatorToken=' + '0'.repeat(64) });
  assert.equal(invalid.status, 401); assert.equal((await invalid.text()).includes(app.token), false);
  const valid = await fetch(app.url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, body: 'operatorToken=' + app.token });
  assert.equal(valid.status, 200); assert.equal(valid.headers.get('cache-control'), 'no-store'); assert.equal(valid.headers.get('set-cookie'), null);
  assert.ok((await valid.text()).includes(`name="operator-token" content="${app.token}"`));
  assert.equal((await app.post('/api/session', { operatorToken: app.token }, { Origin: app.url })).status, 200);
  assert.equal((await app.post('/api/session', { operatorToken: app.token }, { Origin: 'https://untrusted.invalid' })).status, 403);
  const rotated = await createOwnerAccess(path.join(app.directory, 'owner'), 'http://127.0.0.1:3417');
  assert.throws(() => rotated.require({ headers: { authorization: `Bearer ${app.token}` } }), { status: 401 });
});

test('owner auth retains Host, Origin and Fetch Metadata defenses', async t => {
  const app = await fixture(t);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(app.url + '/api/config', { headers: { Host: 'untrusted.invalid', Authorization: `Bearer ${app.token}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await app.post('/api/runs', {}, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await app.post('/api/runs', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await app.post('/api/runs', {}, { Origin: 'null' })).status, 403);
  assert.equal(app.gatewayCalls, 0);
  for (const pathname of ['/api/config', '/api/models', '/api/health', '/api/runs']) assert.equal((await app.request(pathname)).status, 200);
});

test('a second server on an occupied port preserves the running owner capability', async t => {
  const app = await fixture(t);
  const ownerDirectory = path.join(app.directory, 'owner');
  const before = await readFile(path.join(ownerDirectory, 'operator-login.html'), 'utf8');
  const secondData = path.join(app.directory, 'second-data'); await mkdir(secondData);
  const saveFile = path.join(secondData, '00000000-0000-4000-8000-000000000002.json');
  const activeSave = JSON.stringify({ id: '00000000-0000-4000-8000-000000000002', status: 'motion', speeches: [], settings: {}, log: [],
    progress: { completed: 0, total: 42 }, ballots: [], _private: { plans: {}, speechPhases: {}, identityNames: [] } });
  await writeFile(saveFile, activeSave);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env,
    PORT: String(new URL(app.url).port), OWNER_RUNTIME_DIR: ownerDirectory,
    DATA_DIR: secondData, API_KEY: 'fixture-only-key',
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { error += value; });
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 1); assert.match(error, /EADDRINUSE/);
  assert.equal((await readFile(path.join(ownerDirectory, 'operator-token'), 'utf8')).trim(), app.token);
  assert.equal(await readFile(path.join(ownerDirectory, 'operator-login.html'), 'utf8'), before);
  assert.equal(await readFile(saveFile, 'utf8'), activeSave);
  assert.equal((await app.request('/api/config')).status, 200);
});

test('an authenticated healthy viewer receives a large saved round through the real snapshot refresh route', async t => {
  const app = await fixture(t), id = '00000000-0000-4000-8000-000000000001', text = '辩'.repeat(50000);
  app.engine.runs.set(id, { id, status: 'failed', settings: structuredClone(DEFAULTS), teams: structuredClone(TEAMS), judges: structuredClone(JUDGES),
    speeches: SPEAKERS.map(speech => ({ ...speech, status: 'completed', opening: text, middle: text, closing: text, text: [text, text, text].join('\n\n') })),
    ballots: [], progress: { completed: 37, total: 42 }, _private: { identityNames: [] },
  });
  let connection, snapshots = 0;
  connection = connectLiveEvents(`${app.url}/api/runs/${id}/events`, { headers: { Authorization: `Bearer ${app.token}` },
    onEvent: (name, event) => {
      assert.equal(name, 'state'); const state = JSON.parse(event.data); snapshots++;
      assert.equal(state.id, id); assert.equal(state.speeches.length, 8); assert.equal(state.speeches[7].closing, text);
      assert.equal(state._private, undefined); connection.close();
    }, onError: () => assert.fail('A healthy saved round lost its snapshot.'), onUnauthorized: () => assert.fail(),
  });
  await connection.finished; assert.equal(snapshots, 1); assert.equal(app.gatewayCalls, 0);
});

test('authenticated owner can create, stream, cancel, resume, reconnect and export a full blind round', async t => {
  const app = await fixture(t, { maxPerRun: 1 });
  const created = await app.post('/api/runs', { pace: 'quick' }); assert.equal(created.status, 202);
  const { run } = await created.json(), controller = new AbortController();
  const events = await app.request(`/api/runs/${run.id}/events`, { signal: controller.signal }); assert.equal(events.status, 200);
  const reader = events.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /event: state/);
  assert.equal((await app.request(`/api/runs/${run.id}/events`)).status, 429);
  assert.equal((await app.post(`/api/runs/${run.id}/cancel`)).status, 200);
  await app.engine.whenIdle(run.id); assert.equal(app.engine.get(run.id).status, 'cancelled');
  controller.abort(); await reader.cancel().catch(() => {}); reader.releaseLock();
  app.release(); assert.equal((await app.post(`/api/runs/${run.id}/resume`)).status, 202); await app.engine.whenIdle(run.id);
  const completed = await (await app.request(`/api/runs/${run.id}`)).json();
  assert.equal(completed.status, 'completed'); assert.equal(completed.progress.completed, 42); assert.equal(completed.ballots.length, 5);
  for (const format of ['json', 'md']) {
    const exported = await app.request(`/api/runs/${run.id}/export?format=${format}`); assert.equal(exported.status, 200);
    const text = await exported.text(); assert.match(text, /gpt-6\.1-sol|gpt-6-astra/); assert.doesNotMatch(text, /PRIVATE_AUTH_PLAN|gateway-fixture-secret/);
  }
  const reconnect = await app.request(`/api/runs/${run.id}/events`); const latest = new TextDecoder().decode((await reconnect.body.getReader().read()).value);
  assert.match(latest, /"status":"completed"/); app.hub.close(); assert.equal(app.engine.listeners.size, 0); assert.equal(app.engine.deltaListeners.size, 0);
});
