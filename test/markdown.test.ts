// Pure logic, no DB — runs under the default `workers` project fine since it
// makes no `cloudflare:test` imports, but needs no special environment either.
// renderMarkdown escapes the ENTIRE input before any markdown transform, so raw
// HTML (and any attribute-breakout attempt inside markdown syntax) can never
// reach the output — the tests below probe exactly that boundary alongside the
// supported markdown subset.
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown';

describe('renderMarkdown — block structure', () => {
  it('renders a level-1 heading', () => {
    expect(renderMarkdown('# Hi')).toBe('<h1>Hi</h1>');
  });

  it('renders headings 1-6', () => {
    for (let n = 1; n <= 6; n++) {
      const hashes = '#'.repeat(n);
      expect(renderMarkdown(`${hashes} Level ${n}`)).toBe(`<h${n}>Level ${n}</h${n}>`);
    }
  });

  it('merges consecutive non-blank lines into one paragraph, joined by <br />', () => {
    expect(renderMarkdown('Line one\nLine two')).toBe('<p>Line one<br />Line two</p>');
  });

  it('a blank line starts a new paragraph', () => {
    expect(renderMarkdown('First para\n\nSecond para')).toBe('<p>First para</p>\n<p>Second para</p>');
  });

  it('fenced code block preserves content verbatim (no inline parsing inside)', () => {
    const md = ['```', '**not bold** <tag> & "quote"', '```'].join('\n');
    // Escaping happens on the WHOLE input up front, so the fenced block's
    // content is HTML-escaped (safe to embed) but never markdown-inline-parsed
    // (the ** stays literal, not turned into <strong>).
    expect(renderMarkdown(md)).toBe('<pre><code>**not bold** &lt;tag&gt; &amp; &quot;quote&quot;</code></pre>');
  });

  it('unordered list (- and *)', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('* a\n* b')).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('ordered list', () => {
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('blockquote', () => {
    expect(renderMarkdown('> a wise word')).toBe('<blockquote><p>a wise word</p></blockquote>');
  });

  it('--- renders a horizontal rule', () => {
    expect(renderMarkdown('above\n\n---\n\nbelow')).toBe('<p>above</p>\n<hr />\n<p>below</p>');
  });
});

describe('renderMarkdown — inline formatting', () => {
  it('bold, italic, and inline code', () => {
    expect(renderMarkdown('**bold**')).toBe('<p><strong>bold</strong></p>');
    expect(renderMarkdown('*italic*')).toBe('<p><em>italic</em></p>');
    expect(renderMarkdown('`code`')).toBe('<p><code>code</code></p>');
  });

  it('a safe https link renders as <a>', () => {
    expect(renderMarkdown('[a](https://x)')).toBe('<p><a href="https://x">a</a></p>');
  });

  it('a javascript: link does NOT become a link (the raw markdown text passes through, unlinked)', () => {
    // Unsafe hrefs are rejected by returning the original matched text
    // unchanged, so the source text is still visible (as inert text, and here
    // with no HTML metacharacters to escape) — the safety property is "never a
    // live href", not "the substring disappears".
    expect(renderMarkdown('[a](javascript:alert(1))')).toBe('<p>[a](javascript:alert(1))</p>');
  });

  it('an image with a safe src renders as <img>', () => {
    expect(renderMarkdown('![x](/media/uploads/k)')).toBe('<p><img src="/media/uploads/k" alt="x" /></p>');
  });

  it('raw HTML is escaped, never executed', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('a double quote in alt text cannot break out of the alt attribute', () => {
    // The whole input is HTML-escaped before any markdown parsing, so the raw
    // `"` is already `&quot;` by the time the alt attribute gets built —
    // structurally incapable of ending the attribute early.
    expect(renderMarkdown('![alt " onerror=alert(1)](/media/x)')).toBe(
      '<p><img src="/media/x" alt="alt &quot; onerror=alert(1)" /></p>',
    );
  });
});
