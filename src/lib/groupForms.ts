// FormData parser for the site-admin groups create/edit form. Split out from
// groupDb.ts (pure data access, no request-shape knowledge) and from
// validate.ts (that file's parsers all belong to admin/self-service surfaces
// that predate groups) so it can be unit-tested the same way: FormResult<T>,
// dictionary-key errors, trimmed strings.
import type { FormResult } from './validate';
import type { GroupInput, GroupKind } from './groupDb';

const NAME_MAX = 200;
const DESCRIPTION_MAX = 5000;
const TERM_LABEL_MAX = 100;
const GROUP_KINDS: GroupKind[] = ['fellowship', 'sunday_school'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(fd: FormData, name: string): string {
  return String(fd.get(name) ?? '').trim();
}

/**
 * Parse the group create/edit form. `name` is required (trimmed, ≤200 chars);
 * `description` is optional free text (trimmed, ≤5000 chars); `is_public` is a
 * checkbox (present → public, matching every other admin form's checkbox
 * convention). `kind` is a select constrained to the GroupKind allowlist
 * (unrecognized → 'fellowship', the column default); `term_label` is optional
 * free text (≤100 chars) and `term_start`/`term_end` are optional YYYY-MM-DD
 * dates (rejected when malformed). Empty term fields normalize to null.
 */
export function parseGroupForm(fd: FormData): FormResult<GroupInput> {
  const errors: Record<string, string> = {};

  const name = str(fd, 'name');
  if (!name) errors.name = 'errors.required';
  else if (name.length > NAME_MAX) errors.name = 'errors.tooLong';

  const description = str(fd, 'description');
  if (description.length > DESCRIPTION_MAX) errors.description = 'errors.tooLong';

  const isPublic = fd.get('is_public') !== null;

  const kindRaw = str(fd, 'kind') as GroupKind;
  const kind: GroupKind = GROUP_KINDS.includes(kindRaw) ? kindRaw : 'fellowship';

  const termLabelRaw = str(fd, 'term_label');
  if (termLabelRaw.length > TERM_LABEL_MAX) errors.term_label = 'errors.tooLong';
  const termLabel = termLabelRaw || null;

  const termStartRaw = str(fd, 'term_start');
  if (termStartRaw && !DATE_RE.test(termStartRaw)) errors.term_start = 'errors.dateFormat';
  const termStart = termStartRaw || null;

  const termEndRaw = str(fd, 'term_end');
  if (termEndRaw && !DATE_RE.test(termEndRaw)) errors.term_end = 'errors.dateFormat';
  const termEnd = termEndRaw || null;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { name, description, isPublic, kind, termLabel, termStart, termEnd } };
}
