import { I, CoreLoop } from '@shared/ui';

/**
 * Persistent "How to use VibePrompter" card on the dashboard. The app's main
 * feature happens *outside* this window (select text anywhere → hotkey →
 * overlay), so the dashboard always keeps the core loop one glance away.
 *
 * Collapsible, not dismiss-forever: the user can fold it to a slim strip
 * (state persisted by the caller), but it stays reachable — and the "Full
 * guide" button opens the complete walkthrough. Reuses `CoreLoop` so the card
 * and the modal guide never drift.
 */
export function HowToUseCard({
  collapsed,
  onToggle,
  onOpenGuide,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onOpenGuide: () => void;
}) {
  return (
    <section
      className="rounded-xl p-5 flex flex-col gap-3"
      style={{
        background: 'linear-gradient(135deg, var(--accent-tint) 0%, var(--surface) 70%)',
        border: '.5px solid var(--accent-tint-2)',
        boxShadow: collapsed ? 'none' : 'var(--accent-glow)',
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--accent-tint-2)', color: 'var(--accent)' }}
        >
          <I.bolt size={18} />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="m-0 text-[15px] font-semibold text-fg-strong">
            How to use VibePrompter
          </h2>
          <p className="m-0 text-[12px] text-fg-mute mt-0.5">
            Your text gets fixed right where you are — no window switching.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenGuide}
          className="text-[11.5px] px-2.5 py-1 rounded inline-flex items-center gap-1.5 transition-colors flex-shrink-0"
          style={{
            background: 'var(--surface)',
            border: '.5px solid var(--accent-tint-2)',
            color: 'var(--accent)',
            cursor: 'pointer',
          }}
          title="Open the full walkthrough"
        >
          <I.sparkles size={12} />
          Full guide
        </button>
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          className="text-[11.5px] px-2 py-1 rounded transition-colors flex-shrink-0"
          style={{
            background: 'transparent',
            border: '.5px solid var(--border)',
            color: 'var(--fg-mute)',
            cursor: 'pointer',
          }}
          title={collapsed ? 'Show steps' : 'Hide steps'}
        >
          {collapsed ? <I.chevD size={14} /> : <I.chevR size={14} />}
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="mt-1">
            <CoreLoop />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-1">
            <TipHotkey
              accel="Ctrl+Alt+F"
              label="Rewrite"
              hint="Polishes the selection using your active mode."
            />
            <TipHotkey
              accel="Ctrl+Alt+G"
              label="Fix grammar"
              hint="Corrects typos and grammar without changing style."
            />
            <TipHotkey
              accel="Ctrl+Alt+S"
              label="Summarize"
              hint="Bulleted summary of long text. Copies to clipboard."
            />
          </div>

          <div
            className="text-[11.5px] text-fg-mute mt-1 flex items-center gap-2"
            style={{ paddingTop: 10, borderTop: '.5px solid var(--accent-tint-2)' }}
          >
            <I.info size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <span>
              VibePrompter lives in your <strong className="text-fg-strong">system tray</strong>.
              Closing this window keeps it running. On Windows: right-click the tray icon
              (often hidden under the <kbd className="ph-mono text-[10px]">^</kbd> chevron) →
              <strong className="text-fg-strong"> Taskbar settings</strong> → show the
              VibePrompter icon for one-click access.
            </span>
          </div>
        </>
      )}
    </section>
  );
}

function TipHotkey({ accel, label, hint }: { accel: string; label: string; hint: string }) {
  return (
    <div
      className="rounded-lg p-3 flex flex-col gap-1"
      style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
    >
      <div className="flex items-center gap-2">
        <kbd
          className="ph-mono text-[11px] px-2 py-0.5 rounded"
          style={{
            background: 'var(--surface-2)',
            color: 'var(--fg-strong)',
            border: '.5px solid var(--border-strong)',
          }}
        >
          {accel}
        </kbd>
        <span className="text-[12.5px] font-semibold text-fg-strong">{label}</span>
      </div>
      <span className="text-[11px] text-fg-dim leading-snug">{hint}</span>
    </div>
  );
}
