import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useIsMutating } from '@tanstack/react-query';
import { I, NavItem, PhInput, PhWindow, type IconName } from '@shared/ui';
import { useTabsQuery } from '../application/settings.query';
import type { SettingsTabId } from '../domain';

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

  // Live save-state indicator. Any in-flight mutation in the app shows "Saving…";
  // the Settings panels are the primary mutators (useSaveSettingsMutation).
  const isSaving = useIsMutating() > 0;

  return (
    <div
      className="ph-root min-h-screen p-6 flex items-center justify-center"
      style={{ background: 'var(--bg)' }}
    >
      <div style={{ width: 1040, height: 760, maxWidth: '100%' }}>
        <PhWindow title="PromptHelper · Settings" icon={<span className="ph-mark sm" />}>
          <div className="flex flex-1 min-h-0 bg-bg" style={{ height: 'calc(100% - 36px)' }}>
            <aside
              className="w-[220px] flex-shrink-0 p-2.5 flex flex-col gap-2.5"
              style={{ borderRight: '.5px solid var(--border)', background: 'var(--bg-2)' }}
            >
              <div className="px-2 pt-1 pb-1.5">
                <PhInput
                  size="sm"
                  icon={<I.search size={12} />}
                  placeholder="Search settings…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
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
                {filteredTabs.length === 0 ? (
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
              <div className="mt-auto px-2.5 py-2 text-[11px] text-fg-dim flex items-center gap-2">
                <SaveIndicator saving={isSaving} />
                <span className="flex-1" />
                <span className="ph-mono">v1.2.0</span>
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
        </PhWindow>
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
