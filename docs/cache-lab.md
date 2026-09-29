# Cache Lab — `/api/cache/*` contract

Four routes, each demonstrating one CDN caching behaviour on the Adobe-managed CDN in front of the
sandbox stage environment. Everything in `docs/api-contract.md` → "Common response rules" applies
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
absent = `0`; any other value → `400`.

**Cache-key caveat.** The query string is part of the CDN cache key, so `?break=1` is a *different*
object from `/api/cache/quote`. It has never held a good copy, so there is nothing stale to serve and
it can't exercise `stale-if-error` for the plain URL. The function therefore also honours a request
header **`X-Break: 1`**, which leaves the cache key unchanged: once the plain URL's 10 s TTL has passed,
`curl -H 'X-Break: 1' $BASE/api/cache/quote` forces the CDN's refetch to fail. That header only matters
if the CDN forwards it to the origin; the curl results show whether it does.

Whether the Adobe CDN serves stale on an origin 503 (rather than only on a connection failure) is
undocumented. **Not yet observed:** until the config pipeline deploys `route-api-cache-lab`, the public
host returns 503 for `/api/cache/*` without reaching the function. Record the answer here after the proof run.

## How `X-Backend-Calls` is counted

It's inferred, not observed. The obvious mechanism, `CacheOverride`'s `beforeSend` hook, which fires
only when a request really goes to the backend, needs the Compute HTTP cache API. This runtime rejects
it: *"HTTP caching API is not enabled for JavaScript; enable it with the --enable-http-cache flag … or
contact support"*. That happened even when built with `--enable-http-cache`, so every fetch using the hook failed.

So a fetch counts as having left the function when it took **≥ 15 ms** (`LEFT_FUNCTION_MS`). This is
the contract's primary cache-hit signal: a fetch-cache hit returns in a few ms, a live TMDB round trip
in tens of ms or more. Failed fetches (timeouts, network errors) are not counted. Local `serve`
(Viceroy) has no fetch cache, so locally every fetch is a miss.

## Observed on the deployed function (package 8, debug host, 2026-09-29)

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

## Proof sequence (run after the config pipeline has deployed `route-api-cache-lab`)

```bash
BASE=https://publish-p24773-e1511008.adobeaemcloud.com
hdr() { echo "--- $(date -u +%T) $1"; curl -sI --compressed "$BASE$1" "${@:2}" \
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

`curl -I` sends HEAD. The CDN turns it into a GET toward the function. Against local `serve` there's
no CDN, and the router answers HEAD with 405, so use `curl -s -D - -o /dev/null` locally.
