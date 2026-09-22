// Stub of fastly:cache-override. Records what the handler asked for; changes no behaviour.
export class CacheOverride {
  constructor(mode, init = {}) {
    this.mode = mode;
    Object.assign(this, init);
  }
}
