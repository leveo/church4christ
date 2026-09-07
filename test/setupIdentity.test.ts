import { env } from 'cloudflare:test';
import { describe } from 'vitest';
import { setupIdentityContracts } from './helpers/setupIdentityContracts';

describe('trusted setup identity boundary on D1', () => {
  setupIdentityContracts(() => env.DB);
});
