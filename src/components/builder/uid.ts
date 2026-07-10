// Block-id minting. crypto.randomUUID exists only in SECURE contexts (https
// or localhost) — an admin reaching a dev/LAN server over plain http (e.g.
// http://192.168.x.x:4321) has crypto but not randomUUID, and the builder
// crashed on the first palette click. crypto.getRandomValues IS available in
// insecure contexts, so fall back to 32 random hex chars — still unique and
// still matching pageLayout's ID_RE ([A-Za-z0-9_-]{1,36}).
export function uid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
