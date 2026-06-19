import { useMemo } from 'react';
import { I, PhButton, PhInput, FreeKeyCallout, GetKeyLink } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';
import { Field } from './Field';
import { PRESETS, type ConnectionDraft } from './connection';
import { isValidBaseUrl, isValidJsonObject, keyFormatHint } from './validation';

interface ConnectionEditorProps {
  draft: ConnectionDraft;
  setDraft: React.Dispatch<React.SetStateAction<ConnectionDraft | null>>;
  models: string[];
  busy: string | null;
  keyVisible: boolean;
  setKeyVisible: React.Dispatch<React.SetStateAction<boolean>>;
  advancedOpen: boolean;
  setAdvancedOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onApplyPreset: (key: string) => void;
  onFetchModels: () => void;
  onSave: () => void;
}

export function ConnectionEditor({
  draft,
  setDraft,
  models,
  busy,
  keyVisible,
  setKeyVisible,
  advancedOpen,
  setAdvancedOpen,
  onApplyPreset,
  onFetchModels,
  onSave,
}: ConnectionEditorProps) {
  const presetEntries = useMemo(() => Object.entries(PRESETS), []);
  // Match the draft's base URL back to a preset id so we can deep-link to that
  // vendor's API-key page. Null for custom/unknown endpoints.
  const providerId =
    presetEntries.find(([, p]) => p.baseUrl === draft.baseUrl.trim())?.[0] ?? null;
  const openUrl = (url: string) => {
    invokeCommand<void>('open_url', { url }).catch(() => {});
  };

  return (
    <div
      className="rounded-lg p-5 flex flex-col gap-4"
      style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <PhButton
            size="sm"
            variant="ghost"
            icon={<I.chevL size={12} />}
            onClick={() => setDraft(null)}
            title="Discard unsaved changes and return to the connection list"
          >
            Back
          </PhButton>
          <h3 className="m-0 text-[14px] font-semibold text-fg-strong truncate">
            {draft.id ? 'Edit connection' : 'New connection'}
          </h3>
        </div>
        <span className="text-[11.5px] text-fg-dim">
          Quick start with a preset, then customize as needed.
        </span>
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.08em] text-fg-dim font-semibold mb-1.5">Cloud Providers</div>
          <div className="flex flex-wrap gap-1.5">
            {presetEntries
              .filter(([key]) => key !== 'ollama' && key !== 'lmstudio')
              .map(([key, p]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => onApplyPreset(key)}
                  className="text-[11px] px-2.5 py-1 rounded transition-all duration-100 ease-out hover:scale-102"
                  style={{
                    background: 'var(--surface-2)',
                    border: '.5px solid var(--border)',
                    color: 'var(--fg)',
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
              .filter(([key]) => key === 'ollama' || key === 'lmstudio')
              .map(([key, p]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => onApplyPreset(key)}
                  className="text-[11px] px-2.5 py-1 rounded transition-all duration-100 ease-out hover:scale-102 flex items-center gap-1"
                  style={{
                    background: 'var(--surface-2)',
                    border: '.5px solid var(--border)',
                    color: 'var(--fg)',
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

      {!draft.id && <FreeKeyCallout onOpenUrl={openUrl} />}

      <Field label="Label">
        <PhInput
          value={draft.label}
          onChange={(v) => setDraft({ ...draft, label: v })}
          placeholder="My OpenAI key"
        />
      </Field>

      {(() => {
        const matchedPreset = presetEntries.find(
          ([, p]) => p.baseUrl === draft.baseUrl.trim()
        );
        const showProtocol = !matchedPreset;
        return (
          <div className={showProtocol ? 'grid grid-cols-2 gap-3' : ''}>
            {showProtocol && (
              <Field label="Protocol">
                <div className="flex gap-1.5">
                  {(['openai', 'anthropic'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setDraft({ ...draft, kind: k })}
                      className="text-[12.5px] px-2.5 py-1.5 rounded transition-colors flex-1"
                      style={{
                        background: draft.kind === k ? 'var(--accent-tint)' : 'var(--surface-2)',
                        color: draft.kind === k ? 'var(--accent)' : 'var(--fg)',
                        border: `.5px solid ${draft.kind === k ? 'var(--accent-tint-2)' : 'var(--border)'}`,
                        cursor: 'pointer',
                      }}
                    >
                      {k === 'openai' ? 'OpenAI-compatible' : 'Anthropic native'}
                    </button>
                  ))}
                </div>
              </Field>
            )}

            <Field label="Base URL">
              <PhInput
                value={draft.baseUrl}
                onChange={(v) => setDraft({ ...draft, baseUrl: v })}
                placeholder="https://api.openai.com/v1"
              />
              {draft.baseUrl.trim() && !isValidBaseUrl(draft.baseUrl) && (
                <span className="text-[11px] mt-1" style={{ color: 'var(--danger)' }}>
                  Must start with http:// or https://
                </span>
              )}
            </Field>
          </div>
        );
      })()}

      <Field label="API key">
        <div className="flex gap-2 items-center">
          <PhInput
            value={draft.apiKey}
            onChange={(v) => setDraft({ ...draft, apiKey: v })}
            type={keyVisible ? 'text' : 'password'}
            placeholder={
              draft.id ? '(leave blank to keep existing key)' : 'sk-…'
            }
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
          >
            {keyVisible ? <I.eyeOff size={14} /> : <I.eye size={14} />}
          </button>
        </div>
        {(() => {
          const warn = keyFormatHint(draft);
          return warn ? (
            <span className="text-[11px] mt-1" style={{ color: 'var(--warn)' }}>
              {warn}
            </span>
          ) : null;
        })()}
        {providerId && (
          <div className="mt-1.5">
            <GetKeyLink providerId={providerId} onOpenUrl={openUrl} />
          </div>
        )}
      </Field>

      <Field label="Default model">
        <div className="flex flex-col gap-2">
          <div className="flex gap-2 items-center">
            <PhInput
              value={draft.defaultModel}
              onChange={(v) => setDraft({ ...draft, defaultModel: v })}
              placeholder="gpt-4o-mini, claude-sonnet-4-6, llama3.2, anything…"
            />
            <PhButton
              size="sm"
              variant="ghost"
              onClick={onFetchModels}
              disabled={busy === 'models'}
              title="Ask the vendor for its current model list — works before saving so you can pick a model from the live catalog."
            >
              {busy === 'models' ? 'Fetching…' : 'Fetch models'}
            </PhButton>
          </div>
          {models.length > 0 && (
            <div
              className="rounded-md p-2 flex flex-wrap gap-1.5"
              style={{
                background: 'var(--surface-2)',
                border: '.5px solid var(--border)',
                maxHeight: 160,
                overflow: 'auto',
              }}
            >
              {models.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDraft({ ...draft, defaultModel: m })}
                  className="text-[11.5px] px-2 py-0.5 rounded ph-mono transition-colors"
                  style={{
                    background:
                      draft.defaultModel === m ? 'var(--accent-tint)' : 'var(--surface)',
                    color:
                      draft.defaultModel === m ? 'var(--accent)' : 'var(--fg)',
                    border: `.5px solid ${
                      draft.defaultModel === m ? 'var(--accent-tint-2)' : 'var(--border)'
                    }`,
                    cursor: 'pointer',
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
      </Field>

      <Field label="Tags (optional)">
        <PhInput
          value={draft.tags}
          onChange={(v) => setDraft({ ...draft, tags: v })}
          placeholder="work, personal, gpt"
        />
        <span className="text-[11px] text-fg-dim mt-1">
          Comma-separated. Helps filter the list when you have many connections.
        </span>
      </Field>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-2 text-left"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            color: 'var(--fg-mute)',
          }}
          aria-expanded={advancedOpen}
        >
          <I.cog size={12} />
          <span className="text-[11.5px] uppercase tracking-[0.10em] font-semibold">
            Advanced
          </span>
          <span className="text-[11px] ph-mono">
            {advancedOpen ? '− hide' : '+ show'}
          </span>
          <span className="text-[11px]" style={{ color: 'var(--fg-dim)' }}>
            Custom headers · pricing · notes
          </span>
        </button>

        {advancedOpen && (
          <>
            <Field label='Custom headers (JSON)'>
              <textarea
                value={draft.extraHeaders}
                onChange={(e) => setDraft({ ...draft, extraHeaders: e.target.value })}
                rows={3}
                placeholder='{ "HTTP-Referer": "https://vibeprompter.app", "X-Title": "VibePrompter" }'
                className="w-full text-[12.5px] resize-y rounded-md px-3 py-2 outline-none"
                style={{
                  background: 'var(--bg-2)',
                  border: '.5px solid var(--border-strong)',
                  color: 'var(--fg)',
                  fontFamily: 'var(--mono)',
                  minHeight: 64,
                }}
              />
              <span className="text-[11px] text-fg-dim mt-1">
                Sent with every request to this connection. Use for OpenRouter
                attribution, corporate gateway tokens, or vendor-specific opt-ins.
              </span>
              {draft.extraHeaders.trim() && !isValidJsonObject(draft.extraHeaders) && (
                <span className="text-[11px] mt-1" style={{ color: 'var(--danger)' }}>
                  Must be a JSON object with string values.
                </span>
              )}
            </Field>

            <Field label="Pricing override (USD per 1M tokens)">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11.5px] text-fg-dim w-12">Input</span>
                  <PhInput
                    mono
                    type="number"
                    value={String(draft.priceInputPerM)}
                    onChange={(v) => {
                      const n = Number(v);
                      setDraft({
                        ...draft,
                        priceInputPerM: Number.isFinite(n) && n >= 0 ? n : 0,
                      });
                    }}
                    placeholder="0.15"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11.5px] text-fg-dim w-12">Output</span>
                  <PhInput
                    mono
                    type="number"
                    value={String(draft.priceOutputPerM)}
                    onChange={(v) => {
                      const n = Number(v);
                      setDraft({
                        ...draft,
                        priceOutputPerM: Number.isFinite(n) && n >= 0 ? n : 0,
                      });
                    }}
                    placeholder="0.60"
                  />
                </div>
              </div>
              <span className="text-[11px] text-fg-dim mt-1">
                Set non-zero values to override the embedded pricing table for this connection.
                Leave at 0 to use the app's best-known prices for the model the vendor reports.
                Useful for models the embedded table doesn't know yet, or for negotiated rates.
              </span>
            </Field>

            <Field label="Notes (optional)">
              <textarea
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                rows={2}
                placeholder="Rate limit reminders, account ownership, anything you'd want to see again."
                className="w-full text-[12.5px] resize-y rounded-md px-3 py-2 outline-none"
                style={{
                  background: 'var(--bg-2)',
                  border: '.5px solid var(--border-strong)',
                  color: 'var(--fg)',
                  fontFamily: 'var(--sans)',
                  minHeight: 50,
                }}
              />
            </Field>
          </>
        )}
      </div>

      <label className="flex items-center gap-2 text-[12.5px] text-fg cursor-pointer">
        <input
          type="checkbox"
          checked={draft.isDefault}
          onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
        />
        Use this as the default connection for new prompts
      </label>

      <div className="flex items-center gap-2 pt-2" style={{ borderTop: '.5px solid var(--divider)' }}>
        <span className="flex-1" />
        <PhButton variant="ghost" size="md" onClick={() => setDraft(null)}>
          Cancel
        </PhButton>
        <PhButton
          variant="primary"
          size="md"
          icon={<I.check size={14} />}
          onClick={onSave}
          disabled={
            busy === 'save' ||
            !draft.label.trim() ||
            !isValidBaseUrl(draft.baseUrl) ||
            (draft.extraHeaders.trim() !== '' && !isValidJsonObject(draft.extraHeaders))
          }
        >
          {busy === 'save' ? 'Saving…' : draft.id ? 'Save' : 'Create connection'}
        </PhButton>
      </div>
    </div>
  );
}
