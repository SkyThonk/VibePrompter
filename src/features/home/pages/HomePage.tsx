import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listen } from '@tauri-apps/api/event';
import { I, PhButton, useToast, AppIcon, type IconName } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';
import { relativeTimeAgo } from '@shared/lib/date';
import { useShortcuts } from '@shared/lib';
import { CostCard } from '../ui/CostCard';
import { HowToUseCard } from '../ui/HowToUseCard';
import { DashboardSkeleton } from '../ui/DashboardSkeleton';
import { conflictsFor, formatCost, humanizeAction, nextMode } from '../ui/helpers';
import type {
  ActiveMode,
  CatalogMode,
  Connection,
  CostBreakdown,
  CostSummary,
  HealthReport,
  HistoryItem,
  ShortcutBinding,
} from '../ui/types';

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
  const { accel } = useShortcuts();
  const [active, setActive] = useState<ActiveMode | null>(null);
  const [modes, setModes] = useState<CatalogMode[]>([]);
  const [shortcuts, setShortcuts] = useState<ShortcutBinding[]>([]);
  const [recent, setRecent] = useState<HistoryItem[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [costBreakdown, setCostBreakdown] = useState<CostBreakdown | null>(null);
  const [howToCollapsed, setHowToCollapsed] = useState(false);
  // Tracks whether the initial parallel fetch batch has resolved. Until it
  // flips true, empty arrays / null states are indistinguishable from "still
  // loading", so each section renders a shimmer skeleton instead of its
  // empty-state placeholder. A subsequent reload (window focus, event push)
  // does NOT toggle this back — we only ever want the skeleton on first paint.
  const [bootLoaded, setBootLoaded] = useState(false);
  const [inFlight, setInFlight] = useState<{ inFlight: number; capacity: number } | null>(null);

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
      // The "How to use" card is always on the dashboard (the core flow lives
      // outside this window, so we keep it one glance away). Persist only its
      // collapsed/expanded state — expanded by default for newcomers.
      invokeCommand<string | null>('get_kv', { key: 'howto_collapsed' }).then((v) => {
        if (v && JSON.parse(v) === true) setHowToCollapsed(true);
      }),
      // Right after onboarding, show the "How it works" guide once. Onboarding
      // sets this flag; we consume + clear it so it never re-fires on later
      // launches. Returning users open the guide on demand from the header.
      invokeCommand<string | null>('get_kv', { key: 'guide_after_onboarding' }).then((v) => {
        if (v && JSON.parse(v) === true) {
          window.setTimeout(() => window.dispatchEvent(new Event('app:show-guide')), 450);
          invokeCommand<void>('set_kv', {
            key: 'guide_after_onboarding',
            value: JSON.stringify(false),
          }).catch(() => {});
        }
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
    // Backend fires `history_changed` after every successful prompt run or
    // history clear. Refresh the recent-activity strip + cost widgets so
    // the user sees a new run land without waiting for window focus.
    const historyPromise = listen('history_changed', () => {
      invokeCommand<HistoryItem[]>('get_history', { query: { limit: 4, offset: 0 } })
        .then(setRecent)
        .catch(() => {});
      invokeCommand<CostSummary>('get_cost_summary').then(setCost).catch(() => {});
      invokeCommand<CostBreakdown>('get_cost_breakdown', { days: 30 })
        .then(setCostBreakdown)
        .catch(() => {});
    });
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(inFlightTimer);
      modePromise.then((u) => u()).catch(() => {});
      historyPromise.then((u) => u()).catch(() => {});
    };
  }, []);

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
      } catch {
        // Best-effort: the "what's new" toast is a nicety, never block boot on it.
      }
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
              icon={<I.sparkles size={14} />}
              onClick={() => window.dispatchEvent(new Event('app:show-guide'))}
              title="See how VibePrompter works"
            >
              How it works
            </PhButton>
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

        {bootLoaded && (
          <HowToUseCard
            collapsed={howToCollapsed}
            onToggle={() => {
              const next = !howToCollapsed;
              setHowToCollapsed(next);
              invokeCommand<void>('set_kv', {
                key: 'howto_collapsed',
                value: JSON.stringify(next),
              }).catch(() => {});
            }}
            onOpenGuide={() => window.dispatchEvent(new Event('app:show-guide'))}
          />
        )}

        {bootLoaded && health && health.issues.length > 0 && (
          <section className="flex flex-col gap-1.5 w-full min-w-0">
            {health.issues.map((issue) => (
              <div
                key={issue.code}
                className="rounded-lg px-3 py-2 flex items-start gap-2 text-[12.5px] w-full min-w-0"
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
                  boxSizing: 'border-box',
                }}
              >
                <I.info size={14} style={{ marginTop: 2, flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{issue.message}</span>
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
                      {accel('rewrite')}
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
                    Grammar ({accel('grammar')}) and Summarize ({accel('summary')}) have their own dedicated prompts and ignore this setting.
                  </div>
                </div>
                <PhButton
                  variant="primary"
                  size="md"
                  icon={<I.refresh size={14} />}
                  onClick={cycleMode}
                  title={`Cycle to next mode (${accel('modes')} globally, Ctrl+M in-window)`}
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
                    {accel('palette')}
                  </kbd>{' '}
                  anywhere to open the app, or{' '}
                  <kbd
                    className="ph-mono text-[10.5px] px-1 py-0.5 rounded"
                    style={{
                      background: 'var(--surface-2)',
                      border: '.5px solid var(--border-strong)',
                    }}
                  >
                    {accel('rewrite')}
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
                      {relativeTimeAgo(h.createdAt)}
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
