// Server-side QR code as inline SVG. Generated locally from the URL, so the
// kiosk address is never sent to an external image service.
import qrcode from 'qrcode-generator';

/** Returns an <svg> string (token colors via currentColor) or '' for empty input. */
export function qrSvg(text: string, label: string): string {
  if (!text) return '';
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  const size = n + quiet * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const safe = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${safe}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="currentColor" opacity="0"/><path d="${path}" fill="currentColor"/></svg>`;
}
