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

// GET /api/resilient — Pattern 04 Resilient Failover (docs/api-contract.md).
// global.fetch is mocked throughout; each mode's upstream is told apart by URL.

import assert from 'node:assert';
import { TMDB_TOKEN } from '../src/generated/secrets.js';
import { handleRequest } from '../src/index.js';

const BASE = 'https://publish-p24773-e1522172.adobeaemcloud.com';

const MATRIX_DETAIL = {
  id: 603,
  title: 'The Matrix',
  release_date: '1999-03-30',
  runtime: 136
};

const STATIC_DATA = { id: 603, title: 'The Matrix', year: 1999 };

function fetchEvent(path) {
  return { request: new Request(BASE + path), client: {} };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Mimics the real upstreams: TMDB ok, httpbin 500, httpbin 5 s delay (3 s here). */
function upstreams(url) {
  if (url === 'https://api.themoviedb.org/3/movie/603') return jsonResponse(MATRIX_DETAIL);
  if (url === 'https://httpbin.org/status/500') return new Response('', { status: 500 });
  if (url === 'https://httpbin.org/delay/5') {
    return new Promise((resolve) => setTimeout(() => resolve(jsonResponse({})), 3000));
  }
  throw new Error(`unexpected fetch: ${url}`);
}

describe('GET /api/resilient', function () {
  let originalFetch;
  let calls;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts });
      return upstreams(String(url));
    };
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  it('mode=ok serves live TMDB data with X-Fallback: none', async function () {
    const resp = await handleRequest(fetchEvent('/api/resilient?mode=ok'));
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('X-Pattern'), 'failover');
    assert.equal(resp.headers.get('X-Fallback'), 'none');
    assert.deepEqual(await resp.json(), {
      pattern: 'failover',
      served: 'live',
      reason: null,
      data: STATIC_DATA
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.headers.Authorization, `Bearer ${TMDB_TOKEN}`);
    assert.equal(calls[0].opts.cacheOverride.mode, 'pass');
  });

  it('defaults to mode=ok when mode is absent', async function () {
    const resp = await handleRequest(fetchEvent('/api/resilient'));
    const body = await resp.json();
    assert.equal(body.served, 'live');
    assert.equal(calls[0].url, 'https://api.themoviedb.org/3/movie/603');
  });

  it('mode=fail falls back to the static snapshot with reason "upstream 500"', async function () {
    const resp = await handleRequest(fetchEvent('/api/resilient?mode=fail'));
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('X-Fallback'), 'static');
    assert.deepEqual(await resp.json(), {
      pattern: 'failover',
      served: 'static',
      reason: 'upstream 500',
      data: STATIC_DATA
    });
    assert.equal(calls[0].url, 'https://httpbin.org/status/500');
  });

  it('mode=slow hits the 1500ms timeout and falls back with reason "timeout"', async function () {
    this.timeout(4000);
    const started = Date.now();
    const resp = await handleRequest(fetchEvent('/api/resilient?mode=slow'));
    const elapsed = Date.now() - started;

    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('X-Fallback'), 'static');
    const body = await resp.json();
    assert.equal(body.served, 'static');
    assert.equal(body.reason, 'timeout');
    assert.deepEqual(body.data, STATIC_DATA);
    assert.ok(elapsed >= 1490 && elapsed < 2000, `expected ~1500ms, took ${elapsed}ms`);
    assert.match(resp.headers.get('Server-Timing'), /^upstream;dur=1[45]\d\d, edge;dur=\d+$/);
  });

  it('a network error also falls back, with reason "upstream"', async function () {
    globalThis.fetch = async () => {
      throw new Error('connection refused');
    };
    const resp = await handleRequest(fetchEvent('/api/resilient?mode=ok'));
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.served, 'static');
    assert.equal(body.reason, 'upstream');
  });

  it('never sends the TMDB token to the httpbin failure endpoints', async function () {
    await handleRequest(fetchEvent('/api/resilient?mode=fail'));
    assert.equal(calls[0].opts.headers.Authorization, undefined);
  });

  it('is not cacheable: no Surrogate-Control or Surrogate-Key, and never echoes the token', async function () {
    for (const mode of ['ok', 'fail']) {
      const resp = await handleRequest(fetchEvent(`/api/resilient?mode=${mode}`));
      assert.equal(resp.headers.get('Surrogate-Control'), null);
      assert.equal(resp.headers.get('Surrogate-Key'), null);
      const headerDump = [...resp.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
      assert.ok(!headerDump.includes(TMDB_TOKEN));
      assert.ok(!(await resp.text()).includes(TMDB_TOKEN));
    }
  });

  it('400s an unknown mode', async function () {
    const resp = await handleRequest(fetchEvent('/api/resilient?mode=explode'));
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error.code, 'BAD_REQUEST');
    assert.equal(calls.length, 0);
  });
});
