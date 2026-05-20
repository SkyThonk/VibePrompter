import { useEffect, useMemo, useState } from 'react';
import { I, PanelHead, PhButton, PhInput, Pill, Toggle, type IconName } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';

/**
 * Modes panel. Two clear sections:
 *   - Built-in modes (Grammar, Summarize) — locked except for system prompt,
 *     sampling settings, pinned connection, and the enabled toggle. Cannot be
 *     renamed or deleted.
 *   - Your modes — full CRUD.
 *
 * The "New mode" button + search bar live at the top so the list stays the
 * focus of the page. The template picker is part of the create flow, not the
 * main list — it only appears once the user has clicked "New mode" and hasn't
 * yet picked a starting point.
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
  /** JSON object string of `{ "var": "default value" }`. Substituted into
   *  `sys` at run time wherever `{{var}}` appears. Empty `{}` if no
   *  variables. Kept as a string here to match the backend's storage
   *  shape and avoid round-trip drift through the IPC boundary. */
  variables: string;
  enabled: boolean;
  isSystem: boolean;
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
  variables: '{}',
  enabled: true,
  isSystem: false,
});

interface Template {
  name: string;
  desc: string;
  sys: string;
  temp: number;
  maxTok: number;
  iconName: IconName;
}

/** Curated starter prompts. Each one drops into a fresh draft as a starting
 *  point — the user owns the resulting mode and can edit anything. */
const TEMPLATES: Template[] = [
  { name: 'Blank',              desc: 'Start from an empty prompt.',                                  sys: '',                                                                                                                                                                                                                       temp: 0.5, maxTok: 1024, iconName: 'bolt' },
  { name: 'Improve writing',    desc: 'Polish grammar, clarity, and flow without changing meaning.',  sys: 'You improve the writing of the user\'s text. Fix grammar, clarity, and flow. Keep the meaning, tone, and language exactly the same. Reply with ONLY the improved text — no preamble, no explanation, no quotes.', temp: 0.3, maxTok: 2048, iconName: 'pen' },
  { name: 'Make concise',       desc: 'Shorten text while preserving all key information.',          sys: 'Rewrite the user\'s text to be as concise as possible without losing any key information. Drop filler, hedging, and redundancy. Reply with ONLY the shortened text.',                                              temp: 0.3, maxTok: 1024, iconName: 'shorten' },
  { name: 'Formal tone',        desc: 'Polished, professional voice.',                                sys: 'Rewrite the user\'s text in a polished, professional, formal voice suitable for business communication. Keep the meaning unchanged. Reply with ONLY the rewritten text.',                                          temp: 0.4, maxTok: 2048, iconName: 'formal' },
  { name: 'Friendly tone',      desc: 'Warm and approachable.',                                       sys: 'Rewrite the user\'s text to sound warm, friendly, and approachable. Keep it professional enough for work. Reply with ONLY the rewritten text.',                                                                  temp: 0.5, maxTok: 2048, iconName: 'friendly' },
  { name: 'Translate to English', desc: 'Natural English translation (auto-detects source language).', sys: 'You are a professional translator. Auto-detect the source language of the user\'s text — it could be any language. Translate it into natural, fluent English.\n\nHard rules:\n- Preserve tone, register, and intent of the original (formal stays formal, casual stays casual).\n- Preserve proper nouns, names, code identifiers, URLs, and numbers exactly.\n- Idioms: prefer the closest English equivalent over a literal translation.\n- If the input is already English (or mixed with English), translate only the non-English portions and leave the English parts unchanged.\n- Do not add notes about the source language or your translation choices.\n- Output ONLY the translated text — no preamble, no commentary, no surrounding quotes.', temp: 0.3, maxTok: 2048, iconName: 'translate' },
  { name: 'Explain like I\'m 5', desc: 'Plain-language explanation of complex text.',                  sys: 'Explain the user\'s text in plain language a smart 12-year-old would understand. Use short sentences and concrete examples. No jargon.',                                                                          temp: 0.5, maxTok: 2048, iconName: 'wand' },
  { name: 'Code review',        desc: 'Critique code for bugs, style, and readability.',              sys: 'You are a senior software engineer reviewing the user\'s code. Identify bugs, security issues, performance problems, and readability improvements. Be specific — quote the relevant code when you flag something.', temp: 0.2, maxTok: 3072, iconName: 'code' },
];

export function ModesPanel() {
  const [modes, setModes] = useState<Mode[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [active, setActive] = useState<ActiveMode | null>(null);
  const [draft, setDraft] = useState<Mode | null>(null);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const reload = () => {
    invokeCommand<Mode[]>('list_modes').then(setModes).catch(() => setModes([]));
    invokeCommand<Connection[]>('list_connections').then(setConnections).catch(() => {});
    invokeCommand<ActiveMode>('get_active_mode').then(setActive).catch(() => {});
  };

  useEffect(() => {
    reload();
  }, []);

  const isNew = !!draft && !modes.find((m) => m.id === draft.id);

  const beginNew = () => {
    setDraft(blank());
    setShowTemplatePicker(true);
    setErr(null);
  };

  const applyTemplate = (t: Template) => {
    setDraft({
      id: '',
      name: t.name === 'Blank' ? '' : t.name,
      desc: t.desc,
      sys: t.sys,
      temp: t.temp,
      maxTok: t.maxTok,
      provider: null,
      iconName: t.iconName,
      variables: '{}',
      enabled: true,
      isSystem: false,
    });
    setShowTemplatePicker(false);
  };

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
      setShowTemplatePicker(false);
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

  const remove = async (m: Mode) => {
    if (m.isSystem) return; // UI also hides the button — belt + suspenders.
    if (!window.confirm(`Delete "${m.name}"? The tray will fall back to the remaining modes.`)) return;
    setBusy(true);
    try {
      await invokeCommand<void>('delete_mode', { id: m.id });
      reload();
    } catch (e) {
      setErr(typeof e === 'string' ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connectionLabel = (id?: string | null) =>
    connections.find((c) => c.id === id)?.label ?? null;

  const reorder = async (id: string, direction: 'up' | 'down') => {
    setBusy(true);
    try {
      await invokeCommand<void>('reorder_mode', { id, direction });
      reload();
    } catch (e) {
      setErr(typeof e === 'string' ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  const matchesSearch = (m: Mode) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      m.name.toLowerCase().includes(q) ||
      m.desc.toLowerCase().includes(q)
    );
  };

  const systemModes = modes.filter((m) => m.isSystem).filter(matchesSearch);
  const userModes = modes.filter((m) => !m.isSystem).filter(matchesSearch);

  const renderRow = (m: Mode, idx?: number, list?: Mode[]) => {
    const Icon =
      (I as Record<string, React.ComponentType<{ size?: number }>>)[m.iconName] ?? I.bolt;
    const isActive = m.id === active?.id;
    const pinned = connectionLabel(m.provider);
    // Reorder controls only show on user rows that have a neighbor in
    // the matching direction. We pass `list` from the caller so the
    // "first / last" math is honest to filtered views (search applied).
    const canMoveUp = !m.isSystem && idx !== undefined && idx > 0;
    const canMoveDown =
      !m.isSystem && idx !== undefined && list !== undefined && idx + 1 < list.length;
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
          style={{ background: 'var(--accent-tint)', color: 'var(--accent)' }}
        >
          <Icon size={16} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-semibold text-fg-strong truncate">{m.name}</span>
            {isActive && <Pill tone="accent">active</Pill>}
            {m.isSystem && <Pill>built-in</Pill>}
            {!m.enabled && <Pill>disabled</Pill>}
            {pinned && <Pill>{pinned}</Pill>}
          </div>
          <div className="text-[12px] text-fg-mute mt-0.5 truncate">{m.desc}</div>
          <div className="text-[11px] text-fg-dim mt-1 ph-mono">
            temp {m.temp} · max {m.maxTok} tok
          </div>
        </div>
        {!m.isSystem && (
          <Toggle
            value={m.enabled}
            onChange={(v) => toggleEnabled(m, v)}
            disabled={busy || isActive}
          />
        )}
        {!m.isSystem && (
          <div
            className="flex flex-col"
            style={{ gap: 1 }}
            title="Reorder this mode"
          >
            <button
              type="button"
              onClick={() => reorder(m.id, 'up')}
              disabled={!canMoveUp || busy}
              aria-label="Move up"
              className="w-6 h-4 flex items-center justify-center rounded-t transition-colors"
              style={{
                background: 'var(--surface-2)',
                border: '.5px solid var(--border)',
                color: canMoveUp ? 'var(--fg-mute)' : 'var(--fg-dim)',
                cursor: canMoveUp ? 'pointer' : 'default',
                opacity: canMoveUp ? 1 : 0.4,
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              ▲
            </button>
            <button
              type="button"
              onClick={() => reorder(m.id, 'down')}
              disabled={!canMoveDown || busy}
              aria-label="Move down"
              className="w-6 h-4 flex items-center justify-center rounded-b transition-colors"
              style={{
                background: 'var(--surface-2)',
                border: '.5px solid var(--border)',
                color: canMoveDown ? 'var(--fg-mute)' : 'var(--fg-dim)',
                cursor: canMoveDown ? 'pointer' : 'default',
                opacity: canMoveDown ? 1 : 0.4,
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              ▼
            </button>
          </div>
        )}
        <PhButton
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft({ ...m });
            setShowTemplatePicker(false);
            setErr(null);
          }}
        >
          {m.isSystem ? 'Configure' : 'Edit'}
        </PhButton>
        {!m.isSystem && (
          <PhButton
            size="sm"
            variant="ghost"
            icon={<I.trash size={12} />}
            onClick={() => remove(m)}
            disabled={busy}
          >
            {''}
          </PhButton>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PanelHead
        title="Prompt modes"
        hint="A mode bundles a system prompt + sampling settings. Pick one as the active mode (tray, hotkey, dashboard) and prompts run with these settings."
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

      {!draft && (
        <>
          <div className="flex items-center gap-2">
            <PhButton
              variant="primary"
              size="md"
              icon={<I.plus size={14} />}
              onClick={beginNew}
            >
              New mode
            </PhButton>
            <div className="flex-1 max-w-[320px]">
              <PhInput
                value={search}
                onChange={setSearch}
                placeholder="Search modes…"
                icon={<I.search size={14} />}
              />
            </div>
            <span className="flex-1" />
            <span className="text-[11.5px] text-fg-dim">
              {modes.length} mode{modes.length === 1 ? '' : 's'}
            </span>
          </div>

          {systemModes.length > 0 && (
            <Section
              title="Built-in modes"
              hint="Shipped with the app. You can tune the prompt and sampling, but they can't be renamed or deleted."
            >
              {systemModes.map(renderRow)}
            </Section>
          )}

          <Section
            title="Your modes"
            hint={userModes.length === 0 ? 'No custom modes yet. Click “New mode” to create one.' : undefined}
          >
            {userModes.map((m, i) => renderRow(m, i, userModes))}
          </Section>
        </>
      )}

      {draft && showTemplatePicker && isNew && (
        <TemplatePicker
          onPick={applyTemplate}
          onCancel={() => {
            setDraft(null);
            setShowTemplatePicker(false);
          }}
        />
      )}

      {draft && !showTemplatePicker && (
        <ModeEditor
          mode={draft}
          onChange={setDraft}
          connections={connections}
          isNew={isNew}
          busy={busy}
          onCancel={() => {
            setDraft(null);
            setShowTemplatePicker(false);
          }}
          onSave={save}
        />
      )}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h3 className="m-0 text-[11px] uppercase tracking-[0.10em] text-fg-dim font-semibold">
          {title}
        </h3>
        {hint && <span className="text-[11.5px] text-fg-dim">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function TemplatePicker({
  onPick,
  onCancel,
}: {
  onPick: (t: Template) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="rounded-lg p-5 flex flex-col gap-4"
      style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="m-0 text-[14px] font-semibold text-fg-strong">Start from a template</h3>
          <span className="text-[11.5px] text-fg-dim">
            Pick a tested prompt as a starting point, or start blank.
          </span>
        </div>
        <PhButton
          size="sm"
          variant="ghost"
          icon={<I.chevL size={12} />}
          onClick={onCancel}
          title="Return to the mode list"
        >
          Back
        </PhButton>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {TEMPLATES.map((t) => {
          const Icon = (I as Record<string, React.ComponentType<{ size?: number }>>)[t.iconName] ?? I.bolt;
          return (
            <button
              key={t.name}
              type="button"
              onClick={() => onPick(t)}
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
                style={{ background: 'var(--accent-tint)', color: 'var(--accent)' }}
              >
                <Icon size={14} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[12.5px] font-medium text-fg-strong">{t.name}</span>
                <span className="block text-[11px] text-fg-dim mt-0.5 truncate">{t.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
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
  const locked = mode.isSystem; // Built-ins: prompt + sampling + provider only.
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
        params: { temperature: mode.temp, maxTokens: mode.maxTok, system: mode.sys },
      };
      const cmd = mode.provider ? 'complete' : 'complete_default';
      const result = await invokeCommand<{ text: string; model: string; latencyMs: number }>(cmd, args);
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
        <div className="flex items-center gap-2 min-w-0">
          <PhButton
            size="sm"
            variant="ghost"
            icon={<I.chevL size={12} />}
            onClick={onCancel}
            title="Discard unsaved changes and return to the mode list"
          >
            Back
          </PhButton>
          <h3 className="m-0 text-[14px] font-semibold text-fg-strong truncate">
            {isNew ? 'New mode' : `${locked ? 'Configure' : 'Edit'} · ${mode.name || mode.id}`}
          </h3>
          {locked && <Pill>built-in</Pill>}
        </div>
      </div>

      {!locked && (
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
      )}

      {!locked && (
        <Field label="Short description">
          <PhInput
            value={mode.desc}
            onChange={(v) => onChange({ ...mode, desc: v })}
            placeholder="Critique code for bugs, style, and readability."
          />
        </Field>
      )}

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
        <span className="text-[11px] text-fg-dim mt-1">
          Use{' '}
          <code className="ph-mono text-[10.5px]">{`{{variable_name}}`}</code> for
          placeholders. Set their default values just below — every run uses them.
        </span>
      </Field>

      <VariablesEditor mode={mode} onChange={onChange} />

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
            style={{ background: 'var(--bg-2)', border: '.5px solid var(--border-strong)', color: 'var(--fg)' }}
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
            style={{ background: 'var(--bg-2)', border: '.5px solid var(--border-strong)', color: 'var(--fg)' }}
          />
        </Field>
        <Field label="Default connection">
          <select
            value={mode.provider ?? ''}
            onChange={(e) =>
              onChange({ ...mode, provider: e.target.value === '' ? null : e.target.value })
            }
            className="w-full text-[13px] rounded-md px-3 py-2 outline-none"
            style={{ background: 'var(--bg-2)', border: '.5px solid var(--border-strong)', color: 'var(--fg)' }}
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

      {!locked && (
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
      )}

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

/** Regex matching `{{ident}}` placeholders. Identifier must start with
 *  a letter or `_`, then any number of alphanumerics / underscores —
 *  the rules MUST match the Rust `extract_names` in
 *  services/prompt_template.rs or the UI will show variables the backend
 *  doesn't substitute. */
const PLACEHOLDER_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

function extractPlaceholders(prompt: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of prompt.matchAll(PLACEHOLDER_RE)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function parseVarsJson(s: string): Record<string, string> {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = typeof val === 'string' ? val : String(val ?? '');
      }
      return out;
    }
  } catch {}
  return {};
}

/**
 * Renders one input row per `{{variable}}` discovered in the mode's
 * system prompt. The user types the default value once; every run of
 * this mode (via hotkey, dashboard, or per-connection override) gets
 * the placeholder substituted at call time on the Rust side. Editing
 * the prompt to add a new placeholder automatically grows this section
 * to include it (and removing a placeholder strips its stored value on
 * the next save by virtue of only rendering rows for present names).
 */
function VariablesEditor({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  const placeholders = useMemo(() => extractPlaceholders(mode.sys), [mode.sys]);
  if (placeholders.length === 0) return null;
  const current = parseVarsJson(mode.variables);
  const setValue = (name: string, value: string) => {
    const next = { ...current, [name]: value };
    // Don't persist keys for placeholders that no longer exist in the
    // prompt — keeps the JSON tidy and the editor predictable.
    const filtered: Record<string, string> = {};
    for (const k of placeholders) {
      filtered[k] = next[k] ?? '';
    }
    onChange({ ...mode, variables: JSON.stringify(filtered) });
  };
  return (
    <Field label="Variable defaults">
      <div
        className="rounded-md p-3 flex flex-col gap-2"
        style={{
          background: 'var(--bg-2)',
          border: '.5px solid var(--border)',
        }}
      >
        {placeholders.map((name) => (
          <div key={name} className="flex items-center gap-2.5">
            <code
              className="ph-mono text-[11.5px] px-2 py-1 rounded flex-shrink-0"
              style={{
                background: 'var(--surface)',
                color: 'var(--accent)',
                border: '.5px solid var(--accent-tint-2)',
                minWidth: 110,
              }}
              title={`Placeholder {{${name}}} in the prompt above`}
            >
              {`{{${name}}}`}
            </code>
            <PhInput
              value={current[name] ?? ''}
              onChange={(v) => setValue(name, v)}
              placeholder={`default value for ${name}`}
            />
          </div>
        ))}
        <span className="text-[11px] text-fg-dim mt-0.5">
          Every run substitutes these values into the prompt. Leave blank to send an
          empty string. Delete the placeholder from the prompt to remove a row.
        </span>
      </div>
    </Field>
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
