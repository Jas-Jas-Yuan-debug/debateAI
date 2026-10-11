// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import { spawn, execFile } from 'node:child_process';
import { open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../lib/config.mjs';
import { ownerFetch, privateDirectory, privateWrite } from '../lib/owner-access.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await loadConfig(root), url = `http://127.0.0.1:${config.port}`;
await privateDirectory(config.ownerDirectory);
async function ready() {
  try { const response = await fetch(url + '/ready', { signal: AbortSignal.timeout(1000) }); return response.ok && (await response.json()).ownerAuthentication === true; }
  catch { return false; }
}
if (!await ready()) {
  const log = await open(path.join(config.ownerDirectory, 'server.log'), 'a', 0o600); await log.chmod(0o600);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd] }); child.unref(); await log.close();
  await privateWrite(path.join(config.ownerDirectory, 'server.pid'), String(child.pid));
  for (let attempt = 0; attempt < 30 && !await ready(); attempt++) await delay(200);
}
if (!await ready()) throw new Error('The server could not start. Check .runtime/server.log.');
const response = await ownerFetch(url + '/api/config', { signal: AbortSignal.timeout(2000) }, config.ownerDirectory);
if (!response.ok) throw new Error('The server does not match this account’s owner access file.');
await response.body.cancel();
const loginFile = path.join(config.ownerDirectory, 'operator-login.html'), info = await lstat(loginFile);
if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('The owner access file must be private to this account.');
execFile('open', [loginFile], error => { if (error) { console.error('Open the owner access file shown by the server.'); process.exitCode = 1; } });
