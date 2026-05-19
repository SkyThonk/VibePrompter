-- Drop seeded-but-dead settings rows that no longer correspond to any
-- behavior. Keeping them around would invite a future regression where
-- someone adds a UI toggle wired to a key that already exists but has no
-- backend behind it (the prior failure mode that motivated this cleanup).
--
-- Safe on a fresh install: rows that aren't there are a no-op DELETE.

DELETE FROM settings WHERE key IN (
    'auto_paste',
    'clipboard_fallback',
    'low_memory_mode'
);
