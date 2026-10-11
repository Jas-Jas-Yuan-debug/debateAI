// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
export const GATEWAY_LIMITS = Object.freeze({
  jsonBytes: 1024 * 1024,
  streamBytes: 16 * 1024 * 1024,
  eventBytes: 512 * 1024,
  eventLines: 2048,
  events: 200000,
  readChunks: 200000,
  contentBytes: 1024 * 1024,
  models: 512,
  modelIdCharacters: 256,
});
export class ResponseLimitError extends Error {
  constructor(resource) {
    super(`Model service exceeded the ${resource} limit. The unfinished step can be resumed.`);
    this.name = 'ResponseLimitError'; // A quota violation must never trigger automatic retries or repairs.
  }
}
export function responseLimits(overrides = {}) {
  const result = { ...GATEWAY_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(result, key) || !Number.isSafeInteger(value) || value < 1 || value > result[key]) throw new Error('Invalid response limit.');
    result[key] = value;
  }
  return result;
}

// Counts actual wire bytes, including unknown JSON fields, before aggregation or decoding.
export async function readBoundedJSON(response, { signal, maxBytes = GATEWAY_LIMITS.jsonBytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > GATEWAY_LIMITS.jsonBytes) throw new Error('Invalid JSON response limit.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Model service returned no response body.');
  const chunks = []; let bytes = 0, reads = 0;
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const declared = Number(response.headers?.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new ResponseLimitError('JSON response byte');
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const next = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes || ++reads > GATEWAY_LIMITS.readChunks) throw new ResponseLimitError('JSON response byte/chunk');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
