// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectLiveEvents } from '../public/live-events.js';

test('browser streaming sends owner auth in headers, decodes chunks and reconnects to latest state', async () => {
  let calls = 0, connection; const states = [];
  const wire = 'event: state\r\ndata: {"text":"你好"}\r\n\r\nevent: delta\ndata: {"text":"latest"}\n\n', bytes = new TextEncoder().encode(wire);
  const fetchImpl = async (url, options) => {
    assert.equal(url, '/api/runs/fixture/events'); assert.equal(options.headers.Authorization, 'Bearer owner-fixture'); assert.equal(options.credentials, 'omit');
    if (++calls > 1) return new Response('event: state\ndata: {"status":"completed"}\n\n');
    let index = 0; return new Response(new ReadableStream({ pull(controller) { if (index === bytes.length) controller.close(); else controller.enqueue(bytes.slice(index, ++index)); } }));
  };
  connection = connectLiveEvents('/api/runs/fixture/events', { headers: { Authorization: 'Bearer owner-fixture' }, fetchImpl, retryMs: 1,
    onEvent: (type, event) => { states.push([type, JSON.parse(event.data)]); if (states.length === 3) connection.close(); }, onError: () => {}, onUnauthorized: () => assert.fail('Valid owner lost auth.'),
  });
  await connection.finished;
  assert.deepEqual(states, [['state', { text: '你好' }], ['delta', { text: 'latest' }], ['state', { status: 'completed' }]]); assert.equal(calls, 2);
});

test('expired owner capability locks the browser and stops automatic reconnects', async () => {
  let calls = 0, locked = 0;
  const connection = connectLiveEvents('/api/runs/fixture/events', { headers: {}, fetchImpl: async () => { calls++; return new Response('{}', { status: 401 }); }, onEvent: () => assert.fail(), onError: () => assert.fail(), onUnauthorized: () => locked++ });
  await connection.finished; assert.equal(calls, 1); assert.equal(locked, 1);
});

test('large snapshots are fetched once per coalesced refresh while live deltas continue', async () => {
  const id = 'large-round', url = `/api/runs/${id}/events`, text = '辩'.repeat(2400000), snapshot = JSON.stringify({ id, text });
  let connection, release, activeSnapshots = 0, maxActive = 0, snapshots = 0, delivered = 0, deltaDelivered = false;
  const held = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (route, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fixture');
    if (route === url) return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
      controller.enqueue(new TextEncoder().encode(('event: state-refresh\ndata: {"runId":"large-round"}\n\n').repeat(100) + 'event: delta\ndata: {"text":"live"}\n\n'));
    } }));
    assert.equal(route, `/api/runs/${id}`); snapshots++; activeSnapshots++; maxActive = Math.max(maxActive, activeSnapshots);
    await held; activeSnapshots--; return new Response(snapshot);
  };
  connection = connectLiveEvents(url, { headers: { Authorization: 'Bearer fixture' }, fetchImpl,
    onEvent: (type, event) => {
      if (type === 'delta') { deltaDelivered = true; release(); }
      if (type === 'state') { assert.equal(JSON.parse(event.data).text, text); if (++delivered === 2) connection.close(); }
    }, onError: () => assert.fail('A healthy large snapshot failed.'), onUnauthorized: () => assert.fail(),
  });
  await connection.finished; assert.equal(deltaDelivered, true); assert.equal(maxActive, 1); assert.equal(snapshots, 2);
});
