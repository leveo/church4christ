import { describe, it, expect } from 'vitest';
import { parseGroupForm } from '../src/lib/groupForms';

const fdOf = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

describe('parseGroupForm', () => {
  it('parses a full form, trimming name/description and reading the checkbox + kind/term', () => {
    const r = parseGroupForm(
      fdOf({
        name: '  Young Adults  ', description: '  Meets Fridays  ', is_public: 'on',
        kind: 'sunday_school', term_label: '  Fall 2026  ', term_start: '2026-09-01', term_end: '2026-12-15',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      name: 'Young Adults', description: 'Meets Fridays', isPublic: true,
      kind: 'sunday_school', termLabel: 'Fall 2026', termStart: '2026-09-01', termEnd: '2026-12-15',
    });
  });

  it('defaults a blank description to empty string, absent checkbox to false, and kind to fellowship', () => {
    const r = parseGroupForm(fdOf({ name: 'Prayer Partners' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      name: 'Prayer Partners', description: '', isPublic: false,
      kind: 'fellowship', termLabel: null, termStart: null, termEnd: null,
    });
  });

  it('falls back to fellowship for an unrecognized kind', () => {
    const r = parseGroupForm(fdOf({ name: 'X', kind: 'bogus' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.kind).toBe('fellowship');
  });

  it('rejects a malformed term date', () => {
    const r = parseGroupForm(fdOf({ name: 'X', term_start: '09/01/2026' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.term_start).toBe('errors.dateFormat');
  });

  it('requires a non-blank name', () => {
    const r = parseGroupForm(fdOf({ name: '   ' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.name).toBe('errors.required');
  });

  it('rejects a name over 200 chars', () => {
    const r = parseGroupForm(fdOf({ name: 'a'.repeat(201) }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.name).toBe('errors.tooLong');
  });

  it('accepts a name at exactly the 200-char cap', () => {
    const r = parseGroupForm(fdOf({ name: 'a'.repeat(200) }));
    expect(r.ok).toBe(true);
  });

  it('rejects a description over 5000 chars', () => {
    const r = parseGroupForm(fdOf({ name: 'X', description: 'a'.repeat(5001) }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.description).toBe('errors.tooLong');
  });

  it('accepts a description at exactly the 5000-char cap', () => {
    const r = parseGroupForm(fdOf({ name: 'X', description: 'a'.repeat(5000) }));
    expect(r.ok).toBe(true);
  });

  it('reports both errors at once for a blank name and an over-length description', () => {
    const r = parseGroupForm(fdOf({ name: '', description: 'a'.repeat(5001) }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.name).toBe('errors.required');
    expect(r.errors.description).toBe('errors.tooLong');
  });
});
