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

/** The setup checkpoint proves progress, never current identity ownership. */
export async function isBootstrapAdminReady(db, value) {
  const email = normalizedEmail(value);
  const row = await db.prepare(`SELECT p.id FROM people p
    JOIN contact_points c ON c.kind='email' AND c.normalized_value=?1
    JOIN verified_contact_owners o ON o.contact_point_id=c.id AND o.person_id=p.id
    JOIN person_contact_links l ON l.person_id=p.id AND l.contact_point_id=c.id AND l.kind='email' AND l.ended_at IS NULL
    JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=p.home_campus_id AND cm.active=1
    JOIN campuses campus ON campus.id=cm.campus_id AND campus.active=1
    LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
    WHERE lower(p.email)=?1 AND p.role='admin' AND p.super_admin=1 AND p.active=1
      AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
      AND r.loser_person_id IS NULL`).bind(email).first();
  return Number.isSafeInteger(row?.id) && row.id > 0;
}

// This is a trusted installation operation, not a login or member-import path.
// The operator already controls the database and explicitly chooses the first
// administrator. Mint ownership only while creating that new person. A single
// batch prevents a partial identity; an existing/revoked owner cannot be replaced
// because generation 1 and expected NULL are guarded by the identity schema.
async function createSetupAdministrator(db, { email, displayName, locale }) {
  const target = `FROM people p JOIN contact_points c ON c.kind='email' AND c.normalized_value=?1 WHERE p.email=?1`;
  await db.batch([
    db.prepare("INSERT INTO people (display_name,email,role,active,lang,super_admin) VALUES (?,?,'admin',1,?,1)")
      .bind(displayName, email, locale),
    db.prepare(`INSERT INTO contact_points(kind,normalized_value,display_value) VALUES('email',?1,?1)
      ON CONFLICT(kind,normalized_value) DO UPDATE SET display_value=contact_points.display_value`).bind(email),
    db.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,is_primary,notification_enabled)
      SELECT p.id,c.id,'email','setup_bootstrap',1,1 ${target}`).bind(email),
    db.prepare(`INSERT INTO contact_owner_mutation_claims(contact_point_id,generation,expected_person_id,resulting_person_id,operation)
      SELECT c.id,1,NULL,p.id,'assign' ${target}`).bind(email),
    db.prepare(`INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method)
      SELECT c.id,p.id,'admin_review' ${target}`).bind(email),
    db.prepare(`INSERT INTO contact_ownership_events(contact_point_id,person_id,event_type,actor_person_id,reason)
      SELECT c.id,p.id,'verified',p.id,'Trusted CLI administrator bootstrap' ${target}`).bind(email),
    db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,actor_person_id,subject_person_id,contact_point_id,metadata_json)
      SELECT p.home_campus_id,'setup_admin_bootstrapped',p.id,p.id,c.id,'{"reasonCategory":"admin_review"}' ${target}`).bind(email),
  ]);
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
    'SELECT id, role, active, deleted_at, super_admin FROM people WHERE lower(email)=?',
  ).bind(email).first();

  const handleExisting = async (existing) => {
    if (existing.deleted_at) return { status: 'reactivation-required', email };
    if (!existing.active) return { status: 'inactive', email };
    if (existing.role === 'admin' && Number(existing.super_admin) === 1) {
      return { status: 'already-admin', email };
    }
    if (!input.promoteExisting) return { status: 'promotion-required', email };

    const result = await db.prepare(
      "UPDATE people SET role='admin', super_admin=1, updated_at=datetime('now') WHERE id=? AND lower(email)=? AND active=1 AND deleted_at IS NULL AND (role<>'admin' OR super_admin<>1)",
    ).bind(existing.id, email).run();
    const current = await find();
    if (!current || current.deleted_at || !current.active || current.role !== 'admin' || Number(current.super_admin) !== 1) {
      throw new Error('administrator promotion lost a concurrent update');
    }
    return { status: result.meta.changes > 0 ? 'promoted' : 'already-admin', email };
  };

  const existing = await find();
  if (existing) return handleExisting(existing);

  try {
    await createSetupAdministrator(db, { email, displayName, locale: input.locale });
    return { status: 'created', email };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await find();
    if (raced?.deleted_at) return { status: 'reactivation-required', email };
    if (raced?.active && raced.role === 'admin' && Number(raced.super_admin) === 1) {
      return { status: 'already-admin', email };
    }
    if (raced?.active) return { status: 'promotion-required', email };
    return { status: 'inactive', email };
  }
}
