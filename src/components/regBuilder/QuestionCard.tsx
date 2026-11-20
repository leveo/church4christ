// One question card: header (drag handle, number, summary, keyboard reorder, expand), then the editor
// (type, scope, required, texts per language, options, max length, show-if) and delete with confirmation.
import { useState, type Dispatch, type DragEvent } from 'react';
import { lab } from '../../lib/adminUi';
import {
  conditionOps,
  conditionSentence,
  conditionTargets,
  defaultCondition,
  dependentsOf,
  hasMaxLength,
  hasOptions,
  newOption,
  QUESTION_TYPES,
  withOp,
  type DraftCondition,
  type DraftQuestion,
  type FormAction,
  type QuestionType,
} from './model';
import { FieldError, dangerSmallBtn, fieldError, inputClass, smallBtn, type CardIssues, type LocaleOption, type Translate } from './ui';

export interface QuestionCardProps {
  q: DraftQuestion;
  index: number;
  questions: DraftQuestion[];
  locales: LocaleOption[];
  defaultLocale: string;
  open: boolean;
  issues?: CardIssues;
  dragging: boolean;
  dropMark: 'before' | 'after' | null;
  dispatch: Dispatch<FormAction>;
  t: Translate;
  onToggle: () => void;
  onNudge: (direction: -1 | 1) => void;
  onDelete: () => void;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  sentenceText: Record<string, string>;
}

const OPERATOR_KEYS = ['eq', 'neq', 'in', 'checked', 'answered'] as const;

export default function QuestionCard(p: QuestionCardProps) {
  const { q, index, t, dispatch, defaultLocale } = p;
  const [confirming, setConfirming] = useState(false);
  const dependents = dependentsOf(p.questions, q.cid);
  const others = p.locales.filter((l) => l.code !== defaultLocale);
  const err = (field: string) => fieldError(p.issues, field);
  const fid = (field: string) => `rq-${q.cid}-${field.replace(/\./gu, '-')}`;
  const labelErr = err(`labels.${defaultLocale}`);
  const summary = q.labels[defaultLocale]?.trim() || t('untitled');
  const sentence = conditionSentence(p.questions, index, { locale: defaultLocale, text: p.sentenceText });
  const hasProblem = (p.issues?.fields.size ?? 0) > 0;
  const isSection = q.type === 'section';
  const textLabel = q.type === 'section' ? t('field.heading') : q.type === 'terms' ? t('field.termsTitle') : t('field.label');
  const helpLabel = q.type === 'terms' ? t('field.termsText') : q.type === 'section' ? t('field.sectionIntro') : t('field.help');

  const setText = (field: 'labels' | 'help' | 'placeholder', locale: string, value: string) => dispatch({ type: 'setText', cid: q.cid, field, locale, value });

  const textFields = (locale: LocaleOption, primary: boolean) => {
    const labelError = err(`labels.${locale.code}`);
    const suffix = primary ? '' : ` (${locale.label})`;
    const id = (name: string) => `${fid(name)}-${locale.code}`;
    const showPlaceholder = !isSection && q.type !== 'terms' && q.type !== 'yesno' && !hasOptions(q.type);
    return (
      <div className="space-y-3">
        <div>
          <label htmlFor={id('label')} className={lab}>{textLabel}{suffix}{primary && <span className="text-danger"> *</span>}</label>
          <input
            id={id('label')} className={inputClass(!!labelError)} value={q.labels[locale.code] ?? ''} aria-invalid={!!labelError}
            aria-describedby={labelError ? `${id('label')}-err` : undefined}
            onChange={(e) => setText('labels', locale.code, e.target.value)}
          />
          <FieldError id={`${id('label')}-err`} error={labelError} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={showPlaceholder ? '' : 'sm:col-span-2'}>
            <label htmlFor={id('help')} className={lab}>{helpLabel}{suffix}</label>
            <textarea
              id={id('help')} rows={q.type === 'terms' ? 4 : 2} className={inputClass(false)} value={q.help[locale.code] ?? ''}
              onChange={(e) => setText('help', locale.code, e.target.value)}
            />
            <FieldError id={`${id('help')}-err`} error={err(`help.${locale.code}`)} />
          </div>
          {showPlaceholder && (
            <div>
              <label htmlFor={id('ph')} className={lab}>{t('field.placeholder')}{suffix}</label>
              <input id={id('ph')} className={inputClass(false)} value={q.placeholder[locale.code] ?? ''} onChange={(e) => setText('placeholder', locale.code, e.target.value)} />
            </div>
          )}
        </div>
      </div>
    );
  };

  const optionLabel = (o: DraftQuestion['options'][number], n: number) => o.labels[defaultLocale]?.trim() || t('option.unnamed', { n });

  const conditionEditor = () => {
    const targets = conditionTargets(p.questions, index);
    const c = q.condition;
    const target = c ? p.questions.find((x) => x.cid === c.q) : undefined;
    const set = (next: DraftCondition | null) => dispatch({ type: 'setCondition', cid: q.cid, condition: next });
    const qErr = err('condition.q');
    const opErr = err('condition.op');
    const valErr = err('condition.value');
    const targetName = (x: DraftQuestion) => `${p.questions.indexOf(x) + 1}. ${x.labels[defaultLocale]?.trim() || t('untitled')}`;
    return (
      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-semibold text-ink-muted">{t('cond.title')}</legend>
        {!c ? (
          targets.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('cond.noTargets')}</p>
          ) : (
            <button type="button" className={smallBtn} onClick={() => set(defaultCondition(targets[0]))}>{t('cond.add')}</button>
          )
        ) : (
          <div className="space-y-3">
            <div className={`grid gap-3 ${target && (c.op === 'eq' || c.op === 'neq') ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
              <div>
                <label htmlFor={fid('cq')} className={lab}>{t('cond.question')}</label>
                <select
                  id={fid('cq')} className={inputClass(!!qErr)} value={c.q} aria-invalid={!!qErr} aria-describedby={qErr ? `${fid('cq')}-err` : undefined}
                  onChange={(e) => {
                    const next = p.questions.find((x) => x.cid === e.target.value);
                    if (next) set(defaultCondition(next));
                  }}
                >
                  {/* a target that is no longer allowed (moved below, retyped) stays selectable so the error can be seen */}
                  {!targets.some((x) => x.cid === c.q) && target && <option value={c.q}>{targetName(target)}</option>}
                  {targets.map((x) => <option key={x.cid} value={x.cid}>{targetName(x)}</option>)}
                </select>
                <FieldError id={`${fid('cq')}-err`} error={qErr} />
              </div>
              {target && (
                <div>
                  <label htmlFor={fid('cop')} className={lab}>{t('cond.operator')}</label>
                  <select
                    id={fid('cop')} className={inputClass(!!opErr)} value={c.op} aria-invalid={!!opErr}
                    onChange={(e) => set(withOp(c, target, e.target.value as DraftCondition['op']))}
                  >
                    {OPERATOR_KEYS.filter((op) => conditionOps(target.type).includes(op) || op === c.op).map((op) => (
                      <option key={op} value={op}>{t(`op.${op}`)}</option>
                    ))}
                  </select>
                  <FieldError id={`${fid('cop')}-err`} error={opErr} />
                </div>
              )}
              {target && (c.op === 'eq' || c.op === 'neq') && (
                <div>
                  <label htmlFor={fid('cv')} className={lab}>{t('cond.value')}</label>
                  {target.type === 'yesno' || hasOptions(target.type) ? (
                    <select id={fid('cv')} className={inputClass(!!valErr)} value={c.value} aria-invalid={!!valErr} onChange={(e) => set({ ...c, value: e.target.value })}>
                      {target.type === 'yesno' ? (
                        <>
                          <option value="yes">{t('yes')}</option>
                          <option value="no">{t('no')}</option>
                        </>
                      ) : (
                        target.options.map((o, n) => <option key={o.key} value={o.key}>{optionLabel(o, n + 1)}</option>)
                      )}
                      {c.value !== '' && target.type !== 'yesno' && !target.options.some((o) => o.key === c.value) && <option value={c.value}>{c.value}</option>}
                    </select>
                  ) : (
                    <input id={fid('cv')} className={inputClass(!!valErr)} value={c.value} aria-invalid={!!valErr} onChange={(e) => set({ ...c, value: e.target.value })} />
                  )}
                  <FieldError id={`${fid('cv')}-err`} error={valErr} />
                </div>
              )}
            </div>
            {target && c.op === 'in' && (
              <fieldset>
                <legend className={lab}>{t('cond.value')}</legend>
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  {target.options.map((o, n) => (
                    <label key={o.key} className="flex min-h-9 items-center gap-2 text-sm">
                      <input
                        type="checkbox" checked={c.values.includes(o.key)}
                        onChange={(e) => set({ ...c, values: e.target.checked ? [...c.values, o.key] : c.values.filter((v) => v !== o.key) })}
                      />
                      {optionLabel(o, n + 1)}
                    </label>
                  ))}
                </div>
                <FieldError id={`${fid('cv')}-err`} error={valErr} />
              </fieldset>
            )}
            {sentence && <p className="rounded-md bg-primary-soft px-3 py-2 text-sm text-on-primary-soft" data-testid="condition-sentence">{sentence}</p>}
            <button type="button" className={smallBtn} onClick={() => set(null)}>{t('cond.remove')}</button>
          </div>
        )}
      </fieldset>
    );
  };

  const optionsEditor = () => {
    const optionsErr = err('options');
    return (
      <fieldset className="space-y-2">
        <legend className={lab}>{t('field.options')}<span className="text-danger"> *</span></legend>
        {q.options.map((o, n) => {
          const e = err(`options.${n}.labels.${defaultLocale}`);
          const id = `${fid('opt')}-${o.key}`;
          return (
            <div key={o.key} className="flex flex-wrap items-start gap-2">
              <div className="min-w-48 grow">
                <label htmlFor={id} className="sr-only">{t('option.label', { n: n + 1 })}</label>
                <input
                  id={id} className={inputClass(!!e)} value={o.labels[defaultLocale] ?? ''} placeholder={t('option.label', { n: n + 1 })}
                  aria-invalid={!!e} aria-describedby={e ? `${id}-err` : undefined}
                  onChange={(ev) => dispatch({ type: 'setOptionLabel', cid: q.cid, key: o.key, locale: defaultLocale, value: ev.target.value })}
                />
                <FieldError id={`${id}-err`} error={e} />
              </div>
              <button type="button" className={smallBtn} disabled={n === 0} aria-label={t('option.up', { n: n + 1 })} onClick={() => dispatch({ type: 'moveOption', cid: q.cid, key: o.key, direction: -1 })}>↑</button>
              <button type="button" className={smallBtn} disabled={n === q.options.length - 1} aria-label={t('option.down', { n: n + 1 })} onClick={() => dispatch({ type: 'moveOption', cid: q.cid, key: o.key, direction: 1 })}>↓</button>
              <button type="button" className={smallBtn} disabled={q.options.length <= 1} aria-label={t('option.remove', { n: n + 1 })} onClick={() => dispatch({ type: 'removeOption', cid: q.cid, key: o.key })}>×</button>
            </div>
          );
        })}
        <FieldError id={`${fid('opts')}-err`} error={optionsErr} />
        <button
          type="button" className={smallBtn} id={`${fid('addopt')}`}
          onClick={() => dispatch({ type: 'addOption', cid: q.cid, option: newOption(new Set(q.options.map((o) => o.key))) })}
        >
          + {t('option.add')}
        </button>
      </fieldset>
    );
  };

  const scopeErr = err('scope');
  return (
    <li
      className="rb-card rounded-xl border border-border bg-surface-raised shadow-sm"
      data-testid="question-card" data-drop={p.dropMark ?? undefined} data-dragging={p.dragging ? 'true' : undefined}
      onDragOver={p.onDragOver} onDrop={p.onDrop}
    >
      <div className="flex items-center gap-2 p-3">
        <span
          className="rb-handle inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-border bg-surface text-ink-subtle"
          draggable role="img" aria-label={t('card.drag')} title={t('card.drag')} onDragStart={p.onDragStart} onDragEnd={p.onDragEnd}
        >
          ⋮⋮
        </span>
        <span className="text-sm font-semibold tabular-nums text-ink-subtle">{index + 1}.</span>
        <button
          type="button" id={`rq-${q.cid}-toggle`} aria-expanded={p.open} aria-controls={`rq-${q.cid}-body`}
          className="min-w-0 flex-1 break-words rounded-md px-2 py-1 text-left hover:bg-surface-sunken" onClick={p.onToggle}
        >
          <span className={`block font-semibold ${q.labels[defaultLocale]?.trim() ? '' : 'text-ink-subtle'}`}>{summary}</span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-muted">
            <span>{t(`type.${q.type}`)}</span>
            {q.scope === 'attendee' && <span>{t('scope.attendee')}</span>}
            {q.required && <span>{t('field.required')}</span>}
            {q.condition && <span>{t('card.conditional')}</span>}
            {hasProblem && <span className="font-semibold text-danger">{t('card.hasProblems')}</span>}
          </span>
        </button>
        <button type="button" id={`rq-${q.cid}-up`} className={smallBtn} disabled={index === 0} aria-label={t('card.up', { n: index + 1 })} onClick={() => p.onNudge(-1)}>↑</button>
        <button type="button" id={`rq-${q.cid}-down`} className={smallBtn} disabled={index === p.questions.length - 1} aria-label={t('card.down', { n: index + 1 })} onClick={() => p.onNudge(1)}>↓</button>
      </div>

      {p.open && (
        <div id={`rq-${q.cid}-body`} className="space-y-4 border-t border-border p-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor={fid('type')} className={lab}>{t('field.type')}</label>
              <select
                id={fid('type')} className={inputClass(false)} value={q.type}
                onChange={(e) => dispatch({ type: 'patchQuestion', cid: q.cid, patch: { type: e.target.value as QuestionType } })}
              >
                {QUESTION_TYPES.map((type) => <option key={type} value={type}>{t(`type.${type}`)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={fid('scope')} className={lab}>{t('field.scope')}</label>
              <select
                id={fid('scope')} className={inputClass(!!scopeErr)} value={q.scope} aria-invalid={!!scopeErr} aria-describedby={scopeErr ? `${fid('scope')}-err` : undefined}
                onChange={(e) => dispatch({ type: 'patchQuestion', cid: q.cid, patch: { scope: e.target.value === 'attendee' ? 'attendee' : 'registration' } })}
              >
                <option value="registration">{t('scope.registration')}</option>
                <option value="attendee">{t('scope.attendee')}</option>
              </select>
              <FieldError id={`${fid('scope')}-err`} error={scopeErr} />
            </div>
            {!isSection && (
              <label className="flex min-h-11 items-center gap-2 self-end text-sm font-semibold">
                <input type="checkbox" checked={q.required} onChange={(e) => dispatch({ type: 'patchQuestion', cid: q.cid, patch: { required: e.target.checked } })} />
                {t('field.required')}
              </label>
            )}
          </div>

          {textFields(p.locales.find((l) => l.code === defaultLocale) ?? p.locales[0], true)}

          {hasOptions(q.type) && optionsEditor()}

          {hasMaxLength(q.type) && (
            <div className="sm:max-w-xs">
              <label htmlFor={fid('max')} className={lab}>{t('field.maxLength')}</label>
              <input
                id={fid('max')} inputMode="numeric" className={inputClass(!!err('max_length'))} value={q.maxLength} aria-invalid={!!err('max_length')}
                onChange={(e) => dispatch({ type: 'patchQuestion', cid: q.cid, patch: { maxLength: e.target.value } })}
              />
              <FieldError id={`${fid('max')}-err`} error={err('max_length')} />
            </div>
          )}

          {others.length > 0 && (
            <details className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-semibold text-ink-muted">{t('field.otherLanguages')}</summary>
              <div className="mt-3 space-y-5">
                {others.map((locale) => (
                  <div key={locale.code} lang={locale.code} className="space-y-3">
                    {textFields(locale, false)}
                    {hasOptions(q.type) && q.options.length > 0 && (
                      <div className="space-y-2">
                        {q.options.map((o, n) => (
                          <div key={o.key}>
                            <label htmlFor={`${fid('opt')}-${o.key}-${locale.code}`} className="block text-sm text-ink-muted">{t('option.labelIn', { n: n + 1, lang: locale.label })}</label>
                            <input
                              id={`${fid('opt')}-${o.key}-${locale.code}`} className={inputClass(false)} value={o.labels[locale.code] ?? ''}
                              placeholder={o.labels[defaultLocale] ?? ''}
                              onChange={(e) => dispatch({ type: 'setOptionLabel', cid: q.cid, key: o.key, locale: locale.code, value: e.target.value })}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          {conditionEditor()}

          <div className="border-t border-border pt-3">
            {!confirming ? (
              <button type="button" className={dangerSmallBtn} id={`rq-${q.cid}-delete`} onClick={() => setConfirming(true)}>{t('card.delete')}</button>
            ) : dependents.length > 0 ? (
              <div role="alert" className="space-y-2 rounded-md bg-danger-soft p-3 text-sm text-danger">
                <p>{t('card.deleteBlocked', { list: dependents.map((d) => `“${d.labels[defaultLocale]?.trim() || t('untitled')}”`).join(', ') })}</p>
                <button type="button" className={smallBtn} onClick={() => setConfirming(false)}>{t('cancel')}</button>
              </div>
            ) : (
              <div role="alertdialog" aria-label={t('card.deleteConfirm')} className="space-y-2 rounded-md bg-danger-soft p-3 text-sm">
                <p className="font-semibold text-danger">{t('card.deleteConfirm')}</p>
                {q.id !== null && <p className="text-ink-muted">{t('card.deleteAnswers')}</p>}
                <div className="flex gap-2">
                  <button type="button" className={dangerSmallBtn} onClick={p.onDelete}>{t('card.deleteYes')}</button>
                  <button type="button" className={smallBtn} onClick={() => setConfirming(false)}>{t('cancel')}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
