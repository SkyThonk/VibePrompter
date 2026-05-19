import { useEffect, useState } from 'react';
import { Hint, I, Kbd, PanelHead, PhButton, Pill, SettingRow, Toggle, useToast, type IconName } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';

/**
 * Real shortcuts editor. Backed by the `shortcuts` table — every change
 * persists via `register_shortcut` and the backend re-binds the OS-level
 * accelerator on the `shortcut_updated` event.
 *
 * Recording UX:
 *   1. Click "Edit" — row enters listening state.
 *   2. Next keydown that includes at least one modifier becomes the new
 *      accelerator (we reject lone keys to prevent shortcuts like "M" from
 *      capturing every M press in the user's editor).
 *   3. We validate uniqueness across enabled shortcuts; on conflict the
 *      user sees a red preview and Save is gated.
 *   4. Esc cancels without changes.
 */
interface ShortcutItem {
  id: string;
  label: string;
  hint: string;
  iconName: string;
  accelerator: string;
  action: string;
  enabled: boolean;
  keys: string[];
}

interface Recording {
  id: string;
  accel: string | null;
  conflict: string | null;
}

export function ShortcutsPanel() {
  const toast = useToast();
  const [items, setItems] = useState<ShortcutItem[]>([]);
  const [recording, setRecording] = useState<Recording | null>(null);

  const reload = () => {
    invokeCommand<ShortcutItem[]>('list_shortcuts')
      .then(setItems)
      .catch(() => setItems([]));
  };

  useEffect(() => {
    reload();
  }, []);

  // Capture the next keypress while recording. We do this via a global
  // listener (not the row's onKeyDown) because the recording row may not
  // have focus and we want to intercept system-like combos uniformly.
  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setRecording(null);
        return;
      }
      // Reject pure modifier keys — wait for the real key.
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
        return;
      }
      e.preventDefault();
      const parts: string[] = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');
      if (e.metaKey) parts.push('Meta');
      if (parts.length === 0) {
        // Lone key — refuse. Bare hotkeys would fire on every keystroke.
        setRecording({
          ...recording,
          accel: null,
          conflict: 'Pick a combination with Ctrl, Shift, Alt, or Meta.',
        });
        return;
      }
      parts.push(formatKey(e));
      const accel = parts.join('+');
      const collision = items
        .filter((s) => s.enabled && s.id !== recording.id && s.accelerator === accel)
        .map((s) => s.label)
        .join(', ');
      setRecording({
        ...recording,
        accel,
        conflict: collision ? `Conflicts with: ${collision}` : null,
      });
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, items]);

  const save = async (item: ShortcutItem, patch: Partial<ShortcutItem>) => {
    try {
      await invokeCommand<void>('register_shortcut', {
        config: {
          id: item.id,
          label: patch.label ?? item.label,
          hint: patch.hint ?? item.hint,
          iconName: patch.iconName ?? item.iconName,
          accelerator: patch.accelerator ?? item.accelerator,
          action: patch.action ?? item.action,
          enabled: patch.enabled ?? item.enabled,
          sort_order: 0, // server keeps existing on upsert (default 0)
        },
      });
      reload();
    } catch (e) {
      toast.err(typeof e === 'string' ? e : String(e), 'Could not save shortcut');
    }
  };

  const commitRecording = async () => {
    if (!recording || !recording.accel || recording.conflict) return;
    const item = items.find((i) => i.id === recording.id);
    if (!item) return;
    await save(item, { accelerator: recording.accel });
    setRecording(null);
    toast.ok(`${item.label} now bound to ${recording.accel}`, 'Shortcut saved');
  };

  return (
    <>
      <PanelHead
        title="Shortcuts"
        hint="Global keys work in any app on your machine. Changes apply instantly — no restart needed."
      />

      <Hint icon={<I.info size={13} />} tone="info">
        Click <b>Edit</b> next to a shortcut, then press the combo you want.
        Esc cancels. The backend warns about conflicts before you commit.
      </Hint>

      <div className="mt-4">
        {items.map((it) => {
          const Icon = I[it.iconName as IconName];
          const isRecording = recording?.id === it.id;
          return (
            <SettingRow
              key={it.id}
              icon={Icon ? <Icon size={14} /> : null}
              label={
                <span className="flex items-center gap-1.5">
                  {it.label}
                  {!it.enabled && <Pill tone="warn">disabled</Pill>}
                </span>
              }
              hint={
                isRecording
                  ? recording.conflict
                    ? recording.conflict
                    : recording.accel
                    ? `Will bind to ${recording.accel}`
                    : 'Press a combination…'
                  : it.hint
              }
              control={
                <div className="flex items-center gap-1.5">
                  {isRecording ? (
                    <>
                      <span
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium h-[26px]"
                        style={{
                          background: recording.conflict
                            ? 'rgba(248,113,113,0.10)'
                            : 'var(--accent-tint)',
                          color: recording.conflict
                            ? 'var(--danger)'
                            : 'var(--accent)',
                          border: recording.conflict
                            ? '.5px solid rgba(248,113,113,0.40)'
                            : '.5px solid var(--accent)',
                        }}
                      >
                        {recording.accel ? (
                          recording.accel
                        ) : (
                          <>
                            <span className="dot accent ph-pulse" /> listening…
                          </>
                        )}
                      </span>
                      <PhButton size="sm" variant="ghost" onClick={() => setRecording(null)}>
                        Cancel
                      </PhButton>
                      <PhButton
                        size="sm"
                        variant="primary"
                        onClick={commitRecording}
                        disabled={!recording.accel || !!recording.conflict}
                      >
                        Save
                      </PhButton>
                    </>
                  ) : (
                    <>
                      <Toggle
                        value={it.enabled}
                        onChange={(v) => save(it, { enabled: v })}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setRecording({ id: it.id, accel: null, conflict: null })
                        }
                        className="rounded-md px-2 py-[3px] cursor-pointer inline-flex items-center gap-[3px] h-[26px]"
                        style={{
                          background: 'var(--surface-2)',
                          border: '.5px solid var(--border-strong)',
                          opacity: it.enabled ? 1 : 0.5,
                        }}
                        title="Click to record a new combination"
                      >
                        <Kbd keys={it.keys} />
                      </button>
                    </>
                  )}
                </div>
              }
            />
          );
        })}
        {items.length === 0 && (
          <div className="text-[12.5px] text-fg-dim py-4 text-center">
            No shortcuts configured.
          </div>
        )}
      </div>
    </>
  );
}

/** Map a KeyboardEvent.key into the accelerator format Rust's global-shortcut
    plugin expects: single character keys are uppercased, special keys keep
    their names (Space, Enter, ArrowUp, etc.). Symbols like ',' stay literal. */
function formatKey(e: KeyboardEvent): string {
  const k = e.key;
  if (k === ' ') return 'Space';
  if (k.length === 1) return k.toUpperCase();
  // Common multi-char keys are already in the right shape (Enter, Tab,
  // ArrowUp, F1, etc.).
  return k;
}
