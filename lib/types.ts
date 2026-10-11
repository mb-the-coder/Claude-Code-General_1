// Shared TypeScript contracts for OmniCompetitor.
// Mirrors /entities/*.jsonc and the backend function inputs/outputs.
// Dependency-free on purpose: the frontend imports this file without pulling in zod.

export type CompanyStatus = 'IDLE' | 'SCRAPING' | 'ANALYZED' | 'ERROR';
export type CompetitorSource = 'AI_DISCOVERED' | 'MANUAL_INPUT';
export type ThreatLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type GapImpact = 'HIGH' | 'MED' | 'LOW';
export type Priority = 'P0' | 'P1' | 'P2';
export type Effort = 'LOW' | 'MED' | 'HIGH';

/** Fields Base44 adds to every stored record. */
export interface EntityMeta {
  id: string;
  created_by_id?: string;
  created_date?: string;
  updated_date?: string;
}

export interface PricingTier {
  tierName: string;
  price?: string;
  billingPeriod?: string;
  featuresSummary?: string;
}

export interface CompanyProfile extends EntityMeta {
  name: string;
  url: string;
  industry?: string;
  description?: string;
  target_audience?: string;
  value_propositions?: string[];
  pricing_tiers?: PricingTier[];
  raw_scraped_summary?: string;
  status: CompanyStatus;
  last_error?: string;
}

export interface Competitor extends EntityMeta {
  company_profile_id: string;
  name: string;
  url: string;
  source: CompetitorSource;
  discovery_rationale?: string;
  threat_level?: ThreatLevel;
  strengths?: string[];
  weaknesses?: string[];
  features?: Record<string, string | boolean>;
  pricing_summary?: string;
  included_in_report?: boolean;
}

export interface SwotMatrix {
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  threats: string[];
}

export interface FeatureMatrixRow {
  featureName: string;
  targetHas: boolean;
  competitors: Record<string, boolean>;
  gapImpact: GapImpact;
}

export interface Recommendation {
  priority: Priority;
  title: string;
  category: string;
  impact: string;
  effort: Effort;
  tacticalSteps: string[];
}

export interface BenchmarkReport extends EntityMeta {
  company_profile_id: string;
  overall_health_score: number;
  market_positioning_score: number;
  pricing_competitiveness_score: number;
  feature_parity_score: number;
  swot: SwotMatrix;
  feature_matrix: FeatureMatrixRow[];
  actionable_recommendations: Recommendation[];
  executive_summary: string;
  last_analyzed_at: string;
}

// ---------------------------------------------------------------------------
// Backend function contracts
// ---------------------------------------------------------------------------

export interface AuditCompanyWebsiteInput {
  url: string;
  name?: string;
  industry?: string;
}

export interface AuditCompanyWebsiteOutput {
  profile: CompanyProfile;
  scrape: {
    finalUrl: string;
    pagesFetched: number;
    warnings: string[];
  };
}

export interface ManualCompetitorInput {
  url: string;
  name?: string;
}

export interface DiscoverAndAnalyzeCompetitorsInput {
  companyProfileId: string;
  /** Plain URLs, per the original spec. */
  manualCompetitorUrls?: string[];
  /** Same as above but with an optional display name (used by the "Add Competitor" modal). */
  manualCompetitors?: ManualCompetitorInput[];
  /** Skip AI discovery and only analyze the manual competitors. */
  skipDiscovery?: boolean;
}

export interface CompetitorFailure {
  name: string;
  url: string;
  reason: string;
}

export interface DiscoverAndAnalyzeCompetitorsOutput {
  competitors: Competitor[];
  failures: CompetitorFailure[];
  counts: { aiDiscovered: number; manual: number; created: number; updated: number };
}

export interface SynthesizeBenchmarkReportInput {
  companyProfileId: string;
}

export interface SynthesizeBenchmarkReportOutput {
  report: BenchmarkReport;
  competitorsUsed: string[];
}

/** Error body returned by every backend function on failure. */
export interface FunctionErrorBody {
  error: string;
  code: string;
  retryable?: boolean;
  profileId?: string;
}

// ---------------------------------------------------------------------------
// Frontend pipeline
// ---------------------------------------------------------------------------

export type PipelineStepId = 'scrape' | 'discover' | 'benchmark' | 'report';
export type PipelineStatus = 'idle' | 'running' | 'error' | 'done';

export interface PipelineState {
  status: PipelineStatus;
  /** Index (0-3) of the step currently running, or the one that failed. */
  stepIndex: number;
  error?: string;
  /** Step that failed, so Retry can resume from it instead of starting over. */
  failedStep?: PipelineStepId;
  profileId?: string;
  /** Non-fatal notes from the scrape (e.g. THIN_CONTENT), shown once the run finishes. */
  warnings?: string[];
}

/**
 * Everything the OmniCompetitor page needs. Two implementations satisfy it:
 * useLiveController (Base44 entities + backend functions) and useDemoController (in-memory sample data).
 */
export interface OmniController {
  profiles: CompanyProfile[];
  profilesLoading: boolean;
  profile?: CompanyProfile;
  competitors: Competitor[];
  competitorsLoading: boolean;
  report?: BenchmarkReport;
  reportLoading: boolean;
  pipeline: PipelineState;
  /** True while any action (pipeline, add / remove / toggle, regenerate) is running. */
  busy: boolean;
  /** True while a report is being (re)generated outside the main pipeline. */
  regenerating: boolean;
  /** Last failed action, as a user-facing message. */
  actionError?: string;
  /** Entities could not be loaded at all. */
  loadError?: string;
  selectProfile(id: string | undefined): void;
  runAudit(input: AuditCompanyWebsiteInput): void;
  retryPipeline(): void;
  resetPipeline(): void;
  addManualCompetitor(input: ManualCompetitorInput): Promise<void>;
  toggleCompetitor(id: string, included: boolean): void;
  removeCompetitor(id: string): void;
  regenerateReport(): void;
}

export const PIPELINE_STEPS: ReadonlyArray<{ id: PipelineStepId; label: string; hint: string }> = [
  { id: 'scrape', label: 'Scraping Domain', hint: 'Reading your site: messaging, pricing, CTAs' },
  { id: 'discover', label: 'Discovering Competitors', hint: 'Finding and profiling real market rivals' },
  { id: 'benchmark', label: 'Benchmarking', hint: 'Scoring positioning, pricing and feature parity' },
  { id: 'report', label: 'Generating Report', hint: 'Assembling your executive dashboard' },
];
