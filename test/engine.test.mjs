// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DebateEngine, exportMarkdown } from '../lib/engine.mjs';

const RANKING = ['OG', 'OO', 'CG', 'CO'];
const VALID_BALLOT = { ranking: RANKING, reasoning: 'OG wins the S1 versus S2 opening clash, and S5 does not reverse that comparison.' };
const IDENTITIES = /gpt[\s_\-\u2010-\u2015]*6(?:\.1)?[\s_\-\u2010-\u2015]*(?:sol|astra)|\b(?:sol|astra)\b/iu;
const CUSTOM_MODELS = ['orbit/debate-alpha', 'quartz-chat-2', 'raven.v3', 'cedar-chat', 'referee/large-1', 'referee/small-2', 'unselected-text-9', 'gpt-image-1', 'codex-auto-review'];
const CUSTOM_TEAM_MODELS = { OG: CUSTOM_MODELS[0], OO: CUSTOM_MODELS[1], CG: CUSTOM_MODELS[2], CO: CUSTOM_MODELS[3] };
const CUSTOM_JUDGE_MODELS = { J1: CUSTOM_MODELS[4], J2: CUSTOM_MODELS[5], J3: CUSTOM_MODELS[3], J4: CUSTOM_MODELS[4], J5: CUSTOM_MODELS[2] };
const CUSTOM_TEAM_EFFORTS = { OG: 'high', OO: 'low', CG: 'medium', CO: 'auto' };
const CUSTOM_JUDGE_EFFORTS = { J1: 'low', J2: 'auto', J3: 'medium', J4: 'high', J5: 'high' };

function assertOwnerVisibility(value) {
  assert.equal(value._private, undefined);
  for (const collection of ['teams', 'speakers', 'speeches', 'judges', 'ballots']) {
    for (const seat of value[collection] || []) {
      assert.equal(typeof seat.model, 'string', `${collection}/${seat.id || seat.judgeId} shows its model to the owner`);
      assert.ok(seat.model.trim());
      if (seat.poi) assert.equal(typeof seat.poi.model, 'string', 'POI shows its offering model to the owner');
    }
  }
  if (value.anonymity) {
    assert.equal(value.anonymity.mode, 'double-blind');
    assert.equal(value.anonymity.identitiesVisibleToUser, true);
    assert.equal(value.anonymity.participantsBlinded, true);
  }
}

function assertOwnerRun(run) {
  assertOwnerVisibility(run);
  assert.doesNotMatch(JSON.stringify(run), /PRIVATE_PLAN_/u, 'Private preparation is not exposed to the owner');
  const markdown = exportMarkdown(run);
  for (const seat of [...run.teams, ...run.judges]) {
    assert.ok(JSON.stringify(run).includes(seat.model), 'JSON export shows owner routing');
    assert.ok(markdown.includes(seat.model), 'Markdown export shows owner routing');
  }
}

function assertBalancedAssignment(run) {
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra']) {
    const teams = run.teams.filter(t => t.model === model);
    assert.equal(teams.length, 2);
    assert.deepEqual(new Set(teams.map(t => t.position)), new Set(['opening', 'closing']));
    assert.deepEqual(new Set(teams.map(t => t.bench)), new Set(['government', 'opposition']));
  }
  assert.equal(run.judges.filter(j => j.model === 'gpt-6.1-sol').length, 3);
  assert.equal(run.judges.filter(j => j.model === 'gpt-6-astra').length, 2);
  for (const speech of run.speeches) assert.equal(speech.model, run.teams.find(t => t.id === speech.teamId).model);
  for (const ballot of run.ballots) assert.equal(ballot.model, run.judges.find(j => j.id === ballot.judgeId).model);
}

function assertDebatersBlind(calls) {
  for (const call of calls.filter(c => !c.stage.startsWith('ballot:') && c.stage !== 'motion')) {
    const prompt = JSON.stringify(call.body.messages);
    assert.doesNotMatch(prompt, IDENTITIES, `Identity in ${call.stage}`);
    assert.doesNotMatch(prompt, /\bJ[1-5]\b|"(?:judges|ballots|chiefJudgeId|judgeId)"/u, `Judge metadata in ${call.stage}`);
  }
  for (const call of calls) assert.doesNotMatch(JSON.stringify(call.body.messages), /"(?:reasoningEffort|reasoning_effort|teamEfforts|judgeEfforts|activity|requests|startedAt|attemptStartedAt|attempt|maxAttempts|timeoutMs|lastError|endedAt)"/u, `Operator metadata stays outside participant prompts in ${call.stage}`);
}

function assertEffortAssignment(run, teamEfforts, judgeEfforts) {
  assert.deepEqual(run.settings.teamEfforts, teamEfforts);
  assert.deepEqual(run.settings.judgeEfforts, judgeEfforts);
  for (const team of run.teams) assert.equal(team.reasoningEffort, teamEfforts[team.id]);
  for (const judge of run.judges) assert.equal(judge.reasoningEffort, judgeEfforts[judge.id]);
  for (const speech of run.speeches) {
    assert.equal(speech.reasoningEffort, teamEfforts[speech.teamId]);
    if (speech.poi) assert.equal(speech.poi.reasoningEffort, teamEfforts[speech.poi.offeredByTeamId]);
  }
  for (const ballot of run.ballots) assert.equal(ballot.reasoningEffort, judgeEfforts[ballot.judgeId]);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function until(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(5);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function fixture(stage) {
  const [kind, slot] = stage.split(':');
  switch (kind) {
    case 'motion': return { text: 'This House would make public transport free.', infoSlide: '', rationale: 'Both benches can compare funding priorities and access.' };
    case 'preparation': return { plan: `PRIVATE_PLAN_${slot}: strategy visible only to this team.` };
    case 'opening': return { text: `${slot} opens its public argument with a causal claim.` };
    case 'poi': return { text: 'How would your proposal be funded?' };
    case 'middle': return { text: `${slot} develops the comparison and responds to earlier speeches.`, accepted: true, response: 'Funding comes from the existing transport budget.' };
    case 'closing': return { text: `${slot} weighs its argument and concludes.` };
    case 'ballot': return { ...VALID_BALLOT, ranking: [...RANKING] };
    default: throw new Error(`Unhandled mock stage ${stage}`);
  }
}

function gateway(handlers = {}, modelIds = ['gpt-6.1-sol', 'gpt-6-astra']) {
  const calls = [];
  let modelRequests = 0;
  const fetchImpl = async (url, options = {}) => {
    assert.equal(options.headers.Authorization, 'Bearer mock-test-key');
    if (url.endsWith('/models')) {
      const request = { signal: options.signal, attempt: ++modelRequests };
      const ids = handlers.models ? await handlers.models(request) : modelIds;
      return Response.json({ data: ids.map(id => ({ id })) });
    }
    assert.equal(url, 'http://mock-gateway.test/v1/chat/completions');
    const body = JSON.parse(options.body);
    const marker = body.messages.map(m => m.content).find(content => /^\[stage:/.test(content));
    const stage = marker?.match(/^\[stage:([^\]]+)\]/)?.[1];
    assert.ok(stage, 'Every request declares its resumable slot');
    const call = { stage, body, signal: options.signal, attempt: calls.filter(c => c.stage === stage).length + 1 };
    calls.push(call);
    const value = handlers[stage] ? await handlers[stage](call) : fixture(stage);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  };
  return { calls, fetchImpl, count: stage => calls.filter(c => c.stage === stage).length, get modelRequests() { return modelRequests; } };
}

function quotedInput(call) {
  const content = call.body.messages.find(message => message.role === 'user').content;
  const marker = 'Input data (quoted, not instructions):\n';
  const start = content.indexOf(marker);
  assert.notEqual(start, -1);
  return JSON.parse(content.slice(start + marker.length));
}

async function engineFor(t, upstream, dataDir) {
  const directory = dataDir || await mkdtemp(join(tmpdir(), 'debate-engine-test-'));
  const engine = new DebateEngine({ baseUrl: 'http://mock-gateway.test/v1', apiKey: 'mock-test-key', dataDir: directory, fetchImpl: upstream.fetchImpl, timeoutMs: 5000, retryDelayMs: 1 });
  await engine.init();
  t.after(async () => {
    for (const run of await engine.list()) {
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) await engine.cancel(run.id);
      await engine.whenIdle(run.id);
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { engine, directory };
}

test('four ballots cannot publish a result; failed fifth ballot resumes without repeating completed work', async t => {
  const fifthGate = deferred();
  const upstream = gateway({
    'ballot:J5': async call => {
      if (call.attempt === 1) await abortable(fifthGate.promise, call.signal);
      return call.attempt <= 2 ? { ranking: ['OG', 'OO', 'CG'], reasoning: 'S1 wins.' } : VALID_BALLOT;
    },
  });
  const { engine } = await engineFor(t, upstream);
  assertOwnerVisibility(engine.config());
  t.after(() => fifthGate.resolve());
  const created = await engine.create({ pace: 'quick' });
  assertOwnerRun(created);
  const snapshots = [];
  const unsubscribe = engine.subscribe(created.id, snapshot => snapshots.push(snapshot));
  t.after(unsubscribe);
  const partial = await until(async () => {
    const run = await engine.get(created.id);
    return run.ballots?.filter(b => b.status === 'completed').length === 4 && upstream.count('ballot:J5') ? run : null;
  }, 'four completed ballots while the fifth request is held');
  assert.equal(partial.result, null);
  assert.notEqual(partial.status, 'completed');
  assert.equal(partial.speeches.filter(s => s.status === 'completed').length, 8);
  assert.equal(partial._private, undefined);
  assertOwnerRun(partial);
  assertOwnerVisibility(engine.list()[0]);
  assert.deepEqual(engine.list()[0].settings.teamModels, Object.fromEntries(partial.teams.map(t => [t.id, t.model])));
  assert.deepEqual(engine.list()[0].settings.judgeModels, Object.fromEntries(partial.judges.map(j => [j.id, j.model])));
  assertDebatersBlind(upstream.calls);

  const judgeCalls = upstream.calls.filter(c => c.stage.startsWith('ballot:'));
  assert.equal(judgeCalls.length, 5);
  const normalizeJudge = body => body.messages.map(m => ({ ...m, content: m.content.replace(/^\[stage:ballot:J[1-5]\]/, '[stage:ballot]') }));
  const firstJudgePrompt = normalizeJudge(judgeCalls[0].body);
  for (const call of judgeCalls) {
    assert.deepEqual(normalizeJudge(call.body), firstJudgePrompt, 'Every judge receives the same independent public transcript');
    const prompt = JSON.stringify(call.body.messages);
    assert.doesNotMatch(prompt, /PRIVATE_PLAN_|gpt-6\.1-sol|gpt-6-astra/);
    for (let i = 1; i <= 8; i++) assert.match(prompt, new RegExp(`S${i}`));
  }
  assert.deepEqual(judgeCalls.map(c => c.body.model).sort(), ['gpt-6-astra', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6.1-sol']);

  fifthGate.resolve();
  await engine.whenIdle(created.id);
  const failed = await engine.get(created.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result, null);
  assert.equal(failed.ballots.filter(b => b.status === 'completed').length, 4);
  assertOwnerRun(failed);
  assertOwnerVisibility(engine.list()[0]);
  assert.equal(upstream.count('ballot:J5'), 2, 'Malformed JSON gets one repair before the step fails');
  const completedCounts = new Map(upstream.calls.filter(c => c.stage !== 'ballot:J5').map(c => [c.stage, upstream.count(c.stage)]));
  await engine.resume(created.id);
  await engine.whenIdle(created.id);
  const finished = await engine.get(created.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.ballots.filter(b => b.status === 'completed').length, 5);
  assert.equal(finished.result.winner, 'OG');
  assertBalancedAssignment(finished);
  assertEffortAssignment(finished, { OG: 'auto', OO: 'auto', CG: 'auto', CO: 'auto' }, { J1: 'auto', J2: 'auto', J3: 'auto', J4: 'auto', J5: 'auto' });
  for (const call of upstream.calls) assert.ok(!Object.hasOwn(call.body, 'reasoning_effort'), `Auto effort is omitted from ${call.stage}, including repairs`);
  assert.match(exportMarkdown(finished), IDENTITIES);
  for (const snapshot of snapshots) assertOwnerRun(snapshot);
  assertBalancedAssignment(snapshots.at(-1));
  assert.equal(upstream.count('ballot:J5'), 3);
  for (const [stage, count] of completedCounts) assert.equal(upstream.count(stage), count, `Resume must preserve ${stage}`);
});

test('cancel followed immediately by resume cannot let the aborted worker overwrite its replacement', async t => {
  const upstream = gateway({
    'middle:S2': async call => {
      if (call.attempt === 1) {
        await new Promise((resolve, reject) => {
          const abort = () => setTimeout(() => reject(call.signal.reason || new DOMException('Aborted', 'AbortError')), 30);
          call.signal.aborted ? abort() : call.signal.addEventListener('abort', abort, { once: true });
        });
      }
      return fixture(call.stage);
    },
  });
  const { engine, directory } = await engineFor(t, upstream);
  const run = await engine.create({ pace: 'quick' });
  await until(() => upstream.count('middle:S2') === 1, 'the second speech middle request');
  const beforeCancel = await engine.get(run.id);
  assert.equal(beforeCancel.speeches[0].status, 'completed');
  assertOwnerRun(beforeCancel);
  assertOwnerRun(await engine.cancel(run.id));
  assertOwnerVisibility(engine.list()[0]);
  const resumed = await engine.resume(run.id);
  assert.notEqual(resumed.status, 'cancelled');
  await engine.whenIdle(run.id);
  const finished = await engine.get(run.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.speeches.filter(s => s.status === 'completed').length, 8);
  assertBalancedAssignment(finished);
  assert.equal(upstream.count('middle:S2'), 2);
  for (const stage of ['motion', 'preparation:OG', 'preparation:OO', 'preparation:CG', 'preparation:CO', 'opening:S1', 'poi:S1', 'middle:S1', 'closing:S1', 'opening:S2', 'poi:S2']) {
    assert.equal(upstream.count(stage), 1, `Cancel/resume must preserve completed ${stage}`);
  }
  const files = await readdir(directory);
  assert.deepEqual(files, [`${run.id}.json`], 'Settled atomic persistence leaves one run JSON and no temporary write files');
  const persisted = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
  assert.equal(persisted.status, 'completed');
  assert.equal(persisted.result.winner, 'OG');
});

test('identity-containing hints, motion, private plans, and public speeches stay out of model prompts', async t => {
  const handlers = {};
  for (const stage of ['motion', ...['OG', 'OO', 'CG', 'CO'].map(id => `preparation:${id}`), ...Array.from({ length: 8 }, (_, i) => i + 1).flatMap(i => ['opening', 'poi', 'middle', 'closing'].map(kind => `${kind}:S${i}`)), ...Array.from({ length: 5 }, (_, i) => `ballot:J${i + 1}`)]) {
    handlers[stage] = () => {
      const value = fixture(stage);
      for (const [key, text] of Object.entries(value)) if (typeof text === 'string' && text) value[key] = `GPT-6.1 Sol and gpt-6-astra; J1, Judge 4, 裁判5: ${text}`;
      return value;
    };
  }
  const upstream = gateway(handlers);
  const { engine } = await engineFor(t, upstream);
  const created = await engine.create({ pace: 'quick', topicHint: 'J1 and Judge 4 will judge GPT-6.1 Sol (gpt-6.1-sol, gpt6.1 sol, GPT‑6.1 Sol) against GPT-6 Astra (gpt-6-astra, gpt 6 astra, GPT‑6 Astra) on public transport.' });
  const snapshots = [];
  const histories = [];
  const unsubscribe = engine.subscribe(created.id, snapshot => {
    snapshots.push(snapshot);
    histories.push({ status: snapshot.status, value: engine.list()[0] });
  });
  t.after(unsubscribe);
  await engine.whenIdle(created.id);
  const finished = await engine.get(created.id);
  assert.equal(finished.status, 'completed');
  assertDebatersBlind(upstream.calls);
  for (const call of upstream.calls) assert.doesNotMatch(JSON.stringify(call.body.messages), IDENTITIES, `Every ${call.stage} prompt masks accidental identity text`);
  for (const snapshot of snapshots) assertOwnerRun(snapshot);
  for (const entry of histories) assertOwnerVisibility(entry.value);
  const judges = upstream.calls.filter(c => c.stage.startsWith('ballot:'));
  const normalize = call => JSON.stringify(call.body.messages).replace(/stage:ballot:J[1-5]/g, 'stage:ballot');
  assert.equal(judges.length, 5);
  for (const judge of judges) {
    assert.equal(normalize(judge), normalize(judges[0]));
    assert.doesNotMatch(JSON.stringify(judge.body.messages), /PRIVATE_PLAN_|"(?:ballots|privateTeamPlan|judgeId)"/u);
  }
});

test('cancelling when motion persistence finishes retains cancelled status', async t => {
  const upstream = gateway();
  const { engine } = await engineFor(t, upstream);
  const created = await engine.create({ pace: 'quick' });
  let cancellation;
  const unsubscribe = engine.subscribe(created.id, snapshot => {
    if (snapshot.motion && snapshot.status === 'motion' && !cancellation) cancellation = engine.cancel(created.id);
  });
  await engine.whenIdle(created.id);
  unsubscribe();
  assert.ok(cancellation, 'Cancellation occurs exactly after the motion is saved');
  await cancellation;
  const cancelled = await engine.get(created.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.result, null);
  assert.equal(upstream.count('motion'), 1);
  assert.equal(upstream.calls.filter(c => c.stage.startsWith('preparation:')).length, 0);
  await engine.resume(created.id);
  await engine.whenIdle(created.id);
  assert.equal((await engine.get(created.id)).status, 'completed');
  assert.equal(upstream.count('motion'), 1, 'The saved motion is retained on resume');
});

test('a pending resume and a new run cannot both acquire the chamber', async t => {
  const secondMotion = deferred();
  let motionCalls = 0;
  const upstream = gateway({
    motion: async call => {
      if (++motionCalls === 2) await abortable(secondMotion.promise, call.signal);
      return fixture(call.stage);
    },
    'middle:S2': async call => {
      if (call.attempt === 1) await new Promise((resolve, reject) => {
        const abort = () => setTimeout(() => reject(call.signal.reason), 40);
        call.signal.aborted ? abort() : call.signal.addEventListener('abort', abort, { once: true });
      });
      return fixture(call.stage);
    },
  });
  const { engine } = await engineFor(t, upstream);
  const first = await engine.create({ pace: 'quick' });
  await until(() => upstream.count('middle:S2'), 'the first run to reach its interrupted slot');
  await engine.cancel(first.id);
  const pendingResume = engine.resume(first.id).then(run => ({ run }), error => ({ error }));
  const createdAgain = await engine.create({ pace: 'quick' }).then(run => ({ run }), error => ({ error }));
  const resumed = await pendingResume;
  const active = (await engine.list()).filter(run => ['motion', 'preparation', 'debating', 'judging'].includes(run.status));
  assert.ok(active.length <= 1, 'The single chamber cannot contain both newly created and resumed rounds');
  assert.ok(createdAgain.error || resumed.error, 'One competing acquisition must be rejected');
  const rejection = createdAgain.error || resumed.error;
  assert.equal(rejection.status, 409);
  if (createdAgain.run) {
    await engine.cancel(createdAgain.run.id);
    await engine.whenIdle(createdAgain.run.id);
  }
  if (resumed.run) await engine.whenIdle(first.id);
});

test('a persisted interrupted round becomes resumable after restart and retains private preparation', async t => {
  const held = deferred();
  const upstream = gateway({ 'middle:S2': async call => {
    call.signal.addEventListener('abort', () => held.reject(call.signal.reason), { once: true });
    await held.promise;
    return fixture(call.stage);
  } });
  const { engine, directory } = await engineFor(t, upstream);
  const created = await engine.create({ pace: 'quick' });
  await until(() => upstream.count('middle:S2'), 'an interrupted speech');
  const raw = await readFile(join(directory, `${created.id}.json`), 'utf8');
  const interrupted = JSON.parse(raw);
  assert.notEqual(interrupted.status, 'completed');
  assert.equal(interrupted.speeches[0].status, 'completed');
  await engine.cancel(created.id);
  await engine.whenIdle(created.id);

  const recoveredDir = await mkdtemp(join(tmpdir(), 'debate-restart-test-'));
  const legacy = structuredClone(interrupted);
  delete legacy.activity;
  delete legacy.settings.teamEfforts;
  delete legacy.settings.judgeEfforts;
  for (const collection of ['teams', 'judges', 'speeches', 'ballots']) for (const seat of legacy[collection]) {
    delete seat.reasoningEffort;
    if (seat.poi) delete seat.poi.reasoningEffort;
  }
  await writeFile(join(recoveredDir, `${created.id}.json`), JSON.stringify(legacy));
  const afterRestart = gateway();
  const { engine: recovered } = await engineFor(t, afterRestart, recoveredDir);
  const recoveredRun = await recovered.get(created.id);
  assert.notEqual(recoveredRun.status, 'completed');
  assert.equal(recoveredRun.result, null);
  assert.equal(recoveredRun._private, undefined);
  assertOwnerRun(recoveredRun);
  assertEffortAssignment(recoveredRun, { OG: 'auto', OO: 'auto', CG: 'auto', CO: 'auto' }, { J1: 'auto', J2: 'auto', J3: 'auto', J4: 'auto', J5: 'auto' });
  assert.ok(!recoveredRun.activity || recoveredRun.activity.requests.length === 0, 'Legacy rounds tolerate missing activity before the next request');
  await recovered.resume(created.id);
  await recovered.whenIdle(created.id);
  const finished = await recovered.get(created.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.ballots.filter(b => b.status === 'completed').length, 5);
  assertBalancedAssignment(finished);
  assert.deepEqual(finished.teams.map(t => t.model), interrupted.teams.map(t => t.model), 'Restart preserves team assignment');
  assert.deepEqual(finished.judges.map(j => j.model), interrupted.judges.map(j => j.model), 'Restart preserves judge assignment');
  for (const stage of ['motion', 'preparation:OG', 'preparation:OO', 'preparation:CG', 'preparation:CO', 'opening:S1', 'poi:S1', 'middle:S1', 'closing:S1', 'opening:S2', 'poi:S2']) {
    assert.equal(afterRestart.count(stage), 0, `Restart must retain completed ${stage}`);
  }
  assert.equal(afterRestart.count('middle:S2'), 1);
  for (const call of afterRestart.calls) assert.ok(!Object.hasOwn(call.body, 'reasoning_effort'), 'Legacy rounds without efforts retain transport auto behavior');
  assert.ok(finished.activity.requests.length > 0, 'Resuming a legacy round records its new requests');
  assert.ok(finished.activity.requests.every(request => request.status === 'completed' && request.endedAt), 'Completed legacy-resume requests have stopped clocks');
  assert.match(JSON.stringify(afterRestart.calls.find(c => c.stage === 'middle:S2').body.messages), /PRIVATE_PLAN_OO/, 'Private team preparation must survive disk recovery');
});

test('custom models route every role correctly, stay out of prompts and repair messages, and survive restart', async t => {
  const held = deferred();
  const identityText = `${CUSTOM_MODELS[0]}, ${CUSTOM_MODELS[4]}, ${CUSTOM_MODELS[6]}, ${CUSTOM_MODELS[7]}`;
  const identityFixture = stage => {
    const value = fixture(stage);
    for (const [key, text] of Object.entries(value)) if (typeof text === 'string' && text) value[key] = `${identityText}: ${text}`;
    return value;
  };
  const handlers = Object.fromEntries(['motion', ...['OG', 'OO', 'CG', 'CO'].map(id => `preparation:${id}`), ...Array.from({ length: 8 }, (_, i) => i + 1).flatMap(i => ['opening', 'poi', 'middle', 'closing'].map(kind => `${kind}:S${i}`))].map(stage => [stage, () => identityFixture(stage)]));
  handlers['preparation:OG'] = call => {
    if (call.attempt === 1) throw new TypeError('Mock gateway connection reset');
    return identityFixture(call.stage);
  };
  handlers['opening:S1'] = call => call.attempt === 1 ? { text: '', identity: CUSTOM_MODELS.join(' | ') } : identityFixture(call.stage);
  handlers['middle:S2'] = async call => {
    await abortable(held.promise, call.signal);
    return identityFixture(call.stage);
  };
  const upstream = gateway(handlers, CUSTOM_MODELS);
  const { engine, directory } = await engineFor(t, upstream);
  const available = await engine.availableModels();
  assert.equal(available.ok, true);
  assert.ok(available.models.includes(CUSTOM_MODELS[0]));
  assert.ok(available.models.includes(CUSTOM_MODELS[6]));
  assert.ok(!available.models.includes(CUSTOM_MODELS[7]));
  assert.ok(!available.models.includes(CUSTOM_MODELS[8]));
  const created = await engine.create({ pace: 'quick', targetLength: 640, chiefJudgeId: 'J5', teamModels: CUSTOM_TEAM_MODELS, judgeModels: CUSTOM_JUDGE_MODELS, teamEfforts: CUSTOM_TEAM_EFFORTS, judgeEfforts: CUSTOM_JUDGE_EFFORTS, topicHint: CUSTOM_MODELS.join(', ') });
  assertOwnerRun(created);
  assert.deepEqual(created.settings.teamModels, CUSTOM_TEAM_MODELS);
  assert.deepEqual(created.settings.judgeModels, CUSTOM_JUDGE_MODELS);
  assert.equal(created.settings.targetLength, 640);
  assert.equal(created.settings.lengthUnit, 'words');
  assertEffortAssignment(created, CUSTOM_TEAM_EFFORTS, CUSTOM_JUDGE_EFFORTS);
  await until(() => upstream.count('middle:S2'), 'custom round interrupted after its first speech');
  const raw = await readFile(join(directory, `${created.id}.json`), 'utf8');
  const openingRequests = JSON.parse(raw).activity.requests.filter(request => request.stage === 'opening:S1');
  assert.equal(openingRequests.length, 2, 'Structured JSON repair is a separate observable model request');
  assert.equal(new Set(openingRequests.map(request => request.id)).size, 2);
  assert.equal(openingRequests.filter(request => request.repair === true).length, 1);
  for (const request of openingRequests) {
    assert.equal(request.status, 'completed');
    assert.equal(request.reasoningEffort, 'high');
    assert.equal(request.attempt, 1);
    assert.ok(request.endedAt);
  }
  await engine.cancel(created.id);
  await engine.whenIdle(created.id);
  const recoveredDir = await mkdtemp(join(tmpdir(), 'debate-custom-restart-'));
  await writeFile(join(recoveredDir, `${created.id}.json`), raw);
  const resumedHandlers = Object.fromEntries(Object.keys(handlers).filter(stage => stage !== 'opening:S1').map(stage => [stage, () => identityFixture(stage)]));
  const afterRestart = gateway(resumedHandlers, CUSTOM_MODELS);
  const { engine: recovered } = await engineFor(t, afterRestart, recoveredDir);
  assertOwnerRun(recovered.get(created.id));
  await recovered.resume(created.id);
  await recovered.whenIdle(created.id);
  const finished = recovered.get(created.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.ballots.filter(b => b.status === 'completed').length, 5);
  assert.equal(finished.result.winner, 'OG');
  assert.deepEqual(finished.settings.teamModels, CUSTOM_TEAM_MODELS);
  assert.deepEqual(finished.settings.judgeModels, CUSTOM_JUDGE_MODELS);
  assert.equal(finished.settings.targetLength, 640, 'Explicit target survives interrupted-round restart');
  assert.equal(finished.settings.lengthUnit, 'words');
  assertEffortAssignment(finished, CUSTOM_TEAM_EFFORTS, CUSTOM_JUDGE_EFFORTS);
  assert.deepEqual(Object.fromEntries(finished.teams.map(t => [t.id, t.model])), CUSTOM_TEAM_MODELS);
  assert.deepEqual(Object.fromEntries(finished.judges.map(j => [j.id, j.model])), CUSTOM_JUDGE_MODELS);
  const allCalls = [...upstream.calls, ...afterRestart.calls];
  for (const call of allCalls) {
    const [kind, slot] = call.stage.split(':');
    const speech = finished.speeches.find(s => s.id === slot);
    const expected = kind === 'motion' ? CUSTOM_JUDGE_MODELS.J5 : kind === 'preparation' ? CUSTOM_TEAM_MODELS[slot] : kind === 'ballot' ? CUSTOM_JUDGE_MODELS[slot] : kind === 'poi' ? CUSTOM_TEAM_MODELS[speech.poi.offeredByTeamId] : CUSTOM_TEAM_MODELS[speech.teamId];
    assert.equal(call.body.model, expected, `Selected routing for ${call.stage}`);
    const effort = kind === 'motion' ? CUSTOM_JUDGE_EFFORTS.J5 : kind === 'preparation' ? CUSTOM_TEAM_EFFORTS[slot] : kind === 'ballot' ? CUSTOM_JUDGE_EFFORTS[slot] : kind === 'poi' ? CUSTOM_TEAM_EFFORTS[speech.poi.offeredByTeamId] : CUSTOM_TEAM_EFFORTS[speech.teamId];
    if (effort === 'auto') assert.ok(!Object.hasOwn(call.body, 'reasoning_effort'), `Auto effort is omitted from ${call.stage}`);
    else assert.equal(call.body.reasoning_effort, effort, `Reasoning effort follows ${call.stage} routing, including repairs`);
    const prompt = JSON.stringify(call.body.messages);
    for (const model of CUSTOM_MODELS) assert.ok(!prompt.toLowerCase().includes(model.toLowerCase()), `${call.stage} hides available identity ${model}`);
    if (['opening', 'middle', 'closing'].includes(kind)) {
      const input = quotedInput(call);
      assert.deepEqual(input.lengthBudget, { targetLength: 640, unit: 'words', sections: { opening: 96, middle: 448, closing: 96 } });
      if (kind === 'opening') assert.match(prompt, /approximately 96 English words/);
      if (kind === 'middle') assert.match(prompt, /approximately 448 English words/);
      if (kind === 'closing') {
        const delivered = [input.currentSpeech.opening, input.currentSpeech.middle].join(' ').trim().split(/\s+/).filter(Boolean).length;
        assert.match(prompt, new RegExp(`approximately ${Math.max(1, 640 - delivered)} English words`));
        assert.match(prompt, new RegExp(`already delivered ${delivered} English words`));
      }
    }
  }
  assert.equal(upstream.count('opening:S1'), 2, 'Invalid structured opening triggers a repaired response');
  assert.equal(upstream.count('preparation:OG'), 2, 'Transient gateway failure retries with the selected effort');
  assert.equal(afterRestart.count('motion'), 0);
  assert.equal(afterRestart.count('opening:S1'), 0);
  assert.equal(afterRestart.count('preparation:OO'), 0);
  assertDebatersBlind(allCalls);
  const judges = allCalls.filter(c => c.stage.startsWith('ballot:'));
  const normalize = call => JSON.stringify(call.body.messages).replace(/stage:ballot:J[1-5]/g, 'stage:ballot');
  assert.equal(judges.length, 5);
  for (const judge of judges) assert.equal(normalize(judge), normalize(judges[0]));
  const markdown = exportMarkdown(finished);
  for (const effort of new Set([...Object.values(CUSTOM_TEAM_EFFORTS), ...Object.values(CUSTOM_JUDGE_EFFORTS)])) assert.ok(markdown.includes(effort), `Markdown export displays owner effort ${effort}`);
});

test('Chinese character budgets include an accepted response and exclude the opposing question', async t => {
  const handlers = {};
  for (let i = 1; i <= 8; i++) {
    handlers[`opening:S${i}`] = () => ({ text: '开 场' });
    handlers[`poi:S${i}`] = () => ({ text: '为什么？' });
    handlers[`middle:S${i}`] = () => ({ accepted: true, response: '回答', text: '论点 分析' });
    handlers[`closing:S${i}`] = () => ({ text: '总结' });
  }
  const upstream = gateway(handlers);
  const { engine } = await engineFor(t, upstream);
  const created = await engine.create({ language: 'zh', pace: 'quick', targetLength: 200 });
  await engine.whenIdle(created.id);
  const finished = engine.get(created.id);
  assert.equal(finished.status, 'completed', 'Approximate targets do not trigger endless regeneration of short fixture speeches');
  assert.equal(finished.settings.targetLength, 200);
  assert.equal(finished.settings.lengthUnit, 'characters');
  for (const speech of finished.speeches) {
    assert.equal(speech.characterCount, 10, 'Two opening, six middle including response, and two closing characters are counted');
    assert.equal(speech.poi.response, '回答');
    assert.equal(speech.poi.accepted, true);
  }
  for (const call of upstream.calls.filter(c => /^(?:opening|middle|closing):/.test(c.stage))) {
    assert.deepEqual(quotedInput(call).lengthBudget, { targetLength: 200, unit: 'characters', sections: { opening: 30, middle: 140, closing: 30 } });
    const prompt = JSON.stringify(call.body.messages);
    const expected = call.stage.startsWith('opening:') ? 30 : call.stage.startsWith('middle:') ? 140 : 192;
    assert.match(prompt, new RegExp(`approximately ${expected} non-whitespace Chinese characters`));
    if (call.stage.startsWith('closing:')) assert.match(prompt, /already delivered 8 non-whitespace Chinese characters/);
  }
});

test('unknown, excluded, and incomplete model selections are rejected before debate work starts', async t => {
  const upstream = gateway({}, CUSTOM_MODELS);
  const { engine } = await engineFor(t, upstream);
  const valid = { pace: 'quick', teamModels: CUSTOM_TEAM_MODELS, judgeModels: CUSTOM_JUDGE_MODELS };
  for (const settings of [
    { ...valid, teamModels: { OG: CUSTOM_MODELS[0] } },
    { ...valid, judgeModels: { J1: CUSTOM_MODELS[4] } },
    { ...valid, teamModels: { ...CUSTOM_TEAM_MODELS, OG: '' } },
    { ...valid, teamModels: { ...CUSTOM_TEAM_MODELS, OG: 'not-in-model-catalog' } },
    { ...valid, judgeModels: { ...CUSTOM_JUDGE_MODELS, J5: CUSTOM_MODELS[7] } },
    { ...valid, teamModels: { ...CUSTOM_TEAM_MODELS, CO: CUSTOM_MODELS[8] } },
  ]) await assert.rejects(engine.create(settings), /model|mapping|selection|team|judge/i);
  assert.equal(upstream.calls.length, 0, 'Rejected selections never call a debate model');
  assert.equal(engine.list().length, 0, 'Rejected selections never create a saved round');
});

test('two creates awaiting model discovery cannot both acquire the chamber', async t => {
  const catalog = deferred();
  const motion = deferred();
  const upstream = gateway({ models: async request => {
    await abortable(catalog.promise, request.signal);
    return CUSTOM_MODELS;
  }, motion: async call => {
    await abortable(motion.promise, call.signal);
    return fixture(call.stage);
  } }, CUSTOM_MODELS);
  const { engine } = await engineFor(t, upstream);
  const settings = { pace: 'quick', teamModels: CUSTOM_TEAM_MODELS, judgeModels: CUSTOM_JUDGE_MODELS };
  const first = engine.create(settings);
  const second = engine.create(settings);
  const both = Promise.allSettled([first, second]);
  await until(() => upstream.modelRequests === 2, 'both creates waiting on discovery');
  catalog.resolve();
  const outcomes = await both;
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.equal(engine.list().length, 1);
  assert.equal(engine.list()[0].status, 'motion');
});

test('concurrent preparation activity resets its attempt clock on retry and stays terminal after cancel', async t => {
  const firstFailure = deferred();
  const held = deferred();
  const handlers = Object.fromEntries(['OO', 'CG', 'CO'].map(team => [`preparation:${team}`, async call => {
    await abortable(held.promise, call.signal);
    return fixture(call.stage);
  }]));
  handlers['preparation:OG'] = async call => {
    if (call.attempt === 1) {
      await abortable(firstFailure.promise, call.signal);
      throw new TypeError('Temporary mock gateway failure');
    }
    await abortable(held.promise, call.signal);
    return fixture(call.stage);
  };
  const upstream = gateway(handlers);
  const { engine } = await engineFor(t, upstream);
  const created = await engine.create({ pace: 'quick', teamEfforts: { OG: 'high', OO: 'auto', CG: 'auto', CO: 'auto' } });
  const snapshots = [];
  const unsubscribe = engine.subscribe(created.id, snapshot => snapshots.push(snapshot));
  t.after(unsubscribe);
  const first = await until(() => {
    const run = engine.get(created.id);
    const preparation = run.activity.requests.filter(request => request.stage.startsWith('preparation:'));
    return preparation.length === 4 && preparation.every(request => request.status === 'waiting' && request.attempt === 1) && upstream.calls.filter(call => call.stage.startsWith('preparation:')).length === 4 ? run : null;
  }, 'all four concurrent preparation requests');
  const original = first.activity.requests.find(request => request.stage === 'preparation:OG');
  assert.equal(original.model, first.teams.find(team => team.id === 'OG').model);
  assert.equal(original.reasoningEffort, 'high');
  assert.equal(original.maxAttempts, 3);
  assert.equal(original.timeoutMs, 5000);
  assert.equal(original.endedAt, null);
  assert.ok(Number.isFinite(Date.parse(original.startedAt)));
  assert.ok(Date.parse(original.attemptStartedAt) >= Date.parse(original.startedAt));
  firstFailure.resolve();
  const second = await until(() => {
    const request = engine.get(created.id).activity.requests.find(request => request.id === original.id);
    return request?.status === 'waiting' && request.attempt === 2 && upstream.count('preparation:OG') === 2 ? request : null;
  }, 'the second attempt after backoff');
  const retrying = snapshots.flatMap(snapshot => snapshot.activity?.requests || []).find(request => request.id === original.id && request.status === 'retrying');
  assert.ok(retrying, 'Retry backoff is exposed separately from waiting for a response');
  assert.equal(retrying.attempt, 1);
  assert.match(retrying.lastError, /Temporary mock gateway failure/);
  assert.equal(second.startedAt, original.startedAt);
  assert.ok(Date.parse(second.attemptStartedAt) > Date.parse(original.attemptStartedAt), 'Attempt timer restarts while total request start remains stable');
  assert.equal(second.lastError, retrying.lastError);
  assert.equal(second.endedAt, null);
  await engine.cancel(created.id);
  await engine.whenIdle(created.id);
  const stopped = engine.get(created.id);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.error.resumable, true);
  assert.equal(stopped.result, null);
  const stoppedPrep = stopped.activity.requests.filter(request => request.stage.startsWith('preparation:'));
  assert.equal(stoppedPrep.length, 4);
  for (const request of stoppedPrep) {
    assert.equal(request.status, 'cancelled');
    assert.ok(Date.parse(request.endedAt) >= Date.parse(request.attemptStartedAt));
  }
  for (const snapshot of snapshots.filter(snapshot => snapshot.status === 'cancelled')) {
    assert.ok(snapshot.activity.requests.every(request => !['waiting', 'retrying'].includes(request.status)), 'Aborted concurrent work cannot revive an active operator clock');
  }
  assertDebatersBlind(upstream.calls);
});

test('permanent request failure leaves a failed resumable round with no active request clocks', async t => {
  const upstream = gateway({ motion: () => { throw new Error('Permanent mock gateway failure'); } });
  const { engine } = await engineFor(t, upstream);
  const created = await engine.create({ pace: 'quick' });
  const snapshots = [];
  const unsubscribe = engine.subscribe(created.id, snapshot => snapshots.push(snapshot));
  t.after(unsubscribe);
  await engine.whenIdle(created.id);
  const failed = engine.get(created.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.resumable, true);
  assert.equal(failed.result, null);
  assert.equal(failed.activity.requests.length, 1);
  const request = failed.activity.requests[0];
  assert.equal(request.stage, 'motion');
  assert.equal(request.status, 'failed');
  assert.equal(request.attempt, 1, 'A non-transient error is not retried');
  assert.match(request.lastError, /Permanent mock gateway failure/);
  assert.ok(Date.parse(request.endedAt) >= Date.parse(request.attemptStartedAt));
  const primaryError = structuredClone(failed.error);
  const stoppedProgress = structuredClone(failed.progress);
  const stored = engine.requireRun(created.id);
  const lateController = new AbortController();
  lateController.abort(new DOMException('Worker ended after failure', 'AbortError'));
  for (const status of ['waiting', 'retrying', 'completed', 'cancelled']) {
    await engine.recordActivity(stored, { ...request, status, attempt: 2, endedAt: null, lastError: 'Late worker callback' }, lateController.signal, stored._private.generation);
    const updated = engine.get(created.id);
    const terminal = updated.activity.requests.find(row => row.id === request.id);
    assert.equal(terminal.status, 'failed', 'Late worker callbacks cannot revive or relabel a failed request');
    assert.match(terminal.lastError, /Permanent mock gateway failure/);
    assert.ok(terminal.endedAt);
    assert.deepEqual(updated.error, primaryError);
    assert.deepEqual(updated.progress, stoppedProgress);
  }
  await engine.recordActivity(stored, { ...request, id: 'late-request-id', stage: 'preparation:OG', status: 'waiting', endedAt: null, lastError: null }, lateController.signal, stored._private.generation);
  const late = engine.get(created.id).activity.requests.find(row => row.id === 'late-request-id');
  assert.equal(late.status, 'failed', 'A newly reported late request also has a stopped clock');
  assert.match(late.lastError, /Permanent mock gateway failure/);
  assert.ok(late.endedAt);
  for (const snapshot of snapshots.filter(snapshot => snapshot.status === 'failed')) assert.ok(snapshot.activity.requests.every(request => !['waiting', 'retrying'].includes(request.status)));
  assertDebatersBlind(upstream.calls);
});
