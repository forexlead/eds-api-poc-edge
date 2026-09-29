# CLAUDE.md — eds-api-poc-edge (AEM Edge Functions)

## What this repo is
A single AEM Edge Function named **`api-poc`** running on Adobe's managed Fastly Compute edge. It proves four API integration patterns for an AEM Edge Delivery Services site: Secure Proxy, Aggregator, Transformer, Resilient Failover. The API contract is in `docs/api-contract.md` — **it is the source of truth; do not change routes or response shapes without updating it.**

## Environment (fixed facts)
- Adobe org: Dentsu Global Partner Sandbox · Program: AEM Cloud on Dentsu (**p24773, sandbox**)
- Deploy target: sandbox **AEM dev environment** `aem-cloud-on-dentsu-dev-gradial` (e1522172) → public base `https://publish-p24773-e1522172.adobeaemcloud.com`. Sandbox programs do NOT support custom domains, so the EDS site (`main--eds-api-poc--forexlead.aem.page|live`, `localhost:3000`) calls the API **cross-origin** — CORS is mandatory.
- `aio aem edge-functions setup` is configured with Edge Delivery = **No**, environment = **dev (1522172)**.
- Sandbox environments hibernate after ~8 h idle — de-hibernate in Cloud Manager before testing/demo.
- Sandbox programs do **not** support Edge Function secrets, ConfigStore or KV store. Do not use `SecretStoreManager`, `ConfigStore`, or `KVStore`.

## Runtime rules (Fastly Compute JS via @fastly/js-compute)
- Entry: `src/index.js` with `addEventListener("fetch", (event) => event.respondWith(handleRequest(event)))`. Keep a small router; one handler module per route under `src/routes/`.
- Use `fetch()` for backends (dynamic backends are allowed). Use `CacheOverride` from `fastly:cache-override` for the fetch cache: `new CacheOverride("override", { ttl: 60, swr: 300, surrogateKey: "..." })`.
- Purging: via CLI `aio aem edge-functions purge-cache api-poc -k <key> [--soft]` (not a custom endpoint).
- Geo: `event.client.geo` (latitude/longitude) for dashboard defaults.
- Timeouts: wrap each backend fetch in `Promise.race` with a 1500 ms timer. Use `Promise.allSettled` for parallel calls.
- Hard limits — design within them: **max 32 backend fetches per request** (we use ≤3), ~1 s CPU, 128 MB heap, target <100 ms average execution, max 3 functions per program.
- No Node APIs (`fs`, `process`, `Buffer`-dependent libs). No heavy npm deps; plain JS only.
- Measure with `Date.now()` around each fetch; emit a `Server-Timing` header.

## Secrets (sandbox workaround)
- The TMDB v4 read token lives in a gitignored `.env` (`TMDB_TOKEN=...`).
- `scripts/gen-secrets.mjs` reads `.env` and writes `src/generated/secrets.js` (`export const TMDB_TOKEN = "..."`). `src/generated/` is gitignored.
- The generator must run before **every** `serve`, `build`, and `deploy` (wire it into npm scripts; check how `aio aem edge-functions build` invokes the build and hook accordingly).
- The token must never appear in: any response body/header, any `console.log`, git history, or the browser. A test must assert this.

## CORS & headers
Follow "Common response rules" in `docs/api-contract.md` exactly (origin allowlist regex, `Timing-Allow-Origin: *`, `Access-Control-Expose-Headers`, `OPTIONS` → 204). Without `Timing-Allow-Origin` and exposed headers, the site's metrics panel cannot read timings — do not drop them.

## Commands
```bash
npm install
node scripts/gen-secrets.mjs          # (or via npm script)
aio aem edge-functions serve          # http://127.0.0.1:7676
npm run test                          # mocha
aio aem edge-functions build
aio aem edge-functions deploy api-poc
aio aem edge-functions list           # shows debug URL
aio aem edge-functions tail-logs api-poc
aio aem edge-functions purge-cache api-poc -k movie-603 --soft
```

## Config files (deployed by the Cloud Manager Edge Delivery config pipeline from `/config`)
- `config/edgeFunctions.yaml`: declares only `api-poc` (no `secrets`, `configs`, or `kvs` blocks — sandbox).
- `config/cdn.yaml` and `config/edgeFunctions.yaml` carry `metadata: envTypes: ["stage"]`. cdn.yaml: boilerplate `/hello-world` + `/weather`, plus `route-api-uncached` (`^/api/(health|resilient)$`, skipCache) and `route-api-cached` (`^/api/(movies|movie|dashboard|lite)$`) → `edgefunction-api-poc`. Any new route needs a cdn.yaml change + pipeline run — batch changes.

## Working agreement
- Before coding a phase: read `docs/api-contract.md`, state the plan in ≤5 bullets, then implement.
- After each phase: run tests, run `serve` and curl every new route, then report exact curl outputs (headers + body excerpt). Do not claim done without that evidence.
- Keep commits small, message format `pN: <what>` (e.g. `p2: secure proxy /api/movies`).
- Never run `git push --force`, never touch other programs' pipelines, never commit `.env` or `src/generated/`.
