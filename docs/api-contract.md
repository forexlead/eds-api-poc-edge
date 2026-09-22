# API Contract — `api-poc` Edge Function

Shared contract between the edge function (`eds-api-poc-edge`) and the EDS block (`eds-api-poc`). Both sides build against this; change it here first.

Base URL
- **Deployed (current path):** `https://publish-p24773-e1511008.adobeaemcloud.com/api/...` — Adobe-managed CDN of the sandbox **stage** environment (program 24773, env e1511008). The EDS site (`*.aem.page` / `*.aem.live` / `localhost:3000`) calls it **cross-origin** → CORS rules below apply.
- Local function dev: `http://127.0.0.1:7676`
- Routing: `config/cdn.yaml` (envTypes: stage) sends `^/api/(health|resilient)$` (skipCache) and `^/api/(movies|movie|dashboard|lite)$` (CDN-cacheable) to `edgefunction-api-poc`
- Future (production program + custom domain): same-origin `https://edspoc.edcfunctions.lol/api/...` — sandbox programs do not support custom domains.

## Common response rules (every route)
| Header | Value |
|---|---|
| `Content-Type` | `application/json; charset=utf-8` |
| `Access-Control-Allow-Origin` | echo request `Origin` if it matches `^https://[a-z0-9-]+--eds-api-poc--[a-z0-9-]+\.aem\.(page\|live)$` or `http://localhost:3000`; otherwise omit |
| `Access-Control-Expose-Headers` | `Server-Timing, X-Pattern, X-Fallback, X-Original-Bytes, X-Transformed-Bytes, X-Fetched-At, X-Backend-Age, Age` |
| `Timing-Allow-Origin` | `*` (lets the browser Resource Timing API report sizes/timings cross-origin) |
| `Vary` | `Origin` |
| `X-Pattern` | `proxy` \| `aggregate` \| `transform` \| `failover` \| `health` |
| `X-Fetched-At` | **single-upstream routes only** (`movies`, `movie`, `lite`): the upstream response's own `Date` header (preserved in the fetch cache, so an old value = served from cache; a new value after purge = refetched). `dashboard` omits it by design — see below. |
| `X-Backend-Age` | **single-upstream routes only** (`movies`, `movie`, `lite`): passthrough of the upstream response's own `Age` header, when present; omitted when the backend didn't send one. A supplementary signal only — many backends (TMDB included) don't set `Age` on every response, so its absence doesn't mean "not cached". `dashboard` omits it by design — see below. |
| `Server-Timing` | one entry per backend call, e.g. `tmdb;dur=142, weather;dur=88, edge;dur=151` — **this is the primary cache-hit signal**: on a Fastly fetch-cache hit the backend call returns from the local cache in well under a few ms, vs. ~70ms+ for a live round trip to TMDB. `X-Fetched-At`/`X-Backend-Age` corroborate but `tmdb;dur` is what to check first. |
| `Cache-Control` | `public, max-age=0, must-revalidate` (browser always asks the edge — we measure the edge, not the browser cache) |
| `Surrogate-Control` | cacheable routes only: `max-age=60, stale-while-revalidate=300, stale-if-error=86400` (honoured by the Adobe CDN in front of the stage environment) |
| `Surrogate-Key` | as listed per route |

`OPTIONS` on any `/api/*` → `204` with `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Allow-Headers: Content-Type`, `Access-Control-Max-Age: 86400`.

Errors → `{ "error": { "code": "BAD_REQUEST|UPSTREAM|NOT_FOUND", "message": "..." } }` with matching status. **Never** include upstream URLs with credentials, auth headers, or the token in any response or log line.

Backend fetches: fetch cache via `CacheOverride` (`ttl: 60, swr: 300`, `surrogateKey` = same keys as response) on cacheable routes; timeout 1500 ms per backend (Promise.race).

---

## `GET /api/health`
```json
{ "status": "ok", "function": "api-poc", "time": "2026-09-21T18:00:00Z", "pop": "<fastly pop if available>" }
```
Not cached.

## `GET /api/movies?q=<text>` — Pattern 01 Secure Proxy
Backend: TMDB `GET https://api.themoviedb.org/3/search/movie?query=<q>` with `Authorization: Bearer <TMDB_TOKEN>` (token injected at build time, never sent to browser).
```json
{
  "pattern": "proxy",
  "query": "matrix",
  "results": [
    { "id": 603, "title": "The Matrix", "year": 1999, "rating": 8.2,
      "poster": "https://image.tmdb.org/t/p/w185/<path>.jpg" }
  ]
}
```
Max 10 results. `Surrogate-Key: movies movies-q-<slug(q)>`. `X-Backend-Age` passes through TMDB's own `Age` header when TMDB sent one.

## `GET /api/movie?id=<tmdbId>` — single item (purge demo)
Backend: TMDB `GET /3/movie/<id>`.
```json
{ "pattern": "proxy", "id": 603, "title": "The Matrix", "year": 1999, "rating": 8.2,
  "runtime": 136, "overview": "...", "poster": "...", "fetchedAt": "Mon, 21 Sep 2026 18:00:00 GMT" }
```
`Surrogate-Key: movies movie-<id>`. `fetchedAt` = upstream `Date` header (same as `X-Fetched-At`) → old value means served from the fetch cache; after `purge-cache -k movie-603` it jumps to now, while `movie-550` keeps its old value. `X-Backend-Age` passes through TMDB's own `Age` header when present. Neither is as reliable as `Server-Timing`'s `tmdb;dur` (near-0ms on a fetch-cache hit vs. a live round trip) — treat that as the primary cache-hit signal and the headers as corroboration.

## `GET /api/dashboard?lat=<n>&lon=<n>` — Pattern 02 Aggregator
lat/lon optional → default to `event.client.geo`, then to Cary NC (35.79, -78.78).
Backends in parallel (`Promise.allSettled`):
- TMDB trending `GET /3/trending/movie/day` (top 5)
- Open-Meteo `GET https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=temperature_2m,wind_speed_10m,weather_code`
- PokeAPI `GET https://pokeapi.co/api/v2/pokemon/<random 1-151>`
```json
{
  "pattern": "aggregate",
  "totalMs": 212,
  "sumOfSourcesMs": 431,
  "sources": {
    "tmdb":    { "status": "ok", "ms": 180, "data": [ { "id": 1, "title": "...", "poster": "..." } ] },
    "weather": { "status": "ok", "ms": 95,  "data": { "tempC": 24.1, "windKph": 9.4, "code": 1 } },
    "pokemon": { "status": "error", "ms": 1500, "data": null, "error": "timeout" }
  }
}
```
On success, `sources.pokemon.data` = `{ "id": 25, "name": "pikachu", "sprite": "https://raw.githubusercontent.com/.../25.png" }` (the example above shows the `error` shape instead, since that's the more interesting case to document).

One failed source never fails the whole response (status 200). `Surrogate-Key: dashboard`. Max 3 backend fetches (limit is 32).

No `X-Fetched-At`/`X-Backend-Age` on this route, by design: those headers describe a single upstream response, and an aggregate of three backends doesn't have one. Each source's own `ms` in `Server-Timing` is the cache signal here instead — near-0ms on a fetch-cache hit, same as the single-upstream routes.

## `GET /api/lite?id=<1-1025>` — Pattern 03 Transformer
Backend: PokeAPI `GET /api/v2/pokemon/<id>` (~200–400 KB raw).
```json
{ "pattern": "transform", "id": 25, "name": "pikachu", "types": ["electric"],
  "sprite": "https://raw.githubusercontent.com/.../25.png",
  "stats": { "hp": 35, "attack": 55, "defense": 40, "speed": 90 } }
```
Headers `X-Original-Bytes` (raw upstream body length) and `X-Transformed-Bytes`. `Surrogate-Key: pokemon pokemon-<id>`. `Server-Timing`'s backend entry is named `pokemon;dur=…` (e.g. `pokemon;dur=142, edge;dur=151`). A single upstream response exists here (unlike `dashboard`), so `X-Fetched-At`/`X-Backend-Age` apply per the common rules above.

## `GET /api/resilient?mode=ok|fail|slow` — Pattern 04 Failover
Backend: TMDB `/3/movie/603`. `mode=fail` → call a guaranteed-500 URL (`https://httpbin.org/status/500`) instead; `mode=slow` → `https://httpbin.org/delay/5` (hits the 1500 ms timeout).
Fallback: live → static snapshot bundled in the function (`src/fallback/movie-603.json`). (KV "last-good" copy is unavailable in sandbox programs; `resilient` is not CDN-cached, so no CDN stale tier either — record as a finding.)
```json
{ "pattern": "failover", "served": "live|static", "reason": null,
  "data": { "id": 603, "title": "The Matrix", "year": 1999 } }
```
`reason` = `"upstream 500"` or `"timeout"` when static. Always `200`. Header `X-Fallback: none|static`. Not cached.
