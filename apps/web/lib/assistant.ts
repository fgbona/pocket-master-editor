/**
 * What the tone assistant's providers share, and the router between them. Conversations keep only
 * the texts (the person's messages and the answers); every request carries the preset as it is now,
 * so any provider can take the next message. Free quotas: Groq first (about 1,000 requests a day),
 * then Gemini Flash, then Gemini Flash-Lite; a used-up model hands the message to the next.
 */
import { chatContext, currentPresetText, type JsonSchema, type ToneHost } from '@pocket-master/core';

export type Provider = 'groq' | 'gemini';
/** A model the router can use, in the order it tries them. */
export type AiModel = 'groq' | 'flash' | 'lite';
export const ROUTE: readonly AiModel[] = ['groq', 'flash', 'lite'];
export const providerOf = (model: AiModel): Provider => (model === 'groq' ? 'groq' : 'gemini');

/** One message of the conversation as text; tool calls stay inside the request that made them. */
export interface Turn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** Model requests per message: a tone takes one or two; more means the model is going in circles. */
export const MAX_REQUESTS = 6;

/** The model's free quota is used up; it takes requests again at `retryAt`. */
export class QuotaError extends Error {
  readonly retryAt: Date;
  /** The model that ran out, when one ran out after it had already changed the pedal. */
  readonly model?: AiModel;
  /** True when the sound had already changed: the request was only partly done. */
  readonly partial: boolean;
  constructor(retryAt: Date, stopped?: { model: AiModel }) {
    super('The free quota is used up for now.');
    this.retryAt = retryAt;
    this.model = stopped?.model;
    this.partial = stopped !== undefined;
  }
}

/** Tools whose success changes the pedal (or opens the Save dialog): a request that ran one is not repeated elsewhere. */
const ACTS = new Set(['edit_preset', 'undo_edit', 'revert_preset', 'select_preset', 'save_preset', 'load_saved_tone', 'keep_tone']);

/** The provider refused the key itself (wrong, deleted, or not allowed). */
export class KeyError extends Error {
  readonly provider: Provider;
  constructor(provider: Provider, message: string) {
    super(message);
    this.provider = provider;
  }
}

/** Google does not offer the Gemini API (or its free tier) where the person is. */
export class RegionError extends Error {}

/** The text of a new message: the first carries the preset and the models, later ones the preset as it is now. */
export function requestText(host: ToneHost, turns: readonly Turn[], message: string): string {
  const context = turns.length === 0 ? chatContext(host) : `Loaded preset now:\n${currentPresetText(host)}`;
  return `${context}\n\nRequest: ${message}`;
}

/**
 * Tool parameters in the JSON Schema subset both APIs document: unions as anyOf, constants as
 * one-value enums. Not valid for an OpenAI-style "strict" mode (top-level anyOf, type unions).
 */
export function toToolSchema(s: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.oneOf) out.anyOf = s.oneOf.map(toToolSchema);
  if (Array.isArray(s.type)) out.anyOf = s.type.map((type) => ({ type }));
  else if (s.type) out.type = s.type;
  if (s.const !== undefined) out.enum = [s.const];
  if (s.description) out.description = s.description;
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toToolSchema(v)]));
  if (s.required) out.required = s.required;
  if (s.items) out.items = toToolSchema(s.items);
  if (s.minimum !== undefined) out.minimum = s.minimum;
  if (s.maximum !== undefined) out.maximum = s.maximum;
  return out;
}

export interface ConverseOptions {
  readonly key: string;
  readonly model: AiModel;
  readonly turns: readonly Turn[];
  readonly message: string;
  readonly host: ToneHost;
  readonly fetchFn?: typeof fetch;
  /** Called before every request, for the usage meter. */
  readonly onRequest: () => void;
  /** Called after each tool the model ran, with whether it worked. */
  readonly onStep?: (tool: string, ok: boolean, text: string) => void;
  /** Requests left today and the daily limit, when the provider says. */
  readonly onLimits?: (remaining: number, limit: number) => void;
  readonly now?: () => Date;
}

/** One provider's conversation loop for one message: returns the answer text. */
export type Converse = (options: ConverseOptions) => Promise<string>;

export type Cooldown = Readonly<Partial<Record<AiModel, Date>>>;

/**
 * Sends the message to the first model with a key that is not cooling down; a used-up quota moves
 * on to the next model, a refused key to the next provider. Any other error stops: the person sees it.
 */
export async function ask(options: Omit<ConverseOptions, 'key' | 'model' | 'onRequest' | 'onLimits'> & {
  readonly keys: Readonly<Partial<Record<Provider, string>>>;
  readonly cooldown: Cooldown;
  readonly converse: Readonly<Record<AiModel, Converse>>;
  readonly onRequest: (model: AiModel) => void;
  readonly onLimits?: (model: AiModel, remaining: number, limit: number) => void;
  /** Called with the pauses as soon as one changes, so they survive any error. */
  readonly onCooldown?: (cooldown: Cooldown) => void;
}): Promise<{ reply: string; model: AiModel; cooldown: Cooldown; badKeys: Provider[] }> {
  const now = (options.now ?? (() => new Date()))();
  let cooldown: Cooldown = options.cooldown;
  const badKeys: Provider[] = [];
  let keyError: KeyError | null = null;
  const candidates = ROUTE.filter((m) => options.keys[providerOf(m)]);
  if (candidates.length === 0) throw new Error('No AI key is set up.');
  for (const model of candidates) {
    const key = options.keys[providerOf(model)]!;
    if (badKeys.includes(providerOf(model)) || (cooldown[model] && cooldown[model]! > now)) continue;
    let acted = false;
    try {
      const reply = await options.converse[model]({
        ...options, key, model,
        onRequest: () => options.onRequest(model),
        onLimits: (remaining, limit) => options.onLimits?.(model, remaining, limit),
        onStep: (tool, ok, text) => {
          if (ok && ACTS.has(tool)) acted = true;
          options.onStep?.(tool, ok, text);
        },
      });
      return { reply, model, cooldown, badKeys };
    } catch (error) {
      if (error instanceof QuotaError) {
        cooldown = { ...cooldown, [model]: error.retryAt };
        options.onCooldown?.(cooldown);
        // Part of the request is already on the pedal: another model would do it again ("more gain" twice).
        if (acted) throw new QuotaError(error.retryAt, { model });
      } else if (error instanceof KeyError) {
        badKeys.push(error.provider);
        keyError = error;
      } else throw error;
    }
  }
  if (keyError && candidates.every((m) => badKeys.includes(providerOf(m)))) throw keyError;
  const waits = candidates.map((m) => cooldown[m]).filter((d): d is Date => d !== undefined);
  throw new QuotaError(new Date(Math.min(...waits.map((d) => d.getTime()))));
}
