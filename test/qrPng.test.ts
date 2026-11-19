// The QR PNG encoder: valid signature, IHDR, checksums and pixels, encoding ONLY the
// text given; and the public QR route's gating and 404s.
import { env } from 'cloudflare:test';
import qrcode from 'qrcode-generator';
import { describe, expect, it } from 'vitest';
import { crc32, qrPng } from '../src/lib/qrPng';
import { GET } from '../src/pages/register/qr/[eventId]/[confirmation].png';
import { classifyRoute } from '../src/lib/routePolicy';
import { moduleForPath } from '../src/lib/modules';
import { createRegistration, saveEvent } from '../src/lib/regDb';

interface Chunk { type: string; data: Uint8Array; crc: number }
function chunks(png: Uint8Array): Chunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  let at = 8;
  while (at < png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    out.push({ type, data: png.subarray(at + 8, at + 8 + len), crc: view.getUint32(at + 8 + len) });
    at += 12 + len;
  }
  return out;
}
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The dark/light module grid the PNG draws (read back from its pixels), quiet zone removed. */
async function modulesOf(png: Uint8Array): Promise<boolean[][]> {
  const [ihdr, idat] = chunks(png);
  const size = new DataView(ihdr.data.buffer, ihdr.data.byteOffset).getUint32(0);
  const raw = await inflate(chunks(png).find((c) => c.type === 'IDAT')!.data);
  expect(idat.type).toBe('IDAT');
  const scale = 8;
  const quiet = 4;
  const n = size / scale - quiet * 2;
  return Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => raw[((r + quiet) * scale + 3) * (size + 1) + 1 + (c + quiet) * scale + 3] === 0));
}

describe('qrPng', () => {
  it('writes a valid PNG: signature, IHDR, correct CRCs, IDAT that inflates to the scanlines', async () => {
    const png = await qrPng('R26-0001');
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parts = chunks(png);
    expect(parts.map((p) => p.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const ihdr = new DataView(parts[0].data.buffer, parts[0].data.byteOffset);
    const width = ihdr.getUint32(0);
    expect(ihdr.getUint32(4)).toBe(width);
    expect([...parts[0].data.subarray(8)]).toEqual([8, 0, 0, 0, 0]);
    for (const part of parts) {
      const typed = new Uint8Array(4 + part.data.length);
      typed.set(new TextEncoder().encode(part.type));
      typed.set(part.data, 4);
      expect(part.crc).toBe(crc32(typed));
    }
    expect(parts[2].data.length).toBe(0);
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
    const raw = await inflate(parts[1].data);
    expect(raw.length).toBe((width + 1) * width);
    for (let y = 0; y < width; y++) expect(raw[y * (width + 1)]).toBe(0); // filter byte
    // 8-px modules plus a quiet zone: the border is white.
    expect(raw[1]).toBe(255);
    expect(width % 8).toBe(0);
  });

  it('encodes exactly the given text and nothing else', async () => {
    const text = 'R26-0001';
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const expected = Array.from({ length: qr.getModuleCount() }, (_, r) =>
      Array.from({ length: qr.getModuleCount() }, (_, c) => qr.isDark(r, c)));
    expect(await modulesOf(await qrPng(text))).toEqual(expected);
    expect(await modulesOf(await qrPng(`${text}#t=${'a'.repeat(43)}`))).not.toEqual(expected);
  });
});

describe('GET /register/qr/<event>/<confirmation>.png', () => {
  const call = (eventId: string, confirmation: string, modules: string[] = ['registration']) =>
    GET({ params: { eventId, confirmation }, locals: { modules: new Set(modules), rawDb: env.DB } } as never) as Promise<Response>;

  it('serves a registration\'s QR as an immutable public PNG', async () => {
    const eventId = await saveEvent(env.DB, { title_en: 'QR event', starts_at: '2036-01-01 10:00:00', active: 1 });
    const created = await createRegistration(env.DB, {
      eventId, personId: null, name: 'Q', email: 'q@example.com', status: 'confirmed', amountCents: 0, currency: 'usd', answers: [],
    });
    const res = await call(String(eventId), created.confirmationNo!);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const body = new Uint8Array(await res.arrayBuffer());
    expect([...body.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    // Same number under another event, malformed values and a disabled module all 404 bare.
    for (const [e, c, m] of [
      [String(eventId + 999), created.confirmationNo!, undefined],
      [String(eventId), 'R36-9999', undefined],
      ['abc', created.confirmationNo!, undefined],
      [String(eventId), 'r36-0001', undefined],
      [String(eventId), "R36-0001' OR 1=1", undefined],
      [String(eventId), created.confirmationNo!, []],
    ] as const) {
      const miss = await call(e, c, m as string[] | undefined);
      expect(miss.status).toBe(404);
      expect(await miss.text()).toBe('Not found');
    }
  });

  it('is owned by the registration module and public', () => {
    expect(moduleForPath('/register/qr/5/R26-0001.png')).toBe('registration');
    expect(classifyRoute('/register/qr/5/R26-0001.png')).toBe('public');
  });
});
