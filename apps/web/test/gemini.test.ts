import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePreset, applyEdit, type Edit, type Preset, type ToneHost } from '@pocket-master/core';
import { realP08 } from '../../../packages/core/test/fake-pedal.ts';
import { converseGemini as converse, GEMINI_MODELS, testGeminiKey as testKey } from '../lib/gemini.ts';
import { KeyError, QuotaError, RegionError, toToolSchema as toGeminiSchema } from '../lib/assistant.ts';

const KEY = 'AIzaTESTKEY-0000000000000000000000000';
const SLOTS = { irNames: [null, null, null, null, null], profileNames: [null, null, null, null, null] };

function host() {
  let preset: Preset = decodePreset(realP08());
  const edits: Edit[][] = [];
  const h: ToneHost = {
    snapshot: () => ({ index: 7, name: 'IRON-RHY', preset, slots: SLOTS, modified: edits.length > 0, names: [] }),
    applyEdits: async (e) => { edits.push([...e]); preset = e.reduce(applyEdit, preset); },
    undo: async () => false, revert: async () => undefined, selectPreset: async () => true, proposeSave: async () => 'saved',
  };
  return { h, edits };
}

/** A fetch that answers with the scripted replies in order and records the requests. */
function scripted(...replies: { status?: number; body: unknown }[]) {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : {} });
    const r = replies.shift();
    if (!r) throw new Error('no more scripted replies');
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

const call = (name: string, args: unknown, id = 'c1') => ({ body: { status: 'requires_action', steps: [{ type: 'function_call', id, name, arguments: args }] } });
const say = (text: string) => ({ body: { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] } });

test('a tone in two requests: the model edits, then answers; the key only travels in a header', async () => {
  const { h, edits } = host();
  const { fetchFn, requests } = scripted(
    call('edit_preset', { changes: [{ kind: 'model', block: 'amp', model: 'Calif DualM' }, { kind: 'parameter', block: 'amp', parameter: 'gain', value: 70 }] }),
    say('Mesa Dual Rectifier, gain 70.'),
  );
  let counted = 0;
  const steps: string[] = [];
  const reply = await converse({ key: KEY, model: 'flash', turns: [], message: 'black album rhythm on 45', host: h, fetchFn, onRequest: () => void counted++, onStep: (name, ok) => steps.push(`${name} ${ok}`) });
  assert.equal(reply, 'Mesa Dual Rectifier, gain 70.');
  assert.equal(counted, 2);
  assert.deepEqual(steps, ['edit_preset true']);
  assert.equal(edits.length, 1);
  for (const q of requests) {
    assert.equal(q.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(q.headers['x-goog-api-key'], KEY);
    assert.equal(q.body.model, GEMINI_MODELS.flash.id);
    assert.equal(q.body.store, false);
    assert.ok(!JSON.stringify(q.body).includes(KEY));
  }
  const first = requests[0]!.body.input as { type: string; content: string }[];
  assert.match(first[0]!.content, /^Loaded preset:\nP08 "IRON-RHY"[\s\S]*\n\nRequest: black album rhythm on 45$/);
  const second = requests[1]!.body.input as { type: string; call_id?: string; is_error?: boolean }[];
  assert.deepEqual(second.map((s) => s.type), ['user_input', 'function_call', 'function_result']);
  assert.equal(second[2]!.call_id, 'c1');
});

test('the next message carries the earlier texts and the preset as it is now, not the model list', async () => {
  const { h } = host();
  const { fetchFn, requests } = scripted(say('Done'));
  await converse({ key: KEY, model: 'lite', turns: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Hello' }], message: 'more gain', host: h, fetchFn, onRequest: () => {} });
  const input = requests[0]!.body.input as { type: string; content: unknown }[];
  assert.deepEqual(input.map((s) => s.type), ['user_input', 'model_output', 'user_input']);
  assert.equal(input[0]!.content, 'hi');
  assert.deepEqual(input[1]!.content, [{ type: 'text', text: 'Hello' }]);
  assert.match(String(input[2]!.content), /^Loaded preset now:\nP08 "IRON-RHY"[\s\S]*\n\nRequest: more gain$/);
  assert.doesNotMatch(String(input[2]!.content), /models:/);
  assert.equal(requests[0]!.body.model, GEMINI_MODELS.lite.id);
});

test('a model that never stops calling tools is cut off after six requests', async () => {
  const { h } = host();
  const { fetchFn, requests } = scripted(...Array.from({ length: 8 }, (_, i) => call('get_preset', {}, `c${i}`)));
  await assert.rejects(converse({ key: KEY, model: 'flash', turns: [], message: 'x', host: h, fetchFn, onRequest: () => {} }), /too many steps/);
  assert.equal(requests.length, 6);
});

test('quota and key errors are told apart, with when the quota comes back', async () => {
  const { h } = host();
  const now = new Date('2026-11-21T20:00:00Z');
  const quota = { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' }] } } };
  const e = await converse({ key: KEY, model: 'flash', turns: [], message: 'x', host: h, fetchFn: scripted(quota).fetchFn, onRequest: () => {}, now: () => now }).catch((x) => x);
  assert.ok(e instanceof QuotaError);
  assert.equal((e as QuotaError).retryAt.toISOString(), '2026-11-21T21:00:00.000Z');
  const noDelay = await converse({ key: KEY, model: 'flash', turns: [], message: 'x', host: h, fetchFn: scripted({ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }).fetchFn, onRequest: () => {}, now: () => now }).catch((x) => x);
  assert.equal((noDelay as QuotaError).retryAt.toISOString(), '2026-11-22T08:00:00.000Z', 'falls back to Pacific midnight');
  const bad = { status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } } };
  assert.ok((await converse({ key: KEY, model: 'flash', turns: [], message: 'x', host: h, fetchFn: scripted(bad).fetchFn, onRequest: () => {} }).catch((x) => x)) instanceof KeyError);
});

test('testKey asks for the model list, which uses no generation quota', async () => {
  const ok = scripted({ body: { models: [] } });
  assert.equal(await testKey(KEY, ok.fetchFn), 'ok');
  assert.match(ok.requests[0]!.url, /\/v1beta\/models\?pageSize=1$/);
  assert.equal(await testKey(KEY, scripted({ status: 400, body: { error: { details: [{ reason: 'API_KEY_INVALID' }] } } }).fetchFn), 'invalid');
  assert.equal(await testKey(KEY, scripted({ status: 500, body: {} }).fetchFn), 'unavailable');
});

test('schemas go to Gemini in the subset it documents: anyOf, enum, one type each', () => {
  assert.deepEqual(toGeminiSchema({ oneOf: [{ type: 'string', const: 'a' }] }), { anyOf: [{ type: 'string', enum: ['a'] }] });
  assert.deepEqual(toGeminiSchema({ type: ['number', 'boolean'], description: 'v' }), { anyOf: [{ type: 'number' }, { type: 'boolean' }], description: 'v' });
  assert.deepEqual(toGeminiSchema({ type: 'object', properties: { a: { type: 'integer', minimum: 0 } }, required: ['a'] }), { type: 'object', properties: { a: { type: 'integer', minimum: 0 } }, required: ['a'] });
});

test('a preset the person loads during a reply stops the assistant from editing it blind', async () => {
  const { h, edits } = host();
  let index = 7;
  const snap = h.snapshot;
  h.snapshot = () => ({ ...snap(), index });
  const { fetchFn, requests } = scripted(call('edit_preset', { changes: [{ kind: 'volume', value: 50 }] }), say('The preset changed; tell me again.'));
  const original = fetchFn;
  const loadingMeanwhile = (async (url: string, init: RequestInit) => { index = 9; return original(url, init); }) as unknown as typeof fetch;
  await converse({ key: KEY, model: 'flash', turns: [], message: 'louder', host: h, fetchFn: loadingMeanwhile, onRequest: () => {} });
  assert.equal(edits.length, 0);
  assert.match(JSON.stringify(requests[1]!.body.input), /the preset changed to P10/);
});

test('an answer with nothing recognisable in it is an error, not a silent empty reply', async () => {
  const { h } = host();
  await assert.rejects(converse({ key: KEY, model: 'flash', turns: [], message: 'x', host: h, fetchFn: scripted({ body: { outputs: [] } }).fetchFn, onRequest: () => {} }), /no answer this editor understands/);
});

test('a per-minute 429 without a retry delay pauses a minute; a daily one until Pacific midnight', async () => {
  const { h } = host();
  const now = new Date('2026-11-21T20:00:00Z');
  const run = (quotaId: string) => converse({ key: KEY, model: 'flash', turns: [], message: 'x', host: h, onRequest: () => {}, now: () => now,
    fetchFn: scripted({ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] }] } } }).fetchFn }).then(() => { throw new Error('expected a quota error'); }, (x) => x as QuotaError);
  assert.equal((await run('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')).retryAt.toISOString(), '2026-11-21T20:01:00.000Z');
  assert.equal((await run('GenerateRequestsPerDayPerProjectPerModel-FreeTier')).retryAt.toISOString(), '2026-11-22T08:00:00.000Z');
});

test('Google refusing the free tier where the person is gives a region error, not a generic one', async () => {
  const { h } = host();
  const region = { status: 400, body: { error: { code: 400, status: 'FAILED_PRECONDITION', message: 'User location is not supported for the API use.' } } };
  const e = await converse({ key: KEY, model: 'flash', turns: [], message: 'x', host: h, fetchFn: scripted(region).fetchFn, onRequest: () => {} }).catch((x) => x);
  assert.ok(e instanceof RegionError);
  const other = { status: 400, body: { error: { code: 400, status: 'FAILED_PRECONDITION', message: 'Something else.' } } };
  const e2 = await converse({ key: KEY, model: 'flash', turns: [], message: 'x', host: h, fetchFn: scripted(other).fetchFn, onRequest: () => {} }).catch((x) => x);
  assert.ok(!(e2 instanceof RegionError));
});
