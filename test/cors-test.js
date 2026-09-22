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

import assert from 'node:assert';
import { handleRequest } from '../src/index.js';
import { allowedOrigin } from '../src/lib/http.js';

const BASE = 'https://publish-p24773-e1511008.adobeaemcloud.com';

function fetchEvent(path, { method = 'GET', origin } = {}) {
  const headers = origin ? { Origin: origin } : {};
  return { request: new Request(BASE + path, { method, headers }), client: {} };
}

const ALLOWED = [
  'https://main--eds-api-poc--forexlead.aem.page',
  'https://main--eds-api-poc--forexlead.aem.live',
  'https://main--eds-api-poc--test.aem.page',
  'https://feature-1--eds-api-poc--forexlead.aem.page',
  'http://localhost:3000'
];

const DISALLOWED = [
  'https://evil.com',
  'https://main--eds-api-poc--forexlead.aem.page.evil.com',
  'https://evil.com/https://main--eds-api-poc--forexlead.aem.page',
  'https://main--other-site--forexlead.aem.page',
  'https://main--eds-api-poc--forexlead.aem.dev',
  'http://localhost:3001',
  'http://main--eds-api-poc--forexlead.aem.page' // http, not https
];

describe('CORS allowlist', function () {
  for (const origin of ALLOWED) {
    it(`echoes the allowed origin ${origin}`, async function () {
      assert.equal(allowedOrigin(origin), origin);
      const resp = await handleRequest(fetchEvent('/api/health', { origin }));
      assert.equal(resp.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(resp.headers.get('Vary'), 'Origin');
    });
  }

  for (const origin of DISALLOWED) {
    it(`omits the header for the disallowed origin ${origin}`, async function () {
      assert.equal(allowedOrigin(origin), null);
      const resp = await handleRequest(fetchEvent('/api/health', { origin }));
      assert.equal(resp.headers.get('Access-Control-Allow-Origin'), null);
      // Vary is still set, so a rejected response is never reused for another origin.
      assert.equal(resp.headers.get('Vary'), 'Origin');
    });
  }

  it('omits the header when there is no Origin (same-origin / curl)', async function () {
    const resp = await handleRequest(fetchEvent('/api/health'));
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('Access-Control-Allow-Origin'), null);
  });
});

describe('OPTIONS preflight', function () {
  it('answers 204 with the preflight headers for an allowed origin', async function () {
    const origin = 'https://main--eds-api-poc--test.aem.page';
    const resp = await handleRequest(fetchEvent('/api/health', { method: 'OPTIONS', origin }));
    assert.equal(resp.status, 204);
    assert.equal(resp.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(resp.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
    assert.equal(resp.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
    assert.equal(resp.headers.get('Access-Control-Max-Age'), '86400');
    assert.equal(resp.headers.get('Timing-Allow-Origin'), '*');
    assert.equal(await resp.text(), '');
  });

  it('answers 204 without the origin header for a disallowed origin', async function () {
    const resp = await handleRequest(
      fetchEvent('/api/health', { method: 'OPTIONS', origin: 'https://evil.com' })
    );
    assert.equal(resp.status, 204);
    assert.equal(resp.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(resp.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  });

  it('preflights unknown /api routes too', async function () {
    const resp = await handleRequest(fetchEvent('/api/movies', { method: 'OPTIONS' }));
    assert.equal(resp.status, 204);
  });

  it('rejects non-GET methods with 405', async function () {
    const resp = await handleRequest(fetchEvent('/api/health', { method: 'POST' }));
    assert.equal(resp.status, 405);
    assert.equal(resp.headers.get('Allow'), 'GET, OPTIONS');
    const body = await resp.json();
    assert.equal(body.error.code, 'BAD_REQUEST');
  });
});
