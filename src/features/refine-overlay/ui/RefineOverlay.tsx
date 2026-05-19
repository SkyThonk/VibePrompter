import { useEffect, useRef, useState } from 'react';
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
interface ResetPayload {
  selection: string;
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
  const bufRef = useRef('');
  // Set true while we're in the Accept handoff so the blur-to-dismiss
  // listener doesn't race the accept's own hide → undo the clipboard.
  const acceptingRef = useRef(false);

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
      }),
      listen('refine:reset_text', () => {
        setText('');
        bufRef.current = '';
        setDone(null);
        setError(null);
      }),
      listen<string>('refine:token', (e) => {
        bufRef.current += e.payload;
        setText(bufRef.current);
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
        accept();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        retry();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [done, text]);

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

  const iconKey = (meta?.iconName ?? 'wand') as IconName;
  const ModeIcon =
    (I as Record<string, React.ComponentType<{ size?: number }>>)[iconKey] ?? I.wand;
  const streaming = !done && !error;

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
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
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
              {streaming
                ? 'Refining…'
                : error
                ? 'Failed'
                : done
                ? `${done.model} · ${done.latencyMs}ms`
                : 'Ready'}
            </div>
          </div>
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
              <span style={{ color: 'var(--fg-dim)' }}>
                Working on your selection…
              </span>
            )}
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
            onClick={reject}
            title="Cancel (Esc)"
            style={btnStyle('ghost')}
          >
            <I.close size={12} />
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={retry}
            disabled={streaming}
            title="Retry (Ctrl+R)"
            style={btnStyle('ghost', streaming)}
          >
            <I.refresh size={12} />
            Retry
          </button>
          <button
            type="button"
            onClick={accept}
            disabled={!done || !text}
            title="Accept and paste (Enter)"
            style={btnStyle('primary', !done || !text)}
          >
            <I.check size={12} />
            Replace
          </button>
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
      color: disabled ? 'var(--fg-dim)' : '#1a0f2e',
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
