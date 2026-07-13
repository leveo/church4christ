export interface StripeTestEvent {
  id: string;
  type: string;
  api_version: string | null;
  created: number;
  livemode: boolean;
  data: {
    object: unknown;
  };
  [key: string]: unknown;
}

export function stripeEvent(
  type: string,
  object: unknown,
  over: Partial<StripeTestEvent> = {},
): StripeTestEvent {
  return {
    id: 'evt_test_000000000001',
    type,
    api_version: '2026-06-30',
    created: 1_700_000_000,
    livemode: false,
    data: { object },
    ...over,
  };
}

export async function signedStripeRequest(
  event: StripeTestEvent,
  secret = 'whsec_test',
  now = 1_700_000_000,
): Promise<Request> {
  const body = JSON.stringify(event);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${now}.${body}`),
  );
  const v1 = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${now},v1=${v1}`,
    },
    body,
  });
}
