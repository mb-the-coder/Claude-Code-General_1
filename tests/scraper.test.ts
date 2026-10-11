import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ScrapeError,
  assertPublicHttpUrl,
  buildScrapeSummary,
  fetchHtml,
  isPrivateIp,
  parseHtml,
  scrapeSite,
  type DnsResolver,
} from '../backend/utils/scraper';

const LANDING = readFileSync(new URL('./fixtures/landing.html', import.meta.url), 'utf8');

const publicResolver: DnsResolver = async (_host, type) => (type === 'A' ? ['93.184.216.34'] : []);
const noSleep = async () => undefined;
const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('isPrivateIp', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', 'ff02::1', '2001:db8::1', '64:ff9b::808:808',
  ])('blocks %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s',
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
});

describe('assertPublicHttpUrl', () => {
  it('accepts a public host', async () => {
    await expect(assertPublicHttpUrl('https://example.com/path', publicResolver)).resolves.toBeInstanceOf(URL);
  });

  it.each([
    ['file:///etc/passwd', 'INVALID_URL'],
    ['ftp://example.com', 'INVALID_URL'],
    ['https://user:pw@example.com', 'INVALID_URL'],
    ['https://example.com:22/', 'BLOCKED_HOST'],
    ['http://localhost/', 'BLOCKED_HOST'],
    ['http://api.localhost/', 'BLOCKED_HOST'],
    ['https://db.internal/', 'BLOCKED_HOST'],
    ['http://127.0.0.1/', 'BLOCKED_HOST'],
    ['http://169.254.169.254/latest/meta-data/', 'BLOCKED_HOST'],
    ['http://[::1]/', 'BLOCKED_HOST'],
    ['http://2130706433/', 'BLOCKED_HOST'], // decimal form of 127.0.0.1
    ['http://0x7f.1/', 'BLOCKED_HOST'],
    ['not a url', 'INVALID_URL'],
  ])('rejects %s', async (url, code) => {
    await expect(assertPublicHttpUrl(url, publicResolver)).rejects.toMatchObject({ code });
  });

  it('rejects a public-looking name that resolves to a private address', async () => {
    const evil: DnsResolver = async (_h, type) => (type === 'A' ? ['10.0.0.5'] : []);
    await expect(assertPublicHttpUrl('https://innocent.example.com', evil)).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
  });

  it('rejects when ANY resolved address is private (mixed A/AAAA)', async () => {
    const mixed: DnsResolver = async (_h, type) => (type === 'A' ? ['93.184.216.34'] : ['::1']);
    await expect(assertPublicHttpUrl('https://mixed.example.com', mixed)).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
  });

  it('reports unresolvable hosts', async () => {
    await expect(assertPublicHttpUrl('https://nope.example.com', async () => [])).rejects.toMatchObject({ code: 'DNS_FAILURE' });
  });
});

describe('fetchHtml', () => {
  it('sends a browser user-agent and returns the body', async () => {
    const fetchImpl = vi.fn(async () => html('<html><title>Hi</title></html>')) as unknown as typeof fetch;
    const out = await fetchHtml('https://example.com/', { fetchImpl, resolver: publicResolver });
    expect(out.status).toBe(200);
    expect(out.html).toContain('<title>Hi</title>');
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['user-agent']).toMatch(/Mozilla\/5\.0/);
    expect(init.redirect).toBe('manual');
  });

  it('follows redirects and re-validates every hop (redirect to cloud metadata is blocked)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://example.com/') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      return html('SECRET');
    }) as unknown as typeof fetch;
    await expect(fetchHtml('https://example.com/', { fetchImpl, resolver: publicResolver })).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows a safe redirect chain with relative locations', async () => {
    const fetchImpl = (async (url: string) => {
      if (url === 'http://example.com/') return new Response(null, { status: 301, headers: { location: 'https://www.example.com/home' } });
      if (url === 'https://www.example.com/home') return new Response(null, { status: 302, headers: { location: '/landing' } });
      return html('<title>Landed</title>');
    }) as unknown as typeof fetch;
    const out = await fetchHtml('http://example.com/', { fetchImpl, resolver: publicResolver });
    expect(out.finalUrl).toBe('https://www.example.com/landing');
    expect(out.redirects).toBe(2);
  });

  it('gives up on redirect loops', async () => {
    const fetchImpl = (async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } })) as unknown as typeof fetch;
    await expect(fetchHtml('https://example.com/', { fetchImpl, resolver: publicResolver })).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
  });

  it('retries transient 503s once, then succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => (++calls === 1 ? new Response('down', { status: 503 }) : html('<title>OK</title>'))) as unknown as typeof fetch;
    const out = await fetchHtml('https://example.com/', { fetchImpl, resolver: publicResolver, sleep: noSleep });
    expect(calls).toBe(2);
    expect(out.html).toContain('OK');
  });

  it('does not retry bot blocking (403) and explains it', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response('no', { status: 403 }); }) as unknown as typeof fetch;
    await expect(fetchHtml('https://example.com/', { fetchImpl, resolver: publicResolver, sleep: noSleep })).rejects.toMatchObject({
      code: 'BLOCKED_BY_SITE',
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  it('rejects non-HTML responses', async () => {
    const fetchImpl = (async () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch;
    await expect(fetchHtml('https://example.com/a.pdf', { fetchImpl, resolver: publicResolver })).rejects.toMatchObject({ code: 'NOT_HTML' });
  });

  it('times out hanging servers', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    await expect(
      fetchHtml('https://example.com/', { fetchImpl, resolver: publicResolver, timeoutMs: 30, retries: 0 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('caps the response size', async () => {
    const big = 'x'.repeat(50_000);
    const fetchImpl = (async () => html(big)) as unknown as typeof fetch;
    const out = await fetchHtml('https://example.com/', { fetchImpl, resolver: publicResolver, maxBytes: 1_000 });
    expect(out.html.length).toBe(1_000);
    expect(out.truncated).toBe(true);
  });
});

describe('parseHtml', () => {
  const page = parseHtml(LANDING, 'https://www.acmeflow.com/');

  it('extracts metadata and OpenGraph tags', () => {
    expect(page.title).toBe('Acme Flow | Workflow automation for ops teams');
    expect(page.metaDescription).toMatch(/automates approvals/);
    expect(page.openGraph['og:site_name']).toBe('Acme Flow');
    expect(page.canonical).toBe('https://www.acmeflow.com/');
    expect(page.lang).toBe('en');
    expect(page.structuredData.join(' ')).toMatch(/SoftwareApplication/);
  });

  it('extracts headings, navigation and CTAs', () => {
    expect(page.headings.h1).toEqual(['Stop chasing approvals. Automate them.']);
    expect(page.headings.h2).toContain('Why ops teams choose Acme Flow');
    expect(page.headings.h3).toEqual(expect.arrayContaining(['No-code builder', 'Enterprise security', 'Starter']));
    expect(page.navLinks.map((l) => l.text)).toEqual(expect.arrayContaining(['Product', 'Pricing', 'Customers']));
    expect(page.navLinks.map((l) => l.text)).not.toContain('Ignore me');
    expect(page.ctas.map((c) => c.text)).toEqual(expect.arrayContaining(['Get started free', 'Book a demo', 'Start free trial']));
  });

  it('finds pricing signals', () => {
    const joined = page.pricingSignals.join(' || ');
    expect(joined).toMatch(/\$29 per month/);
    expect(joined).toMatch(/\$99 per month/);
  });

  it('strips scripts, styles, svg, tracking and cookie banners from the body text', () => {
    expect(page.bodyText).toMatch(/routes every request to the right person/);
    expect(page.bodyText).not.toMatch(/dataLayer|gtag|color: red|M0 0L10|tracker\.example/);
    expect(page.bodyText).not.toMatch(/We use cookies/);
    expect(page.bodyText).not.toMatch(/Privacy/); // footer is removed from body text
  });

  it('does not leak doctype fragments into the body text', () => {
    expect(page.bodyText).not.toMatch(/doctype/i);
  });

  it('labels external links with their host and keeps same-site links as paths', () => {
    expect(page.navLinks.find((l) => l.text === 'Blog')?.href).toBe('blog.acmeflow.com');
    expect(page.navLinks.find((l) => l.text === 'Pricing')?.href).toBe('/pricing');
  });

  it('reports each pricing block once, without a second concatenated copy', () => {
    const joined = page.pricingSignals.join('\n');
    expect(joined).toMatch(/\$29 per month/);
    expect(joined).not.toMatch(/Starter\$29/); // no whitespace-less duplicate
    expect(page.pricingSignals.filter((s) => s.includes('$29 per month'))).toHaveLength(1);
  });

  it('handles empty and garbage input without throwing', () => {
    expect(() => parseHtml('', 'https://x.com')).not.toThrow();
    expect(() => parseHtml('<<<>>><div', 'https://x.com')).not.toThrow();
  });
});

describe('buildScrapeSummary', () => {
  it('is dense, labelled and respects the size budget', () => {
    const page = parseHtml(LANDING, 'https://www.acmeflow.com/');
    const summary = buildScrapeSummary([page], 2_000);
    expect(summary.length).toBeLessThanOrEqual(2_100);
    expect(summary).toMatch(/^SOURCE: https:\/\/www\.acmeflow\.com\/ \(HTTP 200\)/);
    expect(summary).toMatch(/H1: Stop chasing approvals/);
    expect(summary).toMatch(/CALLS TO ACTION:/);
    expect(summary).toMatch(/PRICING SIGNALS:/);
    expect(summary).not.toMatch(/<[a-z]+[^>]*>/); // no raw HTML left
  });
});

describe('scrapeSite', () => {
  it('returns a summary and warns when no pricing exists anywhere', async () => {
    const bare = '<html><head><title>Bare</title></head><body><h1>Hello</h1><h2>World</h2><p>' + 'Some real copy here. '.repeat(30) + '</p></body></html>';
    const fetchImpl = (async (url: string) => (url.endsWith('/pricing') ? new Response('nope', { status: 404 }) : html(bare))) as unknown as typeof fetch;
    const out = await scrapeSite('https://example.com/', { fetchImpl, resolver: publicResolver, sleep: noSleep });
    expect(out.summary).toMatch(/TITLE: Bare/);
    expect(out.warnings).toContain('NO_PUBLIC_PRICING_FOUND');
    expect(out.pagesFetched).toBe(1);
  });

  it('follows the pricing link when the landing page shows no prices', async () => {
    const landing = '<html><head><title>L</title></head><body><nav><a href="/pricing">Pricing</a></nav><h1>Welcome</h1><h2>Why us</h2><p>' + 'Copy. '.repeat(100) + '</p></body></html>';
    const pricing = '<html><head><title>Pricing</title></head><body><div class="pricing"><h3>Pro</h3><p>$49 per month</p></div></body></html>';
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => { seen.push(url); return html(url.endsWith('/pricing') ? pricing : landing); }) as unknown as typeof fetch;
    const out = await scrapeSite('https://example.com/', { fetchImpl, resolver: publicResolver });
    expect(seen).toEqual(['https://example.com/', 'https://example.com/pricing']);
    expect(out.pagesFetched).toBe(2);
    expect(out.summary).toMatch(/ADDITIONAL PAGE: https:\/\/example\.com\/pricing/);
    expect(out.summary).toMatch(/\$49 per month/);
    expect(out.warnings).not.toContain('NO_PUBLIC_PRICING_FOUND');
  });

  it('flags JS-only shells as thin content and fails on truly empty pages', async () => {
    const shell = '<html><head><title>App</title></head><body><div id="root"></div></body></html>';
    const thin = await scrapeSite('https://example.com/', {
      fetchImpl: (async () => html(shell)) as unknown as typeof fetch,
      resolver: publicResolver,
      includePricingPage: false,
    });
    expect(thin.warnings).toContain('THIN_CONTENT');

    await expect(
      scrapeSite('https://example.com/', {
        fetchImpl: (async () => html('<html><body><div id="root"></div></body></html>')) as unknown as typeof fetch,
        resolver: publicResolver,
        includePricingPage: false,
      }),
    ).rejects.toBeInstanceOf(ScrapeError);
  });
});
