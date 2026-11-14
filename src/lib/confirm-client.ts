// Shared submit-time confirmation. Any form (or its submitting button) that
// carries a data-confirm="message" attribute asks before posting; declining
// cancels the submit. Delegated at document level so it also covers rows that
// are rendered or cloned after load. No inline script, so it stays compatible
// with a strict script-src policy.
export function confirmMessageFor(form: Element, submitter: Element | null): string | null {
  const own = submitter?.getAttribute('data-confirm') ?? form.getAttribute('data-confirm');
  return own && own.length > 0 ? own : null;
}

export function initConfirm(root: Document = document, ask: (message: string) => boolean = (m) => window.confirm(m)): void {
  root.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof Element)) return;
    const submitter = (event as SubmitEvent).submitter ?? null;
    const message = confirmMessageFor(form, submitter);
    if (message && !ask(message)) event.preventDefault();
  });
}
