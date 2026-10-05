// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelClient } from '../lib/provider.mjs';
import { partialFields } from '../lib/streaming.mjs';
import { DebateEngine } from '../lib/engine.mjs';

const encode = value => new TextEncoder().encode(value);
const frame = content => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\r\n\r\n`;
const ending = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\ndata: [DONE]\n\n';
function stream(parts, pause = 0) {
  let index = 0, cancelled = false;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (pause) await delay(pause);
      if (cancelled) return;
      if (index === parts.length) { controller.close(); return; }
      controller.enqueue(typeof parts[index] === 'string' ? encode(parts[index++]) : parts[index++]);
    }, cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('partial JSON previews decode escapes and Unicode without leaking other or nested fields', () => {
  assert.deepEqual(partialFields('{"accepted":true,"response":"Hi\\n\\u4f60\\u597d\\ud83d', ['accepted', 'response']), { accepted: true, response: 'Hi\n你好' });
  assert.deepEqual(partialFields('{"ranking":["OG","OO"],"comparisons":[{"reasoning":"nested"}],"reasoning":"Live\\" quote', ['reasoning']), { reasoning: 'Live" quote' });
  assert.deepEqual(partialFields('{"plan":"PRIVATE","text":"Visible', ['text']), { text: 'Visible' });
  assert.deepEqual(partialFields('{"text":"Hello\\', ['text']), { text: 'Hello' });
  assert.deepEqual(partialFields('{"text":"\\ud83d\\ude00"}', ['text']), { text: '😀' });
});

test('provider forwards real deltas before completion, handles split UTF-8/events and stream usage', async () => {
  const raw = frame('{"text":"你') + frame('好\\nstreamed"}') + ending;
  const bytes = encode(raw), pieces = Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => bytes.slice(i * 7, i * 7 + 7));
  const received = [], usage = [];
  let finished = false;
  const client = new ModelClient({ baseUrl: 'http://mock/v1', apiKey: 'test', timeoutMs: 2000, maxAttempts: 1,
    fetchImpl: async (url, options) => { const body = JSON.parse(options.body); assert.equal(body.stream, true); assert.equal(body.stream_options.include_usage, true); return stream(pieces, 1); },
    onDelta: ({ content }) => { assert.equal(finished, false); received.push(content); }, onUsage: value => usage.push(value),
  });
  const result = await client.json('model', [], value => value, { requestContext: { stage: 'opening:S1' } }); finished = true;
  assert.deepEqual(result, { text: '你好\nstreamed' });
  assert.deepEqual(received, ['{"text":"你', '{"text":"你好\\nstreamed"}']);
  assert.equal(usage[0].total_tokens, 7);
});

test('a healthy stream may run longer than its inactivity timeout', async () => {
  const client = new ModelClient({ baseUrl: 'http://mock/v1', apiKey: 'test', timeoutMs: 70, maxAttempts: 1,
    fetchImpl: async () => stream([frame('{"text":"'), frame('a'), frame('b'), frame('c'), frame('"}'), ending], 25),
  });
  assert.deepEqual(await client.json('model', [], value => value), { text: 'abc' });
});

test('an interrupted stream retries a fresh response without appending its old partial text', async () => {
  let attempt = 0;
  const received = [], states = [];
  const client = new ModelClient({ baseUrl: 'http://mock/v1', apiKey: 'test', timeoutMs: 2000, retryDelayMs: 1,
    fetchImpl: async () => ++attempt === 1 ? stream([frame('{"text":"abandoned')]) : stream([frame('{"text":"replacement"}'), ending]),
    onDelta: packet => received.push({ attempt: packet.request.attempt, content: packet.content }), onRequestState: state => states.push(state),
  });
  assert.deepEqual(await client.json('model', [], value => value), { text: 'replacement' });
  assert.deepEqual(received.map(item => item.content), ['{"text":"abandoned', '{"text":"replacement"}']);
  assert.deepEqual(received.map(item => item.attempt), [1, 2]);
  assert.ok(states.some(state => state.status === 'retrying'));
});

test('a stalled stream times out, retaining the unfinished delta and failing the request', async () => {
  const received = [], states = [];
  const client = new ModelClient({ baseUrl: 'http://mock/v1', apiKey: 'test', timeoutMs: 35, maxAttempts: 1,
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encode(frame('{"text":"unfinished'))); } }), { headers: { 'Content-Type': 'text/event-stream' } }),
    onDelta: chunk => received.push(chunk.content), onRequestState: state => states.push(state),
  });
  // Keep the test clock alive while the provider's inactivity timer is unreferenced.
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(client.complete('model', []), { name: 'TimeoutError' }); }
  finally { clearInterval(keepAlive); }
  assert.deepEqual(received, ['{"text":"unfinished']);
  assert.equal(states.at(-1).status, 'failed');
});

test('busy gateway retries honour Retry-After and cancellation interrupts the cooldown', async () => {
  const controller = new AbortController(); let retry, calls = 0;
  const client = new ModelClient({ baseUrl: 'http://mock/v1', apiKey: 'test', retryDelayMs: 1,
    fetchImpl: async () => { calls++; return new Response('{}', { status: 503, headers: { 'Retry-After': '2' } }); },
    onRequestState: state => { if (state.status === 'retrying') { retry = state; controller.abort(new DOMException('Cancelled', 'AbortError')); } },
  });
  await assert.rejects(client.complete('model', [], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.ok(Date.parse(retry.nextAttemptAt) - Date.now() > 1800);
  assert.match(retry.lastError, /HTTP 503/);
});

test('engine publishes public draft tokens, preserves them on cancel/resume, and keeps private preparation blind', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'debate-streaming-'));
  let hold = true, release, openingCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const deltas = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: ['gpt-6.1-sol', 'gpt-6-astra'].map(id => ({ id })) });
    const body = JSON.parse(options.body);
    assert.equal(body.stream, true);
    assert.doesNotMatch(JSON.stringify(body.messages), /"(?:liveDrafts|requestId|revision|receivedCharacters|lastTokenAt)"/);
    const stage = body.messages.find(message => /^\[stage:/.test(message.content)).content.match(/^\[stage:([^\]]+)\]/)[1];
    if (stage === 'opening:S1' && hold) {
      openingCalls++;
      let sent = false, cancelled = false;
      return new Response(new ReadableStream({
        async pull(controller) {
          if (!sent) { sent = true; controller.enqueue(encode(frame('{"text":"Saved live opening'))); return; }
          await gate; if (cancelled) return;
          controller.enqueue(encode(frame(' completes."}') + ending)); controller.close();
        }, cancel() { cancelled = true; },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    const [kind, seat] = stage.split(':');
    if (kind === 'opening') openingCalls++;
    const values = {
      motion: { text: 'This House would make transport free.', infoSlide: '', rationale: 'Compare access and funding.' },
      preparation: { plan: 'PRIVATE_STREAM_PLAN' }, opening: { text: 'Saved live opening completes.' },
      poi: { text: 'How will you fund this?' }, middle: { accepted: true, response: 'Use existing budgets.', text: 'Compare access and funding costs.' },
      closing: { text: 'Access benefits prevail.' }, ballot: { ranking: ['OG', 'OO', 'CG', 'CO'], reasoning: 'S1 defeats S2; S5 and S6 add less.' },
    };
    return stream([frame(JSON.stringify(values[kind])), ending]);
  };
  let engine = await new DebateEngine({ baseUrl: 'http://mock/v1', apiKey: 'test', fetchImpl, dataDir: directory, timeoutMs: 2000 }).init();
  t.after(async () => { release(); await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const run = await engine.create({ pace: 'quick' });
  engine.subscribeDeltas(run.id, packet => deltas.push(packet));
  const deadline = Date.now() + 3000;
  while (!engine.get(run.id).liveDrafts?.['opening:S1'] && Date.now() < deadline) await delay(5);
  const partial = engine.get(run.id);
  assert.equal(partial.speeches[0].opening, '', 'Draft text is not a validated phase');
  assert.equal(partial.liveDrafts['opening:S1'].fields.text, 'Saved live opening');
  assert.ok(deltas.some(packet => packet.stage === 'opening:S1'));
  assert.ok(deltas.every(packet => !packet.stage.startsWith('preparation:')));
  assert.doesNotMatch(JSON.stringify(partial), /PRIVATE_STREAM_PLAN/);
  await engine.cancel(run.id); await engine.whenIdle(run.id);
  const saved = JSON.parse(await readFile(join(directory, `${run.id}.json`), 'utf8'));
  assert.equal(saved.liveDrafts['opening:S1'].fields.text, 'Saved live opening');
  assert.ok(Object.keys(saved._private.plans).length === 4);
  await engine.close();
  engine = await new DebateEngine({ baseUrl: 'http://mock/v1', apiKey: 'test', fetchImpl, dataDir: directory, timeoutMs: 2000 }).init();
  assert.equal(engine.get(run.id).liveDrafts['opening:S1'].fields.text, 'Saved live opening', 'Restart recovers the saved draft');
  assert.deepEqual(engine.get(run.id).settings, run.settings);
  hold = false; release();
  await engine.resume(run.id); await engine.whenIdle(run.id);
  const completed = engine.get(run.id);
  assert.equal(completed.id, run.id); assert.equal(completed.status, 'completed');
  assert.equal(completed.speeches[0].opening, 'Saved live opening completes.');
  assert.equal(Object.keys(completed.liveDrafts || {}).length, 0);
  assert.equal(openingCalls, 9, 'Only the interrupted opening is retried; completed preparation is retained');
});
