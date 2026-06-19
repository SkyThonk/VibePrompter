import { useEffect, useState } from 'react';
import { Hint, I, PanelHead, PhButton, PhInput } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';
import { errorMessage } from '@shared/lib/utils';
import { blank, slugify, type ActiveMode, type Connection, type Mode, type Template } from './modes/types';
import { Section } from './modes/Section';
import { TemplatePicker } from './modes/TemplatePicker';
import { ModeRow } from './modes/ModeRow';
import { ModeEditor } from './modes/ModeEditor';

/**
 * Modes panel. Two clear sections:
 *   - Built-in modes (Grammar, Summarize) — locked except for system prompt,
 *     sampling settings, pinned connection, and the enabled toggle. Cannot be
 *     renamed or deleted.
 *   - Your modes — full CRUD.
 *
 * This component is the stateful container: it owns the mode list, the editor
 * draft, and all backend calls. The list rows, template picker, and editor
 * live in `./modes/*`.
 */
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
      setErr(errorMessage(e));
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
      setErr(errorMessage(e));
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
      setErr(errorMessage(e));
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
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const beginEdit = (m: Mode) => {
    setDraft({ ...m });
    setShowTemplatePicker(false);
    setErr(null);
  };

  const cancelEdit = () => {
    setDraft(null);
    setShowTemplatePicker(false);
  };

  const matchesSearch = (m: Mode) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return m.name.toLowerCase().includes(q) || m.desc.toLowerCase().includes(q);
  };

  const systemModes = modes.filter((m) => m.isSystem).filter(matchesSearch);
  const userModes = modes.filter((m) => !m.isSystem).filter(matchesSearch);

  return (
    <div className="flex flex-col gap-6">
      <PanelHead
        title="Prompt modes"
        hint="A mode bundles a system prompt + sampling settings. Pick one as the active mode (tray, hotkey, dashboard) and prompts run with these settings."
      />

      {!draft && (
        <Hint icon={<I.info size={13} />} tone="info">
          The <b>active mode</b> is what your Rewrite hotkey (Ctrl+Alt+F) runs. Edit a
          mode's system prompt to change <i>how</i> it rewrites — or create modes for
          different jobs (a “formal email” one, a “concise” one) and switch between them.{' '}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('app:show-guide'))}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }}
          >
            See how it works →
          </button>
        </Hint>
      )}

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
              {systemModes.map((m) => (
                <ModeRow
                  key={m.id}
                  mode={m}
                  isActive={m.id === active?.id}
                  pinned={connectionLabel(m.provider)}
                  busy={busy}
                  onToggleEnabled={toggleEnabled}
                  onReorder={reorder}
                  onEdit={beginEdit}
                  onRemove={remove}
                />
              ))}
            </Section>
          )}

          <Section
            title="Your modes"
            hint={userModes.length === 0 ? 'No custom modes yet. Click “New mode” to create one.' : undefined}
          >
            {userModes.map((m, i) => (
              <ModeRow
                key={m.id}
                mode={m}
                idx={i}
                list={userModes}
                isActive={m.id === active?.id}
                pinned={connectionLabel(m.provider)}
                busy={busy}
                onToggleEnabled={toggleEnabled}
                onReorder={reorder}
                onEdit={beginEdit}
                onRemove={remove}
              />
            ))}
          </Section>
        </>
      )}

      {draft && showTemplatePicker && isNew && (
        <TemplatePicker onPick={applyTemplate} onCancel={cancelEdit} />
      )}

      {draft && !showTemplatePicker && (
        <ModeEditor
          mode={draft}
          onChange={setDraft}
          connections={connections}
          isNew={isNew}
          busy={busy}
          onCancel={cancelEdit}
          onSave={save}
        />
      )}
    </div>
  );
}
