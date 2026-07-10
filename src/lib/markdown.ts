// Minimal, safe Markdown renderer for admin-authored page bodies. The whole
// input is HTML-escaped BEFORE any transformation, so raw HTML can never
// reach the output. Supports: #..###### headings, paragraphs, **bold**,
// *italic*, `code`, ``` fenced blocks, [text](href), ![alt](src),
// -/* and 1. lists, > blockquotes, --- rules. hrefs/srcs restricted to
// https?://, /, #, mailto:.
const SAFE_HREF = /^(https?:\/\/|\/|#|mailto:)/i;

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function inline(escaped: string): string {
  const codes: string[] = [];
  let out = escaped.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, src: string) =>
    SAFE_HREF.test(src) ? `<img src="${src}" alt="${alt}" />` : m,
  );
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) =>
    SAFE_HREF.test(href) ? `<a href="${href}">${label}</a>` : m,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

export function renderMarkdown(md: string): string {
  const lines = escapeHtml(md.replaceAll('\r\n', '\n')).split('\n');
  const html: string[] = [];
  let i = 0;
  const isBlank = (s: string) => s.trim() === '';
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      html.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = h[1].length; html.push(`<h${n}>${inline(h[2].trim())}</h${n}>`); i++; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { html.push('<hr />'); i++; continue; }
    if (line.startsWith('&gt;')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('&gt;')) buf.push(lines[i++].replace(/^&gt;\s?/, ''));
      html.push(`<blockquote><p>${buf.map(inline).join('<br />')}</p></blockquote>`);
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/;
    const ol = /^\s*\d+\.\s+(.*)$/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const buf: string[] = [];
      while (i < lines.length && re.test(lines[i])) buf.push(`<li>${inline(lines[i++].match(re)![1])}</li>`);
      html.push(ordered ? `<ol>${buf.join('')}</ol>` : `<ul>${buf.join('')}</ul>`);
      continue;
    }
    const buf: string[] = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !/^(#{1,6}\s|```|&gt;|\s*[-*]\s|\s*\d+\.\s|\s*(---+|\*\*\*+)\s*$)/.test(lines[i])) buf.push(lines[i++]);
    html.push(`<p>${buf.map((l) => inline(l.trim())).join('<br />')}</p>`);
  }
  return html.join('\n');
}
