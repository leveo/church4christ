// Registry of the per-surface "design" copy maps. Each design*.ts file keeps its
// English source and Chinese translation next to the code that reads them; every
// other language supplies a PARTIAL override per section from its own locale file
// (`export const design` in src/i18n/<code>.ts). Missing keys fall back along the
// chain (requested, default, en) in `designCopy` (src/lib/i18n.ts).
import { careSource } from './designCare';
import { careToolsSource } from './designCareTools';
import { contentSource } from './designContent';
import { financeSource } from './designFinance';
import { frontdoorSource } from './designFrontdoor';
import { gatheringsSource } from './designGatherings';
import { memberSource } from './designMember';
import { ministrySource } from './designMinistry';
import { operationsSource } from './designOperations';
import { publicSource } from './designPublic';

export const DESIGN_SOURCES = {
  care: careSource,
  careTools: careToolsSource,
  content: contentSource,
  finance: financeSource,
  frontdoor: frontdoorSource,
  gatherings: gatheringsSource,
  member: memberSource,
  ministry: ministrySource,
  operations: operationsSource,
  public: publicSource,
} as const;

export type DesignSection = keyof typeof DESIGN_SOURCES;

/** What a locale file exports as `design`: a partial override per section. */
export type DesignOverrides = {
  [S in DesignSection]?: Partial<Record<keyof (typeof DESIGN_SOURCES)[S]['en'], string>>;
};
