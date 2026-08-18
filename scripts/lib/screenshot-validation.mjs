const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function requireScreenshotOnly(argv) {
  if (!argv.includes('--only')) {
    throw new Error('Refusing unfiltered screenshot capture: pass --only with output-path tokens for one backend and identity; no files were written.');
  }
}

export function requireLocalScreenshotBase(rawBase) {
  let base;
  try {
    base = new URL(rawBase);
  } catch {
    throw new Error('Screenshot sessions require an exact loopback screenshot origin');
  }
  const loopback = base.hostname === 'localhost'
    || base.hostname === '127.0.0.1'
    || base.hostname === '[::1]';
  if (
    !['http:', 'https:'].includes(base.protocol)
    || !loopback
    || base.username !== ''
    || base.password !== ''
    || base.pathname !== '/'
    || base.search !== ''
    || base.hash !== ''
  ) {
    throw new Error('Screenshot sessions require an exact loopback screenshot origin');
  }
  return base.origin;
}

export function assertExpectedScreenshotPage(row, snapshot) {
  if (!Number.isInteger(snapshot.status) || snapshot.status < 200 || snapshot.status >= 400) {
    throw new Error(`${row.out}: main document returned HTTP ${String(snapshot.status)}`);
  }
  const actualUrl = new URL(snapshot.url);
  const expectedUrl = new URL(row.path, actualUrl.origin);
  if (actualUrl.pathname !== expectedUrl.pathname) {
    const signIn = /(^|\/)signin\/?$/.test(actualUrl.pathname) ? ' (sign-in page)' : '';
    throw new Error(`${row.out}: unexpected path ${JSON.stringify(actualUrl.pathname)}${signIn}; expected ${JSON.stringify(expectedUrl.pathname)}`);
  }
  for (const [name, value] of expectedUrl.searchParams) {
    const actualValue = actualUrl.searchParams.get(name);
    if (actualValue !== value) {
      throw new Error(`${row.out}: unexpected query ${JSON.stringify(name)}=${JSON.stringify(actualValue)}; expected ${JSON.stringify(value)}`);
    }
  }
  const text = normalize([snapshot.title, ...(snapshot.headings ?? []), snapshot.body].join('\n'));
  const pageIdentity = normalize([snapshot.title, ...(snapshot.headings ?? [])].join('\n'));
  if (/\bpage not found\b|\b404\b|找不到页面|页面未找到|頁面未找到/i.test(pageIdentity)) {
    throw new Error(`${row.out}: capture rendered a 404 page`);
  }
  if (row.expectedText && !text.includes(row.expectedText)) {
    throw new Error(`${row.out}: expected page marker ${JSON.stringify(row.expectedText)} was not found`);
  }
  for (const marker of row.rejectionTexts ?? []) {
    if (text.includes(marker)) throw new Error(`${row.out}: rejection marker ${JSON.stringify(marker)} was found`);
  }
  for (const marker of row.identityRejectionTexts ?? []) {
    if (text.includes(marker)) {
      throw new Error(`${row.out}: identity rejection marker ${JSON.stringify(marker)} was found`);
    }
  }
  if (row.identityExpectedText && !text.includes(row.identityExpectedText)) {
    throw new Error(`${row.out}: identity marker ${JSON.stringify(row.identityExpectedText)} was not found`);
  }
  const searchable = normalize([text, ...(snapshot.links ?? [])].join('\n'));
  for (const marker of row.requiredTexts ?? []) {
    if (!searchable.includes(marker)) {
      throw new Error(`${row.out}: required capture marker ${JSON.stringify(marker)} was not found`);
    }
  }
}

export function validateScreenshotManifest(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new TypeError('screenshot manifest must be non-empty');
  const outputs = new Set();
  for (const row of rows) {
    const keys = Object.keys(row).sort().join('|');
    if (keys !== ['backend', 'expectedText', 'identity', 'locale', 'out', 'path', 'rejectionTexts', 'viewport'].sort().join('|')) throw new TypeError(`screenshot definition fields are invalid: ${row?.out ?? 'unknown'}`);
    if (typeof row.path !== 'string' || !row.path.startsWith('/') || typeof row.out !== 'string' || !row.out.startsWith('docs/images/') || outputs.has(row.out)) throw new TypeError('screenshot path/output is invalid or duplicated');
    outputs.add(row.out);
    if (!['en', 'zh'].includes(row.locale) || !['d1', 'supabase', 'either'].includes(row.backend) || !['public', 'admin', 'member'].includes(row.identity)) throw new TypeError(`screenshot locale/backend/identity is invalid: ${row.out}`);
    if (row.viewport?.width !== 1280 || row.viewport?.height !== 800) throw new TypeError(`screenshot viewport is invalid: ${row.out}`);
    if (typeof row.expectedText !== 'string' || !row.expectedText || !Array.isArray(row.rejectionTexts) || row.rejectionTexts.length === 0 || row.rejectionTexts.some((x) => typeof x !== 'string' || !x)) throw new TypeError(`screenshot markers are invalid: ${row.out}`);
  }
  return rows;
}
