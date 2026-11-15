import { describe, expect, it } from 'vitest';
import { checkCatalog, checkDesign, checkDictionary, translatableText } from '../../scripts/i18n/lib.mjs';

const en = {
  'nav.home': 'Home',
  'greet': 'Hello {name}, <b>welcome</b>',
  'site.name': 'Church4Christ',
  'learning.provider.google': 'Google Classroom',
  'admin.people.save': 'Save changes',
};

describe('translation quality gates', () => {
  it('passes a faithful complete translation', () => {
    const es = { 'nav.home': 'Inicio', greet: 'Hola {name}, <b>bienvenido</b>', 'site.name': 'Church4Christ', 'learning.provider.google': 'Google Classroom', 'admin.people.save': 'Guardar' };
    expect(checkDictionary('es', en, es, { complete: true })).toEqual({ errors: [], warnings: [] });
  });

  it('flags missing keys only when complete', () => {
    expect(checkDictionary('es', en, { 'nav.home': 'Inicio' }, { complete: true }).errors.some((e) => e.includes('greet is missing'))).toBe(true);
    expect(checkDictionary('es', en, { 'nav.home': 'Inicio' }, { complete: false }).errors).toEqual([]);
  });

  it('always rejects extra keys, empty values, and placeholder or tag drift', () => {
    const errors = checkDictionary('es', en, { extra: 'x', 'nav.home': ' ', greet: 'Hola <i>bienvenido</i>' }, { complete: false }).errors.join('\n');
    expect(errors).toMatch(/extra is not a key/);
    expect(errors).toMatch(/nav.home is empty/);
    expect(errors).toMatch(/greet placeholders/);
    expect(errors).toMatch(/greet HTML tags/);
  });

  it('rejects untranslated English copy unless allowlisted', () => {
    const errors = checkDictionary('fr', en, { 'nav.home': 'Home', 'site.name': 'Church4Christ', 'learning.provider.google': 'Google Classroom' }, { complete: true }).errors;
    expect(errors.filter((e) => e.includes('identical to English')).map((e) => e.split(' ')[0])).toEqual(['fr:nav.home']);
  });

  it('requires the language script and rejects foreign script in Latin languages', () => {
    const ja = checkDictionary('ja', { a: 'Home' }, { a: 'Casa' }, { complete: true }).errors;
    expect(ja.join()).toMatch(/no ja script/);
    expect(checkDictionary('ja', { a: 'Home' }, { a: 'ホーム' }, { complete: true }).errors).toEqual([]);
    expect(checkDictionary('ja', { a: 'Home' }, { a: '家' }, { complete: true }).errors).toEqual([]);
    expect(checkDictionary('ko', { a: 'Home' }, { a: 'ホーム' }, { complete: true }).errors.join()).toMatch(/no ko script/);
    expect(checkDictionary('hi', { a: 'Home' }, { a: 'होम' }, { complete: true }).errors).toEqual([]);
    expect(checkDictionary('es', { a: 'Home' }, { a: '首页' }, { complete: false }).errors.join()).toMatch(/non-Latin/);
  });

  it('warns, without failing, when a nav or button label is much longer than English', () => {
    const result = checkDictionary('de', { 'nav.home': 'Home', 'admin.people.save': 'Save' }, { 'nav.home': 'Startseitenübersicht', 'admin.people.save': 'Änderungen speichern' }, { complete: true });
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBe(2);
    const long = checkDictionary('de', { 'admin.misc.body': 'A sentence here' }, { 'admin.misc.body': 'Ein sehr langer deutscher Satz hier' }, { complete: true });
    expect(long.warnings).toEqual([]);
  });

  it('ignores text with nothing left to translate', () => {
    expect(translatableText('{type} · {size}')).toBe('');
    expect(translatableText('<b>12</b> https://x.test a@b.test')).toBe('');
    expect(checkDictionary('es', { a: '{type} · {size}' }, { a: '{type} · {size}' }, { complete: true }).errors).toEqual([]);
  });

  it('checks design sections and catalog copy the same way', () => {
    const sources = { care: { en: { hello: 'Hello there', bye: 'Goodbye' }, zh: { hello: '你好', bye: '再见' } } };
    expect(checkDesign('zh', sources, undefined, { complete: true }).errors).toEqual([]);
    expect(checkDesign('es', sources, { care: { hello: 'Hola' } }, { complete: true }).errors.join()).toMatch(/design.care.bye is missing/);
    expect(checkDesign('es', sources, { care: { hello: 'Hola' } }, { complete: false }).errors).toEqual([]);
    expect(checkDesign('es', sources, { nope: {} } as never, { complete: false }).errors.join()).toMatch(/not a design section/);

    const base = {
      capabilities: { events: { labels: { en: 'Events', zh: '活动' }, descriptions: { en: 'Publish events.', zh: '发布活动。' } } },
      presets: {},
      readiness: [{ id: 'backups', title: { en: 'Backups', zh: '备份' }, description: { en: 'Back up data.', zh: '备份数据。' }, remediation: { en: 'Schedule one.', zh: '安排一个。' } }],
    };
    expect(checkCatalog('zh', base, undefined, { complete: true }).errors).toEqual([]);
    const partial = { capabilities: { events: { label: 'Eventos' } } };
    expect(checkCatalog('es', base, partial, { complete: false }).errors).toEqual([]);
    expect(checkCatalog('es', base, partial, { complete: true }).errors.length).toBe(4);
    expect(checkCatalog('es', base, { readiness: { ghost: { title: 'x' } } }, { complete: false }).errors.join()).toMatch(/ghost is not in the catalog/);
  });
});
