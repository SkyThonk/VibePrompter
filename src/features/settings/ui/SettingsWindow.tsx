import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useIsMutating } from '@tanstack/react-query';
import { I, NavItem, PhInput, type IconName } from '@shared/ui';
import { useTabsQuery } from '../application/settings.query';
import type { SettingsTabId } from '../domain';
import { searchSettings } from './settingsIndex';

export function SettingsWindow() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: tabs = [] } = useTabsQuery();
  const [search, setSearch] = useState('');

  const tab: SettingsTabId = useMemo(() => {
    const segment = pathname.split('/').pop() ?? '';
    return (tabs.find((t) => t.id === segment)?.id ?? 'general') as SettingsTabId;
  }, [tabs, pathname]);

  const filteredTabs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tabs;
    return tabs.filter((t) => t.label.toLowerCase().includes(q) || t.id.includes(q));
  }, [tabs, search]);

  // Content matches — searches deeper than just tab labels so users can
  // find "timeout" or "proxy" and get pointed straight to Advanced.
  const contentHits = useMemo(() => searchSettings(search), [search]);

  // Live save-state indicator. Any in-flight mutation in the app shows "Saving…";
  // the Settings panels are the primary mutators (useSaveSettingsMutation).
  const isSaving = useIsMutating() > 0;

  return (
    <div
      className="ph-root h-full flex flex-col"
      style={{ background: 'var(--bg)' }}
    >
      <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex flex-1 min-h-0 bg-bg">
            <aside
              className="w-[220px] flex-shrink-0 p-2.5 flex flex-col gap-2.5"
              style={{ borderRight: '.5px solid var(--border)', background: 'var(--bg-2)' }}
            >
              <button
                type="button"
                onClick={() => navigate('/')}
                className="flex items-center gap-1.5 px-2 py-1.5 mx-1 mt-0.5 text-[12px] text-fg-mute hover:text-fg rounded transition-colors"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
                title="Back to home (Esc)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5" />
                  <path d="m12 19-7-7 7-7" />
                </svg>
                <span>Back</span>
              </button>
              <div className="px-2 pt-1 pb-1.5">
                <PhInput
                  size="sm"
                  icon={<I.search size={12} />}
                  placeholder="Search settings…"
                  value={search}
                  onChange={setSearch}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && filteredTabs.length > 0) {
                      navigate(`/settings/${filteredTabs[0].id}`);
                    } else if (e.key === 'Escape') {
                      setSearch('');
                    }
                  }}
                />
              </div>
              <nav className="flex flex-col gap-px" aria-label="Settings sections">
                {filteredTabs.length === 0 && contentHits.length === 0 ? (
                  <div className="px-3 py-2 text-[11.5px] text-fg-mute">No matches</div>
                ) : (
                  filteredTabs.map((n) => {
                    const Icon = I[n.iconName as IconName];
                    return (
                      <NavItem
                        key={n.id}
                        icon={Icon ? <Icon size={14} /> : null}
                        label={n.label}
                        active={tab === n.id}
                        onClick={() => navigate(`/settings/${n.id}`)}
                      />
                    );
                  })
                )}
              </nav>
              {search.trim() && contentHits.length > 0 && (
                <div className="px-2 mt-1 flex flex-col gap-1">
                  <div className="text-[10.5px] uppercase tracking-[0.10em] text-fg-dim font-semibold px-1 mb-0.5">
                    Inside settings
                  </div>
                  {contentHits.map((h) => (
                    <button
                      key={`${h.tab}:${h.label}`}
                      type="button"
                      onClick={() => navigate(`/settings/${h.tab}`)}
                      className="text-left text-[11.5px] px-2 py-1.5 rounded transition-colors"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--fg-mute)',
                        cursor: 'pointer',
                      }}
                      title={`Open ${h.tab}`}
                    >
                      <span style={{ color: 'var(--fg)' }}>{h.label}</span>
                      <span className="ph-mono text-[10px] text-fg-dim ml-1">
                        · {h.tab}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-auto px-2.5 py-2 text-[11px] text-fg-dim flex items-center gap-2">
                <SaveIndicator saving={isSaving} />
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => navigate('/settings/about')}
                  className="ph-mono text-[11px]"
                  style={{ background: 'none', border: 'none', color: 'var(--fg-dim)', cursor: 'pointer' }}
                  title="Open About panel"
                >
                  About →
                </button>
              </div>
            </aside>
            <main
              key={tab}
              className="flex-1 min-w-0 overflow-auto ph-anim-fade-in"
              style={{ padding: '20px 28px 28px' }}
            >
              <Outlet />
            </main>
          </div>
      </div>
    </div>
  );
}

/**
 * Small live save-state pill in the sidebar footer. Pulses while a mutation is
 * in flight; quietly shows "Saved" briefly afterward; otherwise hidden.
 */
function SaveIndicator({ saving }: { saving: boolean }) {
  const [recent, setRecent] = useState(false);
  const wasSaving = useRef(false);

  useEffect(() => {
    if (saving) {
      wasSaving.current = true;
      setRecent(false);
      return;
    }
    if (wasSaving.current) {
      wasSaving.current = false;
      setRecent(true);
      const id = window.setTimeout(() => setRecent(false), 1400);
      return () => window.clearTimeout(id);
    }
  }, [saving]);

  if (saving) {
    return (
      <span className="inline-flex items-center gap-1.5 text-fg-mute">
        <span className="dot accent ph-pulse" />
        <span>Saving…</span>
      </span>
    );
  }
  if (recent) {
    return (
      <span className="inline-flex items-center gap-1.5 text-fg-mute ph-anim-fade-in">
        <span className="dot ok" />
        <span>Saved</span>
      </span>
    );
  }
  return <span aria-hidden="true" />;
}
