-- User-owned API connections. Separate from the static `providers` catalog
-- which is design/UX metadata; this is where real keys + base URLs live.
--
-- `kind` is a small enum: 'openai' (any OpenAI-compatible endpoint — OpenAI
-- itself, OpenRouter, Groq, Mistral, DeepSeek, Together, Gemini-compat,
-- Ollama, LM Studio, vLLM, llama.cpp) or 'anthropic' (native Anthropic API).
-- Adding a new vendor doesn't require shipping a new app version — the user
-- just types in a `base_url` + `api_key` + arbitrary `default_model`.

CREATE TABLE provider_connections (
    id            TEXT PRIMARY KEY NOT NULL,
    label         TEXT NOT NULL,
    kind          TEXT NOT NULL,                     -- 'openai' | 'anthropic'
    base_url      TEXT NOT NULL,
    api_key       TEXT NOT NULL DEFAULT '',
    default_model TEXT NOT NULL DEFAULT '',
    is_default    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- A single connection is "the default" at any time. Enforced at the app
-- layer because SQLite doesn't support partial unique indexes that gracefully
-- handle the "no default exists yet" case.
CREATE INDEX idx_provider_connections_default
    ON provider_connections (is_default);
