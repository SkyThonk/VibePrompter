-- Per-connection pricing override. When non-zero, takes precedence over
-- the embedded `services/pricing.rs` table for any run through this
-- connection. Lets users:
--   1. Set accurate prices for models the embedded table doesn't know about
--      (new releases, niche vendors, custom proxies).
--   2. Reflect negotiated enterprise rates.
--   3. Pin a $0 rate to a paid endpoint they're testing free credits on,
--      so the dashboard cost widget doesn't double-count.
--
-- Stored as USD per million tokens to match the embedded table's units.
-- `0` means "fall back to the embedded table"; that's the default for
-- existing rows and new rows that haven't been edited.
ALTER TABLE provider_connections
  ADD COLUMN price_input_per_m  REAL NOT NULL DEFAULT 0;
ALTER TABLE provider_connections
  ADD COLUMN price_output_per_m REAL NOT NULL DEFAULT 0;
