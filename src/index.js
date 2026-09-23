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

import { env } from 'fastly:env';
import { error, preflight } from './lib/http.js';
import { healthHandler } from './routes/health.js';
import { moviesHandler, movieHandler } from './routes/movies.js';
import { dashboardHandler } from './routes/dashboard.js';
import { liteHandler } from './routes/lite.js';
import { resilientHandler } from './routes/resilient.js';

// `addEventListener` only exists on Compute; guarding it lets mocha import this router.
if (typeof addEventListener === 'function') {
  addEventListener('fetch', (event) => event.respondWith(handleRequest(event)));
}

/** GET-only route table. Every handler takes (request, ctx). */
const ROUTES = {
  '/api/health': healthHandler,
  '/api/movies': moviesHandler,
  '/api/movie': movieHandler,
  '/api/dashboard': dashboardHandler,
  '/api/lite': liteHandler,
  '/api/resilient': resilientHandler
};

function popName() {
  try {
    return env('FASTLY_POP') || null;
  } catch {
    return null;
  }
}

/**
 * @param {{ request: Request, client?: { geo?: object } }} event
 */
async function handleRequest(event) {
  const req = event.request;
  const url = new URL(req.url);
  const path = url.pathname;

  try {
    if (path.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        return preflight(req);
      }
      const handler = ROUTES[path];
      if (!handler) {
        return error(req, 404, 'NOT_FOUND', `No such route: ${path}`);
      }
      if (req.method !== 'GET') {
        return error(req, 405, 'BAD_REQUEST', `${req.method} is not allowed on ${path}`, {
          Allow: 'GET, OPTIONS'
        });
      }
      return await handler(req, { pop: popName(), geo: event.client?.geo ?? null });
    }

    // Boilerplate smoke-test route kept for post-deploy verification (see config/cdn.yaml).
    if ((path === '/' || path === '/hello-world') && req.method === 'GET') {
      return new Response('Hello World from the edge!', { status: 200 });
    }

    return new Response('Not Found!', { status: 404 });
  } catch (err) {
    // Log the message only — an upstream error's cause can embed a credentialed URL.
    console.error(`handleRequest failed for ${path}: ${err?.message ?? 'unknown error'}`);
    return error(req, 500, 'UPSTREAM', 'Internal error');
  }
}

export { handleRequest, ROUTES };
