// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskIdentities, publicRun } from '../lib/debate.mjs';
import { ModelClient } from '../lib/provider.mjs';

const hostileNames = ['gpt-6.1-sol', 'gpt-6-astra', ...Array.from({ length: 150 }, (_, index) => {
  const word = ['participant', 'identity', 'sealed'][index % 3];
  return '-'.repeat(index + 1) + word + '-'.repeat(160 - index - word.length);
})];

test('bounded catalogs cannot remask words introduced by redaction placeholders', async () => {
  const client = new ModelClient({ baseUrl: 'http://fixture.invalid/v1', apiKey: 'fixture-key', fetchImpl: async () => Response.json({ data: hostileNames.map(id => ({ id })) }) });
  const names = await client.models();
  const text = 'participant identity sealed gpt-6.1-sol Judge 3';
  const masked = maskIdentities(text, names);
  assert.equal(masked, '[participant identity sealed] [participant identity sealed] [participant identity sealed] [participant identity sealed] [adjudicator identity sealed]');
  for (let index = 0; index < 20; index++) assert.equal(maskIdentities(masked, names), masked);
});

test('repeated public snapshots preserve sealed spans without growing saved topics or speeches', () => {
  const settings = { topicHint: maskIdentities('participant', hostileNames) };
  const run = { id: 'fixture', status: 'failed', settings, teams: [], judges: [], ballots: [],
    speeches: [{ id: 'S1', teamId: 'OG', opening: settings.topicHint, middle: 'Ordinary reasoning', closing: 'Conclusion', text: settings.topicHint }],
    _private: { identityNames: hostileNames }, log: [{ message: settings.topicHint }],
  };
  for (let index = 0; index < 10; index++) {
    const snapshot = publicRun(run);
    assert.equal(snapshot.settings.topicHint, settings.topicHint); assert.equal(snapshot.speeches[0].opening, settings.topicHint);
    assert.equal(snapshot.log[0].message, settings.topicHint); assert.equal(JSON.stringify(snapshot).length < 2000, true);
  }
});

test('single-pass masking still covers qualified IDs, flexible separators and mixed judge names', () => {
  assert.equal(maskIdentities('acme/custom-model custom_model GPT–6.1 Sol J2 裁判5', ['acme/custom-model']),
    '[participant identity sealed] [participant identity sealed] [participant identity sealed] [adjudicator identity sealed] [adjudicator identity sealed]');
});
