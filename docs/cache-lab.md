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
| `X-Backend-Calls` | this execution's backend fetches that Fastly's cache didn't answer (`0` when every fetch was a cache hit) — see "How `X-Backend-Calls` is counted" |
| `X-Cache-Mode` | `cached` on product/stock/quote; `no-store` on mypage |
| `X-Fetched-At` | product: upstream TMDB `Date`; stock: the reading time (`readingAt`, function-generated); quote: the time the quote was generated; mypage: omitted (three upstreams — per-ingredient dates are in the body) |
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
| stock (feed, shared by every SKU) | `/3/movie/603/release_dates` | ttl 20, swr 120, key `stock stock-feed` |
| mypage product | `/3/movie/603?append_to_response=keywords` | ttl 60, key `mypage product-603` |
| mypage prices | `/3/movie/603/watch/providers`, sent with `Accept-Encoding: gzip` (+ `decompressGzip`), see F3 | ttl 60, key `mypage prices` |
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
- Fetch cache: ttl 20, swr 120, on a single feed call shared by every SKU.

The reading is generated **by the function when it builds the response**: a synthetic stock `level`
plus `readingAt`. A CDN-cached copy keeps its old reading, and a refreshed one shows a new `readingAt`
(and usually a new level). Compare `readingAt` with the response `date` to see how stale a copy is.

```json
{ "pattern": "cache-lab", "route": "stock", "id": 1, "level": 421,
  "readingAt": "Tue, 29 Sep 2026 18:01:08 GMT" }
```

`id` is the SKU and any numeric id works. The backend call (a stand-in warehouse feed) always uses
`/3/movie/603/release_dates`, an id TMDB actually has. (p9d used `id=1`, which TMDB doesn't have, and got
404s.) The upstream `Date` is deliberately **not** the reading: in p9d, TMDB's CloudFront returned a
copy over 4 hours old, which says nothing about our caches. Non-numeric `id` → `400`; feed unreachable → `502`.

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

`X-Backend-Calls` counts this execution's fetches that **Fastly's cache did not answer**, i.e. the ones
that went on to TMDB. Each ingredient's `cache` (`hit`/`miss`) in the mypage body uses the same signal.

**Signal: Fastly's own token at the end of the fetch response's `x-cache`.** Fastly appends its cache
state after any upstream value, e.g. `Hit from cloudfront, HIT` / `Hit from cloudfront, MISS` (found with
temporary instrumentation, F4). The last comma-separated token is read if it is exactly `HIT`, `MISS` or
`PASS` (optionally suffixed, e.g. `HIT-STALE`). `HIT` means a cache hit; `MISS` and `PASS` mean it went to
the backend. CloudFront's own `Hit from cloudfront` doesn't match, so it can't be mistaken for Fastly's.

**Fallback, only when that token is absent** (e.g. local `serve`/Viceroy): a fetch taking ≥ 15 ms
(`LEFT_FUNCTION_MS`) counts as a miss. This was the original method, and on the edge it was wrong: hits
served by another cache node took 21–236 ms and were counted as backend calls (F4).

Why not the direct mechanism: `CacheOverride`'s `beforeSend` hook fires only when a request really
goes to the backend, but it needs the Compute HTTP cache API. This runtime rejects that (*"HTTP caching
API is not enabled for JavaScript; enable it with the --enable-http-cache flag … or contact support"*),
even when built with that flag, and the fetch fails. Failed fetches (timeouts, network errors) are not counted.

Verified on dev, package 5, 2026-09-29 ~18:16 UTC:
- **Same-node hits:** on the debug host, a never-fetched `product?id=77` counted `1` (`tmdb;dur=34`), then
  `0` on five 2–3 ms hits across five nodes. A stored object doesn't replay its original `MISS`.
- **Remote hits:** five mypage visitors all counted `0`, every ingredient `hit`, including one visitor
  whose fetches took ~400 ms. The duration rule would have reported `3` for each.

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

## Findings (as of 2026-09-29, dev e1522172)

### F1. A 5xx through this CDN returns Adobe's HTML error page, so our JSON error contract doesn't hold for 5xx

When the function answers 503 and the CDN has no stale copy to substitute, the client gets
`content-type: text/html`, an Adobe error page (`errors.adobeaemcloud.com` assets), not
`{ "error": { "code": …, "message": … } }`. Seen on `?break=1` and on `?break=0` + `X-Break: 1` (proof pass,
test 4). The contract's error envelope holds for the 4xx we emit (400/404, which pass through as JSON),
**not for 5xx**. Browser code calling these routes must handle a non-JSON 5xx body. Not yet checked: a
502 from the other routes, which presumably behaves the same.

### F2. A CDN purge doesn't touch the function's fetch cache, so the demo command is `purge.sh both`, not `key`

`scripts/purge.sh key product-603` invalidated the CDN copy (next request `MISS`, `age: 0`), but the
refetch hit the function's fetch cache (`tmdb;dur=2`, `X-Fetched-At` unchanged at 17:45:07). To show a
genuinely new upstream fetch, purge both layers:

```bash
./scripts/purge.sh both product-603 "/api/cache/product?id=603"
```

(`aio aem edge-functions purge-cache api-poc -k product-603 --soft` for the fetch cache, then the CDN purge.)
`key`/`url` alone demonstrate CDN invalidation only. Watch `age`/`x-cache`, not `X-Fetched-At`.

### F3. mypage `prices` doesn't stay in the fetch cache: not Set-Cookie or private — an old upstream copy per encoding

Hypothesis tested: *a `Set-Cookie` or `Cache-Control: private` on the prices upstream makes Fastly refuse
to store it.* **Ruled out.** `GET /3/movie/603/watch/providers` headers at 17:59 UTC:

| header | prices (never cached) | product / topSellers (cached) |
|---|---|---|
| `Cache-Control` | `public, max-age=21803` | `public, max-age=14429` / `public, max-age=600` |
| `Set-Cookie` | none | none |
| `Vary` | `Accept-Encoding`, `Origin` | same |
| `Age` | **16280** (`Date: 13:28:02`) | 806 / absent (fresh at time of fetch) |

The difference is `Age`. TMDB's CloudFront keeps a **separate copy per `Accept-Encoding`**. Requested with
`Accept-Encoding: gzip`, prices came back fresh (`Age` 1–7, `Date` 17:59:40). Requested without it, it came
back as the 13:28:02 copy with `Age: 16306`. Fastly counts upstream `Age` against our ttl override, so an
object 4.5 h old is expired the moment it's stored under ttl 60.

**Not proven:** which `Accept-Encoding` the Compute fetch sends. Also not proven: why the later p9d prices
fetches with *fresh* `Date`s still missed. The function can't see or strip upstream `Age` without the
`afterSend` hook, which this runtime rejects. The ingredient was **not swapped**: the swap was conditional
on the Set-Cookie/private hypothesis, which failed. Options: send `Accept-Encoding: gzip` explicitly on
ingredient fetches (cheap to try, and would also reveal whether encoding is the lever), or swap prices
for a backend that doesn't sit behind a long-lived shared cache.

### F4. Recheck on dev, 2026-09-29 18:06–18:09 UTC (package 3): stock fixed; mypage evidence contradicts F3

**Deploy propagation.** The debug host served the new package from 18:06:30, but the public host still
reached the *old* code until at least 18:07:07 (old-style `404 "No stock with id 1"`); by 18:07:21 it had
the new code. Wait for the public host, not just the debug host, before running a proof.

**stock (`id=2`) — the card works.** The reading is held while cached, stale-while-revalidate serves the
old reading instantly, and the next request carries the refreshed one:

| t | UTC | x-cache | age | level | readingAt | curl total |
|---|---|---|---|---|---|---|
| +0 s | 18:07:57 | MISS | 0 | 359 | 18:07:59 | 1.50 s |
| +13 s | 18:08:10 | HIT | 11 | 359 | 18:07:59 | 0.19 s |
| +26 s | 18:08:23 | HIT | **24** (stale: past max-age 20) | 359 | 18:07:59 | 0.18 s |
| +40 s | 18:08:37 | HIT | 14 | **415** | **18:08:23** (the refresh triggered at +26 s) | 0.70 s |

**mypage ×5 with temporary instrumentation** (each ingredient's upstream `Age`, `Date`, `x-cache`; removed
before commit). Prices sent `Accept-Encoding: gzip`:

| visitor | ingredient | upstream `x-cache` | upstream `Age` | `Date` / fetchedAt | ms |
|---|---|---|---|---|---|
| 1 gold | product | `Hit from cloudfront, HIT` | 1287 | 18:07:22 | 97 |
| | prices | `Hit from cloudfront, **MISS**` | 463 | **17:59:40** | 98 |
| | topSellers | `Hit from cloudfront, HIT` | 481 | 18:07:22 | 98 |
| 2 silver | all three | `Hit from cloudfront, HIT` | 1287 / 463 / 481 | 18:07:22 | 227–228 |
| 3 bronze | all three | `…, HIT` | 1288 / 464 / 482 | 18:07:23 | 232–236 |
| 4 gold | all three | `…, HIT` | 1288 / 464 / 482 | 18:07:23 | 44–45 |
| 5 silver | all three | `…, HIT` | 1288 / 464 / 482 | 18:07:23 | 21–25 |

What this shows:
- **The gzip header reached TMDB.** Prices landed on CloudFront's gzip copy (`Date 17:59:40`, `Age 463`),
  not the identity copy (`Date 13:28:02`, `Age ~16,000`). The prices ingredient was kept, not swapped.
- **All three ingredients were served from Fastly's cache for visitors 2–5.** The second token in
  `x-cache` (after CloudFront's) is Fastly's own: `HIT` for every ingredient after prices' single `MISS`.
  Each ingredient's upstream `Age` advances in step with the clock (463 → 464), so the same stored copies
  were served to all five visitors. In that sense all three ingredients are shared.
- **`Date`/`fetchedAt` is not a usable "same timestamp" signal.** On these hits `Date` moved with the
  clock (18:07:22 → 18:07:23) while `Age` showed the same object. Something in front rewrites `Date` on
  delivery, so p9d's "prices re-fetched every time, new `Date` each time" was probably a misreading.
- **Contradicts F3's mechanism.** Fastly served `HIT` for objects with upstream `Age` 464–1288 under a 60 s
  TTL, so "Fastly counts upstream `Age` against our ttl" is not what happens here. **Also unexplained:** a
  product object first stored around 17:45 was still a `HIT` at 18:07, 21 minutes into a 60 s TTL. These
  hits may come from another cache layer (e.g. a shield) governed by TMDB's `max-age` rather than our
  override. Not verified.
- **`X-Backend-Calls` was wrong here.** It said 3 on all five visitors, but only one fetch (visitor 1,
  prices) was a Fastly `MISS`. These hits took 21–236 ms (a remote cache node, not the local one), so the
  ≥ 15 ms heuristic counted them as backend calls. The subrequest's own `x-cache` last token (`HIT`/`MISS`)
  looks like a far better signal. Adopted in p9g (see "How `X-Backend-Calls` is counted").

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

# stock: four times across 40 s (watch readingAt: frozen on HITs, new after the SWR refresh)
for at in 0 13 26 40; do hdr '/api/cache/stock?id=1'; [ $at -lt 40 ] && /bin/sleep 13; done

# mypage: five times across the three tiers
for t in gold silver bronze gold silver; do hdr "/api/cache/mypage?tier=$t"; done

# quote: before and after break
hdr '/api/cache/quote'; /bin/sleep 12
hdr '/api/cache/quote?break=1'                 # separate cache key
hdr '/api/cache/quote' -H 'X-Break: 1'          # same cache key, forced origin error
hdr '/api/cache/quote'

# purge: both layers (F2) — then 603 refetches with a new X-Fetched-At, 550 stays cached
hdr '/api/cache/product?id=603'; hdr '/api/cache/product?id=550'
./scripts/purge.sh both product-603 '/api/cache/product?id=603'
hdr '/api/cache/product?id=603'; hdr '/api/cache/product?id=550'
```

Always GET (`curl -s -D - -o /dev/null`), never `curl -I`. The router is GET-only, so HEAD returns 405
wherever it reaches the function directly (local `serve`, the debug host). The public CDN happened to turn
HEAD into GET on 2026-09-29, but don't rely on that.
