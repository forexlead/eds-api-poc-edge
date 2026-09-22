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

// The TMDB token is baked into the Wasm (sandbox has no secret store), so guard the
// blast radius: it must never reach a response, a log line, or git.

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest } from '../src/index.js';

const BASE = 'https://publish-p24773-e1511008.adobeaemcloud.com';

function token() {
  const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  const match = raw.match(/^\s*TMDB_TOKEN\s*=\s*(.+)$/m);
  assert.ok(match, '.env must define TMDB_TOKEN — run node scripts/gen-secrets.mjs');
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

describe('TMDB token containment', function () {
  it('is not present anywhere in a /api/health response', async function () {
    const secret = token();
    const resp = await handleRequest({
      request: new Request(`${BASE}/api/health`),
      client: {}
    });
    const headers = [...resp.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
    const body = await resp.text();
    assert.ok(!headers.includes(secret), 'token leaked into a response header');
    assert.ok(!body.includes(secret), 'token leaked into the response body');
  });

  it('is not tracked by git', function () {
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8'
    }).split('\n');
    assert.ok(!tracked.includes('.env'), '.env must stay untracked');
    assert.ok(
      !tracked.some((f) => f.startsWith('src/generated/')),
      'src/generated/ must stay untracked'
    );
  });

  it('exists in the source tree only in src/generated/secrets.js', function () {
    // .env is the source of truth for the token (excluded here on purpose); bin/ and pkg/
    // are build artifacts that necessarily embed it once compiled and are gitignored.
    const secret = token();
    const root = new URL('..', import.meta.url).pathname;
    let output = '';
    try {
      output = execFileSync(
        'grep',
        [
          '-rlF',
          '--exclude-dir=node_modules',
          '--exclude-dir=.git',
          '--exclude-dir=bin',
          '--exclude-dir=pkg',
          '--exclude-dir=.aio',
          '--exclude=.env',
          '--',
          secret,
          '.'
        ],
        { cwd: root, encoding: 'utf8' }
      );
    } catch (err) {
      if (err.status !== 1) throw err; // grep exits 1 for "no matches", which is fine here
    }
    const matches = output
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ''))
      .sort();
    assert.deepEqual(matches, ['src/generated/secrets.js']);
  });

  it('gen-secrets fails loudly when TMDB_TOKEN is missing', function () {
    // The generator resolves .env relative to its own location, so a copy in a temp
    // directory with an empty .env exercises the failure path without touching the repo.
    const dir = mkdtempSync(join(tmpdir(), 'gen-secrets-'));
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(
      new URL('../scripts/gen-secrets.mjs', import.meta.url),
      join(dir, 'scripts', 'gen-secrets.mjs')
    );
    writeFileSync(join(dir, '.env'), '# no token here\n');

    let failed = false;
    let stderr = '';
    try {
      execFileSync(process.execPath, [join(dir, 'scripts', 'gen-secrets.mjs')], {
        stdio: 'pipe',
        encoding: 'utf8'
      });
    } catch (err) {
      failed = true;
      stderr = err.stderr ?? '';
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    assert.ok(failed, 'gen-secrets should exit non-zero when TMDB_TOKEN is missing');
    assert.match(stderr, /TMDB_TOKEN/);
  });
});
