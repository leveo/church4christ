type RejectionTarget = Pick<EventTarget, 'addEventListener'>;

const ES_MODULE_LEXER_WASM_REJECTION =
  /^WebAssembly\.compile\(\): Wasm code generation disallowed by embedder$/i;
const POSTGRES_CF_CANCEL = /^Stream was cancelled\.$/;
const POSTGRES_CF_READER_STACK =
  /\bat read \(?(?:(?:[^\n]*\/)?node_modules\/postgres\/cf\/polyfills\.js|[^\n]*\/dist\/server\/chunks\/modules_[^/\n]+\.mjs):\d+:\d+\)?/;

export function isKnownUnhandledError(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const candidate = reason as { name?: unknown; message?: unknown; stack?: unknown };
  const wasm =
    candidate.name === 'CompileError' &&
    typeof candidate.message === 'string' &&
    ES_MODULE_LEXER_WASM_REJECTION.test(candidate.message);
  const postgresCancellation =
    candidate.name === 'Error' &&
    typeof candidate.message === 'string' &&
    POSTGRES_CF_CANCEL.test(candidate.message) &&
    typeof candidate.stack === 'string' &&
    POSTGRES_CF_READER_STACK.test(candidate.stack);
  return wasm || postgresCancellation;
}

export function ignoreKnownUnhandledError(reason: unknown): false | undefined {
  return isKnownUnhandledError(reason) ? false : undefined;
}

export function installKnownUnhandledFilter(target: RejectionTarget): void {
  target.addEventListener('unhandledrejection', ((event: Event & { reason?: unknown }) => {
    if (isKnownUnhandledError(event.reason)) event.preventDefault();
  }) as EventListener);
}

const globalTarget = globalThis as unknown as Partial<RejectionTarget>;
if (typeof globalTarget.addEventListener === 'function') {
  installKnownUnhandledFilter(globalTarget as RejectionTarget);
}
