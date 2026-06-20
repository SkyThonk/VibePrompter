import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { EmptyState, I, Kbd, PanelHead, PhButton, PhInput, Pill, useToast, type IconName } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';
import { useHistoryQuery, useHistoryChildrenQuery } from '../../application/settings.query';
import { relativeTimeAgo } from '@shared/lib/date';
import { errorMessage } from '@shared/lib/utils';
import { useShortcuts } from '@shared/lib';

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 600,
};

export function HistoryPanel() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { accel } = useShortcuts();
  const [pageSize, setPageSize] = useState(50);
  const { data: history = [], isLoading } = useHistoryQuery(pageSize, 0);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(1);
  const [clearing, setClearing] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterMode, setFilterMode] = useState('');
  const [filterProvider, setFilterProvider] = useState('');
  const [rerunBusy, setRerunBusy] = useState(false);
  const [rerunResult, setRerunResult] = useState<{
    text: string;
    model: string;
    latencyMs: number;
    connId: string;
  } | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [conns, setConns] = useState<Array<{ id: string; label: string; defaultModel: string; hasKey: boolean }>>([]);
  useEffect(() => {
    invokeCommand<typeof conns>('list_connections').then(setConns).catch(() => {});
  }, []);

  // Live refresh on new prompt runs / history clears. Backend's
  // `HistoryService` emits `history_changed` on every successful insert
  // and on `clear()`; without this listener the panel only updated on
  // mount + manual user actions, so a hotkey run made in another window
  // wouldn't show up until you re-opened the panel.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen('history_changed', () => {
      queryClient.invalidateQueries({ queryKey: ['settings', 'history'] });
      // Tweaks land via the same event — refresh open threads too (separate
      // key prefix, so it isn't covered by the invalidation above).
      queryClient.invalidateQueries({ queryKey: ['settings', 'history-children'] });
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, [queryClient]);

  const rerun = async (
    src: string,
    modeName: string,
    connId: string
  ): Promise<void> => {
    setRerunBusy(true);
    setRerunError(null);
    setRerunResult(null);
    try {
      // Best-effort: look up the mode by name to get its system prompt +
      // sampling. If the mode was deleted since the original run, fall back
      // to a neutral prompt so the re-run still produces something.
      interface ModeShape {
        id: string;
        name: string;
        sys?: string;
        temp?: number;
        maxTok?: number;
      }
      const modes = await invokeCommand<ModeShape[]>('list_modes');
      const match = modes.find((m) => m.name === modeName);
      const result = await invokeCommand<{
        text: string;
        model: string;
        latencyMs: number;
      }>('complete', {
        id: connId,
        messages: [{ role: 'user', content: src }],
        params: {
          system: match?.sys ?? '',
          temperature: match?.temp ?? 0.5,
          maxTokens: match?.maxTok ?? 1024,
        },
      });
      setRerunResult({ ...result, connId });
      queryClient.invalidateQueries({ queryKey: ['settings', 'history'] });
    } catch (e) {
      setRerunError(errorMessage(e));
    } finally {
      setRerunBusy(false);
    }
  };

  const copySource = async (item: { src: string; mode: string }) => {
    // The dashboard no longer has a chat widget, so "Reuse" is now a
    // clipboard copy of the original input. The user pastes it wherever
    // they actually want to transform text (their email, IDE, etc.) and
    // triggers the global hotkey. We also try to re-activate the same
    // mode the original run used — falls back silently if the mode was
    // renamed or deleted since.
    try {
      await navigator.clipboard.writeText(item.src);
    } catch {
      toast.err('Clipboard write blocked.', 'Could not copy');
      return;
    }
    try {
      const modes = await invokeCommand<{ id: string; name: string }[]>('list_modes');
      const match = modes.find((m) => m.name === item.mode);
      if (match) {
        await invokeCommand<void>('set_active_mode', { id: match.id });
      }
    } catch { /* mode switch is best-effort */ }
    toast.ok(
      `Original input copied. Paste anywhere and press ${accel('rewrite')}${
        item.mode ? ` (${item.mode} mode)` : ''
      }.`
    );
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
      const dest = await invokeCommand<string | null>('export_history_to_file');
      if (dest) toast.ok(`Saved to ${dest}`, 'History exported');
      // dest === null means user cancelled — do nothing
    } catch (e) {
      toast.err(errorMessage(e), 'Export failed');
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
      (!filterMode || x.mode === filterMode) &&
      (!filterProvider || x.provider === filterProvider) &&
      (!q.trim() ||
        x.src.toLowerCase().includes(q.toLowerCase()) ||
        x.out.toLowerCase().includes(q.toLowerCase()))
  );
  const current = history.find((x) => x.id === sel) ?? history[0];
  // Tweaks/followups nested under the selected entry, rendered as a thread.
  const { data: tweaks = [] } = useHistoryChildrenQuery(current?.id ?? null);
  // Selection changed → wipe any stale re-run result from the previous row.
  useEffect(() => {
    setRerunResult(null);
    setRerunError(null);
  }, [current?.id]);

  const head = (
    <PanelHead
      title="History"
      hint="The last 30 days of transformations. Stored locally."
      actions={
        history.length > 0 ? (
          <div className="flex gap-1.5">
            <PhButton
              size="sm"
              variant={filterOpen ? 'primary' : 'ghost'}
              icon={<I.filter size={12} />}
              onClick={() => setFilterOpen((v) => !v)}
            >
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
            onChange={setQ}
          />
          {filterOpen && (
            <div
              className="flex flex-col gap-2 rounded-lg px-3 py-2.5"
              style={{ background: 'var(--surface-2)', border: '.5px solid var(--border)' }}
            >
              <div className="flex gap-2">
                <div className="flex flex-col gap-1 flex-1">
                  <span style={labelStyle}>Mode</span>
                  <select
                    value={filterMode}
                    onChange={(e) => setFilterMode(e.target.value)}
                    className="text-[11.5px] rounded px-2 py-1 outline-none w-full"
                    style={{
                      background: 'var(--surface)',
                      border: '.5px solid var(--border)',
                      color: 'var(--fg)',
                    }}
                  >
                    <option value="">All modes</option>
                    {[...new Set(history.map((x) => x.mode))].sort().map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1 flex-1">
                  <span style={labelStyle}>Provider</span>
                  <select
                    value={filterProvider}
                    onChange={(e) => setFilterProvider(e.target.value)}
                    className="text-[11.5px] rounded px-2 py-1 outline-none w-full"
                    style={{
                      background: 'var(--surface)',
                      border: '.5px solid var(--border)',
                      color: 'var(--fg)',
                    }}
                  >
                    <option value="">All providers</option>
                    {[...new Set(history.map((x) => x.provider))].sort().map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
              </div>
              {(filterMode || filterProvider) && (
                <button
                  type="button"
                  onClick={() => { setFilterMode(''); setFilterProvider(''); }}
                  className="text-[11px] self-start"
                  style={{ background: 'none', border: 'none', color: 'var(--fg-dim)', cursor: 'pointer', padding: 0 }}
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
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
                      {relativeTimeAgo(it.createdAt)}
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
          {/* Two-row header: labels on top, actions below. Each row uses
              flex-wrap so the children flow to a second line if the
              container is narrow, instead of overflowing horizontally. */}
          <div className="flex flex-col gap-2.5">
            {/* Row 1: mode pill + provider label, truncating instead of
                breaking the layout if the model id is long. */}
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <Pill tone="accent" icon={CurIcon ? <CurIcon size={12} /> : null}>
                {current.mode}
              </Pill>
              {tweaks.length > 0 && (
                <Pill icon={<I.wand size={11} />}>
                  {tweaks.length} tweak{tweaks.length === 1 ? '' : 's'}
                </Pill>
              )}
              <span className="text-fg-dim flex-shrink-0">·</span>
              <span
                className="ph-mono text-[11.5px] text-fg-mute truncate min-w-0"
                title={current.provider}
                style={{ flex: '1 1 0', minWidth: 0 }}
              >
                {current.provider}
              </span>
            </div>
            {/* Row 2: action buttons. flex-wrap so they reflow on narrow
                widths instead of overflowing the card. */}
            <div className="flex items-center gap-1.5 flex-wrap">
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
                icon={<I.copy size={12} />}
                onClick={() => copySource({ src: current.src, mode: current.mode })}
                title="Copy the original input to your clipboard and activate the original mode, then paste + run the global hotkey wherever you want."
              >
                Copy source
              </PhButton>
              <select
                value=""
                onChange={(e) => {
                  const id = e.target.value;
                  if (id) rerun(current.src, current.mode, id);
                }}
                disabled={rerunBusy || conns.filter((c) => c.hasKey).length === 0}
                className="text-[11.5px] rounded px-2 py-1 outline-none"
                style={{
                  background: 'var(--surface-2)',
                  border: '.5px solid var(--border)',
                  color: 'var(--fg)',
                  cursor: rerunBusy ? 'not-allowed' : 'pointer',
                  maxWidth: 180,
                }}
                title="Run this prompt again through a different connection / model"
              >
                <option value="">
                  {rerunBusy
                    ? 'Re-running…'
                    : conns.filter((c) => c.hasKey).length === 0
                    ? 'No usable connections'
                    : 'Re-run with…'}
                </option>
                {conns
                  .filter((c) => c.hasKey)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                      {c.defaultModel ? ` · ${c.defaultModel}` : ''}
                    </option>
                  ))}
              </select>
              <PhButton
                size="sm"
                variant="primary"
                icon={<I.copy size={12} />}
                onClick={() => copyOutput(current.out)}
              >
                Copy
              </PhButton>
            </div>
          </div>

          {(rerunResult || rerunError) && (
            <div
              className="rounded-md p-3 flex flex-col gap-1.5"
              style={{
                background: 'var(--bg-2)',
                border: `.5px solid ${rerunError ? 'rgba(248,113,113,0.30)' : 'var(--accent-tint-2)'}`,
              }}
            >
              <div className="flex items-center gap-2 text-[11px] ph-mono">
                <span style={{ color: rerunError ? 'var(--danger)' : 'var(--accent)' }}>
                  Re-run
                </span>
                {rerunResult && (
                  <>
                    <span className="text-fg-dim">·</span>
                    <span className="text-fg-mute">{rerunResult.model}</span>
                    <span className="text-fg-dim">·</span>
                    <span className="text-fg-mute">{rerunResult.latencyMs}ms</span>
                  </>
                )}
                <span className="flex-1" />
                {rerunResult && (
                  <button
                    type="button"
                    onClick={() => copyOutput(rerunResult.text)}
                    className="text-[11px]"
                    style={{ background: 'none', border: 'none', color: 'var(--fg-mute)', cursor: 'pointer' }}
                  >
                    Copy
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setRerunResult(null);
                    setRerunError(null);
                  }}
                  className="text-[11px]"
                  style={{ background: 'none', border: 'none', color: 'var(--fg-mute)', cursor: 'pointer' }}
                >
                  Dismiss
                </button>
              </div>
              <pre
                className="m-0 text-[12.5px] whitespace-pre-wrap break-words"
                style={{
                  color: rerunError ? 'var(--danger)' : 'var(--fg-strong)',
                  fontFamily: 'var(--sans)',
                  maxHeight: 200,
                  overflow: 'auto',
                }}
              >
                {rerunError ?? rerunResult?.text}
              </pre>
            </div>
          )}

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

          {tweaks.length > 0 && (
            <div className="flex flex-col gap-2">
              <div style={labelStyle}>Tweaks</div>
              {tweaks.map((t) => (
                <div key={t.id} className="flex flex-col gap-1.5">
                  <div
                    className="px-3 py-2 text-[12.5px] text-fg-mute whitespace-pre-wrap inline-flex gap-2"
                    style={{
                      background: 'var(--surface-2)',
                      border: '.5px solid var(--border)',
                      borderRadius: 'var(--r-md)',
                      lineHeight: 1.5,
                      wordBreak: 'break-word',
                    }}
                  >
                    <I.wand size={13} style={{ flexShrink: 0, marginTop: 2, color: 'var(--accent)' }} />
                    <span>{t.src}</span>
                  </div>
                  <div
                    className="px-3.5 py-2.5 text-[13px] text-fg whitespace-pre-wrap"
                    style={{
                      background: 'var(--accent-tint)',
                      border: '.5px solid var(--accent-tint-2)',
                      borderRadius: 'var(--r-md)',
                      lineHeight: 1.55,
                      maxHeight: 240,
                      overflow: 'auto',
                      wordBreak: 'break-word',
                    }}
                  >
                    {t.out}
                  </div>
                </div>
              ))}
            </div>
          )}

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
              <span className="ph-mono">{relativeTimeAgo(current.createdAt)}</span>
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
