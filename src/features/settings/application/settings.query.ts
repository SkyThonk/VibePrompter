import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../infrastructure/settingsApi';
import { invokeCommand } from '@kernel/infrastructure/tauri';
import { useToast } from '@shared/ui';

const k = (...parts: string[]) => ['settings', ...parts];

export const useTabsQuery = () =>
  useQuery({ queryKey: k('tabs'), queryFn: settingsApi.getTabs });
export const useModesQuery = () =>
  useQuery({ queryKey: k('modes'), queryFn: settingsApi.getModes });
export const useProvidersQuery = () =>
  useQuery({ queryKey: k('providers'), queryFn: settingsApi.getProviders });
export const useOllamaModelsQuery = () =>
  useQuery({ queryKey: k('ollama'), queryFn: settingsApi.getOllamaModels });
/** History list. Accepts pagination so the panel can grow page-by-page
    instead of forcing a single 100-row pull. */
export const useHistoryQuery = (limit = 50, offset = 0) =>
  useQuery({
    queryKey: k('history', String(limit), String(offset)),
    queryFn: () =>
      invokeCommand<import('../domain').HistoryItem[]>('get_history', {
        query: { limit, offset },
      }),
  });
/** Tweaks/followups nested under a history entry, oldest-first. Disabled
    until an entry id is provided; returns [] for entries with no tweaks. */
export const useHistoryChildrenQuery = (parentId: number | null) =>
  useQuery({
    queryKey: k('history-children', String(parentId ?? '')),
    enabled: parentId != null,
    queryFn: () =>
      invokeCommand<import('../domain').HistoryItem[]>('get_history_children', {
        parentId,
      }),
  });

export const useShortcutsQuery = () =>
  useQuery({ queryKey: k('shortcuts'), queryFn: settingsApi.getShortcuts });

/** The user-facing settings aggregate — mirrors the Rust `Settings` struct. */
export interface AppSettings {
  boot_start: boolean;
  minimize_to_tray: boolean;
  quit_on_close: boolean;
  notifications: boolean;
  stream_response: boolean;
  response_timeout: number;
  theme: string;
  accent: string;
  density: string;
  history_retention: string;
  dev_tools: boolean;
  log_raw_responses: boolean;
  proxy_url: string;
}

export const useAppSettingsQuery = () =>
  useQuery({
    queryKey: k('app-settings'),
    queryFn: () => invokeCommand<AppSettings>('get_settings'),
  });

export const useSaveSettingsMutation = () => {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (settings: AppSettings) =>
      invokeCommand<void>('save_settings', { settings }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: k('app-settings') });
      // Short, low-volume confirmation. Every Settings panel toggle goes
      // through this hook so users get consistent feedback without each
      // panel having to wire its own success message.
      toast.ok('Setting saved.');
    },
    onError: (err) => toast.err(String(err), 'Could not save setting'),
  });
};
