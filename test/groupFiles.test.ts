// Group files data layer (Member Portal fusion, Task 4). The download ROUTE
// (src/pages/[locale]/groups/[id]/files/[fileId].ts) needs the full request
// pipeline and is exercised in the pg e2e suite (Task 6); here we unit-test the
// lib exhaustively: the ext+MIME allowlist, size/empty caps, the random (NOT
// content-addressed) key shape, the download ACL matrix, soft-delete +
// best-effort R2 delete, list ordering/exclusion, and the RFC 5987
// content-disposition builder.
//
// group_files is Supabase-only (migrations-supabase/0009) with no D1 counterpart,
// so — exactly as test/groupDb.test.ts documents the pattern — we CREATE TABLE IF
// NOT EXISTS it here referencing this repo's D1 `groups` table. group_members IS a
// D1 table (migrations/0006_groups.sql), so membership uses the real groupDb fns.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import { addMemberByPerson, createGroup, type GroupInput } from '../src/lib/groupDb';
import {
  ALLOWED_GROUP_FILE_EXTS,
  MAX_GROUP_FILE_BYTES,
  contentDispositionAttachment,
  deleteGroupFile,
  getGroupFileForDownload,
  listGroupFiles,
  saveGroupFile,
  type GroupFileBucket,
} from '../src/lib/groupFiles';

await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS group_files (
     id INTEGER PRIMARY KEY,
     group_id INTEGER NOT NULL REFERENCES groups(id),
     uploaded_by INTEGER NOT NULL REFERENCES people(id),
     file_name TEXT NOT NULL,
     r2_key TEXT NOT NULL UNIQUE,
     content_type TEXT NOT NULL,
     size_bytes INTEGER NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     deleted_at TEXT
   )`,
).run();

const testEnv = env as unknown as {
  DB: AppDb;
  MEDIA: GroupFileBucket & { get(key: string): Promise<{ httpMetadata?: { contentType?: string }; arrayBuffer(): Promise<ArrayBuffer> } | null> };
};
const db = testEnv.DB;
const media = testEnv.MEDIA;

const baseInput: GroupInput = {
  name: 'Grace Fellowship',
  description: 'Grow together',
  isPublic: true,
  kind: 'fellowship',
  termLabel: null,
  termStart: null,
  termEnd: null,
};

let groupId: number;

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM group_files'),
    env.DB.prepare('DELETE FROM group_members'),
    env.DB.prepare('DELETE FROM groups'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  await env.DB.batch(
    [1, 2, 3, 4].map((id) =>
      env.DB.prepare('INSERT INTO people (id, display_name, email) VALUES (?, ?, ?)').bind(id, `Person ${id}`, `p${id}@example.com`),
    ),
  );
  groupId = await createGroup(env.DB, baseInput);
}
beforeEach(reset);

function file(name: string, type: string, size = 4): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('constants', () => {
  it('exposes the extension allowlist and the 20MB cap', () => {
    expect(ALLOWED_GROUP_FILE_EXTS).toEqual(
      expect.arrayContaining(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'md']),
    );
    expect(ALLOWED_GROUP_FILE_EXTS).not.toContain('exe');
    expect(ALLOWED_GROUP_FILE_EXTS).not.toContain('svg');
    expect(ALLOWED_GROUP_FILE_EXTS).not.toContain('html');
    expect(MAX_GROUP_FILE_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe('saveGroupFile — allowlist', () => {
  it('accepts a well-formed pdf (ext + MIME agree)', async () => {
    const id = await saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('report.pdf', 'application/pdf') });
    expect(typeof id).toBe('number');
  });

  it('accepts png/jpg/jpeg/webp/txt/md/docx/xlsx/pptx with matching MIME', async () => {
    const ok: [string, string][] = [
      ['a.png', 'image/png'],
      ['a.jpg', 'image/jpeg'],
      ['a.jpeg', 'image/jpeg'],
      ['a.webp', 'image/webp'],
      ['a.txt', 'text/plain'],
      ['a.md', 'text/markdown'],
      ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['a.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ];
    for (const [name, type] of ok) {
      await expect(saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file(name, type) })).resolves.toBeTypeOf('number');
    }
  });

  it('rejects a disallowed extension (.exe) regardless of MIME', async () => {
    await expect(saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('virus.exe', 'application/pdf') })).rejects.toThrow('file_type');
  });

  it('rejects a scriptable .svg', async () => {
    await expect(saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('x.svg', 'image/svg+xml') })).rejects.toThrow('file_type');
  });

  it('rejects an ext/MIME mismatch (.pdf claiming text/html)', async () => {
    await expect(saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('x.pdf', 'text/html') })).rejects.toThrow('file_type');
  });

  it('rejects application/octet-stream even with an allowed extension (strict)', async () => {
    await expect(saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('x.pdf', 'application/octet-stream') })).rejects.toThrow('file_type');
  });

  it('rejects an empty MIME with an allowed extension (strict)', async () => {
    await expect(saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('x.pdf', '') })).rejects.toThrow('file_type');
  });

  it('rejects a file with no extension', async () => {
    await expect(saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('noext', 'application/pdf') })).rejects.toThrow('file_type');
  });

  it('rejects a double-extension whose FINAL segment is disallowed (invoice.pdf.exe)', async () => {
    await expect(saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('invoice.pdf.exe', 'application/pdf') })).rejects.toThrow('file_type');
  });
});

describe('saveGroupFile — size', () => {
  it('rejects a file over the cap with file_too_large', async () => {
    const big = new File([new Uint8Array(MAX_GROUP_FILE_BYTES + 1)], 'big.pdf', { type: 'application/pdf' });
    await expect(saveGroupFile(db, media, { groupId, uploadedBy: 1, file: big })).rejects.toThrow('file_too_large');
  });

  it('accepts a file exactly at the cap', async () => {
    const atCap = new File([new Uint8Array(MAX_GROUP_FILE_BYTES)], 'atcap.pdf', { type: 'application/pdf' });
    await expect(saveGroupFile(db, media, { groupId, uploadedBy: 1, file: atCap })).resolves.toBeTypeOf('number');
  });

  it('rejects a 0-byte file with file_empty', async () => {
    await expect(saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('empty.pdf', 'application/pdf', 0) })).rejects.toThrow('file_empty');
  });
});

describe('saveGroupFile — persistence + key shape', () => {
  it('stores the row, puts the bytes in R2, and uses a random group-scoped key', async () => {
    const id = await saveGroupFile(db, media, { groupId, uploadedBy: 2, file: file('Plan 2026.pdf', 'application/pdf', 8) });
    const row = await db
      .prepare('SELECT group_id, uploaded_by, file_name, r2_key, content_type, size_bytes FROM group_files WHERE id = ?')
      .bind(id)
      .first<{ group_id: number; uploaded_by: number; file_name: string; r2_key: string; content_type: string; size_bytes: number }>();
    expect(row).toEqual({
      group_id: groupId,
      uploaded_by: 2,
      file_name: 'Plan 2026.pdf',
      r2_key: row!.r2_key,
      content_type: 'application/pdf',
      size_bytes: 8,
    });
    expect(row!.r2_key).toMatch(new RegExp(`^group-files/${groupId}/[0-9a-f]{32}$`));
    const object = await media.get(row!.r2_key);
    expect(object).not.toBeNull();
    expect(object!.httpMetadata?.contentType).toBe('application/pdf');
  });

  it('preserves a unicode original filename verbatim', async () => {
    const id = await saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('夏令營手冊.pdf', 'application/pdf') });
    const row = await db.prepare('SELECT file_name FROM group_files WHERE id = ?').bind(id).first<{ file_name: string }>();
    expect(row!.file_name).toBe('夏令營手冊.pdf');
  });

  it('is NOT content-addressed: identical bytes+name yield DIFFERENT keys', async () => {
    const id1 = await saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('dup.pdf', 'application/pdf', 8) });
    const id2 = await saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('dup.pdf', 'application/pdf', 8) });
    const k1 = (await db.prepare('SELECT r2_key FROM group_files WHERE id = ?').bind(id1).first<{ r2_key: string }>())!.r2_key;
    const k2 = (await db.prepare('SELECT r2_key FROM group_files WHERE id = ?').bind(id2).first<{ r2_key: string }>())!.r2_key;
    expect(k1).not.toBe(k2);
  });
});

describe('getGroupFileForDownload — ACL matrix', () => {
  let fileId: number;
  beforeEach(async () => {
    fileId = await saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('doc.pdf', 'application/pdf') });
    await addMemberByPerson(db, groupId, 1); // person 1 is a member
  });

  it('member: returns the row', async () => {
    const row = await getGroupFileForDownload(db, { fileId, groupId, personId: 1, isAdmin: false });
    expect(row?.id).toBe(fileId);
    expect(row?.r2_key).toMatch(/^group-files\//);
  });

  it('non-member: returns null', async () => {
    expect(await getGroupFileForDownload(db, { fileId, groupId, personId: 3, isAdmin: false })).toBeNull();
  });

  it('admin (non-member): returns the row', async () => {
    expect((await getGroupFileForDownload(db, { fileId, groupId, personId: 3, isAdmin: true }))?.id).toBe(fileId);
  });

  it('mismatched groupId in the URL: returns null even for a member', async () => {
    const otherGroup = await createGroup(db, { ...baseInput, name: 'Other' });
    expect(await getGroupFileForDownload(db, { fileId, groupId: otherGroup, personId: 1, isAdmin: false })).toBeNull();
    expect(await getGroupFileForDownload(db, { fileId, groupId: otherGroup, personId: 1, isAdmin: true })).toBeNull();
  });

  it('soft-deleted file: returns null for member and admin alike', async () => {
    await deleteGroupFile(db, media, fileId, groupId);
    expect(await getGroupFileForDownload(db, { fileId, groupId, personId: 1, isAdmin: false })).toBeNull();
    expect(await getGroupFileForDownload(db, { fileId, groupId, personId: 1, isAdmin: true })).toBeNull();
  });
});

describe('deleteGroupFile', () => {
  it('soft-deletes the row and deletes the R2 object; returns true', async () => {
    const fileId = await saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('doc.pdf', 'application/pdf') });
    const key = (await db.prepare('SELECT r2_key FROM group_files WHERE id = ?').bind(fileId).first<{ r2_key: string }>())!.r2_key;

    expect(await deleteGroupFile(db, media, fileId, groupId)).toBe(true);
    const row = await db.prepare('SELECT deleted_at FROM group_files WHERE id = ?').bind(fileId).first<{ deleted_at: string | null }>();
    expect(row!.deleted_at).not.toBeNull();
    expect(await media.get(key)).toBeNull();
  });

  it('returns false for an unknown id or a wrong group id (no cross-group delete)', async () => {
    const fileId = await saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('doc.pdf', 'application/pdf') });
    expect(await deleteGroupFile(db, media, 999999, groupId)).toBe(false);
    const otherGroup = await createGroup(db, { ...baseInput, name: 'Other' });
    expect(await deleteGroupFile(db, media, fileId, otherGroup)).toBe(false);
    const row = await db.prepare('SELECT deleted_at FROM group_files WHERE id = ?').bind(fileId).first<{ deleted_at: string | null }>();
    expect(row!.deleted_at).toBeNull();
  });

  it('returns false on a double-delete (already soft-deleted)', async () => {
    const fileId = await saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('doc.pdf', 'application/pdf') });
    expect(await deleteGroupFile(db, media, fileId, groupId)).toBe(true);
    expect(await deleteGroupFile(db, media, fileId, groupId)).toBe(false);
  });

  it('does not throw when the R2 delete fails (best-effort)', async () => {
    const fileId = await saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('doc.pdf', 'application/pdf') });
    const throwingMedia: GroupFileBucket = {
      put: media.put.bind(media),
      delete: async () => {
        throw new Error('R2 down');
      },
    };
    expect(await deleteGroupFile(db, throwingMedia, fileId, groupId)).toBe(true);
    const row = await db.prepare('SELECT deleted_at FROM group_files WHERE id = ?').bind(fileId).first<{ deleted_at: string | null }>();
    expect(row!.deleted_at).not.toBeNull();
  });
});

describe('listGroupFiles', () => {
  it('excludes soft-deleted files, orders newest-first, and joins the uploader name', async () => {
    const a = await saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('a.pdf', 'application/pdf') });
    const b = await saveGroupFile(db, media, { groupId, uploadedBy: 2, file: file('b.pdf', 'application/pdf') });
    const c = await saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('c.pdf', 'application/pdf') });
    await deleteGroupFile(db, media, b, groupId);

    const rows = await listGroupFiles(db, groupId);
    expect(rows.map((r) => r.id)).toEqual([c, a]);
    expect(rows[0]).toMatchObject({ id: c, file_name: 'c.pdf', uploader_name: 'Person 1' });
  });

  it('scopes to the group', async () => {
    await saveGroupFile(db, media, { groupId, uploadedBy: 1, file: file('a.pdf', 'application/pdf') });
    const otherGroup = await createGroup(db, { ...baseInput, name: 'Other' });
    expect(await listGroupFiles(db, otherGroup)).toEqual([]);
  });
});

describe('contentDispositionAttachment', () => {
  it('emits attachment with an ASCII fallback and an RFC 5987 filename*', () => {
    expect(contentDispositionAttachment('report.pdf')).toBe("attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf");
  });

  it('percent-encodes a unicode name and strips non-ASCII from the fallback', () => {
    const out = contentDispositionAttachment('夏令營.pdf');
    expect(out).toContain("filename*=UTF-8''%E5%A4%8F%E4%BB%A4%E7%87%9F.pdf");
    expect(out).toContain('filename=".pdf"');
  });

  it('never lets quotes/backslashes/newlines break out of the header (injection-safe)', () => {
    const out = contentDispositionAttachment('a"b\\c\n.pdf');
    expect(out).toBe("attachment; filename=\"abc.pdf\"; filename*=UTF-8''a%22b%5Cc%0A.pdf");
    expect(out.startsWith('attachment;')).toBe(true);
  });

  it('always says attachment, never inline', () => {
    expect(contentDispositionAttachment('anything.pdf').startsWith('attachment')).toBe(true);
  });
});
