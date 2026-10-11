// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';

test('external owner-only gateway keys and process environment preserve startup precedence', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chamber-config-')), root = path.join(directory, 'source'), key = path.join(directory, 'gateway-key');
  await mkdir(root); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(key, 'protected-fixture-key\n', { mode: 0o600 });
  await writeFile(path.join(root, '.env'), `API_KEY_FILE=${key}\nPORT=4000\n`);
  const config = await loadConfig(root, {}); assert.equal(config.apiKey, 'protected-fixture-key'); assert.equal(config.port, 4000);
  assert.equal((await loadConfig(root, { API_KEY: 'environment-key' })).apiKey, 'environment-key');
  await chmod(key, 0o644); await assert.rejects(loadConfig(root, {}), /owner-only/);
  await chmod(key, 0o600); const link = path.join(directory, 'link'); await symlink(key, link);
  await assert.rejects(loadConfig(root, { API_KEY_FILE: link }), /owner-only/);
  await writeFile(path.join(root, 'key'), 'fixture', { mode: 0o600 }); await assert.rejects(loadConfig(root, { API_KEY_FILE: 'key' }), /outside/);
});

test('repository-local gateway key literals require migration rather than a silent override', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chamber-config-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, '.env'), 'API_KEY=legacy-fixture-secret\n');
  await assert.rejects(loadConfig(directory, { API_KEY: 'environment-key' }), error => !error.message.includes('legacy-fixture-secret') && /Move API_KEY out of .env/.test(error.message));
  await writeFile(path.join(directory, '.env'), 'BASE_URL=http://127.0.0.1:8317/v1\n');
  assert.equal((await loadConfig(directory, { API_KEY: 'environment-key' })).apiKey, 'environment-key');
});
