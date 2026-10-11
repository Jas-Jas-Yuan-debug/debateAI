// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DebateEngine } from './lib/engine.mjs';
import { loadConfig } from './lib/config.mjs';
import { createOwnerAccess } from './lib/owner-access.mjs';
import { createAppServer } from './lib/server.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const config = await loadConfig(ROOT);
const owner = await createOwnerAccess(config.ownerDirectory, `http://127.0.0.1:${config.port}`, { publish: false });
const engine = new DebateEngine(config); let initialized = false;
const { server, hub } = createAppServer({ engine, owner, port: config.port, publicDirectory: path.join(ROOT, 'public'), isReady: () => initialized });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true; hub.close(); server.close();
  await engine.close(); server.closeAllConnections();
}
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
try {
  server.listen(config.port, '127.0.0.1');
  await once(server, 'listening');
  // Failed duplicate launches cannot run recovery against an active instance's saves.
  await engine.init();
  // Only a process that owns the listening port may publish its capability.
  await owner.publish();
  initialized = true;
  console.log(`Debate AI Chamber: http://127.0.0.1:${config.port}`);
  console.log(`Unlock this browser by opening: ${owner.loginFile}`);
} catch (error) {
  console.error(`Could not start the local debate server: ${error.code || error.message}`);
  await shutdown(); process.exitCode = 1;
}
