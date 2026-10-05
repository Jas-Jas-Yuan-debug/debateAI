// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jas-Jas-Yuan-debug and contributors.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

// This gateway transport deliberately has no implicit header or body deadline.
// ModelClient owns the first-text, stream-idle and overall deadlines via its signal.
// Native fetch has a separate five-minute transport limit that can preempt them.
export function gatewayFetch(input, { method = 'GET', headers = {}, body, signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const url = new URL(input);
  const send = url.protocol === 'http:' ? httpRequest : url.protocol === 'https:' ? httpsRequest : null;
  if (!send) return Promise.reject(new TypeError('The model gateway must use HTTP or HTTPS.'));
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Accept-Encoding', 'identity');
  return new Promise((resolve, reject) => {
    const request = send(url, { method, headers: Object.fromEntries(requestHeaders), signal, agent: false }, incoming => {
      try {
        const responseHeaders = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        const noBody = method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
        if (noBody) incoming.resume();
        // Redirects remain responses; never forward the API key to another host.
        resolve(new Response(noBody ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers: responseHeaders }));
      } catch (error) { incoming.destroy(); reject(error); }
    });
    request.once('error', error => reject(signal?.aborted ? signal.reason : new TypeError('The model gateway connection failed.', { cause: error })));
    request.setTimeout(0);
    request.end(body);
  });
}
