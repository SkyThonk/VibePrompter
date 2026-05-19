/**
 * Static content index for settings global search. Maps user keywords to
 * the destination tab. Kept in one place because backend-derived indexing
 * (extracting strings from each panel's React tree) is more code than
 * curating a small table once.
 *
 * When you add a new control to a panel, add a keyword row here so users
 * can find it from the search box.
 */
export interface SettingsHit {
  tab: string;
  label: string;
  /** Lowercased extra keywords. Auto-built from the label too. */
  keywords: string[];
}

export const SETTINGS_INDEX: SettingsHit[] = [
  // General
  { tab: 'general', label: 'Launch on system startup', keywords: ['autostart', 'boot', 'login'] },
  { tab: 'general', label: 'Minimize to tray on close', keywords: ['close', 'background', 'tray'] },
  { tab: 'general', label: 'Quit completely on close', keywords: ['exit', 'shutdown'] },
  { tab: 'general', label: 'Show notifications', keywords: ['notify', 'toast', 'hud'] },
  { tab: 'general', label: 'Stream AI response', keywords: ['streaming', 'sse'] },
  { tab: 'general', label: 'Response timeout', keywords: ['timeout', 'http', 'seconds'] },
  { tab: 'general', label: 'Concurrent requests', keywords: ['parallel', 'semaphore', 'rate'] },

  // Appearance
  { tab: 'appearance', label: 'Theme (light / dark / system)', keywords: ['dark', 'light', 'colors'] },
  { tab: 'appearance', label: 'Accent color', keywords: ['color', 'tint'] },
  { tab: 'appearance', label: 'Density', keywords: ['spacing', 'compact', 'comfy'] },

  // Shortcuts
  { tab: 'shortcuts', label: 'Edit global hotkeys', keywords: ['hotkey', 'keybinding', 'accelerator'] },

  // Providers
  { tab: 'providers', label: 'Add API connection', keywords: ['provider', 'api', 'key', 'openai', 'anthropic'] },
  { tab: 'providers', label: 'Custom HTTP headers', keywords: ['headers', 'proxy', 'corporate', 'openrouter'] },
  { tab: 'providers', label: 'Import / export connections', keywords: ['backup', 'share', 'json'] },

  // Modes
  { tab: 'modes', label: 'Prompt mode templates', keywords: ['template', 'starter', 'system prompt'] },
  { tab: 'modes', label: 'Tag-filter prompt modes', keywords: ['tag', 'filter', 'category'] },
  { tab: 'modes', label: 'Mode preview tester', keywords: ['preview', 'test', 'sandbox'] },

  // History
  { tab: 'history', label: 'View past runs', keywords: ['log', 'past', 'transcript'] },
  { tab: 'history', label: 'Export history', keywords: ['download', 'json', 'backup'] },
  { tab: 'history', label: 'Clear all history', keywords: ['delete', 'wipe', 'reset'] },
  { tab: 'history', label: 'Favorite history rows', keywords: ['star', 'pin', 'save'] },

  // Advanced
  { tab: 'advanced', label: 'History retention', keywords: ['days', 'purge', 'forever'] },
  { tab: 'advanced', label: 'Custom proxy URL', keywords: ['proxy', 'corporate', 'http_proxy'] },
  { tab: 'advanced', label: 'Log raw model responses', keywords: ['debug', 'verbose', 'logging'] },
  { tab: 'advanced', label: 'Export / import all settings', keywords: ['backup', 'transfer'] },
  { tab: 'advanced', label: 'Developer tools', keywords: ['devtools', 'inspect'] },

  // About
  { tab: 'about', label: 'App version', keywords: ['version', 'build'] },
  { tab: 'about', label: 'Data + log directories', keywords: ['paths', 'where', 'folder', 'reveal'] },
  { tab: 'about', label: 'Recent log lines', keywords: ['logs', 'debug', 'support'] },
  { tab: 'about', label: 'Usage stats / analytics', keywords: ['runs', 'tokens', 'count'] },
];

export function searchSettings(query: string): SettingsHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTINGS_INDEX.filter((row) => {
    const hay = `${row.label} ${row.keywords.join(' ')}`.toLowerCase();
    return hay.includes(q);
  }).slice(0, 8);
}
