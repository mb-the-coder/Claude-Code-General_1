// Claude API integration layer (Anthropic Messages API over fetch; no SDK so it runs on Deno as-is).
//
// callClaudeJson() guarantees a schema-valid result or throws a ClaudeError:
//   1. The Zod schema is converted to JSON Schema and sent as a tool; tool_choice forces the model
//      to answer by calling it (strict structured output).
//   2. The tool input is validated with the same Zod schema on our side.
//   3. On validation failure it retries ONCE, feeding the validation errors back to the model.
//   4. Transient API failures (429 / 5xx / 529 / network) are retried with exponential backoff.
//   5. If a model ever answers in plain text, the JSON is extracted (Markdown fences stripped).
//
// Secrets: ANTHROPIC_API_KEY (required). ANTHROPIC_MODEL (optional override).

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export type ClaudeErrorCode = 'NO_API_KEY' | 'API_ERROR' | 'RATE_LIMITED' | 'TIMEOUT' | 'INVALID_OUTPUT' | 'REFUSED';

export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly code: ClaudeErrorCode,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

/** Reads an environment variable on Deno (Base44) or Node (tests). */
export function readEnv(name: string): string | undefined {
  const g = globalThis as unknown as {
    Deno?: { env?: { get(n: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  try {
    return g.Deno?.env?.get(name) ?? g.process?.env?.[name];
  } catch {
    return undefined;
  }
}

export interface ClaudeJsonRequest<S extends z.ZodTypeAny> {
  system: string;
  user: string;
  schema: S;
  /** Tool name shown to the model, e.g. "submit_benchmark_report". */
  toolName: string;
  toolDescription: string;
  maxTokens?: number;
  timeoutMs?: number;
  model?: string;
  /** Attempts per HTTP request for transient failures. Default 3. */
  maxAttempts?: number;
  /** Extra model round-trips allowed after a schema-validation failure. Default 1. */
  maxRepairs?: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface ContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  text?: string;
}

interface MessagesResponse {
  content?: ContentBlock[];
  stop_reason?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function toToolInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** Pulls a JSON object out of plain model text, tolerating ```json fences and stray prose. */
export function extractJsonFromText(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

async function postMessage(
  body: Record<string, unknown>,
  o: { apiKey: string; timeoutMs: number; maxAttempts: number; fetchImpl: typeof fetch; sleep: (ms: number) => Promise<void> },
): Promise<MessagesResponse> {
  let lastError: ClaudeError | undefined;
  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs);
    let retryAfterMs = 0;
    try {
      const res = await o.fetchImpl(ANTHROPIC_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': o.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) return (await res.json()) as MessagesResponse;

      const detail = await res
        .json()
        .then((j: { error?: { message?: string } }) => j?.error?.message ?? '')
        .catch(() => '');
      const message = `Claude API error (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 300)}` : ''}`;
      const retryable = RETRYABLE_STATUS.has(res.status);
      lastError = new ClaudeError(
        res.status === 401 || res.status === 403 ? 'Claude API rejected the API key. Check the ANTHROPIC_API_KEY secret.' : message,
        res.status === 429 ? 'RATE_LIMITED' : 'API_ERROR',
        retryable,
        res.status,
      );
      if (!retryable) throw lastError;
      const header = Number(res.headers.get('retry-after'));
      if (Number.isFinite(header) && header > 0) retryAfterMs = Math.min(header * 1000, 20_000);
    } catch (err) {
      if (err instanceof ClaudeError) {
        if (!err.retryable) throw err;
        lastError = err;
      } else if (controller.signal.aborted) {
        lastError = new ClaudeError(`Claude did not respond within ${Math.round(o.timeoutMs / 1000)}s.`, 'TIMEOUT', true);
      } else {
        lastError = new ClaudeError(`Could not reach the Claude API (${(err as Error).message}).`, 'API_ERROR', true);
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt < o.maxAttempts) {
      const backoff = retryAfterMs || 800 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      await o.sleep(backoff);
    }
  }
  throw lastError ?? new ClaudeError('Claude request failed.', 'API_ERROR', true);
}

export async function callClaudeJson<S extends z.ZodTypeAny>(req: ClaudeJsonRequest<S>): Promise<z.output<S>> {
  const apiKey = req.apiKey ?? readEnv('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new ClaudeError('The ANTHROPIC_API_KEY secret is not configured for this app.', 'NO_API_KEY', false);
  }
  const model = req.model ?? readEnv('ANTHROPIC_MODEL') ?? DEFAULT_MODEL;
  const maxRepairs = req.maxRepairs ?? 1;
  const transport = {
    apiKey,
    timeoutMs: req.timeoutMs ?? 60_000,
    maxAttempts: req.maxAttempts ?? 3,
    fetchImpl: req.fetchImpl ?? fetch,
    sleep: req.sleep ?? defaultSleep,
  };
  const tool = {
    name: req.toolName,
    description: req.toolDescription,
    input_schema: toToolInputSchema(req.schema),
  };

  let userContent = req.user;
  let lastIssues = '';
  for (let repair = 0; repair <= maxRepairs; repair++) {
    const response = await postMessage(
      {
        model,
        max_tokens: req.maxTokens ?? 4096,
        system: req.system,
        messages: [{ role: 'user', content: userContent }],
        tools: [tool],
        tool_choice: { type: 'tool', name: req.toolName },
      },
      transport,
    );

    if (response.stop_reason === 'refusal') {
      throw new ClaudeError('Claude declined to analyze this content.', 'REFUSED', false);
    }

    const blocks = response.content ?? [];
    const toolUse = blocks.find((b) => b.type === 'tool_use' && b.name === req.toolName);
    const candidate = toolUse
      ? toolUse.input
      : extractJsonFromText(blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'));

    const parsed = req.schema.safeParse(candidate);
    if (parsed.success) return parsed.data;

    lastIssues = candidate === undefined ? 'no JSON object was returned' : summarizeIssues(parsed.error);
    const truncated = response.stop_reason === 'max_tokens';
    userContent =
      `${req.user}\n\n[Validation feedback] Your previous answer was rejected: ${lastIssues}.` +
      `${truncated ? ' It was cut off for length, so be more concise.' : ''}` +
      ' Return a complete, corrected result that satisfies the schema exactly.';
  }

  throw new ClaudeError(`Claude returned output that did not match the required format (${lastIssues}).`, 'INVALID_OUTPUT', true);
}
