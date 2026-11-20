// Registration messaging on D1 (the shared cases in test/shared/regMessagingCases.ts also run on Postgres).
// src/lib/email is replaced by a capturing stand-in so the cases can read the messages.
import { env } from 'cloudflare:test';
import { vi } from 'vitest';

vi.mock('../src/lib/email', async () => (await import('./shared/regMail')).mockEmailModule());

import { defineRegMessagingCases } from './shared/regMessagingCases';

defineRegMessagingCases('D1', () => env.DB, 'd1');
