import { useEffect, useMemo, useState } from 'react';
import { I, PanelHead, PhButton, PhInput, Pill, useToast } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';

/**
 * The "Providers" panel is now a working connection manager. Each connection
 * stores enough to make real API calls: a label, the wire protocol
 * (`openai` covers OpenAI plus every compatible vendor — OpenRouter, Groq,
 * Mistral, DeepSeek, Together, Gemini-compat, Ollama, LM Studio, vLLM,
 * llama.cpp; `anthropic` is the native Messages API), a base URL, an API key,
 * and the default model identifier.
 *
 * We deliberately do NOT ship a hardcoded list of vendors or models. The user
 * types a model string (or fetches the live list from the vendor with the
 * "Fetch models" button) so adding a new vendor or model NEVER requires a
 * new app release.
 */
interface Connection {
  id: string;
  label: string;
  kind: string;
  baseUrl: string;
  apiKeyTail: string;
  hasKey: boolean;
  defaultModel: string;
  isDefault: boolean;
  extraHeaders: string;
  lastUsedAt: string;
  notes: string;
}

interface ConnectionDraft {
  id: string | null;
  label: string;
  kind: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  isDefault: boolean;
  extraHeaders: string;
  notes: string;
}

const PRESETS: Record<string, { label: string; baseUrl: string; kind: 'openai' | 'anthropic'; model: string }> = {
  openai:     { label: 'OpenAI',       baseUrl: 'https://api.openai.com/v1',           kind: 'openai',    model: 'gpt-4o-mini' },
  anthropic:  { label: 'Anthropic',    baseUrl: 'https://api.anthropic.com',           kind: 'anthropic', model: 'claude-sonnet-4-6' },
  openrouter: { label: 'OpenRouter',   baseUrl: 'https://openrouter.ai/api/v1',        kind: 'openai',    model: 'openai/gpt-4o-mini' },
  groq:       { label: 'Groq',         baseUrl: 'https://api.groq.com/openai/v1',      kind: 'openai',    model: 'llama-3.3-70b-versatile' },
  mistral:    { label: 'Mistral',      baseUrl: 'https://api.mistral.ai/v1',           kind: 'openai',    model: 'mistral-small-latest' },
  deepseek:   { label: 'DeepSeek',     baseUrl: 'https://api.deepseek.com/v1',         kind: 'openai',    model: 'deepseek-chat' },
  together:   { label: 'Together',     baseUrl: 'https://api.together.xyz/v1',         kind: 'openai',    model: '' },
  gemini:     { label: 'Gemini',       baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', kind: 'openai', model: 'gemini-2.0-flash' },
  ollama:     { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1',         kind: 'openai',    model: 'llama3.2' },
  lmstudio:   { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1',       kind: 'openai',    model: '' },
};

const emptyDraft = (): ConnectionDraft => ({
  id: null,
  label: '',
  kind: 'openai',
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
  isDefault: false,
  extraHeaders: '',
  notes: '',
});

export function ProvidersPanel() {
  const toast = useToast();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // Inline feedback for state directly tied to the form (Save / Test) — toasts
  // are reserved for transient app-level events (import/export, connection
  // works, etc.). Inline keeps Save context next to the editor.
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);

  const reload = () =>
    invokeCommand<Connection[]>('list_connections')
      .then(setConnections)
      .catch(() => setConnections([]));

  useEffect(() => {
    reload();
  }, []);

  const isEditing = draft !== null;

  const applyPreset = (key: string) => {
    const p = PRESETS[key];
    if (!p || !draft) return;
    setDraft({
      ...draft,
      label: draft.label || p.label,
      kind: p.kind,
      baseUrl: p.baseUrl,
      defaultModel: draft.defaultModel || p.model,
    });
    setModels([]);
  };

  const save = async () => {
    if (!draft) return;
    setBusy('save');
    setFeedback(null);
    try {
      await invokeCommand<Connection>('save_connection', { input: draft });
      await reload();
      setDraft(null);
      setFeedback({ kind: 'ok', msg: 'Saved.' });
    } catch (e) {
      setFeedback({ kind: 'err', msg: errorMsg(e) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(`del:${id}`);
    try {
      await invokeCommand<void>('delete_connection', { id });
      setSelected((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const removeSelected = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} connection${selected.size === 1 ? '' : 's'}? Their API keys will be removed from the keyring too.`)) {
      return;
    }
    setBusy('bulk:del');
    try {
      // Serial — each deletion touches the keyring; running them in parallel
      // can race the platform credential store on some backends.
      for (const id of selected) {
        try {
          await invokeCommand<void>('delete_connection', { id });
        } catch (e) {
          toast.err(`Failed to delete ${id}: ${errorMsg(e)}`);
        }
      }
      setSelected(new Set());
      await reload();
      toast.ok('Selected connections deleted.');
    } finally {
      setBusy(null);
    }
  };

  const toggleOne = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () =>
    setSelected((s) =>
      s.size === connections.length ? new Set() : new Set(connections.map((c) => c.id))
    );

  const test = async (id: string) => {
    setBusy(`test:${id}`);
    const label = connections.find((c) => c.id === id)?.label ?? 'Connection';
    try {
      const r = await invokeCommand<{ model: string; latencyMs: number }>(
        'test_connection',
        { id }
      );
      toast.ok(`${r.model} · ${r.latencyMs}ms`, `${label} works`);
    } catch (e) {
      toast.err(errorMsg(e), `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  const setDefault = async (id: string) => {
    setBusy(`def:${id}`);
    try {
      await invokeCommand<void>('set_default_connection', { id });
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const fetchModels = async () => {
    if (!draft?.id) {
      setFeedback({ kind: 'err', msg: 'Save the connection first, then fetch models.' });
      return;
    }
    setBusy('models');
    setFeedback(null);
    try {
      const list = await invokeCommand<string[]>('list_connection_models', { id: draft.id });
      setModels(list);
      if (list.length === 0) {
        setFeedback({ kind: 'err', msg: 'Vendor returned no models.' });
      }
    } catch (e) {
      setFeedback({ kind: 'err', msg: errorMsg(e) });
    } finally {
      setBusy(null);
    }
  };

  const exportConnections = async () => {
    try {
      const payload = await invokeCommand<unknown>('export_connections');
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vibeprompter-connections-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.ok('Exported connections (API keys excluded).', 'Export complete');
    } catch (e) {
      toast.err(errorMsg(e), 'Export failed');
    }
  };

  const importConnections = () => {
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'application/json';
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        const payload = JSON.parse(text);
        const overwrite = window.confirm(
          'Overwrite existing connections that have matching IDs? Cancel to skip duplicates.'
        );
        const count = await invokeCommand<number>('import_connections', {
          payload,
          overwrite,
        });
        await reload();
        toast.ok(
          `Imported ${count} connection${count === 1 ? '' : 's'}. Add API keys before use.`,
          'Import complete'
        );
      } catch (e) {
        toast.err(errorMsg(e), 'Import failed');
      }
    };
    file.click();
  };

  const beginEdit = (c: Connection) => {
    setDraft({
      id: c.id,
      label: c.label,
      kind: (c.kind as 'openai' | 'anthropic') ?? 'openai',
      baseUrl: c.baseUrl,
      apiKey: '', // empty means "preserve existing"
      defaultModel: c.defaultModel,
      isDefault: c.isDefault,
      extraHeaders: c.extraHeaders ?? '',
      notes: c.notes ?? '',
    });
    setModels([]);
    setKeyVisible(false);
    setFeedback(null);
  };

  const presetEntries = useMemo(() => Object.entries(PRESETS), []);

  return (
    <div className="flex flex-col gap-6">
      <PanelHead
        title="Provider connections"
        sub="Connect any OpenAI-compatible vendor or the native Anthropic API. Models are free-text — fetch them live from the vendor instead of waiting for an app update."
      />

      {feedback && (
        <div
          className="rounded-md px-3 py-2 text-[12.5px]"
          style={{
            background:
              feedback.kind === 'ok'
                ? 'rgba(52,211,153,0.08)'
                : 'rgba(248,113,113,0.10)',
            color: feedback.kind === 'ok' ? 'var(--ok)' : 'var(--danger)',
            border: `.5px solid ${
              feedback.kind === 'ok' ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.30)'
            }`,
          }}
        >
          {feedback.msg}
        </div>
      )}

      {/* List */}
      {!isEditing && (
        <div className="flex flex-col gap-2">
          {connections.length === 0 && (
            <div
              className="rounded-lg px-5 py-6 text-[12.5px] text-fg-dim text-center"
              style={{ background: 'var(--surface)', border: '.5px dashed var(--border)' }}
            >
              No connections yet. Add one to start running real prompts.
            </div>
          )}
          {connections.length > 0 && (
            <div className="flex items-center gap-2 px-1 mb-1">
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === connections.length}
                ref={(el) => {
                  if (el) el.indeterminate = selected.size > 0 && selected.size < connections.length;
                }}
                onChange={toggleAll}
                title="Select all"
              />
              <span className="text-[11.5px] text-fg-dim">
                {selected.size > 0
                  ? `${selected.size} selected`
                  : `${connections.length} connection${connections.length === 1 ? '' : 's'}`}
              </span>
              {selected.size > 0 && (
                <PhButton
                  size="sm"
                  variant="danger"
                  icon={<I.trash size={12} />}
                  onClick={removeSelected}
                  disabled={busy === 'bulk:del'}
                >
                  {busy === 'bulk:del' ? 'Deleting…' : `Delete ${selected.size}`}
                </PhButton>
              )}
            </div>
          )}
          {connections.map((c) => (
            <div
              key={c.id}
              className="rounded-lg p-4 flex items-center gap-3"
              style={{
                background: selected.has(c.id) ? 'var(--accent-tint)' : 'var(--surface)',
                border: `.5px solid ${selected.has(c.id) ? 'var(--accent-tint-2)' : 'var(--border)'}`,
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggleOne(c.id)}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[14px] font-semibold text-fg-strong truncate">
                    {c.label}
                  </span>
                  <Pill>{c.kind}</Pill>
                  {c.isDefault && <Pill tone="accent">default</Pill>}
                  {!c.hasKey && <Pill tone="warn">no key</Pill>}
                </div>
                <div className="text-[11.5px] text-fg-dim mt-1 ph-mono truncate">
                  {c.baseUrl} · {c.defaultModel || '(no default model)'}{' '}
                  {c.hasKey && `· key ${c.apiKeyTail}`}
                  {c.lastUsedAt && ` · used ${relativeTime(c.lastUsedAt)}`}
                </div>
                {c.notes && (
                  <div
                    className="text-[11.5px] text-fg-mute mt-1"
                    style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  >
                    {c.notes}
                  </div>
                )}
              </div>
              <PhButton
                size="sm"
                variant="ghost"
                onClick={() => test(c.id)}
                icon={<I.bolt size={12} />}
                disabled={busy === `test:${c.id}`}
              >
                {busy === `test:${c.id}` ? 'Testing…' : 'Test'}
              </PhButton>
              {!c.isDefault && (
                <PhButton
                  size="sm"
                  variant="ghost"
                  onClick={() => setDefault(c.id)}
                  disabled={busy === `def:${c.id}`}
                >
                  Set default
                </PhButton>
              )}
              <PhButton size="sm" variant="ghost" onClick={() => beginEdit(c)}>
                Edit
              </PhButton>
              <PhButton
                size="sm"
                variant="ghost"
                onClick={() => remove(c.id)}
                disabled={busy === `del:${c.id}`}
                icon={<I.trash size={12} />}
              >
                {''}
              </PhButton>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <PhButton
              variant="primary"
              size="md"
              icon={<I.plus size={14} />}
              onClick={() => {
                setDraft(emptyDraft());
                setKeyVisible(false);
                setFeedback(null);
              }}
            >
              Add connection
            </PhButton>
            <span className="flex-1" />
            <PhButton
              variant="ghost"
              size="md"
              icon={<I.upload size={14} />}
              onClick={importConnections}
              title="Import a connections JSON file (API keys not included)"
            >
              Import
            </PhButton>
            <PhButton
              variant="ghost"
              size="md"
              icon={<I.download size={14} />}
              onClick={exportConnections}
              disabled={connections.length === 0}
              title="Download a JSON file of all connections (API keys excluded)"
            >
              Export
            </PhButton>
          </div>
        </div>
      )}

      {/* Editor */}
      {isEditing && draft && (
        <div
          className="rounded-lg p-5 flex flex-col gap-4"
          style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-[14px] font-semibold text-fg-strong">
              {draft.id ? 'Edit connection' : 'New connection'}
            </h3>
            <span className="text-[11.5px] text-fg-dim">
              Quick start with a preset, then customize as needed.
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {presetEntries.map(([key, p]) => (
              <button
                key={key}
                type="button"
                onClick={() => applyPreset(key)}
                className="text-[11.5px] px-2 py-1 rounded transition-colors"
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

          <Field label="Label">
            <PhInput
              value={draft.label}
              onChange={(v) => setDraft({ ...draft, label: v })}
              placeholder="My OpenAI key"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
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
                  onClick={fetchModels}
                  disabled={busy === 'models'}
                  title="Ask the vendor for its current model list (requires saving first)"
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
              onClick={save}
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
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className="text-[10.5px] uppercase tracking-[0.10em] text-fg-dim font-semibold"
      >
        {label}
      </span>
      {children}
    </div>
  );
}

/** Warn (but never block) on obvious key/vendor mismatches. Pattern checks
    are heuristic — Ollama needs no key, OpenAI keys start with `sk-`,
    Anthropic with `sk-ant-`, Groq with `gsk_`, OpenRouter with `sk-or-`,
    Gemini AI Studio keys start with `AIza`. Heuristics are derived from
    the URL since `kind` only tells us protocol. */
function keyFormatHint(draft: { baseUrl: string; apiKey: string; kind: string }): string | null {
  const k = draft.apiKey.trim();
  if (!k) return null;
  const url = draft.baseUrl.toLowerCase();

  if (url.includes('api.openai.com') && !k.startsWith('sk-')) {
    return 'OpenAI keys usually start with "sk-". Double-check you pasted the right one.';
  }
  if (url.includes('api.anthropic.com') && !k.startsWith('sk-ant-')) {
    return 'Anthropic keys usually start with "sk-ant-".';
  }
  if (url.includes('groq.com') && !k.startsWith('gsk_')) {
    return 'Groq keys usually start with "gsk_".';
  }
  if (url.includes('openrouter.ai') && !k.startsWith('sk-or-')) {
    return 'OpenRouter keys usually start with "sk-or-".';
  }
  if (url.includes('generativelanguage.googleapis.com') && !k.startsWith('AIza')) {
    return 'Gemini AI Studio keys usually start with "AIza".';
  }
  if (url.includes('localhost') && k.length > 0) {
    return 'Local servers (Ollama / LM Studio) typically need no key.';
  }
  return null;
}

function relativeTime(rfc3339: string): string {
  if (!rfc3339) return '';
  const then = Date.parse(rfc3339);
  if (Number.isNaN(then)) return '';
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function isValidBaseUrl(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;
  if (/\s/.test(trimmed)) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isValidJsonObject(s: string): boolean {
  try {
    const v = JSON.parse(s);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    return Object.values(v).every((x) => typeof x === 'string');
  } catch {
    return false;
  }
}

function errorMsg(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
