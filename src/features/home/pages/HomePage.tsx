import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listen } from '@tauri-apps/api/event';
import { I, PhButton, useToast, type IconName } from '@shared/ui';
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
  usage?: { inputTokens: number; outputTokens: number };
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
}

interface AppSettings {
  boot_start: boolean;
  notifications: boolean;
  quit_on_close: boolean;
  minimize_to_tray: boolean;
  stream_response: boolean;
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
  const toast = useToast();
  const [active, setActive] = useState<ActiveMode | null>(null);
  const [modes, setModes] = useState<CatalogMode[]>([]);
  const [shortcuts, setShortcuts] = useState<ShortcutBinding[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [recent, setRecent] = useState<HistoryItem[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [health, setHealth] = useState<HealthReport | null>(null);

  const reloadSettings = () =>
    invokeCommand<AppSettings>('get_settings').then(setSettings).catch(() => {});

  const reloadAll = () => {
    invokeCommand<ActiveMode>('get_active_mode').then(setActive).catch(() => {});
    invokeCommand<ShortcutBinding[]>('list_global_shortcuts').then(setShortcuts).catch(() => {});
    invokeCommand<HistoryItem[]>('get_history', { query: { limit: 4, offset: 0 } })
      .then(setRecent)
      .catch(() => {});
    invokeCommand<Connection[]>('list_connections').then(setConnections).catch(() => {});
    invokeCommand<HealthReport>('run_health_check').then(setHealth).catch(() => {});
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
    invokeCommand<Connection[]>('list_connections').then(setConnections).catch(() => {});
    invokeCommand<HealthReport>('run_health_check').then(setHealth).catch(() => {});

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
    // The settings_changed event is fired from `SettingsService::save` —
    // re-fetch so toggles flipped elsewhere (tray, future panels) stay live.
    const settingsPromise = listen('settings_changed', () => reloadSettings());
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(inFlightTimer);
      modePromise.then((u) => u()).catch(() => {});
      settingsPromise.then((u) => u()).catch(() => {});
    };
  }, []);

  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CompletionResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<{ inFlight: number; capacity: number } | null>(null);
  // Tracks whether we've already auto-focused the textarea this session so the
  // ref-callback doesn't re-focus on every render (which would steal focus
  // mid-typing). Stays true after the first focus until the component unmounts.
  const inputFocused = useRef(false);

  // History panel's "Reuse" button stashes the source text here. Hydrate
  // it once on mount, then clear so a later route change doesn't re-fill.
  useEffect(() => {
    try {
      const stashed = sessionStorage.getItem('dashboard:input-stash');
      if (stashed) {
        setInput(stashed);
        sessionStorage.removeItem('dashboard:input-stash');
      }
    } catch {}
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
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const runPrompt = async () => {
    if (!active || !input.trim() || running) return;
    setRunning(true);
    setRunError(null);
    setResult({ text: '', model: '', latencyMs: 0 });

    // When the user has disabled streaming, take the simpler blocking path —
    // matches the user's intent and avoids SSE on networks that proxy it badly.
    if (settings && settings.stream_response === false) {
      try {
        const r = await invokeCommand<CompletionResult>('run_prompt', {
          modeId: active.id,
          input,
        });
        setResult(r);
        invokeCommand<HistoryItem[]>('get_history', { query: { limit: 4, offset: 0 } })
          .then(setRecent)
          .catch(() => {});
      } catch (e) {
        setRunError(typeof e === 'string' ? e : String(e));
        setResult(null);
      } finally {
        setRunning(false);
      }
      return;
    }

    const newStreamId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setStreamId(newStreamId);
    const tokenEv = `stream:${newStreamId}:token`;
    const doneEv = `stream:${newStreamId}:done`;
    const errEv = `stream:${newStreamId}:error`;

    const unlistens: Array<() => void> = [];
    const cleanup = () => unlistens.forEach((u) => u());

    try {
      let buf = '';
      unlistens.push(
        await listen<string>(tokenEv, (e) => {
          buf += e.payload;
          setResult((prev) => (prev ? { ...prev, text: buf } : { text: buf, model: '', latencyMs: 0 }));
        })
      );
      unlistens.push(
        await listen<CompletionResult>(doneEv, (e) => {
          setResult(e.payload);
          invokeCommand<HistoryItem[]>('get_history', { query: { limit: 4, offset: 0 } })
            .then(setRecent)
            .catch(() => {});
          setRunning(false);
          setStreamId(null);
          cleanup();
        })
      );
      unlistens.push(
        await listen<string>(errEv, (e) => {
          // 'cancelled' is the sentinel the backend emits when the user hit
          // Stop — treat it as a graceful end (keep partial output visible),
          // not an error.
          if (e.payload === 'cancelled') {
            setRunError(null);
          } else {
            setRunError(e.payload);
            setResult(null);
          }
          setRunning(false);
          setStreamId(null);
          cleanup();
        })
      );

      await invokeCommand<void>('run_prompt_stream', {
        streamId: newStreamId,
        modeId: active.id,
        input,
      });
    } catch (e) {
      cleanup();
      setRunError(typeof e === 'string' ? e : String(e));
      setResult(null);
      setRunning(false);
      setStreamId(null);
    }
  };

  const stopPrompt = () => {
    if (!streamId) return;
    invokeCommand<void>('cancel_stream', { streamId }).catch(() => {});
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

  /** Cycle dark → light → system → dark. Same options the Appearance panel
      exposes, but reachable without leaving the dashboard. */
  const cycleTheme = () => {
    if (!settings) return;
    const order = ['dark', 'light', 'system'] as const;
    const idx = order.indexOf(settings.theme as (typeof order)[number]);
    const next = order[(idx + 1) % order.length];
    const updated = { ...settings, theme: next };
    setSettings(updated);
    invokeCommand<void>('save_settings', { settings: updated }).catch(() => {
      setSettings(settings);
    });
  };

  const activeIconKey = (active?.iconName ?? 'bolt') as IconName;
  const ActiveIcon =
    (I as Record<string, React.ComponentType<{ size?: number }>>)[activeIconKey] ?? I.bolt;

  const defaultConn = connections.find((c) => c.isDefault);
  const usableConn = defaultConn?.hasKey ? defaultConn : null;
  const connectionNotice = (() => {
    if (connections.length === 0) {
      return {
        kind: 'empty' as const,
        title: 'No provider connection yet',
        body: 'Add an OpenAI / Anthropic / OpenRouter / Ollama / any vendor connection to start running prompts.',
        cta: 'Add a connection',
      };
    }
    if (!defaultConn) {
      return {
        kind: 'missing-default' as const,
        title: 'No default connection',
        body: 'Pick which connection prompts should run through.',
        cta: 'Set a default',
      };
    }
    if (!defaultConn.hasKey) {
      return {
        kind: 'missing-key' as const,
        title: `"${defaultConn.label}" has no API key`,
        body: 'Add the key so completions can authenticate with the vendor.',
        cta: 'Add API key',
      };
    }
    return null;
  })();

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

        {health && health.issues.length > 0 && (
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

        {connections.length === 0 ? (
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
        ) : (

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
              {usableConn
                ? `${usableConn.label}${
                    usableConn.defaultModel ? ` · ${usableConn.defaultModel}` : ''
                  } · ${active?.name ?? 'no mode'}`
                : active
                ? `${active.name} mode`
                : 'Pick a mode above'}
            </span>
          </div>

          {connectionNotice && (
            <div
              className="rounded-md p-3 flex items-center gap-3"
              style={{
                background: 'var(--accent-tint)',
                border: '.5px solid var(--accent-tint-2)',
              }}
            >
              <span
                className="w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0"
                style={{ background: 'var(--surface)', color: 'var(--accent)' }}
              >
                <I.cloud size={16} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-fg-strong font-medium">
                  {connectionNotice.title}
                </div>
                <div className="text-[12px] text-fg-mute mt-0.5">{connectionNotice.body}</div>
              </div>
              <PhButton
                size="sm"
                variant="primary"
                icon={<I.plus size={12} />}
                onClick={() => navigate('/settings/providers')}
              >
                {connectionNotice.cta}
              </PhButton>
            </div>
          )}
          <textarea
            ref={(el) => {
              // Autofocus when the widget first becomes usable. We watch via
              // ref-callback so it fires once after mount + once after the
              // empty-state replacement swaps in the real widget — not on
              // every render (which would steal focus mid-typing).
              if (el && usableConn && !inputFocused.current) {
                inputFocused.current = true;
                el.focus();
              }
            }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste or type the text you want to transform. Ctrl+Enter runs."
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
                {result.usage && (result.usage.inputTokens > 0 || result.usage.outputTokens > 0) && (
                  <>
                    <span>·</span>
                    <span title="Vendor-reported token usage (input → output)">
                      {result.usage.inputTokens} → {result.usage.outputTokens} tok
                    </span>
                  </>
                )}
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
            <span className="text-[11px] text-fg-dim ph-mono mr-auto">
              <kbd
                className="ph-mono text-[10.5px] px-1.5 py-0.5 rounded mr-0.5"
                style={{ background: 'var(--surface-2)', border: '.5px solid var(--border-strong)' }}
              >
                Ctrl
              </kbd>
              +
              <kbd
                className="ph-mono text-[10.5px] px-1.5 py-0.5 rounded mx-0.5"
                style={{ background: 'var(--surface-2)', border: '.5px solid var(--border-strong)' }}
              >
                Enter
              </kbd>
              to run
            </span>
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
            {running ? (
              <PhButton
                variant="danger"
                size="md"
                icon={<I.close size={14} />}
                onClick={stopPrompt}
                title="Stop generation"
              >
                Stop
              </PhButton>
            ) : (
              <PhButton
                variant="primary"
                size="md"
                icon={<I.bolt size={14} />}
                onClick={runPrompt}
                disabled={!active || !input.trim() || !usableConn}
                title={!usableConn ? 'Add a connection first' : 'Run prompt (Ctrl+Enter)'}
              >
                Run
              </PhButton>
            )}
          </div>
        </section>
        )}

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
            <button
              type="button"
              onClick={cycleTheme}
              className="text-[11.5px] text-fg-mute ph-mono px-2 py-0.5 rounded transition-colors"
              style={{
                background: 'var(--surface-2)',
                border: '.5px solid var(--border)',
                cursor: 'pointer',
              }}
              title="Cycle theme — click to switch dark / light / system"
            >
              {settings.theme === 'dark' ? '☾' : settings.theme === 'light' ? '☀' : '⌘'}{' '}
              {settings.theme}
            </button>
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
                        {(h.inputTokens ?? 0) + (h.outputTokens ?? 0) > 0 && (
                          <> · {h.inputTokens}→{h.outputTokens} tok</>
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

        <footer
          className="flex items-center justify-between pt-4"
          style={{ borderTop: '.5px solid var(--divider)' }}
        >
          <span className="text-[11.5px] text-fg-dim ph-mono flex items-center gap-2">
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
