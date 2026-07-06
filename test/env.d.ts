// The root tsconfig.json sets `compilerOptions.types` explicitly, which
// suppresses automatic discovery of ambient .d.ts files under node_modules.
// The pool's `cloudflare:test` module declaration is exposed via the package's
// "./types" export subpath — pull it in explicitly.
/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `Cloudflare.Env` is an open interface designed for declaration merging; the
// test-only TEST_MIGRATIONS binding (injected by vitest.config.ts) is added
// here. A top-level import makes this file a module, so the ambient declaration
// must sit in `declare global`.
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

// Vite's `?raw` import suffix yields the file's text; test/seed.test.ts loads
// seed/dev-seed.sql this way (works in both the node and workers vitest pools).
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
