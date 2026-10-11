// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
// Fetch supports a port-scoped Authorization header; EventSource cannot send one.
async function snapshotText(response) {
  const reader = response.body.getReader(), decoder = new TextDecoder(), parts = [];
  let bytes = 0, reads = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 64 * 1024 * 1024 || ++reads > 200000) throw new Error('Saved snapshot exceeds its size limit.');
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode()); return parts.join('');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function connectLiveEvents(url, { headers, onEvent, onError, onUnauthorized, fetchImpl = fetch, retryMs = 1000 }) {
  const controller = new AbortController(); let closed = false, snapshotTask, snapshotDirty = false;
  const close = () => { closed = true; controller.abort(); };
  const requestOptions = { headers, signal: controller.signal, credentials: 'omit', cache: 'no-store' };
  const refreshSnapshot = () => {
    snapshotDirty = true;
    if (snapshotTask) return;
    snapshotTask = (async () => {
      while (snapshotDirty && !closed) {
        snapshotDirty = false;
        const response = await fetchImpl(url.replace(/\/events$/, ''), requestOptions);
        if (response.status === 401) { await response.body?.cancel(); close(); onUnauthorized(); return; }
        if (!response.ok) { await response.body?.cancel(); throw new Error('Saved snapshot unavailable.'); }
        const data = await snapshotText(response);
        if (!closed) onEvent('state', { data });
      }
    })().catch(() => { if (!closed) onError(); }).finally(() => {
      snapshotTask = null;
      if (snapshotDirty && !closed) refreshSnapshot();
    });
  };
  const pause = () => new Promise(resolve => {
    if (closed) return resolve();
    const timer = setTimeout(done, retryMs);
    function done() { controller.signal.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); done(); }
    controller.signal.addEventListener('abort', abort, { once: true });
  });
  const finished = (async () => {
    while (!closed) {
      let reader;
      try {
        const response = await fetchImpl(url, requestOptions);
        if (response.status === 401) { await response.body?.cancel(); close(); onUnauthorized(); return; }
        if (!response.ok) { await response.body?.cancel(); throw new Error('Live connection unavailable.'); }
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', scan = 0, event = '', data = [], eventCharacters = 0;
        while (!closed) {
          const next = await reader.read(); if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n', scan)) !== -1) {
            const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1); scan = 0;
            if (!line) {
              if (data.length) {
                const content = data.join('\n');
                if (event === 'state-refresh') {
                  const runId = JSON.parse(content).runId;
                  if (typeof runId !== 'string' || !url.endsWith(`/${runId}/events`)) throw new Error('Invalid snapshot refresh.');
                  refreshSnapshot();
                } else onEvent(event, { data: content });
              }
              event = ''; data = []; eventCharacters = 0;
            } else {
              eventCharacters += line.length + 1;
              if (eventCharacters > 4 * 1024 * 1024 || data.length > 2048) throw new Error('Live update exceeds its size limit.');
              if (line.startsWith('event:')) event = line.slice(6).trim();
              if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
          }
          if (buffer.length + eventCharacters > 4 * 1024 * 1024) throw new Error('Live update exceeds its size limit.');
          scan = buffer.length;
        }
        if (!closed) onError();
      } catch { if (!closed) onError(); }
      finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
      if (!closed) await pause();
    }
    await snapshotTask;
  })();
  return { close, finished };
}
