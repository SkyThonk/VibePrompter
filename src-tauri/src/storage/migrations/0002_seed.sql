-- Seed data. INSERT OR IGNORE keeps this idempotent.

INSERT OR IGNORE INTO providers (id, display_name, enabled, default_model, base_url, extra, created_at, updated_at) VALUES
 ('openai',    'OpenAI',        1, 'gpt-4.1',                       NULL,                     '{"accent":"var(--openai)","local":false}',    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('anthropic', 'Anthropic',     1, 'claude-3-5-sonnet-20241022',    NULL,                     '{"accent":"var(--anthropic)","local":false}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('gemini',    'Google Gemini', 1, 'gemini-2.0-pro',                NULL,                     '{"accent":"var(--gemini)","local":false}',    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('ollama',    'Ollama',        1, 'llama3.1:8b',                   'http://localhost:11434', '{"accent":"var(--ollama)","local":true}',     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

INSERT OR IGNORE INTO prompt_modes (id, name, description, system_prompt, temperature, max_tokens, provider_override, icon_name, is_default, sort_order, created_at, updated_at) VALUES
 ('developer', 'Developer',     'Improves technical clarity for developers', 'You are a senior software engineer. Rewrite the input to be technically precise, unambiguous, and idiomatic. Preserve all code identifiers exactly. Prefer active voice. Keep it concise — do not add commentary.', 0.3, 1024, NULL, 'code',    1, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('email',     'Email',         'Professional email reply',                  'You write clear, courteous business emails. Match the tone of the source message. Open with a one-line greeting, deliver the message in 2-3 short paragraphs, close warmly.',                                                              0.5, 800,  NULL, 'mail',    0, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('friendly',  'Friendly',      'Warm, casual tone',                         'Rewrite the input to sound like a thoughtful friend. Use contractions, light humor where it fits, and keep it warm. Avoid formality.',                                                                                                       0.7, 600,  NULL, 'friendly',0, 2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('concise',   'Concise',       'Tighter, fewer words',                      'Cut the input to its essential message in 50% or fewer words. Preserve every concrete fact. No filler.',                                                                                                                                  0.2, 400,  NULL, 'shorten', 0, 3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('technical', 'Technical',     'Academic and formal',                       'Rewrite in academic register. Use precise terminology. Hedge claims appropriately. Cite implied premises explicitly.',                                                                                                                       0.3, 1200, NULL, 'formal',  0, 4, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('docs',      'Documentation', 'API & technical docs',                      'You write developer documentation. Lead with what the thing does, then how to use it. Use code fences for snippets. Avoid marketing language.',                                                                                            0.2, 1500, NULL, 'text',    0, 5, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

INSERT OR IGNORE INTO shortcuts (id, label, hint, icon_name, accelerator, action, enabled, sort_order, updated_at) VALUES
 ('palette', 'Open Command Palette', 'The main entry point.',      'wand',      'Ctrl+Alt+Space',   'open_palette',     1, 0, '2026-01-01T00:00:00Z'),
 ('rewrite', 'Rewrite selection',    'Improve writing in place.',  'pen',       'Ctrl+Alt+R',       'rewrite_selection',1, 1, '2026-01-01T00:00:00Z'),
 ('grammar', 'Fix grammar',          'Quick grammar pass.',        'text',      'Ctrl+Alt+G',       'fix_grammar',      1, 2, '2026-01-01T00:00:00Z'),
 ('summary', 'Quick summarize',      'Compress to bullets.',       'summarize', 'Ctrl+Alt+S',       'summarize',        1, 3, '2026-01-01T00:00:00Z'),
 ('modes',   'Toggle modes',         'Cycle the active mode.',     'layers',    'Ctrl+Alt+M',       'mode_switch',      1, 4, '2026-01-01T00:00:00Z');

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
 ('boot_start',         'true',      '2026-01-01T00:00:00Z'),
 ('minimize_to_tray',   'true',      '2026-01-01T00:00:00Z'),
 ('quit_on_close',      'false',     '2026-01-01T00:00:00Z'),
 ('auto_paste',         'true',      '2026-01-01T00:00:00Z'),
 ('notifications',      'true',      '2026-01-01T00:00:00Z'),
 ('stream_response',    'true',      '2026-01-01T00:00:00Z'),
 ('clipboard_fallback', 'false',     '2026-01-01T00:00:00Z'),
 ('low_memory_mode',    'false',     '2026-01-01T00:00:00Z'),
 ('response_timeout',   '30',        '2026-01-01T00:00:00Z'),
 ('concurrent_requests','3',         '2026-01-01T00:00:00Z'),
 ('theme',              '"light"',   '2026-01-01T00:00:00Z'),
 ('accent',             '"violet"',  '2026-01-01T00:00:00Z'),
 ('density',            '"regular"', '2026-01-01T00:00:00Z'),
 ('history_retention',  '"30d"',     '2026-01-01T00:00:00Z'),
 ('dev_tools',          'false',     '2026-01-01T00:00:00Z'),
 ('log_raw_responses',  'false',     '2026-01-01T00:00:00Z'),
 ('proxy_url',          '""',        '2026-01-01T00:00:00Z');
