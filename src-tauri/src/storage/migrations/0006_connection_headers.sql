-- Optional custom HTTP headers per connection. Stored as a JSON object
-- string: `{"HTTP-Referer": "https://vibeprompter.app", "X-Title": "VibePrompter"}`.
-- Empty/null means "no extra headers" — same as before the column existed.
--
-- Why a JSON blob instead of a child table? Headers are read together with
-- the row 100% of the time and never queried by name, so a JOIN buys nothing.

ALTER TABLE provider_connections ADD COLUMN extra_headers TEXT NOT NULL DEFAULT '';
