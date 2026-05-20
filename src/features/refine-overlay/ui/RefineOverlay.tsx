import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { I, type IconName } from '@shared/ui';

/**
 * The near-cursor refine overlay. Lives in its own `refine-overlay` Tauri
 * window (transparent, borderless, always-on-top). Backend pushes:
 *
 *   refine:reset       { selection, modeId, modeName, iconName }
 *   refine:reset_text  ()         — sent on Retry, clears the streamed buffer
 *   refine:token       <string>   — each streamed delta
 *   refine:done        { text, model, latencyMs }
 *   refine:error       <string>
 *
 * Buttons call back into Tauri commands `refine_accept` / `refine_reject` /
 * `refine_retry`. Accept hides the window and synthesizes Ctrl+V into the
 * (still-focused) source app.
 */
type RefineKind = 'rewrite' | 'grammar' | 'summarize';

interface ResetPayload {
  selection: string;
  kind?: RefineKind;
  modeId: string;
  modeName: string;
  iconName?: string | null;
}

interface DonePayload {
  text: string;
  model: string;
  latencyMs: number;
}

export function RefineOverlay() {
  const [meta, setMeta] = useState<ResetPayload | null>(null);
  const [text, setText] = useState('');
  const [done, setDone] = useState<DonePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [conns, setConns] = useState<
    Array<{ id: string; label: string; defaultModel: string; hasKey: boolean; isDefault: boolean }>
  >([]);
  const [activeConnId, setActiveConnId] = useState<string>('');
  const bufRef = useRef('');
  const flushPendingRef = useRef(false);
  // Set true while we're in the Accept handoff so the blur-to-dismiss
  // listener doesn't race the accept's own hide → undo the clipboard.
  const acceptingRef = useRef(false);

  // Coalesce streamed token deltas into one React paint per animation frame.
  // Without this a fast provider's per-token setState pegs WebView2 against
  // the blurred card and produces visible jank.
  const scheduleFlush = () => {
    if (flushPendingRef.current) return;
    flushPendingRef.current = true;
    requestAnimationFrame(() => {
      flushPendingRef.current = false;
      setText(bufRef.current);
    });
  };

  // Body must be transparent so the OS window's transparency actually shows.
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prev = {
      htmlBg: html.style.background,
      bodyBg: body.style.background,
      bodyOverflow: body.style.overflow,
    };
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    body.style.overflow = 'hidden';
    return () => {
      html.style.background = prev.htmlBg;
      body.style.background = prev.bodyBg;
      body.style.overflow = prev.bodyOverflow;
    };
  }, []);

  // Fetch the connection catalog once so the model picker has options to
  // show. Reset on every refine:reset (new session) so the picker doesn't
  // remember last session's manual selection — each session starts back
  // on the default / mode-pinned connection.
  useEffect(() => {
    invoke<typeof conns>('list_connections').then(setConns).catch(() => setConns([]));
  }, []);

  // Apply backend theme + accent so this window matches the rest of the app.
  useEffect(() => {
    invoke<{ theme?: string; accent?: string }>('get_settings')
      .then((s) => {
        const html = document.documentElement;
        if (s.theme === 'light' || s.theme === 'dark') {
          html.setAttribute('data-theme', s.theme);
        } else if (s.theme === 'system') {
          const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          html.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
        }
        if (s.accent) html.setAttribute('data-accent', s.accent);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unlistens: Array<() => void> = [];
    Promise.all([
      listen<ResetPayload>('refine:reset', (e) => {
        setMeta(e.payload);
        setText('');
        bufRef.current = '';
        setDone(null);
        setError(null);
        setActiveConnId(''); // new session — picker shows "Default / pinned"
        // Windows often refuses cross-process focus-steal on show(),
        // leaving the first click consumed by window activation. Pull
        // focus back into the webview as soon as the new session begins.
        try {
          window.focus();
          getCurrentWindow().setFocus().catch(() => {});
        } catch {
          /* ignore */
        }
      }),
      listen('refine:reset_text', () => {
        setText('');
        bufRef.current = '';
        setDone(null);
        setError(null);
      }),
      listen<string>('refine:token', (e) => {
        bufRef.current += e.payload;
        scheduleFlush();
      }),
      listen<DonePayload>('refine:done', (e) => {
        setDone(e.payload);
        setText(e.payload.text);
        bufRef.current = e.payload.text;
      }),
      listen<string>('refine:error', (e) => {
        setError(e.payload);
      }),
    ]).then((all) => unlistens.push(...all));
    return () => {
      unlistens.forEach((u) => u());
    };
  }, []);

  // Auto-dismiss when the user clicks away from the overlay (Raycast-style).
  // Only after the overlay has actually appeared (avoids self-dismissing
  // during the initial focus handoff from the source app).
  useEffect(() => {
    let ready = false;
    const armTimer = window.setTimeout(() => {
      ready = true;
    }, 250);

    const onBlur = () => {
      if (!ready) return;
      if (acceptingRef.current) return; // accept's own hide → don't double-fire
      invoke<void>('refine_reject').catch(() => {
        getCurrentWindow().hide().catch(() => {});
      });
    };
    window.addEventListener('blur', onBlur);
    return () => {
      window.clearTimeout(armTimer);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Keyboard shortcuts inside the overlay: Esc rejects, Enter accepts when
  // streaming has finished, Cmd/Ctrl+R retries.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        reject();
      } else if (e.key === 'Enter' && !e.shiftKey && done) {
        e.preventDefault();
        if (meta?.kind === 'summarize') {
          copyAndHide();
        } else {
          accept();
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        retry();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [done, text, meta?.kind]);

  function accept() {
    acceptingRef.current = true;
    invoke<void>('refine_accept', { text }).catch(() => {
      acceptingRef.current = false;
    });
  }
  function reject() {
    invoke<void>('refine_reject')
      .catch(() => {})
      .finally(() => {
        getCurrentWindow().hide().catch(() => {});
      });
  }
  function retry() {
    invoke<void>('refine_retry').catch(() => {});
  }
  function copyAndHide() {
    if (!text) return;
    // Use the browser clipboard API (the refine-overlay webview already has
    // clipboard-write via core:default). Restoring the user's prior clipboard
    // is the refine_reject path's job, so we just dismiss the overlay after.
    navigator.clipboard.writeText(text).catch(() => {});
    getCurrentWindow().hide().catch(() => {});
  }

  const kind: RefineKind = meta?.kind ?? 'rewrite';
  const isSummarize = kind === 'summarize';
  const isGrammar = kind === 'grammar';
  const iconKey = (meta?.iconName ?? (isSummarize ? 'summarize' : isGrammar ? 'text' : 'wand')) as IconName;
  const ModeIcon =
    (I as Record<string, React.ComponentType<{ size?: number }>>)[iconKey] ?? I.wand;
  const streaming = !done && !error;
  const subtitle = streaming
    ? isSummarize
      ? 'Summarizing…'
      : isGrammar
      ? 'Fixing grammar…'
      : 'Refining…'
    : error
    ? 'Failed'
    : done
    ? `${done.model} · ${done.latencyMs}ms`
    : 'Ready';

  return (
    <div
      className="ph-root"
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'stretch',
        background: 'transparent',
        padding: 0,
      }}
    >
      <div
        className="ph-anim-pop-in"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--glass)',
          backdropFilter: 'blur(20px) saturate(160%)',
          WebkitBackdropFilter: 'blur(20px) saturate(160%)',
          border: '.5px solid var(--border-strong)',
          borderRadius: 14,
          boxShadow:
            'var(--shadow-lg), 0 0 0 1px rgba(255,255,255,0.03), 0 0 60px rgba(167,139,250,0.10)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 14px',
            borderBottom: '.5px solid var(--divider)',
          }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              background: 'var(--accent-tint)',
              color: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '.5px solid var(--accent-tint-2)',
            }}
          >
            <ModeIcon size={14} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: 'var(--fg-strong)', fontWeight: 600 }}>
              {meta?.modeName ?? 'Refine'}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>
              {subtitle}
            </div>
          </div>
          {conns.filter((c) => c.hasKey).length > 1 && (
            <select
              value={activeConnId}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                setActiveConnId(id);
                invoke('refine_switch_connection', { connId: id }).catch(() => {});
              }}
              disabled={streaming}
              className="text-[10.5px] rounded px-1.5 py-0.5 outline-none"
              style={{
                background: 'var(--surface-2)',
                border: '.5px solid var(--border)',
                color: 'var(--fg-mute)',
                cursor: streaming ? 'not-allowed' : 'pointer',
                maxWidth: 140,
              }}
              title="Re-run through a different connection / model"
            >
              <option value="">
                {activeConnId ? 'Switch model…' : 'Default / pinned'}
              </option>
              {conns
                .filter((c) => c.hasKey)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
            </select>
          )}
          {!streaming && !error && done && !isSummarize && (
            <button
              type="button"
              onClick={() => setShowDiff((v) => !v)}
              className="text-[10.5px] px-1.5 py-0.5 rounded"
              style={{
                background: showDiff ? 'var(--accent-tint)' : 'var(--surface-2)',
                color: showDiff ? 'var(--accent)' : 'var(--fg-mute)',
                border: `.5px solid ${
                  showDiff ? 'var(--accent-tint-2)' : 'var(--border)'
                }`,
                cursor: 'pointer',
              }}
              title="Highlight what changed vs the original selection"
            >
              {showDiff ? 'Diff on' : 'Diff'}
            </button>
          )}
          {streaming && (
            <span
              className="ph-pulse"
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: 'var(--accent)',
              }}
            />
          )}
        </div>

        {/* Body — read-only stream while running; editable textarea once done so
            the user can polish typos before hitting Replace. */}
        {error ? (
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '12px 14px',
              fontSize: 13,
              lineHeight: 1.5,
              color: 'var(--danger)',
            }}
          >
            {error}
          </div>
        ) : isSummarize ? (
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '12px 14px',
              color: 'var(--fg-strong)',
              fontSize: 13,
              lineHeight: 1.55,
              background: 'transparent',
            }}
          >
            {text ? (
              <BulletBlock text={text} showCaret={streaming} />
            ) : (
              <ThinkingLoader kind="summarize" />
            )}
          </div>
        ) : streaming || !done ? (
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '12px 14px',
              color: 'var(--fg-strong)',
              fontSize: 13,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: 'transparent',
            }}
          >
            {text ? (
              <>
                {text}
                <span
                  className="ph-caret"
                  style={{
                    display: 'inline-block',
                    width: 6,
                    height: 14,
                    marginLeft: 1,
                    background: 'var(--accent)',
                    verticalAlign: 'text-bottom',
                  }}
                />
              </>
            ) : (
              <ThinkingLoader kind={kind} />
            )}
          </div>
        ) : showDiff && meta?.selection ? (
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '12px 14px',
              color: 'var(--fg-strong)',
              fontSize: 13,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: 'transparent',
              fontFamily: 'var(--sans)',
            }}
          >
            <DiffView original={meta.selection} updated={text} />
          </div>
        ) : (
          <textarea
            value={text}
            onChange={(e) => {
              bufRef.current = e.target.value;
              setText(e.target.value);
            }}
            style={{
              flex: 1,
              padding: '12px 14px',
              color: 'var(--fg-strong)',
              fontSize: 13,
              lineHeight: 1.5,
              fontFamily: 'var(--sans)',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              width: '100%',
            }}
          />
        )}

        {/* Footer / actions */}
        {/* Follow-up input — only useful once we have a result the user can
            ask us to refine. Pressing Enter fires `refine_followup` which
            re-streams a new result into the same overlay. Esc clears the
            field without triggering a follow-up. */}
        {done && !error && !isSummarize && (
          <FollowupBar onSend={(instruction) => invoke('refine_followup', { instruction })} />
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 10px',
            borderTop: '.5px solid var(--divider)',
            background: 'var(--surface)',
          }}
        >
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              reject();
            }}
            title="Cancel (Esc)"
            style={btnStyle('ghost')}
          >
            <I.close size={12} />
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          {isSummarize ? (
            <button
              type="button"
              onPointerDown={(e) => {
                if (!done || !text) return;
                e.preventDefault();
                copyAndHide();
              }}
              disabled={!done || !text}
              title="Copy summary to clipboard (Enter)"
              style={btnStyle('primary', !done || !text)}
            >
              <I.check size={12} />
              Copy
            </button>
          ) : (
            <>
              <button
                type="button"
                onPointerDown={(e) => {
                  if (streaming) return;
                  e.preventDefault();
                  retry();
                }}
                disabled={streaming}
                title="Retry (Ctrl+R)"
                style={btnStyle('ghost', streaming)}
              >
                <I.refresh size={12} />
                Retry
              </button>
              <button
                type="button"
                onPointerDown={(e) => {
                  if (!done || !text) return;
                  e.preventDefault();
                  accept();
                }}
                disabled={!done || !text}
                title="Accept and paste (Enter)"
                style={btnStyle('primary', !done || !text)}
              >
                <I.check size={12} />
                Replace
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function btnStyle(
  variant: 'primary' | 'ghost',
  disabled = false
): React.CSSProperties {
  if (variant === 'primary') {
    return {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '5px 10px',
      borderRadius: 6,
      background: disabled ? 'var(--surface-2)' : 'var(--accent)',
      color: disabled ? 'var(--fg-dim)' : '#ffffff',
      fontSize: 11.5,
      fontWeight: 600,
      border: '.5px solid transparent',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.6 : 1,
    };
  }
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '5px 10px',
    borderRadius: 6,
    background: 'transparent',
    color: disabled ? 'var(--fg-dim)' : 'var(--fg)',
    fontSize: 11.5,
    fontWeight: 500,
    border: '.5px solid var(--border)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

/**
 * Word-level diff highlighter. Splits both strings on whitespace +
 * punctuation, runs a longest-common-subsequence pass, then renders
 * removed runs with red strikethrough and inserted runs with green
 * background. Lightweight (no dependency); accuracy is good enough for
 * the typical refine output where ~80% of the text is unchanged.
 */
function DiffView({ original, updated }: { original: string; updated: string }) {
  const segments = useMemo(() => diffWords(original, updated), [original, updated]);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'equal') {
          return <span key={i}>{seg.text}</span>;
        }
        if (seg.kind === 'insert') {
          return (
            <span
              key={i}
              style={{
                background: 'rgba(52, 211, 153, 0.18)',
                color: 'var(--ok)',
                borderRadius: 3,
                padding: '0 2px',
              }}
            >
              {seg.text}
            </span>
          );
        }
        return (
          <span
            key={i}
            style={{
              background: 'rgba(248, 113, 113, 0.12)',
              color: 'var(--danger)',
              textDecoration: 'line-through',
              textDecorationThickness: '1.5px',
              borderRadius: 3,
              padding: '0 2px',
            }}
          >
            {seg.text}
          </span>
        );
      })}
    </>
  );
}

interface DiffSeg {
  kind: 'equal' | 'insert' | 'delete';
  text: string;
}

/** Tokenize keeping whitespace + punctuation as their own tokens so the
 *  diff doesn't collapse "hello," and "hello" into a "changed" segment
 *  just because of trailing punctuation. */
function tokenizePreservingWhitespace(s: string): string[] {
  return s.split(/(\s+|[.,!?;:()"'`—–-])/).filter((x) => x.length > 0);
}

function diffWords(a: string, b: string): DiffSeg[] {
  const ta = tokenizePreservingWhitespace(a);
  const tb = tokenizePreservingWhitespace(b);
  // Bail out on very long inputs — O(N*M) gets slow above ~10k tokens.
  // Show the result as one insert; user can fall back to the textarea.
  if (ta.length * tb.length > 4_000_000) {
    return [{ kind: 'insert', text: b }];
  }

  // LCS DP. dp[i][j] = length of LCS of ta[0..i] + tb[0..j].
  const n = ta.length;
  const m = tb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (ta[i - 1] === tb[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Walk back to emit segments, then merge adjacent same-kind runs so the
  // rendered HTML doesn't fragment into hundreds of one-character spans.
  const raw: DiffSeg[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (ta[i - 1] === tb[j - 1]) {
      raw.push({ kind: 'equal', text: ta[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      raw.push({ kind: 'delete', text: ta[i - 1] });
      i--;
    } else {
      raw.push({ kind: 'insert', text: tb[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    raw.push({ kind: 'delete', text: ta[i - 1] });
    i--;
  }
  while (j > 0) {
    raw.push({ kind: 'insert', text: tb[j - 1] });
    j--;
  }
  raw.reverse();
  const merged: DiffSeg[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && last.kind === seg.kind) {
      last.text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/**
 * Tiny input bar that fires a multi-turn follow-up against the current
 * refine session. Showing this only after `done` keeps the layout minimal
 * while the model is streaming. Enter sends, Shift+Enter inserts a newline
 * (so you can write a longer instruction without firing prematurely), Esc
 * clears the field. The bar stays visible after sending — chains of
 * follow-ups are explicit by design.
 */
function FollowupBar({ onSend }: { onSend: (instruction: string) => void }) {
  const [value, setValue] = useState('');
  const send = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue('');
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 10px',
        borderTop: '.5px solid var(--divider)',
        background: 'var(--bg-2)',
      }}
    >
      <I.wand size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setValue('');
            (e.target as HTMLInputElement).blur();
          }
          // Stop propagation so the overlay's top-level keyboard handler
          // doesn't see this Enter as "accept the result."
          e.stopPropagation();
        }}
        placeholder="Tweak: make it shorter, more formal, …"
        style={{
          flex: 1,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--fg)',
          fontSize: 12.5,
          fontFamily: 'var(--sans)',
          padding: 0,
          minWidth: 0,
        }}
      />
      {value.trim() && (
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            send();
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 8px',
            borderRadius: 5,
            background: 'var(--accent)',
            color: '#ffffff',
            fontSize: 11,
            fontWeight: 600,
            border: '.5px solid transparent',
            cursor: 'pointer',
          }}
          title="Send follow-up (Enter)"
        >
          Tweak
        </button>
      )}
    </div>
  );
}

/**
 * Claude-Code-style rotating phrase while the model is thinking. Stays on
 * screen until the first streamed token arrives (caller swaps the loader
 * for the streaming text). Phrases rotate every ~2.4s with a short fade so
 * the user always sees something happening even on slow first-token
 * latency. Phrase pool is per-kind so the wording matches the action.
 */
const THINKING_PHRASES: Record<RefineKind, string[]> = {
  rewrite: [
    'Pondering',
    'Polishing',
    'Reworking',
    'Refining',
    'Tightening',
    'Massaging the prose',
    'Picking better words',
    'Reading it twice',
    'Trimming the fat',
  ],
  grammar: [
    'Proofreading',
    'Checking commas',
    'Hunting typos',
    'Tightening punctuation',
    'Reading carefully',
    'Squinting at semicolons',
    'Smoothing the rough edges',
  ],
  summarize: [
    'Distilling',
    'Highlighting',
    'Pulling out the gist',
    'Boiling it down',
    'Cherry-picking the key bits',
    'Compressing',
    'Reading through',
  ],
};

function ThinkingLoader({ kind }: { kind: RefineKind }) {
  const phrases = THINKING_PHRASES[kind] ?? THINKING_PHRASES.rewrite;
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * phrases.length));
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // Fade out → swap phrase → fade in. The total cycle is ~2.4s; the swap
    // happens at the halfway point so neither state lingers awkwardly.
    const cycle = window.setInterval(() => {
      setVisible(false);
      window.setTimeout(() => {
        setIdx((i) => (i + 1) % phrases.length);
        setVisible(true);
      }, 220);
    }, 2400);
    return () => window.clearInterval(cycle);
  }, [phrases.length]);

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: 'var(--fg-mute)',
        fontSize: 13,
      }}
    >
      <span
        className="ph-pulse"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: 'var(--accent)',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(-2px)',
          transition: 'opacity 220ms ease, transform 220ms ease',
          display: 'inline-block',
        }}
      >
        {phrases[idx]}
        <DotEllipsis />
      </span>
    </span>
  );
}

/** Three dots that fill in sequentially. Cheaper than animating each glyph
 *  with keyframes — just a 1.2s setInterval ticking 0 → 1 → 2 → 3 → 0. */
function DotEllipsis() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setN((v) => (v + 1) % 4), 360);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span style={{ display: 'inline-block', width: '1.5ch', textAlign: 'left' }}>
      {'.'.repeat(n)}
    </span>
  );
}

/**
 * Lightweight bullet renderer for the Summarize output. The model is
 * instructed to emit one short bullet per line prefixed with `- ` (or `* `);
 * we render those as `<li>` and fall back to plain paragraphs for anything
 * else. A trailing caret blinks while streaming. Intentionally not a full
 * Markdown parser — the prompt constrains the shape enough that a fancier
 * library would just add weight.
 */
function BulletBlock({ text, showCaret }: { text: string; showCaret: boolean }) {
  const lines = text.split('\n');
  const blocks: Array<{ kind: 'bullet' | 'para'; items: string[] }> = [];
  for (const raw of lines) {
    const line = raw.replace(/^\s+/, '');
    if (!line) continue;
    const isBullet = /^[-*•]\s+/.test(line);
    const body = isBullet ? line.replace(/^[-*•]\s+/, '') : line;
    const last = blocks[blocks.length - 1];
    if (isBullet) {
      if (last?.kind === 'bullet') last.items.push(body);
      else blocks.push({ kind: 'bullet', items: [body] });
    } else {
      if (last?.kind === 'para') last.items.push(body);
      else blocks.push({ kind: 'para', items: [body] });
    }
  }

  const caret = showCaret ? (
    <span
      className="ph-caret"
      style={{
        display: 'inline-block',
        width: 6,
        height: 14,
        marginLeft: 4,
        background: 'var(--accent)',
        verticalAlign: 'text-bottom',
      }}
    />
  ) : null;
  const lastIdx = blocks.length - 1;

  return (
    <>
      {blocks.map((b, bi) => {
        if (b.kind === 'bullet') {
          return (
            <ul key={bi} style={{ margin: 0, paddingLeft: 18 }}>
              {b.items.map((it, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  {it}
                  {bi === lastIdx && i === b.items.length - 1 && caret}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi} style={{ margin: '0 0 8px 0', whiteSpace: 'pre-wrap' }}>
            {b.items.join(' ')}
            {bi === lastIdx && caret}
          </p>
        );
      })}
    </>
  );
}
