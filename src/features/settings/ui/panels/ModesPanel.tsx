import { useEffect, useMemo, useState } from 'react';
import { I, PanelHead, PhButton, PhInput, Pill, Toggle, type IconName } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';

/**
 * Working Modes panel — full CRUD over the `prompt_modes` table. The user can
 * change the system prompt, temperature, max tokens, icon, and pin the mode
 * to a specific connection. The backend's `PromptService` honors all of this
 * end-to-end (clipboard hotkey, dashboard Run widget, future surfaces).
 */
interface Mode {
  id: string;
  name: string;
  desc: string;
  sys: string;
  temp: number;
  maxTok: number;
  provider?: string | null;
  iconName: string;
  tags: string;
  enabled: boolean;
}

interface Connection {
  id: string;
  label: string;
}

interface ActiveMode {
  id: string;
}

const ICON_CHOICES: IconName[] = [
  'bolt', 'wand', 'code', 'mail', 'pen', 'text',
  'summarize', 'shorten', 'formal', 'friendly', 'translate', 'expand',
];

const blank = (): Mode => ({
  id: '',
  name: '',
  desc: '',
  sys: '',
  temp: 0.5,
  maxTok: 1024,
  provider: null,
  iconName: 'bolt',
  tags: '',
  enabled: true,
});

/**
 * Curated starter prompts. Each template is a fully-functional mode that
 * works against any provider — users hit "Use" to drop a copy into the
 * editor where they can tweak. Tested system prompts beat blank
 * prompt-prompt-anxiety for new users by a mile.
 */
const TEMPLATES: Omit<Mode, 'enabled'>[] = [
  {
    id: '',
    name: 'Improve writing',
    desc: 'Polish grammar, clarity, and flow without changing meaning.',
    sys: 'You improve the writing of the user\'s text. Fix grammar, clarity, and flow. Keep the meaning, tone, and language exactly the same. Reply with ONLY the improved text — no preamble, no explanation, no quotes.',
    temp: 0.3,
    maxTok: 2048,
    provider: null,
    iconName: 'pen',
    tags: 'writing',
  },
  {
    id: '',
    name: 'Make concise',
    desc: 'Shorten text while preserving all key information.',
    sys: 'Rewrite the user\'s text to be as concise as possible without losing any key information. Drop filler, hedging, and redundancy. Reply with ONLY the shortened text.',
    temp: 0.3,
    maxTok: 1024,
    provider: null,
    iconName: 'shorten',
    tags: 'writing',
  },
  {
    id: '',
    name: 'Formal tone',
    desc: 'Rewrite text in a polished, professional voice.',
    sys: 'Rewrite the user\'s text in a polished, professional, formal voice suitable for business communication. Keep the meaning unchanged. Reply with ONLY the rewritten text.',
    temp: 0.4,
    maxTok: 2048,
    provider: null,
    iconName: 'formal',
    tags: 'writing',
  },
  {
    id: '',
    name: 'Friendly tone',
    desc: 'Rewrite text to sound warm and approachable.',
    sys: 'Rewrite the user\'s text to sound warm, friendly, and approachable. Keep it professional enough for work. Reply with ONLY the rewritten text.',
    temp: 0.5,
    maxTok: 2048,
    provider: null,
    iconName: 'friendly',
    tags: 'writing',
  },
  {
    id: '',
    name: 'Summarize',
    desc: 'Bullet-list of the most important points.',
    sys: 'Summarize the user\'s text as a tight bulleted list of the most important points. Use one short bullet per idea. No preamble.',
    temp: 0.3,
    maxTok: 1024,
    provider: null,
    iconName: 'summarize',
    tags: 'utility',
  },
  {
    id: '',
    name: 'Translate to English',
    desc: 'Natural English translation of the input.',
    sys: 'Translate the user\'s text to natural, fluent English. Preserve tone and meaning. Reply with ONLY the translated text.',
    temp: 0.3,
    maxTok: 2048,
    provider: null,
    iconName: 'translate',
    tags: 'translation',
  },
  {
    id: '',
    name: 'Explain like I\'m 5',
    desc: 'Plain-language explanation of complex text.',
    sys: 'Explain the user\'s text in plain language a smart 12-year-old would understand. Use short sentences and concrete examples. No jargon. No bulleted lists unless the original was a list.',
    temp: 0.5,
    maxTok: 2048,
    provider: null,
    iconName: 'sparkles',
    tags: 'utility',
  },
  {
    id: '',
    name: 'Code review',
    desc: 'Critique code for bugs, style, and readability.',
    sys: 'You are a senior software engineer reviewing the user\'s code. Identify bugs, security issues, performance problems, and readability improvements. Be specific — quote the relevant code when you flag something. Prioritize by impact: critical bugs first, nits last.',
    temp: 0.2,
    maxTok: 3072,
    provider: null,
    iconName: 'code',
    tags: 'code',
  },
];

export function ModesPanel() {
  const [modes, setModes] = useState<Mode[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [active, setActive] = useState<ActiveMode | null>(null);
  const [draft, setDraft] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const reload = () => {
    invokeCommand<Mode[]>('list_modes').then(setModes).catch(() => setModes([]));
    invokeCommand<Connection[]>('list_connections').then(setConnections).catch(() => {});
    invokeCommand<ActiveMode>('get_active_mode').then(setActive).catch(() => {});
  };

  useEffect(() => {
    reload();
  }, []);

  const isNew = !!draft && !modes.find((m) => m.id === draft.id);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      const payload: Mode = {
        ...draft,
        id: draft.id.trim() || slugify(draft.name),
      };
      if (!payload.id) throw new Error('name or id is required');
      if (!payload.name.trim()) throw new Error('name is required');
      await invokeCommand<Mode>('save_mode', { mode: payload });
      reload();
      setDraft(null);
    } catch (e) {
      setErr(typeof e === 'string' ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (m: Mode, next: boolean) => {
    setBusy(true);
    try {
      await invokeCommand<Mode>('save_mode', { mode: { ...m, enabled: next } });
      reload();
    } catch (e) {
      setErr(typeof e === 'string' ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Delete this mode? The tray will fall back to remaining modes.')) return;
    setBusy(true);
    try {
      await invokeCommand<void>('delete_mode', { id });
      reload();
    } finally {
      setBusy(false);
    }
  };

  const activate = (id: string) =>
    invokeCommand<void>('set_active_mode', { id }).then(reload).catch(() => {});

  const connectionLabel = (id?: string | null) =>
    connections.find((c) => c.id === id)?.label ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PanelHead
        title="Prompt modes"
        hint="A mode bundles a system prompt + sampling settings. Pick one as the active mode (tray, hotkey, dashboard) and prompts run with these settings. Optionally pin a mode to a specific connection."
      />

      {err && (
        <div
          className="rounded-md px-3 py-2 text-[12.5px]"
          style={{
            background: 'rgba(248,113,113,0.10)',
            color: 'var(--danger)',
            border: '.5px solid rgba(248,113,113,0.30)',
          }}
        >
          {err}
        </div>
      )}

      {!draft && (() => {
        const allTags = Array.from(
          new Set(
            modes
              .flatMap((m) => (m.tags ?? '').split(',').map((t) => t.trim()))
              .filter((t) => t.length > 0)
          )
        ).sort();
        const visible = tagFilter
          ? modes.filter((m) =>
              (m.tags ?? '')
                .split(',')
                .map((t) => t.trim())
                .includes(tagFilter)
            )
          : modes;
        return (
        <div className="flex flex-col gap-2">
          {allTags.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] text-fg-dim mr-1">Filter:</span>
              <button
                type="button"
                onClick={() => setTagFilter(null)}
                className="text-[11px] px-2 py-1 rounded transition-colors"
                style={{
                  background: tagFilter === null ? 'var(--accent-tint)' : 'var(--surface-2)',
                  color: tagFilter === null ? 'var(--accent)' : 'var(--fg-mute)',
                  border: `.5px solid ${tagFilter === null ? 'var(--accent-tint-2)' : 'var(--border)'}`,
                  cursor: 'pointer',
                }}
              >
                All ({modes.length})
              </button>
              {allTags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTagFilter(t)}
                  className="text-[11px] px-2 py-1 rounded transition-colors"
                  style={{
                    background: tagFilter === t ? 'var(--accent-tint)' : 'var(--surface-2)',
                    color: tagFilter === t ? 'var(--accent)' : 'var(--fg)',
                    border: `.5px solid ${tagFilter === t ? 'var(--accent-tint-2)' : 'var(--border)'}`,
                    cursor: 'pointer',
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          {visible.map((m) => {
            const Icon =
              (I as Record<string, React.ComponentType<{ size?: number }>>)[m.iconName] ?? I.bolt;
            const isActive = m.id === active?.id;
            const pinned = connectionLabel(m.provider);
            return (
              <div
                key={m.id}
                className="rounded-lg p-4 flex items-center gap-3"
                style={{
                  background: 'var(--surface)',
                  border: `.5px solid ${isActive ? 'var(--accent-tint-2)' : 'var(--border)'}`,
                  opacity: m.enabled ? 1 : 0.55,
                }}
              >
                <span
                  className="w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0"
                  style={{
                    background: 'var(--accent-tint)',
                    color: 'var(--accent)',
                  }}
                >
                  <Icon size={16} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] font-semibold text-fg-strong truncate">
                      {m.name}
                    </span>
                    {isActive && <Pill tone="accent">active</Pill>}
                    {!m.enabled && <Pill>disabled</Pill>}
                    {pinned && <Pill>{pinned}</Pill>}
                    {(m.tags ?? '')
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean)
                      .map((t) => (
                        <Pill key={t}>{t}</Pill>
                      ))}
                  </div>
                  <div className="text-[12px] text-fg-mute mt-0.5 truncate">{m.desc}</div>
                  <div className="text-[11px] text-fg-dim mt-1 ph-mono">
                    temp {m.temp} · max {m.maxTok} tok
                  </div>
                </div>
                <div
                  className="flex items-center gap-1.5"
                  title={
                    isActive
                      ? 'Active modes cannot be disabled — switch to another mode first.'
                      : m.enabled
                      ? 'Hide from tray, dashboard, and cycle rotation.'
                      : 'Show in tray, dashboard, and cycle rotation.'
                  }
                >
                  <Toggle
                    value={m.enabled}
                    onChange={(v) => toggleEnabled(m, v)}
                    disabled={busy || isActive}
                  />
                </div>
                {!isActive && m.enabled && (
                  <PhButton size="sm" variant="ghost" onClick={() => activate(m.id)}>
                    Make active
                  </PhButton>
                )}
                <PhButton
                  size="sm"
                  variant="ghost"
                  title="Duplicate this mode as a starting point for a variant"
                  onClick={() => {
                    // Strip id so save_mode generates a new one from the
                    // (modified) name. Suffix the name so it's obviously a copy.
                    setDraft({
                      ...m,
                      id: '',
                      name: `${m.name} (copy)`,
                    });
                    setErr(null);
                  }}
                >
                  Duplicate
                </PhButton>
                <PhButton
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft({ ...m });
                    setErr(null);
                  }}
                >
                  Edit
                </PhButton>
                <PhButton
                  size="sm"
                  variant="ghost"
                  icon={<I.trash size={12} />}
                  onClick={() => remove(m.id)}
                  disabled={busy}
                >
                  {''}
                </PhButton>
              </div>
            );
          })}
          <PhButton
            variant="primary"
            size="md"
            icon={<I.plus size={14} />}
            onClick={() => {
              setDraft(blank());
              setErr(null);
            }}
          >
            New mode
          </PhButton>

          <div
            className="rounded-lg p-4 flex flex-col gap-3 mt-2"
            style={{ background: 'var(--surface)', border: '.5px dashed var(--border)' }}
          >
            <div className="flex items-baseline justify-between">
              <h3 className="m-0 text-[12px] uppercase tracking-[0.10em] text-fg-dim font-semibold">
                Start from a template
              </h3>
              <span className="text-[11.5px] text-fg-dim">
                Drops a tested system prompt into the editor.
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {TEMPLATES.map((t) => {
                const Icon =
                  (I as Record<string, React.ComponentType<{ size?: number }>>)[t.iconName] ?? I.bolt;
                return (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => {
                      setDraft({ ...t, enabled: true });
                      setErr(null);
                    }}
                    className="rounded-md p-3 flex items-start gap-2.5 text-left transition-colors"
                    style={{
                      background: 'var(--bg-2)',
                      border: '.5px solid var(--border)',
                      color: 'var(--fg)',
                      cursor: 'pointer',
                    }}
                    title={t.desc}
                  >
                    <span
                      className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0"
                      style={{
                        background: 'var(--accent-tint)',
                        color: 'var(--accent)',
                      }}
                    >
                      <Icon size={14} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12.5px] font-medium text-fg-strong">
                        {t.name}
                      </span>
                      <span className="block text-[11px] text-fg-dim mt-0.5 truncate">
                        {t.desc}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        );
      })()}

      {draft && (
        <ModeEditor
          mode={draft}
          onChange={setDraft}
          connections={connections}
          isNew={isNew}
          busy={busy}
          onCancel={() => setDraft(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function ModeEditor({
  mode,
  onChange,
  connections,
  isNew,
  busy,
  onCancel,
  onSave,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  connections: Connection[];
  isNew: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const icons = useMemo(() => ICON_CHOICES, []);
  // Preview: send a one-shot completion using the current (unsaved) prompt
  // + temp + max_tokens through the connection override or workspace
  // default. Lets the user iterate on prompts without leaving the editor.
  const [previewInput, setPreviewInput] = useState('');
  const [previewOutput, setPreviewOutput] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const runPreview = async () => {
    if (!previewInput.trim() || previewBusy) return;
    setPreviewBusy(true);
    setPreviewErr(null);
    setPreviewOutput('');
    try {
      const args = {
        id: mode.provider ?? undefined,
        messages: [{ role: 'user', content: previewInput }],
        params: {
          temperature: mode.temp,
          maxTokens: mode.maxTok,
          system: mode.sys,
        },
      };
      // Use the existing per-connection complete command when override set;
      // otherwise the workspace default. Both paths return the same shape.
      const cmd = mode.provider ? 'complete' : 'complete_default';
      const result = await invokeCommand<{ text: string; model: string; latencyMs: number }>(
        cmd,
        args
      );
      setPreviewOutput(`${result.text}\n\n— ${result.model} · ${result.latencyMs}ms`);
    } catch (e) {
      setPreviewErr(typeof e === 'string' ? e : String(e));
      setPreviewOutput(null);
    } finally {
      setPreviewBusy(false);
    }
  };

  return (
    <div
      className="rounded-lg p-5 flex flex-col gap-4"
      style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-[14px] font-semibold text-fg-strong">
          {isNew ? 'New mode' : `Edit · ${mode.name || mode.id}`}
        </h3>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <PhInput value={mode.name} onChange={(v) => onChange({ ...mode, name: v })} placeholder="Code Review" />
        </Field>
        <Field label={isNew ? 'ID (auto from name)' : 'ID (immutable)'}>
          <PhInput
            value={mode.id}
            onChange={(v) => onChange({ ...mode, id: v })}
            placeholder="code-review"
            disabled={!isNew}
          />
        </Field>
      </div>

      <Field label="Short description">
        <PhInput
          value={mode.desc}
          onChange={(v) => onChange({ ...mode, desc: v })}
          placeholder="Critique code for bugs, style, and readability."
        />
      </Field>

      <Field label="Tags (comma-separated)">
        <PhInput
          value={mode.tags}
          onChange={(v) => onChange({ ...mode, tags: v })}
          placeholder="writing, casual"
        />
      </Field>

      <Field label="System prompt">
        <textarea
          value={mode.sys}
          onChange={(e) => onChange({ ...mode, sys: e.target.value })}
          rows={6}
          className="w-full text-[13px] resize-y rounded-md px-3 py-2 outline-none"
          style={{
            background: 'var(--bg-2)',
            border: '.5px solid var(--border-strong)',
            color: 'var(--fg)',
            fontFamily: 'var(--sans)',
            minHeight: 120,
          }}
          placeholder="You are a senior code reviewer. Focus on…"
        />
      </Field>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Temperature">
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={mode.temp}
            onChange={(e) => onChange({ ...mode, temp: Number(e.target.value) })}
            className="w-full text-[13px] rounded-md px-3 py-2 outline-none"
            style={{
              background: 'var(--bg-2)',
              border: '.5px solid var(--border-strong)',
              color: 'var(--fg)',
            }}
          />
        </Field>
        <Field label="Max tokens">
          <input
            type="number"
            min={1}
            max={32768}
            value={mode.maxTok}
            onChange={(e) => onChange({ ...mode, maxTok: Number(e.target.value) })}
            className="w-full text-[13px] rounded-md px-3 py-2 outline-none"
            style={{
              background: 'var(--bg-2)',
              border: '.5px solid var(--border-strong)',
              color: 'var(--fg)',
            }}
          />
        </Field>
        <Field label="Connection override">
          <select
            value={mode.provider ?? ''}
            onChange={(e) =>
              onChange({ ...mode, provider: e.target.value === '' ? null : e.target.value })
            }
            className="w-full text-[13px] rounded-md px-3 py-2 outline-none"
            style={{
              background: 'var(--bg-2)',
              border: '.5px solid var(--border-strong)',
              color: 'var(--fg)',
            }}
          >
            <option value="">(use default connection)</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Icon">
        <div className="flex flex-wrap gap-1.5">
          {icons.map((name) => {
            const IconCmp = I[name];
            const picked = mode.iconName === name;
            return (
              <button
                key={name}
                type="button"
                onClick={() => onChange({ ...mode, iconName: name })}
                className="w-9 h-9 rounded-md flex items-center justify-center transition-colors"
                style={{
                  background: picked ? 'var(--accent-tint)' : 'var(--surface-2)',
                  color: picked ? 'var(--accent)' : 'var(--fg)',
                  border: `.5px solid ${picked ? 'var(--accent-tint-2)' : 'var(--border)'}`,
                  cursor: 'pointer',
                }}
                title={name}
              >
                <IconCmp size={16} />
              </button>
            );
          })}
        </div>
      </Field>

      <div
        className="flex flex-col gap-2 pt-3"
        style={{ borderTop: '.5px solid var(--divider)' }}
      >
        <div className="flex items-baseline justify-between">
          <span className="text-[10.5px] uppercase tracking-[0.10em] text-fg-dim font-semibold">
            Preview
          </span>
          <span className="text-[11px] text-fg-dim">
            Runs against your unsaved settings. Not recorded to history.
          </span>
        </div>
        <textarea
          value={previewInput}
          onChange={(e) => setPreviewInput(e.target.value)}
          rows={2}
          placeholder="Paste sample text here, then click Preview…"
          className="w-full text-[12.5px] resize-y rounded-md px-3 py-2 outline-none"
          style={{
            background: 'var(--bg-2)',
            border: '.5px solid var(--border-strong)',
            color: 'var(--fg)',
            fontFamily: 'var(--sans)',
            minHeight: 56,
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              runPreview();
            }
          }}
        />
        {previewErr && (
          <div
            className="rounded-md px-3 py-2 text-[12px]"
            style={{
              background: 'rgba(248,113,113,0.08)',
              color: 'var(--danger)',
              border: '.5px solid rgba(248,113,113,0.30)',
            }}
          >
            {previewErr}
          </div>
        )}
        {previewOutput !== null && previewOutput !== '' && (
          <pre
            className="text-[12.5px] m-0 rounded-md p-3"
            style={{
              background: 'var(--bg-2)',
              border: '.5px solid var(--border)',
              color: 'var(--fg-strong)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 240,
              overflow: 'auto',
              fontFamily: 'var(--sans)',
            }}
          >
            {previewOutput}
          </pre>
        )}
        <div className="flex justify-end">
          <PhButton
            size="sm"
            variant="ghost"
            icon={<I.bolt size={12} />}
            onClick={runPreview}
            disabled={previewBusy || !previewInput.trim() || !mode.sys.trim()}
            title="Run a one-shot completion with the current draft settings (Ctrl+Enter)"
          >
            {previewBusy ? 'Running…' : 'Preview'}
          </PhButton>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2" style={{ borderTop: '.5px solid var(--divider)' }}>
        <span className="flex-1" />
        <PhButton variant="ghost" size="md" onClick={onCancel}>
          Cancel
        </PhButton>
        <PhButton
          variant="primary"
          size="md"
          icon={<I.check size={14} />}
          onClick={onSave}
          disabled={busy}
        >
          {busy ? 'Saving…' : isNew ? 'Create mode' : 'Save'}
        </PhButton>
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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
