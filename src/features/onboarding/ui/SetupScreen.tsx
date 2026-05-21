import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { I, PhButton, PhInput, useToast, AppIcon, useGlobalLoader } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';
import { errorMessage } from '@shared/lib/utils';

/**
 * First-run onboarding. The job is one thing: get the user a working
 * connection so they can immediately do something. Pick a preset (or skip
 * to manual), paste a key, click "Save & finish" — we test the connection
 * and only on success mark the install onboarded and route to the dashboard.
 *
 * Skip-for-now is allowed (developers, demos, anyone who wants to configure
 * later) — `mark_first_run_done` still fires so we don't loop back here.
 *
 * Vendor presets and model defaults are kept in sync with the Providers
 * settings panel — same shape, same starter models — so the onboarding flow
 * and the Settings flow feel like the same form, not two near-duplicates.
 */
interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  kind: 'openai' | 'anthropic';
  defaultModel: string;
  keyHint: string;
}

const PRESETS: Preset[] = [
  { id: 'openai',     label: 'OpenAI',          baseUrl: 'https://api.openai.com/v1',                              kind: 'openai',    defaultModel: 'gpt-5-mini',                              keyHint: 'sk-…' },
  { id: 'anthropic',  label: 'Anthropic',       baseUrl: 'https://api.anthropic.com/v1',                           kind: 'anthropic', defaultModel: 'claude-sonnet-4-6',                       keyHint: 'sk-ant-…' },
  { id: 'openrouter', label: 'OpenRouter',      baseUrl: 'https://openrouter.ai/api/v1',                           kind: 'openai',    defaultModel: 'openai/gpt-5-mini',                       keyHint: 'sk-or-…' },
  { id: 'groq',       label: 'Groq',            baseUrl: 'https://api.groq.com/openai/v1',                         kind: 'openai',    defaultModel: 'llama-3.3-70b-versatile',                 keyHint: 'gsk_…' },
  { id: 'mistral',    label: 'Mistral',         baseUrl: 'https://api.mistral.ai/v1',                              kind: 'openai',    defaultModel: 'mistral-large-latest',                    keyHint: 'API key' },
  { id: 'deepseek',   label: 'DeepSeek',        baseUrl: 'https://api.deepseek.com/v1',                            kind: 'openai',    defaultModel: 'deepseek-chat',                           keyHint: 'API key' },
  { id: 'together',   label: 'Together',        baseUrl: 'https://api.together.xyz/v1',                            kind: 'openai',    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keyHint: 'API key' },
  { id: 'gemini',     label: 'Gemini',          baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', kind: 'openai',    defaultModel: 'gemini-flash-lite-latest',                keyHint: 'AIza…' },
  { id: 'xai',        label: 'xAI (Grok)',      baseUrl: 'https://api.x.ai/v1',                                    kind: 'openai',    defaultModel: 'grok-4',                                  keyHint: 'API key' },
  { id: 'ollama',     label: 'Ollama (local)',  baseUrl: 'http://localhost:11434/v1',                              kind: 'openai',    defaultModel: 'llama3.3',                                keyHint: '(none — local server)' },
  { id: 'lmstudio',   label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1',                             kind: 'openai',    defaultModel: '',                                        keyHint: '(none — local server)' },
];

export function SetupScreen() {
  const navigate = useNavigate();
  const toast = useToast();
  const loader = useGlobalLoader();
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [label, setLabel] = useState(PRESETS[0].label);
  const [apiKey, setApiKey] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const [model, setModel] = useState(PRESETS[0].defaultModel);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'idle' | 'saving' | 'testing'>('idle');
  const [showProxyHelp, setShowProxyHelp] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const pickPreset = (p: Preset) => {
    setPreset(p);
    setLabel(p.label);
    setModel(p.defaultModel);
  };

  const finishWithoutTest = async () => {
    setBusy(true);
    loader.show('Finishing setup...');
    try {
      await invokeCommand<void>('mark_first_run_done');
      navigate('/');
    } catch (e) {
      toast.err(errorMessage(e), 'Could not save setup state');
    } finally {
      setBusy(false);
      loader.hide();
    }
  };

  const finish = async () => {
    setBusy(true);
    setLastError(null);
    loader.show('Saving connection...');
    try {
      setStage('saving');
      const saved = await invokeCommand<{ id: string; label: string }>('save_connection', {
        input: {
          id: null,
          label: label.trim() || preset.label,
          kind: preset.kind,
          baseUrl: preset.baseUrl,
          apiKey: apiKey.trim(),
          defaultModel: model.trim() || preset.defaultModel,
          isDefault: true,
        },
      });

      // If they gave us a key, validate it immediately — fast feedback on
      // typos or wrong vendor. Local presets (Ollama with no key) skip this.
      if (apiKey.trim()) {
        setStage('testing');
        loader.show('Testing connection...');
        await invokeCommand<void>('test_connection', { id: saved.id });
      }

      await invokeCommand<void>('mark_first_run_done');
      toast.ok(
        `${saved.label} is set as your default connection.`,
        'You are all set'
      );
      navigate('/');
    } catch (e) {
      const msg = errorMessage(e);
      setLastError(msg);
      toast.err(msg, 'Setup failed');
    } finally {
      setBusy(false);
      setStage('idle');
      loader.hide();
    }
  };

  const presetEntries = useMemo(() => PRESETS, []);

  return (
    <div
      className="ph-root overflow-auto min-h-screen"
      style={{
        background:
          'radial-gradient(60% 50% at 50% 0%, rgba(167,139,250,.07), transparent), var(--bg)',
      }}
    >
      <div className="w-full px-8 pt-10 pb-12 flex flex-col gap-6">
        <header className="flex items-center gap-3.5 mb-1">
          <AppIcon size="xl" />
          <div className="flex-1">
            <h1 className="m-0 text-[26px] font-semibold text-fg-strong" style={{ letterSpacing: '-0.025em' }}>
              Welcome to VibePrompter
            </h1>
            <p className="m-0 text-fg-mute text-[13px] mt-1">
              Connect a model provider and you are ready to run prompts.
            </p>
          </div>
        </header>

        <section
          className="rounded-xl p-5 flex flex-col gap-4"
          style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-[14px] font-semibold text-fg-strong">New connection</h3>
            <span className="text-[11.5px] text-fg-dim">
              Quick start with a preset, then customize as needed.
            </span>
          </div>

          <div className="flex flex-col gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.08em] text-fg-dim font-semibold mb-1.5">Cloud Providers</div>
              <div className="flex flex-wrap gap-1.5">
                {presetEntries
                  .filter((p) => p.id !== 'ollama' && p.id !== 'lmstudio')
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => pickPreset(p)}
                      className="text-[11px] px-2.5 py-1 rounded transition-all duration-100 ease-out hover:scale-102"
                      style={{
                        background: preset.id === p.id ? 'var(--accent-tint)' : 'var(--surface-2)',
                        border: `.5px solid ${preset.id === p.id ? 'var(--accent-tint-2)' : 'var(--border)'}`,
                        color: preset.id === p.id ? 'var(--accent)' : 'var(--fg)',
                        cursor: 'pointer',
                      }}
                      title={p.baseUrl}
                    >
                      {p.label}
                    </button>
                  ))}
              </div>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-[0.08em] text-fg-dim font-semibold mb-1.5 flex items-center gap-1.5">
                Local Dev Servers
                <span className="text-[9px] lowercase px-1.5 py-0.5 rounded bg-surface-3 text-fg-mute font-normal">no internet required</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {presetEntries
                  .filter((p) => p.id === 'ollama' || p.id === 'lmstudio')
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => pickPreset(p)}
                      className="text-[11px] px-2.5 py-1 rounded transition-all duration-100 ease-out hover:scale-102 flex items-center gap-1"
                      style={{
                        background: preset.id === p.id ? 'var(--accent-tint)' : 'var(--surface-2)',
                        border: `.5px solid ${preset.id === p.id ? 'var(--accent-tint-2)' : 'var(--border)'}`,
                        color: preset.id === p.id ? 'var(--accent)' : 'var(--fg)',
                        cursor: 'pointer',
                      }}
                      title={p.baseUrl}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8 }}>
                        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                        <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                        <line x1="6" y1="6" x2="6.01" y2="6" />
                        <line x1="6" y1="18" x2="6.01" y2="18" />
                      </svg>
                      {p.label}
                    </button>
                  ))}
              </div>
            </div>
          </div>

          <Field label="Label">
            <PhInput value={label} onChange={setLabel} placeholder={preset.label} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Default model">
              <PhInput value={model} onChange={setModel} placeholder={preset.defaultModel || 'gpt-4o-mini, claude-sonnet-4-6, …'} mono />
            </Field>
            <Field label="Base URL">
              <PhInput value={preset.baseUrl} onChange={() => {}} disabled mono />
            </Field>
          </div>

          <Field label={`API key  ·  ${preset.keyHint}`}>
            <div className="flex gap-2 items-center">
              <PhInput
                value={apiKey}
                onChange={setApiKey}
                type={keyVisible ? 'text' : 'password'}
                placeholder={preset.keyHint}
              />
              <button
                type="button"
                onClick={() => setKeyVisible((v) => !v)}
                className="text-[11.5px] px-2 py-1 rounded"
                style={{
                  background: 'var(--surface-2)',
                  border: '.5px solid var(--border)',
                  color: 'var(--fg-mute)',
                  cursor: 'pointer',
                }}
                title={keyVisible ? 'Hide key' : 'Show key'}
              >
                {keyVisible ? <I.eyeOff size={14} /> : <I.eye size={14} />}
              </button>
            </div>
            <span className="text-[11.5px] text-fg-dim mt-1">
              Stored in your OS keyring (Windows Credential Manager / Keychain / libsecret).
              Never sent anywhere except {preset.label}.
            </span>
          </Field>
        </section>

        {lastError && <TestFailureHelp message={lastError} vendor={preset.label} />}

        <ProxyHelp expanded={showProxyHelp} onToggle={() => setShowProxyHelp((v) => !v)} />

        <div
          className="flex items-center gap-3 pt-3"
          style={{ borderTop: '.5px solid var(--divider)' }}
        >
          <span className="flex-1 text-[11.5px] text-fg-mute">
            You can add more connections, change keys, and customize prompt modes
            later in Settings.
          </span>
          <PhButton variant="ghost" size="md" onClick={finishWithoutTest} disabled={busy}>
            Skip for now
          </PhButton>
          <PhButton
            variant="primary"
            size="md"
            icon={busy ? undefined : <I.bolt size={14} />}
            onClick={finish}
            disabled={busy}
          >
            {stage === 'saving'
              ? 'Saving…'
              : stage === 'testing'
              ? 'Testing…'
              : 'Save & finish'}
          </PhButton>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10.5px] uppercase tracking-[0.10em] text-fg-dim font-semibold">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Disclosable "behind a corporate proxy?" callout. Most users skip it; the
 * collapsed state is one quiet line. Expanded, it explains the actual use
 * cases so users know whether to care, and tells them exactly where to
 * configure it (Settings → Advanced) so the onboarding form stays minimal.
 */
/**
 * Inline guidance shown when the setup test fails. Pattern-matches on the
 * error string to guess the most likely cause so users don't have to
 * Google the literal error message. Always includes a "could also be"
 * list so the guess being wrong doesn't strand them.
 */
function TestFailureHelp({ message, vendor }: { message: string; vendor: string }) {
  const lower = message.toLowerCase();
  type Cause = { title: string; body: React.ReactNode };
  const causes: Cause[] = [];
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid_api_key') ||
    lower.includes('invalid api key')
  ) {
    causes.push({
      title: 'API key is wrong or expired',
      body: (
        <>
          Double-check the key on <strong className="text-fg">{vendor}</strong>'s dashboard.
          Some vendors expire unused keys; a fresh key fixes that. Make sure you didn't
          paste a key from a different vendor (an OpenAI key won't work on Anthropic).
        </>
      ),
    });
  }
  if (
    lower.includes('404') ||
    lower.includes('model_not_found') ||
    lower.includes('model not found') ||
    lower.includes('does not exist')
  ) {
    causes.push({
      title: 'Default model is wrong for this account',
      body: (
        <>
          The model id you set isn't available on your {vendor} account — common when an
          account doesn't have access to the newest models yet. Try a more basic model
          (e.g. <code className="ph-mono">gpt-4o-mini</code> or{' '}
          <code className="ph-mono">claude-3-5-haiku</code>) or use the{' '}
          <strong className="text-fg">Fetch models</strong> button in{' '}
          <strong className="text-fg">Settings → Providers</strong> after Skip.
        </>
      ),
    });
  }
  if (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('billing')
  ) {
    causes.push({
      title: 'Quota or billing issue at the vendor',
      body: (
        <>
          {vendor} is rejecting requests for billing or rate-limit reasons. Check your
          account's billing page and quota usage. New free-tier accounts often need a
          payment method on file before any calls succeed.
        </>
      ),
    });
  }
  if (
    lower.includes('connection') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('dns') ||
    lower.includes('network')
  ) {
    causes.push({
      title: 'Network can’t reach the vendor',
      body: (
        <>
          Your machine couldn't connect to the {vendor} endpoint. Most common cause is a
          corporate proxy or VPN — open the <strong className="text-fg">Behind a corporate proxy?</strong>{' '}
          section below to fix that. Also check whether your firewall is blocking outbound
          HTTPS to {vendor}.
        </>
      ),
    });
  }
  if (causes.length === 0) {
    causes.push({
      title: 'Could be a few things',
      body: (
        <>
          The exact error from {vendor} is shown above. Common causes are listed below —
          start with the API key, then the model id, then network. You can always Skip
          for now and reconfigure in <strong className="text-fg">Settings → Providers</strong>{' '}
          once you've ruled some out.
        </>
      ),
    });
  }
  return (
    <section
      className="rounded-lg p-4 flex flex-col gap-3"
      style={{
        background: 'rgba(248,113,113,0.05)',
        border: '.5px solid rgba(248,113,113,0.30)',
      }}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
          style={{
            background: 'rgba(248,113,113,0.12)',
            color: 'var(--danger)',
          }}
        >
          <I.info size={14} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] font-semibold text-fg-strong">Test failed</div>
          <div
            className="text-[11.5px] mt-1 ph-mono"
            style={{ color: 'var(--danger)', wordBreak: 'break-word' }}
          >
            {message}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2 pl-9">
        <div className="text-[11px] uppercase tracking-[0.10em] text-fg-dim font-semibold">
          Most likely cause{causes.length === 1 ? '' : 's'}
        </div>
        {causes.map((c, i) => (
          <div key={i} className="text-[12px] text-fg-mute leading-relaxed">
            <div className="text-fg-strong font-medium mb-0.5">{c.title}</div>
            {c.body}
          </div>
        ))}
        <div className="text-[11px] text-fg-dim mt-1 italic">
          Tip: you can always Skip for now and revisit this in Settings → Providers.
        </div>
      </div>
    </section>
  );
}

function ProxyHelp({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <section
      className="rounded-lg p-4 flex flex-col gap-2"
      style={{
        background: 'var(--surface)',
        border: '.5px dashed var(--border)',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 text-left"
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          color: 'var(--fg)',
        }}
      >
        <span
          className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
          style={{
            background: 'var(--accent-tint)',
            color: 'var(--accent)',
            border: '.5px solid var(--accent-tint-2)',
          }}
        >
          <I.link size={14} />
        </span>
        <span className="flex-1 text-[12.5px] font-medium text-fg-strong">
          Behind a corporate proxy? Network requests blocked?
        </span>
        <span className="text-[11px] text-fg-dim ph-mono">
          {expanded ? 'hide' : 'learn more'}
        </span>
      </button>

      {expanded && (
        <div className="text-[12px] text-fg-mute mt-1 leading-relaxed">
          VibePrompter can route every outbound LLM call through an HTTP / HTTPS / SOCKS5
          proxy. Common reasons to use this:
          <ul className="mt-1.5 mb-1.5 pl-5 list-disc">
            <li>
              <strong className="text-fg">Corporate network</strong> — your company forces
              traffic through an authenticated proxy (Zscaler, Squid, Forcepoint).
              Without it, the Test button below will fail with a connection error.
            </li>
            <li>
              <strong className="text-fg">Geographic restrictions</strong> — your region
              blocks direct access to a vendor's API.
            </li>
            <li>
              <strong className="text-fg">Auditing / mitmproxy</strong> — you want a local
              gateway to log every prompt for compliance.
            </li>
          </ul>
          You can leave this for later — configure it in{' '}
          <strong className="text-fg-strong">Settings → Advanced → Custom proxy URL</strong>.
          If none of the above sounds like you, you don't need it.
        </div>
      )}
    </section>
  );
}
