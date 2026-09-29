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

// GET /api/cache/{product,stock,mypage,quote} — the Cache Lab (docs/cache-lab.md).
// Each route demonstrates one CDN caching behaviour. TMDB stands in for a catalogue; the
// token is attached only as an outbound Authorization header, never echoed back.
//
// Every TMDB URL here is distinct from the ones other routes fetch (e.g. /api/movie's
// /movie/<id>): the fetch cache is keyed by URL, so sharing one would let an object stored
// under another route's TTL and surrogate keys answer this route's lookups.

import { TMDB_TOKEN } from '../generated/secrets.js';
import { fetchCacheOverride } from '../lib/cache.js';
import { cacheHeaders, error, json, serverTiming, timedFetch } from '../lib/http.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';

const PRODUCT_CACHE = Object.freeze({ ttl: 3600, swr: 300 });
const STOCK_CACHE = Object.freeze({ ttl: 20, swr: 120 });
const MYPAGE_INGREDIENT_CACHE = Object.freeze({ ttl: 60 });
const QUOTE_CACHE = Object.freeze({ ttl: 10, sie: 86400 });

/** mypage composes one fixed catalogue item; tiers change what is shown, not what is fetched. */
const MYPAGE_PRODUCT_ID = 603;

const TIERS = {
  gold: { discountPct: 20, topSellers: 10, offers: ['buy', 'rent', 'flatrate'] },
  silver: { discountPct: 10, topSellers: 5, offers: ['buy', 'rent'] },
  bronze: { discountPct: 0, topSellers: 3, offers: ['buy'] }
};

const PATTERN = 'cache-lab';

/**
 * A fetch at or above this many ms is counted as having left the function. The runtime gives
 * no hit/miss flag (the beforeSend hook that would is unavailable — see lib/cache.js), so this
 * is the contract's primary cache-hit signal: a fetch-cache hit returns in a few ms, a live
 * TMDB round trip takes tens of ms or more.
 */
const LEFT_FUNCTION_MS = 15;

const NO_STORE = {
  'Cache-Control': 'no-store',
  'Surrogate-Control': 'no-store',
  'X-Cache-Mode': 'no-store'
};

function posterUrl(path) {
  return path ? `https://image.tmdb.org/t/p/w185${path}` : null;
}

function yearOf(releaseDate) {
  const year = releaseDate ? Number(releaseDate.slice(0, 4)) : NaN;
  return Number.isFinite(year) ? year : null;
}

/** Counts fetches that left the function in this execution (per LEFT_FUNCTION_MS). */
function backendCounter() {
  let calls = 0;
  return {
    add: () => {
      calls += 1;
    },
    get calls() {
      return calls;
    }
  };
}

/**
 * One TMDB fetch through the fetch cache. `cache` is `miss` when it went to TMDB, `hit` when
 * the fetch cache answered — inferred from its duration (LEFT_FUNCTION_MS). A fetch that
 * failed before reaching TMDB isn't counted.
 */
async function fetchTmdb(path, surrogateKey, policy, counter) {
  const result = await timedFetch(`${TMDB_BASE}${path}`, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}`, Accept: 'application/json' },
    cacheOverride: fetchCacheOverride(false, surrogateKey, policy)
  });
  const left = result.ok && result.ms >= LEFT_FUNCTION_MS;
  if (left) counter.add();
  return { ...result, cache: left ? 'miss' : 'hit' };
}

function numericId(req) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  return /^\d+$/.test(id) ? id : null;
}

function secondsSince(httpDate, now = Date.now()) {
  const at = Date.parse(httpDate);
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null;
}

/** Upstream failure → 404 or 502 envelope; null when the fetch succeeded. */
function upstreamError(req, { ok, response, ms, error: kind }, what, id, started, counter) {
  const headers = {
    'X-Backend-Calls': String(counter.calls),
    'Server-Timing': serverTiming({ tmdb: ms, edge: Date.now() - started })
  };
  if (ok && response.status === 404) {
    return error(req, 404, 'NOT_FOUND', `No ${what} with id ${id}`, headers);
  }
  if (!ok || !response.ok) {
    if (kind) console.error(`cache-lab ${what} fetch failed: ${kind}`);
    return error(req, 502, 'UPSTREAM', `Failed to reach the ${what} backend`, headers);
  }
  return null;
}

/** GET /api/cache/product?id=<n> — long TTL, purgeable by `product-<id>`. */
async function productHandler(req) {
  const started = Date.now();
  const id = numericId(req);
  if (!id) return error(req, 400, 'BAD_REQUEST', 'id is required and must be numeric');

  const counter = backendCounter();
  const surrogateKey = `product-${id} products`;
  const result = await fetchTmdb(`/movie/${id}?language=en-US`, surrogateKey, PRODUCT_CACHE, counter);
  const failed = upstreamError(req, result, 'product', id, started, counter);
  if (failed) return failed;

  const fetchedAt = result.response.headers.get('date') ?? '';
  const item = await result.response.json();

  return json(
    req,
    {
      pattern: PATTERN,
      route: 'product',
      id: item.id,
      title: item.title,
      year: yearOf(item.release_date),
      poster: posterUrl(item.poster_path),
      fetchedAt
    },
    {
      headers: {
        'X-Pattern': PATTERN,
        'X-Fetched-At': fetchedAt,
        'X-Backend-Calls': String(counter.calls),
        ...cacheHeaders(false, PRODUCT_CACHE),
        'Surrogate-Key': surrogateKey,
        'Server-Timing': serverTiming({ tmdb: result.ms, edge: Date.now() - started })
      }
    }
  );
}

/**
 * GET /api/cache/stock?id=<n> — short TTL + stale-while-revalidate. The "stock reading" is the
 * upstream Date, so a stale copy is visible in the body as well as in `Age`.
 */
async function stockHandler(req) {
  const started = Date.now();
  const id = numericId(req);
  if (!id) return error(req, 400, 'BAD_REQUEST', 'id is required and must be numeric');

  const counter = backendCounter();
  const surrogateKey = `stock-${id} stock`;
  const result = await fetchTmdb(`/movie/${id}/release_dates`, surrogateKey, STOCK_CACHE, counter);
  const failed = upstreamError(req, result, 'stock', id, started, counter);
  if (failed) return failed;

  const reading = result.response.headers.get('date') ?? '';
  // Only the Date matters here; drain the body so the connection is released.
  await result.response.arrayBuffer();

  return json(
    req,
    {
      pattern: PATTERN,
      route: 'stock',
      id: Number(id),
      reading,
      readingAgeSeconds: secondsSince(reading)
    },
    {
      headers: {
        'X-Pattern': PATTERN,
        'X-Fetched-At': reading,
        'X-Backend-Calls': String(counter.calls),
        ...cacheHeaders(false, STOCK_CACHE),
        'Surrogate-Key': surrogateKey,
        'Server-Timing': serverTiming({ tmdb: result.ms, edge: Date.now() - started })
      }
    }
  );
}

/** One mypage ingredient → { status, cache, fetchedAt, ms, data }. */
async function ingredient(result, transform) {
  const base = {
    cache: result.cache,
    fetchedAt: result.response?.headers.get('date') ?? null,
    ms: result.ms
  };
  if (!result.ok) return { ...base, status: 'error', data: null, error: result.error };
  if (!result.response.ok) {
    return { ...base, status: 'error', data: null, error: `upstream ${result.response.status}` };
  }
  try {
    return { ...base, status: 'ok', data: transform(await result.response.json()) };
  } catch {
    return { ...base, status: 'error', data: null, error: 'upstream' };
  }
}

function transformProduct(item) {
  return { id: item.id, title: item.title, year: yearOf(item.release_date), poster: posterUrl(item.poster_path) };
}

/** TMDB watch providers (US) stand in for a price table: offer type → provider names. */
function transformPrices(payload) {
  const us = payload.results?.US ?? {};
  const names = (list) => (list ?? []).map((p) => p.provider_name);
  return { buy: names(us.buy), rent: names(us.rent), flatrate: names(us.flatrate) };
}

function transformTopSellers(payload) {
  return (payload.results ?? []).map((item) => ({ id: item.id, title: item.title }));
}

/**
 * GET /api/cache/mypage?tier=gold|silver|bronze — the response is never cached; the three
 * shared ingredients are, so repeat calls (any tier) cost fewer backend fetches.
 */
async function mypageHandler(req) {
  const started = Date.now();
  const tierName = new URL(req.url).searchParams.get('tier') ?? '';
  const tier = TIERS[tierName];
  if (!tier) {
    return error(req, 400, 'BAD_REQUEST', 'tier must be one of gold, silver, bronze', NO_STORE);
  }

  const counter = backendCounter();
  const id = MYPAGE_PRODUCT_ID;
  const [product, prices, topSellers] = await Promise.all([
    fetchTmdb(`/movie/${id}?append_to_response=keywords`, `mypage product-${id}`, MYPAGE_INGREDIENT_CACHE, counter),
    fetchTmdb(`/movie/${id}/watch/providers`, 'mypage prices', MYPAGE_INGREDIENT_CACHE, counter),
    fetchTmdb('/trending/movie/week', 'mypage top-sellers', MYPAGE_INGREDIENT_CACHE, counter)
  ]).then((results) =>
    Promise.all([
      ingredient(results[0], transformProduct),
      ingredient(results[1], transformPrices),
      ingredient(results[2], transformTopSellers)
    ])
  );

  const offers = prices.data
    ? Object.fromEntries(tier.offers.map((kind) => [kind, prices.data[kind]]))
    : null;

  return json(
    req,
    {
      pattern: PATTERN,
      route: 'mypage',
      tier: tierName,
      page: {
        product: product.data,
        discountPct: tier.discountPct,
        offers,
        topSellers: topSellers.data ? topSellers.data.slice(0, tier.topSellers) : null
      },
      ingredients: {
        product: { ...product, data: undefined },
        prices: { ...prices, data: undefined },
        topSellers: { ...topSellers, data: undefined }
      }
    },
    {
      headers: {
        'X-Pattern': PATTERN,
        'X-Backend-Calls': String(counter.calls),
        ...NO_STORE,
        'Server-Timing': serverTiming({
          product: product.ms,
          prices: prices.ms,
          topSellers: topSellers.ms,
          edge: Date.now() - started
        })
      }
    }
  );
}

/**
 * GET /api/cache/quote?break=0|1 — stale-if-error. No backend: the quote is generated here,
 * stamped with the time it was made. `break=1` (or request header `X-Break: 1`, which leaves
 * the CDN cache key unchanged) makes the function itself answer 503, so the CDN sees an
 * origin error.
 */
async function quoteHandler(req) {
  const started = Date.now();
  const breakParam = new URL(req.url).searchParams.get('break') ?? '0';
  if (breakParam !== '0' && breakParam !== '1') {
    return error(req, 400, 'BAD_REQUEST', 'break must be 0 or 1');
  }

  const timing = { 'Server-Timing': serverTiming({ edge: Date.now() - started }), 'X-Backend-Calls': '0' };

  if (breakParam === '1' || req.headers.get('X-Break') === '1') {
    return error(req, 503, 'UPSTREAM', 'Quote service deliberately unavailable (break)', {
      'X-Pattern': PATTERN,
      'Cache-Control': 'no-store',
      'Surrogate-Control': 'no-store',
      ...timing
    });
  }

  const quotedAt = new Date(started).toUTCString();
  // Deterministic in the quote time, so two different copies are visibly different.
  const price = Math.round((100 + (Math.floor(started / 1000) % 600) / 10) * 100) / 100;

  return json(
    req,
    { pattern: PATTERN, route: 'quote', symbol: 'POC', price, quotedAt },
    {
      headers: {
        'X-Pattern': PATTERN,
        'X-Fetched-At': quotedAt,
        ...cacheHeaders(false, QUOTE_CACHE),
        'Surrogate-Key': 'quote',
        ...timing
      }
    }
  );
}

export {
  productHandler,
  stockHandler,
  mypageHandler,
  quoteHandler,
  PRODUCT_CACHE,
  STOCK_CACHE,
  MYPAGE_INGREDIENT_CACHE,
  QUOTE_CACHE,
  TIERS,
  LEFT_FUNCTION_MS
};
