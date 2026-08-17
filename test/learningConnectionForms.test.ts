import { describe, expect, it } from 'vitest';
import {
  LEARNING_CONNECTION_FORM_MAX_BYTES,
  parseLearningConnectionForm,
  readLearningConnectionForm,
} from '../src/lib/learningConnectionForms';

describe('Learning connection form parser', () => {
  it('parses exact Canvas and Google create contracts without treating Google as Canvas', () => {
    expect(parseLearningConnectionForm({
      action: 'create', provider: 'canvas', display_name: 'Church Canvas',
      base_url: 'https://canvas.church.test', access_token: 'canvas-private-token',
    })).toEqual({ ok: true, data: {
      action: 'create', provider: 'canvas', displayName: 'Church Canvas',
      baseUrl: 'https://canvas.church.test', accessToken: 'canvas-private-token',
    } });
    expect(parseLearningConnectionForm({
      action: 'create', provider: 'google_classroom', display_name: 'Sunday School',
    })).toEqual({ ok: true, data: {
      action: 'create', provider: 'google_classroom', displayName: 'Sunday School', baseUrl: null,
    } });
    expect(parseLearningConnectionForm({
      action: 'create', provider: 'google_classroom', display_name: '主日学 😀',
    })).toMatchObject({ ok: true, data: { displayName: '主日学 😀' } });
    for (const invalid of [
      { action: 'create', provider: 'google_classroom', display_name: 'Google', base_url: 'https://classroom.google.com' },
      { action: 'create', provider: 'google_classroom', display_name: 'Google', access_token: 'private' },
      { action: 'create', provider: 'canvas', display_name: 'Canvas', base_url: 'http://canvas.test', access_token: 'private' },
      { action: 'create', provider: 'canvas', display_name: 'Canvas', base_url: 'https://user@canvas.test', access_token: 'private' },
      { action: 'create', provider: 'canvas', display_name: 'Canvas', base_url: 'https://canvas.test/path', access_token: 'private' },
      { action: 'create', provider: 'canvas', display_name: ' Canvas ', base_url: 'https://canvas.test', access_token: 'private' },
      { action: 'create', provider: 'google_classroom', display_name: `Broken ${String.fromCharCode(0xd800)}` },
    ]) expect(parseLearningConnectionForm(invalid)).toEqual({ ok: false, code: 'learning_connection_invalid' });
  });

  it('parses revisioned update, reconnect, health-check, and disconnect actions exactly', () => {
    expect(parseLearningConnectionForm({
      action: 'update', connection_id: '41', revision: '3', provider: 'canvas',
      display_name: 'Updated Canvas', base_url: 'https://new-canvas.test',
    })).toEqual({ ok: true, data: {
      action: 'update', connectionId: 41, revision: 3, provider: 'canvas',
      displayName: 'Updated Canvas', baseUrl: 'https://new-canvas.test',
    } });
    expect(parseLearningConnectionForm({
      action: 'reconnect', connection_id: '41', revision: '4', provider: 'canvas',
      base_url: 'https://new-canvas.test', access_token: 'new-private-token',
    })).toMatchObject({ ok: true, data: { action: 'reconnect', connectionId: 41, revision: 4 } });
    expect(parseLearningConnectionForm({ action: 'health_check', connection_id: '41', revision: '5' }))
      .toEqual({ ok: true, data: { action: 'health_check', connectionId: 41, revision: 5 } });
    expect(parseLearningConnectionForm({ action: 'disconnect', connection_id: '41', revision: '6' }))
      .toEqual({ ok: true, data: { action: 'disconnect', connectionId: 41, revision: 6 } });
    for (const invalid of [
      { action: 'disconnect', connection_id: '0', revision: '1' },
      { action: 'disconnect', connection_id: '1', revision: '-1' },
      { action: 'disconnect', connection_id: '1', revision: '1', access_token: 'private' },
      { action: 'health_check', connection_id: '1', revision: '1', extra: 'x' },
      { action: 'update', connection_id: '1', revision: '1', provider: 'google_classroom', display_name: 'Google', base_url: '' },
    ]) expect(parseLearningConnectionForm(invalid)).toEqual({ ok: false, code: 'learning_connection_invalid' });
  });
});

describe('Learning bounded URL-encoded request reader', () => {
  it('rejects media type and declared/streamed excess before parsing, cancelling oversized streams', async () => {
    expect(await readLearningConnectionForm(new Request('https://church.test/admin/learning/connections', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'private',
    }))).toEqual({ ok: false, reason: 'unsupported_media_type' });

    let pulled = false;
    const declared = new Request('https://church.test/admin/learning/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(LEARNING_CONNECTION_FORM_MAX_BYTES + 1) },
      body: new ReadableStream({ pull() { pulled = true; throw new Error('must not read'); } }, { highWaterMark: 0 }),
    });
    expect(await readLearningConnectionForm(declared)).toEqual({ ok: false, reason: 'too_large' });
    expect(pulled).toBe(false);

    let cancelled = false;
    const streamed = new Request('https://church.test/admin/learning/connections', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(LEARNING_CONNECTION_FORM_MAX_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel() { cancelled = true; },
      }),
    });
    expect(await readLearningConnectionForm(streamed)).toEqual({ ok: false, reason: 'too_large' });
    expect(cancelled).toBe(true);
    expect(streamed.body?.locked).toBe(false);
  });

  it('rejects duplicate, unknown, malformed percent, and invalid UTF-8 fields', async () => {
    for (const body of [
      'action=disconnect&connection_id=1&connection_id=2&revision=1',
      'action=disconnect&connection_id=1&revision=1&private=secret',
      'action=disconnect&connection_id=%ZZ&revision=1',
      new Uint8Array([0x61, 0x3d, 0xc3, 0x28]),
    ]) {
      const result = await readLearningConnectionForm(new Request('https://church.test/admin/learning/connections', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body,
      }));
      expect(result.ok).toBe(false);
    }
  });
});
