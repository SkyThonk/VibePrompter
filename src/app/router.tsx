import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Suspense, lazy, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Changelog, CheatSheet, CommandPalette, HowItWorks, LoadingSpinner } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';

const StartupPage = lazy(() =>
  import('@features/home').then((m) => ({ default: m.StartupPage }))
);
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
 * Persist the current route so the StartupPage can restore it on the next
 * launch or re-show. Skips `/` (the startup loader) and `/setup` (onboarding)
 * so we never auto-return to either transient page.
 */
function LastRouteMemory() {
  const location = useLocation();

  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '/setup') return;
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
  const location = useLocation();

  useEffect(() => {
    function isEditable(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    }

    function handler(e: KeyboardEvent) {
      if (isEditable(e.target)) return;

      // Esc — back out of Settings to home; otherwise hide to tray.
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (location.pathname.startsWith('/settings')) {
          navigate('/app');
        } else {
          invokeCommand<void>('hide_main_window').catch(() => {});
        }
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
  }, [navigate, location.pathname]);

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
      <LastRouteMemory />
      <WindowKeyboardShortcuts />
      <BackendNavigationBridge />
      <CommandPalette />
      <CheatSheet />
      <Changelog />
      <HowItWorks />
      <Routes>
        <Route path="/" element={<StartupPage />} />
        <Route path="/app" element={<HomePage />} />
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
