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

// GET /api/health — liveness probe, never cached (docs/api-contract.md).

import { json, serverTiming } from '../lib/http.js';

const FUNCTION_NAME = 'api-poc';

/** The contract shows second precision ("2026-09-21T18:00:00Z"), not the default millis. */
function isoSeconds(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * @param {Request} req
 * @param {{ pop?: string|null }} [ctx] Fastly-specific context supplied by the entry point.
 */
function healthHandler(req, ctx = {}) {
  const started = Date.now();
  const body = {
    status: 'ok',
    function: FUNCTION_NAME,
    time: isoSeconds(),
    pop: ctx.pop ?? null
  };
  return json(req, body, {
    headers: {
      'X-Pattern': 'health',
      'Server-Timing': serverTiming({ edge: Date.now() - started })
    }
  });
}

export { healthHandler, isoSeconds, FUNCTION_NAME };
