// Postgres-backed smoke of the BUILT worker (SELF.fetch), run by
// vitest.e2e.pg.config.ts with DB_BACKEND=supabase + a HYPERDRIVE binding on local
// Postgres. Every request here flows middleware → route → postgres.js over
// Hyperdrive, so a green run proves the whole stack serves real seeded pages against
// Postgres — and specifically exercises the SQLite→Postgres portability fixes this
// exploration landed:
//   - the streamed-render drain (middleware pipes the body through a TransformStream
//     whose flush() ends the client) — every rendered page below loads theme/
//     settings/modules through the request-scoped client while the body streams;
//   - the admin Overview shortfall query (adminOverviewDb.getNeedsAttention /
//     getOverviewStats), which needed the 2-arg MAX/MIN compat functions, the mixed
//     numbered/anonymous placeholder fix, the HAVING-alias → subquery rewrite, the
//     explicit GROUP BY, and the TRUE/FALSE scope clause — reached via /admin/
//     ministries as both an admin and a team leader.
// This does NOT reuse test/e2e/** (those seed + verify through the D1 env.DB binding,
// which this backend never reads).
import { env } from 'cloudflare:test';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { get } from '../e2e/helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { todayInTz } from '../../src/lib/dates';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

/** Read table values from the named finance region, independently of styling. */
function financeRows(html: string, label: 'Gifts' | 'Gifts by fund'): string[][] {
  const table = html.match(new RegExp(`<div\\b[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</table>`))?.[1];
  expect(table, `${label} table must be rendered`).toBeDefined();
  return [...table!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(row => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)]
      .map(cell => cell[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()))
    .filter(row => row.length > 0);
}

describe('Postgres-backed worker: public render path', () => {
  it('/healthz → 200 {"ok":true}', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('/en/ renders the seeded theme, both hreflang alternates, and the announcement', async () => {
    const body = await (await get('/en/')).text();
    expect(body).toContain('data-theme="sanctuary"'); // theme.name setting, read over Postgres
    expect(body).toContain('hreflang="en"');
    expect(body).toContain('hreflang="zh-Hans"');
    expect(body).toContain('New members class every first Sunday'); // seeded announcement
  });

  it('/zh/ declares lang="zh-Hans" and renders the Chinese announcement', async () => {
    const body = await (await get('/zh/')).text();
    expect(body).toContain('lang="zh-Hans"');
    expect(body).toContain('新朋友课程每月首个主日');
  });

  it('/en/sermons lists a published sermon', async () => {
    const body = await (await get('/en/sermons')).text();
    expect(body).toContain('The Beatitudes');
  });

  it('/en/give sends a guest through identity continuation before checkout', async () => {
    // giving is Supabase-only and defaults ON, so on this backend /give is the
    // giving form — not the D1 external-link page. Rendering it exercises
    // listFunds() over Postgres (the fund select is empty until the giving seed
    // lands in Phase 2 Task 9, so assert the form scaffold, not fund rows). A
    // guest must verify ownership before a Stripe checkout can be attached.
    const res = await get('/en/give');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('action="/api/identity/continuation/start"');
    expect(body).toContain('name="flow" value="giving"');
    expect(body).not.toContain('action="/api/giving/checkout"');
    expect(body).not.toContain('name="identitySource"');
    expect(body).toContain('name="fund_id"');
    expect(body).toContain('name="amount"');
    expect(body).toContain('name="name"');
    expect(body).toContain('name="email"');
  });

  it('/en/give sends a signed-in giver directly to identity-bound checkout', async () => {
    const res = await get('/en/give', { cookie: await sessionCookie(1, 'admin@example.com') });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('action="/api/giving/checkout"');
    expect(body).toContain('name="identitySource" value="1"');
    expect(body).not.toContain('action="/api/identity/continuation/start"');
    expect(body).not.toContain('name="flow"');
    expect(body).not.toContain('name="name"');
    expect(body).not.toContain('name="email"');
  });

  it('/en/register renders the open-events list empty state (no reg events seeded)', async () => {
    // registration is Supabase-only and defaults ON, so /register renders over
    // Postgres via listOpenEvents(). The seed lands no reg_events, so this
    // exercises the query returning empty and the page's empty-state markup.
    const res = await get('/en/register');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Event registration'); // register.title heading
    expect(body).toContain('No events are open for registration right now'); // register.empty
  });

  it('/en/my/giving: anon → 303 to signin (route policy /my is authed)', async () => {
    const res = await get('/en/my/giving');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/signin');
  });

  it('/en/my/giving: signed-in giver → 200 (recurring/ledger/year reads over Postgres)', async () => {
    // Person 1 (admin@example.com) has no seeded gifts yet (the giving seed lands
    // in Task 9), so this exercises listRecurringForPerson / listHouseholdGifts /
    // householdYearTotals returning empty and the page rendering all three empty
    // states + the Manage portal form scaffold.
    const res = await get('/en/my/giving', { cookie: await sessionCookie(1, 'admin@example.com') });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Recurring giving'); // my.giving.recurring section heading
    expect(body).toContain('No gifts recorded yet.'); // my.giving.empty — all three sections empty
  });
});

describe('Postgres-backed worker: admin console (exercises the shortfall query)', () => {
  it('/admin/onboarding renders the shared checklist over Postgres', async () => {
    const res = await get('/admin/onboarding', { cookie: await sessionCookie(1, 'admin@example.com') });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('data-screenshot-marker="admin-onboarding"');
  });
  it('/admin/ministries: anon → 303 to signin', async () => {
    const res = await get('/admin/ministries');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/signin');
  });

  it('/admin/ministries: admin → 200 (Overview shortfall query runs over Postgres)', async () => {
    // Person 1 (admin@example.com) is the admin — Overview runs getOverviewStats +
    // getNeedsAttention (the SUM(MAX(0, needed - filled)) shortfall math) with the
    // all-scope TRUE clause.
    const res = await get('/admin/ministries', { cookie: await sessionCookie(1, 'admin@example.com') });
    expect(res.status).toBe(200);
  });

  it('/admin/ministries: team leader → 200 (leaderTeamFilter placeholder path)', async () => {
    // Person 3 (sarah) leads Worship Team — the shortfall query runs with the
    // `teams.id IN (?)` leader filter spliced into a numbered-placeholder head query
    // (the mixed ?N / ? case the translator fix handles).
    const res = await get('/admin/ministries', { cookie: await sessionCookie(3, 'sarah.johnson@example.com') });
    expect(res.status).toBe(200);
  });

  it('/admin/giving: anon → 303 to signin (finance route class)', async () => {
    const res = await get('/admin/giving');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/signin');
  });

  it('/admin/giving keeps currency amounts per gift, date-scoped counts, and offline entry over Postgres', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const res = await get('/admin/giving', { cookie });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Offline entry');
    expect(body).toContain('No funds yet. Add one to start recording gifts.');
    expect(financeRows(body, 'Gifts')).toEqual([['No gifts match these filters.']]);
    expect(financeRows(body, 'Gifts by fund')).toEqual([['No gifts match these filters.']]);
    const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${todayInTz().slice(0, 7)}-01T12:00:00Z`));
    expect(body).toContain(monthLabel);

    // Isolated test records exercise the actual mixed-currency contract. The
    // fund summary counts succeeded gifts across all funds/methods in the date
    // window; it must never combine their amounts into a USD monetary total.
    const hyperdrive = (env as unknown as { HYPERDRIVE: { connectionString: string } }).HYPERDRIVE;
    const sql = postgres(hyperdrive.connectionString, { max: 1, fetch_types: false, prepare: false, onnotice: () => {} });
    try {
      await sql.unsafe(`INSERT INTO funds (id,fund_number,active,sort) VALUES
        (99001,'PG-CURRENCY-A',1,1),(99002,'PG-CURRENCY-B',1,2)`);
      await sql.unsafe(`INSERT INTO fund_i18n (fund_id,locale,name) VALUES
        (99001,'en','Currency Alpha'),(99002,'en','Currency Beta')`);
      await sql.unsafe(`INSERT INTO gifts (fund_id,donor_name,amount_cents,currency,method,status,received_on,created_at) VALUES
        (99001,'Smoke USD gift',1234,'usd','cash','succeeded','2031-03-10','2031-03-11 12:00:00'),
        (99001,'Smoke EUR gift',4567,'eur','card','succeeded',NULL,'2031-03-10 12:00:00'),
        (99001,'Smoke refunded gift',500,'usd','card','refunded',NULL,'2031-03-10 13:00:00'),
        (99001,'Smoke outside window',9000,'usd','cash','succeeded','2031-03-09','2031-03-10 12:00:00'),
        (99002,'Smoke other fund',2000,'eur','cash','succeeded','2031-03-10','2031-03-10 12:00:00')`);

      const ledgerPath = '/admin/giving?fund=99001&from=2031-03-10&to=2031-03-10';
      const filtered = await get(ledgerPath, { cookie });
      expect(filtered.status).toBe(200);
      const html = await filtered.text();
      const ledger = financeRows(html, 'Gifts');
      expect(ledger).toHaveLength(3);
      expect(ledger.find(row => row[1] === 'Smoke USD gift')).toEqual([
        '2031-03-10', 'Smoke USD gift', 'Currency Alpha', 'Cash', '—', '$12.34 USD',
      ]);
      expect(ledger.find(row => row[1] === 'Smoke EUR gift')?.at(-1)).toBe('EUR 45.67 EUR');
      const refunded = ledger.find(row => row[1] === 'Smoke refunded gift');
      expect(refunded?.[3]).toBe('Card Refunded');
      expect(refunded?.at(-1)).toBe('$5.00 USD');
      expect(ledger.flat()).not.toContain('Smoke outside window');
      expect(ledger.flat()).not.toContain('Smoke other fund');
      const expectedCounts = [['PG-CURRENCY-A', 'Currency Alpha', '2'], ['PG-CURRENCY-B', 'Currency Beta', '1']];
      expect(financeRows(html, 'Gifts by fund')).toEqual(expectedCounts);
      expect(html).toContain('combined monetary totals are not shown');
      expect(html).not.toContain('$58.01'); // 1234 USD + 4567 EUR is not a USD total.

      const entry = html.match(/<aside\b[^>]*id="finance-manual-entry"[^>]*>([\s\S]*?)<\/aside>/)?.[1];
      expect(entry).toBeDefined();
      expect(entry).toContain('Record a received check or cash gift in USD');
      expect(entry).toContain('name="action" value="record"');
      for (const field of ['person_id', 'donor_name', 'fund_id', 'amount', 'method', 'check_number', 'received_on', 'note']) {
        expect(entry).toContain(`name="${field}"`);
      }
      expect(entry).toContain('value="cash"');
      expect(entry).toContain('value="check"');
      expect(entry).not.toContain('value="card"');

      const cash = await get(`${ledgerPath}&method=cash`, { cookie });
      expect(cash.status).toBe(200);
      const cashHtml = await cash.text();
      expect(financeRows(cashHtml, 'Gifts')).toEqual([ledger.find(row => row[1] === 'Smoke USD gift')!]);
      expect(financeRows(cashHtml, 'Gifts by fund')).toEqual(expectedCounts);
    } finally {
      try {
        await sql.unsafe('DELETE FROM gifts WHERE fund_id IN (99001,99002)');
        await sql.unsafe('DELETE FROM funds WHERE id IN (99001,99002)');
      } finally {
        await sql.end();
      }
    }
  });
});
