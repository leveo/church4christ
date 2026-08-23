import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { identityPinnedConfigurationMismatchResponse, identityVerificationHealthResponse } from '../../../lib/identitySecret';
import { ensureIdentitySourceKeyConfiguration } from '../../../lib/identityGateway';
import { ensureIdentityRecoveryKeyConfiguration } from '../../../lib/identityRecoveryKey';

export const prerender = false;

type IdentityHealthEnv = {
  IDENTITY_VERIFICATION_SECRET?: string;
  IDENTITY_SOURCE_KEY_SECRET?: string;
  IDENTITY_SOURCE_KEY_ID?: string;
  IDENTITY_RECOVERY_KEY_SECRET?: string;
  IDENTITY_RECOVERY_KEY_ID?: string;
};
const response: APIRoute = async ({ locals }) => {
  const bindings = env as unknown as IdentityHealthEnv;
  const syntax = identityVerificationHealthResponse(bindings.IDENTITY_VERIFICATION_SECRET,
    bindings.IDENTITY_SOURCE_KEY_SECRET, bindings.IDENTITY_SOURCE_KEY_ID,
    bindings.IDENTITY_RECOVERY_KEY_SECRET, bindings.IDENTITY_RECOVERY_KEY_ID);
  if (syntax.status !== 204) return syntax;
  try {
    await ensureIdentitySourceKeyConfiguration(locals.rawDb, bindings);
    await ensureIdentityRecoveryKeyConfiguration(locals.rawDb, bindings);
    return syntax;
  } catch {
    return identityPinnedConfigurationMismatchResponse();
  }
};

export const GET: APIRoute = response;
export const HEAD: APIRoute = response;
