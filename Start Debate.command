#!/bin/zsh
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
set -e
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  print "Install Node.js 22 or later, then run this launcher again."
  read -r "?Press Return to close."
  exit 1
fi
mkdir -p .runtime
if ! curl --fail --silent --max-time 2 http://localhost:3417/api/config >/dev/null; then
  node --input-type=module - <<'JS'
import {spawn} from 'node:child_process';
import {openSync, closeSync, writeFileSync} from 'node:fs';
const log = openSync('.runtime/server.log', 'a');
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(), detached: true, stdio: ['ignore', log, log]
});
child.unref();
closeSync(log);
writeFileSync('.runtime/server.pid', String(child.pid));
JS
  for attempt in {1..30}; do
    if curl --fail --silent --max-time 2 http://localhost:3417/api/config >/dev/null; then
      break
    fi
    sleep 0.3
  done
fi
if curl --fail --silent --max-time 2 http://localhost:3417/api/config >/dev/null; then
  open http://localhost:3417
else
  print "The server could not start. Check .runtime/server.log."
  read -r "?Press Return to close."
  exit 1
fi
