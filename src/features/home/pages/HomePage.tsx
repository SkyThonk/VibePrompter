import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listen } from '@tauri-apps/api/event';
import { I, PhButton, useToast, AppIcon, type IconName } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';

interface ActiveMode {
  id: string;
  name: string;
  iconName?: string | null;
}

interface ShortcutBinding {
  id: string;
  action: string;
  accelerator: string;
  hasBackend: boolean;
}

interface CatalogMode {
  id: string;
  name: string;
  iconName: string;
  desc: string;
  sys: string;
  temp: number;
  maxTok: number;
  provider?: string | null;
  enabled: boolean;
  isSystem: boolean;
}

interface Connection {
  id: string;
  label: string;
  hasKey: boolean;
  isDefault: boolean;
  defaultModel: string;
}

interface HealthIssue {
  severity: 'warn' | 'error';
  code: string;
  message: string;
}

interface HealthReport {
  ok: boolean;
  issues: HealthIssue[];
}

interface HistoryItem {
  id: number;
  mode: string;
  iconName: string;
  provider: string;
  ms: number;
  createdAt: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicros?: number;
}

interface CostSummary {
  monthMicros: number;
  weekMicros: number;
  totalMicros: number;
  monthRunsPriced: number;
  monthRunsUnpriced: number;
}

interface CostBreakdown {
  byDay: Array<{ day: string; micros: number; runs: number }>;
  byConnection: Array<{ label: string; micros: number; runs: number }>;
  days: number;
}

/**
 * The main window is a real app dashboard — not a tour of demo screens.
 *
 * What the user actually does here:
 *   - See which prompt mode is currently active (the same mode the tray icon
 *     and the global Ctrl+Shift+M hotkey are pointing at).
 *   - Switch modes with one click. Cycling, or picking directly from the
 *     catalog list.
 *   - See the live global hotkey bindings and which ones have backend
 *     implementations vs. are still placeholder.
 *   - Jump into Settings for configuration. Everything else (tray menu,
 *     command palette overlay, transparent HUD, toasts) is an OS-level
 *     surface — those are not pages the user "visits."
 */
export function HomePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [active, setActive] = useState<ActiveMode | null>(null);
  const [modes, setModes] = useState<CatalogMode[]>([]);
  const [shortcuts, setShortcuts] = useState<ShortcutBinding[]>([]);
  const [recent, setRecent] = useState<HistoryItem[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [costBreakdown, setCostBreakdown] = useState<CostBreakdown | null>(null);
  const [showHotkeyTip, setShowHotkeyTip] = useState(false);
  // Tracks whether the initial parallel fetch batch has resolved. Until it
  // flips true, empty arrays / null states are indistinguishable from "still
  // loading", so each section renders a shimmer skeleton instead of its
  // empty-state placeholder. A subsequent reload (window focus, event push)
  // does NOT toggle this back — we only ever want the skeleton on first paint.
  const [bootLoaded, setBootLoaded] = useState(false);

  const reloadAll = () => {
    invokeCommand<ActiveMode>('get_active_mode').then(setActive).catch(() => {});
    invokeCommand<ShortcutBinding[]>('list_global_shortcuts').then(setShortcuts).catch(() => {});
    invokeCommand<HistoryItem[]>('get_history', { query: { limit: 4, offset: 0 } })
      .then(setRecent)
      .catch(() => {});
    invokeCommand<Connection[]>('list_connections').then(setConnections).catch(() => {});
    invokeCommand<HealthReport>('run_health_check').then(setHealth).catch(() => {});
    invokeCommand<CostSummary>('get_cost_summary').then(setCost).catch(() => {});
    invokeCommand<CostBreakdown>('get_cost_breakdown', { days: 30 })
      .then(setCostBreakdown)
      .catch(() => {});
  };

  useEffect(() => {
    // Initial parallel fetch. Track completion via Promise.allSettled so the
    // skeleton hides only after every section has its data (or has failed) —
    // partial reveals look glitchier than waiting a beat for the full paint.
    Promise.allSettled([
      invokeCommand<ActiveMode>('get_active_mode').then(setActive),
      invokeCommand<CatalogMode[]>('list_modes').then((all) =>
        // Filter out built-in modes (Grammar, Summarize). They have dedicated
        // global shortcuts and don't belong in the dashboard switcher or cycle
        // rotation — same filter the tray/setup applies on the backend.
        setModes(all.filter((m) => m.enabled && !m.isSystem))
      ),
      invokeCommand<ShortcutBinding[]>('list_global_shortcuts').then(setShortcuts),
      invokeCommand<HistoryItem[]>('get_history', { query: { limit: 4, offset: 0 } }).then(
        setRecent
      ),
      invokeCommand<Connection[]>('list_connections').then(setConnections),
      invokeCommand<HealthReport>('run_health_check').then(setHealth),
      invokeCommand<CostSummary>('get_cost_summary').then(setCost),
      invokeCommand<CostBreakdown>('get_cost_breakdown', { days: 30 }).then(setCostBreakdown),
      // First-run tip: show the "select text anywhere → press the hotkey"
      // banner once, until the user dismisses it. The flag lives in the
      // settings KV so it survives across restarts.
      invokeCommand<string | null>('get_kv', { key: 'hotkey_tip_dismissed' }).then((v) => {
        if (!v) setShowHotkeyTip(true);
      }),
    ]).finally(() => setBootLoaded(true));

    // Browser-style window focus event — fires when the Tauri webview
    // regains focus (user clicks back into the window after using the tray).
    // Re-pull dynamic data so anything done via tray menu / global hotkey
    // (which already emit events, but a stale render is cheap to fix).
    const onFocus = () => reloadAll();
    window.addEventListener('focus', onFocus);

    // Light poll for in-flight request count. 1s cadence is plenty for a
    // human-readable counter; semaphore reads are constant-time.
    const pollInFlight = () => {
      invokeCommand<{ inFlight: number; capacity: number }>('get_in_flight')
        .then(setInFlight)
        .catch(() => {});
    };
    pollInFlight();
    const inFlightTimer = window.setInterval(pollInFlight, 1000);

    const modePromise = listen<ActiveMode>('mode_changed', (e) => setActive(e.payload));
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(inFlightTimer);
      modePromise.then((u) => u()).catch(() => {});
    };
  }, []);

  const [inFlight, setInFlight] = useState<{ inFlight: number; capacity: number } | null>(null);

  // Show a one-time "Updated to vX" toast after an app version bump. We compare
  // the running version to the value we stashed last launch; if they differ,
  // toast and update the stash. First launch on a given install just stashes
  // the current version silently (no false-positive welcome toast).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const diag = await invokeCommand<{ version: string }>('get_diagnostics');
        if (cancelled) return;
        const raw = await invokeCommand<string | null>('get_kv', { key: 'last_seen_version' });
        const prev = raw ? (JSON.parse(raw) as string) : null;
        if (prev && prev !== diag.version) {
          toast.ok(
            `Now running ${diag.version} (was ${prev}). Press Ctrl+/ for shortcuts, or open "What's new" from the About panel.`,
            'VibePrompter updated'
          );
          // Auto-open the changelog so the user actually sees what changed.
          // (We dispatch on a tiny delay so it lands after the toast renders.)
          window.setTimeout(() => {
            window.dispatchEvent(new Event('app:show-changelog'));
          }, 350);
        }
        if (prev !== diag.version) {
          await invokeCommand<void>('set_kv', {
            key: 'last_seen_version',
            value: JSON.stringify(diag.version),
          });
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const cycleMode = () =>
    invokeCommand<void>('cycle_mode_cmd').catch(() => {});

  const pickMode = (id: string) =>
    invokeCommand<void>('set_active_mode', { id }).catch(() => {});

  const quitApp = () => invokeCommand<void>('quit_app').catch(() => {});

  const activeIconKey = (active?.iconName ?? 'bolt') as IconName;
  const ActiveIcon =
    (I as Record<string, React.ComponentType<{ size?: number }>>)[activeIconKey] ?? I.bolt;

  const defaultConn = connections.find((c) => c.isDefault);

  return (
    <div
      className="ph-root min-h-screen"
      style={{
        background:
          'radial-gradient(60% 45% at 50% 30%, rgba(167,139,250,0.06), transparent 70%), radial-gradient(40% 40% at 80% 80%, rgba(107,138,253,0.05), transparent 70%), var(--bg)',
      }}
    >
      <div className="w-full px-6 sm:px-8 lg:px-10 py-8 flex flex-col gap-6">
        <header className="flex items-center gap-4">
          <AppIcon size="xl" />
          <div className="flex-1 min-w-0">
            <h1
              className="m-0 text-[28px] font-semibold text-fg-strong"
              style={{ letterSpacing: '-0.025em' }}
            >
              VibePrompter
            </h1>
            <p className="m-0 text-fg-mute text-[13px] mt-1">
              Running in the tray. Switch modes from anywhere with the global
              hotkey, or pick one below.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <PhButton
              variant="ghost"
              size="md"
              icon={<I.layers size={14} />}
              onClick={() => navigate('/settings/modes')}
              title="Manage prompt modes"
            >
              Modes
            </PhButton>
            <PhButton
              variant="ghost"
              size="md"
              icon={<I.cog size={14} />}
              onClick={() => navigate('/settings')}
              title="App settings (Ctrl+,)"
            >
              Settings
            </PhButton>
          </div>
        </header>

        {!bootLoaded && <DashboardSkeleton />}

        {bootLoaded && showHotkeyTip && connections.length > 0 && (
          <HotkeyTipCard
            onDismiss={() => {
              setShowHotkeyTip(false);
              invokeCommand<void>('set_kv', {
                key: 'hotkey_tip_dismissed',
                value: JSON.stringify(true),
              }).catch(() => {});
            }}
          />
        )}

        {bootLoaded && health && health.issues.length > 0 && (
          <section className="flex flex-col gap-1.5">
            {health.issues.map((issue) => (
              <div
                key={issue.code}
                className="rounded-lg px-3 py-2 flex items-start gap-2 text-[12.5px]"
                style={{
                  background:
                    issue.severity === 'error'
                      ? 'rgba(248,113,113,0.08)'
                      : 'rgba(251,191,36,0.08)',
                  border:
                    issue.severity === 'error'
                      ? '.5px solid rgba(248,113,113,0.30)'
                      : '.5px solid rgba(251,191,36,0.30)',
                  color:
                    issue.severity === 'error' ? 'var(--danger)' : 'var(--warn)',
                }}
              >
                <I.info size={14} style={{ marginTop: 2, flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{issue.message}</span>
                {(issue.code === 'no_connections' ||
                  issue.code === 'default_missing_key' ||
                  issue.code === 'no_default_connection') && (
                  <button
                    type="button"
                    onClick={() => navigate('/settings/providers')}
                    className="text-[11.5px] underline"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    Fix →
                  </button>
                )}
              </div>
            ))}
          </section>
        )}

        {bootLoaded && (() => {
          const activeFull = modes.find((m) => m.id === active?.id) ?? null;
          const pinnedConn = activeFull?.provider
            ? connections.find((c) => c.id === activeFull.provider) ?? null
            : null;
          const routedConn = pinnedConn ?? defaultConn ?? null;
          const routedModel = routedConn?.defaultModel ?? '';
          const routedLabel = routedConn
            ? `${routedConn.label}${routedModel ? ` · ${routedModel}` : ''}`
            : 'No provider — add one in Settings';
          const promptPreview = (activeFull?.sys ?? '').trim();
          return (
            <section
              className="rounded-xl p-5 flex flex-col gap-4"
              style={{
                background: 'var(--surface)',
                border: '.5px solid var(--border)',
                boxShadow: 'var(--accent-glow)',
              }}
            >
              <div className="flex items-center gap-4">
                <span
                  className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{
                    background: 'var(--accent-tint)',
                    color: 'var(--accent)',
                    border: '.5px solid var(--accent-tint-2)',
                  }}
                >
                  <ActiveIcon size={22} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[10.5px] uppercase tracking-[0.12em] text-fg-dim font-semibold flex items-center gap-1.5">
                    <span>Rewrite hotkey uses</span>
                    <kbd
                      className="ph-mono text-[10px] px-1.5 py-0.5 rounded normal-case"
                      style={{
                        background: 'var(--surface-2)',
                        border: '.5px solid var(--border-strong)',
                        letterSpacing: 0,
                      }}
                      title="Press anywhere to rewrite the selected text in any app"
                    >
                      Ctrl+Alt+Space
                    </kbd>
                  </div>
                  <div className="text-[20px] font-semibold text-fg-strong leading-tight mt-0.5">
                    {active?.name ?? '—'}
                  </div>
                  {activeFull?.desc && (
                    <div className="text-[12.5px] text-fg-mute mt-0.5 truncate">
                      {activeFull.desc}
                    </div>
                  )}
                  <div className="text-[11px] text-fg-dim mt-1">
                    Grammar (Ctrl+Alt+G) and Summarize (Ctrl+Alt+S) have their own dedicated prompts and ignore this setting.
                  </div>
                </div>
                <PhButton
                  variant="primary"
                  size="md"
                  icon={<I.refresh size={14} />}
                  onClick={cycleMode}
                  title="Cycle to next mode (Ctrl+Alt+M globally, Ctrl+M in-window)"
                >
                  {nextMode(active, modes)
                    ? `Cycle → ${nextMode(active, modes)!.name}`
                    : 'Cycle'}
                </PhButton>
              </div>

              <div
                className="grid gap-3 pt-3"
                style={{
                  gridTemplateColumns: '180px 1fr auto',
                  borderTop: '.5px solid var(--divider)',
                  alignItems: 'start',
                }}
              >
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-[10px] uppercase tracking-[0.10em] text-fg-dim font-semibold">
                    Routes through
                  </span>
                  <span
                    className="text-[12.5px] truncate"
                    style={{ color: routedConn ? 'var(--fg-strong)' : 'var(--danger)' }}
                    title={routedLabel}
                  >
                    {routedLabel}
                  </span>
                  {pinnedConn && (
                    <span className="text-[10.5px] text-fg-dim">Pinned to this mode</span>
                  )}
                  {!pinnedConn && defaultConn && activeFull && (
                    <span className="text-[10.5px] text-fg-dim">Workspace default</span>
                  )}
                </div>

                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-[10px] uppercase tracking-[0.10em] text-fg-dim font-semibold">
                    System prompt
                  </span>
                  {promptPreview ? (
                    <span
                      className="text-[12.5px] text-fg-mute"
                      style={{
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        lineHeight: 1.45,
                      }}
                      title={promptPreview}
                    >
                      {promptPreview}
                    </span>
                  ) : (
                    <span className="text-[12px] text-fg-dim italic">No system prompt set</span>
                  )}
                  {activeFull && (
                    <span className="text-[10.5px] text-fg-dim ph-mono">
                      temp {activeFull.temp} · max {activeFull.maxTok} tok
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => navigate('/settings/modes')}
                  className="text-[12px] self-start"
                  style={{
                    background: 'transparent',
                    border: '.5px solid var(--border)',
                    color: 'var(--fg)',
                    borderRadius: 6,
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                  title="Edit this mode in Settings"
                >
                  Edit prompt →
                </button>
              </div>
            </section>
          );
        })()}

        {bootLoaded && connections.length === 0 && (
          <section
            className="rounded-xl p-6 flex flex-col items-center text-center gap-3"
            style={{
              background: 'var(--surface)',
              border: '.5px dashed var(--border-strong)',
            }}
          >
            <span
              className="w-12 h-12 rounded-xl flex items-center justify-center"
              style={{
                background: 'var(--accent-tint)',
                color: 'var(--accent)',
                border: '.5px solid var(--accent-tint-2)',
              }}
            >
              <I.cloud size={22} />
            </span>
            <div>
              <div className="text-[15px] font-semibold text-fg-strong">
                Add your first connection
              </div>
              <div className="text-[12.5px] text-fg-mute mt-1 max-w-[420px]">
                Plug in any OpenAI-compatible API or Anthropic — keys live in
                your OS keyring. Then everything else (hotkeys, refine overlay,
                this dashboard) just works.
              </div>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <PhButton
                variant="primary"
                size="md"
                icon={<I.plus size={14} />}
                onClick={() => navigate('/settings/providers')}
              >
                Add connection
              </PhButton>
              <PhButton
                variant="ghost"
                size="md"
                onClick={() => navigate('/setup')}
              >
                Walk-through setup
              </PhButton>
            </div>
          </section>
        )}


        {bootLoaded && <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2
              className="m-0 text-[13px] font-semibold text-fg uppercase tracking-[0.10em]"
            >
              Switch to
            </h2>
            <span className="text-[11.5px] text-fg-dim ph-mono">
              {modes.length} modes
            </span>
          </div>
          <div
            className="grid grid-cols-2 sm:grid-cols-3 gap-2"
            role="radiogroup"
            aria-label="Select active mode"
            onKeyDown={(e) => {
              // Arrow-key nav between the mode tiles. Computes the grid
              // column count from the live CSS layout so the same handler
              // works for the 2-col and 3-col responsive breakpoints
              // without us hardcoding either.
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
                return;
              }
              const grid = e.currentTarget;
              const buttons = Array.from(
                grid.querySelectorAll<HTMLButtonElement>('button[data-mode-tile="true"]')
              );
              if (buttons.length === 0) return;
              const focusedIdx = buttons.findIndex((b) => b === document.activeElement);
              if (focusedIdx === -1) {
                e.preventDefault();
                buttons[0].focus();
                return;
              }
              // Detect column count by checking offsetTop of the second row's
              // first tile. Tiles in the same row share offsetTop.
              const firstTop = buttons[0].offsetTop;
              let cols = buttons.findIndex((b) => b.offsetTop !== firstTop);
              if (cols === -1) cols = buttons.length;
              let next = focusedIdx;
              switch (e.key) {
                case 'ArrowRight':
                  next = Math.min(focusedIdx + 1, buttons.length - 1);
                  break;
                case 'ArrowLeft':
                  next = Math.max(focusedIdx - 1, 0);
                  break;
                case 'ArrowDown':
                  next = Math.min(focusedIdx + cols, buttons.length - 1);
                  break;
                case 'ArrowUp':
                  next = Math.max(focusedIdx - cols, 0);
                  break;
                case 'Home':
                  next = 0;
                  break;
                case 'End':
                  next = buttons.length - 1;
                  break;
              }
              if (next !== focusedIdx) {
                e.preventDefault();
                buttons[next].focus();
              }
            }}
          >
            {modes.map((m) => {
              const Icon =
                (I as Record<string, React.ComponentType<{ size?: number }>>)[m.iconName] ??
                I.bolt;
              const isActive = m.id === active?.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  data-mode-tile="true"
                  onClick={() => pickMode(m.id)}
                  aria-label={`Switch to ${m.name} mode`}
                  className="rounded-lg p-3 flex items-center gap-2.5 text-left transition-[background,border-color,transform] duration-150 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
                  style={{
                    background: isActive ? 'var(--accent-tint)' : 'var(--surface)',
                    border: `.5px solid ${
                      isActive ? 'var(--accent-tint-2)' : 'var(--border)'
                    }`,
                    color: isActive ? 'var(--accent)' : 'var(--fg)',
                    cursor: 'pointer',
                  }}
                >
                  <Icon size={16} />
                  <span className="text-[13px] font-medium truncate">{m.name}</span>
                  {isActive && (
                    <I.check size={14} style={{ marginLeft: 'auto', flexShrink: 0 }} />
                  )}
                </button>
              );
            })}
          </div>
        </section>}

        {bootLoaded && cost && costBreakdown && (cost.monthMicros > 0 || costBreakdown.byDay.length > 0) && (
          <CostCard cost={cost} breakdown={costBreakdown} />
        )}

        {bootLoaded && <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="flex flex-col gap-2">
          <h2
            className="m-0 text-[13px] font-semibold text-fg uppercase tracking-[0.10em]"
          >
            Global shortcuts
          </h2>
          <div
            className="rounded-lg overflow-hidden"
            style={{
              background: 'var(--surface)',
              border: '.5px solid var(--border)',
            }}
          >
            {shortcuts.length === 0 && (
              <div className="px-4 py-3 text-[12.5px] text-fg-dim">
                No shortcuts configured.
              </div>
            )}
            {shortcuts.map((s, i) => {
              const conflicting = conflictsFor(s.accelerator, shortcuts);
              return (
                <div
                  key={s.id}
                  className="px-4 py-2.5 flex items-center gap-3"
                  style={{
                    borderTop:
                      i === 0 ? 'none' : '.5px solid var(--divider)',
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-fg-strong font-medium truncate">
                      {humanizeAction(s.action)}
                    </div>
                    <div className="text-[11.5px] text-fg-dim mt-0.5 ph-mono">
                      {s.action}
                    </div>
                  </div>
                  {conflicting && (
                    <span
                      className="text-[10px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded"
                      style={{
                        background: 'rgba(248,113,113,0.12)',
                        color: 'var(--danger)',
                        border: '.5px solid rgba(248,113,113,0.30)',
                      }}
                      title={`Same accelerator as: ${conflicting}`}
                    >
                      Conflict
                    </span>
                  )}
                  {!s.hasBackend && (
                    <span
                      className="text-[10px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded"
                      style={{
                        background: 'var(--surface-2)',
                        color: 'var(--fg-mute)',
                        border: '.5px solid var(--border)',
                      }}
                      title="Backend handler not yet implemented"
                    >
                      Stub
                    </span>
                  )}
                  <kbd
                    className="ph-mono text-[11.5px] px-2 py-1 rounded"
                    style={{
                      background: 'var(--surface-2)',
                      color: 'var(--fg-strong)',
                      border: '.5px solid var(--border-strong)',
                    }}
                  >
                    {s.accelerator}
                  </kbd>
                </div>
              );
            })}
          </div>
          <div className="text-[11.5px] text-fg-dim mt-1">
            Edit bindings in{' '}
            <button
              type="button"
              onClick={() => navigate('/settings/shortcuts')}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent)',
                cursor: 'pointer',
                padding: 0,
                font: 'inherit',
              }}
            >
              Settings → Shortcuts
            </button>
            .
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="m-0 text-[13px] font-semibold text-fg uppercase tracking-[0.10em]">
              Recent activity
            </h2>
            <span className="text-[11.5px] text-fg-dim ph-mono">
              {recent.length === 0 ? 'empty' : `last ${recent.length}`}
            </span>
          </div>
          {recent.length === 0 ? (
            <div
              className="rounded-lg px-5 py-5 flex items-center gap-4"
              style={{
                background: 'var(--surface)',
                border: '.5px dashed var(--border)',
              }}
            >
              <span
                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{
                  background: 'var(--accent-tint)',
                  color: 'var(--accent)',
                }}
              >
                <I.history size={18} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-fg-strong font-medium">
                  No prompt runs yet
                </div>
                <div className="text-[11.5px] text-fg-dim mt-0.5">
                  Press{' '}
                  <kbd
                    className="ph-mono text-[10.5px] px-1.5 py-0.5 rounded"
                    style={{
                      background: 'var(--surface-2)',
                      border: '.5px solid var(--border-strong)',
                    }}
                  >
                    Ctrl+Alt+V
                  </kbd>{' '}
                  anywhere to open the app, or{' '}
                  <kbd
                    className="ph-mono text-[10.5px] px-1 py-0.5 rounded"
                    style={{
                      background: 'var(--surface-2)',
                      border: '.5px solid var(--border-strong)',
                    }}
                  >
                    Ctrl+Alt+Space
                  </kbd>{' '}
                  to refine highlighted text in any app.
                </div>
              </div>
            </div>
          ) : (
            <div
              className="rounded-lg overflow-hidden"
              style={{
                background: 'var(--surface)',
                border: '.5px solid var(--border)',
              }}
            >
              {recent.map((h, i) => {
                const Icon =
                  (I as Record<string, React.ComponentType<{ size?: number }>>)[h.iconName] ??
                  I.bolt;
                return (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => navigate('/settings/history')}
                    className="w-full px-4 py-2.5 flex items-center gap-3 text-left transition-colors hover:bg-surface-2"
                    style={{
                      borderTop: i === 0 ? 'none' : '.5px solid var(--divider)',
                      background: 'transparent',
                      border: i === 0 ? 'none' : '.5px solid var(--divider)',
                      borderLeft: 'none',
                      borderRight: 'none',
                      borderBottom: 'none',
                      cursor: 'pointer',
                    }}
                    title="Open history settings"
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
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-fg-strong font-medium truncate">
                        {h.mode}
                      </div>
                      <div className="text-[11.5px] text-fg-dim mt-0.5 truncate">
                        {h.provider} · {h.ms}ms
                        {(h.inputTokens ?? 0) + (h.outputTokens ?? 0) > 0 && (
                          <> · {h.inputTokens}→{h.outputTokens} tok</>
                        )}
                        {(h.costMicros ?? 0) > 0 && (
                          <> · {formatCost(h.costMicros!)}</>
                        )}
                      </div>
                    </div>
                    <span className="text-[11px] text-fg-dim ph-mono">
                      {relativeTime(h.createdAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
        </div>}

        <footer
          className="flex items-center justify-between pt-4"
          style={{ borderTop: '.5px solid var(--divider)' }}
        >
          <span className="text-[11.5px] text-fg-dim ph-mono flex items-center gap-2 flex-wrap">
            VibePrompter · close to hide to tray
            {inFlight && inFlight.inFlight > 0 && (
              <span
                className="px-1.5 py-0.5 rounded"
                style={{
                  background: 'var(--accent-tint)',
                  color: 'var(--accent)',
                  border: '.5px solid var(--accent-tint-2)',
                }}
                title={`${inFlight.inFlight} request${inFlight.inFlight === 1 ? '' : 's'} in flight (max ${inFlight.capacity})`}
              >
                ● {inFlight.inFlight}/{inFlight.capacity}
              </span>
            )}
            {cost && cost.monthMicros > 0 && (
              <span
                className="px-1.5 py-0.5 rounded"
                style={{
                  background: 'var(--surface-2)',
                  color: 'var(--fg-mute)',
                  border: '.5px solid var(--border)',
                }}
                title={
                  `~${formatCost(cost.monthMicros)} spent in the last 30 days across ` +
                  `${cost.monthRunsPriced} priced runs` +
                  (cost.monthRunsUnpriced > 0
                    ? ` (+${cost.monthRunsUnpriced} local / unpriced runs not counted)`
                    : '') +
                  '. Estimate from public per-token pricing; vendor invoices are authoritative.'
                }
              >
                ~{formatCost(cost.monthMicros)} this month
              </span>
            )}
          </span>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => navigate('/setup')}
              className="text-[11.5px] text-fg-mute hover:text-fg transition-colors"
              style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              title="Walk through the first-time setup again"
            >
              Re-run setup
            </button>
            <button
              type="button"
              onClick={quitApp}
              className="text-[11.5px] text-fg-mute hover:text-danger transition-colors"
              style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              title="Quit the application entirely (same as the tray Quit item)"
            >
              Exit VibePrompter
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * Cost card — surfaces the cost data we already record per run so the user
 * can see "how much have I spent this month" + which connection drives
 * the spend + a 30-day trend. Renders only when there's something to
 * show (skipping it on a fresh install keeps the dashboard clean).
 *
 * Visualization choices:
 *  - 30-day bar chart, inline SVG (no chart library): bars scale to the
 *    max-day in the window so the shape is readable regardless of total
 *    spend. Tooltip per bar via native `<title>`.
 *  - Per-connection breakdown as a sparkbar list, with each row scaled
 *    against the highest-spend connection so the user can spot the
 *    biggest contributor at a glance.
 */
function CostCard({
  cost,
  breakdown,
}: {
  cost: CostSummary;
  breakdown: CostBreakdown;
}) {
  const days = breakdown.days;
  // Build a dense per-day array (zero-fill gaps) so the bars align with
  // calendar days, not just days where the user ran prompts.
  const denseByDay = useMemo(() => {
    const map = new Map(breakdown.byDay.map((r) => [r.day, r]));
    const arr: Array<{ day: string; micros: number; runs: number }> = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      arr.push(map.get(key) ?? { day: key, micros: 0, runs: 0 });
    }
    return arr;
  }, [breakdown.byDay, days]);
  const maxDayMicros = Math.max(1, ...denseByDay.map((d) => d.micros));
  const maxConnMicros = Math.max(1, ...breakdown.byConnection.map((c) => c.micros));
  const dailyAvg = cost.monthMicros / Math.max(1, days);

  // SVG chart dims. Width scales to container via viewBox; we just need
  // an aspect ratio that reads as "trend, not single value."
  const chartW = 600;
  const chartH = 80;
  const gap = 2;
  const barW = (chartW - gap * (denseByDay.length - 1)) / denseByDay.length;

  return (
    <section
      className="rounded-xl p-5 flex flex-col gap-4"
      style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
    >
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="m-0 text-[13px] font-semibold text-fg uppercase tracking-[0.10em]">
            Spend · last {days} days
          </h2>
          <span className="text-[11.5px] text-fg-dim">
            Estimated from your local token usage × per-model pricing. Authoritative invoice
            is your vendor's.
          </span>
        </div>
        <div className="flex items-baseline gap-3">
          <span className="text-[24px] font-semibold text-fg-strong ph-mono">
            {formatCost(cost.monthMicros)}
          </span>
          <span className="text-[11.5px] text-fg-mute">
            ≈ {formatCost(dailyAvg)} / day
          </span>
        </div>
      </div>

      {/* Daily bar chart */}
      <div style={{ width: '100%' }}>
        <svg
          viewBox={`0 0 ${chartW} ${chartH}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: 80, display: 'block' }}
          role="img"
          aria-label={`Daily cost trend over the last ${days} days`}
        >
          {denseByDay.map((d, i) => {
            const h = d.micros === 0 ? 1 : Math.max(1, (d.micros / maxDayMicros) * (chartH - 4));
            const x = i * (barW + gap);
            const y = chartH - h;
            return (
              <rect
                key={d.day}
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={1}
                fill={d.micros === 0 ? 'var(--surface-3)' : 'var(--accent)'}
                opacity={d.micros === 0 ? 0.4 : 0.9}
              >
                <title>
                  {d.day} · {formatCost(d.micros)} · {d.runs} run{d.runs === 1 ? '' : 's'}
                </title>
              </rect>
            );
          })}
        </svg>
        <div
          className="flex justify-between mt-1 text-[10.5px] ph-mono"
          style={{ color: 'var(--fg-dim)' }}
        >
          <span>{denseByDay[0]?.day ?? ''}</span>
          <span>{denseByDay[denseByDay.length - 1]?.day ?? 'today'}</span>
        </div>
      </div>

      {/* Per-connection breakdown */}
      {breakdown.byConnection.length > 0 && (
        <div className="flex flex-col gap-2 pt-1" style={{ borderTop: '.5px solid var(--divider)' }}>
          <div className="text-[10.5px] uppercase tracking-[0.10em] text-fg-dim font-semibold pt-2">
            By connection
          </div>
          {breakdown.byConnection.slice(0, 6).map((c) => {
            const pct = (c.micros / maxConnMicros) * 100;
            return (
              <div key={c.label} className="flex items-center gap-3">
                <span className="text-[12.5px] text-fg-strong flex-shrink-0" style={{ minWidth: 140 }}>
                  {c.label || '(unknown)'}
                </span>
                <div
                  className="flex-1 relative rounded-full"
                  style={{
                    height: 6,
                    background: 'var(--surface-2)',
                    overflow: 'hidden',
                  }}
                  title={`${formatCost(c.micros)} across ${c.runs} run${c.runs === 1 ? '' : 's'}`}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      background: c.micros > 0 ? 'var(--accent)' : 'var(--fg-dim)',
                      borderRadius: 999,
                      opacity: c.micros > 0 ? 0.85 : 0.3,
                    }}
                  />
                </div>
                <span
                  className="text-[11.5px] text-fg-mute ph-mono flex-shrink-0 text-right"
                  style={{ minWidth: 72 }}
                >
                  {formatCost(c.micros)}
                </span>
                <span
                  className="text-[10.5px] text-fg-dim ph-mono flex-shrink-0 text-right"
                  style={{ minWidth: 44 }}
                >
                  {c.runs}r
                </span>
              </div>
            );
          })}
          {cost.monthRunsUnpriced > 0 && (
            <span className="text-[11px] text-fg-dim mt-1">
              {cost.monthRunsUnpriced} additional run{cost.monthRunsUnpriced === 1 ? '' : 's'}{' '}
              not priced (local model, or model not in the pricing table). Set a per-connection
              override in <strong>Settings → Providers → edit connection → Advanced</strong>.
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * First-run "try the hotkey" tip. Shows once per install — dismissal is
 * persisted in the settings KV (`hotkey_tip_dismissed`). The card walks
 * the user through the actual core flow that's invisible from the UI:
 * select text anywhere → press the global hotkey → see the result in the
 * floating overlay. Without this, new users land on the dashboard and
 * don't realize the product's main feature isn't on this screen at all.
 */
function HotkeyTipCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section
      className="rounded-xl p-5 flex flex-col gap-3"
      style={{
        background:
          'linear-gradient(135deg, var(--accent-tint) 0%, var(--surface) 70%)',
        border: '.5px solid var(--accent-tint-2)',
        boxShadow: 'var(--accent-glow)',
      }}
    >
      <div className="flex items-start gap-3">
        <span
          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{
            background: 'var(--accent-tint-2)',
            color: 'var(--accent)',
          }}
        >
          <I.bolt size={20} />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="m-0 text-[15px] font-semibold text-fg-strong">
            Try it now — VibePrompter works from any app
          </h2>
          <p className="m-0 text-[12.5px] text-fg-mute mt-1.5 leading-relaxed">
            Select some text in any window (browser, email, IDE — anything),
            then press a hotkey. A floating overlay near your cursor shows the
            result. Hit <kbd className="ph-mono">Enter</kbd> to paste it back,{' '}
            <kbd className="ph-mono">Esc</kbd> to dismiss.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss tip"
          className="text-[11.5px] px-2 py-1 rounded transition-colors flex-shrink-0"
          style={{
            background: 'transparent',
            border: '.5px solid var(--border)',
            color: 'var(--fg-mute)',
            cursor: 'pointer',
          }}
          title="Don't show this again"
        >
          Got it
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-1">
        <TipHotkey
          accel="Ctrl+Alt+Space"
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
        style={{
          paddingTop: 10,
          borderTop: '.5px solid var(--accent-tint-2)',
        }}
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
    </section>
  );
}

function TipHotkey({
  accel,
  label,
  hint,
}: {
  accel: string;
  label: string;
  hint: string;
}) {
  return (
    <div
      className="rounded-lg p-3 flex flex-col gap-1"
      style={{
        background: 'var(--surface)',
        border: '.5px solid var(--border)',
      }}
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

/**
 * Loading-state skeleton for the dashboard. Mirrors the real layout's
 * rough shape — active mode card, run-prompt area, mode grid, shortcuts,
 * recent activity — so the page doesn't visibly jump when the data
 * arrives.
 */
function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading dashboard">
      <div
        className="rounded-xl p-5 flex items-center gap-4"
        style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
      >
        <div className="ph-shimmer" style={{ width: 48, height: 48, borderRadius: 12 }} />
        <div className="flex-1 flex flex-col gap-2 min-w-0">
          <div className="ph-shimmer" style={{ height: 11, width: 90 }} />
          <div className="ph-shimmer" style={{ height: 22, width: '38%' }} />
          <div className="ph-shimmer" style={{ height: 12, width: '60%' }} />
        </div>
        <div className="ph-shimmer" style={{ height: 32, width: 140, borderRadius: 8 }} />
      </div>

      <div
        className="rounded-xl p-5 flex flex-col gap-3"
        style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
      >
        <div className="ph-shimmer" style={{ height: 12, width: 110 }} />
        <div className="ph-shimmer" style={{ height: 80, width: '100%', borderRadius: 8 }} />
        <div className="flex justify-end gap-2">
          <div className="ph-shimmer" style={{ height: 32, width: 80, borderRadius: 8 }} />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="ph-shimmer"
            style={{ height: 46, borderRadius: 10 }}
          />
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <div className="ph-shimmer" style={{ height: 12, width: 140 }} />
        <div
          className="rounded-lg overflow-hidden flex flex-col"
          style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="px-4 py-3 flex items-center gap-3"
              style={{ borderTop: i === 0 ? 'none' : '.5px solid var(--divider)' }}
            >
              <div className="flex-1 flex flex-col gap-1.5">
                <div className="ph-shimmer" style={{ height: 12, width: '40%' }} />
                <div className="ph-shimmer" style={{ height: 10, width: '25%' }} />
              </div>
              <div className="ph-shimmer" style={{ height: 22, width: 90, borderRadius: 4 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Return a comma-separated list of action labels that share `accel` with at
 * least one other binding, or null if the row's accelerator is unique. Used
 * to render the "Conflict" badge in the dashboard.
 */
function conflictsFor(accel: string, all: ShortcutBinding[]): string | null {
  const peers = all.filter((s) => s.accelerator === accel);
  if (peers.length < 2) return null;
  return peers.map((p) => humanizeAction(p.action)).join(', ');
}

/**
 * Compute the mode that the next "Cycle" press will land on. Mirrors the
 * backend's `TrayState::advance` wrap-around so the label stays truthful.
 */
function nextMode(active: ActiveMode | null, modes: CatalogMode[]): CatalogMode | null {
  if (modes.length === 0) return null;
  if (!active) return modes[0];
  const idx = modes.findIndex((m) => m.id === active.id);
  if (idx < 0) return modes[0];
  return modes[(idx + 1) % modes.length];
}

/**
 * Lossy "5m ago"-style formatter — good enough for the dashboard's at-a-glance
 * activity strip without pulling in date-fns at the top level.
 */
/** Format micro-USD (1 USD = 1,000,000 micros) as a short dollar string.
 *  Sub-cent values become "<$0.01" so users don't see "$0.00" and assume
 *  the calculation is broken. Estimates only — see backend pricing.rs. */
function formatCost(micros: number): string {
  if (micros <= 0) return '$0';
  const usd = micros / 1_000_000;
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

function relativeTime(rfc3339: string): string {
  const then = Date.parse(rfc3339);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Translate the seeded `action` slugs into the labels we want to show next to
 * the kbd chip. Cheaper than threading display names through the DB while the
 * action vocabulary is this small.
 */
function humanizeAction(action: string): string {
  switch (action) {
    case 'mode_switch':
      return 'Cycle prompt mode';
    case 'open_palette':
      return 'Open command palette';
    case 'rewrite_selection':
      return 'Rewrite selection';
    case 'fix_grammar':
      return 'Fix grammar';
    case 'summarize':
      return 'Quick summarize';
    default:
      return action;
  }
}
