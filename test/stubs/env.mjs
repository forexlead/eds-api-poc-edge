// Stub of fastly:env. Viceroy/Compute return "" for unknown vars; mirror that.
const VALUES = { FASTLY_POP: 'TEST', FASTLY_SERVICE_VERSION: '0' };
export function env(name) {
  return VALUES[name] ?? '';
}
