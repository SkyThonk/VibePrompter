-- Free-text notes per connection. Use case: "Personal account — rate limit
-- doubled on Nov 12", "Work Anthropic — quota resets every Monday". Keeps
-- per-connection context attached to the row instead of in a separate
-- text file the user has to remember.

ALTER TABLE provider_connections ADD COLUMN notes TEXT NOT NULL DEFAULT '';
