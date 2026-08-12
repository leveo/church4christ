import { describe, expect, it } from 'vitest';
import { PEOPLE_IMPORT_HEADERS } from '../src/lib/peopleImport';
import {
  PeopleImportMappingConflictError,
  PeopleImportMappingInvalidError,
  PeopleImportMappingPersistenceError,
  PeopleImportMappingStructuralError,
} from '../src/lib/peopleImportMappingDb';
import {
  PEOPLE_IMPORT_MAPPING_MULTIPART_MAX_BYTES,
  mappingAcknowledgesWarnings,
  mappingConfigFromUpload,
  mappingProfileId,
  peopleImportMappingErrorResponse,
  peopleImportMappingInspectDto,
  readPeopleImportMappingMultipart,
} from '../src/lib/peopleImportMappingHttp';

function sourceRequest(
  csv: Blob | string | null = new File([' Name ,EMAIL\nAda,ada@example.com\n'], 'source.csv', {
    type: 'text/csv',
  }),
  fields: Array<[string, string]> = [],
): Request {
  const form = new FormData();
  if (csv !== null) form.append('csv', csv);
  for (const [name, value] of fields) form.append(name, value);
  return new Request('https://church.example/admin/people/import/map/action', {
    method: 'POST',
    body: form,
  });
}

function mappings(): Record<(typeof PEOPLE_IMPORT_HEADERS)[number], number | null> {
  return Object.fromEntries(PEOPLE_IMPORT_HEADERS.map((header) => [
    header,
    header === 'display_name' ? 0 : header === 'email' ? 1 : null,
  ])) as Record<(typeof PEOPLE_IMPORT_HEADERS)[number], number | null>;
}

describe('mapping multipart HTTP contract', () => {
  it('preserves exact multipart, CSV-part, and MIME validation', async () => {
    await expect(readPeopleImportMappingMultipart(new Request(
      'https://church.example/admin/people/import/map/action',
      { method: 'POST', body: 'not multipart' },
    ), [])).resolves.toEqual({ ok: false, status: 415, code: 'multipart_required' });

    const malformed = new Request('https://church.example/admin/people/import/map/action', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=broken' },
      body: 'private malformed envelope',
    });
    await expect(readPeopleImportMappingMultipart(malformed, [])).resolves.toEqual({
      ok: false, status: 400, code: 'multipart_invalid',
    });

    await expect(readPeopleImportMappingMultipart(sourceRequest(
      new File(['name\nprivate\n'], 'source.txt', { type: 'text/plain' }),
    ), [])).resolves.toEqual({ ok: false, status: 415, code: 'file_type_invalid' });

    const duplicateForm = new FormData();
    duplicateForm.append('csv', new File(['name\none\n'], 'one.csv', { type: 'text/csv' }));
    duplicateForm.append('csv', new File(['name\ntwo\n'], 'two.csv', { type: 'text/csv' }));
    await expect(readPeopleImportMappingMultipart(new Request(
      'https://church.example/admin/people/import/map/action',
      { method: 'POST', body: duplicateForm },
    ), [])).resolves.toEqual({ ok: false, status: 400, code: 'multipart_invalid' });
  });

  it('accepts one CSV and exact scalar fields while deriving acknowledgement literally', async () => {
    const request = sourceRequest(undefined, [
      ['profile_id', '7'],
      ['acknowledge_warnings', 'true'],
    ]);
    const result = await readPeopleImportMappingMultipart(request, ['profile_id', 'acknowledge_warnings']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toEqual({ profile_id: '7', acknowledge_warnings: 'true' });
    expect(mappingProfileId(result.fields.profile_id)).toBe(7);
    expect(mappingAcknowledgesWarnings(result.fields.acknowledge_warnings)).toBe(true);
    for (const value of [undefined, 'TRUE', '1', 'on', ' true ']) {
      expect(mappingAcknowledgesWarnings(value), value).toBe(false);
    }
  });

  it('rejects duplicate scalar fields, malformed positive ids, and UTF-8 mapping configs over 48 KiB', async () => {
    const duplicate = await readPeopleImportMappingMultipart(sourceRequest(undefined, [
      ['profile_id', '1'],
      ['profile_id', '2'],
    ]), ['profile_id']);
    expect(duplicate).toEqual({ ok: false, status: 400, code: 'multipart_invalid' });

    for (const value of [undefined, '', '0', '-1', '+1', '1.0', '01', '9007199254740992']) {
      expect(mappingProfileId(value), value).toBeNull();
    }

    const tooLarge = await readPeopleImportMappingMultipart(sourceRequest(undefined, [
      ['mapping_config', '界'.repeat(16_385)],
    ]), ['mapping_config']);
    expect(tooLarge).toEqual({ ok: false, status: 413, code: 'mapping_config_too_large' });
    expect(PEOPLE_IMPORT_MAPPING_MULTIPART_MAX_BYTES).toBeGreaterThan(320 * 1024);
  });

  it('does not trust a small Content-Length and releases an actually oversize stream', async () => {
    let cancelled = false;
    const request = new Request('https://church.example/admin/people/import/map/action', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=bounded',
        'content-length': '1',
      },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(PEOPLE_IMPORT_MAPPING_MULTIPART_MAX_BYTES + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    });

    await expect(readPeopleImportMappingMultipart(request, [])).resolves.toEqual({
      ok: false,
      status: 413,
      code: 'file_too_large',
    });
    expect(cancelled).toBe(true);
    expect(request.body?.locked).toBe(false);
  });

  it('builds a v1 contract only from current normalized headers and accepted config fields', () => {
    const clientConfig = JSON.stringify({
      version: 999,
      expectedHeaders: ['attacker-controlled'],
      fieldMappings: mappings(),
      constants: { record_type: 'person' },
      enumTranslations: {},
    });
    const built = mappingConfigFromUpload(clientConfig, ['name', 'email']);

    expect(built.contract).toEqual({
      version: 1,
      expectedHeaders: ['name', 'email'],
      fieldMappings: mappings(),
      constants: { record_type: 'person' },
      enumTranslations: {},
    });
    expect(built.issues).toEqual([]);
  });

  it('returns only normalized headers, row counts, and bounded structural issues from inspection', () => {
    const privateCell = 'DO-NOT-RETURN-THIS-CELL';
    const dto = peopleImportMappingInspectDto(new TextEncoder().encode(
      ` Name ,EMAIL\n${privateCell},ada@example.com\n`,
    ));

    expect(dto).toEqual({
      ok: true,
      headers: ['name', 'email'],
      headerRowNumber: 1,
      dataRows: 1,
      issues: [],
    });
    expect(JSON.stringify(dto)).not.toContain(privateCell);

    const invalid = peopleImportMappingInspectDto(new TextEncoder().encode('Name, name\nprivate,private\n'));
    expect(invalid.headers).toBeNull();
    expect(invalid.dataRows).toBe(1);
    expect(invalid.issues).toEqual([{
      code: 'duplicate_header',
      row: 1,
      column: 2,
      field: null,
    }]);
    expect(Object.keys(invalid.issues[0]).sort()).toEqual(['code', 'column', 'field', 'row']);
  });

  it('maps typed profile/import failures to stable responses without caught details', async () => {
    const cases: Array<[unknown, number, string]> = [
      [new PeopleImportMappingInvalidError(), 400, 'mapping_profile_invalid'],
      [new PeopleImportMappingConflictError(), 409, 'mapping_profile_conflict'],
      [new PeopleImportMappingStructuralError(), 500, 'mapping_profile_corrupt'],
      [new PeopleImportMappingPersistenceError(), 500, 'mapping_profile_failed'],
      [new Error('private@example.com SQL SELECT detail'), 500, 'generic_error'],
    ];
    for (const [error, status, code] of cases) {
      const response = peopleImportMappingErrorResponse(error);
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ ok: false, code });
      expect(text).not.toContain('private@example.com');
    }
  });
});
