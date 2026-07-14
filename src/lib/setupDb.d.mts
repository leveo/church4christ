import type { AppDb } from './appDb';
import type { ModuleKey } from './modules';

export function initializeModuleSettings(
  db: AppDb,
  moduleKeys: readonly ModuleKey[],
  selectedModules: readonly ModuleKey[],
): Promise<void>;

export type BootstrapStatus =
  | 'created'
  | 'already-admin'
  | 'promotion-required'
  | 'promoted'
  | 'inactive'
  | 'reactivation-required';

export function bootstrapFirstAdmin(
  db: AppDb,
  input: {
    email: string;
    displayName: string;
    locale: 'en' | 'zh';
    promoteExisting?: boolean;
  },
): Promise<{ status: BootstrapStatus; email: string }>;
