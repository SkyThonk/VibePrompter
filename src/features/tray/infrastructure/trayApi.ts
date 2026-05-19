import { invokeCommand } from '@kernel/infrastructure/tauri';
import type { TrayMenuItem, TrayToggleConfig } from '../domain';

// Tray menu items are static UI labels — their actions are wired in sub-project 3.
const ITEMS_PRIMARY: TrayMenuItem[] = [
  { id: 'palette', label: 'Open Palette', iconName: 'wand', kbd: ['Ctrl', '⇧', '␣'], accent: true },
  { id: 'mode', label: 'Switch Mode', iconName: 'layers', kbd: ['Ctrl', '⇧', 'M'] },
  { id: 'history', label: 'History', iconName: 'history', kbd: ['Ctrl', '⇧', 'H'] },
  { id: 'settings', label: 'Settings…', iconName: 'cog', kbd: ['⌘', ','] },
];

const ITEMS_SECONDARY: TrayMenuItem[] = [
  { id: 'restart', label: 'Restart service', iconName: 'refresh' },
  { id: 'updates', label: 'Check for updates', iconName: 'download', badge: 'Up to date' },
  { id: 'quit', label: 'Quit PromptHelper', iconName: 'power', danger: true },
];

interface BackendSettings {
  boot_start: boolean;
}

// NOTE: this whole feature is a design preview from when the tray was a React
// page (`/tray`). The actual tray is now a native OS tray icon driven by the
// Rust backend; this file is kept compiling so design artifacts survive but
// the route is no longer registered. Safe to delete the directory entirely.
export const trayApi = {
  getToggles: async (): Promise<TrayToggleConfig[]> => {
    const s = await invokeCommand<BackendSettings>('get_settings');
    return [
      { id: 'enabled', label: 'Enable AI', iconName: 'bolt', defaultValue: true },
      { id: 'shortcuts', label: 'Global shortcuts', iconName: 'keyboard', defaultValue: true, kbd: ['Ctrl', '⇧', '␣'] },
      { id: 'boot', label: 'Start on boot', iconName: 'power', defaultValue: s.boot_start },
    ];
  },
  getPrimaryItems: async (): Promise<TrayMenuItem[]> => ITEMS_PRIMARY,
  getSecondaryItems: async (): Promise<TrayMenuItem[]> => ITEMS_SECONDARY,
};
