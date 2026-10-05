// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelClient } from '../lib/provider.mjs';

const frame = content => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
const ending = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const answer = { choices: [{ finish_reason: 'stop', message: { content: '{"text":"Complete"}' } }] };

async function gateway(t, handler) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    calls.push({ path: request.url, authorization: request.headers.authorization, body: raw ? JSON.parse(raw) : null });
    try { await handler(request, response); }
    catch (error) { response.destroy(error); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test('buffered gateway headers can arrive after the idle allowance without replaying or changing effort', async t => {
  const upstream = await gateway(t, async (request, response) => {
    await delay(160);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(frame('{"text":"Complete"}') + ending);
  });
  const states = [];
  const client = new ModelClient({ ...upstream, apiKey: 'test-key', timeoutMs: 40, firstTextTimeoutMs: 600, maxDurationMs: 1200, retryDelayMs: 1, onRequestState: state => states.push(state) });
  assert.equal(await client.complete('chosen-model', [{ role: 'user', content: 'Keep my 3000-word target.' }], { reasoningEffort: 'max', maxTokens: 16000 }), '{"text":"Complete"}');
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].authorization, 'Bearer test-key');
  assert.equal(upstream.calls[0].body.model, 'chosen-model');
  assert.equal(upstream.calls[0].body.reasoning_effort, 'max');
  assert.equal(upstream.calls[0].body.max_completion_tokens, 16000);
  assert.equal(upstream.calls[0].body.messages[0].content, 'Keep my 3000-word target.');
  assert.equal(states[0].waitPhase, 'first-text');
  assert.ok(states.at(-1).firstTextAt);
  assert.equal(states.at(-1).status, 'completed');
});

test('headers and reasoning events do not start the shorter text inactivity clock', async t => {
  const upstream = await gateway(t, async (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
    response.write('data: {"choices":[{"index":0,"delta":{"reasoning_content":"Private reasoning"}}]}\n\n');
    await delay(160);
    response.end(frame('{"text":"Complete"}') + ending);
  });
  const states = [], deltas = [];
  const client = new ModelClient({ ...upstream, apiKey: 'test', timeoutMs: 40, firstTextTimeoutMs: 600, maxDurationMs: 1200,
    onRequestState: state => states.push(state), onDelta: packet => deltas.push(packet.content) });
  assert.equal(await client.complete('model', []), '{"text":"Complete"}');
  assert.equal(upstream.calls.length, 1);
  assert.ok(states.some(state => state.streaming && state.waitPhase === 'first-text' && !state.firstTextAt));
  assert.deepEqual(deltas, ['{"text":"Complete"}']);
});

test('buffered ordinary JSON bodies also use the first-text allowance', async t => {
  const upstream = await gateway(t, async (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders();
    await delay(160); response.end(JSON.stringify(answer));
  });
  const client = new ModelClient({ ...upstream, apiKey: 'test', timeoutMs: 40, firstTextTimeoutMs: 600, maxDurationMs: 1200 });
  assert.equal(await client.complete('model', []), '{"text":"Complete"}');
  assert.equal(upstream.calls.length, 1);
});

test('first-text deadline remains bounded despite heartbeats and never automatically replays', async t => {
  const upstream = await gateway(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
    const heartbeat = setInterval(() => response.write(': still thinking\n\n'), 20);
    response.once('close', () => clearInterval(heartbeat));
  });
  const states = [];
  const client = new ModelClient({ ...upstream, apiKey: 'test', timeoutMs: 40, firstTextTimeoutMs: 140, maxDurationMs: 1000, retryDelayMs: 1,
    onRequestState: state => states.push(state) });
  await assert.rejects(client.complete('model', []), error => error.name === 'TimeoutError' && error.timeoutKind === 'first-text');
  assert.equal(upstream.calls.length, 1);
  assert.equal(states.at(-1).attempt, 1);
  assert.equal(states.at(-1).status, 'failed');
  assert.equal(states.at(-1).timeoutKind, 'first-text');
  assert.match(states.at(-1).lastError, /no automatic replay/);
});

test('a genuinely stalled stream retains its draft and stops once after text begins', async t => {
  const upstream = await gateway(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(frame('{"text":"Saved unfinished reply'));
  });
  const states = [], deltas = [];
  const client = new ModelClient({ ...upstream, apiKey: 'test', timeoutMs: 70, firstTextTimeoutMs: 600, maxDurationMs: 1200, retryDelayMs: 1,
    onRequestState: state => states.push(state), onDelta: packet => deltas.push(packet.content) });
  await assert.rejects(client.complete('model', []), error => error.name === 'TimeoutError' && error.timeoutKind === 'stream-idle');
  assert.equal(upstream.calls.length, 1);
  assert.deepEqual(deltas, ['{"text":"Saved unfinished reply']);
  assert.equal(states.at(-1).receivedCharacters, deltas[0].length);
  assert.ok(states.at(-1).firstTextAt);
  assert.equal(states.at(-1).timeoutKind, 'stream-idle');
});

test('overall deadline bounds a continuously active stream without replaying it', async t => {
  const upstream = await gateway(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(frame('begin'));
    const tokens = setInterval(() => response.write(frame(' more')), 20);
    response.once('close', () => clearInterval(tokens));
  });
  const states = [];
  const client = new ModelClient({ ...upstream, apiKey: 'test', timeoutMs: 100, firstTextTimeoutMs: 600, maxDurationMs: 160, retryDelayMs: 1,
    onRequestState: state => states.push(state) });
  await assert.rejects(client.complete('model', []), error => error.name === 'TimeoutError' && error.timeoutKind === 'overall');
  assert.equal(upstream.calls.length, 1);
  assert.ok(states.at(-1).receivedCharacters > 5);
});

for (const afterHeaders of [false, true]) {
  test(`user cancellation interrupts ${afterHeaders ? 'a buffered response body' : 'the wait for response headers'} without retry`, async t => {
    const controller = new AbortController(); let connected;
    const ready = new Promise(resolve => { connected = resolve; });
    const upstream = await gateway(t, (request, response) => {
      if (afterHeaders) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); }
      connected();
    });
    const states = [];
    const client = new ModelClient({ ...upstream, apiKey: 'test', timeoutMs: 40, firstTextTimeoutMs: 600, maxDurationMs: 1200, retryDelayMs: 1,
      onRequestState: state => states.push(state) });
    const result = client.complete('model', [], { signal: controller.signal });
    const rejection = assert.rejects(result, { name: 'AbortError', message: 'Operator cancelled' });
    await ready; controller.abort(new DOMException('Operator cancelled', 'AbortError')); await rejection;
    assert.equal(upstream.calls.length, 1);
    assert.equal(states.at(-1).status, 'cancelled');
  });
}
