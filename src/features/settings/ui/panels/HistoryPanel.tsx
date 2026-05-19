import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { EmptyState, I, Kbd, PanelHead, PhButton, PhInput, Pill, useToast, type IconName } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';
import { useHistoryQuery } from '../../application/settings.query';

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 600,
};

export function HistoryPanel() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [pageSize, setPageSize] = useState(50);
  const { data: history = [], isLoading } = useHistoryQuery(pageSize, 0);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(1);
  const [clearing, setClearing] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const reuse = async (item: { src: string; mode: string }) => {
    // Stash input for the dashboard textarea + try to re-activate the same
    // mode the original run used. We look the mode up by *name* (the only
    // identifier we stored on the history row) — if it's been renamed or
    // deleted, the dashboard just runs with whatever's currently active.
    try {
      sessionStorage.setItem('dashboard:input-stash', item.src);
    } catch {}
    try {
      const modes = await invokeCommand<{ id: string; name: string }[]>('list_modes');
      const match = modes.find((m) => m.name === item.mode);
      if (match) {
        await invokeCommand<void>('set_active_mode', { id: match.id });
      }
    } catch {}
    navigate('/');
    toast.ok(`Loaded into dashboard${item.mode ? ` · ${item.mode} mode` : ''}.`);
  };

  const copyOutput = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.ok('Copied output to clipboard.'),
      () => toast.err('Clipboard write blocked.', 'Could not copy')
    );
  };

  const clearAll = async () => {
    if (clearing) return;
    if (!window.confirm('Clear ALL history? This cannot be undone.')) return;
    setClearing(true);
    try {
      await invokeCommand<number>('clear_history');
      queryClient.invalidateQueries({ queryKey: ['settings', 'history'] });
    } finally {
      setClearing(false);
    }
  };

  const toggleFavorite = async (id: number, current: boolean) => {
    try {
      await invokeCommand<void>('set_history_favorite', { id, favorite: !current });
      queryClient.invalidateQueries({ queryKey: ['settings', 'history'] });
    } catch (e) {
      toast.err(String(e), 'Could not update favorite');
    }
  };

  const exportAll = async () => {
    try {
      const payload = await invokeCommand<unknown>('export_history');
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vibeprompter-history-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.ok('History exported.', 'Download started');
    } catch (e) {
      toast.err(String(e), 'Export failed');
    }
  };

  // Vim-style j/k row navigation. Listens on window so the user can drive
  // the list while focus is on the detail panel or the search box (when
  // the search box is focused we bail — don't fight the user typing "j").
  useEffect(() => {
    function isEditable(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;
      const filtered = history.filter(
        (x) =>
          !q.trim() ||
          x.src.toLowerCase().includes(q.toLowerCase()) ||
          x.out.toLowerCase().includes(q.toLowerCase())
      );
      if (filtered.length === 0) return;
      const idx = Math.max(0, filtered.findIndex((x) => x.id === sel));
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = filtered[Math.min(filtered.length - 1, idx + 1)];
        if (next) setSel(next.id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = filtered[Math.max(0, idx - 1)];
        if (prev) setSel(prev.id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history, q, sel]);

  const items = history.filter(
    (x) =>
      (!favoritesOnly || x.fav) &&
      (!q.trim() ||
        x.src.toLowerCase().includes(q.toLowerCase()) ||
        x.out.toLowerCase().includes(q.toLowerCase()))
  );
  const current = history.find((x) => x.id === sel) ?? history[0];

  const head = (
    <PanelHead
      title="History"
      hint="The last 30 days of transformations. Stored locally."
      actions={
        history.length > 0 ? (
          <div className="flex gap-1.5">
            <PhButton size="sm" variant="ghost" icon={<I.filter size={12} />}>
              Filter
            </PhButton>
            <PhButton
              size="sm"
              variant="ghost"
              icon={<I.download size={12} />}
              onClick={exportAll}
            >
              Export
            </PhButton>
            <PhButton
              size="sm"
              variant="danger"
              icon={<I.trash size={12} />}
              onClick={clearAll}
              disabled={clearing}
            >
              {clearing ? 'Clearing…' : 'Clear all'}
            </PhButton>
          </div>
        ) : undefined
      }
    />
  );

  // Loading: render head only; the panel-level fade-in covers the visual gap.
  if (isLoading) return head;

  // Empty: no transformations yet — onboarding state.
  if (history.length === 0) {
    return (
      <>
        {head}
        <EmptyState
          icon={<I.history size={22} />}
          title="No transformations yet"
          description={
            <>
              Highlight text anywhere on your system and press{' '}
              <Kbd keys={['Ctrl', '⇧', '␣']} size="sm" /> to open the command palette.
              Every transformation you run will appear here.
            </>
          }
          action={
            <PhButton size="sm" variant="ghost" icon={<I.wand size={12} />}>
              Learn about shortcuts
            </PhButton>
          }
        />
      </>
    );
  }

  if (!current) return head;
  const CurIcon = I[current.iconName as IconName];

  return (
    <>
      {head}

      <div className="grid gap-4" style={{ gridTemplateColumns: '380px 1fr' }}>
        <div className="flex flex-col gap-2">
          <PhInput
            icon={<I.search size={13} />}
            placeholder="Search history…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setFavoritesOnly((v) => !v)}
              className="text-[11px] px-2 py-1 rounded transition-colors inline-flex items-center gap-1"
              style={{
                background: favoritesOnly ? 'var(--accent-tint)' : 'var(--surface-2)',
                color: favoritesOnly ? 'var(--accent)' : 'var(--fg-mute)',
                border: `.5px solid ${favoritesOnly ? 'var(--accent-tint-2)' : 'var(--border)'}`,
                cursor: 'pointer',
              }}
            >
              <I.star size={11} fill={favoritesOnly ? 'currentColor' : 'none'} />
              Favorites only
            </button>
            <span className="text-[11px] text-fg-dim ml-auto">
              {items.length} shown
            </span>
          </div>
          <div
            className="rounded-lg overflow-hidden"
            style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
          >
            {items.map((it, i) => {
              const Icon = I[it.iconName as IconName];
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => setSel(it.id)}
                  className="w-full text-left border-0 px-3 py-2.5 cursor-pointer flex flex-col gap-1"
                  style={{
                    background: sel === it.id ? 'var(--accent-tint)' : 'transparent',
                    borderTop: i ? '.5px solid var(--divider)' : 'none',
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <Pill tone="accent" icon={Icon ? <Icon size={12} /> : null}>
                      {it.mode}
                    </Pill>
                    <span className="flex-1" />
                    {it.fav && (
                      <I.star size={11} fill="currentColor" style={{ color: 'var(--warn)' }} />
                    )}
                    <span className="text-[10.5px] text-fg-dim">
                      {relativeTime(it.createdAt)}
                    </span>
                  </div>
                  <div
                    className="text-xs text-fg overflow-hidden text-ellipsis"
                    style={{
                      lineHeight: 1.4,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                    }}
                  >
                    {it.out}
                  </div>
                  <div className="text-[11px] text-fg-mute flex gap-1.5">
                    <I.cloud size={10} />
                    <span className="ph-mono">{it.provider}</span>
                    <span className="text-fg-dim">·</span>
                    <span className="ph-mono">{(it.ms / 1000).toFixed(2)}s</span>
                  </div>
                </button>
              );
            })}
            {items.length === 0 && (
              <EmptyState
                compact
                icon={<I.search size={16} />}
                title={`No matches for “${q}”`}
                description="Try a shorter query, or clear the search to browse all history."
                action={
                  <PhButton size="sm" variant="ghost" onClick={() => setQ('')}>
                    Clear search
                  </PhButton>
                }
              />
            )}
          </div>
          {history.length >= pageSize && (
            <button
              type="button"
              onClick={() => setPageSize((n) => n + 50)}
              className="text-[12px] py-2 rounded-md transition-colors"
              style={{
                background: 'var(--surface-2)',
                border: '.5px solid var(--border)',
                color: 'var(--fg-mute)',
                cursor: 'pointer',
              }}
              title="Pull the next page of older entries"
            >
              Load 50 more
            </button>
          )}
        </div>

        {/* Detail */}
        <div
          className="rounded-lg p-[18px] flex flex-col gap-3.5"
          style={{ background: 'var(--surface)', border: '.5px solid var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <Pill tone="accent" icon={CurIcon ? <CurIcon size={12} /> : null}>
              {current.mode}
            </Pill>
            <span className="text-fg-dim">·</span>
            <span className="ph-mono text-[11.5px] text-fg-mute">{current.provider}</span>
            <span className="flex-1" />
            <PhButton
              size="sm"
              variant="ghost"
              icon={<I.star size={12} fill={current.fav ? 'currentColor' : 'none'} />}
              onClick={() => toggleFavorite(current.id, current.fav)}
            >
              {current.fav ? 'Saved' : 'Favorite'}
            </PhButton>
            <PhButton
              size="sm"
              variant="ghost"
              icon={<I.refresh size={12} />}
              onClick={() => reuse({ src: current.src, mode: current.mode })}
              title="Open the dashboard with this input pre-filled + the original mode active"
            >
              Reuse
            </PhButton>
            <PhButton
              size="sm"
              variant="primary"
              icon={<I.copy size={12} />}
              onClick={() => copyOutput(current.out)}
            >
              Copy
            </PhButton>
          </div>

          <div>
            <div style={{ ...labelStyle, marginBottom: 6 }}>
              Original ({current.src.length.toLocaleString()} chars)
            </div>
            <div
              className="px-3 py-2.5 text-[13px] text-fg-mute whitespace-pre-wrap"
              style={{
                background: 'var(--surface-2)',
                border: '.5px solid var(--border)',
                borderRadius: 'var(--r-md)',
                lineHeight: 1.55,
                maxHeight: 220,
                overflow: 'auto',
                wordBreak: 'break-word',
              }}
            >
              {current.src}
            </div>
          </div>

          <div>
            <div style={{ ...labelStyle, color: 'var(--accent)', marginBottom: 6 }}>
              Result ({current.out.length.toLocaleString()} chars)
            </div>
            <div
              className="px-3.5 py-3 text-[13.5px] text-fg whitespace-pre-wrap"
              style={{
                background: 'var(--accent-tint)',
                border: '.5px solid var(--accent-tint-2)',
                borderRadius: 'var(--r-md)',
                lineHeight: 1.55,
                maxHeight: 320,
                overflow: 'auto',
                wordBreak: 'break-word',
              }}
            >
              {current.out}
            </div>
          </div>

          <div
            className="mt-auto flex gap-3 items-center px-3 py-2.5 text-[11.5px] text-fg-mute"
            style={{
              background: 'var(--surface-2)',
              border: '.5px solid var(--border)',
              borderRadius: 'var(--r-md)',
            }}
          >
            <span>
              <span className="text-fg-dim">When </span>
              <span className="ph-mono">{relativeTime(current.createdAt)}</span>
            </span>
            <span>
              <span className="text-fg-dim">Latency </span>
              <span className="ph-mono">{current.ms}ms</span>
            </span>
            {(current.inputTokens ?? 0) + (current.outputTokens ?? 0) > 0 && (
              <span>
                <span className="text-fg-dim">Tokens </span>
                <span className="ph-mono">
                  {current.inputTokens} → {current.outputTokens}
                </span>
              </span>
            )}
            <span className="flex-1" />
            <button
              type="button"
              title="Delete"
              className="w-[26px] h-[26px] flex items-center justify-center rounded-md cursor-pointer p-0"
              style={{
                background: 'var(--surface-2)',
                border: '.5px solid var(--border-strong)',
                color: 'var(--danger)',
              }}
            >
              <I.trash size={12} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** "5m ago" formatter shared with the dashboard's activity strip. */
function relativeTime(rfc3339: string): string {
  const then = Date.parse(rfc3339);
  if (Number.isNaN(then)) return '';
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
