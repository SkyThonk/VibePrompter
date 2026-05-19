import { useEffect, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface WindowTitlebarProps {
  title?: string;
  icon?: ReactNode;
}

export function WindowTitlebar({ title = 'VibePrompter', icon }: WindowTitlebarProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = safeWindow();
    if (!win) return;
    let unlisten: undefined | (() => void);
    win.isMaximized().then(setMaximized).catch(() => {});
    win
      .onResized(() => {
        win.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  const onMin = () => safeWindow()?.minimize().catch(() => {});
  const onMax = () => safeWindow()?.toggleMaximize().catch(() => {});
  const onClose = () => safeWindow()?.close().catch(() => {});

  return (
    <div
      data-tauri-drag-region
      className="h-9 flex-shrink-0 px-3 flex items-center gap-2.5 bg-bg-2 border-b-[0.5px] border-border text-xs text-fg-mute select-none"
      style={{ letterSpacing: '-0.005em' }}
    >
      {icon}
      <span className="flex-1 text-center pointer-events-none">{title}</span>
      <div className="flex">
        <WinBtn onClick={onMin} aria-label="Minimize">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" />
          </svg>
        </WinBtn>
        <WinBtn onClick={onMax} aria-label={maximized ? 'Restore' : 'Maximize'}>
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
              <rect x="0.5" y="2.5" width="7" height="7" />
              <path d="M2.5 2.5V0.5H9.5V7.5H7.5" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" />
            </svg>
          )}
        </WinBtn>
        <WinBtn onClick={onClose} aria-label="Close" danger>
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor">
            <line x1="0" y1="0" x2="10" y2="10" />
            <line x1="10" y1="0" x2="0" y2="10" />
          </svg>
        </WinBtn>
      </div>
    </div>
  );
}

function safeWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

function WinBtn({
  children,
  onClick,
  danger,
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-9 h-9 border-0 p-0 bg-transparent text-fg-mute flex items-center justify-center cursor-pointer ${
        danger ? 'hover:bg-red-500 hover:text-white' : 'hover:bg-surface-2'
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}
