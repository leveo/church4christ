// Registration mail on D1 (the shared cases in test/shared/regNotifyCases.ts also run on
// Postgres). src/lib/email is replaced by a capturing stand-in so the cases can read the
// messages; the real sendEmail path is covered by test/regNotifyDevlog.test.ts.
import { env } from 'cloudflare:test';
import { vi } from 'vitest';

vi.mock('../src/lib/email', async () => (await import('./shared/regMail')).mockEmailModule());

import { defineRegNotifyCases } from './shared/regNotifyCases';

defineRegNotifyCases('D1', () => env.DB, 'd1');
