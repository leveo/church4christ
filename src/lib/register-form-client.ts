// Progressive enhancement for the register form. Without JavaScript every person row is
// visible, every question shows and the household chips stay hidden; with it, blank extra rows collapse behind
// "Add another person", rows can be removed, a household member is one tap, and the first
// invalid field (or the error summary) takes focus after a bounced review.
// Bundled with the page (no inline script), so it works under a strict script policy.

import { initShowIf } from './reg-showif-client';

export function initRegisterForm(root: Document = document): void {
  const form = root.querySelector<HTMLFormElement>('[data-register-form]');
  if (!form) return;

  // Focus: the first invalid control, else the summary (screen readers announce its alert role).
  const firstInvalid = form.querySelector<HTMLElement>('[aria-invalid="true"]');
  const summary = form.querySelector<HTMLElement>('#f-summary');
  if (firstInvalid) firstInvalid.focus();
  else summary?.focus();

  // Show-if (and the required toggling of each person's questions): runs again whenever a person row appears or goes.
  const refresh = initShowIf(form) ?? (() => {});
  const party = form.querySelector<HTMLElement>('[data-party]');
  if (!party) return;
  const rows = [...party.querySelectorAll<HTMLElement>('[data-person-row]')];
  const add = party.querySelector<HTMLButtonElement>('[data-add-person]');
  const household = party.querySelector<HTMLElement>('[data-household]');
  const chips = [...party.querySelectorAll<HTMLButtonElement>('[data-chip]')];
  const nameOf = (row: HTMLElement) => row.querySelector<HTMLInputElement>('input[name^="person_name_"]')!;
  const idOf = (row: HTMLElement) => row.querySelector<HTMLInputElement>('input[name^="person_id_"]')!;

  const sync = (): void => {
    const hiddenRows = rows.filter((r) => r.hidden);
    if (add) add.hidden = hiddenRows.length === 0;
    for (const row of rows) {
      const remove = row.querySelector<HTMLButtonElement>('[data-remove-person]');
      if (remove) remove.hidden = row.hidden;
    }
    const chosen = new Set(rows.filter((r) => !r.hidden).map((r) => idOf(r).value + '|' + nameOf(r).value.trim()));
    for (const chip of chips) {
      const on = chosen.has((chip.dataset.personId ?? '') + '|' + (chip.dataset.name ?? '').trim());
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    refresh();
  };

  // Collapse the rows nobody filled in; the first extra row stays out of sight too until asked for.
  for (const row of rows) row.hidden = nameOf(row).value.trim() === '' && !row.querySelector('[aria-invalid="true"]');
  if (household) household.hidden = false;

  const reveal = (): HTMLElement | null => {
    const next = rows.find((r) => r.hidden);
    if (!next) return null;
    next.hidden = false;
    sync();
    return next;
  };

  add?.addEventListener('click', () => {
    const row = reveal();
    if (row) nameOf(row).focus();
  });

  for (const row of rows) {
    row.querySelector('[data-remove-person]')?.addEventListener('click', () => {
      nameOf(row).value = '';
      idOf(row).value = '';
      row.hidden = true;
      sync();
      add?.focus();
    });
  }

  for (const chip of chips) {
    chip.addEventListener('click', () => {
      const personId = chip.dataset.personId ?? '';
      const name = chip.dataset.name ?? '';
      // Tapping a chosen chip again removes that person.
      const existing = rows.find((r) => !r.hidden && idOf(r).value === personId && nameOf(r).value.trim() === name.trim());
      if (existing) {
        nameOf(existing).value = '';
        idOf(existing).value = '';
        existing.hidden = true;
        sync();
        return;
      }
      const target = rows.find((r) => !r.hidden && nameOf(r).value.trim() === '') ?? reveal();
      if (!target) return;
      nameOf(target).value = name;
      idOf(target).value = personId;
      sync();
    });
  }
  // Typing over a chosen name makes it an ordinary guest again (the server drops a stale person id anyway).
  for (const row of rows) {
    nameOf(row).addEventListener('input', () => {
      if (idOf(row).value !== '') idOf(row).value = '';
      sync();
    });
  }
  sync();
}
