// Thin typed layer over the Base44 client: backend function calls + entity access.
// `@/api/base44Client` is the standard client module every Base44 app already has.

import { base44 } from '@/api/base44Client';
import type {
  AuditCompanyWebsiteInput,
  AuditCompanyWebsiteOutput,
  BenchmarkReport,
  CompanyProfile,
  Competitor,
  DiscoverAndAnalyzeCompetitorsInput,
  DiscoverAndAnalyzeCompetitorsOutput,
  FunctionErrorBody,
  SynthesizeBenchmarkReportInput,
  SynthesizeBenchmarkReportOutput,
} from './types';

/** Error thrown by every backend function call, carrying the server's structured details. */
export class FunctionCallError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly retryable?: boolean,
    /** Profile created / touched before the failure, so a retry can reuse it. */
    readonly profileId?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FunctionCallError';
  }
}

interface AxiosLikeError {
  message?: string;
  code?: string;
  response?: { status?: number; data?: Partial<FunctionErrorBody> | string };
  data?: Partial<FunctionErrorBody>;
  status?: number;
}

/** Normalizes whatever the SDK throws (axios error, fetch error, plain Error) into a FunctionCallError. */
export function toFunctionError(err: unknown): FunctionCallError {
  if (err instanceof FunctionCallError) return err;
  const e = (err ?? {}) as AxiosLikeError;
  const status = e.response?.status ?? e.status;
  const raw = e.response?.data ?? e.data;
  const body: Partial<FunctionErrorBody> = raw && typeof raw === 'object' ? raw : {};

  if (typeof body.error === 'string' && body.error) {
    return new FunctionCallError(body.error, body.code, body.retryable, body.profileId, status);
  }
  if (e.code === 'ERR_NETWORK' || e.message === 'Network Error') {
    return new FunctionCallError('Could not reach the server. Check your connection and try again.', 'NETWORK', true);
  }
  if (status === 401 || status === 403) return new FunctionCallError('Your session has expired. Please sign in again.', 'UNAUTHORIZED', false, undefined, status);
  if (status === 429) return new FunctionCallError('Too many requests right now. Please wait a moment and try again.', 'RATE_LIMITED', true, undefined, status);
  if (status === 408 || status === 504) return new FunctionCallError('The analysis took too long. Please try again.', 'TIMEOUT', true, undefined, status);
  return new FunctionCallError(e.message || 'Something went wrong. Please try again.', undefined, true, undefined, status);
}

async function invoke<TOut>(name: string, payload: unknown): Promise<TOut> {
  try {
    const response = (await base44.functions.invoke(name, payload)) as { data?: unknown } | undefined;
    const data = (response && 'data' in response ? response.data : response) as (TOut & Partial<FunctionErrorBody>) | undefined;
    // Defensive: some transports resolve with an error body instead of throwing.
    if (data && typeof data === 'object' && typeof data.error === 'string' && data.error) {
      throw new FunctionCallError(data.error, data.code, data.retryable, data.profileId);
    }
    if (data === undefined || data === null) throw new FunctionCallError('The server returned an empty response.', 'EMPTY_RESPONSE', true);
    return data as TOut;
  } catch (err) {
    throw toFunctionError(err);
  }
}

export const api = {
  audit: (input: AuditCompanyWebsiteInput) => invoke<AuditCompanyWebsiteOutput>('auditCompanyWebsite', input),
  discover: (input: DiscoverAndAnalyzeCompetitorsInput) => invoke<DiscoverAndAnalyzeCompetitorsOutput>('discoverAndAnalyzeCompetitors', input),
  synthesize: (input: SynthesizeBenchmarkReportInput) => invoke<SynthesizeBenchmarkReportOutput>('synthesizeBenchmarkReport', input),
};

// Entity access (owner-only row-level security is enforced by the platform).
export const entityApi = {
  listProfiles: () => base44.entities.CompanyProfile.list('-created_date', 50) as Promise<CompanyProfile[]>,
  listCompetitors: (profileId: string) => base44.entities.Competitor.filter({ company_profile_id: profileId }, '-created_date', 100) as Promise<Competitor[]>,
  setCompetitorIncluded: (id: string, included: boolean) => base44.entities.Competitor.update(id, { included_in_report: included }) as Promise<Competitor>,
  removeCompetitor: (id: string) => base44.entities.Competitor.delete(id) as Promise<unknown>,
  latestReport: async (profileId: string): Promise<BenchmarkReport | null> => {
    const rows = (await base44.entities.BenchmarkReport.filter({ company_profile_id: profileId }, '-last_analyzed_at', 1)) as BenchmarkReport[];
    return rows[0] ?? null;
  },
};

export const queryKeys = {
  profiles: ['omni', 'profiles'] as const,
  competitors: (profileId: string | undefined) => ['omni', 'competitors', profileId] as const,
  report: (profileId: string | undefined) => ['omni', 'report', profileId] as const,
};
