// Resilient website scraper for the Base44 (Deno) backend.
//
//  fetchHtml      - hardened HTTP client: UA spoofing, manual redirects (each hop re-validated),
//                   timeouts, response size cap, one retry on transient failures.
//  parseHtml      - OpenGraph, title, meta description, H1-H3, nav links, CTAs, pricing signals.
//  scrapeSite     - fetch + parse (+ a best-effort pricing page) -> dense text summary for the LLM.
//
// SECURITY: this fetches user-supplied URLs from a server, so every request goes through
// assertPublicHttpUrl() which blocks non-http(s) schemes, credentials in URLs, odd ports,
// internal hostnames and any host that resolves to a private / loopback / link-local / metadata
// address. Known residual risk: DNS can change between our lookup and fetch's own lookup
// (rebinding); the function sandbox should additionally have no access to internal networks.

import { parse, type HTMLElement } from 'node-html-parser';
import { ScrapeError, type ScrapeErrorCode } from './errors';

export { ScrapeError, type ScrapeErrorCode };

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

export type DnsResolver = (host: string, type: 'A' | 'AAAA') => Promise<string[]>;
type FetchImpl = typeof fetch;

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.localdomain'];

function ipv4ToParts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

export function isPrivateIPv4(ip: string): boolean {
  const p = ipv4ToParts(ip);
  if (!p) return true; // unparseable -> treat as unsafe
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast + reserved + broadcast
  );
}

/** Expands an IPv6 literal into 8 numeric hextets, or null if it cannot be parsed. */
function expandIPv6(input: string): number[] | null {
  let ip = input.toLowerCase().split('%')[0]!;
  // Embedded IPv4 tail (::ffff:1.2.3.4) -> two hextets
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (tail) {
    const v4 = ipv4ToParts(tail[1]!);
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    ip = ip.slice(0, tail.index) + `${hi}:${lo}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && head.length !== 8) || missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...rest] : head;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.length === 8 && out.every((n) => !Number.isNaN(n)) ? out : null;
}

export function isPrivateIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const allZeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUntil(7) && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  if (allZeroUntil(5) && g5 === 0xffff) return isPrivateIPv4(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`); // v4-mapped
  if (g0 === 0x64 && g1 === 0xff9b) return true; // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && (g1 === 0x0db8 || g1 === 0)) return true; // documentation + Teredo
  if (g0 === 0x2002) return true; // 6to4
  void g2; void g3; void g4;
  return false;
}

export function isPrivateIp(ip: string): boolean {
  return ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

const getDeno = () => (globalThis as unknown as { Deno?: typeof Deno }).Deno;

async function dohResolve(host: string, type: 'A' | 'AAAA', fetchImpl: FetchImpl): Promise<string[]> {
  const wanted = type === 'A' ? 1 : 28;
  const endpoints = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
    `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=${type}`,
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await fetchImpl(endpoint, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
      const answers = (body.Answer ?? []).filter((a) => a.type === wanted).map((a) => a.data);
      if (answers.length) return answers;
    } catch {
      // try next endpoint
    }
  }
  return [];
}

/** Default resolver: Deno's native DNS when available, otherwise DNS-over-HTTPS. */
export function createDefaultResolver(fetchImpl: FetchImpl = fetch): DnsResolver {
  return async (host, type) => {
    const deno = getDeno();
    if (deno?.resolveDns) {
      try {
        const answers = await deno.resolveDns(host, type);
        if (answers.length) return answers;
      } catch {
        // NXDOMAIN / unsupported on this runtime -> fall through to DoH
      }
    }
    return dohResolve(host, type, fetchImpl);
  };
}

/**
 * Throws ScrapeError unless `rawUrl` is a public http(s) URL. Returns the parsed URL.
 * DNS is resolved here so every address behind the host can be checked.
 */
export async function assertPublicHttpUrl(rawUrl: string, resolver: DnsResolver = createDefaultResolver()): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ScrapeError('That URL is not valid.', 'INVALID_URL', false);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ScrapeError('Only http and https URLs can be audited.', 'INVALID_URL', false);
  }
  if (url.username || url.password) {
    throw new ScrapeError('URLs containing credentials are not allowed.', 'INVALID_URL', false);
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new ScrapeError('That port is not allowed.', 'BLOCKED_HOST', false);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked = () => new ScrapeError('That address is not a public website and cannot be audited.', 'BLOCKED_HOST', false);

  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) throw blocked();

  const isIpLiteral = host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (isIpLiteral) {
    if (isPrivateIp(host)) throw blocked();
    return url;
  }

  const [v4, v6] = await Promise.all([
    resolver(host, 'A').catch(() => [] as string[]),
    resolver(host, 'AAAA').catch(() => [] as string[]),
  ]);
  const addresses = [...v4, ...v6];
  if (addresses.length === 0) {
    throw new ScrapeError(`Could not resolve "${host}". Check the domain and try again.`, 'DNS_FAILURE', false);
  }
  if (addresses.some(isPrivateIp)) throw blocked();
  return url;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface FetchHtmlOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  retries?: number;
  fetchImpl?: FetchImpl;
  resolver?: DnsResolver;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchedHtml {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  html: string;
  truncated: boolean;
  redirects: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(await res.arrayBuffer()).slice(0, maxBytes), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.slice(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, truncated };
}

export async function fetchHtml(rawUrl: string, options: FetchHtmlOptions = {}): Promise<FetchedHtml> {
  const {
    timeoutMs = 10_000,
    maxBytes = 1_500_000,
    maxRedirects = 5,
    retries = 1,
    fetchImpl = fetch,
    sleep = defaultSleep,
  } = options;
  const resolver = options.resolver ?? createDefaultResolver(fetchImpl);

  let lastError: ScrapeError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchOnce(rawUrl, { timeoutMs, maxBytes, maxRedirects, fetchImpl, resolver });
    } catch (err) {
      if (!(err instanceof ScrapeError)) throw err;
      lastError = err;
      if (!err.retryable || attempt === retries) break;
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastError!;
}

async function fetchOnce(
  rawUrl: string,
  o: { timeoutMs: number; maxBytes: number; maxRedirects: number; fetchImpl: FetchImpl; resolver: DnsResolver },
): Promise<FetchedHtml> {
  let current = rawUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs);
  try {
    for (let hop = 0; hop <= o.maxRedirects; hop++) {
      await assertPublicHttpUrl(current, o.resolver); // re-validate EVERY hop

      let res: Response;
      try {
        res = await o.fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': BROWSER_USER_AGENT,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'no-cache',
          },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new ScrapeError(`The site took longer than ${Math.round(o.timeoutMs / 1000)}s to respond.`, 'TIMEOUT', true);
        }
        throw new ScrapeError(`Could not connect to the site (${(err as Error).message || 'network error'}).`, 'NETWORK', true);
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new ScrapeError(`The site redirected (HTTP ${res.status}) without a destination.`, 'HTTP_ERROR', false, res.status);
        current = new URL(location, current).toString();
        continue;
      }

      if (res.status === 401 || res.status === 403 || res.status === 429 || res.status === 451) {
        await res.body?.cancel().catch(() => undefined);
        throw new ScrapeError(
          `The site blocked automated access (HTTP ${res.status}). Try a different page or add the competitor manually.`,
          'BLOCKED_BY_SITE',
          res.status === 429,
          res.status,
        );
      }
      if (res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        throw new ScrapeError(`The site returned a server error (HTTP ${res.status}).`, 'HTTP_ERROR', true, res.status);
      }
      if (res.status >= 400) {
        await res.body?.cancel().catch(() => undefined);
        throw new ScrapeError(`The page could not be loaded (HTTP ${res.status}).`, 'HTTP_ERROR', false, res.status);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
        await res.body?.cancel().catch(() => undefined);
        throw new ScrapeError('That URL does not return a web page (HTML).', 'NOT_HTML', false, res.status);
      }

      let body: { bytes: Uint8Array; truncated: boolean };
      try {
        body = await readCapped(res, o.maxBytes);
      } catch {
        throw new ScrapeError(`The site took longer than ${Math.round(o.timeoutMs / 1000)}s to send the page.`, 'TIMEOUT', true);
      }
      return {
        requestedUrl: rawUrl,
        finalUrl: current,
        status: res.status,
        html: decodeBody(body.bytes, contentType),
        truncated: body.truncated,
        redirects: hop,
      };
    }
    throw new ScrapeError('The site redirected too many times.', 'TOO_MANY_REDIRECTS', false);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HTML parsing + sanitizing
// ---------------------------------------------------------------------------

export interface ScrapedPage {
  finalUrl: string;
  status: number;
  title: string;
  metaDescription: string;
  canonical: string;
  lang: string;
  openGraph: Record<string, string>;
  structuredData: string[];
  headings: { h1: string[]; h2: string[]; h3: string[] };
  navLinks: Array<{ text: string; href: string }>;
  ctas: Array<{ text: string; href: string }>;
  pricingSignals: string[];
  bodyText: string;
}

const ZERO_WIDTH_AND_CONTROL = /[​-‍⁠﻿\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanText(input: string): string {
  return input.replace(/ /g, ' ').replace(ZERO_WIDTH_AND_CONTROL, '').replace(/[ \t\r\f\v]+/g, ' ').trim();
}

const oneLine = (input: string) => cleanText(input).replace(/\s*\n\s*/g, ' ');

const JUNK_LINE =
  /(gtag\(|dataLayer|fbq\(|_gaq|googletagmanager|window\.|document\.|function\s*\(|=>\s*\{|\bvar\s+\w+\s*=|\{\s*"[\w@]+"\s*:|webpack|__NEXT_DATA__|base64,)/;

function looksLikeJunk(line: string): boolean {
  if (line.length < 3) return true;
  if (/^<[!?\/]?[a-z]/i.test(line)) return true; // stray doctype / tag fragments
  if (!/[\p{L}\p{N}]/u.test(line)) return true;
  if (line.length > 200 && !/\s/.test(line.slice(0, 200))) return true; // minified blob / token
  if (JUNK_LINE.test(line)) return true;
  return false;
}

const NOISE_SELECTORS = 'script,style,noscript,svg,iframe,canvas,template,object,embed,link,meta,head,picture source,[hidden],[style*="display:none"],[style*="display: none"]';
const COOKIE_NOISE = /(cookie|consent|gdpr|onetrust|cc-window|cc-banner|trustarc)/i;

const PRICE_RE = /(?:[$€£¥₹]|\b(?:USD|EUR|GBP|CAD|AUD)\b)\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:\/|per|a)\s?(?:mo(?:nth)?|yr|year|user|seat|member|editor|agent))?/i;
const CTA_RE = /\b(get started|start (?:free|now|trial|building|today|your)|try(?: it)?(?: for)?(?: free| now)?|sign ?up|book (?:a )?(?:demo|call|meeting)|request (?:a )?demo|schedule (?:a )?demo|get (?:a )?(?:demo|quote)|contact(?: sales| us)?|talk to (?:sales|us)|buy(?: now)?|download|subscribe|join(?: now| the waitlist)?|see (?:pricing|plans)|view pricing|free trial)\b/i;
const PRICING_CONTAINER = '[class*="pricing" i],[id*="pricing" i],[class*="price-" i],[class*="plan" i],[class*="tier" i],[data-testid*="pricing" i]';

function absolute(base: string, href: string | undefined): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(h)) return null;
  try {
    return new URL(h, base).toString();
  } catch {
    return null;
  }
}

/** Short link label: path for same-site links, "host/path" for external ones. */
function pathOf(url: string, base: string): string {
  try {
    const u = new URL(url);
    const same = u.hostname.replace(/^www\./, '') === new URL(base).hostname.replace(/^www\./, '');
    const path = `${u.pathname}${u.search}`;
    return (same ? path : `${u.hostname}${path === '/' ? '' : path}`).slice(0, 80) || '/';
  } catch {
    return url.slice(0, 80);
  }
}

const unique = (items: string[], cap: number) => [...new Set(items.filter(Boolean))].slice(0, cap);

function collectHeadings(root: HTMLElement, tag: string, cap: number): string[] {
  return unique(
    root
      .querySelectorAll(tag)
      .map((el) => oneLine(el.text))
      .filter((t) => t.length >= 2 && t.length <= 200),
    cap,
  );
}

function summarizeJsonLd(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll('script[type="application/ld+json"]').slice(0, 6)) {
    try {
      const data = JSON.parse(el.text) as unknown;
      const nodes = Array.isArray(data) ? data : [data];
      for (const raw of nodes.flatMap((n) => (n && typeof n === 'object' && '@graph' in n ? (n as { '@graph': unknown[] })['@graph'] : [n]))) {
        if (!raw || typeof raw !== 'object') continue;
        const node = raw as Record<string, unknown>;
        const type = Array.isArray(node['@type']) ? node['@type'].join('/') : String(node['@type'] ?? '');
        if (!/organization|product|software|service|offer|website/i.test(type)) continue;
        const parts = [type, node.name, node.description].filter((v) => typeof v === 'string' && v).map((v) => oneLine(String(v)).slice(0, 220));
        const offers = node.offers as { price?: unknown; priceCurrency?: unknown } | undefined;
        if (offers && typeof offers === 'object' && offers.price !== undefined) parts.push(`offer ${offers.priceCurrency ?? ''}${offers.price}`);
        if (parts.length > 1) out.push(parts.join(' | '));
      }
    } catch {
      // malformed JSON-LD is common; ignore
    }
  }
  return unique(out, 5);
}

function collectPricingSignals(root: HTMLElement): string[] {
  const signals: string[] = [];
  const seen: string[] = [];
  const push = (raw: string) => {
    const text = oneLine(raw).slice(0, 450);
    if (text.length < 8) return;
    if (seen.some((s) => s.includes(text) || text.includes(s))) return;
    seen.push(text);
    signals.push(text);
  };

  for (const el of root.querySelectorAll(PRICING_CONTAINER)) {
    const text = el.structuredText;
    if (text.length >= 20 && text.length <= 900 && (PRICE_RE.test(text) || /\bfree\b|custom|contact sales/i.test(text))) push(text.replace(/\n+/g, ' | '));
    if (signals.length >= 10) return signals;
  }
  for (const table of root.querySelectorAll('table')) {
    const text = table.structuredText;
    if (PRICE_RE.test(text)) push(text.replace(/\n+/g, ' | '));
    if (signals.length >= 10) return signals;
  }
  // Last resort for sites with no recognizable pricing container: any short element showing a price.
  if (!signals.some((s) => PRICE_RE.test(s))) {
    for (const el of root.querySelectorAll('li,p,td,div,span,h2,h3,h4')) {
      const text = el.structuredText;
      if (text.length <= 160 && PRICE_RE.test(text)) push(text.replace(/\n+/g, ' | '));
      if (signals.length >= 8) break;
    }
  }
  return signals;
}

export function parseHtml(html: string, finalUrl: string, status = 200): ScrapedPage {
  const root = parse(html, { comment: false });

  // --- metadata (read before <head> is stripped) ---
  const meta = (selector: string) => cleanText(root.querySelector(selector)?.getAttribute('content') ?? '');
  const openGraph: Record<string, string> = {};
  for (const el of root.querySelectorAll('meta[property^="og:"],meta[name^="og:"],meta[name^="twitter:"]').slice(0, 20)) {
    const key = (el.getAttribute('property') ?? el.getAttribute('name') ?? '').toLowerCase();
    const value = cleanText(el.getAttribute('content') ?? '');
    if (key && value && !(key in openGraph)) openGraph[key] = value.slice(0, 300);
  }
  const title = oneLine(root.querySelector('title')?.text ?? '') || openGraph['og:title'] || '';
  const metaDescription = meta('meta[name="description"]') || openGraph['og:description'] || '';
  const canonical = absolute(finalUrl, root.querySelector('link[rel="canonical"]')?.getAttribute('href')) ?? '';
  const lang = cleanText(root.querySelector('html')?.getAttribute('lang') ?? '').slice(0, 12);
  const structuredData = summarizeJsonLd(root);

  // --- strip noise ---
  root.querySelectorAll(NOISE_SELECTORS).forEach((el) => el.remove());
  root.querySelectorAll('[id],[class]').forEach((el) => {
    const marker = `${el.getAttribute('id') ?? ''} ${el.getAttribute('class') ?? ''}`;
    if (COOKIE_NOISE.test(marker) && el.text.length < 1500) el.remove();
  });

  // --- structure ---
  const headings = {
    h1: collectHeadings(root, 'h1', 5),
    h2: collectHeadings(root, 'h2', 20),
    h3: collectHeadings(root, 'h3', 25),
  };

  const navSeen = new Set<string>();
  const navLinks: Array<{ text: string; href: string }> = [];
  for (const a of root.querySelectorAll('nav a, header a')) {
    const text = oneLine(a.text);
    const href = absolute(finalUrl, a.getAttribute('href'));
    if (!href || text.length < 2 || text.length > 40 || navSeen.has(text.toLowerCase())) continue;
    navSeen.add(text.toLowerCase());
    navLinks.push({ text, href: pathOf(href, finalUrl) });
    if (navLinks.length >= 25) break;
  }

  const ctaSeen = new Set<string>();
  const ctas: Array<{ text: string; href: string }> = [];
  for (const el of root.querySelectorAll('a, button')) {
    const text = oneLine(el.text);
    if (text.length < 3 || text.length > 40) continue;
    const cls = el.getAttribute('class') ?? '';
    if (!CTA_RE.test(text) && !/\b(cta|btn-primary|button-primary)\b/i.test(cls)) continue;
    if (ctaSeen.has(text.toLowerCase())) continue;
    ctaSeen.add(text.toLowerCase());
    const href = absolute(finalUrl, el.getAttribute('href'));
    ctas.push({ text, href: href ? pathOf(href, finalUrl) : '' });
    if (ctas.length >= 12) break;
  }

  const pricingSignals = collectPricingSignals(root);

  // --- body text (nav/footer already captured separately) ---
  root.querySelectorAll('nav,footer').forEach((el) => el.remove());
  const seenLines = new Set<string>();
  const lines: string[] = [];
  for (const raw of root.structuredText.split('\n')) {
    const line = cleanText(raw);
    if (looksLikeJunk(line) || seenLines.has(line)) continue;
    seenLines.add(line);
    lines.push(line);
  }

  return {
    finalUrl,
    status,
    title: title.slice(0, 300),
    metaDescription: metaDescription.slice(0, 500),
    canonical,
    lang,
    openGraph,
    structuredData,
    headings,
    navLinks,
    ctas,
    pricingSignals,
    bodyText: lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Summary builder + site-level scrape
// ---------------------------------------------------------------------------

function truncateOnLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf('\n');
  return `${lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut}\n[…truncated]`;
}

export function buildScrapeSummary(pages: ScrapedPage[], maxChars = 14_000): string {
  const [main, ...extra] = pages;
  if (!main) return '';
  const sections: string[] = [];
  const head = (label: string, value: string) => (value ? `${label}: ${value}` : '');

  sections.push(
    [
      `SOURCE: ${main.finalUrl} (HTTP ${main.status})`,
      head('TITLE', main.title),
      head('META DESCRIPTION', main.metaDescription),
      head('LANGUAGE', main.lang),
      Object.keys(main.openGraph).length
        ? `OPEN GRAPH: ${Object.entries(main.openGraph).map(([k, v]) => `${k}=${v}`).slice(0, 8).join('; ')}`
        : '',
      main.structuredData.length ? `STRUCTURED DATA:\n${main.structuredData.map((s) => `- ${s}`).join('\n')}` : '',
      head('H1', main.headings.h1.join(' | ')),
      head('H2', main.headings.h2.join(' | ')),
      head('H3', main.headings.h3.join(' | ')),
      main.navLinks.length ? `NAVIGATION: ${main.navLinks.map((l) => `${l.text} (${l.href})`).join(', ')}` : '',
      main.ctas.length ? `CALLS TO ACTION: ${main.ctas.map((c) => (c.href ? `${c.text} (${c.href})` : c.text)).join(', ')}` : '',
      main.pricingSignals.length ? `PRICING SIGNALS:\n${main.pricingSignals.map((s) => `- ${s}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  for (const page of extra) {
    sections.push(
      [
        `ADDITIONAL PAGE: ${page.finalUrl}`,
        head('TITLE', page.title),
        head('H1', page.headings.h1.join(' | ')),
        head('H2', page.headings.h2.join(' | ')),
        page.pricingSignals.length ? `PRICING SIGNALS:\n${page.pricingSignals.map((s) => `- ${s}`).join('\n')}` : '',
        page.bodyText ? `PAGE TEXT:\n${truncateOnLine(page.bodyText, 2_500)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  const structured = sections.join('\n\n');
  const budget = Math.max(1_500, maxChars - structured.length - 20);
  const body = main.bodyText ? `\n\nBODY TEXT:\n${truncateOnLine(main.bodyText, budget)}` : '';
  return truncateOnLine(`${structured}${body}`, maxChars);
}

export interface SiteScrape {
  page: ScrapedPage;
  extraPages: ScrapedPage[];
  summary: string;
  warnings: string[];
  pagesFetched: number;
}

export interface ScrapeSiteOptions extends FetchHtmlOptions {
  maxSummaryChars?: number;
  /** If the landing page shows no pricing, try the pricing page it links to (or /pricing). Default true. */
  includePricingPage?: boolean;
}

function pricingPageCandidate(page: ScrapedPage): string | null {
  const link = page.navLinks.find((l) => /pric|plans?\b/i.test(l.text) || /pric/i.test(l.href));
  const path = link?.href ?? '/pricing';
  try {
    const base = new URL(page.finalUrl);
    const target = new URL(path, base);
    if (target.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return null;
    if (target.pathname === base.pathname && target.search === base.search) return null;
    return target.toString();
  } catch {
    return null;
  }
}

export async function scrapeSite(rawUrl: string, options: ScrapeSiteOptions = {}): Promise<SiteScrape> {
  const { maxSummaryChars = 14_000, includePricingPage = true, ...fetchOptions } = options;
  const warnings: string[] = [];

  const fetched = await fetchHtml(rawUrl, fetchOptions);
  const page = parseHtml(fetched.html, fetched.finalUrl, fetched.status);
  if (fetched.truncated) warnings.push('PAGE_TRUNCATED');

  const readable = page.bodyText.length + page.headings.h1.join('').length;
  if (!page.title && readable < 40) {
    throw new ScrapeError(
      'The page returned no readable content. It may be rendered with JavaScript or block automated visitors.',
      'EMPTY_CONTENT',
      false,
    );
  }
  if (page.bodyText.length < 400 && page.headings.h2.length === 0) warnings.push('THIN_CONTENT');

  const extraPages: ScrapedPage[] = [];
  if (includePricingPage && page.pricingSignals.length === 0) {
    const candidate = pricingPageCandidate(page);
    if (candidate) {
      try {
        const pricing = await fetchHtml(candidate, { ...fetchOptions, timeoutMs: Math.min(fetchOptions.timeoutMs ?? 10_000, 7_000), retries: 0 });
        const pricingPage = parseHtml(pricing.html, pricing.finalUrl, pricing.status);
        if (pricingPage.pricingSignals.length > 0 || pricingPage.bodyText.length > 200) extraPages.push(pricingPage);
      } catch {
        // pricing page is best-effort
      }
    }
    if (!extraPages.some((p) => p.pricingSignals.length > 0)) warnings.push('NO_PUBLIC_PRICING_FOUND');
  }

  return {
    page,
    extraPages,
    summary: buildScrapeSummary([page, ...extraPages], maxSummaryChars),
    warnings,
    pagesFetched: 1 + extraPages.length,
  };
}
