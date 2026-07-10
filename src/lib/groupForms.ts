// FormData parser for the site-admin groups create/edit form. Split out from
// groupDb.ts (pure data access, no request-shape knowledge) and from
// validate.ts (that file's parsers all belong to admin/self-service surfaces
// that predate groups) so it can be unit-tested the same way: FormResult<T>,
// dictionary-key errors, trimmed strings.
import type { FormResult } from './validate';
import type { GroupInput } from './groupDb';

const NAME_MAX = 200;
const DESCRIPTION_MAX = 5000;

function str(fd: FormData, name: string): string {
  return String(fd.get(name) ?? '').trim();
}

/**
 * Parse the group create/edit form. `name` is required (trimmed, ≤200 chars);
 * `description` is optional free text (trimmed, ≤5000 chars); `is_public` is a
 * checkbox (present → public, matching every other admin form's checkbox convention).
 */
export function parseGroupForm(fd: FormData): FormResult<GroupInput> {
  const errors: Record<string, string> = {};

  const name = str(fd, 'name');
  if (!name) errors.name = 'errors.required';
  else if (name.length > NAME_MAX) errors.name = 'errors.tooLong';

  const description = str(fd, 'description');
  if (description.length > DESCRIPTION_MAX) errors.description = 'errors.tooLong';

  const isPublic = fd.get('is_public') !== null;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { name, description, isPublic } };
}
