// Replaces global fetch with a router for: target websites, DNS-over-HTTPS and the Anthropic API.
import { vi } from 'vitest';

export type ClaudeHandler = (toolName: string, requestBody: any) => unknown | Promise<unknown>;

export interface FakeNetworkOptions {
  /** hostname (without www.) -> page(s). A string is the HTML for "/" . */
  sites?: Record<string, string | Record<string, string | number>>;
  /** Returns the tool input for a forced tool call. Throw / return a Response to simulate API failures. */
  claude?: ClaudeHandler;
  /** hostname -> IP override for DNS (default 93.184.216.34). */
  dns?: Record<string, string>;
}

export interface FakeNetwork {
  requests: Array<{ url: string; host: string; kind: 'site' | 'dns' | 'claude' }>;
  claudeCalls: Array<{ toolName: string; body: any }>;
  siteHits(host: string): number;
}

export function installFakeNetwork(options: FakeNetworkOptions = {}): FakeNetwork {
  const net: FakeNetwork = {
    requests: [],
    claudeCalls: [],
    siteHits: (host) => net.requests.filter((r) => r.kind === 'site' && r.host === host).length,
  };

  const impl = async (input: any, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const host = url.hostname.replace(/^www\./, '');

    if (url.hostname === 'cloudflare-dns.com' || url.hostname === 'dns.google') {
      net.requests.push({ url: url.toString(), host: url.hostname, kind: 'dns' });
      const name = (url.searchParams.get('name') ?? '').replace(/^www\./, '');
      const type = url.searchParams.get('type');
      const ip = options.dns?.[name] ?? '93.184.216.34';
      const answer = type === 'A' ? [{ name, type: 1, data: ip }] : [];
      return new Response(JSON.stringify({ Status: 0, Answer: answer }), { status: 200, headers: { 'content-type': 'application/dns-json' } });
    }

    if (url.hostname === 'api.anthropic.com') {
      net.requests.push({ url: url.toString(), host: url.hostname, kind: 'claude' });
      const body = JSON.parse(String(init?.body ?? '{}'));
      const toolName = body.tool_choice?.name as string;
      net.claudeCalls.push({ toolName, body });
      if (!options.claude) throw new Error('Unexpected Claude call: ' + toolName);
      const result = await options.claude(toolName, body);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: toolName, input: result }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    net.requests.push({ url: url.toString(), host, kind: 'site' });
    const site = options.sites?.[host];
    if (site === undefined) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    const pages = typeof site === 'string' ? { '/': site } : site;
    const page = pages[url.pathname];
    if (page === undefined) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    if (typeof page === 'number') return new Response('blocked', { status: page, headers: { 'content-type': 'text/html' } });
    return new Response(page, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };

  vi.stubGlobal('fetch', vi.fn(impl));
  return net;
}

export const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="${title} description"/></head><body><h1>${title}</h1><h2>What we do</h2><p>${'Real marketing copy about the product. '.repeat(20)}</p>${body}</body></html>`;
