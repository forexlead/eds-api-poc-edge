/*
 * Mocha runs under plain Node, where `import ... from 'fastly:env'` has no resolver.
 * Register a synchronous module hook that maps every `fastly:*` specifier to a local
 * stub, so route modules and the router can be imported and exercised directly.
 */

import { registerHooks } from 'node:module';

const STUBS = new URL('./stubs/', import.meta.url).href;

const MODULES = {
  'fastly:env': 'env.mjs',
  'fastly:cache-override': 'cache-override.mjs',
  'fastly:geolocation': 'geolocation.mjs'
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = MODULES[specifier];
    if (stub) {
      return { url: STUBS + stub, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});
