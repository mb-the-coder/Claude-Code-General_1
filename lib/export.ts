// Executive summary export: Markdown download and print-to-PDF.
// Everything that reaches HTML is escaped; the print document contains no scripts.

import type { BenchmarkReport, CompanyProfile, Competitor, Recommendation } from './types';

export interface ExportInput {
  profile: Pick<CompanyProfile, 'name' | 'url' | 'industry'>;
  report: BenchmarkReport;
  competitors?: Pick<Competitor, 'name' | 'url' | 'threat_level' | 'included_in_report'>[];
  /** Keys from roadmapKey() of completed action items. */
  completed?: ReadonlySet<string>;
}

/** Stable identity for a roadmap item (used for the checkbox state). */
export const roadmapKey = (r: Pick<Recommendation, 'priority' | 'title'>, index: number) => `${r.priority}:${index}:${r.title}`;

const PRIORITY_LABEL: Record<Recommendation['priority'], string> = {
  P0: 'P0 · Do now',
  P1: 'P1 · Next',
  P2: 'P2 · Later',
};

export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function safeFilename(name: string, extension: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report';
  return `${base}-competitive-benchmark.${extension}`;
}

const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const grouped = (recs: Recommendation[]) =>
  (['P0', 'P1', 'P2'] as const).map((p) => ({
    priority: p,
    items: recs.map((r, index) => ({ r, index })).filter(({ r }) => r.priority === p),
  }));

export function buildMarkdown({ profile, report, competitors, completed }: ExportInput): string {
  const lines: string[] = [];
  const matrixNames = [...new Set(report.feature_matrix.flatMap((r) => Object.keys(r.competitors)))];
  const done = completed ?? new Set<string>();

  lines.push(`# Competitive Benchmark: ${profile.name}`, '');
  lines.push(`${profile.url}${profile.industry ? ` · ${profile.industry}` : ''}`);
  const date = formatDate(report.last_analyzed_at);
  if (date) lines.push(`Analyzed ${date}`);
  lines.push('');

  lines.push('## Executive Summary', '', report.executive_summary, '');

  lines.push('## Scorecard', '', '| Metric | Score |', '| --- | --- |');
  lines.push(`| Overall health | ${report.overall_health_score}/100 |`);
  lines.push(`| Market positioning | ${report.market_positioning_score}/100 |`);
  lines.push(`| Pricing competitiveness | ${report.pricing_competitiveness_score}/100 |`);
  lines.push(`| Feature parity | ${report.feature_parity_score}/100 |`, '');

  const compared = (competitors ?? []).filter((c) => c.included_in_report !== false);
  if (compared.length > 0) {
    lines.push('## Competitors Compared', '');
    compared.forEach((c) => lines.push(`- ${c.name} (${c.url})${c.threat_level ? ` · threat: ${c.threat_level}` : ''}`));
    lines.push('');
  }

  lines.push('## SWOT', '');
  (
    [
      ['Strengths', report.swot.strengths],
      ['Weaknesses', report.swot.weaknesses],
      ['Opportunities', report.swot.opportunities],
      ['Threats', report.swot.threats],
    ] as const
  ).forEach(([title, items]) => {
    lines.push(`### ${title}`, '');
    items.forEach((i) => lines.push(`- ${i.replace(/\s*\n\s*/g, ' ')}`));
    lines.push('');
  });

  if (report.feature_matrix.length > 0) {
    lines.push('## Feature Gap Matrix', '');
    lines.push(`| Feature | ${mdCell(profile.name)} | ${matrixNames.map(mdCell).join(' | ')} | Gap impact |`);
    lines.push(`| --- | :---: | ${matrixNames.map(() => ':---:').join(' | ')} | :---: |`);
    report.feature_matrix.forEach((row) => {
      const cells = matrixNames.map((n) => (row.competitors[n] ? '✅' : '❌'));
      lines.push(`| ${mdCell(row.featureName)} | ${row.targetHas ? '✅' : '❌'} | ${cells.join(' | ')} | ${row.gapImpact} |`);
    });
    lines.push('');
  }

  lines.push('## Strategic Roadmap', '');
  grouped(report.actionable_recommendations).forEach(({ priority, items }) => {
    if (items.length === 0) return;
    lines.push(`### ${PRIORITY_LABEL[priority]}`, '');
    items.forEach(({ r, index }) => {
      lines.push(`- [${done.has(roadmapKey(r, index)) ? 'x' : ' '}] **${r.title}** (${r.category} · effort: ${r.effort})`);
      lines.push(`  - Impact: ${r.impact.replace(/\s*\n\s*/g, ' ')}`);
      r.tacticalSteps.forEach((s, n) => lines.push(`  ${n + 1}. ${s.replace(/\s*\n\s*/g, ' ')}`));
    });
    lines.push('');
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Self-contained, script-free HTML used for print-to-PDF. */
export function buildPrintHtml({ profile, report, competitors, completed }: ExportInput): string {
  const e = escapeHtml;
  const done = completed ?? new Set<string>();
  const matrixNames = [...new Set(report.feature_matrix.flatMap((r) => Object.keys(r.competitors)))];
  const list = (items: string[]) => `<ul>${items.map((i) => `<li>${e(i)}</li>`).join('')}</ul>`;
  const compared = (competitors ?? []).filter((c) => c.included_in_report !== false);

  const roadmap = grouped(report.actionable_recommendations)
    .filter((g) => g.items.length > 0)
    .map(
      ({ priority, items }) => `<h3>${e(PRIORITY_LABEL[priority])}</h3>${items
        .map(
          ({ r, index }) => `<div class="item"><p class="title">${done.has(roadmapKey(r, index)) ? '&#9745;' : '&#9744;'} <strong>${e(r.title)}</strong> <span class="muted">${e(r.category)} · effort ${e(r.effort)}</span></p><p>${e(r.impact)}</p><ol>${r.tacticalSteps.map((s) => `<li>${e(s)}</li>`).join('')}</ol></div>`,
        )
        .join('')}`,
    )
    .join('');

  const matrix = report.feature_matrix.length
    ? `<h2>Feature Gap Matrix</h2><table><thead><tr><th>Feature</th><th>${e(profile.name)}</th>${matrixNames.map((n) => `<th>${e(n)}</th>`).join('')}<th>Gap impact</th></tr></thead><tbody>${report.feature_matrix
        .map(
          (row) => `<tr><td>${e(row.featureName)}</td><td>${row.targetHas ? 'Yes' : 'No'}</td>${matrixNames.map((n) => `<td>${row.competitors[n] ? 'Yes' : 'No'}</td>`).join('')}<td>${e(row.gapImpact)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${e(profile.name)} - Competitive Benchmark</title><style>
  body{font:13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;margin:32px auto;max-width:860px;padding:0 24px}
  h1{font-size:24px;margin:0 0 4px} h2{font-size:17px;margin:26px 0 8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px} h3{font-size:14px;margin:16px 0 6px}
  .muted{color:#64748b;font-weight:400} .scores{display:flex;gap:12px} .score{flex:1;border:1px solid #e2e8f0;border-radius:10px;padding:10px;text-align:center}
  .score b{display:block;font-size:24px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #e2e8f0;padding:5px 8px;text-align:left;font-size:12px}
  th{background:#f8fafc} .item{page-break-inside:avoid;margin:0 0 10px} .item p{margin:2px 0} ul,ol{margin:4px 0 4px 20px;padding:0}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px} .grid>div{border:1px solid #e2e8f0;border-radius:10px;padding:8px 12px}
  </style></head><body>
  <h1>Competitive Benchmark: ${e(profile.name)}</h1>
  <p class="muted">${e(profile.url)}${profile.industry ? ` · ${e(profile.industry)}` : ''}${formatDate(report.last_analyzed_at) ? ` · Analyzed ${e(formatDate(report.last_analyzed_at))}` : ''}</p>
  <h2>Executive Summary</h2><p>${e(report.executive_summary)}</p>
  <div class="scores">
    <div class="score"><b>${report.overall_health_score}</b>Overall health</div>
    <div class="score"><b>${report.market_positioning_score}</b>Market positioning</div>
    <div class="score"><b>${report.pricing_competitiveness_score}</b>Pricing</div>
    <div class="score"><b>${report.feature_parity_score}</b>Feature parity</div>
  </div>
  ${compared.length ? `<h2>Competitors Compared</h2>${list(compared.map((c) => `${c.name} (${c.url})${c.threat_level ? ` - threat: ${c.threat_level}` : ''}`))}` : ''}
  <h2>SWOT</h2><div class="grid">
    <div><h3>Strengths</h3>${list(report.swot.strengths)}</div><div><h3>Weaknesses</h3>${list(report.swot.weaknesses)}</div>
    <div><h3>Opportunities</h3>${list(report.swot.opportunities)}</div><div><h3>Threats</h3>${list(report.swot.threats)}</div>
  </div>
  ${matrix}
  <h2>Strategic Roadmap</h2>${roadmap}
  </body></html>`;
}

export function downloadTextFile(filename: string, content: string, mime = 'text/markdown;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens the browser print dialog for `html` ("Save as PDF") using a hidden iframe. */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.srcdoc = html;
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) return frame.remove();
    win.focus();
    win.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}
