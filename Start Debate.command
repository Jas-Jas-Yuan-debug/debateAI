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
if ! node scripts/launch.mjs; then
  print "The chamber could not open. Check the message above."
  read -r "?Press Return to close."
  exit 1
fi
