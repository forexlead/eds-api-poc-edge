# Cache Lab — `/api/cache/*` contract

Four routes, each demonstrating one CDN caching behaviour on the Adobe-managed CDN in front of the
sandbox dev environment (`aem-cloud-on-dentsu-dev-gradial`, e1522172). Everything in `docs/api-contract.md` → "Common response rules" applies
(CORS allowlist, `Timing-Allow-Origin: *`, `Vary: Origin`, `Access-Control-Expose-Headers`,
`OPTIONS` → 204, error envelope) unless this page says otherwise.

Routing: `config/cdn.yaml` rule `route-api-cache-lab` sends `^/api/cache/(product|stock|mypage|quote)$`
to `edgefunction-api-poc` **CDN-cacheable** (no `skipCache`). The CDN must be in the path, or none of
this demonstrates anything. Each route controls its own caching with `Surrogate-Control`.

Code: `src/routes/cache-lab.js`. Tests: `test/cache-lab-test.js`.

## Headers on every Cache Lab route

| Header | Value |
|---|---|
| `X-Pattern` | `cache-lab` |
| `X-Backend-Calls` | backend fetches that left the function in this execution (`0` on a full fetch-cache hit) — see "How `X-Backend-Calls` is counted" |
| `X-Cache-Mode` | `cached` on product/stock/quote; `no-store` on mypage |
| `X-Fetched-At` | product/stock: upstream TMDB `Date`; quote: the time the quote was generated; mypage: omitted (three upstreams — per-ingredient dates are in the body) |
| `Server-Timing` | one entry per backend call plus `edge` |
| `Cache-Control` | `public, max-age=0, must-revalidate` (browser always asks the edge), except mypage → `no-store` |
| `Access-Control-Expose-Headers` | the common list, which includes `Age`, `X-Cache-Mode`, `X-Fetched-At`, `X-Backend-Calls` |

The CDN strips `Surrogate-Control` and `Surrogate-Key` from client responses (see `docs/purge-demo.md`);
verify those in the unit tests or under local `serve`. From a client, watch `age`, `x-cache`,
`X-Fetched-At`, `X-Backend-Calls` and `Server-Timing`.

## Upstream URLs are deliberately distinct

The function's fetch cache is keyed by URL. If two routes fetched the same URL with different TTLs
or surrogate keys, whichever stored the object first would answer the other's lookups. So no Cache Lab
fetch reuses a URL another route fetches (e.g. `/api/movie` uses `/3/movie/<id>`):

| Ingredient | TMDB URL | Fetch cache |
|---|---|---|
| product | `/3/movie/<id>?language=en-US` | ttl 3600, swr 300, key `product-<id> products` |
| stock | `/3/movie/<id>/release_dates` | ttl 20, swr 120, key `stock-<id> stock` |
| mypage product | `/3/movie/603?append_to_response=keywords` | ttl 60, key `mypage product-603` |
| mypage prices | `/3/movie/603/watch/providers` | ttl 60, key `mypage prices` |
| mypage top sellers | `/3/trending/movie/week` | ttl 60, key `mypage top-sellers` |

---

## `GET /api/cache/product?id=<n>` — long TTL, purgeable

Backend: TMDB movie record (a stand-in catalogue item).

- `Surrogate-Control: max-age=3600, stale-while-revalidate=300`
- `Surrogate-Key: product-<id> products`
- Fetch cache: ttl 3600, swr 300, same surrogate key.

```json
{ "pattern": "cache-lab", "route": "product", "id": 603, "title": "The Matrix", "year": 1999,
  "poster": "https://image.tmdb.org/t/p/w185/<path>.jpg", "fetchedAt": "Tue, 29 Sep 2026 13:28:01 GMT" }
```

`id` must be numeric → else `400 BAD_REQUEST`. Unknown id → `404 NOT_FOUND`. TMDB unreachable → `502 UPSTREAM`.
Purge: `aio aem edge-functions purge-cache api-poc -k product-603 [--soft]` (one item) or `-k products` (all).

## `GET /api/cache/stock?id=<n>` — short TTL, stale-while-revalidate

- `Surrogate-Control: max-age=20, stale-while-revalidate=120`
- `Surrogate-Key: stock-<id> stock`
- Fetch cache: ttl 20, swr 120.

The upstream `Date` **is** the stock reading, so staleness shows in the body, not just in `Age`:

```json
{ "pattern": "cache-lab", "route": "stock", "id": 603,
  "reading": "Tue, 29 Sep 2026 13:28:02 GMT", "readingAgeSeconds": 1 }
```

`readingAgeSeconds` = seconds between `reading` and when the function ran. On a CDN hit the body is the
stored one, so compare `reading` with the client's clock (or the response `date`) for true staleness.
Errors as for product.

## `GET /api/cache/mypage?tier=gold|silver|bronze` — uncacheable response, cached ingredients

The response is never cached anywhere: `Cache-Control: no-store`, `Surrogate-Control: no-store`,
**no** `Surrogate-Key`. Every request reaches the function. Internally it fetches three shared
ingredients (same for every tier), each fetch-cached with ttl 60, and composes a per-tier page:

| tier | discountPct | offers shown | top sellers |
|---|---|---|---|
| gold | 20 | buy, rent, flatrate | 10 |
| silver | 10 | buy, rent | 5 |
| bronze | 0 | buy | 3 |

(The "price table" stand-in is TMDB's US watch providers per offer type; the discount is a label.)

```json
{
  "pattern": "cache-lab", "route": "mypage", "tier": "silver",
  "page": {
    "product": { "id": 603, "title": "The Matrix", "year": 1999, "poster": "..." },
    "discountPct": 10,
    "offers": { "buy": ["Apple TV Store", "..."], "rent": ["..."] },
    "topSellers": [ { "id": 1, "title": "..." } ]
  },
  "ingredients": {
    "product":    { "cache": "miss", "fetchedAt": "Tue, 29 Sep 2026 13:28:02 GMT", "ms": 151, "status": "ok" },
    "prices":     { "cache": "hit",  "fetchedAt": "Tue, 29 Sep 2026 13:28:02 GMT", "ms": 1,   "status": "ok" },
    "topSellers": { "cache": "hit",  "fetchedAt": "Tue, 29 Sep 2026 13:28:02 GMT", "ms": 0,   "status": "ok" }
  }
}
```

A failed ingredient becomes `"status": "error", "error": "timeout|upstream|upstream <status>"` and its
`page` field is `null`; the response is still `200`. Missing/unknown `tier` → `400 BAD_REQUEST` (also `no-store`).
`Server-Timing: product;dur=…, prices;dur=…, topSellers;dur=…, edge;dur=…`.

## `GET /api/cache/quote?break=0|1` — stale-if-error

No backend: the function generates the quote and stamps it with the time it was made.

- `Surrogate-Control: max-age=10, stale-if-error=86400` (no stale-while-revalidate)
- `Surrogate-Key: quote`

```json
{ "pattern": "cache-lab", "route": "quote", "symbol": "POC", "price": 148.3,
  "quotedAt": "Tue, 29 Sep 2026 13:28:03 GMT" }
```

`break=1` makes the function itself answer `503` (`{ "error": { "code": "UPSTREAM", ... } }`, with
`Cache-Control: no-store`, `Surrogate-Control: no-store`), so the CDN sees an origin error. `break`
absent = `0`; any other value → `400`. **Through the Adobe CDN, clients never see that JSON:** the CDN
replaces an origin 503 with its own HTML error page (`content-type: text/html`). Observed on dev,
2026-09-29 — see the proof pass below.

**Cache-key caveat.** The query string is part of the CDN cache key, so `?break=1` is a *different*
object from `/api/cache/quote`. It has never held a good copy, so there is nothing stale to serve and
it can't exercise `stale-if-error` for the plain URL. The function therefore also honours a request
header **`X-Break: 1`**, which leaves the cache key unchanged: once the plain URL's 10 s TTL has passed,
`curl -H 'X-Break: 1' $BASE/api/cache/quote` forces the CDN's refetch to fail. The CDN does forward
the header to the origin (verified on dev: `X-Break: 1` on a never-requested key returned 503).

Whether the Adobe CDN serves stale on an origin 503 (rather than only on a connection failure) is
undocumented. **Observed on dev, 2026-09-29: it serves the stale copy.** See the proof pass, test 4.

## How `X-Backend-Calls` is counted

It's inferred, not observed. The obvious mechanism, `CacheOverride`'s `beforeSend` hook, which fires
only when a request really goes to the backend, needs the Compute HTTP cache API. This runtime rejects
it: *"HTTP caching API is not enabled for JavaScript; enable it with the --enable-http-cache flag … or
contact support"*. That happened even when built with `--enable-http-cache`, so every fetch using the hook failed.

So a fetch counts as having left the function when it took **≥ 15 ms** (`LEFT_FUNCTION_MS`). This is
the contract's primary cache-hit signal: a fetch-cache hit returns in a few ms, a live TMDB round trip
in tens of ms or more. Failed fetches (timeouts, network errors) are not counted. Local `serve`
(Viceroy) has no fetch cache, so locally every fetch is a miss.

## Observed on the deployed function (package 8, stage env e1511008 debug host, 2026-09-29 — before the move to dev)

These results come from calling the function directly (`edgefunction-p24773-e1511008-api-poc.adobeaemcloud.com`),
with no Adobe CDN in front, so they show the fetch-cache layer only:

- **product: works.** First call was a live TMDB fetch (`tmdb;dur=102`, `X-Backend-Calls: 1`). Every later
  call hit the fetch cache (`tmdb;dur` 1–4 ms, `X-Backend-Calls: 0`) on six different IAD cache nodes, so
  the fetch cache is shared across the POP.
- **stock and mypage: the fetch cache does not hold.** Every call refetched, with a new upstream `Date`.
  Cause, verified for the first fetch: TMDB sits behind CloudFront, which answers with an old `Date` and
  `Age: ~197` (`x-cache: Hit from cloudfront`). Fastly counts that upstream `Age` against the override
  TTL, so an object with `Age` 197 is already expired when stored under ttl 60 (mypage) or ttl 20 + swr 120
  (stock). Product's ttl 3600 absorbs it. Later stock fetches came back with fresh `Date`s and still
  missed; their upstream `Age` wasn't captured, so that part is unexplained.
  Consequence: on the deployed edge, `mypage` shows `X-Backend-Calls: 3` on every call, which defeats that
  route's point. The CDN-level short-TTL behaviour of `stock` doesn't depend on this.
- Without `afterSend`, the function can't strip the upstream `Age` before the object is stored.

## Proof pass — dev environment (`aem-cloud-on-dentsu-dev-gradial`, e1522172), 2026-09-29

Base `https://publish-p24773-e1522172.adobeaemcloud.com`, through the Adobe CDN (POP IAD), requests
from 17:45 to 17:47 UTC. Every request was a GET (`curl -s --compressed -D - -o /dev/null`).

### 1. product ×3 — as expected

| UTC | status | x-cache | age | X-Fetched-At | Server-Timing |
|---|---|---|---|---|---|
| 17:45:06 | 200 | MISS | 0 | 17:45:07 | `tmdb;dur=237, edge;dur=238` |
| 17:45:11 | 200 | HIT | 4 | 17:45:07 | `tmdb;dur=237, edge;dur=238` (stored copy) |
| 17:45:15 | 200 | HIT | 9 | 17:45:07 | `tmdb;dur=237, edge;dur=238` (stored copy) |

### 2. stock — SWR works on id=603; **id=1 as specified doesn't exist**

**Contradiction:** TMDB has no movie 1 (`/3/movie/1/release_dates` → 404), so `/api/cache/stock?id=1` returns
`404 NOT_FOUND`. It carries no `Surrogate-Control`, so the CDN never stores it: all four requests were
`MISS`, `age: 0`. It demonstrates nothing about SWR. (The function's *fetch cache* did store the TMDB 404:
`tmdb;dur` went 98 → 4 → 2 → 1.) The same schedule was run on **id=603** in parallel:

| t | UTC | x-cache | age | reading / X-Fetched-At | Server-Timing |
|---|---|---|---|---|---|
| +0 s | 17:45:15 | MISS | 0 | **13:28:02** (`readingAgeSeconds: 15435`) | `tmdb;dur=259` |
| +13 s | 17:45:28 | HIT | 12 | 13:28:02 | stored |
| +26 s | 17:45:41 | HIT | **25** | 13:28:02 — **stale, served instantly** (age > max-age 20, inside swr 120) | stored |
| +40 s | 17:45:55 | HIT | 14 | **17:45:41** (`readingAgeSeconds: 1`) — newer reading | `tmdb;dur=233` |

The +26 s request got the stale copy and triggered a background refresh at 17:45:41. The +40 s request
got that refreshed object, now 14 s old. That is stale-while-revalidate, as designed.

**Contradiction:** the first reading was over 4 hours old (13:28:02). TMDB's CloudFront served a cached
object with `Age: ~15,400`, so "the stock reading" on a cold start can be hours stale before either of
our caches is involved.

### 3. mypage ×5 — response never cached ✔; ingredient timestamps **not** identical

Every response: `200`, `cache-control: no-store`, `x-cache-mode: no-store`, `x-cache: MISS`, **no `age`
header**. The response itself is never cached. ✔

| # | UTC | tier | product fetchedAt | prices fetchedAt | topSellers fetchedAt | X-Backend-Calls |
|---|---|---|---|---|---|---|
| 1 | 17:45:55 | gold | 17:45:56 | **13:28:02** | 17:45:56 | 3 |
| 2 | 17:45:56 | silver | 17:45:56 | **17:45:57** | 17:45:56 | 1 |
| 3 | 17:45:57 | bronze | 17:45:56 | **17:45:58** | 17:45:56 | 1 |
| 4 | 17:45:58 | gold | 17:45:56 | **17:45:58** | 17:45:56 | 1 |
| 5 | 17:45:58 | silver | 17:45:56 | **17:45:59** | 17:45:56 | 1 |

- **product** and **topSellers**: identical upstream timestamps across all five (fetch-cache hits, 2–4 ms,
  from request 2 on). This is the card C evidence for two of the three ingredients.
- **prices** (`/3/movie/603/watch/providers`) was re-fetched on **every** request, with a different `Date` each
  time (21–391 ms). **The three ingredients are not identical across all five.** Checked directly at
  17:46:41, TMDB's CloudFront returns that URL with `Date: 13:28:02` and `Age: 15519`. Fastly counts the
  upstream `Age` against our 60 s TTL, so that copy is already expired when stored. The later fetches came
  back with fresh `Date`s and *still* didn't stick; that part is unexplained (same as stock on stage).
  Product and topSellers were fresh at CloudFront (`Age: 46`), which is why they cached.
- The `X-Backend-Calls` estimate matched the per-ingredient timings in every response.

### 4. stale-if-error — **the CDN served the stale copy on an origin 503**

| step | UTC | request | status | x-cache | age | quotedAt |
|---|---|---|---|---|---|---|
| a | 17:45:59 | `GET /api/cache/quote` | 200 | MISS | 0 | 17:46:00 |
| b | — | wait 13 s (max-age=10 expires) | | | | |
| c | 17:46:13 | same URL + `X-Break: 1` | **200** | HIT | **13** | 17:46:00 |
| c′ | 17:46:13 | again + `X-Break: 1` | **200** | HIT | **14** | 17:46:00 |
| e | 17:46:14 | same URL, no header | 200 | MISS | 0 | 17:46:14 (new) |
| f | 17:46:14 | `?break=1` (separate key) | **503** | MISS | — | Adobe HTML error page |
| g | 17:46:40 | `?break=0` + `X-Break: 1` (never-requested key) | **503** | MISS | — | Adobe HTML error page |

**Answer: 200 with `age` 13 > 10. The CDN served a stale copy; the error did not pass through.**
Why this is stale-if-error and not something else:
- The route sets no stale-while-revalidate (`max-age=10, stale-if-error=86400`). The plain request at step e
  refetched synchronously (`MISS`, new quote), so the CDN isn't applying a default SWR.
- The CDN forwards `X-Break` to the function: step g, with no stale copy available, got the 503.
- So at step c the refetch reached the function, the function answered 503, and the CDN substituted
  the stale object.

**Contradiction:** when the 503 does pass through (f, g), the client gets **Adobe's HTML error page**, not
our JSON error envelope. The contract's "Errors → `{ "error": … }`" rule doesn't hold for 5xx through this CDN.

### 5. purge by surrogate key — **the key form alone worked**

| UTC | request | 603: x-cache / age / Server-Timing | 550: x-cache / age |
|---|---|---|---|
| 17:47:00 | warm | HIT / 114 / `tmdb;dur=237` | MISS / 0 |
| 17:47:04 | re-check | HIT / 118 | HIT / 4 |
| 17:47:05 | `scripts/purge.sh key product-603` | **HTTP 200** | |
| 17:47:05 | immediately (no sleep) | **MISS / 0 / `tmdb;dur=2`** (refetched) | HIT / 4 (untouched) |
| 17:47:07 | +2 s | HIT / 3 | HIT / 7 |

603 was refetched from the function on the very next request, and 550 stayed cached. **The key form
invalidated the CDN copy**, so the URL form (step 5d) was not needed and wasn't run.

**Contradictions with `docs/purge-demo.md`'s expectations:**
- The purge was soft (`X-AEM-Purge: soft`) and the route has swr 300, but the first request after the purge
  was a synchronous `MISS`. No stale copy was served while it refreshed.
- `X-Fetched-At` did **not** change for 603 (still 17:45:07). A CDN purge doesn't touch the function's
  fetch cache (ttl 3600), so the refetch hit it (`tmdb;dur=2`). A changed `X-Fetched-At` needs the fetch
  cache purged too (`scripts/purge.sh both`). The CDN-level signal is `age`/`x-cache` resetting.

## Proof sequence (re-run)

```bash
BASE=https://publish-p24773-e1522172.adobeaemcloud.com
hdr() { echo "--- $(date -u +%T) $1"; curl -s --compressed -D - -o /dev/null "$BASE$1" "${@:2}" \
  | grep -iE '^(HTTP/|age:|x-cache:|x-fetched-at:|x-backend-calls:|x-cache-mode:|server-timing:|cache-control:)'; }

# product: twice
hdr '/api/cache/product?id=603'; hdr '/api/cache/product?id=603'

# stock: four times across 30 s
for i in 1 2 3 4; do hdr '/api/cache/stock?id=603'; [ $i -lt 4 ] && /bin/sleep 10; done

# mypage: five times across the three tiers
for t in gold silver bronze gold silver; do hdr "/api/cache/mypage?tier=$t"; done

# quote: before and after break
hdr '/api/cache/quote'; /bin/sleep 12
hdr '/api/cache/quote?break=1'                 # separate cache key
hdr '/api/cache/quote' -H 'X-Break: 1'          # same cache key, forced origin error
hdr '/api/cache/quote'
```

Always GET (`curl -s -D - -o /dev/null`), never `curl -I`. The router is GET-only, so HEAD returns 405
wherever it reaches the function directly (local `serve`, the debug host). The public CDN happened to turn
HEAD into GET on 2026-09-29, but don't rely on that.
