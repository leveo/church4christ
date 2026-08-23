import { describe, expect, it, vi } from 'vitest';
import {
  PlanningCenterBadResponseError,
  PlanningCenterNotFoundError,
  PlanningCenterRateLimitError,
  fetchPlanningCenterPage,
  fetchPlanningCenterOrganization,
  nextPlanningCenterUrl,
  parsePlanningCenterWebhookEnvelope,
  validatePlanningCenterBaseUrl,
  verifyPlanningCenterWebhook,
} from '../../src/lib/planningCenterClient';

const base = 'https://api.planningcenteronline.com';
function response(body: string, init: ResponseInit = {}): Response { return new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.api+json' }, ...init }); }

describe('Planning Center bounded client', () => {
  it('accepts only the official same-origin API base and next links', () => {
    expect(validatePlanningCenterBaseUrl(base)).toBe(base);
    expect(() => validatePlanningCenterBaseUrl('http://api.planningcenteronline.com')).toThrow();
    expect(() => validatePlanningCenterBaseUrl('https://evil.invalid')).toThrow();
    expect(nextPlanningCenterUrl(base, { next: 'https://api.planningcenteronline.com/people/v2/people?page=2' })).toContain('page=2');
    expect(() => nextPlanningCenterUrl(base, { next: 'https://evil.invalid/steal' })).toThrow();
    expect(() => nextPlanningCenterUrl(base, { next: `${base}/oauth/token` })).toThrow();
    expect(() => nextPlanningCenterUrl(base, { next: `${base}/people/v2/people/1/../../oauth/token` })).toThrow();
  });

  it('validates JSON:API shape and bounds oversized/truncated responses', async () => {
    const fetcher = vi.fn(async () => response(JSON.stringify({ data: [{ type: 'Person', id: '1', attributes: {}, relationships: { emails: { data: [{ type: 'Email', id: 'e1' }] } } }], included: [{ type: 'Email', id: 'e1', attributes: { address: 'ada@example.test' } }], links: { next: null } }), { headers: { 'x-pco-api-request-rate-limit': '100', 'x-pco-api-request-rate-count': '7', 'x-pco-api-request-rate-period': '20 seconds' } }));
    const page = await fetchPlanningCenterPage({ baseUrl: base, path: '/people/v2/people', clientId: 'client_test', secret: 'secret_test', userAgent: 'Church CMS <https://church.example/contact>', fetcher });
    expect(page.data[0].id).toBe('1');
    expect(page.included[0].attributes.address).toBe('ada@example.test');
    expect(page.rate).toMatchObject({ limit: 100, count: 7, remaining: 93, periodSeconds: 20 });
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ headers: expect.objectContaining({ 'user-agent': 'Church CMS <https://church.example/contact>', authorization: expect.stringMatching(/^Basic /u) }) }));
    await expect(fetchPlanningCenterPage({ baseUrl: base, path: '/people/v2/people', clientId: 'client_test', secret: 'secret_test', userAgent: 'Church CMS <https://church.example/contact>', fetcher: vi.fn(async () => response('{')) })).rejects.toBeInstanceOf(PlanningCenterBadResponseError);
    await expect(fetchPlanningCenterPage({ baseUrl: base, path: '/people/v2/people', clientId: 'client_test', secret: 'secret_test', userAgent: 'Church CMS <https://church.example/contact>', maxBytes: 2, fetcher: vi.fn(async () => response('123')) })).rejects.toBeInstanceOf(PlanningCenterBadResponseError);
  });

  it('normalizes an exact-person JSON:API singleton into one bounded page row', async () => {
    const fetcher = vi.fn(async () => response(JSON.stringify({
      data: {
        type: 'Person', id: '6010', attributes: { first_name: 'Exact' },
        relationships: { emails: { data: [{ type: 'Email', id: 'e1' }] } },
      },
      included: [{ type: 'Email', id: 'e1', attributes: { address: 'exact@example.test', primary: true, blocked: false } }],
      links: { self: `${base}/people/v2/people/6010` },
    })));
    const page = await fetchPlanningCenterPage({
      baseUrl: base,
      path: '/people/v2/people/6010?include=emails,phone_numbers',
      clientId: 'client_test', secret: 'secret_test',
      userAgent: 'Church CMS <https://church.example/contact>', fetcher,
    });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ type: 'Person', id: '6010' });
    expect(page.included).toHaveLength(1);
  });

  it('requires an exact-person response to be one matching Person singleton', async () => {
    const input = {
      baseUrl: base,
      path: '/people/v2/people/6010?include=emails,phone_numbers',
      clientId: 'client_test', secret: 'secret_test',
      userAgent: 'Church CMS <https://church.example/contact>',
    };
    await expect(fetchPlanningCenterPage({
      ...input,
      fetcher: vi.fn(async () => response(JSON.stringify({
        data: [{ type: 'Person', id: '6010', attributes: {} }, { type: 'Person', id: '9999', attributes: {} }],
        included: [], links: {},
      }))),
    })).rejects.toBeInstanceOf(PlanningCenterBadResponseError);
    await expect(fetchPlanningCenterPage({
      ...input,
      fetcher: vi.fn(async () => response(JSON.stringify({ data: { type: 'Email', id: '6010', attributes: {} }, included: [], links: {} }))),
    })).rejects.toBeInstanceOf(PlanningCenterBadResponseError);
    await expect(fetchPlanningCenterPage({
      ...input,
      fetcher: vi.fn(async () => response(JSON.stringify({ data: { type: 'Person', id: '6011', attributes: {} }, included: [], links: {} }))),
    })).rejects.toBeInstanceOf(PlanningCenterBadResponseError);
  });

  it('rejects excessive included resources and link maps even below the byte ceiling', async () => {
    const input = { baseUrl: base, path: '/people/v2/people', clientId: 'client_test', secret: 'secret_test', userAgent: 'Church CMS <https://church.example/contact>' };
    const included = Array.from({ length: 5_001 }, (_, index) => ({ type: 'Email', id: String(index + 1), attributes: {} }));
    await expect(fetchPlanningCenterPage({ ...input, fetcher: vi.fn(async () => response(JSON.stringify({ data: [], included, links: {} }))) })).rejects.toBeInstanceOf(PlanningCenterBadResponseError);
    const links = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`page${index}`, null]));
    await expect(fetchPlanningCenterPage({ ...input, fetcher: vi.fn(async () => response(JSON.stringify({ data: [], included: [], links }))) })).rejects.toBeInstanceOf(PlanningCenterBadResponseError);
  });

  it('surfaces 429 Retry-After and 404 without hard-coded rate capacity', async () => {
    await expect(fetchPlanningCenterPage({ baseUrl: base, path: '/people/v2/people', clientId: 'client_test', secret: 'secret_test', userAgent: 'Church CMS <https://church.example/contact>', fetcher: vi.fn(async () => response('', { status: 429, headers: { 'retry-after': '7' } })) })).rejects.toBeInstanceOf(PlanningCenterRateLimitError);
    await expect(fetchPlanningCenterPage({ baseUrl: base, path: '/people/v2/people', clientId: 'client_test', secret: 'secret_test', userAgent: 'Church CMS <https://church.example/contact>', fetcher: vi.fn(async () => response('', { status: 404 })) })).rejects.toBeInstanceOf(PlanningCenterNotFoundError);
  });

  it('authoritatively validates the singleton organization resource', async () => {
    const organization = await fetchPlanningCenterOrganization({ baseUrl: base, clientId: 'client_test', secret: 'secret_test', userAgent: 'Church CMS (https://church.example/contact)', fetcher: vi.fn(async () => response(JSON.stringify({ data: { type: 'Organization', id: '42', attributes: { name: 'Example' } } })) ) });
    expect(organization).toEqual({ id: '42' });
    await expect(fetchPlanningCenterOrganization({ baseUrl: base, clientId: 'client_test', secret: 'secret_test', userAgent: 'Church CMS (https://church.example/contact)', fetcher: vi.fn(async () => response(JSON.stringify({ data: { type: 'Person', id: '42', attributes: {} } }))) })).rejects.toBeInstanceOf(PlanningCenterBadResponseError);
  });

  it('authenticates the raw body with the official authenticity header and rejects forged signatures', async () => {
    const body = '{"data":{"type":"Person","id":"1"}}';
    const secret = 's'.repeat(32);
    const signature = await verifyPlanningCenterWebhook('bad', body, secret);
    expect(signature.ok).toBe(false);
    const valid = await verifyPlanningCenterWebhook(await (async () => { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)); return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join(''); })(), body, secret);
    expect(valid.ok).toBe(true);
    expect((await verifyPlanningCenterWebhook('00', body, secret)).ok).toBe(false);
  });

  it('extracts only opaque delivery metadata from the EventDelivery envelope', () => {
    const envelope = parsePlanningCenterWebhookEnvelope(JSON.stringify({ data: [{ type: 'EventDelivery', id: 'delivery-1', attributes: { name: 'people.v2.events.person.updated', attempt: 2, payload: '{"email":"never-store"}' }, relationships: { organization: { data: { type: 'Organization', id: '42' } } } }] }));
    expect(envelope).toEqual({ deliveryId: 'delivery-1', eventType: 'people.v2.events.person.updated', attempt: 2, organizationId: '42', providerPersonId: null });
    expect(() => parsePlanningCenterWebhookEnvelope(JSON.stringify({ data: [{ type: 'EventDelivery', id: 'delivery-1', attributes: { name: 'people.v2.events.person.updated', attempt: 0 }, relationships: { organization: { data: { id: '42' } } } }] }))).toThrow();
    expect(() => parsePlanningCenterWebhookEnvelope(JSON.stringify({ data: [{ type: 'EventDelivery', id: 'delivery-2', attributes: { name: 'people.v2.events.person.updated', attempt: 1 }, relationships: { organization: { data: { id: 'not-numeric' } } } }] }))).toThrow();
  });
});
