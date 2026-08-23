import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_MERGE_REFERENCE_REGISTRY,
  IDENTITY_MERGE_TEXT_ACTOR_REGISTRY,
  mergeReferenceKey,
} from '../src/lib/identityMergeRegistry';

describe('identity merge reference registry', () => {
  it('exhaustively classifies every live D1 foreign key to people', async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE TABLE %' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ name: string }>();
    const actual = new Set<string>();
    for (const { name } of tables.results) {
      expect(name).toMatch(/^[a-z_][a-z0-9_]*$/i);
      const foreignKeys = await env.DB.prepare(`PRAGMA foreign_key_list(${name})`)
        .all<{ table: string; from: string }>();
      for (const foreignKey of foreignKeys.results) {
        if (foreignKey.table === 'people') actual.add(mergeReferenceKey(name, foreignKey.from));
      }
    }

    const registered = IDENTITY_MERGE_REFERENCE_REGISTRY.filter(({ backend }) => backend !== 'postgres').map(({ table, column }) =>
      mergeReferenceKey(table, column));
    expect(new Set(registered).size).toBe(registered.length);
    expect([...new Set(registered)].sort()).toEqual([...actual].sort());
  });

  it('uses only closed policies with review notes and explicitly tracks text actors', () => {
    const allowed = new Set([
      'subject_repoint',
      'dedupe_then_repoint',
      'operational_actor_repoint',
      'historical_preserve',
      'security_revoke',
      'hard_conflict',
    ]);
    for (const entry of IDENTITY_MERGE_REFERENCE_REGISTRY) {
      expect(allowed.has(entry.policy), `${entry.table}.${entry.column}`).toBe(true);
      expect(entry.notes.trim().length, `${entry.table}.${entry.column}`).toBeGreaterThan(8);
    }
    expect(IDENTITY_MERGE_TEXT_ACTOR_REGISTRY.map(({ table, column, policy }) =>
      `${mergeReferenceKey(table, column)}:${policy}`).sort()).toEqual([
      'bulletins.updated_by:historical_preserve',
      'external_ids.entity_id:hard_conflict',
      'identity_account_operations.reserved_person_id:hard_conflict',
      'identity_source_provisional_operations.reserved_person_id:hard_conflict',
      'media.uploaded_by:historical_preserve',
      'person_notes.author_email:historical_preserve',
      'prayer_activity.author:historical_preserve',
      'prayer_sheets.updated_by:historical_preserve',
      'revisions.edited_by:historical_preserve',
      'roster_assignments.assigned_by:historical_preserve',
      'sermons.updated_by:historical_preserve',
      'team_applications.decided_by:historical_preserve',
      'testimonies.author_name:historical_preserve',
    ]);
  });

  it('seeds exactly the static registry keys accepted by reassignment journals', async () => {
    const rows = await env.DB.prepare('SELECT reference_key,policy FROM person_merge_registry_keys ORDER BY reference_key')
      .all<{ reference_key: string; policy: string }>();
    const expected = [...IDENTITY_MERGE_REFERENCE_REGISTRY, ...IDENTITY_MERGE_TEXT_ACTOR_REGISTRY]
      .map(({ table, column, policy }) => ({ reference_key: mergeReferenceKey(table, column), policy }))
      .sort((left, right) => left.reference_key.localeCompare(right.reference_key));
    expect([...rows.results].sort((left, right) => left.reference_key.localeCompare(right.reference_key))).toEqual(expected);
  });
});
