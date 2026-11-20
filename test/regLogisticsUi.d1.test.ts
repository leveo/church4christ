// The event page's logistics actions on D1, plain and through the campus SQL scoper the request handlers use. The
// cases live in test/shared/regLogisticsUiCases.ts and also run on Postgres (test/pg/regLogisticsUi.pg.test.ts).
import { env } from 'cloudflare:test';
import { scopeDatabase } from '../src/lib/campusScope';
import { defineRegLogisticsUiCases } from './shared/regLogisticsUiCases';

defineRegLogisticsUiCases('D1', () => env.DB, 'd1');
defineRegLogisticsUiCases('D1, campus-scoped', () => scopeDatabase(env.DB, 1), 'd1');
