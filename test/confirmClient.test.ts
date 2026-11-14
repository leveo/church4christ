import { describe, expect, it, vi } from 'vitest';
import { confirmMessageFor, initConfirm } from '../src/lib/confirm-client';
import base from '../src/layouts/Base.astro?raw';
import admin from '../src/layouts/Admin.astro?raw';
import * as ui from '../src/lib/adminUi';

function fakeEl(attrs: Record<string, string>) {
  const el = { getAttribute: (n: string) => attrs[n] ?? null };
  Object.setPrototypeOf(el, (globalThis as { Element?: { prototype: object } }).Element?.prototype ?? Object.prototype);
  return el as unknown as Element;
}

describe('data-confirm handler', () => {
  it('prefers the submitter message over the form message', () => {
    expect(confirmMessageFor(fakeEl({ 'data-confirm': 'form' }), fakeEl({ 'data-confirm': 'button' }))).toBe('button');
    expect(confirmMessageFor(fakeEl({ 'data-confirm': 'form' }), fakeEl({}))).toBe('form');
    expect(confirmMessageFor(fakeEl({}), null)).toBeNull();
  });

  it('cancels the submit when the visitor declines', () => {
    class FakeElement { constructor(private a: Record<string, string>) {} getAttribute(n: string) { return this.a[n] ?? null; } }
    vi.stubGlobal('Element', FakeElement);
    let handler: ((e: unknown) => void) | undefined;
    const root = { addEventListener: (_: string, h: (e: unknown) => void) => { handler = h; } } as unknown as Document;
    const ask = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    initConfirm(root, ask);
    const make = () => ({ target: new FakeElement({}), submitter: new FakeElement({ 'data-confirm': 'Sure?' }), preventDefault: vi.fn() });
    const declined = make(); handler!(declined);
    expect(ask).toHaveBeenCalledWith('Sure?');
    expect(declined.preventDefault).toHaveBeenCalled();
    const accepted = make(); handler!(accepted);
    expect(accepted.preventDefault).not.toHaveBeenCalled();
    const plain = { target: new FakeElement({}), submitter: null, preventDefault: vi.fn() }; handler!(plain);
    expect(plain.preventDefault).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('is wired into both layouts as a bundled (CSP-safe) script', () => {
    expect(base).toContain("initConfirm");
    expect(admin).toContain("initConfirm");
  });
});

describe('adminUi touch targets', () => {
  it('keeps buttons at least 44px tall and inputs at 16px on phones', () => {
    for (const c of [ui.btn, ui.btnSecondary, ui.btnDanger]) expect(c).toContain('min-h-11');
    expect(ui.rowBtn).toContain('min-h-9');
    expect(ui.tin).toContain('text-base');
    expect(ui.tin).toContain('sm:text-sm');
  });
});
