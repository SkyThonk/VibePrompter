-- Track when each connection was last used for a successful completion.
-- Sorts the providers list by recency, and gives the user a "stale
-- connection" hint when a default hasn't been used in a long while.
--
-- Stored as RFC3339 string for consistency with other timestamp columns.
-- Empty string means "never used" — sorts last under any non-empty value.

ALTER TABLE provider_connections ADD COLUMN last_used_at TEXT NOT NULL DEFAULT '';
