import { describe, expect, it } from 'vitest';
import { hostKey, isValidWebsiteUrl, nameFromUrl, normalizeUrl } from '../lib/url';

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
