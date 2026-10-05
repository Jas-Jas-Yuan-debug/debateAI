// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
// Only decoded public string fields are previewed. Incomplete JSON never becomes a completed phase.
export function partialFields(raw, allowed) {
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
      if (names.has(key.text)) fields[key.text] = value.text;
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

export async function readChatStream(response, { signal, touch, onDelta }) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Model service returned no stream.');
  const decoder = new TextDecoder();
  let buffer = '', data = [], content = '', finishReason = null, usage = {}, done = false;
  async function event() {
    if (!data.length) return;
    const source = data.join('\n'); data = [];
    if (source.trim() === '[DONE]') { done = true; return; }
    let packet;
    try { packet = JSON.parse(source); } catch { throw new Error('Model stream returned an invalid event.'); }
    if (packet.error) throw new Error('Model stream reported an upstream error.');
    if (packet.usage) usage = packet.usage;
    const choice = packet.choices?.find(item => (item.index ?? 0) === 0);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) {
      content += delta;
      if (content.length > 1000000) throw new Error('Model stream exceeded the response size limit.');
      await onDelta({ delta, content });
    }
  }
  async function lines(final = false) {
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
      if (!line) await event();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      if (done) return;
    }
    if (final) {
      if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
      buffer = ''; await event();
    }
  }
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (!done) {
      if (signal.aborted) throw signal.reason;
      const next = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (next.done) { buffer += decoder.decode(); await lines(true); break; }
      touch(); buffer += decoder.decode(next.value, { stream: true });
      if (buffer.length > 1000000) throw new Error('Model stream event exceeded the response size limit.');
      await lines();
    }
    if (!done && !finishReason) {
      const error = new Error('Model stream ended before the response finished.'); error.transient = true; throw error;
    }
    return { choices: [{ finish_reason: finishReason || 'stop', message: { content } }], usage };
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
  }
}
