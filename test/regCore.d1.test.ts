// Registration core behavior on D1, plain and through the campus SQL scoper the
// request handlers use (locals.db is a CampusScopedDb in campus mode). The cases
// live in test/shared/regCoreCases.ts and also run on Postgres.
import { env } from 'cloudflare:test';
import { scopeDatabase } from '../src/lib/campusScope';
import { defineRegCoreCases } from './shared/regCoreCases';

defineRegCoreCases('D1', () => env.DB);
defineRegCoreCases('D1, campus-scoped', () => scopeDatabase(env.DB, 1));
