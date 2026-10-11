// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import { readSSE } from './streaming.mjs';
import { ResponseLimitError } from './response-limits.mjs';

export async function readResponseDiagnostics(response, { signal, limits, maxTypes = 64, maxRecords = 512 } = {}) {
  const started = Date.now(), chunks = [], events = new Map();
  let characters = 0, firstDeltaMs = null;
  await readSSE(response, { signal, limits, onEvent: source => {
    if (source.trim() === '[DONE]') return false;
    const packet = JSON.parse(source), type = packet.type || 'unknown';
    if (typeof type !== 'string' || type.length > 128) throw new ResponseLimitError('diagnostic event type');
    if (!events.has(type) && events.size >= maxTypes) throw new ResponseLimitError('diagnostic event type count');
    events.set(type, (events.get(type) || 0) + 1);
    if (type === 'response.output_text.delta') {
      if (typeof packet.delta !== 'string') throw new Error('Invalid diagnostic text delta.');
      if (chunks.length >= maxRecords) throw new ResponseLimitError('diagnostic delta record count');
      const elapsed = Date.now() - started; firstDeltaMs ??= elapsed; characters += packet.delta.length;
      chunks.push({ elapsed, characters: packet.delta.length });
    }
  } });
  return { firstDeltaMs, characters, chunks, events: Object.fromEntries(events) };
}
