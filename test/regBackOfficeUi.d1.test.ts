// The registration event page's server side on D1 (cases shared with Postgres in test/shared/regBackOfficeUiCases.ts).
// src/lib/email is replaced by a capturing stand-in so the mail the actions send can be read.
import { env } from 'cloudflare:test';
import { vi } from 'vitest';

vi.mock('../src/lib/email', async () => (await import('./shared/regMail')).mockEmailModule());

import { scopeDatabase } from '../src/lib/campusScope';
import { defineRegBackOfficeUiCases } from './shared/regBackOfficeUiCases';

defineRegBackOfficeUiCases('D1', () => env.DB, 'd1');
defineRegBackOfficeUiCases('D1, campus-scoped', () => scopeDatabase(env.DB, 1), 'd1');
