// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

export function parseEnvironment(source) {
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}
export async function loadConfig(root, environment = process.env) {
  let fileEnv = {};
  try { fileEnv = parseEnvironment(await readFile(path.join(root, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const setting = (key, fallback) => environment[key] ?? fileEnv[key] ?? fallback;
  const port = Number(setting('PORT', '3417'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const timeoutMs = Number(setting('REQUEST_TIMEOUT_MS', '300000'));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) throw new Error('REQUEST_TIMEOUT_MS must be an integer from 1000 to 1800000.');
  const firstTextTimeoutMs = Number(setting('FIRST_TEXT_TIMEOUT_MS', '1800000'));
  const maxDurationMs = Number(setting('REQUEST_MAX_DURATION_MS', '2700000'));
  if (!Number.isInteger(firstTextTimeoutMs) || firstTextTimeoutMs < 1000 || firstTextTimeoutMs > 3600000) throw new Error('FIRST_TEXT_TIMEOUT_MS must be an integer from 1000 to 3600000.');
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < firstTextTimeoutMs || maxDurationMs > 7200000) throw new Error('REQUEST_MAX_DURATION_MS must allow the first text deadline and be at most 7200000.');
  let apiKey = environment.API_KEY;
  if (apiKey === undefined && setting('API_KEY_FILE', '')) {
    const filename = path.resolve(root, setting('API_KEY_FILE', ''));
    const relative = path.relative(root, filename);
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('API_KEY_FILE must be outside the source directory.');
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('API_KEY_FILE must be an owner-only file (mode 0600).');
    if (info.size > 4096) throw new Error('API_KEY_FILE is too large.');
    apiKey = (await readFile(filename, 'utf8')).trim();
  }
  if (fileEnv.API_KEY) throw new Error('Move API_KEY out of .env: use the server environment or an owner-only external API_KEY_FILE.');
  return { port, baseUrl: setting('BASE_URL', 'http://127.0.0.1:8317/v1'), apiKey: apiKey || '', dataDir: path.resolve(root, setting('DATA_DIR', 'data')), ownerDirectory: path.resolve(root, setting('OWNER_RUNTIME_DIR', '.runtime')), timeoutMs, firstTextTimeoutMs, maxDurationMs };
}
