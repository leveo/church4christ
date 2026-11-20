// The check-in desk's request logic on D1 (cases shared with Postgres in test/shared/regDeskCases.ts).
import { env } from 'cloudflare:test';
import { scopeDatabase } from '../src/lib/campusScope';
import { defineRegDeskCases } from './shared/regDeskCases';

defineRegDeskCases('D1', () => env.DB);
defineRegDeskCases('D1, campus-scoped', () => scopeDatabase(env.DB, 1));
