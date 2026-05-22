import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoadingSpinner } from '@shared/ui';
import { invokeCommand } from '@kernel/infrastructure/tauri';

/**
 * Entry-point route (`/`). Displayed for at most one frame — it immediately
 * decides where to send the user:
 *
 *   - First run (no `first_run_done` flag + no connections) → `/setup`
 *   - Returning user → restore `last_route` KV, or fall back to `/app`
 *   - Backend unavailable → `/app` (never force onboarding on transient errors)
 *
 * `show_main_window` in the backend emits `navigate /` whenever the window
 * transitions from hidden to visible, so this page re-runs its decision on
 * every re-show — preventing a stale `/setup` route from persisting after a
 * hide-to-tray session.
 */
export function StartupPage() {
  const navigate = useNavigate();

  useEffect(() => {
    invokeCommand<boolean>('check_first_run')
      .then((shouldOnboard) => {
        if (shouldOnboard) {
          navigate('/setup', { replace: true });
          return;
        }
        return invokeCommand<string | null>('get_kv', { key: 'last_route' }).then((raw) => {
          if (raw) {
            try {
              const path = JSON.parse(raw) as unknown;
              if (typeof path === 'string' && path.startsWith('/') && path !== '/') {
                navigate(path, { replace: true });
                return;
              }
            } catch {
              /* malformed — fall through to /app */
            }
          }
          navigate('/app', { replace: true });
        });
      })
      .catch(() => {
        // Backend not available or transient error — go to the app, not onboarding.
        navigate('/app', { replace: true });
      });
  }, [navigate]);

  return <LoadingSpinner fullScreen />;
}
