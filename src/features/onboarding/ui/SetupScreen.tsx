import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  I,
  Kbd,
  PhButton,
  PhInput,
  ProviderGlyphs,
  SelectCard,
} from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';
import { useProvidersQuery, useModesQuery } from '../application/setup.query';
import { useValidateKeyMutation } from '../application/validateKey.command';
import type { ProviderId } from '../domain';
import { StepIndicator } from './StepIndicator';
import { GroupHead } from './GroupHead';

const GLYPHS: Record<ProviderId, () => React.ReactNode> = {
  openai: () => ProviderGlyphs.openai(20),
  anthropic: () => ProviderGlyphs.anthropic(18),
  gemini: () => ProviderGlyphs.gemini(20),
  ollama: () => ProviderGlyphs.ollama(20),
};

export function SetupScreen() {
  const navigate = useNavigate();
  const [provider, setProvider] = useState<ProviderId>('openai');
  const [apiKey, setApiKey] = useState('sk-proj-7Kx9_••••••••••••••••••••••••PqR4');
  const [keyVis, setKeyVis] = useState(false);
  const [validated, setValidated] = useState(true);
  const [defaultMode, setDefaultMode] = useState('developer');
  const [modeOpen, setModeOpen] = useState(false);

  const { data: providers = [] } = useProvidersQuery();
  const { data: modes = [] } = useModesQuery();
  const validate = useValidateKeyMutation();

  const onValidate = () =>
    validate.mutate(apiKey, { onSuccess: (r) => setValidated(r.valid) });

  return (
    <div
      className="ph-root overflow-auto min-h-screen"
      style={{
        background:
          'radial-gradient(60% 50% at 50% 0%, rgba(167,139,250,.07), transparent), var(--bg)',
      }}
    >
      <div className="max-w-[640px] mx-auto px-8 pt-10 pb-12 flex flex-col gap-6">
        {/* Welcome */}
        <div className="flex items-center gap-3.5 mb-1">
          <span className="ph-mark xl" />
          <div>
            <div
              className="text-[22px] font-semibold text-fg-strong"
              style={{ letterSpacing: '-0.02em' }}
            >
              Welcome to PromptHelper
            </div>
            <div className="text-[13.5px] text-fg-mute mt-0.5">
              Transform text anywhere on your PC using AI — three steps to go.
            </div>
          </div>
        </div>

        <StepIndicator
          steps={[
            { n: '1', label: 'Provider', done: true },
            { n: '2', label: 'API Key', done: true },
            { n: '3', label: 'Preferences', active: true },
          ]}
        />

        {/* Providers */}
        <section>
          <GroupHead
            title="AI Provider"
            hint="Choose where requests go. You can connect more later."
          />
          <div className="grid grid-cols-2 gap-2">
            {providers.map((p) => (
              <SelectCard
                key={p.id}
                icon={GLYPHS[p.id]()}
                title={p.name}
                hint={p.hint}
                accent={p.accent}
                selected={provider === p.id}
                onClick={() => setProvider(p.id)}
                status={
                  provider === p.id && (
                    <span className="text-accent">
                      <I.check size={14} sw={2.2} />
                    </span>
                  )
                }
              />
            ))}
          </div>
        </section>

        {/* API Key */}
        <section>
          <GroupHead
            title="API Key"
            hint="Stored locally in the OS keychain. Never sent to our servers."
          />
          <PhInput
            mono
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setValidated(false);
            }}
            type={keyVis ? 'text' : 'password'}
            placeholder="sk-…"
            size="lg"
            icon={<I.link size={14} />}
            suffix={
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setKeyVis((v) => !v)}
                  className="w-7 h-7 border-0 bg-transparent text-fg-mute flex items-center justify-center rounded-md cursor-pointer"
                >
                  {keyVis ? <I.eyeOff size={14} /> : <I.eye size={14} />}
                </button>
                <PhButton
                  size="sm"
                  variant={validated ? 'ghost' : 'subtle'}
                  icon={validated ? <I.check size={12} sw={2.4} /> : null}
                  onClick={onValidate}
                >
                  {validated ? 'Valid' : 'Validate'}
                </PhButton>
              </div>
            }
          />
          {validated && (
            <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-ok">
              <span className="dot ok" />
              Connected — 6 models available
            </div>
          )}
        </section>

        {/* Shortcut */}
        <section>
          <GroupHead
            title="Global Shortcut"
            hint="Press this anywhere to summon PromptHelper."
          />
          <div className="flex items-center gap-2.5 p-3.5 bg-surface border-[0.5px] border-border rounded-lg">
            <I.keyboard size={18} style={{ color: 'var(--fg-mute)' }} />
            <span className="flex-1 text-[13px] text-fg-mute">Open Command Palette</span>
            <Kbd keys={['Ctrl', 'Shift', 'Space']} size="lg" />
            <PhButton size="sm" variant="ghost">
              Change
            </PhButton>
          </div>
        </section>

        {/* Default mode */}
        <section>
          <GroupHead title="Default Mode" hint="Used when no mode is selected." />
          <div className="relative">
            <button
              type="button"
              onClick={() => setModeOpen((o) => !o)}
              className="w-full text-left cursor-pointer h-10 px-3.5 rounded-md flex items-center gap-2.5 text-fg text-[13.5px]"
              style={{
                background: 'var(--surface-2)',
                border: '.5px solid var(--border-strong)',
              }}
            >
              <I.layers size={14} style={{ color: 'var(--accent)' }} />
              {defaultMode.charAt(0).toUpperCase() + defaultMode.slice(1)}
              <span className="flex-1" />
              <I.chevD size={12} style={{ color: 'var(--fg-mute)' }} />
            </button>
            {modeOpen && (
              <div
                className="absolute left-0 right-0 p-1 rounded-md z-10 shadow-lg"
                style={{
                  top: 'calc(100% + 4px)',
                  background: 'var(--surface-2)',
                  border: '.5px solid var(--border-strong)',
                }}
              >
                {modes.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setDefaultMode(m.toLowerCase());
                      setModeOpen(false);
                    }}
                    className="w-full text-left h-[30px] px-2.5 border-0 rounded text-[13px] cursor-pointer"
                    style={{
                      background:
                        defaultMode === m.toLowerCase() ? 'var(--accent-tint)' : 'transparent',
                      color: defaultMode === m.toLowerCase() ? 'var(--accent)' : 'var(--fg)',
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Finish */}
        <div className="flex items-center gap-3 pt-3 border-t-[0.5px] border-divider">
          <span className="flex-1 text-[11.5px] text-fg-mute">
            You can change all of this later in Settings · <span className="kbd">⌘</span>
            <span className="kbd ml-px">,</span>
          </span>
          <PhButton
            variant="ghost"
            size="md"
            onClick={() => {
              invokeCommand<void>('mark_first_run_done')
                .catch(() => {})
                .finally(() => navigate('/'));
            }}
          >
            Skip for now
          </PhButton>
          <PhButton
            variant="primary"
            size="md"
            icon={<I.bolt size={14} />}
            onClick={() => {
              invokeCommand<void>('mark_first_run_done')
                .catch(() => {})
                .finally(() => navigate('/'));
            }}
          >
            Launch VibePrompter
          </PhButton>
        </div>
      </div>
    </div>
  );
}
