// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { gatewayFetch } from '../lib/http-transport.mjs';
import { readResponseDiagnostics } from '../lib/diagnostics.mjs';

export async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = await loadConfig(root), started = Date.now(), signal = AbortSignal.timeout(60000);
  const response = await gatewayFetch(config.baseUrl + '/responses', { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'Count from 1 to 100, separated by spaces. Output only the numbers.' }], reasoning: { effort: 'low' }, stream: true, max_output_tokens: 512 }), signal });
  if (!response.ok) { await response.body?.cancel(); throw new Error('HTTP ' + response.status); }
  const headersMs = Date.now() - started;
  const result = await readResponseDiagnostics(response, { signal });
  console.log(JSON.stringify({ ...result, headersMs, totalMs: Date.now() - started }));
}
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
