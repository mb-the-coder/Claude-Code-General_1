// Zod schemas: (1) validation of backend function inputs, (2) validation of every Claude output.
// The AI-output schemas are also converted to JSON Schema and handed to Claude as tool input
// schemas, so the model is constrained at generation time AND validated again on our side.

import { z } from 'zod';
import { normalizeUrl } from '../url';

// ---------------------------------------------------------------------------
// Enums (single source of truth, reused by prompts and the UI)
// ---------------------------------------------------------------------------

export const THREAT_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const GAP_IMPACTS = ['HIGH', 'MED', 'LOW'] as const;
export const PRIORITIES = ['P0', 'P1', 'P2'] as const;
export const EFFORTS = ['LOW', 'MED', 'HIGH'] as const;
export const RELATIONSHIPS = ['DIRECT', 'INDIRECT'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A trimmed string that is silently clipped to `max` characters instead of failing validation. */
const text = (max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .transform((s) => (s.length > max ? s.slice(0, max) : s));

/** Form fields often arrive as "" — treat that as "not provided". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((s) => (s ? s : undefined));

const websiteUrl = z.string().transform((value, ctx) => {
  try {
    return normalizeUrl(value);
  } catch (err) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
    return z.NEVER;
  }
});

const recordId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid record id');

// ---------------------------------------------------------------------------
// Backend function inputs
// ---------------------------------------------------------------------------

export const AuditInputSchema = z.object({
  url: websiteUrl,
  name: optionalText(200),
  industry: optionalText(120),
});

export const MAX_MANUAL_COMPETITORS = 5;

export const DiscoverInputSchema = z
  .object({
    companyProfileId: recordId,
    manualCompetitorUrls: z.array(websiteUrl).max(MAX_MANUAL_COMPETITORS).optional(),
    manualCompetitors: z
      .array(z.object({ url: websiteUrl, name: optionalText(200) }))
      .max(MAX_MANUAL_COMPETITORS)
      .optional(),
    skipDiscovery: z.boolean().optional().default(false),
  })
  .superRefine((value, ctx) => {
    const manual = (value.manualCompetitorUrls?.length ?? 0) + (value.manualCompetitors?.length ?? 0);
    if (value.skipDiscovery && manual === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'skipDiscovery requires at least one manual competitor.',
        path: ['skipDiscovery'],
      });
    }
  });

export const SynthesizeInputSchema = z.object({
  companyProfileId: recordId,
});

// ---------------------------------------------------------------------------
// Claude output: company profile extraction (auditCompanyWebsite)
// ---------------------------------------------------------------------------

export const CompanyExtractionSchema = z.object({
  industry: text(120).describe('Industry / market category, e.g. "B2B SaaS - Project Management". Empty string if unclear.'),
  description: text(600).describe('What the company does, in one to three plain sentences.'),
  target_audience: text(500).describe('Who the company sells to (roles, company size, segments).'),
  value_propositions: z
    .array(text(200))
    .max(8)
    .describe('Core value propositions exactly as the site frames them, most prominent first.'),
  pricing_tiers: z
    .array(
      z.object({
        tierName: text(80),
        price: text(60).describe('e.g. "$29", "Free", "Custom". Empty string if not shown.'),
        billingPeriod: text(40).describe('e.g. "month", "year", "one-time". Empty string if not shown.'),
        featuresSummary: text(300),
      }),
    )
    .max(8)
    .describe('Pricing tiers found in the evidence. Empty array if pricing is not public.'),
});

// ---------------------------------------------------------------------------
// Claude output: competitor discovery (discoverAndAnalyzeCompetitors, stage 1)
// ---------------------------------------------------------------------------

export const DiscoveredCompetitorSchema = z.object({
  name: text(120),
  url: text(300).describe('Primary marketing website, e.g. "https://www.example.com".'),
  relationship: z.enum(RELATIONSHIPS).describe('DIRECT = same buyer, same problem. INDIRECT = adjacent or substitute.'),
  threat_level: z.enum(THREAT_LEVELS),
  positioning_rationale: text(500).describe('Why this company competes for the same customers and how it positions itself.'),
});

export const DiscoveredCompetitorsSchema = z.object({
  competitors: z.array(DiscoveredCompetitorSchema).min(3).max(5),
});

// ---------------------------------------------------------------------------
// Claude output: single competitor analysis (discoverAndAnalyzeCompetitors, stage 2)
// ---------------------------------------------------------------------------

export const CompetitorAnalysisSchema = z.object({
  name: text(120).describe('Official company/product name.'),
  threat_level: z.enum(THREAT_LEVELS),
  features: z
    .record(z.string(), z.union([text(200), z.boolean()]))
    .describe('Core capabilities: short feature name -> one-line description of how it is offered (or true/false). 6-15 entries.'),
  pricing_summary: text(400).describe('Pricing model and price points in one or two sentences. "Not public" if unknown.'),
  strengths: z.array(text(200)).min(1).max(6),
  weaknesses: z.array(text(200)).min(1).max(6),
});

// ---------------------------------------------------------------------------
// Claude output: benchmark report (synthesizeBenchmarkReport)
// ---------------------------------------------------------------------------

export const BenchmarkReportSchema = z.object({
  scores: z.object({
    overall_health: z.number().min(0).max(100),
    market_positioning: z.number().min(0).max(100),
    pricing_competitiveness: z.number().min(0).max(100),
    feature_parity: z.number().min(0).max(100),
  }),
  executive_summary: z.string().min(1),
  swot: z.object({
    strengths: z.array(z.string()).min(1).max(8),
    weaknesses: z.array(z.string()).min(1).max(8),
    opportunities: z.array(z.string()).min(1).max(8),
    threats: z.array(z.string()).min(1).max(8),
  }),
  feature_matrix: z
    .array(
      z.object({
        featureName: z.string(),
        targetHas: z.boolean(),
        competitors: z.record(z.string(), z.boolean()),
        gapImpact: z.enum(GAP_IMPACTS),
      }),
    )
    .min(1)
    .max(25),
  recommendations: z
    .array(
      z.object({
        priority: z.enum(PRIORITIES),
        category: z.string(),
        title: z.string(),
        impact: z.string(),
        effort: z.enum(EFFORTS),
        tacticalSteps: z.array(z.string()).min(1).max(8),
      }),
    )
    .min(1)
    .max(12),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type AuditInput = z.infer<typeof AuditInputSchema>;
export type DiscoverInput = z.infer<typeof DiscoverInputSchema>;
export type SynthesizeInput = z.infer<typeof SynthesizeInputSchema>;
export type CompanyExtraction = z.infer<typeof CompanyExtractionSchema>;
export type DiscoveredCompetitors = z.infer<typeof DiscoveredCompetitorsSchema>;
export type CompetitorAnalysis = z.infer<typeof CompetitorAnalysisSchema>;
export type BenchmarkReportOutput = z.infer<typeof BenchmarkReportSchema>;
