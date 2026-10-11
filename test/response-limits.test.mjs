// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelClient } from '../lib/provider.mjs';
import { DebateEngine } from '../lib/engine.mjs';
import { readChatStream, partialFields, MAX_PREVIEW_UPDATES, PREVIEW_INTERVAL_MS } from '../lib/streaming.mjs';
import { readBoundedJSON } from '../lib/response-limits.mjs';
import { readResponseDiagnostics } from '../lib/diagnostics.mjs';

const encode = value => new TextEncoder().encode(value);
const frame = content => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
const ending = 'data: [DONE]\n\n';
function tracked(parts, headers = { 'Content-Type': 'text/event-stream' }) {
  let consumed = 0, cancelled = false;
  return {
    get consumed() { return consumed; }, get cancelled() { return cancelled; },
    response: new Response(new ReadableStream({
      pull(controller) { if (consumed === parts.length) controller.close(); else { const value = parts[consumed++]; controller.enqueue(typeof value === 'string' ? encode(value) : value); } },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers }),
  };
}

for (const declared of [undefined, '1']) test(`ordinary JSON byte quota stops unknown fields (${declared || 'no length header'})`, async () => {
  const response = tracked(Array.from({ length: 30 }, () => '你'.repeat(32)), { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': declared } : {}) });
  await assert.rejects(readBoundedJSON(response.response, { maxBytes: 512 }), { name: 'ResponseLimitError' });
  assert.ok(response.consumed < 30); assert.equal(response.cancelled, true);
});

test('a declared oversized JSON response is cancelled without reading its body', async () => {
  const response = tracked(['{}'], { 'Content-Length': '2000' });
  await assert.rejects(readBoundedJSON(response.response, { maxBytes: 128 }), { name: 'ResponseLimitError' });
  assert.equal(response.consumed, 0); assert.equal(response.cancelled, true);
});

test('bounded ordinary JSON accepts UTF-8 split between bytes', async () => {
  const bytes = encode('{"text":"你好😀"}');
  const response = tracked([...bytes].map(value => Uint8Array.of(value)), { 'Content-Type': 'application/json' });
  assert.deepEqual(await readBoundedJSON(response.response, { maxBytes: 128 }), { text: '你好😀' });
});

test('completion fallback and structured repair share non-retrying response quotas', async () => {
  let calls = 0; const states = [];
  const client = new ModelClient({ baseUrl: 'http://mock/v1', apiKey: 'fixture', responseLimits: { jsonBytes: 128 },
    fetchImpl: async () => { calls++; return Response.json({ choices: [{ message: { content: '{}' } }], unused: 'x'.repeat(1000) }); },
    onRequestState: state => states.push(state),
  });
  await assert.rejects(client.json('fixture', [], value => value), { name: 'ResponseLimitError' });
  assert.equal(calls, 1); assert.equal(states.at(-1).status, 'failed');
  let repairCalls = 0;
  const repair = new ModelClient({ baseUrl: 'http://mock/v1', apiKey: 'fixture', responseLimits: { jsonBytes: 128 }, fetchImpl: async () => ++repairCalls === 1 ? Response.json({ choices: [{ message: { content: 'invalid JSON' } }] }) : Response.json({ ignored: 'x'.repeat(1000) }) });
  await assert.rejects(repair.json('fixture', [], value => value), { name: 'ResponseLimitError' });
  assert.equal(repairCalls, 2, 'The oversized repair is not replayed.');
});

for (const atEOF of [false, true]) test(`pending multiline SSE data is bounded before ${atEOF ? 'EOF' : 'a terminator'}`, async () => {
  const response = tracked([...Array.from({ length: 30 }, () => 'data: "' + 'a'.repeat(50) + '\n'), atEOF ? 'data: last' : '\n']);
  await assert.rejects(readChatStream(response.response, { limits: { eventBytes: 256 } }), { name: 'ResponseLimitError' });
  assert.ok(response.consumed < 30); assert.equal(response.cancelled, true);
});

test('EOF separators count toward the event byte quota', async () => {
  const response = tracked(['data: {}']);
  await assert.rejects(readChatStream(response.response, { limits: { eventBytes: 8 } }), { name: 'ResponseLimitError' });
  assert.equal(response.response.body.locked, false, 'EOF already closed the body; its reader must still be released.');
});

test('bounded multiline events and split UTF-8 still produce the exact final answer', async () => {
  const wire = 'data: {\r\ndata: "choices":[{"delta":{"content":"你好😀"}}]}\r\n\r\n' + ending;
  const response = tracked([...encode(wire)].map(value => Uint8Array.of(value)));
  const result = await readChatStream(response.response, { limits: { eventBytes: 256, eventLines: 5 } });
  assert.equal(result.choices[0].message.content, '你好😀');
});

for (const [limits, parts] of [
  [{ eventLines: 3 }, Array(10).fill(': comment\n')],
  [{ streamBytes: 128 }, Array(30).fill(': heartbeat\n\n')],
  [{ events: 3 }, Array(10).fill(': heartbeat\n\n')],
  [{ readChunks: 3 }, Array(10).fill('x')],
]) test(`SSE limits cover non-content bytes, lines, events and reads: ${Object.keys(limits)[0]}`, async () => {
  const response = tracked(parts);
  await assert.rejects(readChatStream(response.response, { limits }), { name: 'ResponseLimitError' });
  assert.ok(response.consumed < parts.length); assert.equal(response.cancelled, true);
});

test('answer quota counts UTF-8 bytes rather than JavaScript characters', async () => {
  const response = tracked([frame('你'.repeat(100)), ending]);
  await assert.rejects(readChatStream(response.response, { limits: { contentBytes: 128 } }), { name: 'ResponseLimitError' });
  assert.equal(response.cancelled, true);
});

for (const ids of [Array.from({ length: 513 }, (_, i) => 'audio-' + i), ['audio-' + 'x'.repeat(260)]]) test(`invalid complete catalogs are rejected before retention (${ids.length} entries)`, async () => {
  const engine = new DebateEngine({ apiKey: 'fixture', fetchImpl: async () => Response.json({ data: ids.map(id => ({ id })) }) });
  const before = [...engine.allModelIds];
  assert.equal((await engine.availableModels()).ok, false);
  assert.deepEqual(engine.allModelIds, before); assert.deepEqual(engine.availableModelIds, before);
});

test('normal catalog discovery retains both selectable and excluded bounded IDs', async () => {
  const ids = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-image-1'];
  const engine = new DebateEngine({ apiKey: 'fixture', fetchImpl: async () => Response.json({ data: ids.map(id => ({ id })) }) });
  const result = await engine.availableModels();
  assert.equal(result.ok, true); assert.deepEqual(result.excludedModels, ['gpt-image-1']); assert.deepEqual(engine.allModelIds, ids);
});

test('tiny gateway deltas cause cadence-bounded full preview work and preserve complete text', async () => {
  const answer = JSON.stringify({ text: 'a'.repeat(8000) });
  let calls = 0, scanned = 0; const started = Date.now();
  const response = tracked([...answer].map(frame).concat(ending));
  const result = await readChatStream(response.response, { onDelta: ({ content }) => { calls++; scanned += content.length; partialFields(content, ['text']); } });
  assert.equal(result.choices[0].message.content, answer);
  assert.ok(calls <= Math.ceil((Date.now() - started) / PREVIEW_INTERVAL_MS) + 2);
  assert.ok(calls < answer.length / 100); assert.ok(scanned < answer.length * 100);
});

test('slow tiny deltas also have a finite preview work budget', async () => {
  const original = Date.now; let clock = 0, count = 0, index = 0;
  const parts = Array(MAX_PREVIEW_UPDATES + 20).fill(frame('a')).concat(ending);
  const response = new Response(new ReadableStream({ pull(controller) { clock += 101; if (index === parts.length) controller.close(); else controller.enqueue(encode(parts[index++])); } }, { highWaterMark: 0 }));
  try {
    Date.now = () => clock;
    const result = await readChatStream(response, { onDelta: () => count++ });
    assert.equal(result.choices[0].message.content.length, MAX_PREVIEW_UPDATES + 20);
    assert.ok(count <= MAX_PREVIEW_UPDATES + 1);
  } finally { Date.now = original; }
});

test('bounded draft fields do not truncate the complete validated response', async () => {
  const answer = JSON.stringify({ text: 'a'.repeat(90000) }), previews = [];
  const response = tracked([frame(answer), ending]);
  const result = await readChatStream(response.response, { onDelta: ({ content }) => previews.push(partialFields(content, ['text'])) });
  assert.equal(JSON.parse(result.choices[0].message.content).text.length, 90000);
  assert.ok(previews.every(value => value.text.length <= 30000));
  assert.deepEqual(partialFields('{"plan":"private","text":"abcdef"}', ['text'], { text: 3 }), { text: 'abc' });
});

test('a deferred preview failure cancels a held reader rather than waiting or replaying', async () => {
  let notifications = 0, cancelled = false, calls = 0;
  const client = new ModelClient({ baseUrl: 'http://mock/v1', apiKey: 'fixture', timeoutMs: 1000, maxAttempts: 1,
    fetchImpl: async () => { calls++; return new Response(new ReadableStream({
      start(controller) { controller.enqueue(encode(frame('first'))); setTimeout(() => controller.enqueue(encode(frame('second'))), 10); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } }); },
    onDelta: () => { if (++notifications === 2) throw new Error('Preview unavailable.'); },
  });
  await Promise.all([assert.rejects(client.complete('fixture', []), /Preview unavailable/), delay(150)]);
  assert.equal(cancelled, true); assert.equal(calls, 1);
});

test('Responses diagnostics bound unterminated lines, distinct types and retained delta metadata', async () => {
  const long = tracked(Array(20).fill('data: ' + 'x'.repeat(40)));
  await assert.rejects(readResponseDiagnostics(long.response, { limits: { eventBytes: 128 } }), { name: 'ResponseLimitError' }); assert.equal(long.cancelled, true);
  for (const mode of ['types', 'records']) {
    const response = tracked(Array.from({ length: 10 }, (_, i) => 'data: ' + JSON.stringify(mode === 'types' ? { type: 'custom-' + i } : { type: 'response.output_text.delta', delta: 'a' }) + '\n\n'));
    await assert.rejects(readResponseDiagnostics(response.response, { maxTypes: 3, maxRecords: 3 }), { name: 'ResponseLimitError' });
    assert.ok(response.consumed < 10); assert.equal(response.cancelled, true);
  }
  const normal = tracked(['data: {"type":"response.output_text.delta","delta":"你好"}\n\n', 'data: {"type":"response.completed"}\n\n']);
  const result = await readResponseDiagnostics(normal.response);
  assert.equal(result.characters, 2); assert.equal(result.chunks.length, 1); assert.equal(result.events['response.completed'], 1);
});
