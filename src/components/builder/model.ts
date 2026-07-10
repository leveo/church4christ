// Pure state model for the builder island: container addressing, containment
// rules, and an undo-capable reducer. React components stay thin views; every
// tree mutation lives here where it is unit-tested (test/builderModel.test.ts).
import type { AnyNode, ColumnsNode, PageLayout } from '../../lib/pageLayout';

export type ContainerRef = 'root' | `sec:${string}` | `col:${string}:${number}`;

export function parseContainerRef(ref: ContainerRef):
  | { kind: 'root' }
  | { kind: 'sec'; id: string }
  | { kind: 'col'; id: string; col: number } {
  if (ref === 'root') return { kind: 'root' };
  if (ref.startsWith('sec:')) return { kind: 'sec', id: ref.slice(4) };
  const [, id, col] = ref.split(':');
  return { kind: 'col', id, col: Number(col) };
}

export interface BuilderState {
  layout: PageLayout;
  selectedId: string | null;
  past: PageLayout[];
  future: PageLayout[];
}

export type BuilderAction =
  | { type: 'insert'; container: ContainerRef; index: number; node: AnyNode }
  | { type: 'move'; container: ContainerRef; index: number; id: string }
  | { type: 'update'; id: string; props: Record<string, unknown> }
  | { type: 'remove'; id: string }
  | { type: 'duplicate'; id: string }
  | { type: 'select'; id: string | null }
  | { type: 'undo' }
  | { type: 'redo' };

const HISTORY_CAP = 50;

export function initialState(layout: PageLayout): BuilderState {
  return { layout, selectedId: null, past: [], future: [] };
}

/** Containment rules — mirrors validateLayout so the canvas can never build a
 *  tree the server would reject. */
export function canDrop(nodeType: AnyNode['type'], container: ContainerRef): boolean {
  const target = parseContainerRef(container);
  if (nodeType === 'section') return target.kind === 'root';
  if (nodeType === 'columns') return target.kind === 'sec';
  return target.kind === 'sec' || target.kind === 'col';
}

/** The mutable array a container ref addresses inside `layout`, or null. */
function containerArray(layout: PageLayout, ref: ContainerRef): AnyNode[] | null {
  const target = parseContainerRef(ref);
  if (target.kind === 'root') return layout.blocks;
  for (const sec of layout.blocks) {
    if (target.kind === 'sec' && sec.id === target.id) return sec.children;
    if (target.kind === 'col') {
      for (const child of sec.children) {
        if (child.type === 'columns' && child.id === target.id) return child.columns[target.col] ?? null;
      }
    }
  }
  return null;
}

export function findNode(
  layout: PageLayout,
  id: string,
): { node: AnyNode; container: ContainerRef; index: number } | null {
  for (const [i, sec] of layout.blocks.entries()) {
    if (sec.id === id) return { node: sec, container: 'root', index: i };
    for (const [j, child] of sec.children.entries()) {
      if (child.id === id) return { node: child, container: `sec:${sec.id}`, index: j };
      if (child.type === 'columns') {
        for (const [c, col] of child.columns.entries()) {
          for (const [k, leaf] of col.entries()) {
            if (leaf.id === id) return { node: leaf, container: `col:${child.id}:${c}`, index: k };
          }
        }
      }
    }
  }
  return null;
}

function withFreshIds<T extends AnyNode>(node: T): T {
  const clone = structuredClone(node);
  const stamp = (n: AnyNode): void => {
    n.id = crypto.randomUUID();
    if (n.type === 'section') n.children.forEach(stamp);
    if (n.type === 'columns') n.columns.forEach((col) => col.forEach(stamp));
  };
  stamp(clone);
  return clone;
}

/** Resize a columns node's arrays: grow with empty columns, shrink by merging
 *  overflow leaves into the last kept column (nothing is silently deleted). */
function reflowColumns(node: ColumnsNode, count: 2 | 3 | 4): void {
  while (node.columns.length < count) node.columns.push([]);
  if (node.columns.length > count) {
    const overflow = node.columns.slice(count).flat();
    node.columns = node.columns.slice(0, count);
    node.columns[count - 1].push(...overflow);
  }
}

function commit(state: BuilderState, next: PageLayout, selectedId: string | null): BuilderState {
  return {
    layout: next,
    selectedId,
    past: [...state.past.slice(-(HISTORY_CAP - 1)), state.layout],
    future: [],
  };
}

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case 'select':
      return { ...state, selectedId: action.id };

    case 'undo': {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      return { ...state, layout: prev, past: state.past.slice(0, -1), future: [state.layout, ...state.future] };
    }
    case 'redo': {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { ...state, layout: next, past: [...state.past, state.layout], future: rest };
    }

    case 'insert': {
      if (!canDrop(action.node.type, action.container)) return state;
      const next = structuredClone(state.layout);
      const arr = containerArray(next, action.container);
      if (!arr) return state;
      arr.splice(Math.min(action.index, arr.length), 0, structuredClone(action.node));
      return commit(state, next, action.node.id);
    }

    case 'move': {
      const found = findNode(state.layout, action.id);
      if (!found || !canDrop(found.node.type, action.container)) return state;
      const next = structuredClone(state.layout);
      const fromArr = containerArray(next, found.container);
      if (!fromArr) return state;
      const [node] = fromArr.splice(found.index, 1);
      let index = action.index;
      if (found.container === action.container && found.index < index) index -= 1;
      const toArr = containerArray(next, action.container);
      if (!toArr || !node) return state;
      toArr.splice(Math.min(index, toArr.length), 0, node);
      return commit(state, next, action.id);
    }

    case 'update': {
      const found = findNode(state.layout, action.id);
      if (!found) return state;
      const next = structuredClone(state.layout);
      const target = findNode(next, action.id);
      if (!target) return state;
      const node = target.node;
      const { count, ...rest } = action.props as { count?: 2 | 3 | 4 } & Record<string, unknown>;
      (node as { props: Record<string, unknown> }).props = { ...node.props, ...rest };
      if (node.type === 'columns' && count !== undefined) {
        node.props.count = count;
        reflowColumns(node, count);
      } else if (count !== undefined) {
        (node as { props: Record<string, unknown> }).props = { ...node.props, count };
      }
      return commit(state, next, state.selectedId);
    }

    case 'remove': {
      const found = findNode(state.layout, action.id);
      if (!found) return state;
      const next = structuredClone(state.layout);
      const arr = containerArray(next, found.container);
      if (!arr) return state;
      arr.splice(found.index, 1);
      return commit(state, next, null);
    }

    case 'duplicate': {
      const found = findNode(state.layout, action.id);
      if (!found) return state;
      const next = structuredClone(state.layout);
      const arr = containerArray(next, found.container);
      if (!arr) return state;
      const copy = withFreshIds(found.node);
      arr.splice(found.index + 1, 0, copy);
      return commit(state, next, copy.id);
    }
  }
}
