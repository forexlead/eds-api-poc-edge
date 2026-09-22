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

// GET /api/movies?q= and GET /api/movie?id= — Pattern 01 Secure Proxy
// (docs/api-contract.md). The TMDB token is read from src/generated/secrets.js (baked in
// at build time — see scripts/gen-secrets.mjs) and attached only as an outbound
// Authorization header. It must never reach a response body, a response header, or a
// console.log line.

import { CacheOverride } from 'fastly:cache-override';
import { TMDB_TOKEN } from '../generated/secrets.js';
import { error, json, serverTiming, timedFetch } from '../lib/http.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const MAX_RESULTS = 10;

/** Cacheable routes only (docs/api-contract.md "Common response rules"). */
const SURROGATE_CONTROL = 'max-age=60, stale-while-revalidate=300, stale-if-error=86400';

/** `<slug(q)>` for the `movies-q-<slug(q)>` surrogate key. */
function slug(text) {
  const s = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'empty';
}

function posterUrl(path) {
  return path ? `https://image.tmdb.org/t/p/w185${path}` : null;
}

function yearOf(releaseDate) {
  const year = releaseDate ? Number(releaseDate.slice(0, 4)) : NaN;
  return Number.isFinite(year) ? year : null;
}

function ratingOf(voteAverage) {
  return typeof voteAverage === 'number' ? Math.round(voteAverage * 10) / 10 : null;
}

/**
 * Passthrough of the upstream `Age` header as `X-Backend-Age` — a supplementary cache-hit
 * signal alongside `X-Fetched-At`. Omitted (not an empty string) when TMDB didn't send one,
 * since `Age` isn't set on every TMDB response even when the request was cached.
 */
function backendAgeHeader(response) {
  const age = response.headers.get('age');
  return age !== null ? { 'X-Backend-Age': age } : {};
}

function toSummary(item) {
  return {
    id: item.id,
    title: item.title,
    year: yearOf(item.release_date),
    rating: ratingOf(item.vote_average),
    poster: posterUrl(item.poster_path)
  };
}

/** Fetch a TMDB path with the shared auth header and fetch-cache settings. */
async function fetchTmdb(path, surrogateKey) {
  return timedFetch(`${TMDB_BASE}${path}`, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}`, Accept: 'application/json' },
    cacheOverride: new CacheOverride('override', { ttl: 60, swr: 300, surrogateKey })
  });
}

/** GET /api/movies?q=<text> */
async function moviesHandler(req) {
  const started = Date.now();
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();

  if (q.length < 1 || q.length > 100) {
    return error(req, 400, 'BAD_REQUEST', 'q is required and must be 1-100 characters');
  }

  const surrogateKey = `movies movies-q-${slug(q)}`;
  const { ok, response, ms, error: kind } = await fetchTmdb(
    `/search/movie?query=${encodeURIComponent(q)}`,
    surrogateKey
  );

  if (!ok || !response.ok) {
    if (kind) console.error(`tmdb search fetch failed: ${kind}`);
    return error(req, 502, 'UPSTREAM', 'Failed to reach the movie search backend', {
      'Server-Timing': serverTiming({ tmdb: ms, edge: Date.now() - started })
    });
  }

  const fetchedAt = response.headers.get('date') ?? '';
  const payload = await response.json();
  const results = (payload.results ?? []).slice(0, MAX_RESULTS).map(toSummary);

  return json(
    req,
    { pattern: 'proxy', query: q, results },
    {
      headers: {
        'X-Pattern': 'proxy',
        'X-Fetched-At': fetchedAt,
        ...backendAgeHeader(response),
        'Surrogate-Control': SURROGATE_CONTROL,
        'Surrogate-Key': surrogateKey,
        'Server-Timing': serverTiming({ tmdb: ms, edge: Date.now() - started })
      }
    }
  );
}

/** GET /api/movie?id=<tmdbId> */
async function movieHandler(req) {
  const started = Date.now();
  const url = new URL(req.url);
  const idParam = url.searchParams.get('id') ?? '';

  if (!/^\d+$/.test(idParam)) {
    return error(req, 400, 'BAD_REQUEST', 'id is required and must be numeric');
  }

  const surrogateKey = `movies movie-${idParam}`;
  const { ok, response, ms, error: kind } = await fetchTmdb(`/movie/${idParam}`, surrogateKey);

  if (ok && response.status === 404) {
    return error(req, 404, 'NOT_FOUND', `No movie with id ${idParam}`, {
      'Server-Timing': serverTiming({ tmdb: ms, edge: Date.now() - started })
    });
  }

  if (!ok || !response.ok) {
    if (kind) console.error(`tmdb movie fetch failed: ${kind}`);
    return error(req, 502, 'UPSTREAM', 'Failed to reach the movie details backend', {
      'Server-Timing': serverTiming({ tmdb: ms, edge: Date.now() - started })
    });
  }

  const fetchedAt = response.headers.get('date') ?? '';
  const item = await response.json();

  return json(
    req,
    {
      pattern: 'proxy',
      id: item.id,
      title: item.title,
      year: yearOf(item.release_date),
      rating: ratingOf(item.vote_average),
      runtime: item.runtime ?? null,
      overview: item.overview ?? '',
      poster: posterUrl(item.poster_path),
      fetchedAt
    },
    {
      headers: {
        'X-Pattern': 'proxy',
        'X-Fetched-At': fetchedAt,
        ...backendAgeHeader(response),
        'Surrogate-Control': SURROGATE_CONTROL,
        'Surrogate-Key': surrogateKey,
        'Server-Timing': serverTiming({ tmdb: ms, edge: Date.now() - started })
      }
    }
  );
}

export { moviesHandler, movieHandler, slug, posterUrl, yearOf, ratingOf, toSummary, backendAgeHeader };
