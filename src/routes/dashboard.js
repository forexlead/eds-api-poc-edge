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

// GET /api/dashboard?lat=&lon= — Pattern 02 Aggregator (docs/api-contract.md).
// Three backends fetched in parallel (Promise.allSettled over timedFetch's own 1500ms
// Promise.race budget); one failing never fails the whole response.
//
// No single upstream response exists for an aggregate of three backends, so — unlike
// movies/movie — this route does not set X-Fetched-At/X-Backend-Age; each source's own
// `ms` in Server-Timing (near-0ms on a fetch-cache hit) is the per-source cache signal.

import { TMDB_TOKEN } from '../generated/secrets.js';
import { fetchCacheOverride } from '../lib/cache.js';
import { cacheHeaders, json, serverTiming, STANDARD_CACHE, timedFetch, wantsFresh } from '../lib/http.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const MAX_TRENDING = 5;
const POKEMON_MAX_ID = 151;

/** Cary, NC — the contract's fallback when neither the query nor client geo has a location. */
const DEFAULT_LAT = 35.79;
const DEFAULT_LON = -78.78;

const SURROGATE_KEY = 'dashboard';

/** Mirrors routes/movies.js's posterUrl — kept local so the two patterns stay decoupled. */
function posterUrl(path) {
  return path ? `https://image.tmdb.org/t/p/w185${path}` : null;
}

/** `null`/missing must fall through, not coerce to 0 — hence the explicit has() check. */
function queryCoord(searchParams, key) {
  if (!searchParams.has(key)) return undefined;
  const value = Number(searchParams.get(key));
  return Number.isFinite(value) ? value : undefined;
}

/**
 * lat/lon precedence: query params, then `event.client.geo`, then Cary NC.
 * @param {URL} url
 * @param {{ latitude?: number, longitude?: number }|null} geo
 */
function resolveCoords(url, geo) {
  const qLat = queryCoord(url.searchParams, 'lat');
  const qLon = queryCoord(url.searchParams, 'lon');
  if (qLat !== undefined && qLon !== undefined) return { lat: qLat, lon: qLon };

  if (Number.isFinite(geo?.latitude) && Number.isFinite(geo?.longitude)) {
    return { lat: geo.latitude, lon: geo.longitude };
  }

  return { lat: DEFAULT_LAT, lon: DEFAULT_LON };
}

function fetchTmdbTrending(fresh) {
  return timedFetch(`${TMDB_BASE}/trending/movie/day`, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}`, Accept: 'application/json' },
    cacheOverride: fetchCacheOverride(fresh, SURROGATE_KEY, STANDARD_CACHE)
  });
}

function fetchWeather(lat, lon, fresh) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,weather_code`;
  return timedFetch(url, {
    cacheOverride: fetchCacheOverride(fresh, SURROGATE_KEY, STANDARD_CACHE)
  });
}

function fetchPokemon(id, fresh) {
  return timedFetch(`https://pokeapi.co/api/v2/pokemon/${id}`, {
    cacheOverride: fetchCacheOverride(fresh, SURROGATE_KEY, STANDARD_CACHE)
  });
}

function transformTmdbTrending(payload) {
  return (payload.results ?? []).slice(0, MAX_TRENDING).map((item) => ({
    id: item.id,
    title: item.title,
    poster: posterUrl(item.poster_path)
  }));
}

function transformWeather(payload) {
  return {
    tempC: payload.current?.temperature_2m ?? null,
    windKph: payload.current?.wind_speed_10m ?? null,
    code: payload.current?.weather_code ?? null
  };
}

function transformPokemon(payload) {
  return {
    id: payload.id,
    name: payload.name,
    sprite: payload.sprites?.front_default ?? null
  };
}

/**
 * Turns one `Promise.allSettled` result (from `timedFetch`, which never itself rejects)
 * into the contract's per-source shape.
 * @param {PromiseSettledResult<Awaited<ReturnType<typeof timedFetch>>>} settled
 * @param {(payload: unknown) => unknown} transform
 */
async function toSource(settled, transform) {
  if (settled.status !== 'fulfilled') {
    return { status: 'error', ms: null, data: null, error: 'upstream' };
  }

  const { ok, response, ms, error: kind } = settled.value;
  if (!ok) {
    return { status: 'error', ms, data: null, error: kind };
  }
  if (!response.ok) {
    return { status: 'error', ms, data: null, error: `upstream ${response.status}` };
  }

  try {
    const payload = await response.json();
    return { status: 'ok', ms, data: transform(payload) };
  } catch {
    return { status: 'error', ms, data: null, error: 'upstream' };
  }
}

/** GET /api/dashboard?lat=<n>&lon=<n> */
async function dashboardHandler(req, ctx = {}) {
  const started = Date.now();
  const url = new URL(req.url);
  const { lat, lon } = resolveCoords(url, ctx.geo);
  const fresh = wantsFresh(url);
  const pokemonId = 1 + Math.floor(Math.random() * POKEMON_MAX_ID);

  const settled = await Promise.allSettled([
    fetchTmdbTrending(fresh),
    fetchWeather(lat, lon, fresh),
    fetchPokemon(pokemonId, fresh)
  ]);

  const [tmdb, weather, pokemon] = await Promise.all([
    toSource(settled[0], transformTmdbTrending),
    toSource(settled[1], transformWeather),
    toSource(settled[2], transformPokemon)
  ]);

  const totalMs = Date.now() - started;
  const sumOfSourcesMs = [tmdb, weather, pokemon].reduce(
    (sum, source) => sum + (Number.isFinite(source.ms) ? source.ms : 0),
    0
  );

  return json(
    req,
    {
      pattern: 'aggregate',
      totalMs,
      sumOfSourcesMs,
      sources: { tmdb, weather, pokemon }
    },
    {
      headers: {
        'X-Pattern': 'aggregate',
        ...cacheHeaders(fresh, STANDARD_CACHE),
        'Surrogate-Key': SURROGATE_KEY,
        'Server-Timing': serverTiming({
          tmdb: tmdb.ms,
          weather: weather.ms,
          pokemon: pokemon.ms,
          edge: totalMs
        })
      }
    }
  );
}

export {
  dashboardHandler,
  resolveCoords,
  toSource,
  transformTmdbTrending,
  transformWeather,
  transformPokemon,
  DEFAULT_LAT,
  DEFAULT_LON
};
