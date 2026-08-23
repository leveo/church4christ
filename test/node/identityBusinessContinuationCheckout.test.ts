import { describe, expect, it, vi } from 'vitest';
import { StripeError } from '../../src/lib/stripe';
import { continuePaidRegistrationCheckout } from '../../src/lib/identityBusinessContinuation';
import type { CheckoutRequestResolution } from '../../src/lib/stripeCheckoutRequests';

const resolution: CheckoutRequestResolution = {
  kind: 'create', registrationId: 77, requestId: '11111111-1111-4111-8111-111111111111',
  requestJson: {
    metadata: { registration_id: '77' }, line_items: [{ price_data: { currency: 'usd', unit_amount: 2500, product_data: { name: 'Event' } }, quantity: 1 }],
    mode: 'payment', success_url: 'https://church.invalid/done', cancel_url: 'https://church.invalid/cancel', customer_email: 'a@example.com',
  } as never,
};
const env = { STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', APP_ORIGIN: 'https://church.invalid' };
const db = {} as never;

describe('paid registration continuation checkout saga', () => {
  it('creates once, attaches durably, and returns redirect', async () => {
    const create = vi.fn(async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/1' }));
    const result = await continuePaidRegistrationCheckout(db, env, resolution, 9, {
      createCheckout: create as never, attachRequest: vi.fn(async () => true), cancelRequest: vi.fn(), continueRequest: vi.fn(),
    });
    expect(create).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: 'redirect', registrationId: 77, checkoutUrl: 'https://checkout.stripe.com/c/pay/1' });
  });

  it('keeps ambiguous transport failures recoverable without cancelling', async () => {
    const cancel = vi.fn();
    const result = await continuePaidRegistrationCheckout(db, env, resolution, 9, {
      createCheckout: vi.fn(async () => { throw new StripeError('timeout', { stage: 'transport' }); }) as never,
      attachRequest: vi.fn(), cancelRequest: cancel, continueRequest: vi.fn(),
    });
    expect(result).toEqual({ kind: 'waiting', registrationId: 77 });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels deterministic Stripe failures through the existing compensation path', async () => {
    const cancel = vi.fn(async () => true);
    const result = await continuePaidRegistrationCheckout(db, env, resolution, 9, {
      createCheckout: vi.fn(async () => { throw new StripeError('bad request', { stage: 'response', status: 400 }); }) as never,
      attachRequest: vi.fn(), cancelRequest: cancel, continueRequest: vi.fn(),
    });
    expect(result).toEqual({ kind: 'expired' });
    expect(cancel).toHaveBeenCalledWith(db, resolution.requestId, resolution.registrationId);
  });

  it('converges an attach race without creating a second Stripe session', async () => {
    const create = vi.fn(async () => ({ id: 'cs_test_2', url: 'https://checkout.stripe.com/c/pay/2' }));
    const result = await continuePaidRegistrationCheckout(db, env, resolution, 9, {
      createCheckout: create as never, attachRequest: vi.fn(async () => false), cancelRequest: vi.fn(),
      continueRequest: vi.fn(async () => ({ kind: 'redirect' as const, registrationId: 77, checkoutUrl: 'https://checkout.stripe.com/c/pay/winner' })),
    });
    expect(result).toEqual({ kind: 'redirect', registrationId: 77, checkoutUrl: 'https://checkout.stripe.com/c/pay/winner' });
    expect(create).toHaveBeenCalledOnce();
  });
});
