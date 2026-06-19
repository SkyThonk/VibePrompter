# Tweak history threading + conversation context — design

**Date:** 2026-06-17
**Status:** Approved, pending implementation plan

## Problem

The refine overlay's **Tweak** (followup) feature has two defects:

1. **Disconnected history.** Each tweak records a brand-new top-level history row
   (`"<mode> · tweak"`, source `"[Tweak: <instr>]\n\n<original>"`) via
   `history.record(...)` in `run_followup_stream`
   ([overlay/mod.rs:789](../../../src-tauri/src/overlay/mod.rs)). The `history`
   table is flat, so a tweak appears in the History panel as an entry unrelated
   to the refine it came from.

2. **Loose loop context.** Each tweak rebuilds the conversation as exactly
   `[user: original, assistant: last_result, user: instruction]`. The original
   *is* sent (contrary to first impression), but the conversation only ever
   carries the original + the single most-recent result. Across multiple tweaks
   the earlier instructions and intermediate results are discarded, so the model
   loses the refinement trajectory.

## Decisions (from brainstorming)

- **History model:** Thread tweaks under the original refine (parent/child).
- **Tweak context:** Send original + **all instructions** + latest result; drop
  intermediate outputs (instructions are cheap, full outputs are the token cost).

## Design

### 1. Schema — new migration `0002_history_threads.sql`

```sql
ALTER TABLE history ADD COLUMN parent_id INTEGER REFERENCES history(id) ON DELETE CASCADE;
CREATE INDEX idx_history_parent ON history (parent_id);
```

- `NULL` = top-level refine (thread root); non-null = a tweak pointing at its root.
- Foreign keys are already enabled (`pool.rs` `.foreign_keys(true)`), so
  `ON DELETE CASCADE` removes a root's tweaks when the root is deleted or purged —
  no dangling threads.
- ADD COLUMN with a NULL default is a safe, idempotent migration; existing rows
  become roots.

### 2. Backend data layer

- `NewHistoryItem` and `HistoryItem` gain `parent_id: Option<i64>` (read DTO serde
  rename `parentId`).
- `HistoryRepo::insert` binds `parent_id`.
- `HistoryRepo::list` returns **top-level only** (`WHERE parent_id IS NULL`), so the
  left list and limit/offset pagination page over refines, not over every tweak.
  Existing `ORDER BY favorite DESC, created_at DESC, id DESC` is preserved.
- New `HistoryRepo::children_of(parent_id) -> Vec<HistoryItem>` ordered
  `created_at ASC, id ASC` (oldest-first = chronological thread).
- Cost/aggregate queries (`cost_by_day`, `cost_summary`, `cost_by_connection`,
  `count`) stay over **all** rows — tweaks are real billable runs and must count.
- `HistoryService` exposes `children_of`. New IPC command
  `get_history_children { parentId } -> HistoryItem[]`.

### 3. Overlay session — the bug fix

`RefineSession` gains:

- `root_history_id: Mutex<Option<i64>>` — id of the thread root. Set when
  `run_stream` records the initial refine (the returned id is currently
  discarded; capture it instead). Reset to `None` at the start of `run_stream`
  (covers both `begin` and `retry`).
- `instructions: Mutex<Vec<String>>` — running list of tweak instructions; reset
  to empty alongside the root. Cleared in `clear_session`.

`run_stream` (initial refine / retry):
- At entry, reset `instructions = []` and `root_history_id = None`.
- On successful `history.record(...)`, store the returned id into
  `root_history_id`.

`run_followup_stream` (tweak):
- **Context.** Build messages with strictly alternating roles:
  ```
  user:      <original selection>
  assistant: <latest result>            // session.last_result
  user:      <followup user turn>
  ```
  where `<followup user turn>` is produced by a pure helper:
  ```
  build_followup_user_turn(prior_instructions: &[String], new_instruction: &str) -> String
  ```
  - No prior instructions → returns `new_instruction` verbatim.
  - With prior instructions → returns a preamble listing them in order followed
    by the new instruction, e.g.:
    ```
    Already applied, in order:
    - make it formal
    - shorten the intro

    Now apply: translate to Spanish
    ```
  This keeps every instruction in context, keeps roles alternating (valid for
  both OpenAI and Anthropic), and omits intermediate outputs.
- **History.** Record the tweak as a child:
  `parent_id = root_history_id`, `source_text = <new_instruction>`,
  `output_text = <result>`, `mode_name`/`icon` = same kind-aware values as today
  (no `"· tweak"` suffix needed — nesting conveys it). If `root_history_id` is
  `None` (defensive: tweak before any root recorded), fall back to recording a
  normal top-level row.
- On success, push `new_instruction` onto `session.instructions` and update
  `last_result` (as today).

Max-token estimation stays as-is (the existing `effective_max_tokens` /
large-selection logic already bounds growth).

### 4. Frontend — HistoryPanel

- `HistoryItem` TS type gains optional `parentId?: number | null`.
- Left list unchanged (backend returns roots only).
- On selecting an entry, fetch `get_history_children(parentId = current.id)` and,
  when non-empty, render a **conversation thread** in the detail pane:
  Original → Result, then each tweak as *instruction → result* in chronological
  order. A small "N tweaks" pill marks threaded entries.
- Existing single-entry rendering is the zero-children case.

## Testing (TDD)

Rust (verifiable via `cargo build`; note the tauri lib test exe cannot launch in
the current dev environment — see project memory — so pure logic is also checked
with a standalone `rustc` snippet):

- `HistoryRepo`: `insert` with `parent_id` round-trips; `list` excludes children;
  `children_of` returns children oldest-first; deleting a root cascades to
  children.
- `build_followup_user_turn`: no-prior case returns the instruction unchanged;
  multi-prior case lists prior instructions in order and appends the new one.

Frontend: type-level change; manual verification of the thread rendering.

## Out of scope

- Retry already records a fresh top-level row per run (pre-existing). Unchanged;
  tweaks attach to whichever root is current.
- No backfill of historical `"· tweak"` rows into threads — old rows remain
  top-level.
