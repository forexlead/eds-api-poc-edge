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

const BASE = 'https://publish-p24773-e1511008.adobeaemcloud.com';

/** Minimal stand-in for a Compute FetchEvent. */
function fetchEvent(path, { method = 'GET', origin } = {}) {
  const headers = origin ? { Origin: origin } : {};
  return {
    request: new Request(BASE + path, { method, headers }),
    client: { geo: { latitude: 35.79, longitude: -78.78 } }
  };
}

describe('GET /api/health', function () {
  it('returns the shape from the contract', async function () {
    const resp = await handleRequest(fetchEvent('/api/health'));
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(resp.headers.get('X-Pattern'), 'health');

    const body = await resp.json();
    assert.deepEqual(Object.keys(body).sort(), ['function', 'pop', 'status', 'time']);
    assert.equal(body.status, 'ok');
    assert.equal(body.function, 'api-poc');
    assert.match(body.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(body.pop, 'TEST'); // from the fastly:env stub
  });

  it('is not cached by the browser and reports edge timing', async function () {
    const resp = await handleRequest(fetchEvent('/api/health'));
    assert.equal(resp.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
    assert.equal(resp.headers.get('Surrogate-Control'), null);
    assert.match(resp.headers.get('Server-Timing'), /^edge;dur=\d+$/);
  });

  it('exposes the timing headers to cross-origin readers', async function () {
    const resp = await handleRequest(fetchEvent('/api/health'));
    assert.equal(resp.headers.get('Timing-Allow-Origin'), '*');
    assert.equal(resp.headers.get('Vary'), 'Origin');
    const exposed = resp.headers.get('Access-Control-Expose-Headers');
    for (const name of ['Server-Timing', 'X-Pattern', 'X-Fetched-At', 'Age']) {
      assert.ok(exposed.includes(name), `${name} should be exposed`);
    }
  });

  it('404s unknown /api routes with the error envelope', async function () {
    const resp = await handleRequest(fetchEvent('/api/nope'));
    assert.equal(resp.status, 404);
    const body = await resp.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('keeps /hello-world working for the deploy smoke test', async function () {
    const resp = await handleRequest(fetchEvent('/hello-world'));
    assert.equal(resp.status, 200);
    assert.equal(await resp.text(), 'Hello World from the edge!');
  });
});
