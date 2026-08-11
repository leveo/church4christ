const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function assertExpectedScreenshotPage(row, snapshot) {
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
}
