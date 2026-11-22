// The generated member app service worker must parse. Runs in the node project:
// workerd forbids compiling code from strings, so the syntax check lives here.
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildServiceWorker } from '../../src/lib/memberApp';

describe('member app service worker source', () => {
  it('is valid JavaScript for every shape of locale code', () => {
    for (const locale of ['en', 'zh', 'pt']) {
      expect(() => new Script(buildServiceWorker(locale, '1.2.3'))).not.toThrow();
    }
  });
});
