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

// Fetch-cache settings for backend calls on cacheable routes. Kept apart from lib/http.js,
// which stays free of `fastly:*` imports.

import { CacheOverride } from 'fastly:cache-override';

/**
 * `fresh=1` → "pass" (skip the fetch cache entirely, so the demo shows a cold call);
 * otherwise the contract's ttl/swr override tagged with the route's surrogate keys.
 * @param {boolean} fresh
 * @param {string} surrogateKey
 */
function fetchCacheOverride(fresh, surrogateKey) {
  return fresh
    ? new CacheOverride('pass')
    : new CacheOverride('override', { ttl: 60, swr: 300, surrogateKey });
}

export { fetchCacheOverride };
