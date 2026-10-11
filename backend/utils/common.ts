// Shared plumbing for all Base44 backend functions: auth, body parsing, error mapping,
// ownership checks, status bookkeeping and a tiny concurrency pool.

import { createClientFromRequest, type Base44Client } from 'npm:@base44/sdk@0.8.40';
import { z } from 'zod';
import { ClaudeError } from './claudeClient';
import { ScrapeError } from './errors';
import type { CompanyProfile, CompanyStatus } from '../../lib/types';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface AuthContext {
  base44: Base44Client;
  user: { id: string; email?: string };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Every function starts here. Base44 has no `context.user`: the signed-in user comes from
 * the request's token via `base44.auth.me()`. We use the user-scoped client for all entity
 * access so the entities' row-level security (owner-only) is enforced by the platform too.
 */
export async function authenticate(req: Request): Promise<AuthContext> {
  if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me().catch(() => null);
  if (!user?.id) throw new HttpError(401, 'UNAUTHORIZED', 'You must be signed in to use this feature.');
  return { base44, user };
}

const MAX_BODY_BYTES = 64 * 1024;

export async function readJsonBody(req: Request): Promise<unknown> {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
}

/** Validates + sanitizes input with Zod, turning failures into a 400 with a readable message. */
export function parseInput<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const message = result.error.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
  throw new HttpError(400, 'VALIDATION_ERROR', message || 'Invalid input.');
}

/** Maps any thrown error to a JSON response. Unknown errors are masked; details go to the log only. */
export function errorResponse(err: unknown, context: { profileId?: string } = {}): Response {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong on our side. Please try again.';
  let retryable = true;

  if (err instanceof HttpError) {
    ({ status, code, message, retryable } = err);
  } else if (err instanceof ScrapeError) {
    status = err.code === 'INVALID_URL' || err.code === 'BLOCKED_HOST' ? 400 : 422;
    code = `SCRAPE_${err.code}`;
    message = err.message;
    retryable = err.retryable;
  } else if (err instanceof ClaudeError) {
    code = `AI_${err.code}`;
    message = err.message;
    retryable = err.retryable;
    status =
      err.code === 'RATE_LIMITED' ? 429 : err.code === 'TIMEOUT' ? 504 : err.code === 'REFUSED' ? 422 : err.code === 'NO_API_KEY' ? 500 : 502;
  } else {
    console.error('[omnicompetitor] unexpected error:', err instanceof Error ? err.message : String(err));
  }
  if (status >= 500) console.error(`[omnicompetitor] ${code}: ${message}`);
  return json({ error: message, code, retryable, ...(context.profileId ? { profileId: context.profileId } : {}) }, status);
}

/** Loads a CompanyProfile the caller owns. Missing and foreign records are indistinguishable (404). */
export async function loadOwnedProfile(
  { base44, user }: AuthContext,
  id: string,
): Promise<CompanyProfile> {
  let profile: CompanyProfile | null = null;
  try {
    profile = (await base44.entities.CompanyProfile.get(id)) as CompanyProfile;
  } catch {
    profile = null;
  }
  if (!profile || (profile.created_by_id && profile.created_by_id !== user.id)) {
    throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Company profile not found.');
  }
  return profile;
}

const IN_FLIGHT_WINDOW_MS = 4 * 60 * 1000;

/** True while another run is plausibly still working on this profile (guards double-clicks / cost abuse). */
export function isInFlight(profile: Pick<CompanyProfile, 'status' | 'updated_date'>, now = Date.now()): boolean {
  if (profile.status !== 'SCRAPING') return false;
  const updated = profile.updated_date ? Date.parse(profile.updated_date) : NaN;
  return Number.isFinite(updated) && now - updated < IN_FLIGHT_WINDOW_MS;
}

export function assertNotInFlight(profile: CompanyProfile): void {
  if (isInFlight(profile)) {
    throw new HttpError(409, 'ALREADY_RUNNING', 'An analysis is already running for this company. Please wait a moment.', true);
  }
}

/** Best-effort status write: bookkeeping must never mask the real error. */
export async function setProfileStatus(
  { base44 }: AuthContext,
  id: string,
  status: CompanyStatus,
  lastError = '',
): Promise<void> {
  try {
    await base44.entities.CompanyProfile.update(id, { status, last_error: status === 'ERROR' ? lastError.slice(0, 500) : '' });
  } catch (err) {
    console.error('[omnicompetitor] could not update profile status:', err instanceof Error ? err.message : String(err));
  }
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
