// Registration form builder island root: owns the reducer state, drag-to-reorder, save to its own route
// (same-page JSON POST; the CSRF middleware validates Origin on every non-GET), focus management and the
// aria-live status. Admin only: public pages never ship React. Everything stateful lives in model.ts.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type DragEvent } from 'react';
import { btn, btnSecondary } from '../../lib/adminUi';
import QuestionCard from './QuestionCard';
import TicketCard from './TicketCard';
import {
  QUESTION_TYPES,
  buildPayload,
  conditionIssues,
  dependentsOf,
  errorKey,
  formReducer,
  initialState,
  issuesByCard,
  newQuestion,
  newTicket,
  toDrafts,
  validateDraft,
  type FormIssue,
  type QuestionType,
  type StoredQuestion,
  type StoredTicket,
} from './model';
import { smallBtn, type CardIssues, type LocaleOption, type Translate } from './ui';
import './reg-builder.css';

export interface RegFormBuilderProps {
  questions: StoredQuestion[];
  tickets: StoredTicket[];
  /** Enabled languages, default first. */
  locales: LocaleOption[];
  defaultLocale: string;
  isD1: boolean;
  /** Pre-translated copy keyed without the `admin.regBuilder.` prefix. */
  strings: Record<string, string>;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export default function RegFormBuilder(props: RegFormBuilderProps) {
  const localeCodes = useMemo(() => props.locales.map((l) => l.code), [props.locales]);
  const [state, dispatch] = useReducer(formReducer, undefined, () => initialState(toDrafts(props.questions, props.tickets, localeCodes)));
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [attempted, setAttempted] = useState(false);
  const [serverIssues, setServerIssues] = useState<FormIssue[]>([]);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [announce, setAnnounce] = useState('');
  const [focusId, setFocusId] = useState<{ id: string } | null>(null);
  const [dragCid, setDragCid] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ index: number; mark: 'before' | 'after' } | null>(null);

  const t: Translate = useCallback(
    (key, params) => {
      let text = props.strings[key] ?? key;
      if (params) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
      return text;
    },
    [props.strings],
  );

  const saved = useRef(JSON.stringify({ q: state.questions, t: state.tickets }));
  const dirty = JSON.stringify({ q: state.questions, t: state.tickets }) !== saved.current;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(focusId.id)?.focus();
  }, [focusId]);

  // Issues shown on the cards: the show-if problems live, everything else after the first save attempt, plus the server's.
  const issues = useMemo<FormIssue[]>(
    () => [...(attempted ? validateDraft(state, props.defaultLocale, { d1: props.isD1 }) : conditionIssues(state.questions)), ...serverIssues],
    [state, attempted, serverIssues, props.defaultLocale, props.isD1],
  );
  const grouped = useMemo(() => issuesByCard(issues), [issues]);
  const message = useCallback((field: string, code: string) => {
    const key = `err.${errorKey(field.split('.').pop() ?? field, code)}`;
    return props.strings[key] ?? props.strings['err.invalid'] ?? code;
  }, [props.strings]);
  const cardIssues = (map: Map<string, string> | undefined): CardIssues | undefined => (map ? { fields: map, message } : undefined);

  const sentenceText = useMemo(
    () => ({
      eq: t('sentence.eq'), neq: t('sentence.neq'), in: t('sentence.in'), checked: t('sentence.checked'), answered: t('sentence.answered'),
      yes: t('yes'), no: t('no'), untitled: t('untitled'),
    }),
    [t],
  );

  const toggle = (cid: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(cid)) next.add(cid);
    return next;
  });

  const addQuestion = (type: QuestionType) => {
    const question = newQuestion(type, localeCodes);
    dispatch({ type: 'addQuestion', question });
    setOpen((prev) => new Set(prev).add(question.cid));
    setAnnounce(t('announce.added', { n: state.questions.length + 1 }));
    setFocusId({ id: `rq-${question.cid}-label-${props.defaultLocale}` });
  };

  const nudgeQuestion = (cid: string, direction: -1 | 1) => {
    const from = state.questions.findIndex((q) => q.cid === cid);
    const to = from + direction;
    if (to < 0 || to >= state.questions.length) return;
    dispatch({ type: 'nudgeQuestion', cid, direction });
    setAnnounce(t('announce.moved', { n: to + 1, total: state.questions.length }));
    setFocusId({ id: `rq-${cid}-${direction === -1 ? (to === 0 ? 'down' : 'up') : to === state.questions.length - 1 ? 'up' : 'down'}` });
  };

  const deleteQuestion = (cid: string) => {
    const index = state.questions.findIndex((q) => q.cid === cid);
    if (dependentsOf(state.questions, cid).length > 0) return;
    dispatch({ type: 'removeQuestion', cid });
    setAnnounce(t('announce.deleted'));
    const neighbour = state.questions[index + 1] ?? state.questions[index - 1];
    setFocusId({ id: neighbour ? `rq-${neighbour.cid}-toggle` : 'rb-add-heading' });
  };

  const nudgeTicket = (cid: string, direction: -1 | 1) => {
    const from = state.tickets.findIndex((x) => x.cid === cid);
    const to = from + direction;
    if (to < 0 || to >= state.tickets.length) return;
    dispatch({ type: 'nudgeTicket', cid, direction });
    setAnnounce(t('announce.movedTicket', { n: to + 1, total: state.tickets.length }));
    setFocusId({ id: `rt-${cid}-${direction === -1 ? (to === 0 ? 'down' : 'up') : to === state.tickets.length - 1 ? 'up' : 'down'}` });
  };

  const addTicket = () => {
    const ticket = newTicket(localeCodes);
    dispatch({ type: 'addTicket', ticket });
    setAnnounce(t('announce.addedTicket', { n: state.tickets.length + 1 }));
    setFocusId({ id: `rt-${ticket.cid}-label` });
  };

  const deleteTicket = (cid: string) => {
    const index = state.tickets.findIndex((x) => x.cid === cid);
    dispatch({ type: 'removeTicket', cid });
    setAnnounce(t('announce.deletedTicket'));
    const neighbour = state.tickets[index + 1] ?? state.tickets[index - 1];
    setFocusId({ id: neighbour ? `rt-${neighbour.cid}-label` : 'rb-add-ticket' });
  };

  // Native drag and drop on the handle; the drop line shows where the card lands.
  const onDragOverCard = (index: number) => (e: DragEvent<HTMLElement>) => {
    if (dragCid === null) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setDrop({ index, mark: e.clientY < rect.top + rect.height / 2 ? 'before' : 'after' });
  };
  const onDropCard = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (dragCid !== null && drop) {
      const from = state.questions.findIndex((q) => q.cid === dragCid);
      let to = drop.mark === 'before' ? drop.index : drop.index + 1;
      if (to > from) to -= 1;
      if (from >= 0 && to !== from) {
        dispatch({ type: 'moveQuestion', cid: dragCid, to });
        setAnnounce(t('announce.moved', { n: to + 1, total: state.questions.length }));
      }
    }
    setDragCid(null);
    setDrop(null);
  };

  const save = async () => {
    setAttempted(true);
    setServerIssues([]);
    const local = validateDraft(state, props.defaultLocale, { d1: props.isD1 });
    if (local.length > 0) {
      setStatus('failed');
      setAnnounce(t('fixErrors'));
      // open the cards that have problems and move to the first one
      const grouped = issuesByCard(local);
      setOpen((prev) => {
        const next = new Set(prev);
        for (const index of grouped.questions.keys()) next.add(state.questions[index].cid);
        return next;
      });
      const firstQ = [...grouped.questions.keys()].sort((a, b) => a - b)[0];
      if (firstQ !== undefined) setFocusId({ id: `rq-${state.questions[firstQ].cid}-toggle` });
      else if (grouped.tickets.size > 0) setFocusId({ id: `rt-${state.tickets[[...grouped.tickets.keys()][0]].cid}-label` });
      return;
    }
    setStatus('saving');
    try {
      const res = await fetch(window.location.pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPayload(state, localeCodes)),
      });
      const body = (await res.json()) as { ok: boolean; errors?: FormIssue[]; questions?: StoredQuestion[]; tickets?: StoredTicket[] };
      if (!body.ok) {
        setServerIssues(body.errors ?? []);
        setStatus('failed');
        setAnnounce(t(body.errors ? 'fixErrors' : 'err.saveFailed'));
        if (body.errors) {
          const g = issuesByCard(body.errors);
          setOpen((prev) => {
            const next = new Set(prev);
            for (const index of g.questions.keys()) if (state.questions[index]) next.add(state.questions[index].cid);
            return next;
          });
        }
        return;
      }
      const draft = toDrafts(body.questions ?? [], body.tickets ?? [], localeCodes);
      dispatch({ type: 'saved', draft });
      // the adopted state keeps client ids by position, so the baseline is computed from the same merge
      const adopted = formReducer(state, { type: 'saved', draft });
      saved.current = JSON.stringify({ q: adopted.questions, t: adopted.tickets });
      setAttempted(false);
      setStatus('saved');
      setAnnounce(t('saved'));
    } catch {
      setStatus('failed');
      setServerIssues([]);
      setAnnounce(t('err.saveFailed'));
    }
  };

  const activeTickets = state.tickets.some((x) => x.active);
  const statusText =
    status === 'saving' ? t('saving')
    : status === 'failed' ? (serverIssues.length > 0 || attempted ? t('fixErrors') : t('err.saveFailed'))
    : dirty ? t('unsaved')
    : status === 'saved' ? t('saved')
    : '';

  return (
    <div className="reg-builder space-y-6" data-testid="reg-form-builder">
      <div className="rb-bar flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-raised p-3 shadow-sm">
        <button type="button" className={btnSecondary} disabled={state.past.length === 0} onClick={() => dispatch({ type: 'undo' })} aria-label={t('undo')} title={t('undo')}>↩</button>
        <button type="button" className={btnSecondary} disabled={state.future.length === 0} onClick={() => dispatch({ type: 'redo' })} aria-label={t('redo')} title={t('redo')}>↪</button>
        <span className="grow" />
        <span className={`text-sm ${status === 'failed' ? 'font-semibold text-danger' : dirty ? 'text-warn' : 'text-success'}`} data-testid="save-status">{statusText}</span>
        <button type="button" className={btn} disabled={status === 'saving'} onClick={save} data-testid="save-form">{status === 'saving' ? t('saving') : t('save')}</button>
      </div>
      <div role="status" aria-live="polite" className="sr-only" data-testid="live-region">{announce}</div>

      <section aria-labelledby="rb-questions-heading" className="space-y-3">
        <h3 id="rb-questions-heading" className="font-display text-heading-sm font-bold">{t('questions')}</h3>
        {grouped.form.filter((i) => i.path === 'questions').map((i) => <p key={i.code} role="alert" className="text-sm text-danger">{message('questions', i.code)}</p>)}
        {state.questions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-ink-muted">{t('emptyQuestions')}</p>
        ) : (
          <ol className="space-y-3">
            {state.questions.map((q, index) => (
              <QuestionCard
                key={q.cid} q={q} index={index} questions={state.questions} locales={props.locales} defaultLocale={props.defaultLocale}
                open={open.has(q.cid)} issues={cardIssues(grouped.questions.get(index))} dispatch={dispatch} t={t}
                dragging={dragCid === q.cid} dropMark={drop && drop.index === index && dragCid !== null ? drop.mark : null}
                sentenceText={sentenceText}
                onToggle={() => toggle(q.cid)} onNudge={(d) => nudgeQuestion(q.cid, d)} onDelete={() => deleteQuestion(q.cid)}
                onDragStart={(e) => {
                  setDragCid(q.cid);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', q.cid);
                  const card = e.currentTarget.closest('li');
                  if (card) e.dataTransfer.setDragImage(card, 16, 16);
                }}
                onDragOver={onDragOverCard(index)} onDrop={onDropCard} onDragEnd={() => { setDragCid(null); setDrop(null); }}
              />
            ))}
          </ol>
        )}
        <div className="rounded-xl border border-border bg-surface-raised p-4">
          <h4 id="rb-add-heading" tabIndex={-1} className="mb-3 text-sm font-semibold text-ink-muted">{t('addQuestion')}</h4>
          <div className="rb-types" role="group" aria-labelledby="rb-add-heading">
            {QUESTION_TYPES.map((type) => (
              <button key={type} type="button" className={`${smallBtn} justify-start px-3 text-left`} onClick={() => addQuestion(type)} data-add-type={type}>
                + {t(`type.${type}`)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="rb-tickets-heading" className="space-y-3">
        <div>
          <h3 id="rb-tickets-heading" className="font-display text-heading-sm font-bold">{t('tickets')}</h3>
          <p className="mt-1 text-sm text-ink-muted">{t('tickets.intro')}</p>
        </div>
        {props.isD1 && <p id="rb-price-d1" className="text-sm text-ink-muted">{t('ticket.priceD1')}</p>}
        {activeTickets && <p className="rounded-md bg-primary-soft px-3 py-2 text-sm text-on-primary-soft" data-testid="price-ignored">{t('tickets.priceIgnored')}</p>}
        {grouped.form.filter((i) => i.path === 'tickets').map((i) => <p key={i.code} role="alert" className="text-sm text-danger">{message('tickets', i.code)}</p>)}
        {state.tickets.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-ink-muted">{t('tickets.empty')}</p>
        ) : (
          <ol className="space-y-3">
            {state.tickets.map((tk, index) => (
              <TicketCard
                key={tk.cid} ticket={tk} index={index} total={state.tickets.length} locales={props.locales} defaultLocale={props.defaultLocale}
                isD1={props.isD1} issues={cardIssues(grouped.tickets.get(index))} dispatch={dispatch} t={t}
                onNudge={(d) => nudgeTicket(tk.cid, d)} onDelete={() => deleteTicket(tk.cid)}
              />
            ))}
          </ol>
        )}
        <button type="button" id="rb-add-ticket" className={smallBtn} onClick={addTicket}>+ {t('tickets.add')}</button>
      </section>
    </div>
  );
}
