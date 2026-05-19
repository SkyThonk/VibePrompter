import { Group, I, PanelHead, PhButton, PhInput, SettingRow, Toggle, useToast } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';
import { useAppSettingsQuery, useSaveSettingsMutation } from '../../application/settings.query';

const RETENTIONS = ['7d', '30d', '90d', 'Forever'];

export function AdvancedPanel() {
  const { data: settings } = useAppSettingsQuery();
  const saveSettings = useSaveSettingsMutation();
  const toast = useToast();
  if (!settings) return null;
  const retention = RETENTIONS.indexOf(settings.history_retention);
  const setRetention = (i: number) =>
    saveSettings.mutate({ ...settings, history_retention: RETENTIONS[i] });

  const exportSettings = async () => {
    try {
      const payload = await invokeCommand<unknown>('export_settings');
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vibeprompter-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.ok('Saved settings bundle to disk.', 'Export complete');
    } catch (e) {
      toast.err(String(e), 'Export failed');
    }
  };

  const importSettings = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (!window.confirm('Replace your current settings with the imported file? Existing values will be overwritten.')) {
        return;
      }
      try {
        const text = await f.text();
        await invokeCommand<void>('import_settings', { payload: JSON.parse(text) });
        toast.ok('Settings imported. Some changes take effect on the next prompt.', 'Imported');
      } catch (e) {
        toast.err(String(e), 'Import failed');
      }
    };
    input.click();
  };

  const exportAll = async () => {
    try {
      const [history, connections] = await Promise.all([
        invokeCommand<unknown>('export_history'),
        invokeCommand<unknown>('export_connections'),
      ]);
      const payload = {
        schema: 'vibeprompter-export-v1',
        exportedAt: new Date().toISOString(),
        settings,
        history,
        connections,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vibeprompter-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.ok('Export written. API keys are not included.', 'Export complete');
    } catch (e) {
      toast.err(String(e), 'Export failed');
    }
  };

  return (
    <>
      <PanelHead title="Advanced" hint="Power-user settings. Be careful." />

      <Group title="Data">
        <SettingRow
          icon={<I.history size={14} />}
          label="Local history retention"
          hint="Older entries are purged automatically."
          control={
            <div
              className="inline-flex p-0.5 rounded-md"
              style={{
                background: 'var(--surface-2)',
                border: '.5px solid var(--border)',
              }}
            >
              {RETENTIONS.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setRetention(i)}
                  className="px-2.5 py-1 border-0 cursor-pointer rounded-sm text-[11.5px] font-medium"
                  style={{
                    background: retention === i ? 'var(--surface)' : 'transparent',
                    color: retention === i ? 'var(--fg)' : 'var(--fg-mute)',
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
          }
        />
        <SettingRow
          icon={<I.download size={14} />}
          label="Export all data"
          hint="Bundles settings, history, and connections (API keys excluded)."
          control={
            <PhButton size="sm" variant="ghost" onClick={exportAll}>
              Export as JSON
            </PhButton>
          }
        />
        <SettingRow
          icon={<I.cog size={14} />}
          label="Settings backup"
          hint="Export just your typed settings, or import from a previous export."
          control={
            <div className="flex gap-1.5">
              <PhButton size="sm" variant="ghost" onClick={exportSettings}>
                Export
              </PhButton>
              <PhButton size="sm" variant="ghost" onClick={importSettings}>
                Import…
              </PhButton>
            </div>
          }
        />
        <SettingRow
          icon={<I.history size={14} />}
          label="Request timeout (seconds)"
          hint="Applies to every outbound LLM HTTP call. Clamped 5–600."
          control={
            <div style={{ width: 120 }}>
              <PhInput
                mono
                type="number"
                value={String(settings.response_timeout)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) {
                    saveSettings.mutate({ ...settings, response_timeout: Math.round(v) });
                  }
                }}
              />
            </div>
          }
        />
        <SettingRow
          icon={<I.bolt size={14} />}
          label="Stream responses"
          hint="When off, the dashboard waits for the full reply instead of showing tokens live."
          control={
            <Toggle
              value={settings.stream_response}
              onChange={(v) => saveSettings.mutate({ ...settings, stream_response: v })}
            />
          }
        />
      </Group>

      <Group title="Developer">
        <SettingRow
          icon={<I.code size={14} />}
          label="Enable developer tools"
          hint="Opens DevTools on the main window. Dev builds only."
          control={
            <Toggle
              value={settings.dev_tools}
              onChange={(v) => saveSettings.mutate({ ...settings, dev_tools: v })}
            />
          }
        />
        <SettingRow
          icon={<I.cpu size={14} />}
          label="Log raw model responses"
          hint="Useful for debugging prompt regressions."
          control={<Toggle value={settings.log_raw_responses} onChange={(v) => saveSettings.mutate({ ...settings, log_raw_responses: v })} />}
        />
        <SettingRow
          icon={<I.link size={14} />}
          label="Custom proxy URL"
          control={
            <div style={{ width: 240 }}>
              <PhInput mono placeholder="https://proxy.example.com" value={settings.proxy_url} onChange={(e) => saveSettings.mutate({ ...settings, proxy_url: e.target.value })} />
            </div>
          }
        />
      </Group>
    </>
  );
}
