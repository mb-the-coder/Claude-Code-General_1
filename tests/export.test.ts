import { describe, expect, it } from 'vitest';
import { buildMarkdown, buildPrintHtml, escapeHtml, roadmapKey, safeFilename } from '../lib/export';
import { MOCK_COMPETITORS, MOCK_PROFILE, MOCK_REPORT } from '../lib/mockData';

describe('buildMarkdown', () => {
  const md = buildMarkdown({ profile: MOCK_PROFILE, report: MOCK_REPORT, competitors: MOCK_COMPETITORS });

  it('contains every section in order', () => {
    const order = ['# Competitive Benchmark: Acme Flow', '## Executive Summary', '## Scorecard', '## Competitors Compared', '## SWOT', '## Feature Gap Matrix', '## Strategic Roadmap'];
    let last = -1;
    for (const heading of order) {
      const at = md.indexOf(heading);
      expect(at, heading).toBeGreaterThan(last);
      last = at;
    }
  });

  it('lists only competitors that are included in the report', () => {
    expect(md).toMatch(/- Streamline \(/);
    expect(md).not.toMatch(/- Cascade HQ \(/); // included_in_report: false in the sample data
  });

  it('renders scores, matrix marks and prioritized roadmap items', () => {
    expect(md).toMatch(/\| Feature parity \| 39\/100 \|/);
    expect(md).toMatch(/\| SSO \/ SAML \| ❌ \| ✅ \| ❌ \| ✅ \| HIGH \|/);
    expect(md.indexOf('### P0 · Do now')).toBeLessThan(md.indexOf('### P1 · Next'));
    expect(md).toMatch(/- \[ \] \*\*Ship SSO and audit logs on the Business plan\*\* \(Product · effort: MED\)/);
  });

  it('marks completed roadmap items', () => {
    const done = new Set([roadmapKey(MOCK_REPORT.actionable_recommendations[0]!, 0)]);
    const checked = buildMarkdown({ profile: MOCK_PROFILE, report: MOCK_REPORT, completed: done });
    expect(checked).toMatch(/- \[x\] \*\*Ship SSO and audit logs/);
    expect(checked.match(/- \[x\]/g)).toHaveLength(1);
  });

  it('keeps the table intact when text contains pipes or newlines', () => {
    const report = {
      ...MOCK_REPORT,
      feature_matrix: [{ featureName: 'A | B\nfeature', targetHas: true, competitors: { 'X | Y': true }, gapImpact: 'LOW' as const }],
    };
    const out = buildMarkdown({ profile: MOCK_PROFILE, report });
    const row = out.split('\n').find((l) => l.startsWith('| A'))!;
    expect(row).toBe('| A \\| B feature | ✅ | ✅ | LOW |');
  });
});

describe('buildPrintHtml', () => {
  it('escapes all untrusted text and contains no scripts', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const html = buildPrintHtml({
      profile: { name: evil, url: 'https://x.com', industry: evil },
      report: {
        ...MOCK_REPORT,
        executive_summary: evil,
        swot: { strengths: [evil], weaknesses: [evil], opportunities: [evil], threats: [evil] },
        feature_matrix: [{ featureName: evil, targetHas: true, competitors: { [evil]: true }, gapImpact: 'LOW' }],
        actionable_recommendations: [{ priority: 'P0', title: evil, category: evil, impact: evil, effort: 'LOW', tacticalSteps: [evil] }],
      },
      competitors: [{ name: evil, url: evil, threat_level: 'LOW', included_in_report: true }],
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('includes the key content', () => {
    const html = buildPrintHtml({ profile: MOCK_PROFILE, report: MOCK_REPORT });
    expect(html).toContain('Competitive Benchmark: Acme Flow');
    expect(html).toContain('Strategic Roadmap');
    expect(html).toMatch(/<b>78<\/b>Market positioning/);
  });
});

describe('helpers', () => {
  it('escapeHtml covers the five critical characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
  it('safeFilename produces a filesystem-safe name', () => {
    expect(safeFilename('Acme / Flow: "Inc."', 'md')).toBe('acme-flow-inc-competitive-benchmark.md');
    expect(safeFilename('日本語', 'pdf')).toBe('report-competitive-benchmark.pdf');
  });
});
