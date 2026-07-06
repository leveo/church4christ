// Client-side 简/繁 toggle. zh content is authored in Simplified Chinese
// (zh-Hans); when the visitor prefers Traditional, the whole document is
// converted in place. The conversion table is code-split behind a dynamic
// import and only fetched in Traditional mode — Simplified readers pay zero
// extra bytes. Ported from dcfc-website's zh-client.ts with the direction
// flipped (their base was Traditional with t2s).
const KEY = 'c4c-hant';
const HAN_RE = /[㐀-鿿]/;
const CONVERTED_ATTRS = ['title', 'alt', 'placeholder', 'aria-label'] as const;

function isHant(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

async function traditionalizeDocument(): Promise<void> {
  const { toTraditional } = await import('./s2t');
  document.documentElement.lang = 'zh-Hant';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || p.closest('script,style,noscript,[data-no-convert]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const n of nodes) {
    const t = n.nodeValue;
    if (t && HAN_RE.test(t)) n.nodeValue = toTraditional(t);
  }
  const attrSelector = CONVERTED_ATTRS.map((a) => `[${a}]`).join(', ');
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(attrSelector))) {
    if (el.closest('[data-no-convert]')) continue;
    for (const attr of CONVERTED_ATTRS) {
      const v = el.getAttribute(attr);
      if (v && HAN_RE.test(v)) el.setAttribute(attr, toTraditional(v));
    }
  }
  document.title = toTraditional(document.title);
}

export function initZhToggle(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLElement>('[data-zh-toggle]'));
  if (buttons.length === 0) return; // non-zh pages render no toggle → nothing to do
  const hant = isHant();
  if (hant) void traditionalizeDocument();
  for (const btn of buttons) {
    btn.textContent = hant ? '简' : '繁';
    btn.setAttribute('title', hant ? '切換為簡體中文' : '切换为繁体中文');
    btn.addEventListener('click', () => {
      try {
        if (hant) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, '1');
      } catch {
        return; // storage unavailable → toggling can't persist; do nothing
      }
      location.reload();
    });
  }
}
