// A QR code as a PNG, for places SVG cannot go (email clients block SVG and data
// URIs). The module matrix comes from qrcode-generator; the PNG itself is encoded
// here: 8-bit grayscale, filter 0 on every scanline, zlib from CompressionStream,
// CRC-32 on every chunk. Nothing is sent to an outside service.
import qrcode from 'qrcode-generator';

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Modules of white border on every side (the QR specification asks for 4). */
const QUIET_ZONE = 4;
/** Pixels per module. */
const SCALE = 8;

let crcTable: Uint32Array | null = null;

/** CRC-32 (the PNG / zlib polynomial) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // The checksum covers the type and the data, not the length.
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib-wrapped deflate ('deflate' is the zlib format; 'deflate-raw' would not be). */
async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The QR for `text` as PNG bytes: width = height = (modules + 2 x quiet zone) x scale. */
export async function qrPng(text: string): Promise<Uint8Array> {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount();
  const size = (modules + QUIET_ZONE * 2) * SCALE;

  // One filter byte (0 = none) then `size` gray samples (0 black, 255 white) per row.
  const raw = new Uint8Array((size + 1) * size).fill(255);
  for (let y = 0; y < size; y++) raw[y * (size + 1)] = 0;
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (!qr.isDark(row, col)) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        const start = ((row + QUIET_ZONE) * SCALE + dy) * (size + 1) + 1 + (col + QUIET_ZONE) * SCALE;
        raw.fill(0, start, start + SCALE);
      }
    }
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header[8] = 8; // bit depth
  header[9] = 0; // color type: grayscale
  // compression 0, filter method 0, interlace 0 are already zero.

  const parts = [SIGNATURE, chunk('IHDR', header), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** What a registration QR encodes: the confirmation number and nothing else. */
export const CONFIRMATION_NO_RE = /^[A-Z0-9]{1,6}-\d{4,}$/;
