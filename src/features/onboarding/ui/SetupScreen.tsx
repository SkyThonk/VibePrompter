import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { I, PhButton, PhInput, useToast } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';

/**
 * First-run onboarding. The job is one thing: get the user a working
 * connection so they can immediately do something. Pick a preset (or skip
 * to manual), paste a key, click "Test & finish" — we test the connection
 * and only on success mark the install onboarded and route to the dashboard.
 *
 * Skip-for-now is allowed (developers, demos, anyone who wants to configure
 * later) — `mark_first_run_done` still fires so we don't loop back here.
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
  { id: 'openai',     label: 'OpenAI',         baseUrl: 'https://api.openai.com/v1',           kind: 'openai',    defaultModel: 'gpt-4o-mini',          keyHint: 'sk-…' },
  { id: 'anthropic',  label: 'Anthropic',      baseUrl: 'https://api.anthropic.com',           kind: 'anthropic', defaultModel: 'claude-sonnet-4-6',    keyHint: 'sk-ant-…' },
  { id: 'openrouter', label: 'OpenRouter',     baseUrl: 'https://openrouter.ai/api/v1',        kind: 'openai',    defaultModel: 'openai/gpt-4o-mini',   keyHint: 'sk-or-…' },
  { id: 'groq',       label: 'Groq',           baseUrl: 'https://api.groq.com/openai/v1',      kind: 'openai',    defaultModel: 'llama-3.3-70b-versatile', keyHint: 'gsk_…' },
  { id: 'gemini',     label: 'Gemini',         baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', kind: 'openai', defaultModel: 'gemini-2.0-flash', keyHint: 'AIza…' },
  { id: 'ollama',     label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1',           kind: 'openai',    defaultModel: 'llama3.2',             keyHint: '(none — local server)' },
];

export function SetupScreen() {
  const navigate = useNavigate();
  const toast = useToast();
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [label, setLabel] = useState(PRESETS[0].label);
  const [apiKey, setApiKey] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const [model, setModel] = useState(PRESETS[0].defaultModel);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'idle' | 'saving' | 'testing'>('idle');

  const pickPreset = (p: Preset) => {
    setPreset(p);
    setLabel(p.label);
    setModel(p.defaultModel);
  };

  const finishWithoutTest = async () => {
    setBusy(true);
    try {
      await invokeCommand<void>('mark_first_run_done');
    } catch {}
    setBusy(false);
    navigate('/');
  };

  const finish = async () => {
    setBusy(true);
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
        await invokeCommand<void>('test_connection', { id: saved.id });
      }

      await invokeCommand<void>('mark_first_run_done');
      toast.ok(
        `${saved.label} is set as your default connection.`,
        'You are all set'
      );
      navigate('/');
    } catch (e) {
      toast.err(typeof e === 'string' ? e : String(e), 'Setup failed');
    } finally {
      setBusy(false);
      setStage('idle');
    }
  };

  return (
    <div
      className="ph-root overflow-auto min-h-screen"
      style={{
        background:
          'radial-gradient(60% 50% at 50% 0%, rgba(167,139,250,.07), transparent), var(--bg)',
      }}
    >
      <div className="max-w-[640px] mx-auto px-8 pt-10 pb-12 flex flex-col gap-6">
        <header className="flex items-center gap-3.5 mb-1">
          <span className="ph-mark xl" />
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
          <Field label="Provider">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pickPreset(p)}
                  className="text-[12.5px] px-3 py-1.5 rounded-md transition-colors"
                  style={{
                    background: preset.id === p.id ? 'var(--accent-tint)' : 'var(--surface-2)',
                    color: preset.id === p.id ? 'var(--accent)' : 'var(--fg)',
                    border: `.5px solid ${preset.id === p.id ? 'var(--accent-tint-2)' : 'var(--border)'}`,
                    cursor: 'pointer',
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Label">
              <PhInput value={label} onChange={setLabel} placeholder={preset.label} />
            </Field>
            <Field label="Default model">
              <PhInput value={model} onChange={setModel} placeholder={preset.defaultModel} mono />
            </Field>
          </div>

          <Field label={`API key  (${preset.keyHint})`}>
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
                className="px-2 py-1 rounded"
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
