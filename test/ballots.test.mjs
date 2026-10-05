// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS, SPEAKERS, JUDGES, validateBallot, tallyBallots, publicRun } from '../lib/debate.mjs';

const ballot = (judgeId, ranking) => ({
  ...validateBallot({
    ranking,
    reasoning: `S1 and S2 establish the opening clash; S5 and S6 provide comparative extensions. ${ranking[0]} wins that comparison.`,
  }, judgeId),
  model: JUDGES.find(j => j.id === judgeId).model,
});

const panel = (rankings) => rankings.map((ranking, index) => ballot(`J${index + 1}`, ranking));

test('BP chamber contains four teams, eight ordered roles, and five judges', () => {
  assert.equal(TEAMS.length, 4);
  assert.equal(SPEAKERS.length, 8);
  assert.deepEqual(SPEAKERS.map(s => s.role), ['PM', 'LO', 'DPM', 'DLO', 'MG', 'MO', 'GW', 'OW']);
  for (const team of TEAMS) assert.equal(SPEAKERS.filter(s => s.teamId === team.id).length, 2);
  assert.equal(JUDGES.length, 5);
});

test('ballots require a complete distinct four-team ranking and grounded reasons', () => {
  const valid = { ranking: ['OG', 'OO', 'CG', 'CO'], reasoning: 'OG wins the S1 versus S2 comparison.' };
  assert.equal(validateBallot(valid, 'J1').winner, 'OG');
  for (const ranking of [[], ['OG', 'OO', 'CG'], ['OG', 'OO', 'CG', 'OG'], ['OG', 'OO', 'CG', 'XX']]) {
    assert.throws(() => validateBallot({ ...valid, ranking }), /ranking/);
  }
  assert.throws(() => validateBallot({ ...valid, winner: 'CO' }), /winner/);
  assert.throws(() => validateBallot({ ...valid, reasoning: '' }), /reasoning/);
  assert.throws(() => validateBallot({ ...valid, reasoning: 'This team was more persuasive.' }), /speech IDs/);
});

test('winner requires exactly five distinct valid completed judge ballots', () => {
  const ballots = panel(Array.from({ length: 5 }, () => ['OG', 'OO', 'CG', 'CO']));
  assert.throws(() => tallyBallots(ballots.slice(0, 4), 'J4'), /five/);
  assert.throws(() => tallyBallots([...ballots, ballots[0]], 'J4'), /five/);
  assert.throws(() => tallyBallots([...ballots.slice(0, 4), { ...ballots[4], judgeId: 'J1' }], 'J4'), /distinct/);
  assert.throws(() => tallyBallots([...ballots.slice(0, 4), { ...ballots[4], status: 'failed' }], 'J4'), /completed/);
  assert.throws(() => tallyBallots([...ballots.slice(0, 4), { ...ballots[4], ranking: ['OG', 'OO', 'CG'] }], 'J4'), /ranking/);
  assert.throws(() => tallyBallots([...ballots.slice(0, 4), { ...ballots[4], model: 'gpt-6.1-sol' }], 'J4'), /model/);
  const missingModel = { ...ballots[4] };
  delete missingModel.model;
  assert.throws(() => tallyBallots([...ballots.slice(0, 4), missingModel], 'J4'), /model/);
});

test('a chief has one ordinary vote and cannot overturn a clear plurality', () => {
  const result = tallyBallots(panel([
    ['OG', 'OO', 'CG', 'CO'], ['OG', 'CO', 'OO', 'CG'], ['OG', 'CG', 'CO', 'OO'],
    ['OO', 'CG', 'CO', 'OG'], ['CG', 'OO', 'CO', 'OG'],
  ]), 'J5');
  assert.equal(result.winner, 'OG');
  assert.equal(result.tallies.OG.firstPlaceVotes, 3);
  assert.equal(Object.values(result.tallies).reduce((sum, t) => sum + t.firstPlaceVotes, 0), 5);
  assert.equal(result.tieBreak.method, 'first-place votes');
});

test('a 2-2-1 split is resolved by ranking points of the tied first-place teams', () => {
  const result = tallyBallots(panel([
    ['OG', 'OO', 'CG', 'CO'], ['OG', 'CG', 'OO', 'CO'], ['OO', 'CO', 'OG', 'CG'],
    ['OO', 'CG', 'CO', 'OG'], ['CG', 'OO', 'CO', 'OG'],
  ]), 'J1');
  assert.equal(result.winner, 'OO');
  assert.equal(result.tallies.OG.firstPlaceVotes, 2);
  assert.equal(result.tallies.OO.firstPlaceVotes, 2);
  assert.equal(result.tallies.CG.firstPlaceVotes, 1);
  assert.equal(result.tallies.OG.bordaPoints, 7);
  assert.equal(result.tallies.OO.bordaPoints, 11);
  assert.deepEqual(result.tieBreak.firstPlaceTied, ['OG', 'OO']);
  assert.match(result.tieBreak.method, /Borda/);
});

test('chief ordering breaks only the tie remaining after first-place votes and ranking points', () => {
  const ballots = panel([
    ['OG', 'OO', 'CG', 'CO'], ['OG', 'OO', 'CO', 'CG'], ['OO', 'OG', 'CG', 'CO'],
    ['OO', 'CG', 'OG', 'CO'], ['CG', 'OG', 'OO', 'CO'],
  ]);
  const result = tallyBallots(ballots, 'J4');
  assert.equal(result.tallies.OG.bordaPoints, 11);
  assert.equal(result.tallies.OO.bordaPoints, 11);
  assert.equal(result.winner, 'OO');
  assert.deepEqual(result.tieBreak.bordaTied, ['OG', 'OO']);
  assert.match(result.tieBreak.method, /chief judge/);
  assert.equal(tallyBallots(ballots, 'J2').winner, 'OG');
  // J5 ranks CG first, but CG is outside the remaining tie and cannot win it.
  assert.equal(tallyBallots(ballots, 'J5').winner, 'OG');
});

test('the shuffled per-round panel validates each ballot against its own assigned model', () => {
  const shuffled = JUDGES.map((judge, index) => ({ ...judge, model: JUDGES.at(-index - 1).model }));
  const ballots = panel(Array.from({ length: 5 }, () => ['OG', 'OO', 'CG', 'CO'])).map((b, i) => ({ ...b, status: 'completed', model: shuffled[i].model }));
  assert.equal(tallyBallots(ballots, 'J4', shuffled).winner, 'OG');
  assert.throws(() => tallyBallots(ballots, 'J4'), /model/);
  assert.throws(() => tallyBallots([{ ...ballots[0], model: 'gpt-6.1-sol' }, ...ballots.slice(1)], 'J4', shuffled), /model/);
});

test('owner sees model routing in every status while a result still requires five valid ballots', () => {
  const ballots = panel(Array.from({ length: 5 }, () => ['OG', 'OO', 'CG', 'CO'])).map((b, i) => ({ ...b, status: 'completed', model: JUDGES[i].model }));
  const run = { status: 'completed', settings: { chiefJudgeId: 'J4' }, teams: TEAMS, speeches: SPEAKERS, judges: JUDGES, ballots, result: tallyBallots(ballots, 'J4'), _private: { plans: { OG: 'private' } } };
  const visibleRun = publicRun(run);
  assert.equal(visibleRun.anonymity.identitiesVisibleToUser, true);
  assert.equal(visibleRun.anonymity.participantsBlinded, true);
  assert.deepEqual(visibleRun.settings.teamEfforts, { OG: 'auto', OO: 'auto', CG: 'auto', CO: 'auto' });
  assert.deepEqual(visibleRun.settings.judgeEfforts, { J1: 'auto', J2: 'auto', J3: 'auto', J4: 'auto', J5: 'auto' });
  assert.equal(run.settings.teamEfforts, undefined, 'Legacy effort projection does not mutate stored settings');
  assert.ok(run.teams.every(team => !Object.hasOwn(team, 'reasoningEffort')), 'Legacy effort projection does not mutate stored seats');
  for (const invalid of [
    { ...run, status: 'judging' },
    { ...run, ballots: ballots.slice(0, 4) },
    { ...run, ballots: [{ ...ballots[0], status: 'pending' }, ...ballots.slice(1)] },
    { ...run, ballots: [{ ...ballots[0], ranking: ['OG', 'OO', 'CG'] }, ...ballots.slice(1)] },
    { ...run, result: { ...run.result, winner: 'CO' } },
  ]) {
    const visible = publicRun(invalid);
    assert.equal(visible.anonymity.identitiesVisibleToUser, true);
    assert.equal(visible.anonymity.participantsBlinded, true);
    assert.equal(visible._private, undefined);
    assert.equal(visible.result, null);
    assert.match(JSON.stringify(visible), /gpt-6\.1-sol|gpt-6-astra/);
  }
});
