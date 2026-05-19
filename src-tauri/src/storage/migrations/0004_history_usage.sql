-- Vendor-reported token counts per history row. NULL/zero is legitimate:
-- some OpenAI-compat servers don't return `usage`, and a cancelled stream
-- may finish before the totals chunk arrived. Existing rows backfill as 0
-- via the column default; UI treats 0 as "unknown".

ALTER TABLE history ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE history ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
