// Registration back office behavior on D1, plain and through the campus SQL scoper the request handlers
// use. The cases live in test/shared/regOfficeCases.ts and also run on Postgres.
import { env } from 'cloudflare:test';
import { scopeDatabase } from '../src/lib/campusScope';
import { defineRegOfficeCases } from './shared/regOfficeCases';

defineRegOfficeCases('D1', () => env.DB, 'd1');
defineRegOfficeCases('D1, campus-scoped', () => scopeDatabase(env.DB, 1), 'd1');
