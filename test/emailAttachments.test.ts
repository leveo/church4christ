// buildMime: the plain message is unchanged, and attachments wrap it in multipart/mixed
// with base64 at 76 columns and header-safe filenames and media types.
import { describe, expect, it } from 'vitest';
import { buildMime, type SendEmailInput } from '../src/lib/email';

const base: SendEmailInput = { to: 'a@example.com', kind: 'x', subject: 'Hello', html: '<p>Hi</p>', text: 'Hi' };
const lines = (mime: string) => mime.split('\r\n');
const decode = (b64: string) => Uint8Array.from(atob(b64.replace(/\r\n/g, '')), (c) => c.charCodeAt(0));

describe('buildMime without attachments', () => {
  it('is a single multipart/alternative message', () => {
    const mime = buildMime('from@example.com', base);
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="b_');
    expect(mime).not.toContain('multipart/mixed');
    expect(mime).not.toContain('Content-Disposition');
    expect(mime.endsWith('--\r\n')).toBe(true);
    // An empty list is the same as none.
    const normalize = (m: string) => m.replace(/b_[0-9a-f]{32}/g, 'B');
    expect(normalize(buildMime('from@example.com', { ...base, attachments: [] }))).toBe(normalize(mime));
  });
});

describe('buildMime with attachments', () => {
  const ics = 'BEGIN:VCALENDAR\r\nSUMMARY:Retreat 秋季\r\nEND:VCALENDAR\r\n';
  const binary = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256);
  const mime = buildMime('from@example.com', {
    ...base,
    attachments: [
      { filename: 'event.ics', contentType: 'text/calendar; charset=utf-8; method=PUBLISH', content: ics },
      { filename: 'data.bin', contentType: 'application/octet-stream', content: binary },
    ],
  });

  it('wraps the alternative part in multipart/mixed with different boundaries', () => {
    const mixed = /Content-Type: multipart\/mixed; boundary="(m_[0-9a-f]{32})"/.exec(mime)?.[1];
    const alt = /Content-Type: multipart\/alternative; boundary="(b_[0-9a-f]{32})"/.exec(mime)?.[1];
    expect(mixed).toBeTruthy();
    expect(alt).toBeTruthy();
    expect(mixed).not.toBe(alt);
    expect(mime.indexOf(`--${mixed}\r\nContent-Type: multipart/alternative`)).toBeGreaterThan(0);
    expect(mime.match(new RegExp(`--${mixed}\\r\\n`, 'g'))).toHaveLength(3); // alternative + 2 files
    expect(mime.trimEnd().endsWith(`--${mixed}--`)).toBe(true);
    expect(mime).toContain(`--${alt}--`);
    expect(mime).toContain('Content-Disposition: attachment; filename="event.ics"');
  });

  it('base64-encodes attachments at 76 columns and round-trips the bytes', () => {
    const parts = mime.split(/\r\n--m_[0-9a-f]{32}(?:--)?\r\n?/).slice(2).filter((p) => p.trim() !== '');
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      const body = part.split('\r\n\r\n')[1].trimEnd();
      for (const line of body.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(new TextDecoder().decode(decode(parts[0].split('\r\n\r\n')[1]))).toBe(ics);
    expect([...decode(parts[1].split('\r\n\r\n')[1])]).toEqual([...binary]);
  });

  it('keeps hostile filenames and media types out of the header block', () => {
    const hostile = buildMime('from@example.com', {
      ...base,
      subject: 'Hi\r\nBcc: evil@example.com',
      attachments: [{ filename: 'a"\r\nBcc: x@example.com\r\n.ics', contentType: 'text/plain\r\nBcc: y@example.com', content: 'x' }],
    });
    for (const line of lines(hostile)) {
      expect(line.startsWith('Bcc:')).toBe(false);
    }
    expect(hostile).not.toMatch(/\r\n"?\s*Bcc/);
  });

  it('encodes non-ASCII filenames per RFC 2231', () => {
    const named = buildMime('from@example.com', {
      ...base,
      attachments: [{ filename: '秋季.ics', contentType: 'text/calendar', content: 'x' }],
    });
    expect(named).toContain(`filename*=UTF-8''%E7%A7%8B%E5%AD%A3.ics`);
    expect(named).toMatch(/filename="[\x20-\x7e]*"; filename\*=/);
  });
});
