// One ticket type: name and description per language, price, limit, active, reorder, delete.
import { useState, type Dispatch } from 'react';
import { lab } from '../../lib/adminUi';
import type { DraftTicket, FormAction } from './model';
import { FieldError, dangerSmallBtn, fieldError, inputClass, smallBtn, type CardIssues, type LocaleOption, type Translate } from './ui';

export interface TicketCardProps {
  ticket: DraftTicket;
  index: number;
  total: number;
  locales: LocaleOption[];
  defaultLocale: string;
  isD1: boolean;
  issues?: CardIssues;
  dispatch: Dispatch<FormAction>;
  t: Translate;
  onNudge: (direction: -1 | 1) => void;
  onDelete: () => void;
}

export default function TicketCard(p: TicketCardProps) {
  const { ticket: tk, index, t, dispatch, defaultLocale } = p;
  const [confirming, setConfirming] = useState(false);
  const err = (field: string) => fieldError(p.issues, field);
  const id = (name: string) => `rt-${tk.cid}-${name}`;
  const others = p.locales.filter((l) => l.code !== defaultLocale);
  const nameErr = err(`labels.${defaultLocale}`);
  const priceErr = err('price_cents');
  const capErr = err('capacity');
  const holders = tk.taken > 0;
  return (
    <li className="rounded-xl border border-border bg-surface-raised p-4 shadow-sm" data-testid="ticket-card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="grow text-sm font-semibold">
          {t('ticket.n', { n: index + 1 })}
          {!tk.active && <span className="ml-2 rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-medium text-ink-muted">{t('ticket.inactive')}</span>}
          {holders && <span className="ml-2 text-xs font-normal text-ink-muted">{t('ticket.taken', { n: tk.taken })}</span>}
        </h3>
        <button type="button" id={`rt-${tk.cid}-up`} className={smallBtn} disabled={index === 0} aria-label={t('ticket.up', { n: index + 1 })} onClick={() => p.onNudge(-1)}>↑</button>
        <button type="button" id={`rt-${tk.cid}-down`} className={smallBtn} disabled={index === p.total - 1} aria-label={t('ticket.down', { n: index + 1 })} onClick={() => p.onNudge(1)}>↓</button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={id('label')} className={lab}>{t('ticket.name')}<span className="text-danger"> *</span></label>
          <input
            id={id('label')} className={inputClass(!!nameErr)} value={tk.labels[defaultLocale] ?? ''} aria-invalid={!!nameErr}
            aria-describedby={nameErr ? `${id('label')}-err` : undefined}
            onChange={(e) => dispatch({ type: 'setTicketText', cid: tk.cid, field: 'labels', locale: defaultLocale, value: e.target.value })}
          />
          <FieldError id={`${id('label')}-err`} error={nameErr} />
        </div>
        <div>
          <label htmlFor={id('desc')} className={lab}>{t('ticket.description')}</label>
          <input
            id={id('desc')} className={inputClass(false)} value={tk.descriptions[defaultLocale] ?? ''}
            onChange={(e) => dispatch({ type: 'setTicketText', cid: tk.cid, field: 'descriptions', locale: defaultLocale, value: e.target.value })}
          />
          <FieldError id={`${id('desc')}-err`} error={err(`descriptions.${defaultLocale}`)} />
        </div>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor={id('price')} className={lab}>{t('ticket.price')}</label>
          <input
            id={id('price')} inputMode="decimal" className={`${inputClass(!!priceErr)} disabled:cursor-not-allowed disabled:opacity-60`} value={p.isD1 ? '' : tk.price} disabled={p.isD1} aria-invalid={!!priceErr}
            aria-describedby={priceErr ? `${id('price')}-err` : p.isD1 ? 'rb-price-d1' : undefined}
            onChange={(e) => dispatch({ type: 'patchTicket', cid: tk.cid, patch: { price: e.target.value } })}
          />
          <FieldError id={`${id('price')}-err`} error={priceErr} />
        </div>
        <div>
          <label htmlFor={id('cap')} className={lab}>{t('ticket.limit')}</label>
          <input
            id={id('cap')} inputMode="numeric" className={inputClass(!!capErr)} value={tk.capacity} aria-invalid={!!capErr} placeholder={t('ticket.noLimit')}
            aria-describedby={capErr ? `${id('cap')}-err` : undefined}
            onChange={(e) => dispatch({ type: 'patchTicket', cid: tk.cid, patch: { capacity: e.target.value } })}
          />
          <FieldError id={`${id('cap')}-err`} error={capErr} />
        </div>
        <label className="flex min-h-11 items-center gap-2 self-end text-sm font-semibold">
          <input type="checkbox" checked={tk.active} onChange={(e) => dispatch({ type: 'patchTicket', cid: tk.cid, patch: { active: e.target.checked } })} />
          {t('ticket.active')}
        </label>
      </div>
      {others.length > 0 && (
        <details className="mt-2 rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink-muted">{t('field.otherLanguages')}</summary>
          <div className="mt-3 space-y-4">
            {others.map((locale) => (
              <div key={locale.code} lang={locale.code} className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={`${id('label')}-${locale.code}`} className={lab}>{t('ticket.name')} ({locale.label})</label>
                  <input
                    id={`${id('label')}-${locale.code}`} className={inputClass(!!err(`labels.${locale.code}`))} value={tk.labels[locale.code] ?? ''}
                    onChange={(e) => dispatch({ type: 'setTicketText', cid: tk.cid, field: 'labels', locale: locale.code, value: e.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor={`${id('desc')}-${locale.code}`} className={lab}>{t('ticket.description')} ({locale.label})</label>
                  <input
                    id={`${id('desc')}-${locale.code}`} className={inputClass(false)} value={tk.descriptions[locale.code] ?? ''}
                    onChange={(e) => dispatch({ type: 'setTicketText', cid: tk.cid, field: 'descriptions', locale: locale.code, value: e.target.value })}
                  />
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="mt-3 border-t border-border pt-3">
        {!confirming ? (
          <button type="button" className={dangerSmallBtn} id={`rt-${tk.cid}-delete`} onClick={() => setConfirming(true)}>{t('ticket.delete')}</button>
        ) : (
          <div role="alertdialog" aria-label={t('ticket.deleteConfirm')} className="space-y-2 rounded-md bg-danger-soft p-3 text-sm">
            <p className="font-semibold text-danger">{t('ticket.deleteConfirm')}</p>
            {tk.id !== null && <p className="text-ink-muted">{t('ticket.deleteHint')}</p>}
            <div className="flex gap-2">
              <button type="button" className={dangerSmallBtn} onClick={p.onDelete}>{t('ticket.deleteYes')}</button>
              <button type="button" className={smallBtn} onClick={() => setConfirming(false)}>{t('cancel')}</button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}
