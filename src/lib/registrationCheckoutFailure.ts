import { StripeError } from './stripe';

export type RegistrationCheckoutFailureAction = 'cancel' | 'recover';
const AMBIGUOUS_4XX = new Set([408, 409, 424, 429]);

/** Shared compensation policy for every paid-registration entry point. */
export function classifyRegistrationCheckoutFailure(error: unknown): RegistrationCheckoutFailureAction {
  if (!(error instanceof StripeError)) return 'recover';
  if (error.stage === 'configuration') return 'cancel';
  if (error.stage !== 'response') return 'recover';
  if (error.code === 'stripe_response_invalid' || error.code === 'live_mode_disabled') return 'recover';
  return error.status !== undefined && error.status >= 400 && error.status < 500 && !AMBIGUOUS_4XX.has(error.status)
    ? 'cancel' : 'recover';
}
