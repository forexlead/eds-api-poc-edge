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

// GET /api/lite?id=<1-1025> — Pattern 03 Transformer (docs/api-contract.md).
// Fetches the full PokeAPI payload (~200-400 KB), measures its raw byte length once, and
// returns a small transformed subset — X-Original-Bytes/X-Transformed-Bytes make the
// reduction visible to the caller.

import { fetchCacheOverride } from '../lib/cache.js';
import { cacheHeaders, error, json, serverTiming, timedFetch, wantsFresh } from '../lib/http.js';

const POKEAPI_BASE = 'https://pokeapi.co/api/v2';
const MIN_ID = 1;
const MAX_ID = 1025;

const STAT_NAMES = ['hp', 'attack', 'defense', 'speed'];

/** `X-Backend-Age` passthrough, same convention as routes/movies.js. */
function backendAgeHeader(response) {
  const age = response.headers.get('age');
  return age !== null ? { 'X-Backend-Age': age } : {};
}

/** `[{ stat: { name: 'hp' }, base_stat: 35 }, ...]` -> `{ hp: 35, attack: 55, ... }` */
function pickStats(rawStats) {
  const byName = Object.fromEntries((rawStats ?? []).map((s) => [s.stat?.name, s.base_stat]));
  return Object.fromEntries(STAT_NAMES.map((name) => [name, byName[name] ?? null]));
}

function transform(payload) {
  return {
    pattern: 'transform',
    id: payload.id,
    name: payload.name,
    types: (payload.types ?? []).map((t) => t.type?.name).filter(Boolean),
    sprite: payload.sprites?.front_default ?? null,
    stats: pickStats(payload.stats)
  };
}

function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

/** GET /api/lite?id=<1-1025> */
async function liteHandler(req) {
  const started = Date.now();
  const url = new URL(req.url);
  const idParam = url.searchParams.get('id') ?? '';

  if (!/^\d+$/.test(idParam) || Number(idParam) < MIN_ID || Number(idParam) > MAX_ID) {
    return error(req, 400, 'BAD_REQUEST', `id is required and must be between ${MIN_ID} and ${MAX_ID}`);
  }
  const id = Number(idParam);
  const surrogateKey = `pokemon pokemon-${id}`;
  const fresh = wantsFresh(url);

  const { ok, response, ms, error: kind } = await timedFetch(`${POKEAPI_BASE}/pokemon/${id}`, {
    cacheOverride: fetchCacheOverride(fresh, surrogateKey)
  });

  if (ok && response.status === 404) {
    return error(req, 404, 'NOT_FOUND', `No pokemon with id ${id}`, {
      'Server-Timing': serverTiming({ pokemon: ms, edge: Date.now() - started })
    });
  }

  if (!ok || !response.ok) {
    if (kind) console.error(`pokeapi fetch failed: ${kind}`);
    return error(req, 502, 'UPSTREAM', 'Failed to reach the pokemon backend', {
      'Server-Timing': serverTiming({ pokemon: ms, edge: Date.now() - started })
    });
  }

  const fetchedAt = response.headers.get('date') ?? '';
  const rawBuffer = await response.arrayBuffer();
  const originalBytes = rawBuffer.byteLength;
  const payload = JSON.parse(new TextDecoder().decode(rawBuffer));

  const body = transform(payload);
  const transformedBytes = byteLength(JSON.stringify(body));

  return json(req, body, {
    headers: {
      'X-Pattern': 'transform',
      'X-Original-Bytes': String(originalBytes),
      'X-Transformed-Bytes': String(transformedBytes),
      'X-Fetched-At': fetchedAt,
      ...backendAgeHeader(response),
      ...cacheHeaders(fresh),
      'Surrogate-Key': surrogateKey,
      'Server-Timing': serverTiming({ pokemon: ms, edge: Date.now() - started })
    }
  });
}

export { liteHandler, transform, pickStats, MIN_ID, MAX_ID };
