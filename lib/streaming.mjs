// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import { GATEWAY_LIMITS, ResponseLimitError, responseLimits } from './response-limits.mjs';
export const PREVIEW_INTERVAL_MS = 100;
export const MAX_PREVIEW_UPDATES = 2048;
export const MAX_PREVIEW_CHARACTERS = 65536;
// Only decoded public string fields are previewed. Incomplete JSON never becomes a completed phase.
export function partialFields(raw, allowed, fieldLimits = {}) {
  raw = raw.slice(0, MAX_PREVIEW_CHARACTERS);
  const fields = {}, names = new Set(allowed);
  function stringAt(start) {
    let text = '', i = start + 1;
    const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    while (i < raw.length) {
      const char = raw[i++];
      if (char === '"') return { text, next: i, complete: true };
      if (char !== '\\') { text += char; continue; }
      if (i >= raw.length) break;
      const escape = raw[i++];
      if (escape === 'u') {
        const hex = raw.slice(i, i + 4);
        if (!/^[0-9a-f]{4}$/i.test(hex)) break;
        const code = parseInt(hex, 16); i += 4;
        if (code >= 0xd800 && code <= 0xdbff) {
          const pair = raw.slice(i, i + 6);
          if (!/^\\u[0-9a-f]{4}$/i.test(pair)) break;
          const low = parseInt(pair.slice(2), 16);
          if (low < 0xdc00 || low > 0xdfff) break;
          text += String.fromCharCode(code, low); i += 6;
        } else text += String.fromCharCode(code);
      } else if (Object.hasOwn(escapes, escape)) text += escapes[escape];
      else break;
    }
    return { text, next: i, complete: false };
  }
  let i = raw.indexOf('{') + 1;
  if (!i) return fields;
  while (i < raw.length) {
    while (/[\s,]/.test(raw[i] || '') && i < raw.length) i++;
    if (raw[i] !== '"') break;
    const key = stringAt(i); if (!key.complete) break;
    i = key.next; while (/\s/.test(raw[i] || '') && i < raw.length) i++;
    if (raw[i++] !== ':') break;
    while (/\s/.test(raw[i] || '') && i < raw.length) i++;
    if (raw[i] === '"') {
      const value = stringAt(i);
      if (names.has(key.text)) fields[key.text] = value.text.slice(0, fieldLimits[key.text] || 30000);
      i = value.next; if (!value.complete) break;
    } else if (raw[i] === '[' || raw[i] === '{') {
      let depth = 0;
      do {
        if (raw[i] === '"') { const value = stringAt(i); i = value.next; if (!value.complete) return fields; continue; }
        if ('[{'.includes(raw[i])) depth++;
        if (']}'.includes(raw[i])) depth--;
        i++;
      } while (i < raw.length && depth > 0);
      if (depth) break;
    } else {
      const start = i; while (i < raw.length && !/[\s,}]/.test(raw[i])) i++;
      const value = raw.slice(start, i);
      if (names.has(key.text) && ['true', 'false'].includes(value)) fields[key.text] = value === 'true';
    }
  }
  return fields;
}

// A byte-oriented line assembler avoids rescanning an ever-growing unterminated line.
// The same budgets cover exported parser calls and both diagnostic protocols.
export async function readSSE(response, { signal, touch = () => {}, onEvent, limits: overrides } = {}) {
  const limits = responseLimits(overrides);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Model service returned no stream.');
  const decoder = new TextDecoder();
  let lineParts = [], lineBytes = 0, data = [], eventBytes = 0, eventLines = 0, events = 0, bytes = 0, reads = 0;
  async function event() {
    if (eventLines && ++events > limits.events) throw new ResponseLimitError('stream event count');
    const source = data.length ? data.join('\n') : null;
    data = []; eventBytes = 0; eventLines = 0;
    return source === null ? true : (await onEvent(source)) !== false;
  }
  async function line() {
    if (++eventLines > limits.eventLines) throw new ResponseLimitError('stream event line count');
    const value = decoder.decode(Buffer.concat(lineParts, lineBytes)).replace(/\r$/, '');
    lineParts = []; lineBytes = 0;
    if (!value) return event();
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    return true;
  }
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const declared = Number(response.headers?.get('content-length'));
    if (Number.isFinite(declared) && declared > limits.streamBytes) throw new ResponseLimitError('stream response byte');
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const next = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (next.done) {
        if (lineBytes) {
          // Account for the EOF separator before decoding/joining pending event data.
          if (++eventBytes > limits.eventBytes) throw new ResponseLimitError('stream event byte');
          if (!await line()) return;
        }
        await event(); return;
      }
      bytes += next.value.byteLength;
      if (bytes > limits.streamBytes || ++reads > limits.readChunks) throw new ResponseLimitError('stream response byte/chunk');
      touch();
      let start = 0;
      while (start < next.value.byteLength) {
        const end = next.value.indexOf(10, start), stop = end === -1 ? next.value.byteLength : end;
        const length = stop - start;
        eventBytes += length + (end === -1 ? 0 : 1);
        if (eventBytes > limits.eventBytes) throw new ResponseLimitError('stream event byte');
        if (length) { lineParts.push(next.value.subarray(start, stop)); lineBytes += length; }
        if (end === -1) break;
        if (!await line()) return;
        start = end + 1;
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readChatStream(response, { signal, touch, onText = () => {}, onDelta = () => {}, limits: overrides } = {}) {
  const limits = responseLimits(overrides);
  const previewController = new AbortController();
  const streamSignal = AbortSignal.any([previewController.signal, ...(signal ? [signal] : [])]);
  let content = '', pending = [], characters = 0, contentBytes = 0, finishReason = null, usage = {}, done = false;
  let timer, nextPreviewAt = 0, previews = 0, publishError, publication = Promise.resolve();
  function publish(final = false) {
    clearTimeout(timer); timer = null;
    publication = publication.then(async () => {
      if (!pending.length || streamSignal.aborted) return;
      if (!final && previews >= MAX_PREVIEW_UPDATES) return;
      const delta = pending.join(''); pending = []; content += delta;
      nextPreviewAt = Date.now() + PREVIEW_INTERVAL_MS; previews++;
      await onDelta({ delta, content: content.slice(0, MAX_PREVIEW_CHARACTERS), receivedCharacters: characters });
    });
    return publication;
  }
  function schedule() {
    if (timer || previews >= MAX_PREVIEW_UPDATES) return;
    timer = setTimeout(() => { publish().catch(error => { publishError = error; previewController.abort(error); }); }, Math.max(0, nextPreviewAt - Date.now()));
    timer.unref?.();
  }
  try {
    await readSSE(response, { signal: streamSignal, touch, limits, onEvent: async source => {
      if (publishError) throw publishError;
      if (source.trim() === '[DONE]') { done = true; return false; }
      let packet;
      try { packet = JSON.parse(source); } catch { throw new Error('Model stream returned an invalid event.'); }
      if (!packet || typeof packet !== 'object' || Array.isArray(packet) || (packet.choices !== undefined && !Array.isArray(packet.choices))) throw new Error('Model stream returned an invalid event.');
      if (packet.error) throw new Error('Model stream reported an upstream error.');
      if (packet.usage) usage = packet.usage;
      const choice = packet.choices?.find(item => (item.index ?? 0) === 0);
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (typeof delta !== 'string' || !delta) return;
      contentBytes += Buffer.byteLength(delta); characters += delta.length;
      if (contentBytes > limits.contentBytes) throw new ResponseLimitError('answer byte');
      pending.push(delta);
      await onText({ receivedCharacters: characters });
      if (!previews || (Date.now() >= nextPreviewAt && previews < MAX_PREVIEW_UPDATES)) await publish();
      else schedule();
    } });
    if (!done && !finishReason) { const error = new Error('Model stream ended before the response finished.'); error.transient = true; throw error; }
    await publish(true);
    return { choices: [{ finish_reason: finishReason || 'stop', message: { content } }], usage };
  } finally {
    clearTimeout(timer);
    // Keep the last bounded draft for a failed response; cancellation never publishes late work.
    if (!streamSignal.aborted) await publish(true);
    else await publication.catch(() => {});
  }
}
