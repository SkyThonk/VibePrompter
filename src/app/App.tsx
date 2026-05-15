import { getCurrentWindow } from '@tauri-apps/api/window';
import { AppProviders } from './providers';
import { AppRouter } from './router';
import { BackendThemeBridge } from './BackendThemeBridge';
import { ModeHud } from '@features/overlay-hud';

/**
 * Read the current Tauri window label. In multi-window Tauri apps every
 * window mounts the same React bundle; the label is what distinguishes them.
 * Outside Tauri (raw `vite dev` in a browser), defaults to 'main'.
 *
 * Computed once at module load so the React tree mounts directly into the
 * right shell without flashing the wrong one first.
 */
function readWindowLabel(): string {
  try {
    return getCurrentWindow().label || 'main';
  } catch {
    return 'main';
  }
}

const WINDOW_LABEL = readWindowLabel();

/**
 * App composition root. Selects the top-level shell based on Tauri window label:
 *   - `mode-hud`  → transparent always-on-top HUD (no providers, no router)
 *   - everything else → main app shell (providers + router)
 */
export function App() {
  if (WINDOW_LABEL === 'mode-hud') {
    return <ModeHud />;
  }
  return (
    <AppProviders>
      <BackendThemeBridge />
      <AppRouter />
    </AppProviders>
  );
}
