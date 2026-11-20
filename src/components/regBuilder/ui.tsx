// Small shared pieces for the registration form builder island.
import type { ReactNode } from 'react';

export interface LocaleOption {
  code: string;
  label: string;
}

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface CardIssues {
  /** field path inside the card -> error code */
  fields: Map<string, string>;
  message: (field: string, code: string) => string;
}

export function fieldError(issues: CardIssues | undefined, field: string): { code: string; text: string } | null {
  const code = issues?.fields.get(field);
  return code && issues ? { code, text: issues.message(field, code) } : null;
}

export function FieldError({ id, error }: { id: string; error: { text: string } | null }): ReactNode {
  if (!error) return null;
  return (
    <p id={id} className="mt-1 text-sm text-danger">
      {error.text}
    </p>
  );
}

/** Class for an input that may carry an error. */
export const inputClass = (invalid: boolean): string =>
  `w-full min-h-11 rounded-md border bg-surface px-3 py-2 text-base sm:min-h-0 sm:text-sm focus:border-primary focus:outline-none ${invalid ? 'border-danger' : 'border-border'}`;

export const smallBtn =
  'inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-border bg-surface px-2 text-sm font-semibold text-ink-muted hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40';
export const dangerSmallBtn =
  'inline-flex min-h-9 items-center justify-center rounded-md border border-danger px-3 text-sm font-semibold text-danger hover:bg-danger-soft';
