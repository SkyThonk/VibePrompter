import { useEffect, useState } from 'react';
import { prettyAccel, useShortcuts } from '@shared/lib/shortcuts';
import { I } from '../Icon';

/**
 * Ctrl+/ keyboard cheat sheet modal. Lists every keyboard surface the user
 * can actually drive — global hotkeys, in-window shortcuts, overlay
 * shortcuts, list navigation. Single source of truth that's never wrong
 * because we read it from the running shortcut bindings + hardcoded
 * window-scoped keys.
 *
 * The "Global" group is the user's *actual* rebindable hotkeys, read live from
 * the shortcut bindings — so a custom combo shows here, never the stale default.
 * The remaining groups are window-scoped webview keys that aren't rebindable,
 * so they stay static.
 */
interface Row {
  keys: string;
  label: string;
}
interface Group {
  title: string;
  rows: Row[];
}

/**
 * Clearer wording for the rebindable global hotkeys than the raw DB labels
 * (e.g. the `palette` shortcut's action toggles the window — it does NOT open
 * the Ctrl+K command palette — so "Toggle VibePrompter window" is truer than
 * the stored "Open Command Palette"). Keyed by shortcut id; the accelerator
 * itself is always read live, so a custom binding shows here. Ids without an
 * entry fall back to their backend label.
 */
const GLOBAL_LABELS: Record<string, string> = {
  palette: 'Toggle VibePrompter window',
  modes: 'Cycle active prompt mode',
  rewrite: 'Rewrite selection',
  grammar: 'Fix grammar on selection',
  summary: 'Summarize selection',
};

// Window-scoped keys handled inside the webview — not rebindable, so static.
const STATIC_GROUPS: Group[] = [
  {
    title: 'Main window',
    rows: [
      { keys: 'Ctrl + K', label: 'Command palette' },
      { keys: 'Ctrl + /', label: 'This cheat sheet' },
      { keys: 'Ctrl + ,', label: 'Open Settings' },
      { keys: 'Ctrl + M', label: 'Cycle prompt mode (in-window)' },
      { keys: 'Esc', label: 'Hide to tray' },
    ],
  },
  {
    title: 'Run a prompt',
    rows: [
      { keys: 'Ctrl + Enter', label: 'Run / submit' },
    ],
  },
  {
    title: 'Refine overlay',
    rows: [
      { keys: 'Enter', label: 'Accept & replace selection' },
      { keys: 'Ctrl + R', label: 'Retry' },
      { keys: 'Esc', label: 'Cancel & restore clipboard' },
    ],
  },
  {
    title: 'History',
    rows: [
      { keys: 'j / ↓', label: 'Next entry' },
      { keys: 'k / ↑', label: 'Previous entry' },
    ],
  },
];

export function CheatSheet() {
  const [open, setOpen] = useState(false);
  const { items } = useShortcuts();

  // The rebindable global hotkeys, straight from the live bindings. Falls back
  // to nothing-rendered until the query resolves; the static groups still show.
  const globalGroup: Group = {
    title: 'Global (work in any app)',
    rows: items.map((s) => ({
      keys: prettyAccel(s.accelerator),
      label: GLOBAL_LABELS[s.id] ?? s.label,
    })),
  };
  const groups = globalGroup.rows.length ? [globalGroup, ...STATIC_GROUPS] : STATIC_GROUPS;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        background: 'rgba(10, 11, 15, 0.45)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="ph-anim-pop-in"
        style={{
          width: 'min(640px, 92vw)',
          maxHeight: '80vh',
          background: 'var(--glass)',
          backdropFilter: 'blur(40px) saturate(180%)',
          border: '.5px solid var(--border-strong)',
          borderRadius: 14,
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            borderBottom: '.5px solid var(--divider)',
          }}
        >
          <I.keyboard size={14} style={{ color: 'var(--accent)' }} />
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--fg-strong)' }}>
            Keyboard shortcuts
          </span>
          <span
            className="ph-mono"
            style={{
              fontSize: 10.5,
              color: 'var(--fg-mute)',
              padding: '2px 6px',
              borderRadius: 4,
              background: 'var(--surface-2)',
              border: '.5px solid var(--border-strong)',
            }}
          >
            Ctrl + /
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            setOpen(false);
            window.dispatchEvent(new Event('app:show-guide'));
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            textAlign: 'left',
            padding: '10px 16px',
            background: 'transparent',
            border: 'none',
            borderBottom: '.5px solid var(--divider)',
            color: 'var(--accent)',
            cursor: 'pointer',
            fontSize: 12.5,
          }}
        >
          <I.sparkles size={13} />
          New here? See how VibePrompter works
        </button>

        <div style={{ overflow: 'auto', padding: '8px 0' }}>
          {groups.map((g) => (
            <div key={g.title} style={{ padding: '10px 16px 14px' }}>
              <div
                style={{
                  fontSize: 10.5,
                  textTransform: 'uppercase',
                  letterSpacing: '0.10em',
                  fontWeight: 600,
                  color: 'var(--fg-dim)',
                  marginBottom: 8,
                }}
              >
                {g.title}
              </div>
              {g.rows.map((r) => (
                <div
                  key={r.keys}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '4px 0',
                  }}
                >
                  <span style={{ flex: 1, fontSize: 12.5, color: 'var(--fg)' }}>{r.label}</span>
                  <kbd
                    className="ph-mono"
                    style={{
                      fontSize: 11,
                      padding: '2px 7px',
                      borderRadius: 5,
                      background: 'var(--surface-2)',
                      border: '.5px solid var(--border-strong)',
                      color: 'var(--fg-strong)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.keys}
                  </kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
