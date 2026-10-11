// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { ModelClient } from '../lib/provider.mjs';

export async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = await loadConfig(root), started = Date.now();
  let chunks = 0, firstDeltaMs = null, lastDeltaMs = null, streaming = false;
  const client = new ModelClient({ ...config, timeoutMs: 60000, maxAttempts: 1,
    onRequestState: request => { streaming ||= Boolean(request.streaming); },
    onDelta: () => { chunks++; lastDeltaMs = Date.now() - started; firstDeltaMs ??= lastDeltaMs; },
  });
  const answer = await client.complete('gpt-6.1-sol', [{ role: 'user', content: 'Count from 1 to 80, separated by spaces. Output only the numbers.' }], { maxTokens: 512, reasoningEffort: 'low' });
  console.log(JSON.stringify({ streaming, chunks, firstDeltaMs, lastDeltaMs, totalMs: Date.now() - started, characters: answer.length }));
}
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
