// Builder island tree ops (pure reducer — the React components are thin
// views over this). Runs in the workers pool like every other unit test;
// crypto.randomUUID is available there.
import { describe, expect, it, vi } from 'vitest';
import { builderReducer, canDrop, findNode, initialState } from '../src/components/builder/model';
import { uid } from '../src/components/builder/uid';
import { newBlock } from '../src/components/builder/newBlock';
import type { ColumnsNode, PageLayout, SectionNode } from '../src/lib/pageLayout';

const start = (): ReturnType<typeof initialState> => {
  const section = newBlock('section') as SectionNode;
  const layout: PageLayout = { v: 1, blocks: [section] };
  return { ...initialState(layout), layout };
};

describe('canDrop containment', () => {
  it('sections only at root; columns only in sections; leaves in sections/columns', () => {
    expect(canDrop('section', 'root')).toBe(true);
    expect(canDrop('heading', 'root')).toBe(false);
    expect(canDrop('columns', 'sec:x')).toBe(true);
    expect(canDrop('columns', 'col:x:0')).toBe(false);
    expect(canDrop('section', 'sec:x')).toBe(false);
    expect(canDrop('button', 'col:x:1')).toBe(true);
  });
});

describe('builderReducer', () => {
  it('insert appends into a section and records history + selection', () => {
    const s0 = start();
    const secId = s0.layout.blocks[0].id;
    const h = newBlock('heading');
    const s1 = builderReducer(s0, { type: 'insert', container: `sec:${secId}`, index: 0, node: h });
    expect((s1.layout.blocks[0] as SectionNode).children[0].id).toBe(h.id);
    expect(s1.selectedId).toBe(h.id);
    expect(s1.past.length).toBe(1);
  });

  it('rejects containment violations without changing state', () => {
    const s0 = start();
    const s1 = builderReducer(s0, { type: 'insert', container: 'root', index: 0, node: newBlock('heading') });
    expect(s1).toBe(s0);
  });

  it('move adjusts the index when moving later within the same container', () => {
    let s = start();
    const secId = s.layout.blocks[0].id;
    const a = newBlock('heading'); const b = newBlock('text'); const c = newBlock('divider');
    for (const [i, n] of [a, b, c].entries()) s = builderReducer(s, { type: 'insert', container: `sec:${secId}`, index: i, node: n });
    // Move a (index 0) to "before index 3" (the end): with same-container
    // removal adjustment it must land AFTER c, order b,c,a.
    s = builderReducer(s, { type: 'move', container: `sec:${secId}`, index: 3, id: a.id });
    const ids = (s.layout.blocks[0] as SectionNode).children.map((n) => n.id);
    expect(ids).toEqual([b.id, c.id, a.id]);
  });

  it('move between containers works and respects canDrop', () => {
    let s = start();
    const secId = s.layout.blocks[0].id;
    const cols = newBlock('columns');
    const h = newBlock('heading');
    s = builderReducer(s, { type: 'insert', container: `sec:${secId}`, index: 0, node: cols });
    s = builderReducer(s, { type: 'insert', container: `sec:${secId}`, index: 1, node: h });
    s = builderReducer(s, { type: 'move', container: `col:${cols.id}:0`, index: 0, id: h.id });
    const sec = s.layout.blocks[0] as SectionNode;
    expect(sec.children.length).toBe(1);
    expect(findNode(s.layout, h.id)?.container).toBe(`col:${cols.id}:0`);
    // a section cannot be moved into a column
    const s2 = builderReducer(s, { type: 'move', container: `col:${cols.id}:1`, index: 0, id: secId });
    expect(s2).toBe(s);
  });

  it('update merges props; columns count change reflows the column arrays', () => {
    let s = start();
    const secId = s.layout.blocks[0].id;
    const cols = newBlock('columns');
    const h = newBlock('heading');
    s = builderReducer(s, { type: 'insert', container: `sec:${secId}`, index: 0, node: cols });
    s = builderReducer(s, { type: 'insert', container: `col:${cols.id}:1`, index: 0, node: h });
    // shrink 2 → … grow to 4 first, then shrink to 2 keeping h (merged into last kept col)
    s = builderReducer(s, { type: 'update', id: cols.id, props: { count: 4 } });
    let found = findNode(s.layout, cols.id)!.node as ColumnsNode;
    expect(found.columns.length).toBe(4);
    s = builderReducer(s, { type: 'update', id: cols.id, props: { count: 2 } });
    found = findNode(s.layout, cols.id)!.node as ColumnsNode;
    expect(found.columns.length).toBe(2);
    expect(findNode(s.layout, h.id)).not.toBeNull(); // survived the shrink
  });

  it('remove, duplicate (fresh unique ids), undo, redo', () => {
    let s = start();
    const secId = s.layout.blocks[0].id;
    const h = newBlock('heading');
    s = builderReducer(s, { type: 'insert', container: `sec:${secId}`, index: 0, node: h });
    s = builderReducer(s, { type: 'duplicate', id: h.id });
    const sec = s.layout.blocks[0] as SectionNode;
    expect(sec.children.length).toBe(2);
    expect(sec.children[1].id).not.toBe(h.id);

    const before = s.layout;
    s = builderReducer(s, { type: 'remove', id: h.id });
    expect(findNode(s.layout, h.id)).toBeNull();
    s = builderReducer(s, { type: 'undo' });
    expect(s.layout).toEqual(before);
    s = builderReducer(s, { type: 'redo' });
    expect(findNode(s.layout, h.id)).toBeNull();
  });
});

// Insecure-context regression: crypto.randomUUID exists only on https/localhost,
// so an admin on a plain-http LAN dev server crashed on the first palette click.
// uid() must mint valid, unique ids from getRandomValues when randomUUID is absent.
describe('uid fallback (insecure context)', () => {
  it('mints ID_RE-valid unique ids without crypto.randomUUID', () => {
    const stripped = {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    } as unknown as Crypto;
    vi.stubGlobal('crypto', stripped);
    try {
      const a = uid();
      const b = uid();
      expect(a).toMatch(/^[A-Za-z0-9_-]{1,36}$/);
      expect(a).not.toBe(b);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
