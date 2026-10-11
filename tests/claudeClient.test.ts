import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ClaudeError, callClaudeJson, extractJsonFromText, toToolInputSchema } from '../backend/utils/claudeClient';

const Schema = z.object({
  score: z.number().min(0).max(100),
  label: z.enum(['LOW', 'HIGH']),
});

const toolReply = (input: unknown, stop_reason = 'tool_use') =>
  new Response(JSON.stringify({ stop_reason, content: [{ type: 'tool_use', name: 'submit', input }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const textReply = (text: string) =>
  new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }), { status: 200 });

const base = {
  system: 'sys',
  user: 'do it',
  schema: Schema,
  toolName: 'submit',
  toolDescription: 'Submit result',
  apiKey: 'sk-test-secret',
  sleep: async () => undefined,
};

describe('callClaudeJson', () => {
  it('forces the tool, sends auth headers and returns validated data', async () => {
    const fetchImpl = vi.fn(async () => toolReply({ score: 82, label: 'HIGH' })) as unknown as typeof fetch;
    const out = await callClaudeJson({ ...base, fetchImpl });
    expect(out).toEqual({ score: 82, label: 'HIGH' });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-secret');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit' });
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.tools[0].input_schema.type).toBe('object');
    expect(body.tools[0].input_schema.$schema).toBeUndefined();
    expect(body.tools[0].input_schema.properties.label.enum).toEqual(['LOW', 'HIGH']);
  });

  it('feeds validation errors back once and accepts the repaired answer', async () => {
    const replies = [toolReply({ score: 140, label: 'HIGH' }), toolReply({ score: 90, label: 'HIGH' })];
    const fetchImpl = vi.fn(async () => replies.shift()!) as unknown as typeof fetch;
    const out = await callClaudeJson({ ...base, fetchImpl });
    expect(out.score).toBe(90);
    const second = JSON.parse(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1] as RequestInit).body as string);
    expect(second.messages[0].content).toMatch(/Validation feedback.*score/s);
  });

  it('throws INVALID_OUTPUT when the repair also fails', async () => {
    const fetchImpl = vi.fn(async () => toolReply({ score: -5, label: 'NOPE' })) as unknown as typeof fetch;
    await expect(callClaudeJson({ ...base, fetchImpl })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to JSON in plain text, stripping Markdown fences', async () => {
    const fetchImpl = vi.fn(async () => textReply('Sure!\n```json\n{"score": 12, "label": "LOW"}\n```')) as unknown as typeof fetch;
    await expect(callClaudeJson({ ...base, fetchImpl })).resolves.toEqual({ score: 12, label: 'LOW' });
  });

  it('retries 429 / 529 with backoff and honors retry-after', async () => {
    const sleeps: number[] = [];
    const replies = [
      new Response('{}', { status: 429, headers: { 'retry-after': '2' } }),
      new Response('{}', { status: 529 }),
      toolReply({ score: 1, label: 'LOW' }),
    ];
    const fetchImpl = vi.fn(async () => replies.shift()!) as unknown as typeof fetch;
    const out = await callClaudeJson({ ...base, fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
    expect(out.score).toBe(1);
    expect(sleeps[0]).toBe(2000);
    expect(sleeps).toHaveLength(2);
  });

  it('does not retry auth errors and never leaks the API key in the message', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key sk-test-secret' } }), { status: 401 })) as unknown as typeof fetch;
    const err = (await callClaudeJson({ ...base, fetchImpl }).catch((e: unknown) => e)) as ClaudeError;
    expect(err).toBeInstanceOf(ClaudeError);
    expect(err.code).toBe('API_ERROR');
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain('sk-test-secret');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails fast without an API key', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await expect(callClaudeJson({ ...base, apiKey: undefined, fetchImpl })).rejects.toMatchObject({ code: 'NO_API_KEY' });
    expect(fetchImpl).not.toHaveBeenCalled();
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  });

  it('honors the ANTHROPIC_MODEL override', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-custom-model';
    const fetchImpl = vi.fn(async () => toolReply({ score: 1, label: 'LOW' })) as unknown as typeof fetch;
    await callClaudeJson({ ...base, fetchImpl });
    delete process.env.ANTHROPIC_MODEL;
    const body = JSON.parse(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('claude-custom-model');
  });

  it('surfaces refusals', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 })) as unknown as typeof fetch;
    await expect(callClaudeJson({ ...base, fetchImpl })).rejects.toMatchObject({ code: 'REFUSED' });
  });
});

describe('helpers', () => {
  it('extractJsonFromText handles fences, prose and junk', () => {
    expect(extractJsonFromText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonFromText('Here you go: {"a":{"b":2}} thanks')).toEqual({ a: { b: 2 } });
    expect(extractJsonFromText('no json here')).toBeUndefined();
    expect(extractJsonFromText('{broken')).toBeUndefined();
  });

  it('toToolInputSchema produces an object schema without $schema', () => {
    const json = toToolInputSchema(z.object({ a: z.string().transform((s) => s.trim()), b: z.array(z.number()).max(3) }));
    expect(json.type).toBe('object');
    expect(json.$schema).toBeUndefined();
    expect((json.properties as Record<string, { type: string }>).a?.type).toBe('string');
  });
});
