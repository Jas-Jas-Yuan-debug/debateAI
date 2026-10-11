// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { SSEHub } from '../lib/sse-output.mjs';
import { publicRun, requireText } from '../lib/debate.mjs';

class Response extends EventEmitter {
  constructor(stalled = false) { super(); this.stalled = stalled; this.writableLength = 0; this.frames = []; }
  write(frame) { this.frames.push(frame); if (this.stalled) this.writableLength += Buffer.byteLength(frame); return !this.stalled; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('close'); }
  drain() { this.writableLength = 0; this.stalled = false; this.emit('drain'); }
}
const hub = options => new SSEHub({ maxPendingBytes: 512, maxFrameBytes: 400, drainMs: 100, heartbeatMs: 1000, ...options });

test('backpressure retains only latest state/draft and drains it in order', () => {
  const manager = hub(), req = new EventEmitter(), res = new Response(true), connection = manager.open(req, res, 'run');
  connection.send('initial', 'state');
  for (let i = 0; i < 1000; i++) connection.send('old-' + i, 'delta:opening:S1');
  connection.send('latest state', 'state'); connection.send('newer draft', 'delta:opening:S1');
  assert.equal(res.frames.length, 1); assert.ok(connection.pendingBytes + res.writableLength <= 512);
  res.drain(); assert.deepEqual(res.frames, ['initial', 'latest state', 'newer draft']);
  manager.close(); assert.equal(manager.connections.size, 0);
});

test('pending-byte overflow evicts only the slow viewer and removes all callbacks', () => {
  const manager = hub(), slowReq = new EventEmitter(), slowRes = new Response(true), fastRes = new Response();
  const slow = manager.open(slowReq, slowRes, 'run'), fast = manager.open(new EventEmitter(), fastRes, 'run');
  let cleaned = 0; slow.addCleanup(() => cleaned++); slow.addCleanup(() => cleaned++);
  slow.send('x'.repeat(300), 'state'); slow.send('x'.repeat(300), 'delta:S1');
  assert.equal(slow.closed, true); assert.equal(slowRes.destroyed, true); assert.equal(cleaned, 2);
  assert.equal(slow.pendingBytes, 0); assert.equal(slowReq.listenerCount('close'), 0); assert.equal(slowRes.listenerCount('drain'), 0);
  fast.send('healthy final state', 'state'); assert.deepEqual(fastRes.frames, ['healthy final state']); manager.close();
});

test('a finite drain deadline covers heartbeats without blocking another viewer', async () => {
  const manager = hub({ drainMs: 20, heartbeatMs: 5 }), slowRes = new Response(true), fastRes = new Response();
  const slow = manager.open(new EventEmitter(), slowRes, 'run'), fast = manager.open(new EventEmitter(), fastRes, 'run');
  let cleaned = false; slow.addCleanup(() => { cleaned = true; });
  slow.send('initial', 'state'); fast.send('latest', 'state'); await delay(35);
  assert.equal(slow.closed, true); assert.equal(cleaned, true); assert.equal(fast.closed, false);
  assert.ok(fastRes.frames.includes('latest')); assert.ok(slowRes.writableLength < 512); manager.close();
});

test('global/per-run admission quotas and every disconnect path release slots', () => {
  const manager = hub({ maxSubscribers: 2, maxPerRun: 1 });
  const req = new EventEmitter(), res = new Response(), first = manager.open(req, res, 'one');
  assert.throws(() => manager.open(new EventEmitter(), new Response(), 'one'), { status: 429 });
  const second = manager.open(new EventEmitter(), new Response(), 'two');
  assert.throws(() => manager.open(new EventEmitter(), new Response(), 'three'), { status: 429 });
  req.emit('close'); first.close(); assert.equal(manager.connections.size, 1);
  const thirdRes = new Response(), third = manager.open(new EventEmitter(), thirdRes, 'three'); thirdRes.emit('error', new Error('closed'));
  assert.equal(third.closed, true); second.res.emit('close'); assert.equal(manager.connections.size, 0);
});

test('oversized initial snapshots and shutdown clean up even late subscription registrations', () => {
  const manager = hub(), res = new Response(), connection = manager.open(new EventEmitter(), res, 'one');
  connection.send('x'.repeat(401), 'state'); let removed = false; connection.addCleanup(() => { removed = true; });
  assert.equal(removed, true); assert.equal(manager.connections.size, 0);
  const other = manager.open(new EventEmitter(), new Response(), 'two'); manager.close(); assert.equal(other.closed, true);
});

for (const character of ['辩', '\u0000']) test(`maximum accepted ${character === '辩' ? 'CJK' : 'escaped control'} speeches use bounded refresh notices for healthy viewers`, () => {
  const text = requireText(character.repeat(50000), 'speech');
  const speeches = Array.from({ length: 8 }, (_, index) => ({ id: `S${index + 1}`, teamId: 'OG', status: 'completed', opening: text, middle: text, closing: text, text: [text, text, text].join('\n\n') }));
  const state = publicRun({ id: 'large-round', status: 'failed', settings: {}, teams: [], judges: [], speeches, ballots: [], _private: { identityNames: [] } });
  assert.ok(Buffer.byteLength(JSON.stringify(state)) > 4 * 1024 * 1024);
  const manager = new SSEHub(), res = new Response(), connection = manager.open(new EventEmitter(), res, state.id);
  const frame = manager.frame('state', state); assert.match(frame, /^event: state-refresh\n/); assert.ok(Buffer.byteLength(frame) < 256);
  connection.send(frame, 'state'); assert.equal(connection.closed, false); assert.equal(res.frames[0], frame);
  assert.equal(state.speeches[0].opening, text); assert.equal(manager.frame('state', state), frame); manager.close();
});
