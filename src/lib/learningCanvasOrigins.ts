import { LEARNING_LIMITS, normalizeCanvasBaseUrl } from './learningModel';

const MAX_ALLOWLIST_BYTES = 4_096;
const MAX_ALLOWED_ORIGINS = 16;
const encoder = new TextEncoder();

export class LearningCanvasOriginConfigError extends Error {
  readonly code = 'learning_canvas_origin_config_invalid' as const;
  constructor() {
    super('learning_canvas_origin_config_invalid');
    this.name = 'LearningCanvasOriginConfigError';
  }
}

const invalid = (): never => { throw new LearningCanvasOriginConfigError(); };

function ipv4Octets(hostname: string): readonly number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return null;
  const octets = hostname.split('.').map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) invalid();
  return octets;
}

function publicIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
  );
}

function ipv6Words(hostname: string): readonly number[] | null {
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) return null;
  const raw = hostname.slice(1, -1).toLowerCase();
  if (!/^[0-9a-f:]+$/u.test(raw) || raw.includes(':::')) invalid();
  const halves = raw.split('::');
  if (halves.length > 2) invalid();
  const left = halves[0] === '' ? [] : halves[0]!.split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1]!.split(':');
  if (left.concat(right).some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) invalid();
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) invalid();
  return [...left, ...Array.from({ length: omitted }, () => '0'), ...right].map((word) => Number.parseInt(word, 16));
}

function publicIpv6(words: readonly number[]): boolean {
  if (words.length !== 8) return false;
  const first = words[0] ?? 0;
  const second = words[1] ?? 0;
  if (
    first === 0 || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00 || (first === 0x2001 && second === 0x0db8)
  ) return false;
  return true;
}

function publicHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')
    || lower.endsWith('.internal') || lower.endsWith('.lan') || lower.endsWith('.home')
  ) return false;
  const v4 = ipv4Octets(lower);
  if (v4 !== null) return publicIpv4(v4);
  const v6 = ipv6Words(lower);
  if (v6 !== null) return publicIpv6(v6);
  return lower.includes('.') && lower.length <= 253;
}

export type CanvasAllowedOriginsSource = string | undefined | (() => string | undefined);

function sourceValue(source: CanvasAllowedOriginsSource): string {
  let value: unknown;
  try { value = typeof source === 'function' ? source() : source; } catch { return invalid(); }
  if (
    typeof value !== 'string' || value.length < 1
    || encoder.encode(value).byteLength > MAX_ALLOWLIST_BYTES
  ) invalid();
  return value as string;
}

export function readCanvasAllowedOrigins(source: CanvasAllowedOriginsSource): readonly string[] {
  let value: unknown;
  try { value = JSON.parse(sourceValue(source)); } catch { return invalid(); }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ALLOWED_ORIGINS) invalid();
  const entries = value as unknown[];
  const origins: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    let origin: string;
    try { origin = normalizeCanvasBaseUrl(entry); } catch { return invalid(); }
    if (
      origin.length > LEARNING_LIMITS.urlBytes || !publicHostname(new URL(origin).hostname)
      || seen.has(origin)
    ) invalid();
    seen.add(origin);
    origins.push(origin);
  }
  return Object.freeze(origins);
}

export function requireAllowedCanvasOrigin(
  baseUrl: unknown,
  allowedOrigins: readonly string[],
): string {
  let origin: string;
  try { origin = normalizeCanvasBaseUrl(baseUrl); } catch { return invalid(); }
  if (!Object.isFrozen(allowedOrigins) || !allowedOrigins.includes(origin)) invalid();
  return origin;
}
