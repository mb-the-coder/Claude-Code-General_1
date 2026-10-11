// URL helpers shared by the backend (input validation, upsert keys) and the frontend (form validation).

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Turns user input ("acme.com", "https://www.acme.com/pricing?x=1#top") into a clean http(s) URL.
 * Throws an Error with a user-presentable message when the input cannot be used.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('Enter a website URL.');
  if (trimmed.length > 2048) throw new Error('That URL is too long.');

  // "javascript:alert(1)" and friends have no "//": reject anything that names another scheme.
  const withScheme = SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('That does not look like a valid website URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.');
  }
  if (url.username || url.password) {
    throw new Error('URLs containing credentials are not allowed.');
  }
  const host = url.hostname;
  const isIpv6 = host.startsWith('[');
  if (!isIpv6 && !host.includes('.')) {
    throw new Error('Enter a full domain such as acme.com.');
  }
  url.hash = '';
  return url.toString();
}

/** True when `normalizeUrl` would accept the input. */
export function isValidWebsiteUrl(raw: string): boolean {
  try {
    normalizeUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safe value for an <a href>: returns the URL only if it is http(s), otherwise "#".
 * Entity rows can be written directly through the SDK, so never trust a stored URL to be a web address.
 */
export function safeHref(raw: string | undefined | null): string {
  if (!raw) return '#';
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : '#';
  } catch {
    return '#';
  }
}

/** Lowercased hostname without a leading "www." — the identity of a company for dedupe/upsert. */
export function hostKey(rawUrl: string): string {
  try {
    const host = new URL(SCHEME_RE.test(rawUrl) ? rawUrl : `https://${rawUrl}`).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

/** Best-effort display name from a URL: "https://www.acme-corp.io" -> "Acme Corp". */
export function nameFromUrl(rawUrl: string): string {
  const key = hostKey(rawUrl);
  const parts = key.split('.');
  const label = parts.length > 1 ? parts[parts.length - 2]! : parts[0]!;
  const words = label.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return key;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
