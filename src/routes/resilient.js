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

// GET /api/resilient?mode=ok|fail|slow — Pattern 04 Resilient Failover (docs/api-contract.md).
// Fallback chain: live upstream → static snapshot bundled in the function. Always 200.
// (No KV "last-good" tier — sandbox programs have no KV store.) Not cached at either layer:
// the fetch uses CacheOverride("pass"), and cdn.yaml routes this path with skipCache.

import { CacheOverride } from 'fastly:cache-override';
import { TMDB_TOKEN } from '../generated/secrets.js';
import { error, json, serverTiming, timedFetch } from '../lib/http.js';
import STATIC_SNAPSHOT from '../fallback/movie-603.json' with { type: 'json' };

const TMDB_MOVIE_URL = 'https://api.themoviedb.org/3/movie/603';

/** mode → upstream. fail/slow deliberately point away from TMDB to force the fallback. */
const UPSTREAMS = {
  ok: TMDB_MOVIE_URL,
  fail: 'https://httpbin.org/status/500', // guaranteed 500
  slow: 'https://httpbin.org/delay/5' // ~5 s, well past the 1500 ms budget
};

function yearOf(releaseDate) {
  const year = releaseDate ? Number(releaseDate.slice(0, 4)) : NaN;
  return Number.isFinite(year) ? year : null;
}

/** The token goes to TMDB only — never to the httpbin failure endpoints. */
function fetchOptions(url) {
  const headers = { Accept: 'application/json' };
  if (url === TMDB_MOVIE_URL) headers.Authorization = `Bearer ${TMDB_TOKEN}`;
  return { headers, cacheOverride: new CacheOverride('pass') };
}

/**
 * Try the live upstream once.
 * @returns {Promise<{ data: object|null, reason: string|null, ms: number }>}
 */
async function tryLive(url) {
  const { ok, response, ms, error: kind } = await timedFetch(url, fetchOptions(url));
  if (!ok) return { data: null, reason: kind, ms };
  if (!response.ok) return { data: null, reason: `upstream ${response.status}`, ms };
  try {
    const item = await response.json();
    return { data: { id: item.id, title: item.title, year: yearOf(item.release_date) }, reason: null, ms };
  } catch {
    return { data: null, reason: 'upstream', ms };
  }
}

/** GET /api/resilient?mode=ok|fail|slow */
async function resilientHandler(req) {
  const started = Date.now();
  const mode = new URL(req.url).searchParams.get('mode') ?? 'ok';
  const upstream = UPSTREAMS[mode];

  if (!upstream) {
    return error(req, 400, 'BAD_REQUEST', 'mode must be one of ok, fail, slow');
  }

  const live = await tryLive(upstream);
  const served = live.data ? 'live' : 'static';
  if (!live.data) console.error(`resilient: live upstream failed (${live.reason}), serving static`);

  return json(
    req,
    {
      pattern: 'failover',
      served,
      reason: live.reason,
      data: live.data ?? STATIC_SNAPSHOT
    },
    {
      headers: {
        'X-Pattern': 'failover',
        'X-Fallback': served === 'live' ? 'none' : 'static',
        'Server-Timing': serverTiming({ upstream: live.ms, edge: Date.now() - started })
      }
    }
  );
}

export { resilientHandler, UPSTREAMS, STATIC_SNAPSHOT };
