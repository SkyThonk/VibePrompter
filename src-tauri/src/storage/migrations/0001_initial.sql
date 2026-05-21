-- VibePrompter foundation schema — single consolidated migration.
--
-- Every table, index, and seed row lives here. This is the authoritative
-- starting state for all fresh installs. There are no follow-on migration
-- files; future schema changes will be added as new numbered files.

-- ──────────────────────────────────────────────────────────────────── tables

CREATE TABLE settings (
    key        TEXT PRIMARY KEY NOT NULL,
    value      TEXT NOT NULL,           -- JSON-encoded scalar
    updated_at TEXT NOT NULL
);

CREATE TABLE providers (
    id            TEXT PRIMARY KEY NOT NULL,
    display_name  TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    default_model TEXT NOT NULL,
    base_url      TEXT,
    extra         TEXT NOT NULL DEFAULT '{}',  -- JSON
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE prompt_modes (
    id                TEXT PRIMARY KEY NOT NULL,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL,
    system_prompt     TEXT NOT NULL,
    temperature       REAL NOT NULL DEFAULT 0.5,
    max_tokens        INTEGER NOT NULL DEFAULT 1024,
    provider_override TEXT,
    icon_name         TEXT NOT NULL,
    -- JSON object of `{ "var_name": "default_value" }`. Substituted into
    -- the system_prompt at call time wherever `{{var_name}}` appears.
    -- Empty `{}` when the mode has no variables. NOT NULL DEFAULT keeps
    -- the value safe through every code path that constructs a mode.
    variables         TEXT NOT NULL DEFAULT '{}',
    enabled           INTEGER NOT NULL DEFAULT 1,
    is_system         INTEGER NOT NULL DEFAULT 0,
    is_default        INTEGER NOT NULL DEFAULT 0,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE TABLE history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    mode_name      TEXT NOT NULL,
    icon_name      TEXT NOT NULL,
    provider_label TEXT NOT NULL,
    source_text    TEXT NOT NULL,
    output_text    TEXT NOT NULL,
    latency_ms     INTEGER NOT NULL DEFAULT 0,
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    -- Cost in micro-dollars (1 USD = 1_000_000 micros). Computed at record
    -- time from the model's pricing entry × token counts; 0 means "unknown"
    -- (local model, unrecognized model id, or vendor didn't return usage).
    cost_micros    INTEGER NOT NULL DEFAULT 0,
    favorite       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);
CREATE INDEX idx_history_created_at ON history (created_at DESC);

CREATE TABLE shortcuts (
    id          TEXT PRIMARY KEY NOT NULL,
    label       TEXT NOT NULL,
    hint        TEXT NOT NULL,
    icon_name   TEXT NOT NULL,
    accelerator TEXT NOT NULL,
    action      TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
);

CREATE TABLE analytics (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}',  -- JSON
    created_at TEXT NOT NULL
);
CREATE INDEX idx_analytics_created_at ON analytics (created_at DESC);

CREATE TABLE provider_connections (
    id            TEXT PRIMARY KEY NOT NULL,
    label         TEXT NOT NULL,
    kind          TEXT NOT NULL,                     -- 'openai' | 'anthropic'
    base_url      TEXT NOT NULL,
    api_key       TEXT NOT NULL DEFAULT '',
    default_model TEXT NOT NULL DEFAULT '',
    is_default    INTEGER NOT NULL DEFAULT 0,
    extra_headers TEXT NOT NULL DEFAULT '',
    last_used_at  TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    tags          TEXT NOT NULL DEFAULT '',  -- comma-separated, e.g. "work,gpt"
    -- Pricing override in USD per million tokens. 0 = use embedded table.
    price_input_per_m  REAL NOT NULL DEFAULT 0,
    price_output_per_m REAL NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX idx_provider_connections_default
    ON provider_connections (is_default);

-- ────────────────────────────────────────────────────────────────────── seed

INSERT OR IGNORE INTO providers (id, display_name, enabled, default_model, base_url, extra, created_at, updated_at) VALUES
 ('openai',    'OpenAI',        1, 'gpt-4.1',                       NULL,                     '{"accent":"var(--openai)","local":false}',    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('anthropic', 'Anthropic',     1, 'claude-3-5-sonnet-20241022',    NULL,                     '{"accent":"var(--anthropic)","local":false}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('gemini',    'Google Gemini', 1, 'gemini-2.0-pro',                NULL,                     '{"accent":"var(--gemini)","local":false}',    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('ollama',    'Ollama',        1, 'llama3.1:8b',                   'http://localhost:11434', '{"accent":"var(--ollama)","local":true}',     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

-- Prompt modes: 2 built-in (grammar, summarize) + 6 user-editable seeds.
-- Built-ins sit at the top via negative sort_order and have is_system=1 so
-- the UI hides Rename/Delete and the repo refuses delete attempts.
INSERT OR IGNORE INTO prompt_modes
  (id, name, description, system_prompt, temperature, max_tokens,
   provider_override, icon_name, enabled, is_system, is_default,
   sort_order, created_at, updated_at)
VALUES
 ('grammar',   'Grammar',       'Fix grammar, spelling, and punctuation without changing meaning.',
   'You are a meticulous copy editor. Correct grammar, spelling, punctuation, and obvious typos in the user''s text.

Hard rules:
- Preserve the exact meaning, tone, voice, register, language, and intent of the original.
- Preserve sentence boundaries, paragraph structure, line breaks, lists, code blocks, URLs, numbers, names, and any markup or punctuation that was clearly intentional.
- Do NOT rewrite for style, conciseness, or clarity. If a sentence is awkward but grammatical, leave it.
- If the input is already correct, return it unchanged.
- Output ONLY the corrected text — no preamble, no explanation, no surrounding quotes, no markdown fences.',
   0.1, 2048, NULL, 'pen',       1, 1, 0, -2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('summarize', 'Summarize',     'Tight bulleted summary of the most important points.',
   'You produce concise, faithful summaries.

How to summarize:
- Read the user''s text in full before writing anything.
- Identify the most important facts, claims, decisions, or actions — not stylistic flourishes.
- Output a bulleted list using "- " markers, one idea per bullet, each bullet under 20 words.
- Preserve every concrete fact: names, numbers, dates, conclusions. Drop adjectives, hedging, and filler.
- If the input is shorter than ~3 sentences, summarize in one bullet rather than padding.
- Do not add information not present in the input. Do not editorialize.
- Output ONLY the bullets — no title, no preamble, no closing remarks.',
   0.2, 1024, NULL, 'summarize', 1, 1, 0, -1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('developer', 'Developer',     'Sharpen prompts for AI agents with minimal targeted edits.',
   'You are a prompt engineer reviewing a draft prompt for an AI model. Make the minimum targeted edits needed to improve clarity and precision — do not restructure, expand, or rewrite unless the draft is genuinely unclear.

How to edit:
- Replace ambiguous or vague phrasing with precise wording that carries the same intent.
- Fix inconsistent verb tense (prefer imperative: "Return …" not "You should return …").
- Make an implicit output format explicit only when it is clearly implied and its absence would cause confusion.

Hard rules:
- Preserve the existing structure, order, and length of the draft. Do not add sections, headers, or numbered steps the draft does not already have.
- Do not add constraints, behavior, topics, or context the draft did not ask for.
- Do not add or change a persona or role.
- Never modify code blocks, XML/HTML tags, JSON structures, template variables ({{var}}, {var}, <PLACEHOLDER>), or embedded examples — these are part of the specification.
- If the draft is already clear and complete, return it with minor wording polish only, or unchanged.
- Output ONLY the improved prompt — no preamble, no explanation, no surrounding quotes.',
   0.4, 2048, NULL, 'code',      1, 0, 1,  0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('email',     'Email',         'Clear, courteous business emails.',
   'You rewrite the input as a clear, courteous business email or email reply.

Structure:
- Open with a one-line greeting that matches the relationship implied by the input (e.g. "Hi Sarah," for first names, "Hello," for unknown recipients).
- Deliver the message in 1–3 short paragraphs. One idea per paragraph.
- Close with a brief, warm sign-off line (e.g. "Thanks," / "Best,") — pick what matches the tone of the body.

Tone:
- Professional but human. No corporate jargon ("circle back", "synergize"). No emojis.
- Match the formality level the input implies. If the input is curt, keep the reply efficient; if the input is warm, mirror that warmth.

Hard rules:
- Preserve the names, dates, deliverables, and decisions in the input exactly.
- Do not invent specifics that were not in the input.
- Output ONLY the email body — no subject line unless the input asks for one, no commentary.',
   0.5,  900, NULL, 'mail',      1, 0, 0,  1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('friendly',  'Friendly',      'Warm, conversational tone for casual messages.',
   'You rewrite the input to sound like it''s coming from a thoughtful friend — warm, conversational, and easy to read.

How:
- Use contractions ("you''re", "don''t", "it''s") and natural sentence rhythm.
- Light, situation-appropriate humor is welcome when it fits; never forced.
- Cut formality (drop "Per my last email", "I am writing to inform you", etc.).
- Keep it short and direct. Long, friendly messages feel performative.

Hard rules:
- Preserve every concrete fact, name, and decision in the input.
- Stay professional enough for a workplace channel (Slack, Teams, work email). No slang that would be inappropriate at work, no profanity.
- Output ONLY the rewritten text — no preamble, no commentary.',
   0.7,  700, NULL, 'friendly',  1, 0, 0,  2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('concise',   'Concise',       'Same meaning, half the words.',
   'You shorten the user''s text so it conveys the same information in roughly half the words (or fewer if you can do it cleanly).

How:
- Cut filler: "in order to" → "to", "the fact that" → "that", "at this point in time" → "now".
- Cut hedges that add no information: "I think maybe", "sort of", "it seems like".
- Merge sentences when one shorter sentence carries both ideas.
- Replace long phrases with single precise words when the meaning is identical.

Hard rules:
- Preserve every concrete fact: names, numbers, dates, conclusions.
- Preserve the original tone (formal stays formal, casual stays casual).
- Do not change the meaning. Do not add caveats the original did not have.
- Output ONLY the shortened text — no preamble, no commentary.',
   0.2,  500, NULL, 'shorten',   1, 0, 0,  3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('technical', 'Technical',     'Formal academic register for reports and papers.',
   'You rewrite the input in a formal academic register suitable for reports, papers, and technical documentation.

How:
- Use precise terminology native to the domain implied by the input.
- Prefer the passive or impersonal voice only when it improves clarity; otherwise active voice with a concrete subject.
- Hedge claims appropriately ("appears to", "is consistent with") only where the evidence in the input warrants it.
- Make implicit premises explicit when doing so removes ambiguity.
- Avoid contractions, idioms, and conversational openers.

Hard rules:
- Preserve every fact, name, citation, equation, and number exactly.
- Do not introduce claims not supported by the input. Do not add citations.
- Output ONLY the rewritten text — no preamble, no abstract, no commentary.',
   0.3, 1500, NULL, 'formal',    1, 0, 0,  4, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('docs',      'Documentation', 'API reference and how-to documentation.',
   'You rewrite the input as developer-facing documentation (API reference, how-to guide, or reference snippet).

Structure (use whichever sections apply):
- Lead with one sentence describing WHAT the thing does — concrete, no marketing.
- Then HOW to use it: minimal code example in a fenced ``` block, with the language tag matching the example.
- Then PARAMETERS / OPTIONS as a list if applicable, each line: `name` (type) — what it controls.
- Then RETURNS / RAISES / SIDE EFFECTS only if relevant.
- Then a NOTES section only for caveats a reader would otherwise hit.

Style:
- Imperative, present tense ("Returns the parsed URL", not "Will return").
- No marketing language ("blazing-fast", "powerful"), no first-person, no rhetorical questions.
- Code examples must be copy-pasteable and use realistic placeholder names.

Hard rules:
- Preserve identifiers, types, and signatures from the input exactly.
- Do not invent parameters, return values, or behavior the input does not describe.
- Output ONLY the documentation — no preamble.',
   0.2, 1800, NULL, 'text',      1, 0, 0,  5, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

-- Global shortcuts. Accelerators reflect the current defaults.
INSERT OR IGNORE INTO shortcuts (id, label, hint, icon_name, accelerator, action, enabled, sort_order, updated_at) VALUES
 ('palette', 'Open Command Palette', 'The main entry point.',      'wand',      'Ctrl+Alt+V',     'open_palette',      1, 0, '2026-01-01T00:00:00Z'),
 ('rewrite', 'Rewrite selection',    'Improve writing in place.',  'pen',       'Ctrl+Alt+F',     'rewrite_selection', 1, 1, '2026-01-01T00:00:00Z'),
 ('grammar', 'Fix grammar',          'Quick grammar pass.',        'text',      'Ctrl+Alt+G',     'fix_grammar',       1, 2, '2026-01-01T00:00:00Z'),
 ('summary', 'Quick summarize',      'Compress to bullets.',       'summarize', 'Ctrl+Alt+S',     'summarize',         1, 3, '2026-01-01T00:00:00Z'),
 ('modes',   'Toggle modes',         'Cycle the active mode.',     'layers',    'Ctrl+Alt+M',     'mode_switch',       1, 4, '2026-01-01T00:00:00Z');

-- Default settings. Dead keys (`auto_paste`, `clipboard_fallback`,
-- `low_memory_mode`, `concurrent_requests`) that previous migrations dropped
-- are simply not seeded here.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
 ('boot_start',         'true',      '2026-01-01T00:00:00Z'),
 ('minimize_to_tray',   'true',      '2026-01-01T00:00:00Z'),
 ('quit_on_close',      'false',     '2026-01-01T00:00:00Z'),
 ('notifications',      'true',      '2026-01-01T00:00:00Z'),
 ('stream_response',    'true',      '2026-01-01T00:00:00Z'),
 ('response_timeout',   '30',        '2026-01-01T00:00:00Z'),
 ('theme',              '"system"',  '2026-01-01T00:00:00Z'),
 ('accent',             '"violet"',  '2026-01-01T00:00:00Z'),
 ('density',            '"regular"', '2026-01-01T00:00:00Z'),
 ('history_retention',  '"30d"',     '2026-01-01T00:00:00Z'),
 ('dev_tools',          'false',     '2026-01-01T00:00:00Z'),
 ('log_raw_responses',  'false',     '2026-01-01T00:00:00Z'),
 ('proxy_url',          '""',        '2026-01-01T00:00:00Z');
