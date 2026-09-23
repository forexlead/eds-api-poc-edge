# Purge demo — targeted cache invalidation by Surrogate-Key

Proves that purging one surrogate key (`movie-603`) refreshes exactly that item on the deployed
`api-poc` function, while a sibling item (`movie-550`) under the same route stays cached.

Keys involved (see `docs/api-contract.md`):

| Request | `Surrogate-Key` set by the function |
|---|---|
| `GET /api/movie?id=603` | `movies movie-603` |
| `GET /api/movie?id=550` | `movies movie-550` |

The same keys tag both cache layers: the CDN response cache (via the response's `Surrogate-Key`)
and the function's fetch cache (via `CacheOverride`'s `surrogateKey`).

## Before you start

1. **De-hibernate** the sandbox stage environment in Cloud Manager (it sleeps after ~8 h idle).
2. The deployed function is current: `npm run deploy`, and `aio aem edge-functions list` shows it.
3. Set the base URL and a helper that prints only the observable signals:

```bash
BASE=https://publish-p24773-e1511008.adobeaemcloud.com

sig() {  # sig <path>
  curl -s --compressed -D - -o /dev/null "$BASE$1" \
    | grep -iE '^(HTTP/|age:|server-timing:|x-cache-mode:|x-fetched-at:|x-backend-age:)'
}
```

## What you can observe from the client (and what you can't)

- **`Surrogate-Key` and `Surrogate-Control` are stripped from client responses by the CDN, by
  design.** They are instructions to the CDN, not to the browser, so a `curl` against the deployed
  host never shows them. That's expected, not a bug. The keys can be checked in the unit tests and
  under local `serve`, where nothing strips them.
- The signals you *can* see:
  - **`age`**: seconds this response has sat in the CDN cache. It climbs across repeat requests
    and drops back to ~0 when the object is refetched from the function.
  - **`Server-Timing`**: `tmdb;dur=…` is the backend call inside the function. Near 0 ms means a
    fetch-cache hit; ~70 ms or more means a live TMDB round trip. It only changes when the
    function actually runs, so on a CDN hit you see the stored value from the last time it ran.
  - **`X-Cache-Mode`**: `cached` on normal requests; `fresh` only when you add `fresh=1`, which
    bypasses both cache layers (useful as a "cold" baseline, not part of the purge sequence).
  - Corroborating: `X-Fetched-At` (and the `fetchedAt` body field), the upstream TMDB `Date`. A
    new value means the function went to TMDB again.
- **Byte counts:** on these hosts, `curl` without `--compressed` reports **compressed** byte counts
  (`content-length`, `%{size_download}`). The `sig` helper and every size you quote in the demo
  should use `--compressed`, so the numbers match what the browser decodes and what
  `X-Transformed-Bytes`/`X-Original-Bytes` describe.

## Timing constraint

Cacheable responses carry `Surrogate-Control: max-age=60, stale-while-revalidate=300`, so **every**
object refreshes on its own about 60 s after it was stored. Run steps 1–4 **within about 60 s of
warming**, or `550` will refresh by itself and the contrast disappears. The script at the end does
the whole sequence in ~20 s.

## Sequence

### 1. Warm both items

```bash
sig '/api/movie?id=603'
sig '/api/movie?id=550'
```

The first hit may be a miss (`age: 0`, live `tmdb;dur`). That's fine; it seeds both caches.

### 2. Repeat both, a few seconds apart: `age` climbs

```bash
/bin/sleep 5; sig '/api/movie?id=603'; sig '/api/movie?id=550'
/bin/sleep 5; sig '/api/movie?id=603'; sig '/api/movie?id=550'
```

Expected: `age` is higher on each round for **both** ids (e.g. 5 → 10). `X-Fetched-At` is unchanged
for each id.

### 3. Purge only `movie-603` (soft)

```bash
aio aem edge-functions purge-cache api-poc -k movie-603 --soft
```

`--soft` marks the tagged objects stale instead of deleting them, so the edge can still serve them
if the origin fails (`stale-if-error`), while the next request triggers a refetch.

### 4. Re-GET both

```bash
sig '/api/movie?id=603'; sig '/api/movie?id=550'
/bin/sleep 2
sig '/api/movie?id=603'; sig '/api/movie?id=550'
```

Expected:

| | `movie?id=603` (purged) | `movie?id=550` (not purged) |
|---|---|---|
| `age` | back to ~0, then counts up again from there | keeps climbing from step 2 |
| `X-Fetched-At` / `fetchedAt` | jumps to ~now | unchanged |
| `Server-Timing` `tmdb;dur` | live round trip (~70 ms+) on the refetch | unchanged stored value |

Because the purge is soft and the route allows `stale-while-revalidate`, the **first** request for
603 right after the purge may still return the stale copy while the refresh happens in the
background. The second request shows the reset `age` and the new `X-Fetched-At`. That's why step 4
requests each id twice.

## One-shot script

```bash
BASE=https://publish-p24773-e1511008.adobeaemcloud.com
sig() { curl -s --compressed -D - -o /dev/null "$BASE$1" \
  | grep -iE '^(HTTP/|age:|server-timing:|x-cache-mode:|x-fetched-at:)'; }
both() { echo "--- 603"; sig '/api/movie?id=603'; echo "--- 550"; sig '/api/movie?id=550'; }

echo "## warm";          both
/bin/sleep 5; echo "## +5s";  both
/bin/sleep 5; echo "## +10s"; both
echo "## purge movie-603 (soft)"
aio aem edge-functions purge-cache api-poc -k movie-603 --soft
echo "## after purge";   both
/bin/sleep 2; echo "## after purge +2s"; both
```

For the talk track, the claim is: **one key purged, one item refreshed, its neighbour untouched.**
The fetch cache and CDN were never flushed wholesale.
