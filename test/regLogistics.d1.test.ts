// Event logistics behavior on D1, plain and through the campus SQL scoper the request handlers use. The cases
// live in test/shared/regLogisticsCases.ts and also run on Postgres (test/pg/regLogistics.pg.test.ts).
import { env } from 'cloudflare:test';
import { scopeDatabase } from '../src/lib/campusScope';
import { defineRegLogisticsCases } from './shared/regLogisticsCases';

defineRegLogisticsCases('D1', () => env.DB, 'd1');
defineRegLogisticsCases('D1, campus-scoped', () => scopeDatabase(env.DB, 1), 'd1');
