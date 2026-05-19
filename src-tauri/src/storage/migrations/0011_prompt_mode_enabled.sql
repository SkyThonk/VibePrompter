-- Per-mode enabled flag. Disabled modes are hidden from the tray menu, the
-- dashboard mode list, and the `cycle_mode` rotation, but their definitions
-- (system prompt, sampling settings, pinned provider) are preserved so the
-- user can re-enable them later without losing work.

ALTER TABLE prompt_modes
  ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
