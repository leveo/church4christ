// Every language's dictionary, design overrides, and catalog copy for the parity suites.
import capabilities from '../../config/capabilities.json';
import readiness from '../../config/readiness.json';
import en from '../../src/i18n/en';
import zh from '../../src/i18n/zh';
import { DESIGN_SOURCES } from '../../src/i18n/designRegistry';
import * as esMod from '../../src/i18n/es';
import * as ptMod from '../../src/i18n/pt';
import * as frMod from '../../src/i18n/fr';
import * as deMod from '../../src/i18n/de';
import * as jaMod from '../../src/i18n/ja';
import * as koMod from '../../src/i18n/ko';
import * as msMod from '../../src/i18n/ms';
import * as idMod from '../../src/i18n/id';
import * as viMod from '../../src/i18n/vi';
import * as hiMod from '../../src/i18n/hi';

export const dicts: Record<string, Record<string, string>> = {
  en,
  zh,
  es: esMod.default,
  pt: ptMod.default,
  fr: frMod.default,
  de: deMod.default,
  ja: jaMod.default,
  ko: koMod.default,
  ms: msMod.default,
  id: idMod.default,
  vi: viMod.default,
  hi: hiMod.default,
};
export const designs: Record<string, Record<string, Record<string, string | undefined>>> = {
  es: esMod.design as Record<string, Record<string, string | undefined>>,
  pt: ptMod.design as Record<string, Record<string, string | undefined>>,
  fr: frMod.design as Record<string, Record<string, string | undefined>>,
  de: deMod.design as Record<string, Record<string, string | undefined>>,
  ja: jaMod.design as Record<string, Record<string, string | undefined>>,
  ko: koMod.design as Record<string, Record<string, string | undefined>>,
  ms: msMod.design as Record<string, Record<string, string | undefined>>,
  id: idMod.design as Record<string, Record<string, string | undefined>>,
  vi: viMod.design as Record<string, Record<string, string | undefined>>,
  hi: hiMod.design as Record<string, Record<string, string | undefined>>,
};
export const catalogs: Record<string, unknown> = {
  es: esMod.catalog,
  pt: ptMod.catalog,
  fr: frMod.catalog,
  de: deMod.catalog,
  ja: jaMod.catalog,
  ko: koMod.catalog,
  ms: msMod.catalog,
  id: idMod.catalog,
  vi: viMod.catalog,
  hi: hiMod.catalog,
};
export const designSources = DESIGN_SOURCES as unknown as Record<string, { en: Record<string, string>; zh: Record<string, string> }>;
export const catalogBase = {
  capabilities: capabilities.capabilities,
  presets: capabilities.presets,
  readiness: readiness.checks,
};
