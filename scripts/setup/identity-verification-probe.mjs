const PATH = '/api/health/identity-verification';
const STATUSES = new Set(['valid', 'invalid', 'unverifiable']);

function privateIpv4(host) {
  const octets = host.split('.');
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const values = octets.map(Number);
  if (values.some((part) => part > 255)) return false;
  return values[0] === 0 || values[0] === 10 || values[0] === 127 ||
    values[0] === 169 && values[1] === 254 || values[0] === 172 && values[1] >= 16 && values[1] <= 31 ||
    values[0] === 192 && values[1] === 168 || values[0] === 100 && values[1] >= 64 && values[1] <= 127;
}

function privateIpLiteral(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || privateIpv4(host)) return true;
  const embeddedV4 = host.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (embeddedV4 && privateIpv4(embeddedV4[1])) return true;
  return host === '::' || host === '::1' || /^fe[89ab][0-9a-f]:/u.test(host) || /^f[cd][0-9a-f]{2}:/u.test(host);
}

function endpoint(appOrigin) {
  if (typeof appOrigin !== 'string') throw new TypeError('identity verification probe origin is required');
  let url;
  try { url = new URL(appOrigin); } catch { throw new TypeError('identity verification probe origin is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== appOrigin || url.username || url.password || url.pathname !== '/' || url.search || url.hash || privateIpLiteral(url.hostname)) {
    throw new TypeError('identity verification probe origin is invalid');
  }
  return `${url.origin}${PATH}`;
}

/** Probe only the deployed runtime's binding health; never read response bodies. */
export async function probeIdentityVerificationRuntime(options) {
  const url = endpoint(options?.appOrigin);
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? 3_000;
  if (typeof fetchImpl !== 'function') throw new TypeError('identity verification probe fetch is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) throw new TypeError('identity verification probe timeout is invalid');
  const controller = new AbortController();
  let timeout;
  try {
    const outcome = await Promise.race([
      Promise.resolve(fetchImpl(url, {
      method: 'HEAD', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { accept: '*/*', 'cache-control': 'no-store' },
      })).then((response) => ({ response }), () => ({ response: null })),
      new Promise((resolve) => { timeout = setTimeout(() => { controller.abort(); resolve({ response: null }); }, timeoutMs); }),
    ]);
    const status = outcome?.response?.status === 204 ? 'valid' : outcome?.response?.status === 503 ? 'invalid' : 'unverifiable';
    return Object.freeze({ status: STATUSES.has(status) ? status : 'unverifiable' });
  } catch {
    return Object.freeze({ status: 'unverifiable' });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
