import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { I } from '../Icon';

/**
 * Lightweight toast notification system. Lives at the providers level so any
 * component can call `useToast().push(...)` for unobtrusive success/error
 * feedback — no more scattered `window.alert` dialogs or inline error rows
 * the user has to dismiss manually.
 */

export type ToastKind = 'ok' | 'err' | 'info';

export interface ToastInput {
  kind?: ToastKind;
  title?: string;
  message: string;
  /** Milliseconds before auto-dismiss. 0 means stay until clicked. */
  duration?: number;
}

interface Toast extends Required<Pick<ToastInput, 'kind' | 'message' | 'duration'>> {
  id: number;
  title?: string;
}

interface ToastApi {
  push: (input: ToastInput) => void;
  ok: (message: string, title?: string) => void;
  err: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Render-without-provider safety: returns no-ops so a forgotten provider
    // doesn't crash a button click, just silently drops the toast.
    return {
      push: () => {},
      ok: () => {},
      err: () => {},
      info: () => {},
    };
  }
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const push = useCallback((input: ToastInput) => {
    const id = ++counter.current;
    const toast: Toast = {
      id,
      kind: input.kind ?? 'info',
      title: input.title,
      message: input.message,
      duration: input.duration ?? (input.kind === 'err' ? 6000 : 3500),
    };
    setToasts((prev) => [...prev, toast]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Auto-dismiss timers — one effect that re-runs whenever the toast list
  // changes. Each toast keeps a stable id so we don't double-fire.
  useEffect(() => {
    const timers = toasts
      .filter((t) => t.duration > 0)
      .map((t) =>
        window.setTimeout(() => dismiss(t.id), t.duration)
      );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [toasts, dismiss]);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      ok: (message, title) => push({ kind: 'ok', message, title }),
      err: (message, title) => push({ kind: 'err', message, title }),
      info: (message, title) => push({ kind: 'info', message, title }),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          zIndex: 10_000,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          alignItems: 'flex-end',
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const color =
    toast.kind === 'ok'
      ? { tint: 'rgba(52,211,153,0.10)', accent: 'var(--ok)', border: 'rgba(52,211,153,0.30)' }
      : toast.kind === 'err'
      ? { tint: 'rgba(248,113,113,0.10)', accent: 'var(--danger)', border: 'rgba(248,113,113,0.30)' }
      : { tint: 'var(--accent-tint)', accent: 'var(--accent)', border: 'var(--accent-tint-2)' };

  const Icon =
    toast.kind === 'ok' ? I.check : toast.kind === 'err' ? I.close : I.info;

  return (
    <div
      onClick={onDismiss}
      className="ph-anim-pop-in"
      style={{
        pointerEvents: 'auto',
        cursor: 'pointer',
        minWidth: 260,
        maxWidth: 380,
        padding: '10px 12px',
        borderRadius: 10,
        background: 'var(--surface)',
        border: `.5px solid ${color.border}`,
        boxShadow: 'var(--shadow-md)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
      }}
      role="status"
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: color.tint,
          color: color.accent,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon size={13} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {toast.title && (
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--fg-strong)',
              marginBottom: 2,
            }}
          >
            {toast.title}
          </div>
        )}
        <div style={{ fontSize: 12, color: 'var(--fg)', wordBreak: 'break-word' }}>
          {toast.message}
        </div>
      </div>
    </div>
  );
}
