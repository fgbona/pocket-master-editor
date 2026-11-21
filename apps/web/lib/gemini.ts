/**
 * The tone assistant's link to Gemini, called straight from the editor with the person's own key
 * (no server in between). Uses the Interactions API in stateless mode (store: false): Google keeps
 * none of the conversation between requests. Tool calls run in the editor through runChatTool.
 */
import { CHAT_INSTRUCTIONS, CHAT_TOOLS, runChatTool, type ChatGuard } from '@pocket-master/core';
import { KeyError, MAX_REQUESTS, RegionError, QuotaError, requestText, toToolSchema, type ConverseOptions } from './assistant.ts';
import { nextReset } from './aiUsage.ts';

/** Gemini models and their free daily requests (AI Studio, 2026-11). Check aistudio.google.com/rate-limit when they change. */
export const GEMINI_MODELS = {
  flash: { id: 'gemini-3.8-flash', freeDailyLimit: 20 },
  lite: { id: 'gemini-3.5-flash-lite', freeDailyLimit: 500 },
} as const;

const API = 'https://generativelanguage.googleapis.com/v1beta';

/** A step of the conversation, as the Interactions API sends and takes it. */
type Step = { readonly type: string; readonly [field: string]: unknown };

const TOOLS = CHAT_TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: toToolSchema(t.parameters) }));

type ApiError = { error?: { status?: string; message?: string; details?: { '@type'?: string; reason?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[] } };

/** The error Google answered with, as one of ours. The key is never part of the message. */
function failure(status: number, body: ApiError, now: Date): Error {
  const details = body.error?.details ?? [];
  if (status === 429) {
    const delay = details.find((d) => d['@type']?.endsWith('RetryInfo'))?.retryDelay;
    const seconds = delay ? Number.parseFloat(delay) : Number.NaN;
    if (Number.isFinite(seconds)) return new QuotaError(new Date(now.getTime() + seconds * 1000));
    // Without a delay, the violated quota tells a per-minute limit (a minute) from the daily one (Pacific midnight).
    const perMinute = details.some((d) => d.violations?.some((v) => /PerMinute/i.test(v.quotaId ?? '')));
    return new QuotaError(perMinute ? new Date(now.getTime() + 60_000) : nextReset(now));
  }
  if (status === 401 || status === 403 || details.some((d) => d.reason === 'API_KEY_INVALID')) {
    return new KeyError('gemini', body.error?.message ?? 'Google did not accept this key.');
  }
  if (body.error?.status === 'FAILED_PRECONDITION' && /location is not supported/i.test(body.error.message ?? '')) {
    return new RegionError(body.error.message);
  }
  return new Error(`Gemini answered ${status}${body.error?.message ? `: ${body.error.message}` : ''}`);
}

/** Checks a key with the model list, which costs no generation quota. */
export async function testGeminiKey(key: string, fetchFn: typeof fetch = fetch): Promise<'ok' | 'invalid' | 'unavailable'> {
  try {
    const r = await fetchFn(`${API}/models?pageSize=1`, { headers: { 'x-goog-api-key': key } });
    if (r.ok) return 'ok';
    const body = (await r.json().catch(() => ({}))) as ApiError;
    return failure(r.status, body, new Date()) instanceof KeyError ? 'invalid' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** Sends one message to Gemini, runs the tools it asks for, and returns its answer. */
export async function converseGemini(options: ConverseOptions): Promise<string> {
  const { key, host, onRequest, onStep, fetchFn = fetch, now = () => new Date() } = options;
  const model = options.model === 'lite' ? GEMINI_MODELS.lite : GEMINI_MODELS.flash;
  const input: Step[] = [
    ...options.turns.map((t): Step => (t.role === 'user'
      ? { type: 'user_input', content: t.text }
      : { type: 'model_output', content: [{ type: 'text', text: t.text }] })),
    { type: 'user_input', content: requestText(host, options.turns, options.message) },
  ];
  const guard: ChatGuard = { index: host.snapshot().index };
  for (let request = 0; request < MAX_REQUESTS; request++) {
    onRequest();
    const r = await fetchFn(`${API}/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ model: model.id, store: false, system_instruction: CHAT_INSTRUCTIONS, tools: TOOLS, input }),
    });
    const body = (await r.json().catch(() => ({}))) as ApiError & { steps?: Step[] };
    if (!r.ok) throw failure(r.status, body, now());
    const steps = body.steps;
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('Gemini sent no answer this editor understands. Try again in a moment.');
    input.push(...steps); // model steps go back exactly as received (thoughts included)
    const calls = steps.filter((s) => s.type === 'function_call');
    if (calls.length === 0) {
      return steps.filter((s) => s.type === 'model_output')
        .flatMap((s) => (s.content as { type: string; text?: string }[] | undefined) ?? [])
        .map((c) => c.text ?? '').join('').trim();
    }
    for (const c of calls) {
      const result = await runChatTool(host, String(c.name), c.arguments, guard);
      onStep?.(String(c.name), result.ok, result.text);
      input.push({ type: 'function_result', name: c.name, call_id: c.id, is_error: !result.ok, result: [{ type: 'text', text: result.text }] });
    }
  }
  throw new Error('The assistant took too many steps for one message. Try asking again, more simply.');
}
