import { describe, expect, it } from 'vitest';
import { hostKey, isValidWebsiteUrl, nameFromUrl, normalizeUrl, safeHref } from '../lib/url';

describe('safeHref', () => {
  it('passes http(s) URLs and neutralizes everything else', () => {
    expect(safeHref('https://acme.com/x?y=1')).toBe('https://acme.com/x?y=1');
    expect(safeHref('http://acme.com')).toBe('http://acme.com/');
    expect(safeHref('javascript:alert(1)')).toBe('#');
    expect(safeHref('JaVaScRiPt:alert(1)')).toBe('#');
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBe('#');
    expect(safeHref('//evil.com')).toBe('#');
    expect(safeHref('not a url')).toBe('#');
    expect(safeHref(undefined)).toBe('#');
    expect(safeHref('')).toBe('#');
  });
});

describe('normalizeUrl', () => {
  it('adds https and strips the hash', () => {
    expect(normalizeUrl('acme.com')).toBe('https://acme.com/');
    expect(normalizeUrl(' https://www.acme.com/pricing?x=1#top ')).toBe('https://www.acme.com/pricing?x=1');
  });

  it('rejects other schemes and credentials', () => {
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow();
    expect(() => normalizeUrl('ftp://acme.com')).toThrow(/http/i);
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow();
    expect(() => normalizeUrl('https://user:pw@acme.com')).toThrow(/credentials/i);
  });

  it('rejects empty, oversized and dotless hosts', () => {
    expect(() => normalizeUrl('')).toThrow();
    expect(() => normalizeUrl('a'.repeat(2100))).toThrow(/too long/i);
    expect(() => normalizeUrl('localhost')).toThrow();
  });
});

describe('hostKey / nameFromUrl / isValidWebsiteUrl', () => {
  it('treats www and bare hosts as the same company', () => {
    expect(hostKey('https://www.Acme.com/x')).toBe('acme.com');
    expect(hostKey('acme.com')).toBe('acme.com');
  });

  it('derives a readable name', () => {
    expect(nameFromUrl('https://www.acme-corp.io')).toBe('Acme Corp');
    expect(nameFromUrl('https://linear.app')).toBe('Linear');
  });

  it('validates form input', () => {
    expect(isValidWebsiteUrl('acme.com')).toBe(true);
    expect(isValidWebsiteUrl('not a url')).toBe(false);
  });
});
