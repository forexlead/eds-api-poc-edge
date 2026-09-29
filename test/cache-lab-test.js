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

// GET /api/cache/* — the Cache Lab (docs/cache-lab.md). global.fetch is mocked; a mocked
// "miss" takes longer than LEFT_FUNCTION_MS (like a live TMDB round trip) and a "hit"
// returns at once (like the fetch cache), since duration is how misses are counted.

import assert from 'node:assert';
import { TMDB_TOKEN } from '../src/generated/secrets.js';
import { handleRequest } from '../src/index.js';
import { EXPOSE_HEADERS } from '../src/lib/http.js';
import { cacheState, LEFT_FUNCTION_MS } from '../src/routes/cache-lab.js';

const BASE = 'https://publish-p24773-e1522172.adobeaemcloud.com';
const ORIGIN = 'https://main--eds-api-poc--forexlead.aem.page';
const UPSTREAM_DATE = 'Mon, 21 Sep 2026 18:00:00 GMT';

const MATRIX = {
  id: 603,
  title: 'The Matrix',
  release_date: '1999-03-30',
  poster_path: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
  results: {
    US: {
      buy: [{ provider_name: 'Apple TV' }],
      rent: [{ provider_name: 'Amazon Video' }],
      flatrate: [{ provider_name: 'Max' }]
    }
  }
};

const TRENDING = { results: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `Movie ${i + 1}` })) };

function fetchEvent(path, headers = {}) {
  return { request: new Request(BASE + path, { headers: { Origin: ORIGIN, ...headers } }), client: {} };
}

function upstream(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', Date: UPSTREAM_DATE }
  });
}

describe('Cache Lab /api/cache/*', function () {
  let originalFetch;
  let calls;
  /** URLs that the mock treats as fetch-cache hits (answered instantly). */
  let cachedUrls;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    calls = [];
    cachedUrls = new Set();
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, opts });
      if (!cachedUrls.has(u)) await new Promise((resolve) => setTimeout(resolve, LEFT_FUNCTION_MS + 10));
      return upstream(u.includes('/trending/') ? TRENDING : MATRIX);
    };
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  function assertCommon(resp) {
    assert.equal(resp.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(resp.headers.get('Timing-Allow-Origin'), '*');
    assert.equal(resp.headers.get('Vary'), 'Origin');
    assert.equal(resp.headers.get('X-Pattern'), 'cache-lab');
    const exposed = resp.headers.get('Access-Control-Expose-Headers').split(', ');
    for (const h of ['Age', 'X-Cache-Mode', 'X-Fetched-At', 'X-Backend-Calls']) {
      assert.ok(exposed.includes(h), `${h} not exposed`);
    }
  }

  describe('product', function () {
    it('sets a long TTL, product surrogate keys, and matching fetch-cache settings', async function () {
      const resp = await handleRequest(fetchEvent('/api/cache/product?id=603'));
      assert.equal(resp.status, 200);
      assertCommon(resp);
      assert.equal(resp.headers.get('Surrogate-Control'), 'max-age=3600, stale-while-revalidate=300');
      assert.equal(resp.headers.get('Surrogate-Key'), 'product-603 products');
      assert.equal(resp.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
      assert.equal(resp.headers.get('X-Cache-Mode'), 'cached');
      assert.equal(resp.headers.get('X-Fetched-At'), UPSTREAM_DATE);
      assert.equal(resp.headers.get('X-Backend-Calls'), '1');

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.themoviedb.org/3/movie/603?language=en-US');
      assert.equal(calls[0].opts.headers.Authorization, `Bearer ${TMDB_TOKEN}`);
      const co = calls[0].opts.cacheOverride;
      assert.deepEqual([co.mode, co.ttl, co.swr, co.surrogateKey], ['override', 3600, 300, 'product-603 products']);

      const body = await resp.json();
      assert.equal(body.id, 603);
      assert.equal(body.fetchedAt, UPSTREAM_DATE);
    });

    it('reports X-Backend-Calls: 0 on a fetch-cache hit', async function () {
      cachedUrls.add('https://api.themoviedb.org/3/movie/603?language=en-US');
      const resp = await handleRequest(fetchEvent('/api/cache/product?id=603'));
      assert.equal(resp.headers.get('X-Backend-Calls'), '0');
    });

    it('400s a non-numeric id and 404s an unknown one', async function () {
      assert.equal((await handleRequest(fetchEvent('/api/cache/product?id=x'))).status, 400);
      globalThis.fetch = async () => upstream({}, { status: 404 });
      assert.equal((await handleRequest(fetchEvent('/api/cache/product?id=9'))).status, 404);
    });
  });

  describe('stock', function () {
    it('sets a short TTL with SWR and returns a reading the function generated', async function () {
      const before = Date.now();
      const resp = await handleRequest(fetchEvent('/api/cache/stock?id=603'));
      assert.equal(resp.status, 200);
      assertCommon(resp);
      assert.equal(resp.headers.get('Surrogate-Control'), 'max-age=20, stale-while-revalidate=120');
      assert.equal(resp.headers.get('Surrogate-Key'), 'stock-603 stock');
      assert.equal(resp.headers.get('X-Backend-Calls'), '1');

      const co = calls[0].opts.cacheOverride;
      assert.equal(calls[0].url, 'https://api.themoviedb.org/3/movie/603/release_dates');
      assert.deepEqual([co.ttl, co.swr, co.surrogateKey], [20, 120, 'stock stock-feed']);

      const body = await resp.json();
      assert.notEqual(body.readingAt, UPSTREAM_DATE, 'reading must not be the upstream Date');
      assert.ok(Date.parse(body.readingAt) >= Math.floor(before / 1000) * 1000);
      assert.equal(resp.headers.get('X-Fetched-At'), body.readingAt);
      assert.ok(Number.isInteger(body.level) && body.level >= 0 && body.level < 500);
    });

    it('serves any SKU, including ids TMDB does not have, from a valid feed id', async function () {
      const resp = await handleRequest(fetchEvent('/api/cache/stock?id=1'));
      assert.equal(resp.status, 200);
      assert.equal(calls[0].url, 'https://api.themoviedb.org/3/movie/603/release_dates');
      assert.equal(resp.headers.get('Surrogate-Key'), 'stock-1 stock');
      assert.equal((await resp.json()).id, 1);
    });
  });

  describe('mypage', function () {
    it('is never cached, has no surrogate key, and caches its three ingredients for 60s', async function () {
      const resp = await handleRequest(fetchEvent('/api/cache/mypage?tier=gold'));
      assert.equal(resp.status, 200);
      assertCommon(resp);
      assert.equal(resp.headers.get('Cache-Control'), 'no-store');
      assert.equal(resp.headers.get('Surrogate-Control'), 'no-store');
      assert.equal(resp.headers.get('Surrogate-Key'), null);
      assert.equal(resp.headers.get('X-Cache-Mode'), 'no-store');
      assert.equal(resp.headers.get('X-Backend-Calls'), '3');
      assert.match(resp.headers.get('Server-Timing'), /^product;dur=\d+, prices;dur=\d+, topSellers;dur=\d+, edge;dur=\d+$/);

      assert.equal(calls.length, 3);
      for (const { opts } of calls) {
        assert.equal(opts.cacheOverride.ttl, 60);
        assert.equal(opts.cacheOverride.swr, undefined);
      }
      // prices asks for gzip: TMDB's CloudFront keeps a separate, much older copy for identity
      const prices = calls.find((c) => c.url.endsWith('/watch/providers'));
      assert.equal(prices.opts.headers['Accept-Encoding'], 'gzip');
      assert.equal(prices.opts.fastly.decompressGzip, true);

      const body = await resp.json();
      assert.equal(body.tier, 'gold');
      assert.equal(body.page.topSellers.length, 10);
      assert.deepEqual(Object.keys(body.page.offers), ['buy', 'rent', 'flatrate']);
      for (const name of ['product', 'prices', 'topSellers']) {
        assert.deepEqual(body.ingredients[name].cache, 'miss');
        assert.equal(body.ingredients[name].fetchedAt, UPSTREAM_DATE);
      }
    });

    it('counts only the ingredients that left the function', async function () {
      cachedUrls.add('https://api.themoviedb.org/3/trending/movie/week');
      cachedUrls.add('https://api.themoviedb.org/3/movie/603/watch/providers');
      const resp = await handleRequest(fetchEvent('/api/cache/mypage?tier=bronze'));
      assert.equal(resp.headers.get('X-Backend-Calls'), '1');
      const body = await resp.json();
      assert.equal(body.ingredients.product.cache, 'miss');
      assert.equal(body.ingredients.prices.cache, 'hit');
      assert.equal(body.ingredients.topSellers.cache, 'hit');
      assert.equal(body.page.topSellers.length, 3);
      assert.deepEqual(Object.keys(body.page.offers), ['buy']);
    });

    it('400s a missing or unknown tier', async function () {
      for (const path of ['/api/cache/mypage', '/api/cache/mypage?tier=platinum']) {
        const resp = await handleRequest(fetchEvent(path));
        assert.equal(resp.status, 400);
        assert.equal(resp.headers.get('Cache-Control'), 'no-store');
      }
    });
  });

  describe('quote', function () {
    it('sets max-age=10 with stale-if-error and makes no backend call', async function () {
      const resp = await handleRequest(fetchEvent('/api/cache/quote'));
      assert.equal(resp.status, 200);
      assertCommon(resp);
      assert.equal(resp.headers.get('Surrogate-Control'), 'max-age=10, stale-if-error=86400');
      assert.equal(resp.headers.get('X-Backend-Calls'), '0');
      assert.equal(calls.length, 0);
      const body = await resp.json();
      assert.equal(resp.headers.get('X-Fetched-At'), body.quotedAt);
    });

    it('answers 503 on break=1 or X-Break: 1, uncacheable', async function () {
      for (const event of [
        fetchEvent('/api/cache/quote?break=1'),
        fetchEvent('/api/cache/quote', { 'X-Break': '1' })
      ]) {
        const resp = await handleRequest(event);
        assert.equal(resp.status, 503);
        assert.equal(resp.headers.get('Surrogate-Control'), 'no-store');
        assert.equal(resp.headers.get('Cache-Control'), 'no-store');
        assert.equal((await resp.json()).error.code, 'UPSTREAM');
      }
    });

    it('400s an unknown break value', async function () {
      assert.equal((await handleRequest(fetchEvent('/api/cache/quote?break=2'))).status, 400);
    });
  });

  it('never leaks the TMDB token', async function () {
    for (const path of ['/api/cache/product?id=603', '/api/cache/stock?id=603', '/api/cache/mypage?tier=gold']) {
      const resp = await handleRequest(fetchEvent(path));
      const headerText = [...resp.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
      assert.ok(!headerText.includes(TMDB_TOKEN));
      assert.ok(!(await resp.text()).includes(TMDB_TOKEN));
    }
  });

  it('exposes X-Backend-Calls on every route', function () {
    assert.match(EXPOSE_HEADERS, /X-Backend-Calls/);
  });
});

describe('cacheState (X-Backend-Calls signal)', function () {
  const withXCache = (value) => new Response('{}', { headers: value === null ? {} : { 'x-cache': value } });

  it("reads Fastly's token at the end of x-cache, ignoring duration", function () {
    assert.equal(cacheState(withXCache('Hit from cloudfront, HIT'), 230), 'hit');
    assert.equal(cacheState(withXCache('Hit from cloudfront, MISS'), 2), 'miss');
    assert.equal(cacheState(withXCache('HIT'), 500), 'hit');
    assert.equal(cacheState(withXCache('Miss from cloudfront, PASS'), 1), 'miss');
    assert.equal(cacheState(withXCache('Hit from cloudfront, HIT-STALE'), 90), 'hit');
  });

  it("doesn't mistake CloudFront's own value for Fastly's; falls back to duration", function () {
    assert.equal(cacheState(withXCache('Hit from cloudfront'), 2), 'hit');
    assert.equal(cacheState(withXCache('Hit from cloudfront'), LEFT_FUNCTION_MS + 5), 'miss');
    assert.equal(cacheState(withXCache(null), LEFT_FUNCTION_MS + 5), 'miss');
  });
});
