-- History threading: a tweak/followup is a child of the refine it came from.
--
-- `parent_id` is NULL for top-level refines (thread roots) and points at the
-- root row's id for each tweak. Foreign keys are enabled on the pool, so
-- ON DELETE CASCADE removes a root's tweaks when the root is deleted or purged
-- by retention — no dangling threads. Adding a NULL-default column is a safe,
-- idempotent change; every pre-existing row becomes a root.

ALTER TABLE history ADD COLUMN parent_id INTEGER REFERENCES history(id) ON DELETE CASCADE;
CREATE INDEX idx_history_parent ON history (parent_id);
