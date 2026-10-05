// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
export const TEAMS = Object.freeze([
  { id: 'OG', name: 'Opening Government', bench: 'government', position: 'opening', model: 'gpt-6.1-sol' },
  { id: 'OO', name: 'Opening Opposition', bench: 'opposition', position: 'opening', model: 'gpt-6-astra' },
  { id: 'CG', name: 'Closing Government', bench: 'government', position: 'closing', model: 'gpt-6-astra' },
  { id: 'CO', name: 'Closing Opposition', bench: 'opposition', position: 'closing', model: 'gpt-6.1-sol' },
]);
export const SPEAKERS = Object.freeze([
  { id: 'S1', index: 1, teamId: 'OG', role: 'PM', name: 'Prime Minister' },
  { id: 'S2', index: 2, teamId: 'OO', role: 'LO', name: 'Leader of Opposition' },
  { id: 'S3', index: 3, teamId: 'OG', role: 'DPM', name: 'Deputy Prime Minister' },
  { id: 'S4', index: 4, teamId: 'OO', role: 'DLO', name: 'Deputy Leader of Opposition' },
  { id: 'S5', index: 5, teamId: 'CG', role: 'MG', name: 'Member of Government' },
  { id: 'S6', index: 6, teamId: 'CO', role: 'MO', name: 'Member of Opposition' },
  { id: 'S7', index: 7, teamId: 'CG', role: 'GW', name: 'Government Whip' },
  { id: 'S8', index: 8, teamId: 'CO', role: 'OW', name: 'Opposition Whip' },
].map(s => ({ ...s, model: TEAMS.find(t => t.id === s.teamId).model })));
export const JUDGES = Object.freeze([
  { id: 'J1', name: 'Judge 1', model: 'gpt-6.1-sol' },
  { id: 'J2', name: 'Judge 2', model: 'gpt-6.1-sol' },
  { id: 'J3', name: 'Judge 3', model: 'gpt-6.1-sol' },
  { id: 'J4', name: 'Judge 4', model: 'gpt-6-astra' },
  { id: 'J5', name: 'Judge 5', model: 'gpt-6-astra' },
]);
export const LENGTH_DEFAULTS = Object.freeze({ en: Object.freeze({ standard: 950, quick: 470 }), zh: Object.freeze({ standard: 1800, quick: 950 }) });
export const REASONING_EFFORTS = Object.freeze(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const DEFAULTS = Object.freeze({ language: 'en', chiefJudgeId: 'J4', pace: 'standard', targetLength: LENGTH_DEFAULTS.en.standard, teamModels: Object.freeze(Object.fromEntries(TEAMS.map(t => [t.id, t.model]))), judgeModels: Object.freeze(Object.fromEntries(JUDGES.map(j => [j.id, j.model]))), teamEfforts: Object.freeze(Object.fromEntries(TEAMS.map(t => [t.id, 'auto']))), judgeEfforts: Object.freeze(Object.fromEntries(JUDGES.map(j => [j.id, 'auto']))) });
export const MODELS = Object.freeze(['gpt-6.1-sol', 'gpt-6-astra']);
export const TEAM_IDS = Object.freeze(TEAMS.map(t => t.id));

// Identity labels are removed from all debate content, including adversarial hints
// and historical generated text. Routing fields are handled separately.
const PROVIDER_LABELS = ['OpenAI', 'ChatGPT', 'GPT', 'Anthropic', 'Google', 'Gemini', 'Claude', 'DeepSeek', 'Qwen', 'Llama', 'Mistral', 'Meta', 'xAI', 'Grok', 'Alibaba'];
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function identityNamesForRun(run) {
  return [...new Set([...MODELS, ...(run?._private?.identityNames || []), ...(run?.teams || []).map(t => t.model), ...(run?.judges || []).map(j => j.model)].filter(name => typeof name === 'string' && name.trim()))];
}

export function maskIdentities(text, modelNames = MODELS) {
  if (typeof text !== 'string') return text;
  let result = text;
  const aliases = new Set([...MODELS, ...modelNames, ...PROVIDER_LABELS]);
  for (const name of modelNames) {
    if (typeof name !== 'string') continue;
    // Gateways commonly qualify IDs as provider/model. Include both forms.
    const parts = name.split('/');
    if (parts.length > 1) for (const part of parts) if (part.length > 2) aliases.add(part);
  }
  for (const name of [...aliases].filter(name => typeof name === 'string' && name.trim()).sort((a, b) => b.length - a.length)) {
    const tokens = name.trim().split(/[-_\u2010-\u2015./:\s]+/u).filter(Boolean);
    const pattern = tokens.map(escaped).join('[-_\\u2010-\\u2015./:\\s]*');
    if (!pattern) continue;
    result = result.replace(new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, 'gi'), '[participant identity sealed]');
  }
  return result
    .replace(/\bgpt\s*[-_\u2010-\u2015 ]?\s*6\s*(?:\.\s*1)?\s*[-_\u2010-\u2015 ]?\s*(?:sol|astra)\b/gi, '[participant identity sealed]')
    .replace(/\b(?:gpt\s*[-_\u2010-\u2015 ]?\s*6\s*(?:\.\s*1)?|sol|astra)\b/gi, '[participant identity sealed]')
    .replace(/\b(?:J[1-5]|Judge\s*[1-5])\b/gi, '[adjudicator identity sealed]')
    .replace(/裁判\s*[1-5]/g, '[adjudicator identity sealed]');
}

export function maskContent(value, modelNames = MODELS) {
  if (typeof value === 'string') return maskIdentities(value, modelNames);
  if (Array.isArray(value)) return value.map(item => maskContent(item, modelNames));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskContent(item, modelNames)]));
  return value;
}

export function requireText(value, label, maxLength = 50000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`Invalid ${label}: expected nonempty text (at most ${maxLength} characters).`);
  return value.trim();
}

export function validateMotion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Motion must be an object.');
  return { text: requireText(value.text, 'motion text', 1500), infoSlide: typeof value.infoSlide === 'string' ? value.infoSlide.trim().slice(0, 5000) : '', rationale: requireText(value.rationale, 'motion rationale', 3000) };
}

export function validateBallot(value, judgeId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ballot must be an object.');
  if (!Array.isArray(value.ranking) || value.ranking.length !== 4 || new Set(value.ranking).size !== 4 || value.ranking.some(t => !TEAM_IDS.includes(t))) throw new Error('Ballot ranking must contain OG, OO, CG and CO exactly once.');
  if (value.winner !== undefined && value.winner !== value.ranking[0]) throw new Error('Ballot winner does not match first-ranked team.');
  const reasoning = requireText(value.reasoning, 'ballot reasoning', 16000);
  if (!/\bS[1-8]\b/.test(reasoning)) throw new Error('Ballot reasoning must cite speech IDs S1-S8.');
  if (/\bS(?:0|9|\d{2,})\b/.test(reasoning)) throw new Error('Ballot reasoning refers to a nonexistent speech.');
  let comparisons;
  if (value.comparisons !== undefined) {
    if (!Array.isArray(value.comparisons) || value.comparisons.length > 8) throw new Error('Ballot comparisons must be an array.');
    comparisons = value.comparisons.map((c, i) => {
      if (typeof c === 'string') return requireText(c, `comparison ${i + 1}`, 4000);
      if (!c || typeof c !== 'object') throw new Error('Invalid ballot comparison.');
      const higher = requireText(c.higher, 'higher team', 10), lower = requireText(c.lower, 'lower team', 10);
      if (!TEAM_IDS.includes(higher) || !TEAM_IDS.includes(lower) || value.ranking.indexOf(higher) >= value.ranking.indexOf(lower)) throw new Error('Ballot comparison must compare configured teams in ranking order.');
      return { higher, lower, reason: requireText(c.reason, 'comparison reason', 4000) };
    });
  }
  return { ...(judgeId ? { judgeId } : {}), ranking: [...value.ranking], reasoning, ...(comparisons ? { comparisons } : {}), winner: value.ranking[0] };
}

// This mechanical policy is an explicit app adaptation of BP adjudication.
export function tallyBallots(ballots, chiefJudgeId, panel = JUDGES) {
  if (!Array.isArray(ballots) || ballots.length !== JUDGES.length) throw new Error('All five valid judge ballots are required before announcing a winner.');
  if (!Array.isArray(panel) || panel.length !== 5 || new Set(panel.map(j => j.id)).size !== 5 || panel.some(j => !JUDGES.some(base => base.id === j.id) || typeof j.model !== 'string' || !j.model.trim())) throw new Error('The per-round panel must contain five distinct configured judges with valid model IDs.');
  const expected = new Set(panel.map(j => j.id));
  for (const ballot of ballots) {
    if (!expected.delete(ballot.judgeId)) throw new Error('Ballots must belong to five distinct configured judges.');
    if (ballot.status && ballot.status !== 'completed') throw new Error('All ballots must be completed.');
    const judge = panel.find(j => j.id === ballot.judgeId);
    if (typeof ballot.model !== 'string' || ballot.model !== judge.model) throw new Error('Ballot model does not match configured judge.');
    validateBallot(ballot, ballot.judgeId);
  }
  if (expected.size) throw new Error('Missing judge ballots.');
  const chief = ballots.find(b => b.judgeId === chiefJudgeId);
  if (!chief) throw new Error('Chief judge must have a valid ballot.');
  const tallies = Object.fromEntries(TEAM_IDS.map(t => [t, { firstPlaceVotes: 0, bordaPoints: 0 }]));
  for (const b of ballots) b.ranking.forEach((t, i) => { tallies[t].bordaPoints += 3 - i; if (i === 0) tallies[t].firstPlaceVotes++; });
  const ranking = [...TEAM_IDS].sort((a, b) => tallies[b].firstPlaceVotes - tallies[a].firstPlaceVotes || tallies[b].bordaPoints - tallies[a].bordaPoints || chief.ranking.indexOf(a) - chief.ranking.indexOf(b));
  const maxVotes = Math.max(...TEAM_IDS.map(t => tallies[t].firstPlaceVotes));
  const firstPlaceTied = TEAM_IDS.filter(t => tallies[t].firstPlaceVotes === maxVotes);
  const maxBorda = Math.max(...firstPlaceTied.map(t => tallies[t].bordaPoints));
  const bordaTied = firstPlaceTied.filter(t => tallies[t].bordaPoints === maxBorda);
  const method = firstPlaceTied.length === 1 ? 'first-place votes' : bordaTied.length === 1 ? 'Borda points among teams tied on first-place votes' : 'chief judge ranking among teams still tied';
  return {
    winner: ranking[0], ranking, tallies,
    tieBreak: { policy: 'Custom rule: first-place plurality, then Borda 3/2/1/0 among tied teams, then the chief judge’s existing ranking among remaining tied teams.', method, firstPlaceTied, bordaTied, chiefJudgeId },
    chiefSummary: chief.reasoning,
  };
}

export function normalizeSettings(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Settings must be an object.');
  const value = { ...DEFAULTS, ...settings };
  if (!['en', 'zh'].includes(value.language)) throw new Error('Language must be en or zh.');
  if (!['standard', 'quick'].includes(value.pace)) throw new Error('Pace must be standard or quick.');
  if (!JUDGES.some(j => j.id === value.chiefJudgeId)) throw new Error('Unknown chief judge.');
  if (value.topicHint !== undefined && (typeof value.topicHint !== 'string' || value.topicHint.length > 1000)) throw new Error('Topic hint must be text of at most 1000 characters.');
  const targetLength = settings.targetLength === undefined ? LENGTH_DEFAULTS[value.language][value.pace] : settings.targetLength;
  const [minLength, maxLength] = value.language === 'zh' ? [200, 6000] : [100, 3000];
  if (!Number.isInteger(targetLength) || targetLength < minLength || targetLength > maxLength) throw new Error(`targetLength must be an integer from ${minLength} to ${maxLength} for ${value.language === 'zh' ? 'Chinese characters' : 'English words'}.`);
  const lengthUnit = value.language === 'zh' ? 'characters' : 'words';
  const teamModels = validateModelSelections(value.teamModels, TEAM_IDS, 'teamModels');
  const judgeModels = validateModelSelections(value.judgeModels, JUDGES.map(j => j.id), 'judgeModels');
  const teamEfforts = validateEffortSelections(value.teamEfforts, TEAM_IDS, 'teamEfforts');
  const judgeEfforts = validateEffortSelections(value.judgeEfforts, JUDGES.map(j => j.id), 'judgeEfforts');
  return { language: value.language, chiefJudgeId: value.chiefJudgeId, pace: value.pace, targetLength, lengthUnit, teamModels, judgeModels, teamEfforts, judgeEfforts, topicHint: maskIdentities((value.topicHint || '').trim(), [...Object.values(teamModels), ...Object.values(judgeModels)]), timing: 'Accelerated text simulation: each speech has a protected opening minute, five-minute POI window and protected final minute.', scriptLength: `Target: approximately ${targetLength} ${value.language === 'zh' ? 'non-whitespace Chinese characters' : 'English words'} per speech, including an accepted POI response and excluding the opposing POI question. Actual output length is reported for each speech.` };
}

export function validateModelSelections(value, seatIds, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== seatIds.length || Object.keys(value).some(id => !seatIds.includes(id)) || seatIds.some(id => typeof value[id] !== 'string' || !value[id].trim() || value[id].length > 256)) throw new Error(`${label} must map exactly ${seatIds.join(', ')} to nonempty model IDs.`);
  return Object.fromEntries(seatIds.map(id => [id, value[id].trim()]));
}

export function validateEffortSelections(value, seatIds, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== seatIds.length || Object.keys(value).some(id => !seatIds.includes(id)) || seatIds.some(id => !REASONING_EFFORTS.includes(value[id]))) throw new Error(`${label} must map exactly ${seatIds.join(', ')} to a supported reasoning effort: ${REASONING_EFFORTS.join(', ')}.`);
  return Object.fromEntries(seatIds.map(id => [id, value[id]]));
}

export function publicTranscript(run) {
  return maskContent(run.speeches.filter(s => s.status === 'completed').map(s => ({ speechId: s.id, teamId: s.teamId, role: s.role, opening: s.opening, middle: s.middle, closing: s.closing, poi: s.poi ? { offeredByTeamId: s.poi.offeredByTeamId, offeredByRole: s.poi.offeredByRole, text: s.poi.text, accepted: s.poi.accepted, response: s.poi.response, window: s.poi.window } : null })), identityNamesForRun(run));
}

export function publicRun(run) {
  if (!run) return null;
  const { _private, ...value } = run;
  const copy = structuredClone(value);
  const names = identityNamesForRun(run);
  const mask = text => maskIdentities(text, names);
  let validResult = false;
  if (run.status === 'completed' && run.result && Array.isArray(run.ballots) && run.ballots.length === 5 && run.ballots.every(ballot => ballot.status === 'completed' && typeof ballot.model === 'string')) {
    try { validResult = tallyBallots(run.ballots, run.settings.chiefJudgeId, run.judges).winner === run.result.winner; } catch { /* Invalid completion cannot publish a winner. */ }
  }
  copy.anonymity = { mode: 'double-blind', identitiesVisibleToUser: true, participantsBlinded: true, identitiesRevealed: true };
  if (!validResult) copy.result = null;
  for (const team of copy.teams || []) team.reasoningEffort ??= copy.settings?.teamEfforts?.[team.id] || 'auto';
  for (const judge of copy.judges || []) judge.reasoningEffort ??= copy.settings?.judgeEfforts?.[judge.id] || 'auto';
  for (const speech of copy.speeches || []) {
    speech.reasoningEffort ??= copy.settings?.teamEfforts?.[speech.teamId] || 'auto';
    for (const key of ['opening', 'middle', 'closing', 'text']) speech[key] = mask(speech[key]);
    if (speech.poi) { speech.poi.reasoningEffort ??= copy.settings?.teamEfforts?.[speech.poi.offeredByTeamId] || 'auto'; speech.poi.text = mask(speech.poi.text); speech.poi.response = mask(speech.poi.response); }
  }
  for (const ballot of copy.ballots || []) {
    ballot.reasoningEffort ??= copy.settings?.judgeEfforts?.[ballot.judgeId] || 'auto';
    ballot.reasoning = mask(ballot.reasoning);
    if (ballot.comparisons) ballot.comparisons = maskContent(ballot.comparisons, names);
  }
  if (copy.motion) copy.motion = maskContent(copy.motion, names);
  if (copy.liveDrafts) {
    for (const [stage, draft] of Object.entries(copy.liveDrafts)) {
      if (!/^(?:motion|opening:S[1-8]|poi:S[1-8]|middle:S[1-8]|closing:S[1-8]|ballot:J[1-5])$/.test(stage)) delete copy.liveDrafts[stage];
      else draft.fields = maskContent(draft.fields, names);
    }
  }
  if (copy.settings) { copy.settings.topicHint = mask(copy.settings.topicHint); copy.settings.teamModels = Object.fromEntries((copy.teams || []).map(t => [t.id, t.model])); copy.settings.judgeModels = Object.fromEntries((copy.judges || []).map(j => [j.id, j.model])); copy.settings.teamEfforts = Object.fromEntries((copy.teams || []).map(t => [t.id, t.reasoningEffort])); copy.settings.judgeEfforts = Object.fromEntries((copy.judges || []).map(j => [j.id, j.reasoningEffort])); }
  if (copy.error) copy.error.message = mask(copy.error.message);
  if (copy.log) copy.log = copy.log.map(entry => ({ ...entry, message: mask(entry.message) }));
  if (copy.result?.chiefSummary) copy.result.chiefSummary = mask(copy.result.chiefSummary);
  return copy;
}
