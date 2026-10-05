// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, REASONING_EFFORTS } from '../lib/debate.mjs';

test('speech targets use the language and pace defaults when no target is supplied', () => {
  for (const [language, pace, expected, unit] of [
    ['en', 'standard', 950, 'words'], ['en', 'quick', 470, 'words'],
    ['zh', 'standard', 1800, 'characters'], ['zh', 'quick', 950, 'characters'],
  ]) {
    const settings = normalizeSettings({ language, pace });
    assert.equal(settings.targetLength, expected);
    assert.equal(settings.lengthUnit, unit);
  }
});

test('English word and Chinese character targets accept both inclusive boundaries', () => {
  for (const [language, min, max] of [['en', 100, 3000], ['zh', 200, 6000]]) {
    for (const targetLength of [min, max]) {
      const settings = normalizeSettings({ language, targetLength });
      assert.equal(settings.targetLength, targetLength);
      assert.match(settings.scriptLength, new RegExp(String(targetLength)));
    }
    for (const targetLength of [min - 1, max + 1]) assert.throws(() => normalizeSettings({ language, targetLength }), /targetLength/);
  }
});

test('speech target must be a numeric integer, including for Chinese rounds', () => {
  for (const language of ['en', 'zh']) {
    for (const targetLength of ['400', 400.5, null, true, [], NaN, Infinity]) {
      assert.throws(() => normalizeSettings({ language, targetLength }), /targetLength/);
    }
  }
});

test('reasoning effort defaults to auto and accepts every advertised supported option', () => {
  const defaults = normalizeSettings();
  assert.deepEqual(defaults.teamEfforts, { OG: 'auto', OO: 'auto', CG: 'auto', CO: 'auto' });
  assert.deepEqual(defaults.judgeEfforts, { J1: 'auto', J2: 'auto', J3: 'auto', J4: 'auto', J5: 'auto' });
  assert.ok(REASONING_EFFORTS.includes('auto'));
  for (const effort of REASONING_EFFORTS) {
    const teamEfforts = { OG: effort, OO: effort, CG: effort, CO: effort };
    const judgeEfforts = { J1: effort, J2: effort, J3: effort, J4: effort, J5: effort };
    const settings = normalizeSettings({ teamEfforts, judgeEfforts });
    assert.deepEqual(settings.teamEfforts, teamEfforts);
    assert.deepEqual(settings.judgeEfforts, judgeEfforts);
  }
});

test('reasoning effort mappings require exactly the configured seats and valid effort values', () => {
  const teamEfforts = { OG: 'auto', OO: 'auto', CG: 'auto', CO: 'auto' };
  const judgeEfforts = { J1: 'auto', J2: 'auto', J3: 'auto', J4: 'auto', J5: 'auto' };
  for (const value of [
    { teamEfforts: { OG: 'high' } }, { judgeEfforts: { J1: 'high' } },
    { teamEfforts: { ...teamEfforts, OG: 'turbo' } }, { judgeEfforts: { ...judgeEfforts, J4: 'HIGH' } },
    { teamEfforts: { ...teamEfforts, other: 'auto' } }, { judgeEfforts: { ...judgeEfforts, J6: 'auto' } },
    { teamEfforts: null }, { judgeEfforts: [] },
  ]) assert.throws(() => normalizeSettings(value), /effort/i);
});
