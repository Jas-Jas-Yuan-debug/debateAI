// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
'use strict';
import { connectLiveEvents } from './live-events.js';
const $ = id => document.getElementById(id);
const bootstrap = document.querySelector('meta[name="operator-token"]');
let operatorToken = bootstrap?.content || '';
try { operatorToken ||= sessionStorage.getItem('chamber-owner-token') || ''; if (operatorToken) sessionStorage.setItem('chamber-owner-token', operatorToken); } catch { /* The private access file can unlock each visit. */ }
if (bootstrap) { bootstrap.remove(); window.history.replaceState(null, '', '/'); }
if (!/^[a-f0-9]{64}$/.test(operatorToken)) operatorToken = '';
const activeStatuses = new Set(['motion', 'preparation', 'debating', 'judging']);
let config, current, history = [], source, selected = 'S1', busy = false, online = false, speechKey = '', speakerKey = '', judgeKey = '', historyBusy = false, modelsBusy = false, availableModels = [], lengthCustomized = false, streamFrame = null;
const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
const modelName = value => value === 'gpt-6-astra' ? 'GPT-6 Astra' : value === 'gpt-6.1-sol' ? 'GPT-6.1 Sol' : typeof value === 'string' && value ? value : 'Model not recorded';
const teamIds = ['OG', 'OO', 'CG', 'CO'];
const judgeIds = ['J1', 'J2', 'J3', 'J4', 'J5'];
const fallbackTeamModels = { OG: 'gpt-6.1-sol', OO: 'gpt-6-astra', CG: 'gpt-6-astra', CO: 'gpt-6.1-sol' };
const fallbackJudgeModels = { J1: 'gpt-6.1-sol', J2: 'gpt-6.1-sol', J3: 'gpt-6.1-sol', J4: 'gpt-6-astra', J5: 'gpt-6-astra' };
const draftModels = (kind, ids) => Object.fromEntries(ids.map(id => [id, $(`${kind}-model-${id}`)?.value || config?.defaults?.[`${kind}Models`]?.[id] || config?.[kind === 'team' ? 'teams' : 'judges']?.find(seat => seat.id === id)?.model || (kind === 'team' ? fallbackTeamModels : fallbackJudgeModels)[id]]));
const draftTeams = () => draftModels('team', teamIds);
const draftJudges = () => draftModels('judge', judgeIds);
const fallbackEfforts = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const effortOptions = () => config?.reasoningEfforts || fallbackEfforts;
const effortName = value => value === 'auto' ? 'Auto (service default)' : value === 'xhigh' ? 'XHigh' : `${(value || 'auto').charAt(0).toUpperCase()}${(value || 'auto').slice(1)}`;
const effortCaption = value => `Effort · ${effortName(value || 'auto')}`;
const draftEfforts = (kind, ids) => Object.fromEntries(ids.map(id => [id, $(`${kind}-effort-${id}`)?.value || config?.defaults?.[`${kind}Efforts`]?.[id] || 'auto']));
const draftTeamEfforts = () => draftEfforts('team', teamIds);
const draftJudgeEfforts = () => draftEfforts('judge', judgeIds);
const actualTeamEffort = id => current ? current.teams?.find(team => team.id === id)?.reasoningEffort || current.settings?.teamEfforts?.[id] || 'auto' : draftTeamEfforts()[id];
const actualJudgeEffort = id => current ? current.judges?.find(judge => judge.id === id)?.reasoningEffort || current.settings?.judgeEfforts?.[id] || 'auto' : draftJudgeEfforts()[id];
const fallbackLengths = { en: { standard: 950, quick: 470 }, zh: { standard: 1800, quick: 950 } };
function syncTargetLength() {
  const language = $('language').value, pace = $('pace').value, input = $('target-length'), chinese = language === 'zh';
  $('target-length-label').textContent = chinese ? 'Target characters per speech' : 'Target words per speech';
  input.min = chinese ? '200' : '100'; input.max = chinese ? '6000' : '3000';
  $('target-length-range').textContent = chinese ? '200–6,000 characters per speech.' : '100–3,000 words per speech.';
  if (!lengthCustomized) input.value = config?.lengthDefaults?.[language]?.[pace] || config?.defaults?.lengthDefaults?.[language]?.[pace] || fallbackLengths[language][pace];
}
function savedTarget(settings) {
  if (!Number.isInteger(settings?.targetLength) || settings.targetLength <= 0) return '';
  const unit = settings.lengthUnit || (settings.language === 'zh' ? 'characters' : 'words');
  return `${settings.targetLength.toLocaleString()} ${unit}`;
}
const actualTeamModel = id => current ? current.teams?.find(t => t.id === id)?.model || current.settings?.teamModels?.[id] : draftTeams()[id];
const actualJudgeModel = id => current ? current.judges?.find(j => j.id === id)?.model || current.settings?.judgeModels?.[id] : draftJudges()[id];
const viewTeams = () => (current?.teams || config?.teams || []).map(team => ({ ...team, model: current ? team.model || actualTeamModel(team.id) : draftTeams()[team.id], reasoningEffort: actualTeamEffort(team.id) }));
const viewJudges = () => (current?.judges || config?.judges || []).map(judge => ({ ...judge, model: current ? judge.model || actualJudgeModel(judge.id) : draftJudges()[judge.id], reasoningEffort: actualJudgeEffort(judge.id) }));
function previewSpeech(speech) {
  const result = { ...speech, model: current ? speech.model || actualTeamModel(speech.teamId) : draftTeams()[speech.teamId], reasoningEffort: current ? speech.reasoningEffort || actualTeamEffort(speech.teamId) : draftTeamEfforts()[speech.teamId], previewStages: [] };
  if (speech.status === 'completed') return result;
  for (const phase of ['opening', 'poi', 'middle', 'closing']) {
    const draft = current?.liveDrafts?.[`${phase}:${speech.id}`];
    if (!draft || (phase === 'poi' ? speech.poi : speech[phase])) continue;
    result.previewStages.push(phase);
    if (phase === 'poi') result.poi = { text: draft.fields.text || '', accepted: null, response: '', offeredByTeamId: 'Opposing team', offeredByRole: 'POI', model: draft.model, reasoningEffort: draft.reasoningEffort };
    else if (phase === 'middle') {
      const response = draft.fields.accepted ? draft.fields.response || '' : '';
      result.middle = [response, draft.fields.text || ''].filter(Boolean).join('\n\n');
      if (result.poi) result.poi = { ...result.poi, accepted: draft.fields.accepted ?? null, response };
    } else result[phase] = draft.fields.text || '';
  }
  if (result.previewStages.length) {
    const spoken = [result.opening, result.middle, result.closing].filter(Boolean).join(' ');
    result.wordCount = spoken.trim().split(/\s+/u).filter(Boolean).length;
    result.characterCount = [...spoken.replace(/\s/gu, '')].length;
  }
  return result;
}
const viewSpeeches = () => (current?.speeches || config?.speakers || []).map(previewSpeech);
const date = value => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
async function api(url, options) {
  const headers = new Headers(options?.headers); headers.set('Authorization', `Bearer ${operatorToken}`);
  const response = await fetch(url, { ...options, headers, credentials: 'omit', cache: 'no-store' });
  const value = await response.json();
  if (response.status === 401) lockBrowser('This server restarted. Open Start Debate.command to unlock this browser again.');
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
  return value;
}
function lockBrowser(message = '') {
  source?.close(); operatorToken = ''; history = [];
  try { sessionStorage.removeItem('chamber-owner-token'); } catch { /* Optional. */ }
  $('owner-panel').hidden = false; $('workspace').hidden = true;
  $('health-button').disabled = true; $('health-label').textContent = 'Browser locked'; notice(message);
}
const post = (url, value = {}) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const requestActive = request => ['waiting', 'retrying'].includes(request.status);
const activityRequests = () => current?.activity?.requests || [];
const phaseName = phase => ({ opening: 'opening', poi: 'opponent POI', middle: 'middle', closing: 'closing', pending: 'next section' })[phase] || phase || 'next section';
const liveSignature = () => [current?.status, current?.error, current?.activity, current?.log?.slice(-4), current?.speeches?.map(speech => [speech.id, speech.status, speech.phase])];
function stageName(stage = '') {
  const [phase, seat] = stage.split(':');
  return ({ motion: 'Chief motion', preparation: `${seat || 'Team'} · private preparation`, opening: `${seat || 'Speech'} · opening`, poi: `${seat || 'Speech'} · opposing POI`, middle: `${seat || 'Speech'} · middle`, closing: `${seat || 'Speech'} · closing`, ballot: `${seat || 'Judge'} · ballot` })[phase] || stage || 'Model request';
}
function duration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function elapsedSince(start, end = Date.now()) {
  const timestamp = Date.parse(start), finish = typeof end === 'number' ? end : Date.parse(end);
  return Number.isFinite(timestamp) && Number.isFinite(finish) ? duration(finish - timestamp) : null;
}
function requestTiming(request) {
  const live = activeStatuses.has(current?.status) && requestActive(request);
  const end = live ? Date.now() : request.endedAt;
  const elapsed = end ? elapsedSince(request.attemptStartedAt || request.startedAt, end) : null;
  const total = end ? elapsedSince(request.startedAt, end) : null;
  const retries = Math.max(0, (request.attempt || 1) - 1);
  const parts = [`Attempt ${request.attempt || 1}${request.maxAttempts ? `/${request.maxAttempts}` : ''}`, `${retries} ${retries === 1 ? 'retry' : 'retries'}`];
  if (elapsed) parts.push(`${elapsed} ${live ? 'elapsed this attempt' : 'this attempt'}`);
  if (total && request.attempt > 1) parts.push(`${total} total`);
  if (request.waitPhase === 'first-text') parts.push(`${duration(request.firstTextTimeoutMs)} allowance for first text`);
  else if (request.timeoutMs) parts.push(`${duration(request.timeoutMs)} ${request.timeoutMode === 'inactivity' ? 'inactivity limit after text begins' : 'timeout per attempt'}`);
  if (request.maxDurationMs) parts.push(`${duration(request.maxDurationMs)} maximum per attempt`);
  if (request.status === 'retrying' && request.nextAttemptAt) parts.push(`Next attempt in ${duration(Math.max(0, Date.parse(request.nextAttemptAt) - Date.now()))}`);
  return parts.join(' · ');
}
function activeSpeech() {
  return current?.speeches?.find(speech => speech.status === 'running') || current?.speeches?.find(speech => speech.status !== 'completed');
}
function speechState(speech) {
  if (speech?.status === 'completed') return 'Complete';
  if (current?.status === 'failed') return 'Paused';
  if (current?.status === 'cancelled') return 'Cancelled';
  if (speech?.previewStages?.length && activeStatuses.has(current?.status)) return `Streaming ${phaseName(speech.phase)}`;
  if (speech?.status === 'running' && activeStatuses.has(current?.status)) return speech.phase === 'poi' ? 'Waiting for POI' : `Generating ${phaseName(speech.phase)}`;
  if (current?.status === 'motion') return 'Waiting for motion';
  if (current?.status === 'preparation') return 'Private preparation';
  const ahead = activeSpeech();
  return ahead && ahead.id !== speech?.id ? `Queued after ${ahead.id}` : 'Queued';
}
function speechExplanation(speech) {
  const phase = phaseName(speech?.phase);
  if (current?.status === 'failed') return `This round is paused after an error. ${speech?.opening ? `Saved text stops during the ${phase} section.` : 'This speech has not started.'} Resume continues from the last saved step.`;
  if (current?.status === 'cancelled') return `This round was cancelled. ${speech?.opening ? 'The text below is a saved partial speech.' : 'This speech has not started.'} Resume continues from saved steps.`;
  if (current?.status === 'motion') return 'Waiting for the chief judge to choose the motion. Speeches begin after all four teams prepare privately.';
  if (current?.status === 'preparation') return 'The four teams are preparing privately. Speeches begin when all preparation is complete.';
  if (speech?.status === 'running' && activeStatuses.has(current?.status)) {
    if (speech.phase === 'poi') return 'An opposing team is generating its Point of Information. The next speech remains queued until this speech’s closing is complete.';
    return speech.previewStages?.length ? 'Live text appears as it arrives. This draft is saved separately until the section finishes.' : `Waiting for ${modelName(speech.model)} to begin the ${phase} section. Text will appear as soon as the API sends it.`;
  }
  const ahead = activeSpeech();
  if (current?.status === 'debating' && ahead && ahead.id !== speech?.id) return `Waiting for ${ahead.id} · ${ahead.name || ahead.role} · ${ahead.teamId} · ${modelName(actualTeamModel(ahead.teamId))} to finish. Speeches follow British Parliamentary order, one speaker at a time. Other teams have already prepared privately.`;
  return 'Eight speakers take the floor in British Parliamentary order. Their speeches and POI exchanges appear here.';
}
function terminalTimestamp() {
  const logs = current?.log || [];
  const terminal = [...logs].reverse().find(entry => /round paused after an error|round cancelled|server stopped|all five.*validated/i.test(entry.message || ''));
  if (terminal?.at) return terminal.at;
  return [...activityRequests()].reverse().find(request => request.endedAt)?.endedAt;
}
function renderRequestTimers() {
  for (const element of document.querySelectorAll('[data-request-timing]')) {
    const request = activityRequests().find(item => item.id === element.dataset.requestTiming);
    if (request) element.textContent = requestTiming(request);
  }
}
function renderActivity() {
  const panel = $('activity-panel'); panel.hidden = !current;
  if (!current) return;
  const stopped = ['failed', 'cancelled'].includes(current.status), requests = activityRequests();
  const active = activeStatuses.has(current.status) ? requests.filter(requestActive) : [];
  panel.className = `panel activity-panel${stopped ? ' stopped' : ''}`;
  $('activity-title').textContent = current.status === 'failed' ? 'Round paused after an error' : current.status === 'cancelled' ? 'Round cancelled' : current.status === 'completed' ? 'Round complete' : 'Generation activity';
  const receiving = active.filter(request => request.status === 'waiting' && request.streaming && request.receivedCharacters > 0);
  $('activity-state').textContent = stopped ? 'STOPPED' : current.status === 'completed' ? 'COMPLETE' : active.some(request => request.status === 'retrying') ? 'RETRYING' : receiving.length ? 'STREAMING' : 'ACTIVE';
  const stoppedAt = stopped ? terminalTimestamp() : null;
  const reason = (current.error?.message || (current.status === 'failed' ? 'A model request failed.' : 'The round was cancelled.')).trim();
  const punctuatedReason = /[.!?。！？]$/.test(reason) ? reason : `${reason}.`;
  $('activity-summary').textContent = stopped ? `${stoppedAt ? `Stopped ${date(stoppedAt)}. ` : ''}${punctuatedReason} Saved speeches remain available. Use Resume round to continue.` : current.status === 'completed' ? 'All eight speeches and five validated ballots are complete.' : receiving.length ? 'Receiving live text from the model gateway. The draft updates as text arrives.' : active.length ? `${active.length} request${active.length === 1 ? '' : 's'} ${active.some(request => request.status === 'retrying') ? 'waiting or retrying' : 'waiting for the first model text'}.` : current.progress?.label || 'Waiting for the next saved step.';
  const speaker = activeSpeech();
  $('queue-summary').textContent = current.status === 'debating' && speaker ? `Current: ${speaker.id} · ${speaker.name || speaker.role} · ${speaker.teamId} · ${modelName(actualTeamModel(speaker.teamId))} · ${phaseName(speaker.phase)}. Later speeches are queued in BP order; they begin after this speaker finishes.` : stopped ? 'Saved partial speeches remain paused until you resume the round.' : 'Speeches run one at a time in British Parliamentary order. Team preparation and the five judge ballots may run concurrently.';
  const shown = active.length ? active : stopped ? requests.slice(-2) : [];
  $('request-list').replaceChildren(...shown.map(request => {
    const row = node('div', 'request-row');
    const state = stopped && requestActive(request) ? 'Stopped' : request.status === 'waiting' && request.streaming && request.receivedCharacters > 0 ? 'Receiving live text' : ({ waiting: 'Waiting for first text', retrying: 'Retrying after an error', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' })[request.status] || request.status;
    row.append(node('p', 'request-heading', `${stageName(request.stage)} · ${state}${request.repair ? ' · JSON repair' : ''}`), node('p', 'request-model', `${modelName(request.model)} · ${effortCaption(request.reasoningEffort)}`));
    const timing = node('p', 'request-timing', requestTiming(request)); timing.dataset.requestTiming = request.id;
    row.append(timing);
    if (request.lastError) row.append(node('p', 'request-error', `Latest request error: ${request.lastError}`));
    return row;
  }));
  if (!requests.length && activeStatuses.has(current.status)) $('request-list').append(node('p', 'activity-legacy', 'This saved round has no request timing records. Its current phase and recorded retry messages are shown; elapsed request time is unavailable.'));
  const entries = [
    ...requests.map(request => ({ at: request.endedAt || request.attemptStartedAt || request.startedAt, text: `${stageName(request.stage)} · ${modelName(request.model)} · ${request.status}${request.repair ? ' · JSON repair' : ''} · attempt ${request.attempt || 1}${request.maxAttempts ? `/${request.maxAttempts}` : ''}${request.lastError ? ` · ${request.lastError}` : ''}` })),
    ...(current.log || []).map(entry => ({ at: entry.at, text: entry.message })),
  ].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).slice(0, 9);
  $('activity-log').replaceChildren(...entries.map(entry => {
    const item = node('li'); if (entry.at) item.append(node('time', '', date(entry.at))); item.append(node('span', '', entry.text)); return item;
  }));
  if (!entries.length) $('activity-log').append(node('li', '', 'No earlier request or retry records were saved.'));
}

function refreshChiefOptions() {
  const chief = $('chief'), selectedChief = chief.value || config?.defaults?.chiefJudgeId || 'J4', assignments = draftJudges();
  chief.replaceChildren(...judgeIds.map(id => { const option = node('option', '', `${id} · ${modelName(assignments[id])}`); option.value = id; return option; }));
  chief.value = judgeIds.includes(selectedChief) ? selectedChief : 'J4';
}
function syncAllEffort() {
  const values = [...Object.values(draftTeamEfforts()), ...Object.values(draftJudgeEfforts())];
  const uniform = values.every(value => value === values[0]);
  const placeholder = node('option', '', uniform ? 'Choose an effort for all seats' : 'Mixed per-seat settings'); placeholder.value = ''; placeholder.disabled = true;
  $('all-effort').replaceChildren(placeholder, ...effortOptions().map(value => { const option = node('option', '', effortName(value)); option.value = value; return option; }));
  $('all-effort').value = uniform ? values[0] : '';
}
function populateModelFields() {
  const selections = { team: draftTeams(), judge: draftJudges() };
  const efforts = { team: draftTeamEfforts(), judge: draftJudgeEfforts() };
  for (const [kind, ids] of [['team', teamIds], ['judge', judgeIds]]) {
    $(`${kind}-models`).replaceChildren(...ids.map(id => {
      const field = node('div', 'model-field'), select = node('select');
      select.id = `${kind}-model-${id}`; select.name = `${kind}Models[${id}]`;
      const label = node('label', '', `${id}${kind === 'team' ? ` · ${config?.teams?.find(t => t.id === id)?.name || 'Team'}` : ' · Judge'}`); label.htmlFor = select.id;
      const value = selections[kind][id];
      const rememberedModels = [...(config?.teams || []), ...(config?.judges || []), ...(current?.teams || []), ...(current?.judges || [])].map(seat => seat.model);
      const choices = [...new Set([...availableModels, ...rememberedModels, value].filter(Boolean))];
      select.replaceChildren(...choices.map(model => { const option = node('option', '', `${modelName(model)}${availableModels.includes(model) ? '' : ' · not currently listed by API'}`); option.value = model; return option; }));
      select.value = value; select.title = value;
      select.addEventListener('change', () => { select.title = select.value; refreshChiefOptions(); render(current); });
      const effortField = node('div', 'effort-field'), effortSelect = node('select', 'effort-select');
      effortSelect.id = `${kind}-effort-${id}`; effortSelect.name = `${kind}Efforts[${id}]`; effortSelect.setAttribute('aria-describedby', 'effort-note');
      const effortLabel = node('label', '', `${id} · Reasoning effort`); effortLabel.htmlFor = effortSelect.id;
      effortSelect.replaceChildren(...effortOptions().map(value => { const option = node('option', '', effortName(value)); option.value = value; return option; }));
      effortSelect.value = efforts[kind][id];
      effortSelect.addEventListener('change', () => { syncAllEffort(); render(current); });
      effortField.append(effortLabel, effortSelect);
      field.append(label, select, effortField); return field;
    }));
  }
  refreshChiefOptions(); syncAllEffort(); controls();
}
async function refreshModels() {
  if (modelsBusy) return;
  modelsBusy = true; $('models-status').textContent = 'Loading debate models…'; controls();
  try {
    const result = await api('/api/models');
    if (!result.ok) throw new Error(result.error || 'The gateway model list is unavailable.');
    availableModels = [...new Set((result.models || []).map(model => typeof model === 'string' ? model : model.id).filter(Boolean))];
    $('models-status').textContent = `${availableModels.length} debate model${availableModels.length === 1 ? '' : 's'} from your API`;
    $('models-status').title = '';
    populateModelFields(); render(current);
  } catch (error) {
    $('models-status').textContent = 'Model list unavailable · retry';
    $('models-status').title = error.message;
    notice(error.message);
  } finally { modelsBusy = false; controls(); }
}

function controls() {
  const running = activeStatuses.has(current?.status);
  const otherRunning = history.some(r => activeStatuses.has(r.status) && r.id !== current?.id);
  $('start-button').disabled = busy || modelsBusy || running || otherRunning || !online;
  $('start-button').firstElementChild.textContent = running || otherRunning ? 'Round in progress' : 'Start debate';
  for (const id of ['language', 'chief', 'pace', 'topic', 'target-length', 'all-effort']) $(id).disabled = busy;
  for (const select of document.querySelectorAll('.model-field select')) select.disabled = busy;
  $('refresh-models').disabled = modelsBusy || busy;
  $('setup-title').textContent = current ? 'Set the next round' : 'Set the chamber';
  $('setup-note').textContent = current ? 'These settings apply to your next round. The viewed round’s actual assignments appear on the right.' : 'Choose each team and judge’s model. You can see every assignment.';
  $('cancel-button').hidden = !running;
  $('resume-button').hidden = !['failed', 'cancelled'].includes(current?.status);
  $('cancel-button').disabled = busy;
  $('resume-button').disabled = busy || otherRunning || !online;
}
function renderTeams() {
  const teams = viewTeams();
  const speakers = viewSpeeches();
  $('teams').replaceChildren(...teams.map(team => {
    const card = node('div', `team${team.bench === 'opposition' ? ' opposition' : ''}`);
    const code = node('div', 'team-code', team.id); code.append(node('span', '', team.bench === 'government' ? '+' : '−'));
    card.append(code, node('h3', 'team-name', team.name));
    const meta = node('div', 'team-meta');
    const model = node('p', 'model-identity', modelName(team.model)); model.title = team.model || 'This saved round did not record a model identity.';
    meta.append(node('p', 'team-roles', speakers.filter(s => s.teamId === team.id).map(s => s.role).join(' · ')), model, node('p', 'effort-identity', effortCaption(team.reasoningEffort)));
    card.append(meta); return card;
  }));
}
function renderSpeakers() {
  const speeches = viewSpeeches();
  const key = JSON.stringify([current?.id, selected, liveSignature(), speeches.map(s => [s.id, s.status, s.model, s.reasoningEffort, s.phase])]);
  if (key === speakerKey) return;
  speakerKey = key;
  $('speaker-list').replaceChildren(...speeches.map(s => {
    const button = node('button', `speaker-button${s.id === selected ? ' selected' : ''}`);
    button.type = 'button'; button.setAttribute('aria-pressed', String(s.id === selected));
    button.setAttribute('aria-label', `${s.index}. ${s.name}, ${s.teamId}, ${modelName(s.model)}, ${effortCaption(s.reasoningEffort)}, ${speechState(s)}`);
    button.title = `${s.teamId} · ${s.model || 'Model not recorded'} · ${effortCaption(s.reasoningEffort)}`;
    const summary = node('span', 'speaker-summary');
    summary.append(node('span', 'speaker-role', s.name), node('span', 'speaker-team', `${s.teamId} · ${modelName(s.model)}`), node('span', `speaker-state${['failed', 'cancelled'].includes(current?.status) && s.status !== 'completed' ? ' stopped' : ''}`, speechState(s)));
    button.append(node('span', 'speaker-number', String(s.index).padStart(2, '0')), summary, node('span', `speech-dot${s.status === 'completed' ? ' complete' : s.status === 'running' && activeStatuses.has(current?.status) ? ' active' : ''}`));
    button.addEventListener('click', () => { selected = s.id; $('follow-live').checked = false; renderSpeakers(); renderSpeech(); });
    return button;
  }));
}
function renderSpeech() {
  const speech = viewSpeeches().find(s => s.id === selected);
  const key = JSON.stringify([current?.id, speech, liveSignature()]);
  if (key === speechKey) return;
  speechKey = key;
  const detail = $('speech-detail'), oldScroll = detail.scrollTop, atBottom = oldScroll + detail.clientHeight >= detail.scrollHeight - 60;
  if (!speech?.opening) {
    const empty = node('div', 'empty-state');
    empty.append(node('span', 'empty-symbol', '“'), node('h3', '', current ? speechState(speech) : 'A case is about to be made.'), node('p', 'empty-model', `${speech?.teamId || ''} · ${modelName(speech?.model)} · ${effortCaption(speech?.reasoningEffort)}`), node('p', '', speechExplanation(speech)));
    detail.replaceChildren(empty); return;
  }
  const header = node('div', 'speech-header'), title = node('div');
  const target = savedTarget(current.settings);
  title.append(node('h3', '', speech.name), node('p', 'speech-byline', `${speech.id} · ${speech.teamId} · ${modelName(speech.model)} · ${effortCaption(speech.reasoningEffort)} · ${current.settings.language === 'zh' ? `${speech.characterCount || 0} characters` : `${speech.wordCount || 0} words`}${target ? ` · target ${target}` : ''}`));
  header.append(title, node('span', `speech-status${['failed', 'cancelled'].includes(current?.status) && speech.status !== 'completed' ? ' stopped' : ''}`, speechState(speech)));
  const children = [header];
  if (speech.previewStages?.length) children.push(node('p', 'streaming-note', `${activeStatuses.has(current?.status) ? 'LIVE DRAFT' : 'SAVED UNFINISHED DRAFT'} · ${speech.previewStages.map(phaseName).join(', ')} · Counts include the draft.`));
  if (speech.status !== 'completed') children.push(node('p', `speech-explanation${['failed', 'cancelled'].includes(current?.status) ? ' stopped' : ''}`, speechExplanation(speech)));
  function section(label, text) { if (!text) return; const block = node('section', 'speech-section'); block.append(node('p', 'speech-section-label', label), node('p', 'speech-text', text)); children.push(block); }
  section('Protected opening · minute 0–1', speech.opening);
  if (speech.poi) {
    const poi = node('section', 'poi'), decision = `${speech.poi.accepted === null ? 'Awaiting decision' : speech.poi.accepted ? 'Accepted' : 'Declined'}${speech.previewStages?.some(phase => ['poi', 'middle'].includes(phase)) ? ' · live draft' : ''}`;
    poi.append(node('p', 'poi-heading', `POINT OF INFORMATION · ${speech.poi.offeredByTeamId} / ${speech.poi.offeredByRole} · ${modelName(speech.poi.model || actualTeamModel(speech.poi.offeredByTeamId))} · ${effortCaption(speech.poi.reasoningEffort || actualTeamEffort(speech.poi.offeredByTeamId))} · ${decision}`), node('p', '', speech.poi.text));
    if (speech.poi.accepted && speech.poi.response) poi.append(node('p', 'poi-response', speech.poi.response));
    children.push(poi);
  }
  let middle = speech.middle || '';
  if (speech.poi?.response && middle.startsWith(speech.poi.response)) middle = middle.slice(speech.poi.response.length).trimStart();
  section('Middle · POI window, minutes 1–6', middle);
  section('Protected closing · minute 6–7', speech.closing);
  if (speech.status !== 'completed') children.push(node('p', 'writing', ['failed', 'cancelled'].includes(current?.status) ? 'Saved partial speech · generation stopped.' : speechState(speech)));
  detail.replaceChildren(...children);
  detail.scrollTop = $('follow-live').checked && atBottom ? detail.scrollHeight : oldScroll;
}
function renderJudges() {
  const judges = viewJudges();
  const ballots = current?.ballots || [];
  const key = JSON.stringify([current?.id, judges, ballots, current?.liveDrafts, liveSignature(), current?.settings.chiefJudgeId || $('chief').value]);
  if (key === judgeKey) return;
  judgeKey = key;
  const open = new Set([...$('judges').querySelectorAll('details[open]')].map(el => el.dataset.judge));
  $('judges').replaceChildren(...judges.map(judge => {
    const ballot = ballots.find(b => b.judgeId === judge.id), card = node('div', 'judge'), top = node('div', 'judge-top');
    top.append(node('span', 'judge-id', judge.id));
    if (judge.id === (current?.settings.chiefJudgeId || $('chief').value)) top.append(node('span', 'chief-badge', 'CHIEF'));
    const model = node('p', 'judge-model', modelName(judge.model)); model.title = judge.model || 'This saved round did not record a model identity.';
    card.append(top, model, node('p', 'judge-effort', effortCaption(judge.reasoningEffort)));
    if (ballot?.status === 'completed') {
      const ranking = node('ol', 'ranking');
      ballot.ranking.forEach((team, i) => { const row = node('li'); row.append(node('span', 'rank-number', String(i + 1)), node('span', '', team)); ranking.append(row); });
      const reasons = node('details'); reasons.dataset.judge = judge.id; reasons.open = open.has(judge.id);
      reasons.append(node('summary', '', 'Read decision'), node('p', '', ballot.reasoning)); card.append(ranking, reasons);
    } else {
      card.append(node('p', 'judge-pending', current?.status === 'failed' ? 'Paused · resume to continue' : current?.status === 'cancelled' ? 'Cancelled · no ballot yet' : ballot?.status === 'running' && activeStatuses.has(current?.status) ? 'Generating ballot…' : 'Waiting for all speeches'));
      const draft = current?.liveDrafts?.[`ballot:${judge.id}`];
      if (draft?.fields.reasoning) {
        const reasons = node('details'); reasons.dataset.judge = judge.id; reasons.open = open.has(judge.id);
        reasons.append(node('summary', '', 'Live decision · unfinished'), node('p', '', draft.fields.reasoning)); card.append(reasons);
      }
    }
    return card;
  }));
  $('ballot-count').textContent = `${ballots.filter(b => b.status === 'completed').length} / 5 ballots`;
}
function renderVerdict() {
  const result = current?.status === 'completed' && current.ballots.filter(b => b.status === 'completed').length === 5 ? current.result : null;
  $('verdict').hidden = !result;
  if (!result) return $('verdict').replaceChildren();
  const winner = viewTeams().find(t => t.id === result.winner), tallies = node('div', 'tallies');
  for (const [id, tally] of Object.entries(result.tallies)) tallies.append(node('span', 'tally', `${id}: ${tally.firstPlaceVotes} vote${tally.firstPlaceVotes === 1 ? '' : 's'} · ${tally.bordaPoints} points`));
  const reasons = node('details'); reasons.append(node('summary', '', 'Chief judge’s ballot'), node('p', '', result.chiefSummary || ''));
  $('verdict').replaceChildren(node('p', 'eyebrow', 'THE VERDICT · FIVE VALIDATED BALLOTS'), node('h3', '', `${result.winner} · ${winner?.name || ''} wins`), node('p', '', `${modelName(winner?.model)} · ${result.tallies[result.winner].firstPlaceVotes} of 5 first-place votes`), tallies, node('p', '', `Decision: ${result.tieBreak.method}.`), reasons);
}
function renderMotionText() {
  const motion = current?.motion || current?.liveDrafts?.motion?.fields;
  $('motion-title').textContent = motion?.text || 'The floor is waiting.';
  $('motion-placeholder').hidden = Boolean(motion?.text);
  $('info-slide').hidden = !motion?.infoSlide; $('info-slide').textContent = motion?.infoSlide || '';
  $('motion-rationale').hidden = !motion?.rationale; $('motion-rationale').querySelector('p').textContent = motion?.rationale || '';
}
function render(run) {
  if (run && current && run.id === current.id) {
    for (const [stage, draft] of Object.entries(current.liveDrafts || {})) {
      const [phase, seat] = stage.split(':');
      const speech = run.speeches?.find(item => item.id === seat), ballot = run.ballots?.find(item => item.judgeId === seat);
      const unfinished = phase === 'motion' ? !run.motion : phase === 'ballot' ? ballot?.status !== 'completed' : speech && !(phase === 'poi' ? speech.poi : speech[phase]);
      if (unfinished && draft.revision > (run.liveDrafts?.[stage]?.revision || 0)) { run.liveDrafts ||= {}; run.liveDrafts[stage] = draft; }
    }
  }
  current = run;
  $('blind-label').textContent = current ? 'VIEWED ROUND · ACTUAL MODELS BELOW · AI PARTICIPANTS RECEIVE NO IDENTITY MAPPING' : 'NEXT ROUND PREVIEW · ALL MODEL ASSIGNMENTS VISIBLE TO YOU · AI PARTICIPANTS BLIND';
  const settings = current?.settings || { chiefJudgeId: $('chief').value, language: $('language').value, pace: $('pace').value, targetLength: Number($('target-length').value) };
  const target = savedTarget(settings);
  $('motion-chief').textContent = `${current ? 'Viewed round' : 'Next round'} · Chief: ${settings.chiefJudgeId} · ${modelName(actualJudgeModel(settings.chiefJudgeId))} · ${effortCaption(actualJudgeEffort(settings.chiefJudgeId))} · ${settings.language === 'zh' ? '中文' : 'English'} · ${settings.pace === 'quick' ? 'Quick' : 'Standard'}${target ? ` · target ${target} per speech` : ''}`;
  if ($('follow-live').checked && current) selected = current.speeches.find(s => s.status === 'running')?.id || current.speeches.filter(s => s.status === 'completed').at(-1)?.id || 'S1';
  renderMotionText();
  $('run-status').textContent = ({ motion: 'Setting the motion', preparation: 'Private preparation', debating: 'Generating debate', judging: 'Generating ballots', completed: 'Round complete', failed: 'Paused · generation stopped', cancelled: 'Cancelled · generation stopped' })[current?.status] || 'Ready to begin';
  const runningSpeech = activeSpeech();
  const liveLabel = current?.status === 'debating' && runningSpeech ? `${runningSpeech.id} · ${runningSpeech.teamId} · ${phaseName(runningSpeech.phase)}` : current?.progress?.label;
  $('progress-label').textContent = ['failed', 'cancelled'].includes(current?.status) ? `${current.status === 'failed' ? 'Paused' : 'Cancelled'} at ${current.progress?.label || 'the last saved step'}` : liveLabel || 'Eight speeches. Five ballots. A reasoned verdict.';
  const finished = current?.speeches.filter(s => s.status === 'completed').length || 0;
  $('progress-count').textContent = `${finished} / 8 speeches`;
  $('progress-fill').style.width = `${current ? Math.min(100, current.progress.completed / current.progress.total * 100) : 0}%`;
  for (const [id, format] of [['export-md', 'md'], ['export-json', 'json']]) { $(id).hidden = !current; $(id).href = current ? `/api/runs/${current.id}/export?format=${format}` : '#'; }
  $('run-meta').textContent = current ? `${date(current.createdAt)} · ${current.settings.pace} · ${current.usage.totalTokens.toLocaleString()} tokens · saved locally` : 'Your debate stays on this computer.';
  if (current?.error) notice(`${current.status === 'failed' ? 'Round paused' : current.status === 'cancelled' ? 'Round cancelled' : 'Round error'}: ${current.error.message}`);
  renderActivity(); renderTeams(); renderSpeakers(); renderSpeech(); renderJudges(); renderVerdict(); controls();
  if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) refreshHistory();
}
async function selectRun(run) {
  source?.close(); selected = 'S1'; speechKey = ''; speakerKey = ''; judgeKey = ''; notice(); render(run);
  try { localStorage.setItem('chamber-round', run.id); } catch { /* Browser storage is optional. */ }
  const state = event => {
    try {
      const snapshot = JSON.parse(event.data);
      if (!current || current.id !== run.id || snapshot.id !== run.id) return;
      if (Date.parse(snapshot.updatedAt) < Date.parse(current.updatedAt)) return;
      render(snapshot);
    } catch { notice('A live update could not be displayed. Refresh the round to reconnect.'); }
  };
  const delta = event => {
    try {
      const packet = JSON.parse(event.data);
      if (!current || packet.runId !== current.id) return;
      current.liveDrafts ||= {};
      if ((current.liveDrafts[packet.stage]?.revision || 0) >= packet.draft.revision) return;
      current.liveDrafts[packet.stage] = packet.draft;
      const request = current.activity?.requests?.find(item => item.id === packet.request?.id);
      if (request) Object.assign(request, packet.request);
      if (streamFrame === null) streamFrame = requestAnimationFrame(() => {
        streamFrame = null;
        if (!current) return;
        renderMotionText(); renderSpeech(); renderSpeakers();
        if (current.status === 'judging') renderJudges();
      });
    } catch { notice('A streaming update could not be displayed. Reconnect to recover the saved draft.'); }
  };
  source = connectLiveEvents(`/api/runs/${run.id}/events`, {
    headers: { Authorization: `Bearer ${operatorToken}` },
    onEvent: (name, event) => { if (name === 'state') state(event); if (name === 'delta') delta(event); },
    onError: () => { if (activeStatuses.has(current?.status)) $('progress-label').textContent = 'Reconnecting live updates…'; },
    onUnauthorized: () => lockBrowser('This server restarted. Open Start Debate.command to unlock this browser again.'),
  });
}
async function refreshHistory() {
  if (historyBusy) return;
  historyBusy = true;
  try {
    history = await api('/api/runs');
    $('history').replaceChildren(...history.slice(0, 8).map(run => {
      const button = node('button', `history-item${run.id === current?.id ? ' selected' : ''}`); button.type = 'button';
      button.append(node('span', 'history-motion', run.motion?.text || 'Chief is choosing a motion…'), node('span', 'history-date', `${date(run.createdAt)} · ${run.status}`));
      button.addEventListener('click', async () => { try { await selectRun(await api(`/api/runs/${run.id}`)); } catch (error) { notice(error.message); } }); return button;
    }));
    if (!history.length) $('history').append(node('p', 'empty-small', 'Your rounds will appear here. Saved rounds survive a refresh.'));
    controls();
  } catch (error) { notice(error.message); }
  finally { historyBusy = false; }
}
async function health() {
  $('health-label').textContent = 'Checking connection';
  try { const result = await api('/api/health'); online = result.ok; $('health-label').textContent = online ? 'Model gateway connected' : 'Model service unavailable'; $('health-button').className = `health ${online ? 'ok' : 'error'}`; $('health-button').title = result.error || config?.baseUrl || ''; if (!online) notice(result.error || 'Check the local model gateway.'); }
  catch (error) { online = false; $('health-label').textContent = 'Connection unavailable'; $('health-button').className = 'health error'; notice(error.message); }
  controls();
}
$('setup-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !$('setup-form').reportValidity()) return; busy = true; notice(); controls();
  try { const value = await post('/api/runs', { language: $('language').value, chiefJudgeId: $('chief').value, pace: $('pace').value, topicHint: $('topic').value, teamModels: draftTeams(), judgeModels: draftJudges(), teamEfforts: draftTeamEfforts(), judgeEfforts: draftJudgeEfforts(), targetLength: Number($('target-length').value) }); $('follow-live').checked = true; await selectRun(value.run); await refreshHistory(); }
  catch (error) { notice(error.message); await refreshHistory(); }
  finally { busy = false; controls(); }
});
for (const action of ['cancel', 'resume']) $(`${action}-button`).addEventListener('click', async () => {
  if (!current || busy) return; busy = true; notice(); controls();
  try { const value = await post(`/api/runs/${current.id}/${action}`); render(value.run); await refreshHistory(); }
  catch (error) { notice(error.message); }
  finally { busy = false; controls(); }
});
$('health-button').addEventListener('click', health);
$('refresh-history').addEventListener('click', refreshHistory);
$('refresh-models').addEventListener('click', refreshModels);
$('all-effort').addEventListener('change', () => {
  const value = $('all-effort').value;
  if (!effortOptions().includes(value)) return;
  for (const [kind, ids] of [['team', teamIds], ['judge', judgeIds]]) for (const id of ids) $(`${kind}-effort-${id}`).value = value;
  syncAllEffort(); render(current);
});
$('chief').addEventListener('change', () => render(current));
for (const id of ['language', 'pace']) $(id).addEventListener('change', () => { syncTargetLength(); render(current); });
$('target-length').addEventListener('input', () => { lengthCustomized = true; render(current); });
$('follow-live').addEventListener('change', () => render(current));
window.addEventListener('pagehide', () => source?.close());
setInterval(() => { if (activeStatuses.has(current?.status)) renderRequestTimers(); }, 1000);
setInterval(() => { if (history.some(run => activeStatuses.has(run.status))) refreshHistory(); }, 20000);
async function initialize() {
  if (!operatorToken) { lockBrowser(); return; }
  try {
    config = await api('/api/config');
    availableModels = [...new Set((config.models || ['gpt-6.1-sol', 'gpt-6-astra']).map(model => typeof model === 'string' ? model : model.id).filter(Boolean))];
    for (const id of ['language', 'chief', 'pace']) if (config.defaults?.[id === 'chief' ? 'chiefJudgeId' : id]) $(id).value = config.defaults[id === 'chief' ? 'chiefJudgeId' : id];
    syncTargetLength(); populateModelFields(); render(null);
    await Promise.all([health(), refreshHistory(), refreshModels()]);
    if (!operatorToken) return;
    let saved; try { saved = localStorage.getItem('chamber-round'); } catch { /* Optional. */ }
    const latest = history.find(r => activeStatuses.has(r.status)) || history.find(r => r.id === saved) || history[0];
    if (latest) await selectRun(await api(`/api/runs/${latest.id}`));
    $('owner-panel').hidden = true; $('workspace').hidden = false; $('health-button').disabled = false;
  } catch (error) { notice(error.message); controls(); }
}
$('owner-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!$('owner-form').reportValidity()) return;
  operatorToken = $('owner-code').value; $('owner-code').value = '';
  try { await post('/api/session', { operatorToken }); try { sessionStorage.setItem('chamber-owner-token', operatorToken); } catch { /* Optional. */ } notice(); await initialize(); }
  catch (error) { lockBrowser(error.message); }
});
for (const [id, format] of [['export-md', 'md'], ['export-json', 'json']]) $(id).addEventListener('click', async event => {
  event.preventDefault(); if (!current) return;
  const runId = current.id;
  try {
    const response = await fetch(`/api/runs/${runId}/export?format=${format}`, { headers: { Authorization: `Bearer ${operatorToken}` }, credentials: 'omit', cache: 'no-store' });
    if (response.status === 401) { lockBrowser('Open Start Debate.command to unlock this browser again.'); return; }
    if (!response.ok) throw new Error('The transcript could not be exported.');
    const url = URL.createObjectURL(await response.blob()), link = node('a');
    link.href = url; link.download = `debate-${runId}.${format}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { notice(error.message); }
});
initialize();
