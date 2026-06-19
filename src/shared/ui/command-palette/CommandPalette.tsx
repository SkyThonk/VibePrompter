import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeCommand } from '@kernel/infrastructure/tauri';
import { I, type IconName } from '../Icon';
import { useToast } from '../toast/ToastProvider';

/**
 * Lightweight Cmd+K command palette mounted at the app shell. Combines:
 *   - Static actions: navigate to settings panels, cycle mode, quit, exit-tray
 *   - Dynamic actions: "Switch to <mode>" for every mode in the catalog
 *
 * Designed to surface the keyboard-first power-user path without forcing
 * users to remember every global hotkey. Opens on Ctrl/Cmd+K, closes on
 * Esc, accepts on Enter, navigates with Up/Down arrows.
 */
export interface Command {
  id: string;
  label: string;
  hint?: string;
  iconName?: IconName;
  /** Lowercased haystack for filter. Auto-derived from label+hint when omitted. */
  search?: string;
  run: () => void | Promise<void>;
}

interface CatalogMode {
  id: string;
  name: string;
  iconName: string;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [modes, setModes] = useState<CatalogMode[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Toggle on Ctrl/Cmd+K from anywhere — global so input focus doesn't
  // matter. e.preventDefault stops Chrome's address-bar shortcut in the
  // webview (Tauri inherits Chromium's bindings).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => {
          if (!v) {
            setQuery('');
            setHighlight(0);
          }
          return !v;
        });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Refresh mode list whenever the palette opens — cheap (already cached
  // by the catalog query path) and keeps the list fresh after mode edits.
  useEffect(() => {
    if (!open) return;
    invokeCommand<CatalogMode[]>('list_modes').then(setModes).catch(() => {});
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: 'go.home', label: 'Go to Dashboard', iconName: 'wand', run: () => navigate('/app') },
      {
        id: 'help.guide',
        label: 'How it works (guide)',
        iconName: 'sparkles',
        search: 'help guide how it works tutorial getting started learn',
        run: () => {
          window.dispatchEvent(new Event('app:show-guide'));
        },
      },
      { id: 'go.settings', label: 'Open Settings', iconName: 'cog', hint: 'Ctrl+,', run: () => navigate('/settings') },
      { id: 'go.providers', label: 'Manage connections', iconName: 'cloud', run: () => navigate('/settings/providers') },
      { id: 'go.modes', label: 'Manage modes', iconName: 'layers', run: () => navigate('/settings/modes') },
      { id: 'go.shortcuts', label: 'Edit shortcuts', iconName: 'keyboard', run: () => navigate('/settings/shortcuts') },
      { id: 'go.history', label: 'View history', iconName: 'history', run: () => navigate('/settings/history') },
      { id: 'go.about', label: 'About / diagnostics', iconName: 'info', run: () => navigate('/settings/about') },
    ];
    const actions: Command[] = [
      {
        id: 'cycle',
        label: 'Cycle prompt mode',
        iconName: 'refresh',
        hint: 'Ctrl+M',
        run: () => invokeCommand<void>('cycle_mode_cmd').catch(() => {}),
      },
      {
        id: 'hide',
        label: 'Hide to tray',
        iconName: 'close',
        hint: 'Esc',
        run: () => invokeCommand<void>('hide_main_window').catch(() => {}),
      },
      {
        id: 'quit',
        label: 'Quit VibePrompter',
        iconName: 'power',
        run: () => invokeCommand<void>('quit_app').catch(() => {}),
      },
    ];
    const modeJumps: Command[] = modes.map((m) => ({
      id: `mode.${m.id}`,
      label: `Switch to ${m.name}`,
      iconName: m.iconName as IconName,
      search: `switch mode ${m.name} ${m.id}`,
      run: () =>
        invokeCommand<void>('set_active_mode', { id: m.id })
          .then(() => toast.ok(`${m.name} is now active`))
          .catch(() => {}),
    }));
    return [...nav, ...actions, ...modeJumps];
  }, [navigate, modes, toast]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = (c.search ?? `${c.label} ${c.hint ?? ''}`).toLowerCase();
      return hay.includes(q);
    });
  }, [commands, query]);

  // Clamp highlight to valid range — computed rather than via an effect
  // to avoid a redundant render cycle when the list shrinks.
  const activeHighlight = filtered.length === 0 ? 0 : Math.min(highlight, filtered.length - 1);

  const runCommand = async (cmd: Command) => {
    close();
    try {
      await cmd.run();
    } catch (e) {
      toast.err(String(e), 'Command failed');
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[activeHighlight];
      if (cmd) runCommand(cmd);
    }
  };

  if (!open) return null;

  return (
    <div
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        background: 'rgba(10, 11, 15, 0.45)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '15vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="ph-anim-pop-in"
        style={{
          width: 'min(560px, 92vw)',
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
            padding: '10px 14px',
            borderBottom: '.5px solid var(--divider)',
          }}
        >
          <I.search size={14} style={{ color: 'var(--fg-mute)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command, page, or mode…"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--fg-strong)',
              fontSize: 14,
              fontFamily: 'var(--sans)',
            }}
          />
          <kbd
            className="ph-mono"
            style={{
              padding: '2px 6px',
              borderRadius: 4,
              background: 'var(--surface-2)',
              border: '.5px solid var(--border-strong)',
              color: 'var(--fg-mute)',
              fontSize: 10.5,
            }}
          >
            Esc
          </kbd>
        </div>

        <div style={{ maxHeight: '50vh', overflow: 'auto', padding: '6px 0' }}>
          {filtered.length === 0 && (
            <div style={{ padding: '14px 16px', fontSize: 12.5, color: 'var(--fg-dim)' }}>
              No commands match “{query}”.
            </div>
          )}
          {filtered.map((c, i) => {
            const Icon = c.iconName ? I[c.iconName] : I.bolt;
            const active = i === activeHighlight;
            return (
              <CommandRow
                key={c.id}
                cmd={c}
                icon={<Icon size={14} />}
                active={active}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => runCommand(c)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CommandRow({
  cmd,
  icon,
  active,
  onMouseEnter,
  onClick,
}: {
  cmd: Command;
  icon: ReactNode;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        background: active ? 'var(--accent-tint)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 5,
          background: active ? 'var(--surface)' : 'var(--surface-2)',
          color: active ? 'var(--accent)' : 'var(--fg-mute)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, fontSize: 13, color: 'var(--fg-strong)' }}>
        {cmd.label}
      </span>
      {cmd.hint && (
        <span
          className="ph-mono"
          style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}
        >
          {cmd.hint}
        </span>
      )}
    </button>
  );
}
