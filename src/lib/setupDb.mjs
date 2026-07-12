// Provider-neutral setup writes over the D1-shaped AppDb seam. This module is
// deliberately runtime-agnostic so the same operations run in a Worker or Node.

const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const EMAIL_DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const MODULE_KEY = /^[a-z][a-z0-9-]*$/;

function normalizedEmail(value) {
  const address = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const at = address.indexOf('@');
  if (at <= 0 || at !== address.lastIndexOf('@') || address.length > 254) {
    throw new Error('first administrator email is invalid');
  }
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const labels = domain.split('.');
  if (
    local.length > 64 ||
    !EMAIL_LOCAL.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    domain.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !EMAIL_DOMAIN_LABEL.test(label))
  ) {
    throw new Error('first administrator email is invalid');
  }
  return address;
}

function validatedKeys(moduleKeys, selectedModules) {
  if (!Array.isArray(moduleKeys) || moduleKeys.length === 0) {
    throw new Error('module keys must be a non-empty list');
  }
  if (!Array.isArray(selectedModules)) {
    throw new Error('selected modules must be a list');
  }

  const supported = new Set();
  for (const key of moduleKeys) {
    if (typeof key !== 'string' || !MODULE_KEY.test(key)) {
      throw new Error(`invalid module key: ${String(key)}`);
    }
    if (supported.has(key)) throw new Error(`duplicate module key: ${key}`);
    supported.add(key);
  }

  const selected = new Set();
  const unknown = [];
  for (const key of selectedModules) {
    if (typeof key !== 'string' || !supported.has(key)) unknown.push(String(key));
    if (selected.has(key)) throw new Error(`duplicate selected module: ${String(key)}`);
    selected.add(key);
  }
  if (unknown.length) throw new Error(`unknown selected module(s): ${unknown.join(', ')}`);
  return selected;
}

function isUniqueViolation(error) {
  if (typeof error === 'object' && error !== null && error.code === '23505') return true;
  const message = String(error);
  return /UNIQUE constraint failed:\s*(?:main\.)?people\.email(?:\s|$|:)/.test(message);
}

/** Explicitly persist every supported module toggle in one atomic SQL statement. */
export async function initializeModuleSettings(db, moduleKeys, selectedModules) {
  const enabled = validatedKeys(moduleKeys, selectedModules);
  const rows = moduleKeys.map((key) => [`module.${key}`, enabled.has(key) ? '1' : '0']);
  const placeholders = rows.map(() => '(?, ?)').join(', ');
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES ${placeholders} ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(...rows.flat()).run();
}

/** Create the first admin, or conservatively classify an existing identity. */
export async function bootstrapFirstAdmin(db, input) {
  const email = normalizedEmail(input?.email);
  const displayName = typeof input?.displayName === 'string' ? input.displayName.trim() : '';
  if (!displayName) throw new Error('first administrator display name is required');
  if (input?.locale !== 'en' && input?.locale !== 'zh') {
    throw new Error('first administrator locale must be en or zh');
  }
  if (input.promoteExisting !== undefined && typeof input.promoteExisting !== 'boolean') {
    throw new Error('promoteExisting must be a boolean');
  }

  const find = () => db.prepare(
    'SELECT id, role, active, deleted_at FROM people WHERE lower(email)=?',
  ).bind(email).first();

  const handleExisting = async (existing) => {
    if (existing.deleted_at) return { status: 'reactivation-required', email };
    if (!existing.active) return { status: 'inactive', email };
    if (existing.role === 'admin') return { status: 'already-admin', email };
    if (!input.promoteExisting) return { status: 'promotion-required', email };

    const result = await db.prepare(
      "UPDATE people SET role='admin', updated_at=datetime('now') WHERE id=? AND lower(email)=? AND active=1 AND deleted_at IS NULL AND role<>'admin'",
    ).bind(existing.id, email).run();
    const current = await find();
    if (!current || current.deleted_at || !current.active || current.role !== 'admin') {
      throw new Error('administrator promotion lost a concurrent update');
    }
    return { status: result.meta.changes > 0 ? 'promoted' : 'already-admin', email };
  };

  const existing = await find();
  if (existing) return handleExisting(existing);

  try {
    await db.prepare(
      "INSERT INTO people (display_name,email,role,active,lang) VALUES (?,?,'admin',1,?)",
    ).bind(displayName, email, input.locale).run();
    return { status: 'created', email };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await find();
    if (raced?.deleted_at) return { status: 'reactivation-required', email };
    if (raced?.active && raced.role === 'admin') return { status: 'already-admin', email };
    if (raced?.active) return { status: 'promotion-required', email };
    return { status: 'inactive', email };
  }
}
