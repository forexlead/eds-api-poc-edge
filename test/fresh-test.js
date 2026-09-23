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

// `fresh=1` on the cacheable routes (docs/api-contract.md "fresh flag"): every backend fetch
// passes the fetch cache, and the response is marked no-store for browser and CDN.
// Without the flag, the ttl/swr override and cacheable headers stay as they were.

import assert from 'node:assert';
import { handleRequest } from '../src/index.js';

const BASE = 'https://publish-p24773-e1511008.adobeaemcloud.com';
const CACHEABLE_SURROGATE_CONTROL = 'max-age=60, stale-while-revalidate=300, stale-if-error=86400';

/** One fake upstream body that satisfies every route's transform. */
const UPSTREAM_BODY = {
  id: 25,
  name: 'pikachu',
  title: 'The Matrix',
  results: [{ id: 603, title: 'The Matrix' }],
  current: { temperature_2m: 20, wind_speed_10m: 5, weather_code: 1 },
  sprites: { front_default: 'https://example.test/25.png' },
  types: [],
  stats: []
};

const ROUTES = ['/api/dashboard', '/api/movie?id=603', '/api/movies?q=matrix', '/api/lite?id=25'];

function withFresh(path) {
  return path + (path.includes('?') ? '&' : '?') + 'fresh=1';
}

describe('fresh=1 flag', function () {
  let originalFetch;
  let calls;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts });
      return new Response(JSON.stringify(UPSTREAM_BODY), {
        headers: { 'Content-Type': 'application/json', Date: 'Mon, 21 Sep 2026 18:00:00 GMT' }
      });
    };
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  for (const path of ROUTES) {
    it(`${withFresh(path)} passes the fetch cache and responds no-store`, async function () {
      const resp = await handleRequest({ request: new Request(BASE + withFresh(path)), client: {} });
      assert.equal(resp.status, 200);
      assert.ok(calls.length >= 1);
      for (const { opts } of calls) {
        assert.equal(opts.cacheOverride.mode, 'pass');
        assert.equal(opts.cacheOverride.ttl, undefined);
      }
      assert.equal(resp.headers.get('Cache-Control'), 'no-store');
      assert.equal(resp.headers.get('Surrogate-Control'), 'no-store');
      assert.equal(resp.headers.get('X-Cache-Mode'), 'fresh');
    });

    it(`${path} keeps the ttl/swr override and cacheable headers`, async function () {
      const resp = await handleRequest({ request: new Request(BASE + path), client: {} });
      assert.equal(resp.status, 200);
      for (const { opts } of calls) {
        assert.equal(opts.cacheOverride.mode, 'override');
        assert.equal(opts.cacheOverride.ttl, 60);
        assert.equal(opts.cacheOverride.swr, 300);
        assert.equal(opts.cacheOverride.surrogateKey, resp.headers.get('Surrogate-Key'));
      }
      assert.equal(resp.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
      assert.equal(resp.headers.get('Surrogate-Control'), CACHEABLE_SURROGATE_CONTROL);
      assert.equal(resp.headers.get('X-Cache-Mode'), 'cached');
    });
  }

  it('only fresh=1 triggers the bypass', async function () {
    const resp = await handleRequest({ request: new Request(`${BASE}/api/movie?id=603&fresh=true`), client: {} });
    assert.equal(resp.headers.get('X-Cache-Mode'), 'cached');
    assert.equal(calls[0].opts.cacheOverride.mode, 'override');
  });

  it('exposes X-Cache-Mode to the browser', async function () {
    const resp = await handleRequest({ request: new Request(withFresh(`${BASE}/api/dashboard`)), client: {} });
    assert.match(resp.headers.get('Access-Control-Expose-Headers'), /\bX-Cache-Mode\b/);
  });
});
