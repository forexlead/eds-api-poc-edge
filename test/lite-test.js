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

// GET /api/lite — Pattern 03 Transformer (docs/api-contract.md). global.fetch is mocked
// throughout with a PokeAPI-shaped payload carrying plenty of fields the transform drops,
// so X-Original-Bytes/X-Transformed-Bytes show a real reduction.

import assert from 'node:assert';
import { handleRequest } from '../src/index.js';

const BASE = 'https://publish-p24773-e1511008.adobeaemcloud.com';
const UPSTREAM_DATE = 'Mon, 21 Sep 2026 18:00:00 GMT';

function fetchEvent(path) {
  return { request: new Request(BASE + path), client: {} };
}

const PIKACHU_PAYLOAD = {
  id: 25,
  name: 'pikachu',
  height: 4,
  weight: 60,
  base_experience: 112,
  order: 35,
  is_default: true,
  location_area_encounters: 'https://pokeapi.co/api/v2/pokemon/25/encounters',
  abilities: [
    { ability: { name: 'static', url: 'https://pokeapi.co/api/v2/ability/9/' }, is_hidden: false, slot: 1 },
    { ability: { name: 'lightning-rod', url: 'https://pokeapi.co/api/v2/ability/31/' }, is_hidden: true, slot: 3 }
  ],
  types: [{ slot: 1, type: { name: 'electric', url: 'https://pokeapi.co/api/v2/type/13/' } }],
  sprites: {
    front_default: 'https://raw.githubusercontent.com/.../25.png',
    back_default: 'https://raw.githubusercontent.com/.../25-back.png',
    other: { 'official-artwork': { front_default: 'https://raw.githubusercontent.com/.../artwork/25.png' } }
  },
  stats: [
    { base_stat: 35, effort: 0, stat: { name: 'hp', url: '...' } },
    { base_stat: 55, effort: 0, stat: { name: 'attack', url: '...' } },
    { base_stat: 40, effort: 0, stat: { name: 'defense', url: '...' } },
    { base_stat: 50, effort: 0, stat: { name: 'special-attack', url: '...' } },
    { base_stat: 50, effort: 0, stat: { name: 'special-defense', url: '...' } },
    { base_stat: 90, effort: 2, stat: { name: 'speed', url: '...' } }
  ],
  moves: Array.from({ length: 80 }, (_, i) => ({ move: { name: `move-${i}`, url: '...' } }))
};

function pokeResponse(body, { status = 200, date = UPSTREAM_DATE, age } = {}) {
  const headers = { 'Content-Type': 'application/json', Date: date };
  if (age !== undefined) headers.Age = String(age);
  return new Response(JSON.stringify(body), { status, headers });
}

describe('GET /api/lite?id=', function () {
  let originalFetch;
  let calls;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  it('shapes the output and sets both byte headers', async function () {
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts });
      return pokeResponse(PIKACHU_PAYLOAD);
    };

    const resp = await handleRequest(fetchEvent('/api/lite?id=25'));
    assert.equal(resp.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://pokeapi.co/api/v2/pokemon/25');
    assert.equal(calls[0].opts.cacheOverride.surrogateKey, 'pokemon pokemon-25');

    const body = await resp.json();
    assert.deepEqual(body, {
      pattern: 'transform',
      id: 25,
      name: 'pikachu',
      types: ['electric'],
      sprite: 'https://raw.githubusercontent.com/.../25.png',
      stats: { hp: 35, attack: 55, defense: 40, speed: 90 }
    });

    const originalBytes = Number(resp.headers.get('X-Original-Bytes'));
    const transformedBytes = Number(resp.headers.get('X-Transformed-Bytes'));
    assert.equal(originalBytes, new TextEncoder().encode(JSON.stringify(PIKACHU_PAYLOAD)).length);
    assert.equal(transformedBytes, new TextEncoder().encode(JSON.stringify(body)).length);
    assert.ok(transformedBytes < originalBytes, 'the transform should shrink the payload');

    assert.equal(resp.headers.get('X-Pattern'), 'transform');
    assert.equal(resp.headers.get('X-Fetched-At'), UPSTREAM_DATE);
    assert.equal(resp.headers.get('Surrogate-Key'), 'pokemon pokemon-25');
    assert.equal(
      resp.headers.get('Surrogate-Control'),
      'max-age=60, stale-while-revalidate=300, stale-if-error=86400'
    );
    assert.match(resp.headers.get('Server-Timing'), /^pokemon;dur=\d+, edge;dur=\d+$/);
  });

  it('passes through the Age header as X-Backend-Age when present', async function () {
    globalThis.fetch = async () => pokeResponse(PIKACHU_PAYLOAD, { age: 12 });
    const resp = await handleRequest(fetchEvent('/api/lite?id=25'));
    assert.equal(resp.headers.get('X-Backend-Age'), '12');
  });

  it('defaults missing stats to null rather than dropping the key', async function () {
    globalThis.fetch = async () =>
      pokeResponse({ ...PIKACHU_PAYLOAD, stats: [{ base_stat: 35, stat: { name: 'hp' } }] });
    const resp = await handleRequest(fetchEvent('/api/lite?id=25'));
    const body = await resp.json();
    assert.deepEqual(body.stats, { hp: 35, attack: null, defense: null, speed: null });
  });

  it('400s an id outside 1-1025', async function () {
    globalThis.fetch = async () => {
      throw new Error('fetch should not be called for an invalid id');
    };
    for (const path of ['/api/lite', '/api/lite?id=0', '/api/lite?id=1026', '/api/lite?id=abc', '/api/lite?id=-5']) {
      const resp = await handleRequest(fetchEvent(path));
      assert.equal(resp.status, 400, `expected 400 for ${path}`);
      const body = await resp.json();
      assert.equal(body.error.code, 'BAD_REQUEST');
    }
  });

  it('accepts the boundary ids 1 and 1025', async function () {
    globalThis.fetch = async (url) => {
      const id = String(url).split('/').pop();
      return pokeResponse({ ...PIKACHU_PAYLOAD, id: Number(id) });
    };
    for (const id of [1, 1025]) {
      const resp = await handleRequest(fetchEvent(`/api/lite?id=${id}`));
      assert.equal(resp.status, 200, `expected 200 for id=${id}`);
    }
  });

  it('404s as NOT_FOUND when PokeAPI has no such id', async function () {
    globalThis.fetch = async () => pokeResponse({}, { status: 404 });
    const resp = await handleRequest(fetchEvent('/api/lite?id=999'));
    assert.equal(resp.status, 404);
    const body = await resp.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('502s as UPSTREAM when PokeAPI is unreachable', async function () {
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    const resp = await handleRequest(fetchEvent('/api/lite?id=25'));
    assert.equal(resp.status, 502);
    const body = await resp.json();
    assert.equal(body.error.code, 'UPSTREAM');
  });
});
