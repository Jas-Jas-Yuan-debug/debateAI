// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import { randomUUID } from 'node:crypto';
import { REASONING_EFFORTS } from './debate.mjs';
import { readChatStream } from './streaming.mjs';
import { gatewayFetch } from './http-transport.mjs';

export class UpstreamError extends Error {
  constructor(message, status, transient = false) { super(message); this.name = 'UpstreamError'; this.status = status; this.transient = transient; }
}

export class RequestTimeoutError extends Error {
  constructor(kind, milliseconds) {
    const duration = milliseconds >= 60000 ? `${Math.ceil(milliseconds / 60000)} minutes` : `${milliseconds} milliseconds`;
    const reason = {
      'first-text': `The gateway sent no answer text within ${duration}.`,
      'stream-idle': `The stream sent no more data for ${duration} after text began.`,
      overall: `The request exceeded its ${duration} maximum duration.`,
      response: `The gateway did not respond within ${duration}.`,
    }[kind];
    super(`${reason} The unfinished step is saved; no automatic replay was started.`);
    this.name = 'TimeoutError'; this.timeoutKind = kind;
  }
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  const timeout = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timeout); signal?.removeEventListener('abort', abort); reject(signal.reason || new DOMException('Aborted', 'AbortError')); }
  signal?.addEventListener('abort', abort, { once: true });
});

export function parseJSON(raw) {
  if (typeof raw !== 'string') throw new Error('Model returned no text.');
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); } catch {
    const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error('Model response is not valid JSON.');
  }
}

export class ModelClient {
  constructor({ baseUrl, apiKey, fetchImpl = gatewayFetch, timeoutMs = 300000, firstTextTimeoutMs = 1800000, maxDurationMs = 2700000, retryDelayMs = 30000, maxAttempts = 3, onUsage = () => {}, onRetry = () => {}, onRequestState = () => {}, onDelta = () => {}, sanitizeText = value => value }) {
    this.baseUrl = baseUrl.replace(/\/+$/, ''); this.apiKey = apiKey; this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs; this.firstTextTimeoutMs = firstTextTimeoutMs; this.maxDurationMs = maxDurationMs;
    this.retryDelayMs = retryDelayMs; this.onUsage = onUsage; this.onRetry = onRetry;
    this.maxAttempts = Math.max(1, Math.min(3, maxAttempts));
    this.sanitizeText = sanitizeText;
    this.onRequestState = onRequestState;
    this.onDelta = onDelta;
  }
  async models(signal) {
    const result = await this.request('/models', { method: 'GET' }, signal);
    if (!Array.isArray(result.data)) throw new Error('Invalid models response.');
    return result.data.map(m => m.id).filter(id => typeof id === 'string');
  }
  async request(path, options, signal, activity = null) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    if (!this.apiKey) throw new Error('API key is not configured. Set API_KEY in .env.');
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      let firstTimer, idleTimer, maximumTimer, receivedText = false;
      const deadlineController = new AbortController();
      const timer = (kind, milliseconds) => {
        const handle = setTimeout(() => deadlineController.abort(new RequestTimeoutError(kind, milliseconds)), milliseconds);
        handle.unref?.(); return handle;
      };
      const clearTimers = () => { clearTimeout(firstTimer); clearTimeout(idleTimer); clearTimeout(maximumTimer); };
      const touch = () => {
        // Transport silence before first text is normal for a buffering gateway or a reasoning model.
        if (!receivedText) return;
        clearTimeout(idleTimer); idleTimer = timer('stream-idle', this.timeoutMs);
      };
      const firstText = async () => {
        if (receivedText) return;
        receivedText = true; clearTimeout(firstTimer); touch();
        if (activity) {
          Object.assign(activity, { firstTextAt: new Date().toISOString(), waitPhase: 'streaming', timeoutMode: 'inactivity' });
          await this.onRequestState({ ...activity });
        }
      };
      try {
        if (activity) {
          Object.assign(activity, { status: 'waiting', attempt: attempt + 1, attemptStartedAt: new Date().toISOString(), receivedCharacters: 0, lastTokenAt: null, firstTextAt: null, nextAttemptAt: null, waitPhase: 'first-text', timeoutMode: 'first-text', timeoutKind: null, streaming: false });
          await this.onRequestState({ ...activity });
        }
        if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        firstTimer = timer(activity ? 'first-text' : 'response', activity ? this.firstTextTimeoutMs : this.timeoutMs);
        if (activity) maximumTimer = timer('overall', this.maxDurationMs);
        const mergedSignal = AbortSignal.any([deadlineController.signal, ...(signal ? [signal] : [])]);
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...options, headers: { 'Authorization': `Bearer ${this.apiKey}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, signal: mergedSignal });
        if (!response.ok) {
          const error = new UpstreamError(`Model service returned HTTP ${response.status}.`, response.status, [408, 429, 500, 502, 503, 504].includes(response.status));
          const retryAfter = response.headers?.get('retry-after');
          const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
          const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          if (delay > 0) error.retryAfterMs = Math.min(delay, 300000);
          await response.body?.cancel().catch(() => {});
          throw error;
        }
        const streaming = activity && /text\/event-stream/i.test(response.headers?.get('content-type') || '');
        if (activity) { activity.streaming = Boolean(streaming); await this.onRequestState({ ...activity }); }
        const result = streaming ? await readChatStream(response, { signal: mergedSignal, touch, onDelta: async chunk => {
          await firstText();
          Object.assign(activity, { lastTokenAt: new Date().toISOString(), receivedCharacters: chunk.content.length });
          await this.onDelta({ ...chunk, request: { ...activity } });
        } }) : await response.json();
        if (mergedSignal.aborted) throw mergedSignal.reason;
        if (!streaming && typeof result?.choices?.[0]?.message?.content === 'string' && result.choices[0].message.content.length) await firstText();
        if (!result || typeof result !== 'object') throw new Error('Model service returned an invalid JSON response.');
        return result;
      } catch (error) {
        clearTimers();
        if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        if (deadlineController.signal.aborted) error = deadlineController.signal.reason;
        if (error.name === 'TimeoutError') { if (activity) activity.timeoutKind = error.timeoutKind || 'overall'; throw error; }
        const transient = error.transient || error.name === 'AbortError' || error instanceof TypeError;
        if (!transient || attempt === this.maxAttempts - 1) throw error;
        const retryMs = Math.max(this.retryDelayMs * 2 ** attempt, error.retryAfterMs || 0);
        if (activity) {
          Object.assign(activity, { status: 'retrying', lastError: error.message, nextAttemptAt: new Date(Date.now() + retryMs).toISOString() });
          await this.onRequestState({ ...activity });
        }
        await this.onRetry(`Model request retry ${attempt + 1}/${this.maxAttempts - 1}: ${error.message}`);
        await wait(retryMs, signal);
      } finally {
        clearTimers();
      }
    }
  }
  async complete(model, messages, { signal, maxTokens = 4096, reasoningEffort = 'auto', requestContext = {} } = {}) {
    if (typeof model !== 'string' || !model.trim() || model.length > 256) throw new Error('Model ID must be a nonempty string.');
    if (!REASONING_EFFORTS.includes(reasoningEffort)) throw new Error('Unsupported reasoning effort.');
    const safeMessages = messages.map(message => ({ ...message, content: this.sanitizeText(message.content) }));
    const activity = { id: randomUUID(), stage: requestContext.stage || 'completion', model, reasoningEffort, status: 'waiting', startedAt: new Date().toISOString(), attemptStartedAt: null, attempt: 0, maxAttempts: this.maxAttempts, timeoutMs: this.timeoutMs, firstTextTimeoutMs: this.firstTextTimeoutMs, maxDurationMs: this.maxDurationMs, lastError: null, endedAt: null, ...(requestContext.repair ? { repair: true } : {}) };
    let result;
    try {
      result = await this.request('/chat/completions', { method: 'POST', body: JSON.stringify({ model, messages: safeMessages, stream: true, stream_options: { include_usage: true }, max_completion_tokens: maxTokens, ...(reasoningEffort === 'auto' ? {} : { reasoning_effort: reasoningEffort }) }) }, signal, activity);
      await this.onUsage(result.usage || {});
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const choice = result.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('Model output exceeded its token budget. Resume retries the unfinished step.');
      const content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('Model returned an empty message.');
      Object.assign(activity, { status: 'completed', endedAt: new Date().toISOString() });
      await this.onRequestState({ ...activity });
      return content;
    } catch (error) {
      if (error instanceof UpstreamError && reasoningEffort !== 'auto') error.message += ` Requested reasoning effort: ${reasoningEffort}.`;
      Object.assign(activity, { status: signal?.aborted ? 'cancelled' : 'failed', endedAt: new Date().toISOString(), lastError: error.message });
      await this.onRequestState({ ...activity });
      throw error;
    }
  }
  async json(model, messages, validator, options = {}) {
    let raw = await this.complete(model, messages, options);
    try { return validator(parseJSON(raw)); } catch (error) {
      const validationMessage = error.message.slice(0, 500);
      await this.onRetry(`Repairing structured response: ${validationMessage}`);
      raw = await this.complete(model, [...messages, { role: 'assistant', content: raw }, { role: 'user', content: `The JSON failed validation: ${validationMessage}\nReturn one corrected JSON object with all required fields. Preserve your substantive answer, obey the requested schema and do not add Markdown.` }], { ...options, requestContext: { ...options.requestContext, repair: true } });
      return validator(parseJSON(raw));
    }
  }
}
