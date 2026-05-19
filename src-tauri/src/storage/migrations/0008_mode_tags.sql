-- Tags for prompt modes: free-text comma-separated. Keeps the schema
-- simple (no join table) and matches how users describe their own modes
-- ("writing, casual"). Empty string = untagged.
--
-- Seed tags on the built-in modes so the filter is useful out of the box.

ALTER TABLE prompt_modes ADD COLUMN tags TEXT NOT NULL DEFAULT '';

UPDATE prompt_modes SET tags = 'writing' WHERE id IN ('email', 'friendly');
UPDATE prompt_modes SET tags = 'writing,utility' WHERE id IN ('concise', 'docs');
UPDATE prompt_modes SET tags = 'code' WHERE id = 'developer';
UPDATE prompt_modes SET tags = 'utility' WHERE id = 'brainstorm';
