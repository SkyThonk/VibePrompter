-- Swap the global accelerators for refine overlay and open-palette.
-- New mapping: overlay → Ctrl+Alt+Space, open palette (main window) → Ctrl+Alt+V.
-- Only updates rows that still hold the *previous* defaults so user-customized
-- bindings are preserved.

UPDATE shortcuts
SET accelerator = 'Ctrl+Alt+V', updated_at = '2026-01-02T00:00:00Z'
WHERE id = 'palette' AND accelerator IN ('Ctrl+Alt+Space', 'Ctrl+Shift+Space');

UPDATE shortcuts
SET accelerator = 'Ctrl+Alt+Space', updated_at = '2026-01-02T00:00:00Z'
WHERE id = 'rewrite' AND accelerator IN ('Ctrl+Alt+R', 'Ctrl+Shift+R');
