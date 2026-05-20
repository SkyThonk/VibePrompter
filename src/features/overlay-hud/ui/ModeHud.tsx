import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { I, type IconName } from '@shared/ui';

interface HudPayload {
  modeId: string;
  modeName: string;
  iconName?: string | null;
  kicker?: string | null;
}

/**
 * Native transparent HUD shown briefly when the active prompt mode changes.
 * Lives in the `mode-hud` Tauri window (transparent, alwaysOnTop, skipTaskbar,
 * undecorated). Listens for `hud_show` events emitted by the `show_mode_hud`
 * Tauri command; animates in, holds, animates out, then hides the window.
 *
 * Visual reference: Windows volume OSD, Raycast confirmation toast.
 */
/**
 * Read `theme` and `accent` from the backend settings and apply them to this
 * window's `<html>` element. The HUD window mounts an isolated React tree (no
 * `BackendThemeBridge`), so without this it always renders the dark default.
 */
function applyThemeAttrs(theme?: string, accent?: string) {
  const html = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    html.setAttribute('data-theme', theme);
  } else if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    html.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  }
  if (accent) html.setAttribute('data-accent', accent);
}

export function ModeHud() {
  const [payload, setPayload] = useState<HudPayload | null>(null);
  const [counter, setCounter] = useState(0);

  useEffect(() => {
    invoke<{ theme?: string; accent?: string }>('get_settings')
      .then((s) => applyThemeAttrs(s?.theme, s?.accent))
      .catch(() => {});
    const promise = listen('settings_changed', () => {
      invoke<{ theme?: string; accent?: string }>('get_settings')
        .then((s) => applyThemeAttrs(s?.theme, s?.accent))
        .catch(() => {});
    });
    return () => {
      promise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  // Body must be transparent so the OS window transparency actually shows.
  // The default index.css sets body background to `var(--bg)` which would
  // otherwise fill the HUD window with the app's dark surface.
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

  useEffect(() => {
    const unlistenPromise = listen<HudPayload>('hud_show', (e) => {
      setPayload(e.payload);
      setCounter((c) => c + 1);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  // The ph-hud-popup keyframe is 1500ms; give it a small tail so the final
  // fade-out frame actually paints before the OS window is hidden. Without
  // this buffer the card visibly snaps off on slower frames.
  useEffect(() => {
    if (counter === 0) return;
    const id = window.setTimeout(() => {
      getCurrentWindow().hide().catch(() => {});
    }, 1600);
    return () => window.clearTimeout(id);
  }, [counter]);

  if (!payload) return null;

  // Catalog modes carry an `icon_name` (e.g. "code", "mail", "pen") that maps
  // 1:1 to entries in the shared `I` icon set. Fall back to the lightning
  // bolt — the original "mode switched" glyph — for any unknown name or when
  // the backend didn't send one (manual demo trigger).
  const iconKey = (payload.iconName ?? 'bolt') as IconName;
  const Icon = (I as Record<string, React.ComponentType<{ size?: number }>>)[iconKey] ?? I.bolt;

  return (
    <div
      className="ph-root ph-hud-stage"
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
      }}
    >
      <div
        key={counter}
        className="ph-hud-card"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '12px 18px',
          background: 'var(--glass)',
          backdropFilter: 'blur(20px) saturate(160%)',
          WebkitBackdropFilter: 'blur(20px) saturate(160%)',
          border: '1px solid var(--border-strong)',
          borderRadius: 14,
          // Tight shadow only — large outer glows get clipped by the
          // rectangular transparent window edge, producing a sharp seam
          // at the rounded corners. 12px blur stays comfortably within
          // the window bounds even when the HUD card is full-width.
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
          isolation: 'isolate',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: 'var(--accent-tint)',
            color: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '.5px solid var(--accent-tint-2)',
            flexShrink: 0,
          }}
        >
          <Icon size={18} />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span
            style={{
              fontSize: 10.5,
              color: 'var(--fg-dim)',
              textTransform: 'uppercase',
              letterSpacing: '0.10em',
              fontWeight: 600,
            }}
          >
            {payload.kicker ?? 'Mode switched'}
          </span>
          <span
            style={{
              fontSize: 16,
              color: 'var(--fg-strong)',
              fontWeight: 600,
              letterSpacing: '-0.01em',
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {payload.modeName}
          </span>
        </div>
      </div>
    </div>
  );
}
