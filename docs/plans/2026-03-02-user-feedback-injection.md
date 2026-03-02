# User Feedback Injection & Per-Reviewer Instructions — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Two related features — (A) inject one-shot ad-hoc feedback on any task at any time, targeted at coder / reviewer / all, with an optional override directive; and (B) configure persistent per-reviewer focus instructions (per-project or global) shown in the AI settings panel.

**Architecture:** Feature A uses a new `task_feedback` DB table with per-agent delivery tracking; feedback is injected at prompt-build time via a transaction-wrapped fetch+mark. Feature B stores instructions in the existing SteroidsConfig reviewer config and injects them into every reviewer prompt.

**Tech Stack:** SQLite (better-sqlite3), TypeScript, React, Express

---

## Problem Statement

There is no way to inject ad-hoc guidance into a running task without going through the full rejection/dispute cycle. The user also cannot tell a specific reviewer to focus on particular concerns without editing config files manually.

---

## Current Behavior

- Feedback to agents is only possible via `steroids tasks reject --notes` or `steroids tasks approve --notes`; neither is injected into the next reviewer or coder prompt.
- `tasks.description` column exists in schema but is unused everywhere.
- Prompt contexts (`CoderPromptContext`, `ReviewerPromptContext`) have no user-feedback or custom-instructions field.
- `queries.ts` is 1744 lines; `API/src/routes/tasks.ts` is 1372 lines; `reviewer.ts` is 637 lines — all over 500-line limit. New code must go in new files.
- Reviewer config in `SteroidsConfig` (`src/config/loader.ts`) has no `customInstructions` field.

---

## Desired Behavior

### Feature A — Task Feedback

1. Task detail page shows a **User Feedback** panel:
   - Textarea (max 4000 chars)
   - Dropdown: **Coder** | **Reviewer** | **All**
   - Checkbox: **Override** (user mandate — best-effort directive)
   - Submit / Delete buttons, pending list
2. On next invocation of the targeted agent, feedback is injected prominently in the prompt.
3. Override feedback adds a compliance directive. **Important:** this is best-effort — the reviewer LLM retains judgment to reject on genuine critical regressions. It is not a mechanical bypass.
4. Feedback is marked delivered atomically with fetch, before provider invocation. If provider crashes after marking, user must resubmit.
5. CLI: `steroids tasks feedback <id> "body" [--target coder|reviewer|all] [--override]`

### Feature B — Per-Reviewer Custom Instructions

1. AI settings panel has an expandable "Focus Instructions" textarea under each reviewer entry.
2. Instructions are stored in reviewer config (`SteroidsConfig`) — per-project or global depending on where the reviewer is configured.
3. On every reviewer invocation for that reviewer, instructions are injected into the prompt as a dedicated section.
4. Empty instructions = no injection (no-op).

---

## Design — Feature A (Task Feedback)

### A1. New table: `task_feedback`

```sql
CREATE TABLE IF NOT EXISTS task_feedback (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id               TEXT    NOT NULL REFERENCES tasks(id),
    body                  TEXT    NOT NULL CHECK(length(body) <= 4000),
    target                TEXT    NOT NULL CHECK(target IN ('coder', 'reviewer', 'all')),
    is_override           INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    delivered_coder_at    TEXT,
    delivered_reviewer_at TEXT
);

-- Required indexes (consistent with codebase pattern):
CREATE INDEX IF NOT EXISTS idx_task_feedback_task
    ON task_feedback(task_id);

CREATE INDEX IF NOT EXISTS idx_task_feedback_pending_coder
    ON task_feedback(task_id, delivered_coder_at)
    WHERE delivered_coder_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_task_feedback_pending_reviewer
    ON task_feedback(task_id, delivered_reviewer_at)
    WHERE delivered_reviewer_at IS NULL;
```

**Delivery semantics:**
- Coder picks: `target IN ('coder','all') AND delivered_coder_at IS NULL`
- Reviewer picks: `target IN ('reviewer','all') AND delivered_reviewer_at IS NULL`
- `target='all'` → both columns tracked independently; row remains visible in pending list until both are delivered

### A2. Migration entry

The codebase uses `autoMigrate()` and tracks applied migrations in `_migrations`. Add a numbered entry to `INITIAL_SCHEMA_DATA` in `src/database/schema.ts`:

```typescript
{ id: 23, name: '023_add_task_feedback', checksum: 'builtin' }
```

(Verify the next migration ID by checking the last entry in `INITIAL_SCHEMA_DATA`.)

### A3. New file: `src/database/feedback-queries.ts`

```typescript
export interface UserFeedbackEntry {
  id: number;
  task_id: string;
  body: string;
  target: 'coder' | 'reviewer' | 'all';
  is_override: boolean;          // RUNTIME: cast from SQLite INTEGER — use `row.is_override !== 0`
  created_at: string;
  delivered_coder_at: string | null;
  delivered_reviewer_at: string | null;
}

// Internal row type as SQLite returns it:
interface FeedbackRow {
  id: number; task_id: string; body: string;
  target: 'coder' | 'reviewer' | 'all';
  is_override: number;   // 0 or 1
  created_at: string;
  delivered_coder_at: string | null;
  delivered_reviewer_at: string | null;
}

function toEntry(row: FeedbackRow): UserFeedbackEntry {
  return { ...row, is_override: row.is_override !== 0 };
}

// Queries — all use ORDER BY id ASC (id is autoincrement = insertion order)
export function getPendingFeedbackForCoder(db, taskId): UserFeedbackEntry[]
// WHERE task_id=? AND (target='coder' OR target='all') AND delivered_coder_at IS NULL ORDER BY id ASC

export function getPendingFeedbackForReviewer(db, taskId): UserFeedbackEntry[]
// WHERE task_id=? AND (target='reviewer' OR target='all') AND delivered_reviewer_at IS NULL ORDER BY id ASC

export function getPendingFeedbackForTask(db, taskId): UserFeedbackEntry[]
// All rows for API display, ORDER BY id ASC

export function createFeedback(db, taskId, body, target, isOverride): UserFeedbackEntry

// Mark-delivered: wrapped in transaction with the corresponding getPending* call
// (see orchestrator integration note below)
export function markFeedbackDeliveredToCoder(db, feedbackId): void
export function markFeedbackDeliveredToReviewer(db, feedbackId): void

// Delete: only allowed for rows where relevant delivered column is still NULL
// Returns boolean — false if already delivered (caller sends 409)
export function deleteFeedback(db, feedbackId, role: 'coder' | 'reviewer' | 'all'): boolean
```

### A4. Prompt context changes

**`src/prompts/coder.ts`** — `CoderPromptContext`:
```typescript
userFeedback?: UserFeedbackEntry[];
```

**`src/prompts/reviewer.ts`** — `ReviewerPromptContext`:
```typescript
userFeedback?: UserFeedbackEntry[];
```

**Also add to batch contexts:**
```typescript
// BatchCoderPromptContext (coder.ts)
userFeedback?: UserFeedbackEntry[];   // per-task entries if any; empty for most batch tasks

// BatchReviewerPromptContext (reviewer.ts)
userFeedback?: UserFeedbackEntry[];
```

### A5. New file: `src/prompts/feedback-prompt-helpers.ts`

```typescript
import type { UserFeedbackEntry } from '../database/feedback-queries.js';

export function formatUserFeedbackSection(
  entries: UserFeedbackEntry[],
  role: 'coder' | 'reviewer'
): string {
  if (!entries.length) return '';

  const overrides = entries.filter(e => e.is_override);
  const normal    = entries.filter(e => !e.is_override);

  let out = '\n---\n## User Feedback\n\n';

  if (overrides.length > 0) {
    out += `[USER OVERRIDE] The following instructions are mandatory directives from the user:\n\n`;
    for (const e of overrides) {
      out += `> ${e.body}\n\n`;
    }
    if (role === 'reviewer') {
      out += `Approve this task unless the current diff introduces a critical regression ` +
             `that breaks core production functionality (not pre-existing issues, not style).\n\n`;
    } else {
      out += `Implement exactly as instructed. This supersedes rejection history and coordinator guidance.\n\n`;
    }
  }

  if (normal.length > 0) {
    out += `The following feedback has been submitted by the user:\n\n`;
    for (const e of normal) {
      out += `- ${e.body}\n`;
    }
    out += '\n';
  }

  return out;
}
```

### A6. Orchestrator integration — CRITICAL: transaction requirement

**`src/orchestrator/coder.ts`:**

```typescript
// WRONG — race condition between fetch and mark:
const pending = getPendingFeedbackForCoder(db, taskId);
const prompt = generateCoderPrompt({ ...ctx, userFeedback: pending });
for (const e of pending) markFeedbackDeliveredToCoder(db, e.id);  // race window here

// CORRECT — single transaction:
const pending = withDatabase(projectPath, (db) => {
  return db.transaction(() => {
    const entries = getPendingFeedbackForCoder(db, taskId);
    for (const e of entries) markFeedbackDeliveredToCoder(db, e.id);
    return entries;
  })();
});
const prompt = generateCoderPrompt({ ...ctx, userFeedback: pending });
// Then invoke provider
```

**`src/orchestrator/reviewer.ts`** — same pattern.

**Prompt generation paths that MUST all receive `userFeedback`:**

| Function | File | Notes |
|----------|------|-------|
| `generateCoderPrompt` | `src/prompts/coder.ts` | Standard invocation |
| `generateResumingCoderPrompt` | `src/prompts/coder.ts` | Session resume with full context |
| `generateResumingCoderDeltaPrompt` | `src/prompts/coder.ts` | Delta for resumed session — **easy to miss** |
| `generateBatchCoderPrompt` | `src/prompts/coder.ts` | Batch mode — pass per-task entries |
| `generateReviewerPrompt` | `src/prompts/reviewer.ts` | Standard invocation |
| `generateResumingReviewerDeltaPrompt` | `src/prompts/reviewer.ts` | Delta for resumed session — **easy to miss** |
| `generateBatchReviewerPrompt` | `src/prompts/reviewer.ts` | Batch mode |

The delta prompts are the highest-risk omission — they are intentionally minimal, so an implementer might forget to add the user feedback section. The user feedback section MUST be injected in all seven paths.

**Injection position:**
- Coder: after task header, before rejection history (highest visibility)
- Reviewer: after task description, before diff instructions

### A7. API — new file `API/src/routes/feedback.ts`

```
POST   /api/tasks/:taskId/feedback        — body: { body, target, is_override }
GET    /api/tasks/:taskId/feedback        — returns { items: FeedbackApiEntry[] }
DELETE /api/tasks/:taskId/feedback/:id    — 409 if already delivered
```

**`FeedbackApiEntry` response shape:**
```typescript
interface FeedbackApiEntry {
  id: number;
  body: string;
  target: 'coder' | 'reviewer' | 'all';
  is_override: boolean;
  created_at: string;
  // Partial-delivery state (important for target='all'):
  pending_for: ('coder' | 'reviewer')[];  // which agents haven't seen it yet
}
```

Register router in `API/src/index.ts`.

### A8. Web UI — `WebUI/src/components/UserFeedbackPanel.tsx`

Panel renders:
- Textarea (max 4000 chars, character counter)
- `<select>`: Coder / Reviewer / All
- Checkbox: Override
- Submit (disabled while empty or loading)
- List of pending entries — show `pending_for` badges to indicate partial delivery
- Warning banner if task status is `completed` or `skipped`

Mount in `TaskDetailPage.tsx`: `<UserFeedbackPanel taskId={task.id} taskStatus={task.status} />`

### A9. CLI subcommand

```
steroids tasks feedback <id> "body" [--target coder|reviewer|all] [--override]
```

Default target: `all`. Add to `src/commands/tasks.ts` help text.

---

## Design — Feature B (Per-Reviewer Custom Instructions)

### B1. Config change — `src/config/loader.ts`

Add `customInstructions?: string` to the per-reviewer config type. Example:

```typescript
export interface ReviewerConfig {
  model: string;
  provider: string;
  // ... existing fields ...
  customInstructions?: string;  // Optional focus instructions, injected into every invocation
}
```

No DB change needed — this lives in `.steroids/config.json` (per-project) or the global config.

### B2. Prompt context — `src/prompts/reviewer.ts`

Add to `ReviewerPromptContext`:
```typescript
reviewerCustomInstructions?: string;
```

### B3. Prompt injection — `src/prompts/reviewer.ts`

In `generateReviewerPrompt()` and `generateResumingReviewerDeltaPrompt()`:

```typescript
if (context.reviewerCustomInstructions?.trim()) {
  prompt += `\n---\n## Reviewer Focus Instructions\n\n${context.reviewerCustomInstructions.trim()}\n\n`;
}
```

Inject after task description, before diff instructions (same position as user feedback, but user feedback takes priority and appears first).

Also inject in `generateResumingReviewerDeltaPrompt()` — same risk as user feedback delta omission.

### B4. Orchestrator — `src/orchestrator/reviewer.ts`

Load from config and pass to context:
```typescript
const config = loadConfig(projectPath);
const reviewerCfg = config.ai?.reviewers?.find(r => r.model === reviewerModel);
const reviewerCustomInstructions = reviewerCfg?.customInstructions;

context.reviewerCustomInstructions = reviewerCustomInstructions;
```

### B5. API — config save endpoint

The AI settings panel presumably already calls a config save endpoint when changing reviewer model/provider. Extend that endpoint to include `customInstructions` in the reviewer object. No new route needed if config save is already generic.

If no generic config save exists, add:
```
PATCH /api/config/reviewer/:reviewerIndex
Body: { customInstructions: string }
```

### B6. Web UI — AI settings panel

Locate the AI settings component (in `WebUI/src/` — find the settings/config panel). For each reviewer entry:

```tsx
<details>
  <summary>Focus Instructions</summary>
  <textarea
    placeholder="e.g. Focus on security vulnerabilities and input validation. Do not flag missing tests."
    value={reviewer.customInstructions ?? ''}
    onChange={e => updateReviewer(index, { customInstructions: e.target.value })}
    maxLength={2000}
  />
</details>
```

On save, persist via config API.

---

## Implementation Order

### Phase 1 — Database (Feature A, safe to land alone)

**Task 1.1:** Add `task_feedback` table + indexes + migration entry to `src/database/schema.ts`
**Task 1.2:** Create `src/database/feedback-queries.ts` with full typed CRUD + unit tests
**Task 1.3:** Verify: `initDatabase()` creates table; migration entry appears in `_migrations`

### Phase 2 — Prompt helpers (Feature A)

**Task 2.1:** Create `src/prompts/feedback-prompt-helpers.ts` with `formatUserFeedbackSection()` + unit tests (test override, non-override, mixed, empty)
**Task 2.2:** Add `userFeedback?` to `CoderPromptContext`; inject in ALL four coder prompt functions
**Task 2.3:** Add `userFeedback?` to `ReviewerPromptContext`; inject in ALL three reviewer prompt functions (including delta)
**Task 2.4:** Wire orchestrators — transaction-wrapped fetch+mark in both `coder.ts` and `reviewer.ts`

### Phase 3 — Config & reviewer instructions (Feature B)

**Task 3.1:** Add `customInstructions?` to `ReviewerConfig` in `src/config/loader.ts`
**Task 3.2:** Add `reviewerCustomInstructions?` to `ReviewerPromptContext`; inject in `generateReviewerPrompt` and `generateResumingReviewerDeltaPrompt`
**Task 3.3:** Load custom instructions in `src/orchestrator/reviewer.ts` and pass to context

### Phase 4 — API

**Task 4.1:** Create `API/src/routes/feedback.ts` (POST / GET / DELETE) with partial-delivery `pending_for` field
**Task 4.2:** Register feedback router
**Task 4.3:** Config save endpoint for reviewer `customInstructions` (or extend existing)

### Phase 5 — Web UI

**Task 5.1:** Create `WebUI/src/components/UserFeedbackPanel.tsx`
**Task 5.2:** Mount in `TaskDetailPage.tsx`
**Task 5.3:** Add Focus Instructions textarea to AI settings reviewer entries

### Phase 6 — CLI

**Task 6.1:** Add `feedback` subcommand to `src/commands/tasks.ts`
**Task 6.2:** Update help text

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Feedback submitted while task is actively running | Stored as pending; picked up on NEXT invocation |
| Multiple pending items for same target | All injected in `id` order (insertion order, not `created_at` — avoids same-second ambiguity) |
| `target='all'` — coder runs, reviewer not yet invoked | `delivered_coder_at` set; `delivered_reviewer_at` NULL; row stays in pending list with `pending_for: ['reviewer']` |
| Override + normal feedback in same batch | Override section first, normal second; override compliance directive applies |
| Task in terminal state (`completed`, `skipped`) | Warning banner in UI; feedback stored but never delivered unless task is restarted |
| Override on reviewer + active dispute | Override in prompt only; dispute system untouched; reviewer LLM follows override directive (best-effort) |
| Crash after mark-delivered | Feedback is gone; user must resubmit — this is the documented behavior |
| DELETE of already-delivered feedback | `deleteFeedback()` checks delivered column; API returns 409 |
| Session-resume delta path (coder or reviewer) | `userFeedback` MUST be injected in delta prompts too — see prompt function table |
| Batch mode invocation | Per-task feedback injected from `BatchCoderPromptContext.userFeedback` |
| Override — is it guaranteed? | No. The reviewer retains LLM judgment for genuine critical regressions. Override is a strong prompt directive, not a mechanical bypass. |
| Per-reviewer instructions + user feedback both present | Both injected; user feedback first (more immediate), reviewer instructions second |
| `customInstructions` whitespace-only | Not injected (use `.trim()` check) |
| `customInstructions` > 2000 chars | UI enforces max; API validates |

---

## Non-Goals

- Threaded conversations or reply chains.
- Feedback history/archive view beyond DB rows.
- Auto-redelivery on failure.
- Section-level feedback (only task-level).
- Modifying the dispute system.
- Mechanical enforcement of override (LLM retains final judgment).
- Custom instructions for coders (reviewer-only for now).
- Batch mode feedback injection as a separate tracked feature (batch mode piggybacks on the same context field; implementer handles at context-build time).

---

## File Line Count Audit (pre-implementation)

| File | Current Lines | Change | Plan |
|------|--------------|--------|------|
| `src/database/schema.ts` | ~100 | +30 | Safe |
| `src/database/feedback-queries.ts` | 0 (new) | +120 | New file |
| `src/database/queries.ts` | 1744 | 0 | No changes |
| `src/prompts/coder.ts` | 427 | +10 | Minimal: interface field + 4 injection calls |
| `src/prompts/reviewer.ts` | 637 | +15 | Minimal: 2 interface fields + 3 injection calls |
| `src/prompts/prompt-helpers.ts` | 423 | 0 | No changes |
| `src/prompts/feedback-prompt-helpers.ts` | 0 (new) | +50 | New file |
| `src/orchestrator/coder.ts` | ~300 | +20 | Transaction + load |
| `src/orchestrator/reviewer.ts` | 480 | +25 | Transaction + load + custom instructions |
| `src/config/loader.ts` | unknown | +5 | 1 optional field on ReviewerConfig |
| `API/src/routes/feedback.ts` | 0 (new) | +120 | New file |
| `API/src/routes/tasks.ts` | 1372 | 0 | No changes |
| `WebUI/src/components/UserFeedbackPanel.tsx` | 0 (new) | +120 | New file |
| `WebUI/src/pages/TaskDetailPage.tsx` | ~650 | +5 | Mount UserFeedbackPanel |
| `src/commands/tasks.ts` | ~1400 | +30 | Subcommand |

---

## Cross-Provider Review

### Round 1 — Claude review of initial design

**Date:** 2026-03-02

**Findings:**

| # | Finding | Severity | Decision |
|---|---------|----------|----------|
| 1 | Missing transaction: `getPendingFeedback` and `markFeedbackDelivered` in separate DB calls — race window between fetch and mark | Critical | **Adopt** — design now specifies transaction wrapping |
| 2 | Session-resume delta prompts (`generateResumingCoderDeltaPrompt`, `generateResumingReviewerDeltaPrompt`) not in scope — feedback silently dropped on resumed sessions | Critical | **Adopt** — all 7 prompt functions now listed explicitly |
| 3 | `is_override: boolean` typed in interface but SQLite returns `0`/`1` INTEGER — runtime mismatch, broken `=== true` checks | Critical | **Adopt** — design now uses `FeedbackRow` raw type + `toEntry()` cast |
| 4 | Override directive has LLM-interpreted escape clause — cannot mechanically guarantee compliance | Important | **Adopt as documentation** — design now states "best-effort" explicitly; noted in Non-Goals and Edge Cases |
| 5 | Batch coder/reviewer paths (`generateBatchCoderPrompt`, `generateBatchReviewerPrompt`) not addressed | Important | **Adopt** — `BatchCoderPromptContext` and `BatchReviewerPromptContext` now in scope |
| 6 | Missing index on `task_feedback(task_id)` and partial indexes for pending-delivery queries | Important | **Adopt** — three indexes added to schema |
| 7 | Missing `_migrations` entry — `autoMigrate()` exists, schema note was wrong | Important | **Adopt** — migration entry added to design |
| 8 | `getPendingFeedbackForCoder` query must use `target='coder' OR target='all'` — not `target='coder'` only | Important | **Adopt** — explicit SQL documented |
| 9 | No token budget interaction; unbounded feedback size in prompt | Moderate | **Defer** — feedback is max 4000 chars per entry; in practice 1-2 entries per invocation. Explicit cap is over-engineering for now. Document as known risk. |
| 10 | Use `ORDER BY id ASC` not `ORDER BY created_at ASC` for deterministic ordering (1-second TEXT resolution) | Moderate | **Adopt** — `ORDER BY id ASC` now explicit throughout |
| 11 | Partial delivery state (`target='all'`) not surfaced in API response — UI shows row as pending even after coder delivery | Moderate | **Adopt** — `pending_for: ('coder' \| 'reviewer')[]` added to API response type |
| 12 | `deleteFeedback` needs explicit delivered-check guard; 409 is correct status | Minor | **Adopt** — `deleteFeedback()` returns `boolean`; caller sends 409 |
| 13 | Mark-delivered timing must survive session-not-found retry path in `coder.ts` (prompt rebuilt on retry) | Minor | **Adopt as implementation note** — transaction completes before any prompt generation, so retry reuses captured `entries` array without re-fetching |

### Round 2 — Codex review

**Date:** 2026-03-02

**Status:** Timed out (5 min) during codebase exploration before producing findings. No findings to assess. Round 2 review deferred until implementation is ready for verification-phase review.

---
