import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Suspense, lazy, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Changelog, CheatSheet, CommandPalette, LoadingSpinner } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';

const HomePage = lazy(() =>
  import('@features/home/pages/HomePage').then((m) => ({ default: m.HomePage }))
);
const NotFoundPage = lazy(() =>
  import('@shared/ui/NotFoundPage').then((m) => ({ default: m.NotFoundPage }))
);
const OnboardingPage = lazy(() =>
  import('@features/onboarding').then((m) => ({ default: m.OnboardingPage }))
);
// NOTE: `/palette`, `/tray`, `/overlay`, `/toasts` used to mount React previews
// of those surfaces. They are deliberately not routed — the real surfaces are
// OS-level (tray icon, transparent HUD window, native toasts). The React
// components still exist as design artifacts but should not be navigable.

const SettingsWindow = lazy(() =>
  import('@features/settings').then((m) => ({ default: m.SettingsWindow }))
);
const GeneralPanel = lazy(() =>
  import('@features/settings').then((m) => ({ default: m.GeneralPanel }))
);
const ShortcutsPanel = lazy(() =>
  import('@features/settings').then((m) => ({ default: m.ShortcutsPanel }))
);
const ModesPanel = lazy(() =>
  import('@features/settings').then((m) => ({ default: m.ModesPanel }))
);
const ProvidersPanel = lazy(() =>
  import('@features/settings').then((m) => ({ default: m.ProvidersPanel }))
);
const HistoryPanel = lazy(() =>
  import('@features/settings').then((m) => ({ default: m.HistoryPanel }))
);
const AppearancePanel = lazy(() =>
  import('@features/settings').then((m) => ({ default: m.AppearancePanel }))
);
const AdvancedPanel = lazy(() =>
  import('@features/settings').then((m) => ({ default: m.AdvancedPanel }))
);
const AboutPanel = lazy(() =>
  import('@features/settings').then((m) => ({ default: m.AboutPanel }))
);

/**
 * Persist the current route so re-opening the main window lands the user
 * where they were. Stored as the `last_route` KV in the settings table.
 * Restoration is one-shot on mount; saves debounce by listening to route
 * changes via `useLocation`.
 */
function LastRouteMemory() {
  const navigate = useNavigate();
  const location = useLocation();
  const restored = useRef(false);

  // One-shot restore.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (location.pathname !== '/') return; // user deep-linked — don't override
    invokeCommand<string | null>('get_kv', { key: 'last_route' })
      .then((raw) => {
        if (!raw) return;
        try {
          const path = JSON.parse(raw) as unknown;
          if (typeof path === 'string' && path.startsWith('/') && path !== '/') {
            navigate(path, { replace: true });
          }
        } catch {
          /* malformed — ignore */
        }
      })
      .catch(() => {});
  }, [navigate, location.pathname]);

  // Persist on every navigation.
  useEffect(() => {
    if (location.pathname === '/setup') return; // never auto-return to onboarding
    invokeCommand<void>('set_kv', {
      key: 'last_route',
      value: JSON.stringify(location.pathname),
    }).catch(() => {});
  }, [location.pathname]);

  return null;
}

/**
 * Window-scoped keyboard shortcuts for the main app shell. These ARE NOT the
 * global OS hotkeys (those live in the backend `shortcuts` module and fire
 * from anywhere on the desktop). These only fire while the main window has
 * focus and exist to match Windows-app conventions:
 *
 *   Esc        — hide the window to tray (same as the close button)
 *   Ctrl+,     — open Settings
 *   Ctrl+M     — cycle the active mode locally
 *
 * Designed to never swallow keys that an input is consuming: we bail early if
 * an editable element is the active target.
 */
function WindowKeyboardShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    function isEditable(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    }

    function handler(e: KeyboardEvent) {
      if (isEditable(e.target)) return;

      // Esc — hide to tray. Skip when the user is in a modal/dialog so
      // the dialog can consume it first (no current dialogs, but future-proof).
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        invokeCommand<void>('hide_main_window').catch(() => {});
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        navigate('/settings');
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        invokeCommand<void>('cycle_mode_cmd').catch(() => {});
        return;
      }
    }

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  return null;
}

/**
 * On first launch, push the user into the onboarding flow once. We check the
 * persistent `first_run_done` KV in the backend and redirect / → /setup if
 * not yet done. The check runs only on the home route so deep links and tray
 * navigations are never intercepted.
 */
function FirstRunGate() {
  const navigate = useNavigate();
  const location = useLocation();
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    if (location.pathname !== '/') return;
    checked.current = true;
    invokeCommand<boolean>('get_first_run_done')
      .then((done) => {
        if (!done) navigate('/setup', { replace: true });
      })
      .catch(() => {
        /* swallow: in browser-only preview the command doesn't exist */
      });
  }, [location.pathname, navigate]);

  return null;
}

/**
 * Listens for backend `navigate` events (currently fired by the tray's
 * "Settings…" menu item) and pushes the requested path into React Router.
 * Keeps navigation decisions on the React side rather than coupling the
 * backend to URL hash hacks.
 */
function BackendNavigationBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    const promise = listen<string>('navigate', (e) => {
      if (typeof e.payload === 'string' && e.payload.startsWith('/')) {
        navigate(e.payload);
      }
    });
    return () => {
      promise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [navigate]);
  return null;
}

export function AppRouter() {
  return (
    <Suspense fallback={<LoadingSpinner fullScreen />}>
      <FirstRunGate />
      <LastRouteMemory />
      <WindowKeyboardShortcuts />
      <BackendNavigationBridge />
      <CommandPalette />
      <CheatSheet />
      <Changelog />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/setup" element={<OnboardingPage />} />

        <Route path="/settings" element={<SettingsWindow />}>
          <Route index element={<Navigate to="general" replace />} />
          <Route path="general" element={<GeneralPanel />} />
          <Route path="shortcuts" element={<ShortcutsPanel />} />
          <Route path="modes" element={<ModesPanel />} />
          <Route path="providers" element={<ProvidersPanel />} />
          <Route path="history" element={<HistoryPanel />} />
          <Route path="appearance" element={<AppearancePanel />} />
          <Route path="advanced" element={<AdvancedPanel />} />
          <Route path="about" element={<AboutPanel />} />
        </Route>

        <Route path="/404" element={<NotFoundPage />} />
        <Route path="*" element={<Navigate to="/404" replace />} />
      </Routes>
    </Suspense>
  );
}
