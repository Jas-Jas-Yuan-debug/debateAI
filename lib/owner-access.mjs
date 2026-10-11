// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function unauthorized() {
  const error = new Error('Unlock this browser with Start Debate.command or the owner access file.');
  error.status = 401; throw error;
}
export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('The owner access directory must belong to this account.');
  await chmod(directory, 0o700);
}
export async function privateWrite(filename, content) {
  const temporary = `${filename}.${randomBytes(12).toString('hex')}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await rename(temporary, filename);
}

export async function createOwnerAccess(directory, origin, { publish = true } = {}) {
  await privateDirectory(directory);
  const token = randomBytes(32).toString('hex');
  const loginFile = path.join(directory, 'operator-login.html');
  // The private file transports a capability in a POST body, never in a URL.
  // The authenticated response uses the app's ordinary self-hosted scripts.
  const html = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Unlock The Chamber</title><form method="post" action="${origin}/api/session"><input type="hidden" name="operatorToken" value="${token}"><button>Open The Chamber</button></form><script>document.forms[0].submit()</script>`;
  const access = {
    loginFile,
    async publish() {
      await privateWrite(path.join(directory, 'operator-token'), token + '\n');
      await privateWrite(loginFile, html);
    },
    require(req, bootstrapToken) {
      const candidate = bootstrapToken ?? req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
      if (typeof candidate !== 'string' || !/^[a-f0-9]{64}$/.test(candidate) || !timingSafeEqual(Buffer.from(candidate), Buffer.from(token))) unauthorized();
      return token;
    },
  };
  if (publish) await access.publish();
  return access;
}

export async function ownerFetch(url, options = {}, directory = path.resolve('.runtime')) {
  const filename = path.join(directory, 'operator-token');
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Owner access file must be private to this account.');
  const token = (await readFile(filename, 'utf8')).trim();
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...options, headers });
}
