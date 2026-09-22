/*
Copyright 2025 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

/// <reference types="@fastly/js-compute" />

// Shared response helpers. Implements "Common response rules" in docs/api-contract.md.
// Deliberately free of `fastly:*` imports so mocha can exercise it under plain Node.

/** EDS preview/live hosts for this site, e.g. https://main--eds-api-poc--forexlead.aem.page */
const ALLOWED_ORIGIN_RE = /^https:\/\/[a-z0-9-]+--eds-api-poc--[a-z0-9-]+\.aem\.(page|live)$/;
const ALLOWED_ORIGIN_LITERAL = 'http://localhost:3000';

const EXPOSE_HEADERS =
  'Server-Timing, X-Pattern, X-Fallback, X-Original-Bytes, X-Transformed-Bytes, X-Fetched-At, X-Backend-Age, Age';

/** The browser always revalidates against the edge — we measure the edge, not the browser cache. */
const BROWSER_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/** Default per-backend budget (docs/api-contract.md). */
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * @param {string|null|undefined} origin
 * @returns {string|null} the origin if it is allowlisted, otherwise null
 */
function allowedOrigin(origin) {
  if (!origin) return null;
  if (origin === ALLOWED_ORIGIN_LITERAL) return origin;
  return ALLOWED_ORIGIN_RE.test(origin) ? origin : null;
}

/**
 * CORS headers shared by real responses and preflights. `Vary: Origin` is set even when the
 * origin is rejected, so a cached response is never reused for a different origin.
 */
function corsHeaders(req) {
  const headers = { Vary: 'Origin', 'Timing-Allow-Origin': '*' };
  const origin = allowedOrigin(req?.headers?.get('Origin'));
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/**
 * Serialize timing marks into a Server-Timing header value.
 * @param {Record<string, number>|Array<[string, number]>} marks e.g. { tmdb: 142, edge: 151 }
 */
function serverTiming(marks) {
  const entries = Array.isArray(marks) ? marks : Object.entries(marks);
  return entries
    .filter(([, ms]) => Number.isFinite(ms))
    .map(([name, ms]) => `${name};dur=${Math.round(ms)}`)
    .join(', ');
}

/**
 * JSON response carrying every common header from the contract.
 * @param {Request} req the inbound request (for Origin echoing)
 * @param {unknown} body
 * @param {{ status?: number, headers?: Record<string, string> }} [opts]
 */
function json(req, body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': BROWSER_CACHE_CONTROL,
      'Access-Control-Expose-Headers': EXPOSE_HEADERS,
      ...corsHeaders(req),
      ...headers
    }
  });
}

/**
 * Error envelope: { error: { code, message } }.
 * Messages must never contain upstream URLs, credentials or the TMDB token.
 */
function error(req, status, code, message, headers = {}) {
  return json(req, { error: { code, message } }, { status, headers });
}

/** `OPTIONS /api/*` → 204 with the preflight headers from the contract. */
function preflight(req) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Access-Control-Expose-Headers': EXPOSE_HEADERS,
      ...corsHeaders(req)
    }
  });
}

/**
 * fetch() with a hard wall-clock budget, never rejecting.
 * @returns {Promise<{ok: boolean, response: Response|null, ms: number, error?: 'timeout'|'upstream'}>}
 */
async function timedFetch(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const started = Date.now();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  try {
    const response = await Promise.race([fetch(url, opts), timeout]);
    return { ok: true, response, ms: Date.now() - started };
  } catch (err) {
    // Swallow the cause: it can embed the upstream URL, which may carry credentials.
    const kind = err?.message === 'timeout' ? 'timeout' : 'upstream';
    return { ok: false, response: null, ms: Date.now() - started, error: kind };
  } finally {
    clearTimeout(timer);
  }
}

export {
  ALLOWED_ORIGIN_RE,
  ALLOWED_ORIGIN_LITERAL,
  EXPOSE_HEADERS,
  BROWSER_CACHE_CONTROL,
  DEFAULT_TIMEOUT_MS,
  allowedOrigin,
  corsHeaders,
  serverTiming,
  json,
  error,
  preflight,
  timedFetch
};
