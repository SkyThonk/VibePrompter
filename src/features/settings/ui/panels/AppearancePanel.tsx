import { Group, PanelHead } from '@shared/ui';
import { useAppSettingsQuery, useSaveSettingsMutation } from '../../application/settings.query';

const ACCENTS = [
  { id: 'violet', color: '#a78bfa' },
  { id: 'blue', color: '#6b8afd' },
  { id: 'green', color: '#34d399' },
  { id: 'amber', color: '#fbbf24' },
  { id: 'rose', color: '#fb7185' },
  { id: 'mono', color: '#e5e7eb' },
];

const THEMES = ['dark', 'light', 'system'] as const;

export function AppearancePanel() {
  const { data: settings } = useAppSettingsQuery();
  const saveSettings = useSaveSettingsMutation();
  if (!settings) return null;
  const theme = settings.theme as (typeof THEMES)[number];
  const accent = settings.accent;
  const setTheme = (t: (typeof THEMES)[number]) => saveSettings.mutate({ ...settings, theme: t });
  const setAccent = (a: string) => saveSettings.mutate({ ...settings, accent: a });

  return (
    <>
      <PanelHead
        title="Appearance"
        hint="Customize how VibePrompter looks across the app."
      />

      <Group title="Theme">
        <div className="grid grid-cols-3 gap-2.5 p-3">
          {THEMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTheme(t)}
              className="p-3 cursor-pointer text-left rounded-lg"
              style={{
                background: 'var(--surface)',
                border: theme === t ? '.5px solid var(--accent)' : '.5px solid var(--border)',
                boxShadow: theme === t ? 'var(--accent-glow)' : 'none',
              }}
            >
              <div
                className="rounded-md mb-2 flex items-center justify-center"
                style={{
                  height: 60,
                  background:
                    t === 'dark'
                      ? '#0a0b0f'
                      : t === 'light'
                      ? '#f6f6f8'
                      : 'linear-gradient(90deg, #0a0b0f 0%, #0a0b0f 50%, #f6f6f8 50%, #f6f6f8 100%)',
                  border: '.5px solid var(--border)',
                }}
              >
                <div
                  className="rounded-[2px]"
                  style={{
                    width: 24,
                    height: 4,
                    background: t === 'light' ? '#16181f' : '#e8eaef',
                  }}
                />
              </div>
              <div className="text-[12.5px] font-medium text-fg">
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </div>
            </button>
          ))}
        </div>
      </Group>

      <Group title="Accent">
        <div className="flex gap-2 p-3">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setAccent(a.id)}
              className="cursor-pointer p-0"
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: a.color,
                border: accent === a.id ? '.5px solid var(--fg)' : '.5px solid transparent',
                boxShadow:
                  accent === a.id ? `0 0 0 2px var(--bg), 0 0 0 3.5px ${a.color}` : 'none',
              }}
            />
          ))}
        </div>
      </Group>

    </>
  );
}
