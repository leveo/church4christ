// Editors for the languages beyond the en/zh columns (workers project, migrated D1):
// the extra `*_i18n` rows must round-trip through the admin read/write paths so enabling a
// third language never drops text entered in it.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { extraLocalePosted, extraLocaleTexts, loadExtraI18n, localeValues, saveExtraI18n } from '../src/lib/i18nExtras';
import { createMinistryFromWizard, listMinistryEditRows, updateMinistryBasics, type MinistryWizardInput } from '../src/lib/ministryDb';
import { createTeam, listServiceTypesAdmin, saveServiceType } from '../src/lib/teamDb';
import { getCustomPage, saveCustomPage } from '../src/lib/pagesDb';

describe('extra-language form helpers', () => {
  it('reads only the extra languages, trimming and dropping blanks', () => {
    const fields: Record<string, string> = { name_en: 'E', name_zh: 'Z', name_es: ' Hola ', name_fr: '  ', name_ja: 'こんにちは' };
    expect(extraLocaleTexts((field) => fields[field] ?? '', 'name')).toEqual({ es: 'Hola', ja: 'こんにちは' });
  });

  it('keeps posted blanks (to clear a translation) but omits fields that were not posted', () => {
    const fd = new FormData();
    fd.set('name_es', ' ');
    fd.set('name_de', 'Hallo');
    expect(extraLocalePosted(fd, 'name')).toEqual({ es: '', de: 'Hallo' });
  });

  it('merges the legacy pair with the extra languages for the tabbed editor', () => {
    expect(localeValues({ en: 'Home', zh: null }, { es: { name: 'Inicio' } }, 'name')).toEqual({ en: 'Home', zh: '', es: 'Inicio' });
  });
});

describe('ministries', () => {
  const input = (overrides: Partial<MinistryWizardInput> = {}): MinistryWizardInput => ({
    name_en: 'Hospitality', name_zh: '接待', category: 'care', icon: '☕', intro_en: 'Welcome.', intro_zh: null,
    leader_person_id: null, meeting_time: null, positions: [], frequency: 'irregular', autoGenerate: false, ...overrides,
  });

  it('stores, lists, updates, and clears extra-language names', async () => {
    const id = await createMinistryFromWizard(env.DB, input({ extra: { names: { es: 'Hospitalidad' }, intros: { es: 'Bienvenidos.' } } }));
    let row = (await listMinistryEditRows(env.DB)).find((r) => r.id === id)!;
    expect(row.extra.es).toEqual({ name: 'Hospitalidad', intro: 'Bienvenidos.' });
    expect(row.name_en).toBe('Hospitality');

    await updateMinistryBasics(env.DB, id, {
      name_en: 'Hospitality', name_zh: '接待', category: 'care', icon: '☕', intro_en: 'Welcome.', intro_zh: null, leader_person_id: null,
      extra: { names: { es: 'Acogida', fr: 'Accueil' } },
    });
    row = (await listMinistryEditRows(env.DB)).find((r) => r.id === id)!;
    expect(row.extra.es?.name).toBe('Acogida');
    expect(row.extra.es?.intro).toBe('Bienvenidos.'); // an update that omits intros leaves them alone
    expect(row.extra.fr?.name).toBe('Accueil');

    await updateMinistryBasics(env.DB, id, {
      name_en: 'Hospitality', name_zh: '接待', category: 'care', icon: '☕', intro_en: 'Welcome.', intro_zh: null, leader_person_id: null,
      extra: { names: { es: '' } },
    });
    row = (await listMinistryEditRows(env.DB)).find((r) => r.id === id)!;
    expect(row.extra.es).toBeUndefined();
    expect(row.extra.fr?.name).toBe('Accueil');
  });

  it('falls back to another language for the English row when only an extra name is given', async () => {
    const id = await createMinistryFromWizard(env.DB, input({ name_en: '', name_zh: '', extra: { names: { de: 'Gastfreundschaft' } } }));
    const en = await env.DB.prepare(`SELECT name FROM ministry_i18n WHERE ministry_id = ?1 AND locale = 'en'`).bind(id).first<{ name: string }>();
    expect(en?.name).toBe('Gastfreundschaft');
  });
});

describe('teams, service types, and custom pages', () => {
  it('creates a team with extra-language names', async () => {
    const id = await createTeam(env.DB, { ministryId: null, nameEn: 'Ushers', extraNames: { pt: 'Recepcionistas', ko: '' } });
    const map = await loadExtraI18n(env.DB, 'team_i18n', 'team_id', ['name']);
    expect(map.get(String(id))).toEqual({ pt: { name: 'Recepcionistas' } });
  });

  it('saves and reads service type names in other languages', async () => {
    const id = await saveServiceType(env.DB, null, { nameEn: 'Sunday', nameZh: null, extraNames: { es: 'Domingo' }, startTime: null, endTime: null, sort: 0 });
    let row = (await listServiceTypesAdmin(env.DB)).find((r) => r.id === id)!;
    expect(row.extra.es?.name).toBe('Domingo');
    await saveServiceType(env.DB, id, { nameEn: 'Sunday', nameZh: null, extraNames: { es: '' }, startTime: null, endTime: null, sort: 0 });
    row = (await listServiceTypesAdmin(env.DB)).find((r) => r.id === id)!;
    expect(row.extra.es).toBeUndefined();
  });

  it('round-trips a custom page in an extra language', async () => {
    const saved = (await saveCustomPage(env.DB, {
      id: null, slug: 'extras', published: true, title_en: 'About', title_zh: '', body_en: 'Body', body_zh: '',
      extra: { es: { title: 'Acerca', body_md: 'Cuerpo' } }, updatedBy: 'ed@example.com',
    })) as { ok: true; id: string };
    const page = await getCustomPage(env.DB, saved.id);
    expect(page?.extra.es).toEqual({ title: 'Acerca', body_md: 'Cuerpo' });
    expect(page?.i18n.en.title).toBe('About');
  });

  it('rejects an unsafe identifier before building SQL', async () => {
    await expect(saveExtraI18n(env.DB, 'team_i18n', 'team_id', 1, { es: { 'name; DROP': 'x' } }, 'name')).rejects.toThrow(/unsafe identifier/);
  });
});
