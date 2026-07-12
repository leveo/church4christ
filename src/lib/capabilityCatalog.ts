import raw from '../../config/capabilities.json';
import { validateCapabilityCatalog } from '../../scripts/lib/validate-capability-catalog.mjs';

export type CapabilityKey = keyof typeof raw.capabilities;
export type ProviderKey = keyof typeof raw.providers;
export type ServiceKey = (typeof raw.services)[number];
export type CapabilityGroup = (typeof raw.groups)[number];

export interface CapabilityDef {
  order: number;
  labels: { en: string; zh: string };
  descriptions: { en: string; zh: string };
  group: CapabilityGroup;
  publicPrefixes: string[];
  adminPrefixes: string[];
  navKeys: string[];
  uses: CapabilityKey[];
  dependsOn: CapabilityKey[];
  requiresBackend?: ProviderKey;
  requiredServices: ServiceKey[];
  optionalServices: ServiceKey[];
  seedProfiles: string[];
  readinessChecks: string[];
}

validateCapabilityCatalog(raw);
export const CAPABILITY_CATALOG = raw;
export const CAPABILITY_KEYS = Object.freeze([...raw.order]) as readonly CapabilityKey[];
export const CAPABILITIES = raw.capabilities as Record<CapabilityKey, CapabilityDef>;
