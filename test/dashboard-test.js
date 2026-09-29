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

// GET /api/dashboard — Pattern 02 Aggregator (docs/api-contract.md).
// global.fetch is mocked throughout; three routes are told apart by their URL host.

import assert from 'node:assert';
import { handleRequest } from '../src/index.js';

const BASE = 'https://publish-p24773-e1522172.adobeaemcloud.com';

function fetchEvent(path, { geo } = {}) {
  return { request: new Request(BASE + path), client: { geo } };
}

function jsonResponse(body, { status = 200, date = 'Mon, 21 Sep 2026 18:00:00 GMT' } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', Date: date }
  });
}

/** After a real delay, resolve with `body` — lets tests shape each source's ms deterministically. */
function delayed(ms, body, opts) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(jsonResponse(body, opts)), ms);
  });
}

const TRENDING_PAYLOAD = {
  results: Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    title: `Movie ${i + 1}`,
    poster_path: `/poster-${i + 1}.jpg`
  }))
};

const WEATHER_PAYLOAD = {
  current: { temperature_2m: 24.1, wind_speed_10m: 9.4, weather_code: 1 }
};

const POKEMON_PAYLOAD = {
  id: 25,
  name: 'pikachu',
  sprites: { front_default: 'https://raw.githubusercontent.com/.../25.png' }
};

function routeByHost(url, { tmdb, weather, pokemon }) {
  if (url.includes('themoviedb.org')) return tmdb();
  if (url.includes('open-meteo.com')) return weather();
  if (url.includes('pokeapi.co')) return pokemon();
  throw new Error(`unexpected fetch: ${url}`);
}

describe('GET /api/dashboard', function () {
  let originalFetch;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  it('returns all three sources ok, shaped per the contract', async function () {
    globalThis.fetch = async (url) =>
      routeByHost(String(url), {
        tmdb: () => delayed(10, TRENDING_PAYLOAD),
        weather: () => delayed(15, WEATHER_PAYLOAD),
        pokemon: () => delayed(20, POKEMON_PAYLOAD)
      });

    const resp = await handleRequest(fetchEvent('/api/dashboard'));
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('X-Pattern'), 'aggregate');
    assert.equal(resp.headers.get('Surrogate-Key'), 'dashboard');
    assert.equal(
      resp.headers.get('Surrogate-Control'),
      'max-age=60, stale-while-revalidate=300, stale-if-error=86400'
    );

    const body = await resp.json();
    assert.equal(body.pattern, 'aggregate');

    assert.equal(body.sources.tmdb.status, 'ok');
    assert.equal(body.sources.tmdb.data.length, 5); // top 5, contract max
    assert.deepEqual(body.sources.tmdb.data[0], {
      id: 1,
      title: 'Movie 1',
      poster: 'https://image.tmdb.org/t/p/w185/poster-1.jpg'
    });

    assert.equal(body.sources.weather.status, 'ok');
    assert.deepEqual(body.sources.weather.data, { tempC: 24.1, windKph: 9.4, code: 1 });

    assert.equal(body.sources.pokemon.status, 'ok');
    assert.deepEqual(body.sources.pokemon.data, {
      id: 25,
      name: 'pikachu',
      sprite: 'https://raw.githubusercontent.com/.../25.png'
    });
  });

  it('keeps totalMs below sumOfSourcesMs (parallel, not sequential)', async function () {
    globalThis.fetch = async (url) =>
      routeByHost(String(url), {
        tmdb: () => delayed(20, TRENDING_PAYLOAD),
        weather: () => delayed(30, WEATHER_PAYLOAD),
        pokemon: () => delayed(40, POKEMON_PAYLOAD)
      });

    const resp = await handleRequest(fetchEvent('/api/dashboard'));
    const body = await resp.json();

    assert.ok(body.totalMs < body.sumOfSourcesMs, `${body.totalMs} should be < ${body.sumOfSourcesMs}`);
    // sequential would be ~90ms; parallel should land close to the slowest single source (~40ms).
    assert.ok(body.totalMs < 80, `expected a parallel-ish totalMs, got ${body.totalMs}`);
    const expectedSum = body.sources.tmdb.ms + body.sources.weather.ms + body.sources.pokemon.ms;
    assert.equal(body.sumOfSourcesMs, expectedSum);
  });

  it('still returns 200 when one source errors — the other two stay ok', async function () {
    globalThis.fetch = async (url) =>
      routeByHost(String(url), {
        tmdb: () => delayed(10, TRENDING_PAYLOAD),
        weather: () => {
          throw new Error('network down');
        },
        pokemon: () => delayed(10, POKEMON_PAYLOAD)
      });

    const resp = await handleRequest(fetchEvent('/api/dashboard'));
    assert.equal(resp.status, 200);

    const body = await resp.json();
    assert.equal(body.sources.tmdb.status, 'ok');
    assert.equal(body.sources.pokemon.status, 'ok');
    assert.equal(body.sources.weather.status, 'error');
    assert.equal(body.sources.weather.data, null);
    assert.equal(body.sources.weather.error, 'upstream');
  });

  it('a source that exceeds the 1500ms budget reports ms≈1500 and error "timeout"', async function () {
    this.timeout(4000);

    globalThis.fetch = async (url) =>
      routeByHost(String(url), {
        tmdb: () => delayed(10, TRENDING_PAYLOAD),
        weather: () => delayed(10, WEATHER_PAYLOAD),
        pokemon: () => delayed(3000, POKEMON_PAYLOAD) // never wins the race against the 1500ms timer
      });

    const resp = await handleRequest(fetchEvent('/api/dashboard'));
    assert.equal(resp.status, 200);

    const body = await resp.json();
    assert.equal(body.sources.pokemon.status, 'error');
    assert.equal(body.sources.pokemon.error, 'timeout');
    assert.ok(
      body.sources.pokemon.ms >= 1490 && body.sources.pokemon.ms <= 1650,
      `expected ms close to 1500, got ${body.sources.pokemon.ms}`
    );
  });

  it('uses lat/lon from the query when present', async function () {
    let weatherUrl = null;
    globalThis.fetch = async (url) =>
      routeByHost(String(url), {
        tmdb: () => delayed(5, TRENDING_PAYLOAD),
        weather: () => {
          weatherUrl = String(url);
          return delayed(5, WEATHER_PAYLOAD);
        },
        pokemon: () => delayed(5, POKEMON_PAYLOAD)
      });

    await handleRequest(fetchEvent('/api/dashboard?lat=40.7&lon=-74.0'));
    assert.ok(weatherUrl.includes('latitude=40.7'));
    assert.ok(weatherUrl.includes('longitude=-74'));
  });

  it('falls back to event.client.geo, then Cary NC, when lat/lon are absent', async function () {
    let weatherUrl = null;
    globalThis.fetch = async (url) =>
      routeByHost(String(url), {
        tmdb: () => delayed(5, TRENDING_PAYLOAD),
        weather: () => {
          weatherUrl = String(url);
          return delayed(5, WEATHER_PAYLOAD);
        },
        pokemon: () => delayed(5, POKEMON_PAYLOAD)
      });

    await handleRequest(fetchEvent('/api/dashboard', { geo: { latitude: 51.5, longitude: -0.12 } }));
    assert.ok(weatherUrl.includes('latitude=51.5'));
    assert.ok(weatherUrl.includes('longitude=-0.12'));

    await handleRequest(fetchEvent('/api/dashboard')); // no geo at all
    assert.ok(weatherUrl.includes('latitude=35.79'));
    assert.ok(weatherUrl.includes('longitude=-78.78'));
  });

  it('reports Server-Timing for every source plus edge', async function () {
    globalThis.fetch = async (url) =>
      routeByHost(String(url), {
        tmdb: () => delayed(5, TRENDING_PAYLOAD),
        weather: () => delayed(5, WEATHER_PAYLOAD),
        pokemon: () => delayed(5, POKEMON_PAYLOAD)
      });

    const resp = await handleRequest(fetchEvent('/api/dashboard'));
    assert.match(
      resp.headers.get('Server-Timing'),
      /^tmdb;dur=\d+, weather;dur=\d+, pokemon;dur=\d+, edge;dur=\d+$/
    );
  });
});
