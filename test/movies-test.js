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

// GET /api/movies and GET /api/movie — Pattern 01 Secure Proxy (docs/api-contract.md).
// global.fetch is mocked throughout: these tests never hit the real TMDB API, and every
// assertion on the outbound Authorization header confirms the token was attached
// server-side without ever appearing in what comes back to the caller.

import assert from 'node:assert';
import { TMDB_TOKEN } from '../src/generated/secrets.js';
import { handleRequest } from '../src/index.js';

const BASE = 'https://publish-p24773-e1522172.adobeaemcloud.com';
const UPSTREAM_DATE = 'Mon, 21 Sep 2026 18:00:00 GMT';

function fetchEvent(path) {
  return { request: new Request(BASE + path), client: {} };
}

function tmdbResponse(body, { status = 200, date = UPSTREAM_DATE, age } = {}) {
  const headers = { 'Content-Type': 'application/json', Date: date };
  if (age !== undefined) headers.Age = String(age);
  return new Response(JSON.stringify(body), { status, headers });
}

const MATRIX_SEARCH_HIT = {
  id: 603,
  title: 'The Matrix',
  release_date: '1999-03-30',
  vote_average: 8.184,
  poster_path: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg'
};

const MATRIX_DETAIL = {
  id: 603,
  title: 'The Matrix',
  release_date: '1999-03-30',
  vote_average: 8.184,
  runtime: 136,
  overview: 'A computer hacker learns from mysterious rebels about the true nature of reality.',
  poster_path: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg'
};

describe('GET /api/movies?q=', function () {
  let originalFetch;
  let calls;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  it('proxies TMDB search with the Bearer token and shapes the results', async function () {
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts });
      return tmdbResponse({ results: [MATRIX_SEARCH_HIT] });
    };

    const resp = await handleRequest(fetchEvent('/api/movies?q=matrix'));
    assert.equal(resp.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://api.themoviedb.org/3/search/movie?query=matrix'
    );
    assert.equal(calls[0].opts.headers.Authorization, `Bearer ${TMDB_TOKEN}`);
    assert.equal(calls[0].opts.cacheOverride.ttl, 60);
    assert.equal(calls[0].opts.cacheOverride.swr, 300);
    assert.equal(calls[0].opts.cacheOverride.surrogateKey, 'movies movies-q-matrix');

    const body = await resp.json();
    assert.equal(body.pattern, 'proxy');
    assert.equal(body.query, 'matrix');
    assert.deepEqual(body.results, [
      {
        id: 603,
        title: 'The Matrix',
        year: 1999,
        rating: 8.2,
        poster: 'https://image.tmdb.org/t/p/w185/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg'
      }
    ]);

    assert.equal(resp.headers.get('X-Pattern'), 'proxy');
    assert.equal(resp.headers.get('X-Fetched-At'), UPSTREAM_DATE);
    assert.equal(resp.headers.get('X-Backend-Age'), null); // TMDB sent no Age header here
    assert.equal(resp.headers.get('Surrogate-Key'), 'movies movies-q-matrix');
    assert.equal(
      resp.headers.get('Surrogate-Control'),
      'max-age=60, stale-while-revalidate=300, stale-if-error=86400'
    );
    assert.match(resp.headers.get('Server-Timing'), /^tmdb;dur=\d+, edge;dur=\d+$/);
  });

  it('passes through TMDB\'s Age header as X-Backend-Age when present', async function () {
    globalThis.fetch = async () => tmdbResponse({ results: [MATRIX_SEARCH_HIT] }, { age: 42 });
    const resp = await handleRequest(fetchEvent('/api/movies?q=matrix'));
    assert.equal(resp.headers.get('X-Backend-Age'), '42');
  });

  it('caps results at 10', async function () {
    globalThis.fetch = async () =>
      tmdbResponse({
        results: Array.from({ length: 15 }, (_, i) => ({
          id: i,
          title: `Movie ${i}`,
          release_date: '2000-01-01',
          vote_average: 5,
          poster_path: null
        }))
      });

    const resp = await handleRequest(fetchEvent('/api/movies?q=movie'));
    const body = await resp.json();
    assert.equal(body.results.length, 10);
  });

  it('400s a missing, blank, or over-length q', async function () {
    globalThis.fetch = async () => {
      throw new Error('fetch should not be called for an invalid q');
    };
    for (const path of ['/api/movies', '/api/movies?q=', `/api/movies?q=${'x'.repeat(101)}`]) {
      const resp = await handleRequest(fetchEvent(path));
      assert.equal(resp.status, 400);
      const body = await resp.json();
      assert.equal(body.error.code, 'BAD_REQUEST');
    }
  });

  it('502s as UPSTREAM when TMDB is unreachable', async function () {
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    const resp = await handleRequest(fetchEvent('/api/movies?q=matrix'));
    assert.equal(resp.status, 502);
    const body = await resp.json();
    assert.equal(body.error.code, 'UPSTREAM');
  });
});

describe('GET /api/movie?id=', function () {
  let originalFetch;
  let calls;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  it('proxies TMDB movie details with the Bearer token and shapes the response', async function () {
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts });
      return tmdbResponse(MATRIX_DETAIL);
    };

    const resp = await handleRequest(fetchEvent('/api/movie?id=603'));
    assert.equal(resp.status, 200);
    assert.equal(calls[0].url, 'https://api.themoviedb.org/3/movie/603');
    assert.equal(calls[0].opts.headers.Authorization, `Bearer ${TMDB_TOKEN}`);
    assert.equal(calls[0].opts.cacheOverride.surrogateKey, 'movies movie-603');

    const body = await resp.json();
    assert.deepEqual(body, {
      pattern: 'proxy',
      id: 603,
      title: 'The Matrix',
      year: 1999,
      rating: 8.2,
      runtime: 136,
      overview: MATRIX_DETAIL.overview,
      poster: 'https://image.tmdb.org/t/p/w185/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
      fetchedAt: UPSTREAM_DATE
    });

    assert.equal(resp.headers.get('X-Fetched-At'), UPSTREAM_DATE);
    assert.equal(resp.headers.get('X-Backend-Age'), null); // TMDB sent no Age header here
    assert.equal(resp.headers.get('Surrogate-Key'), 'movies movie-603');
  });

  it('passes through TMDB\'s Age header as X-Backend-Age when present', async function () {
    globalThis.fetch = async () => tmdbResponse(MATRIX_DETAIL, { age: 7 });
    const resp = await handleRequest(fetchEvent('/api/movie?id=603'));
    assert.equal(resp.headers.get('X-Backend-Age'), '7');
  });

  it('400s a missing or non-numeric id', async function () {
    globalThis.fetch = async () => {
      throw new Error('fetch should not be called for an invalid id');
    };
    for (const path of ['/api/movie', '/api/movie?id=abc', '/api/movie?id=6.03']) {
      const resp = await handleRequest(fetchEvent(path));
      assert.equal(resp.status, 400);
      const body = await resp.json();
      assert.equal(body.error.code, 'BAD_REQUEST');
    }
  });

  it('404s as NOT_FOUND when TMDB has no such movie', async function () {
    globalThis.fetch = async () => tmdbResponse({ status_message: 'not found' }, { status: 404 });
    const resp = await handleRequest(fetchEvent('/api/movie?id=999999999'));
    assert.equal(resp.status, 404);
    const body = await resp.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('502s as UPSTREAM on a TMDB 5xx', async function () {
    globalThis.fetch = async () => tmdbResponse({}, { status: 500 });
    const resp = await handleRequest(fetchEvent('/api/movie?id=603'));
    assert.equal(resp.status, 502);
    const body = await resp.json();
    assert.equal(body.error.code, 'UPSTREAM');
  });
});

describe('Server-Timing as the primary cache-hit signal', function () {
  // docs/api-contract.md: X-Fetched-At and X-Backend-Age are corroborating signals, but
  // tmdb;dur is the one to check first — a Fastly fetch-cache hit returns near-instantly,
  // a live round trip to TMDB does not. This simulates that gap without a real network call.
  let originalFetch;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  it('reports a near-0ms tmdb;dur on a fast (cache-hit-like) response', async function () {
    globalThis.fetch = async () => tmdbResponse(MATRIX_DETAIL);
    const resp = await handleRequest(fetchEvent('/api/movie?id=603'));
    const [, tmdbMs] = resp.headers.get('Server-Timing').match(/tmdb;dur=(\d+)/);
    assert.ok(Number(tmdbMs) < 20, `expected a near-0ms tmdb;dur, got ${tmdbMs}ms`);
  });

  it('reports the real elapsed time on a slow (live round-trip-like) response', async function () {
    globalThis.fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return tmdbResponse(MATRIX_DETAIL);
    };
    const resp = await handleRequest(fetchEvent('/api/movie?id=603'));
    const [, tmdbMs] = resp.headers.get('Server-Timing').match(/tmdb;dur=(\d+)/);
    assert.ok(Number(tmdbMs) >= 55, `expected tmdb;dur to reflect the ~60ms delay, got ${tmdbMs}ms`);
  });
});

describe('TMDB token containment (movies routes)', function () {
  let originalFetch;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      tmdbResponse({ results: [MATRIX_SEARCH_HIT], ...MATRIX_DETAIL });
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  async function assertNoLeak(resp) {
    const statusLine = `HTTP/1.1 ${resp.status} ${resp.statusText}`;
    const headerText = [...resp.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
    const body = await resp.text();
    for (const [label, text] of [
      ['status line', statusLine],
      ['headers', headerText],
      ['body', body]
    ]) {
      assert.ok(!text.includes(TMDB_TOKEN), `token leaked into the response ${label}`);
    }
  }

  it('never appears in a /api/movies response', async function () {
    await assertNoLeak(await handleRequest(fetchEvent('/api/movies?q=matrix')));
  });

  it('never appears in a /api/movie response', async function () {
    await assertNoLeak(await handleRequest(fetchEvent('/api/movie?id=603')));
  });
});
