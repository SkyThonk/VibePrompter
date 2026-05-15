import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listen } from '@tauri-apps/api/event';
import { I, PhButton, type IconName } from '@shared/ui';
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
}

interface CompletionResult {
  text: string;
  model: string;
  latencyMs: number;
}

interface HistoryItem {
  id: number;
  mode: string;
  iconName: string;
  provider: string;
  ms: number;
  createdAt: string;
}

interface AppSettings {
  boot_start: boolean;
  notifications: boolean;
  quit_on_close: boolean;
  minimize_to_tray: boolean;
  theme: string;
  accent: string;
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
  const [active, setActive] = useState<ActiveMode | null>(null);
  const [modes, setModes] = useState<CatalogMode[]>([]);
  const [shortcuts, setShortcuts] = useState<ShortcutBinding[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [recent, setRecent] = useState<HistoryItem[]>([]);

  const reloadSettings = () =>
    invokeCommand<AppSettings>('get_settings').then(setSettings).catch(() => {});

  const reloadAll = () => {
    invokeCommand<ActiveMode>('get_active_mode').then(setActive).catch(() => {});
    invokeCommand<ShortcutBinding[]>('list_global_shortcuts').then(setShortcuts).catch(() => {});
    invokeCommand<HistoryItem[]>('get_history', { query: { limit: 4, offset: 0 } })
      .then(setRecent)
      .catch(() => {});
    reloadSettings();
  };

  useEffect(() => {
    invokeCommand<ActiveMode>('get_active_mode').then(setActive).catch(() => {});
    invokeCommand<CatalogMode[]>('list_modes').then(setModes).catch(() => setModes([]));
    invokeCommand<ShortcutBinding[]>('list_global_shortcuts')
      .then(setShortcuts)
      .catch(() => setShortcuts([]));
    reloadSettings();
    invokeCommand<HistoryItem[]>('get_history', { query: { limit: 4, offset: 0 } })
      .then(setRecent)
      .catch(() => setRecent([]));

    // Browser-style window focus event — fires when the Tauri webview
    // regains focus (user clicks back into the window after using the tray).
    // Re-pull dynamic data so anything done via tray menu / global hotkey
    // (which already emit events, but a stale render is cheap to fix).
    const onFocus = () => reloadAll();
    window.addEventListener('focus', onFocus);

    const modePromise = listen<ActiveMode>('mode_changed', (e) => setActive(e.payload));
    // The settings_changed event is fired from `SettingsService::save` —
    // re-fetch so toggles flipped elsewhere (tray, future panels) stay live.
    const settingsPromise = listen('settings_changed', () => reloadSettings());
    return () => {
      window.removeEventListener('focus', onFocus);
      modePromise.then((u) => u()).catch(() => {});
      settingsPromise.then((u) => u()).catch(() => {});
    };
  }, []);

  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CompletionResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const runPrompt = async () => {
    if (!active || !input.trim() || running) return;
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      const r = await invokeCommand<CompletionResult>('run_prompt', {
        modeId: active.id,
        input,
      });
      setResult(r);
      // Refresh recent activity since we just appended to history.
      invokeCommand<HistoryItem[]>('get_history', { query: { limit: 4, offset: 0 } })
        .then(setRecent)
        .catch(() => {});
    } catch (e) {
      const msg = typeof e === 'string' ? e : String(e);
      setRunError(msg);
    } finally {
      setRunning(false);
    }
  };

  const copyResult = () => {
    if (!result?.text) return;
    navigator.clipboard.writeText(result.text).catch(() => {});
  };

  const cycleMode = () =>
    invokeCommand<void>('cycle_mode_cmd').catch(() => {});

  const pickMode = (id: string) =>
    invokeCommand<void>('set_active_mode', { id }).catch(() => {});

  const quitApp = () => invokeCommand<void>('quit_app').catch(() => {});

  const toggleSetting = (key: keyof AppSettings) => {
    if (!settings) return;
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next); // optimistic — the backend event will reconcile
    invokeCommand<void>('save_settings', { settings: next }).catch(() => {
      // Rollback on failure so the UI doesn't lie.
      setSettings(settings);
    });
  };

  const activeIconKey = (active?.iconName ?? 'bolt') as IconName;
  const ActiveIcon =
    (I as Record<string, React.ComponentType<{ size?: number }>>)[activeIconKey] ?? I.bolt;

  return (
    <div
      className="ph-root min-h-screen"
      style={{
        background:
          'radial-gradient(60% 45% at 50% 30%, rgba(167,139,250,0.06), transparent 70%), radial-gradient(40% 40% at 80% 80%, rgba(107,138,253,0.05), transparent 70%), var(--bg)',
      }}
    >
      <div className="max-w-[840px] mx-auto px-8 py-12 flex flex-col gap-8">
        <header className="flex items-center gap-4">
          <span className="ph-mark xl" />
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

        <section
          className="rounded-xl p-5 flex items-center gap-4"
          style={{
            background: 'var(--surface)',
            border: '.5px solid var(--border)',
            boxShadow: 'var(--accent-glow)',
          }}
        >
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
            <div
              className="text-[10.5px] uppercase tracking-[0.12em] text-fg-dim font-semibold"
            >
              Active mode
            </div>
            <div className="text-[20px] font-semibold text-fg-strong leading-tight">
              {active?.name ?? '—'}
            </div>
          </div>
          <PhButton
            variant="primary"
            size="md"
            icon={<I.refresh size={14} />}
            onClick={cycleMode}
            title="Cycle to next mode (Ctrl+Shift+M globally, Ctrl+M in-window)"
          >
            {nextMode(active, modes)
              ? `Cycle → ${nextMode(active, modes)!.name}`
              : 'Cycle'}
          </PhButton>
        </section>

        <section
          className="rounded-xl p-5 flex flex-col gap-3"
          style={{
            background: 'var(--surface)',
            border: '.5px solid var(--border)',
          }}
        >
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-[13px] font-semibold text-fg uppercase tracking-[0.10em]">
              Run a prompt
            </h2>
            <span className="text-[11.5px] text-fg-dim">
              {active ? `Using ${active.name} mode` : 'Pick a mode above'}
            </span>
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste or type the text you want to transform. Cmd/Ctrl+Enter to run."
            rows={4}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                runPrompt();
              }
            }}
            className="w-full text-[13px] resize-y rounded-md px-3 py-2 outline-none transition-colors"
            style={{
              background: 'var(--bg-2)',
              border: '.5px solid var(--border-strong)',
              color: 'var(--fg)',
              fontFamily: 'var(--sans)',
              minHeight: 80,
            }}
          />
          {runError && (
            <div
              className="rounded-md px-3 py-2 text-[12.5px] flex items-start gap-2"
              style={{
                background: 'rgba(248,113,113,0.10)',
                color: 'var(--danger)',
                border: '.5px solid rgba(248,113,113,0.30)',
              }}
            >
              <span className="flex-1">{runError}</span>
              {runError.toLowerCase().includes('no default connection') && (
                <button
                  type="button"
                  onClick={() => navigate('/settings/providers')}
                  className="text-[11.5px] underline"
                  style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
                >
                  Add a connection →
                </button>
              )}
            </div>
          )}
          {result && (
            <div
              className="rounded-md p-3 flex flex-col gap-2"
              style={{
                background: 'var(--bg-2)',
                border: '.5px solid var(--border)',
              }}
            >
              <div className="flex items-center gap-2 text-[11px] text-fg-dim ph-mono">
                <span>{result.model}</span>
                <span>·</span>
                <span>{result.latencyMs}ms</span>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={copyResult}
                  className="text-[11px] hover:text-fg-strong transition-colors"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-mute)' }}
                  title="Copy result to clipboard"
                >
                  Copy
                </button>
              </div>
              <pre
                className="m-0 text-[13px] whitespace-pre-wrap break-words"
                style={{
                  color: 'var(--fg-strong)',
                  fontFamily: 'var(--sans)',
                  maxHeight: 260,
                  overflow: 'auto',
                }}
              >
                {result.text}
              </pre>
            </div>
          )}
          <div className="flex items-center gap-2 justify-end">
            {input && (
              <button
                type="button"
                onClick={() => {
                  setInput('');
                  setResult(null);
                  setRunError(null);
                }}
                className="text-[11.5px] text-fg-mute hover:text-fg transition-colors"
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                Clear
              </button>
            )}
            <PhButton
              variant="primary"
              size="md"
              icon={running ? undefined : <I.bolt size={14} />}
              onClick={runPrompt}
              disabled={!active || !input.trim() || running}
              title="Run prompt (Ctrl+Enter)"
            >
              {running ? 'Running…' : 'Run'}
            </PhButton>
          </div>
        </section>

        {settings && (
          <section
            className="rounded-lg px-4 py-3 flex items-center gap-2 flex-wrap"
            style={{
              background: 'var(--surface)',
              border: '.5px solid var(--border)',
            }}
          >
            <StatusToggle
              label="Start at login"
              on={settings.boot_start}
              onClick={() => toggleSetting('boot_start')}
            />
            <StatusToggle
              label="Notifications"
              on={settings.notifications}
              onClick={() => toggleSetting('notifications')}
            />
            <StatusToggle
              label="Minimize to tray"
              on={settings.minimize_to_tray}
              onClick={() => toggleSetting('minimize_to_tray')}
            />
            <span style={{ flex: 1 }} />
            <span
              className="text-[11.5px] text-fg-dim ph-mono px-1.5 py-0.5 rounded"
              style={{
                background: 'var(--surface-2)',
                border: '.5px solid var(--border)',
              }}
              title="Current theme · accent"
            >
              {settings.theme} · {settings.accent}
            </span>
          </section>
        )}

        <section className="flex flex-col gap-2">
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
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {modes.map((m) => {
              const Icon =
                (I as Record<string, React.ComponentType<{ size?: number }>>)[m.iconName] ??
                I.bolt;
              const isActive = m.id === active?.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => pickMode(m.id)}
                  aria-pressed={isActive}
                  aria-label={`Switch to ${m.name} mode`}
                  className="rounded-lg p-3 flex items-center gap-2.5 text-left transition-[background,border-color,transform] duration-150 active:scale-[0.98]"
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
        </section>

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
                    Ctrl+Shift+Space
                  </kbd>{' '}
                  anywhere to open the command palette and run your first
                  prompt.
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

        <footer
          className="flex items-center justify-between pt-4"
          style={{ borderTop: '.5px solid var(--divider)' }}
        >
          <span className="text-[11.5px] text-fg-dim ph-mono">
            VibePrompter · close to hide to tray
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
 * Compact on/off chip the dashboard uses for quick settings access. Clicking
 * flips the value optimistically — the parent reconciles via the
 * `settings_changed` event the backend already emits after `save`.
 */
function StatusToggle({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11.5px] flex items-center gap-1.5 px-2 py-1 rounded transition-colors"
      style={{
        background: on ? 'var(--accent-tint)' : 'var(--surface-2)',
        color: on ? 'var(--accent)' : 'var(--fg-mute)',
        border: `.5px solid ${on ? 'var(--accent-tint-2)' : 'var(--border)'}`,
        cursor: 'pointer',
      }}
      title={`${label}: ${on ? 'on — click to disable' : 'off — click to enable'}`}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: on ? 'var(--ok)' : 'var(--fg-dim)' }}
      />
      {label}
    </button>
  );
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
