'use client';

import { useEffect, useRef, useState } from 'react';
import { comparePresets, type Difference, type ToneHost, type ToneSnapshot } from '@pocket-master/core';
import { loadKey, maskKey, removeKey, saveKey } from '@/lib/aiKey';
import { nextReset, recordRequest, usedToday, useAiUsage } from '@/lib/aiUsage';
import { ask, KeyError, providerOf, QuotaError, RegionError, ROUTE, type AiModel, type Converse, type Cooldown, type Provider, type Turn } from '@/lib/assistant';
import { converseGemini, GEMINI_MODELS, testGeminiKey } from '@/lib/gemini';
import { converseGroq, GROQ_MODEL, testGroqKey } from '@/lib/groq';
import type { MessageKey } from '@/lib/i18n';
import { Changes, DIFF_KEY } from './PresetFiles';
import { useI18n } from './I18n';

interface Props {
  host: ToneHost;
  liveEdit: boolean;
  onLiveEdit: () => void;
}

interface Message {
  readonly role: 'user' | 'assistant' | 'error';
  readonly text: string;
  readonly changes?: readonly Difference[];
  readonly model?: AiModel;
  readonly link?: { readonly href: string; readonly text: string };
}

const REGIONS = 'https://ai.google.dev/gemini-api/docs/available-regions';
const EXAMPLES = ['assistant.example1', 'assistant.example2', 'assistant.example3'] as const;

const CONVERSE: Readonly<Record<AiModel, Converse>> = { groq: converseGroq, flash: converseGemini, lite: converseGemini };
const MODELS: Readonly<Record<AiModel, { readonly name: string; readonly limit: number; readonly pacificReset: boolean }>> = {
  groq: { name: 'Groq', limit: GROQ_MODEL.freeDailyLimit, pacificReset: false },
  flash: { name: 'Gemini Flash', limit: GEMINI_MODELS.flash.freeDailyLimit, pacificReset: true },
  lite: { name: 'Gemini Flash-Lite', limit: GEMINI_MODELS.lite.freeDailyLimit, pacificReset: true },
};
const PROVIDER_NAME: Readonly<Record<Provider, string>> = { groq: 'Groq', gemini: 'Google Gemini' };

/** How to get each free key; Groq first, since its free quota is the largest. */
const SETUP: readonly {
  readonly provider: Provider;
  readonly note: MessageKey;
  readonly link: string;
  readonly linkText: MessageKey;
  readonly steps: readonly MessageKey[];
  readonly label: MessageKey;
  readonly placeholder: string;
  readonly test: (key: string) => Promise<'ok' | 'invalid' | 'unavailable'>;
  readonly usage: string;
}[] = [
  {
    provider: 'groq', note: 'assistant.groqNote', link: 'https://console.groq.com/keys', linkText: 'assistant.openGroq',
    steps: ['assistant.groqStep1', 'assistant.groqStep2', 'assistant.groqStep3'], label: 'assistant.groqKeyLabel', placeholder: 'gsk_…',
    test: (k) => testGroqKey(k), usage: 'https://console.groq.com/settings/limits',
  },
  {
    provider: 'gemini', note: 'assistant.geminiNote', link: 'https://aistudio.google.com/apikey', linkText: 'assistant.openStudio',
    steps: ['assistant.step1', 'assistant.step2', 'assistant.step3'], label: 'assistant.keyLabel', placeholder: 'AIza…',
    test: (k) => testGeminiKey(k), usage: 'https://aistudio.google.com/rate-limit',
  },
];

/** What the reply changed on the loaded preset; nothing when another preset is loaded now. */
const changed = (before: ToneSnapshot, after: ToneSnapshot) => (before.index === after.index ? comparePresets(before.preset, after.preset) : []);

/** One provider's key: how to get it, or the saved one with a way to remove it. */
function KeySetup({ setup, saved, kept, onSaved, onRemove }: { setup: (typeof SETUP)[number]; saved: string | null; kept: boolean; onSaved: (key: string, kept: boolean) => void; onRemove: () => void }) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'testing' | 'invalid' | 'unavailable'>('idle');
  const name = PROVIDER_NAME[setup.provider];
  const add = async () => {
    const candidate = input.trim();
    if (!candidate) return;
    setStatus('testing');
    const result = await setup.test(candidate);
    if (result !== 'ok') return setStatus(result);
    const kept = saveKey(setup.provider, candidate);
    setInput('');
    setStatus('idle');
    onSaved(candidate, kept);
  };
  return (
    <section className="assistant-provider" aria-label={t('assistant.providerAria', { provider: name })}>
      <h3>{name} <span className="muted small">{t(setup.note)}</span></h3>
      {saved ? (
        <p className="assistant-saved">
          <span>{t(kept ? 'assistant.keySaved' : 'assistant.keyNotKept', { key: maskKey(saved) })}</span>
          <button type="button" className="btn btn-small" onClick={onRemove}>{t('assistant.removeKey')}</button>
        </p>
      ) : (
        <>
          <ol className="steps assistant-steps">
            {setup.steps.map((s, i) => (
              <li key={s}>{t(s)}{i === 0 && <> <a href={setup.link} target="_blank" rel="noreferrer">{t(setup.linkText)}</a></>}</li>
            ))}
          </ol>
          <form className="assistant-key" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <label className="field">
              <span>{t(setup.label)}</span>
              <input type="password" value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off" spellCheck={false} placeholder={setup.placeholder} />
            </label>
            <button type="submit" className="btn btn-primary" disabled={!input.trim() || status === 'testing'}>
              {status === 'testing' ? t('assistant.testing') : t('assistant.saveKey')}
            </button>
          </form>
          {status === 'invalid' && <p className="alert" role="alert">{t('assistant.keyInvalid', { provider: name })}</p>}
          {status === 'unavailable' && <p className="alert" role="alert">{t('assistant.keyUnavailable', { provider: name })}</p>}
        </>
      )}
    </section>
  );
}

/** Chat that builds tones on the pedal from a description, with the person's own free AI keys. */
export function AssistantPanel({ host, liveEdit, onLiveEdit }: Props) {
  const { t, lang } = useI18n();
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  /** Keys the browser refused to store: they last for this page only. */
  const [notKept, setNotKept] = useState<readonly Provider[]>([]);
  const [managing, setManaging] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [working, setWorking] = useState(false);
  const [cooldown, setCooldown] = useState<Cooldown>({});
  const [limits, setLimits] = useState<Partial<Record<AiModel, { remaining: number; limit: number }>>>({});
  const [needLive, setNeedLive] = useState(false);
  const usage = useAiUsage();
  const warnedKeys = useRef(new Set<Provider>());
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored: Partial<Record<Provider, string>> = {};
    for (const p of ['groq', 'gemini'] as const) {
      const k = loadKey(p);
      if (k) stored[p] = k;
    }
    setKeys(stored);
  }, []);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'nearest' }); }, [messages, working]);
  useEffect(() => { if (liveEdit) setNeedLive(false); }, [liveEdit]);

  const time = (d: Date) => d.toLocaleTimeString(lang === 'pt' ? 'pt-BR' : 'en', { hour: '2-digit', minute: '2-digit' });
  const label = (d: Difference) => (d.what === 'param' ? d.name : t(DIFF_KEY[d.what]));
  const hasKey = Object.keys(keys).length > 0;

  const send = async () => {
    const message = draft.trim();
    if (!message || !hasKey || working) return;
    setDraft('');
    setMessages((m) => [...m, { role: 'user', text: message }]);
    setWorking(true);
    let before: ToneSnapshot | null = null;
    try {
      before = host.snapshot();
      const result = await ask({
        keys, cooldown, converse: CONVERSE, turns, message, host,
        onRequest: (model) => recordRequest(model),
        onCooldown: setCooldown,
        onLimits: (model, remaining, limit) => setLimits((l) => ({ ...l, [model]: { remaining, limit } })),
        onStep: (_tool, ok, text) => { if (!ok && text.includes('Live edit is off')) setNeedLive(true); },
      });
      setCooldown(result.cooldown);
      const reply = result.reply || '…';
      // A key the provider refused, while another provider answered: say it once, or it fails silently on every message.
      const refused = result.badKeys.filter((p) => !warnedKeys.current.has(p));
      refused.forEach((p) => warnedKeys.current.add(p));
      setTurns((h) => [...h, { role: 'user', text: message }, { role: 'assistant', text: reply }]);
      setMessages((m) => [
        ...m,
        ...refused.map((p): Message => ({ role: 'error', text: t('assistant.keyRejected', { provider: PROVIDER_NAME[p] }) })),
        { role: 'assistant', text: reply, model: result.model, changes: changed(before!, host.snapshot()) },
      ]);
    } catch (error) {
      const text = error instanceof QuotaError && error.partial && error.model ? t('assistant.quotaPartial', { model: MODELS[error.model].name })
        : error instanceof QuotaError ? t('assistant.quotaAll', { time: time(error.retryAt) })
        : error instanceof KeyError ? t('assistant.keyRejected', { provider: PROVIDER_NAME[error.provider] })
        : error instanceof RegionError ? t('assistant.region')
          : t('assistant.error', { reason: error instanceof Error ? error.message : String(error) });
      // The next answer is told this one was cut, so a model does not lose the request (the preset it gets is current).
      setTurns((h) => [...h, { role: 'user', text: message }, { role: 'assistant', text: `(This answer was interrupted: ${error instanceof Error ? error.message : String(error)})` }]);
      const link = error instanceof RegionError ? { href: REGIONS, text: t('assistant.regionLink') } : undefined;
      setMessages((m) => [...m, { role: 'error', text, link, changes: before ? changed(before, host.snapshot()) : [] }]);
    } finally {
      setWorking(false);
    }
  };

  const now = new Date();
  const usageLine = (model: AiModel) => {
    const info = MODELS[model];
    const until = cooldown[model];
    if (until && until > now) return t('assistant.paused', { model: info.name, time: time(until) });
    const known = limits[model];
    if (known) return t('assistant.left', { model: info.name, remaining: known.remaining, limit: known.limit });
    const used = usedToday(usage, model, now);
    return info.pacificReset
      ? t('assistant.usedReset', { model: info.name, used, limit: info.limit, time: time(nextReset(now)) })
      : t('assistant.used', { model: info.name, used, limit: info.limit });
  };

  return (
    <section className="panel assistant" aria-label={t('assistant.title')}>
      <header className="panel-head">
        <h2>{t('assistant.title')}</h2>
        {hasKey && (
          <div className="assistant-head-actions">
            {!managing && messages.length > 0 && <button type="button" className="btn btn-small" onClick={() => { setMessages([]); setTurns([]); }}>{t('assistant.new')}</button>}
            <button type="button" className="btn btn-small" disabled={working} onClick={() => setManaging(!managing)}>{t(managing ? 'assistant.backToChat' : 'assistant.keys')}</button>
          </div>
        )}
      </header>
      <div className="assistant-body">
        {!hasKey || managing ? (
          <>
            {!hasKey && <p>{t('assistant.intro')}</p>}
            <p className="muted small">{t('assistant.setupHint')}</p>
            {SETUP.map((s) => (
              <KeySetup key={s.provider} setup={s} saved={keys[s.provider] ?? null} kept={!notKept.includes(s.provider)}
                onSaved={(k, kept) => {
                  setKeys((all) => ({ ...all, [s.provider]: k }));
                  setNotKept((list) => (kept ? list.filter((p) => p !== s.provider) : [...list, s.provider]));
                }}
                onRemove={() => {
                  removeKey(s.provider);
                  warnedKeys.current.delete(s.provider);
                  const { [s.provider]: _gone, ...rest } = keys;
                  setKeys(rest);
                  if (Object.keys(rest).length === 0) setManaging(false); // the next key added goes straight to the chat
                }} />
            ))}
            <p className="muted small">{t('assistant.privacy')}</p>
          </>
        ) : (
          <>
            {messages.length === 0 && (
              <div className="assistant-examples">
                <p className="muted">{t('assistant.hint')}</p>
                {EXAMPLES.map((k) => (
                  <button key={k} type="button" className="btn btn-small" onClick={() => { setDraft(t(k)); input.current?.focus(); }}>{t(k)}</button>
                ))}
              </div>
            )}
            <ol className="assistant-messages" aria-live="polite">
              {messages.map((m, i) => (
                <li key={i} className={`assistant-message is-${m.role}`}>
                  <p>{m.text}{m.link && <> <a href={m.link.href} target="_blank" rel="noreferrer">{m.link.text}</a></>}</p>
                  {m.changes && m.changes.length > 0 && <Changes differences={m.changes} label={label} title={t('assistant.changes')} />}
                  {m.model && <p className="muted small assistant-via">{t('assistant.via', { model: MODELS[m.model].name })}</p>}
                </li>
              ))}
              {working && <li className="assistant-message is-assistant"><p className="muted">{t('assistant.thinking')}</p></li>}
            </ol>
            <div ref={end} />
            {needLive && !liveEdit && (
              <p className="notice assistant-live">
                {t('assistant.needLive')} <button type="button" className="btn btn-small btn-primary" onClick={onLiveEdit}>{t('assistant.turnOnLive')}</button>
              </p>
            )}
            <form className="assistant-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('assistant.placeholder')} aria-label={t('assistant.inputAria')} disabled={working} />
              <button type="submit" className="btn btn-primary" disabled={working || !draft.trim()}>{t('assistant.send')}</button>
            </form>
            <ul className="muted small assistant-usage">
              {ROUTE.filter((m) => keys[providerOf(m)]).map((m) => <li key={m}>{usageLine(m)}</li>)}
            </ul>
            <p className="muted small">
              {t('assistant.realUsage')}{' '}
              {SETUP.filter((s) => keys[s.provider]).map((s, i) => (
                <span key={s.provider}>{i > 0 && ' · '}<a href={s.usage} target="_blank" rel="noreferrer">{PROVIDER_NAME[s.provider]}</a></span>
              ))}
            </p>
            <p className="muted small">{t('assistant.privacy')}</p>
          </>
        )}
      </div>
    </section>
  );
}
