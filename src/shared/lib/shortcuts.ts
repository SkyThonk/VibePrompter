import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeCommand, onEvent } from '@kernel/infrastructure/tauri';

/**
 * Live global-shortcut bindings for the read-only surfaces (dashboard hints,
 * the "How it works" guide, the cheat sheet). These all used to hardcode the
 * default accelerators, so a user who rebound (say) Rewrite to a custom combo
 * still saw "Ctrl+Alt+F" everywhere. This hook reads the same `list_shortcuts`
 * data the Settings → Shortcuts editor writes, so every hint reflects the
 * user's actual binding — and refreshes when they change one.
 */
export interface ShortcutItem {
  id: string;
  label: string;
  hint: string;
  iconName: string;
  accelerator: string;
  action: string;
  enabled: boolean;
  keys: string[];
}

/**
 * Default accelerators — must mirror the seed in migration `0001_initial.sql`.
 * Used as a fallback before the live bindings resolve, or if a row is missing.
 */
export const SHORTCUT_DEFAULTS: Record<string, string> = {
  palette: 'Ctrl+Alt+V',
  rewrite: 'Ctrl+Alt+F',
  grammar: 'Ctrl+Alt+G',
  summary: 'Ctrl+Alt+S',
  modes: 'Ctrl+Alt+M',
};

export type ShortcutId = keyof typeof SHORTCUT_DEFAULTS;

/** Render an accelerator ("Ctrl+Alt+F") as spaced prose ("Ctrl + Alt + F"). */
export function prettyAccel(accel: string): string {
  return accel
    .split('+')
    .map((s) => s.trim())
    .join(' + ');
}

// Shared with the settings feature's `useShortcutsQuery` so both read one cache.
const SHORTCUTS_KEY = ['settings', 'shortcuts'] as const;

export interface ShortcutLookup {
  /** Raw accelerator for a shortcut id, e.g. "Ctrl+Alt+F". Falls back to the seed default. */
  accel: (id: ShortcutId | string) => string;
  /** Accelerator formatted for prose/kbd display, e.g. "Ctrl + Alt + F". */
  pretty: (id: ShortcutId | string) => string;
  /** Accelerator split into key tokens, e.g. ["Ctrl", "Alt", "F"]. */
  keys: (id: ShortcutId | string) => string[];
  /** All configured shortcuts (empty until the query resolves). */
  items: ShortcutItem[];
}

export function useShortcuts(): ShortcutLookup {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: SHORTCUTS_KEY,
    queryFn: () => invokeCommand<ShortcutItem[]>('list_shortcuts'),
  });

  // The Shortcuts editor persists via `register_shortcut` and the backend
  // emits `shortcut_updated` after re-binding. Invalidate so open guides /
  // the dashboard pick up the new combo without a manual refresh.
  useEffect(() => {
    const un = onEvent('shortcut_updated', () => {
      qc.invalidateQueries({ queryKey: SHORTCUTS_KEY });
    });
    return () => {
      un.then((u) => u()).catch(() => {});
    };
  }, [qc]);

  const accel = (id: ShortcutId | string): string => {
    const item = data?.find((s) => s.id === id);
    return item?.accelerator ?? SHORTCUT_DEFAULTS[id] ?? '';
  };

  return {
    accel,
    pretty: (id) => prettyAccel(accel(id)),
    keys: (id) =>
      accel(id)
        .split('+')
        .map((s) => s.trim()),
    items: data ?? [],
  };
}
