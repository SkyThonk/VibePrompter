import { I, Group, PanelHead, PhInput, SettingRow, Slider, Toggle } from '@shared/ui';
import { useAppSettingsQuery, useSaveSettingsMutation, type AppSettings } from '../../application/settings.query';

export function GeneralPanel() {
  const { data: settings } = useAppSettingsQuery();
  const saveSettings = useSaveSettingsMutation();

  if (!settings) return null;

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    saveSettings.mutate({ ...settings, [k]: v });

  return (
    <>
      <PanelHead title="General" hint="Behavior and performance defaults." />

      <Group title="Startup">
        <SettingRow
          icon={<I.power size={14} />}
          label="Launch on system startup"
          control={<Toggle value={settings.boot_start} onChange={(v) => set('boot_start', v)} />}
        />
        <SettingRow
          icon={<I.list size={14} />}
          label="Minimize to tray on close"
          hint="Keep VibePrompter running in the background when you close the window."
          control={<Toggle value={settings.minimize_to_tray} onChange={(v) => set('minimize_to_tray', v)} />}
        />
        <SettingRow
          icon={<I.close size={14} />}
          label="Quit completely on close"
          control={<Toggle value={settings.quit_on_close} onChange={(v) => set('quit_on_close', v)} />}
        />
      </Group>

      <Group title="Behavior">
        <SettingRow
          icon={<I.bell size={14} />}
          label="Show notifications"
          hint="Mode-switch HUD plus native Windows toasts when the main window is hidden."
          control={<Toggle value={settings.notifications} onChange={(v) => set('notifications', v)} />}
        />
        <SettingRow
          icon={<I.sparkles size={14} />}
          label="Stream AI response"
          hint="Show tokens as they arrive. Disable for slow networks or proxies that buffer SSE poorly."
          control={<Toggle value={settings.stream_response} onChange={(v) => set('stream_response', v)} />}
        />
      </Group>

      <Group title="Performance">
        <SettingRow
          icon={<I.refresh size={14} />}
          label="Response timeout"
          hint="Abort if the model hasn't started streaming."
          control={
            <div className="flex items-center gap-1.5">
              <PhInput
                style={{ width: 64 }}
                value={settings.response_timeout}
                onChange={(e) => set('response_timeout', Number(e.target.value))}
              />
              <span className="text-xs text-fg-mute">seconds</span>
            </div>
          }
        />
        <SettingRow
          icon={<I.layers size={14} />}
          label="Concurrent requests"
          hint="Maximum in-flight transformations."
          control={
            <div className="flex items-center gap-2">
              <div style={{ width: 140 }}>
                <Slider
                  value={settings.concurrent_requests}
                  onChange={(v) => set('concurrent_requests', v)}
                  min={1}
                  max={8}
                  step={1}
                />
              </div>
              <span className="ph-mono text-xs text-fg min-w-[14px]">{settings.concurrent_requests}</span>
            </div>
          }
        />
      </Group>
    </>
  );
}
