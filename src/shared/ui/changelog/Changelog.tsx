import { useEffect, useState } from 'react';
import { I } from '../Icon';

/**
 * Built-in changelog. Curated, not fetched — keeps the modal honest and
 * offline-friendly. Add an entry at the top whenever a release ships.
 *
 * Trigger: window event `app:show-changelog` (fired from the version-upgrade
 * toast button + the About panel "View changelog" link).
 */
interface Entry {
  version: string;
  date: string;
  highlights: string[];
}

const ENTRIES: Entry[] = [
  {
    version: '1.0.3.0',
    date: '2026-06-19',
    highlights: [
      'New: a "How it works" guide explains the select → hotkey → overlay workflow, what Modes are, and how to customize prompts. Opens automatically after setup, and anytime from the dashboard, command palette (Ctrl+K), or cheat sheet.',
      'Plus clearer in-app hints: how to get a free API key (Groq, Google AI Studio, OpenRouter), what the active Mode does, and what each shortcut triggers.',
      'Fix: starting at Windows login now opens silently in the system tray instead of popping up the main window.',
      'Fix: Grammar and Summary now respect their configured settings instead of falling back to defaults.',
      'Tweaks and follow-ups now thread under their original refine in history, so the full conversation stays grouped together.',
    ],
  },
  {
    version: '1.0.2.0',
    date: '2026-05-28',
    highlights: [
      'Fix: Copy button in refine overlay for apps where Replace (Ctrl+V) is unreliable (e.g. Excel loses cell-edit mode on focus shift).',
      'New Copy button beside Replace in Grammer and Mode Overlay'
    ],
  }
];

export function Changelog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('app:show-changelog', onOpen);
    return () => window.removeEventListener('app:show-changelog', onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
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
          width: 'min(580px, 92vw)',
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
          <I.sparkles size={14} style={{ color: 'var(--accent)' }} />
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--fg-strong)' }}>
            What's new
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--fg-mute)',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 4,
            }}
            title="Close (Esc)"
          >
            <I.close size={14} />
          </button>
        </div>

        <div style={{ overflow: 'auto', padding: '12px 18px 18px' }}>
          {ENTRIES.map((e) => (
            <div key={e.version} style={{ marginBottom: 18 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  marginBottom: 6,
                }}
              >
                <span
                  className="ph-mono"
                  style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-strong)' }}
                >
                  v{e.version}
                </span>
                <span className="ph-mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                  {e.date}
                </span>
              </div>
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                {e.highlights.map((h, i) => (
                  <li
                    key={i}
                    style={{
                      fontSize: 12.5,
                      color: 'var(--fg)',
                      paddingLeft: 14,
                      position: 'relative',
                      lineHeight: 1.5,
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 8,
                        width: 4,
                        height: 4,
                        borderRadius: '50%',
                        background: 'var(--accent)',
                      }}
                    />
                    {h}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
