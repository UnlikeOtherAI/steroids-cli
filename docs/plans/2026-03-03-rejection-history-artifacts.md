# Rejection History Artifacts and Full-Fidelity Prompt Context

**Status:** Draft (pre-implementation)
**Date:** 2026-03-03
**Scope:** Ensure coder/reviewer always have complete rejection history without lossy truncation

## 1. Problem Statement

The coder/reviewer loop is dropping historical rejection detail in long-running tasks.

Observed on task `6abd2a15-ab91-4af5-a95a-96138c9cdcb5` (AdGoes.live):
- Task reached `rejection_count=8`.
- Several coder retries used resume-delta prompts (not full prompts), so only latest rejection was injected.
- At least one merged rejection note was exactly `3000` chars in audit, which matches a hard slice in code.

This creates rejection spirals where previously reported issues are forgotten or partially represented.

## 2. Current Behavior

### Data storage
- `audit.notes` is `TEXT` (no DB-level truncation): `src/database/schema.ts`.
- Rejections are read via `getTaskRejections()` with no query limit: `src/database/queries.ts`.

### Prompt assembly and truncation points
- Coder full prompt (`generateCoderPrompt`) includes latest rejection and only last 3 detailed rejections: `src/prompts/prompt-helpers.ts`.
- Coder resume-delta prompt (`generateResumingCoderDeltaPrompt`) includes only latest rejection plus optional coordinator guidance: `src/prompts/coder.ts`.
- Reviewer prompt shows only latest 2 rejections and truncates each to 800 chars: `src/prompts/reviewer-template-sections.ts`.
- Multi-reviewer reject fallback stores `primaryResult.stdout.slice(-3000)` as rejection notes: `src/commands/loop-phases-reviewer-resolution.ts`.
- Post-reviewer orchestrator prompt only passes last 5000 chars of reviewer stdout/stderr to its parser/merger: `src/orchestrator/post-reviewer.ts`.

### Impact confirmed in task records
- Audit row at `2026-03-03 12:37:18` has `length(notes)=3000`.
- Many coder invocations for this task were resume prompts (`"The reviewer rejected your last submission..."`), not full-history prompts.

## 3. Desired Behavior

1. Every rejection note is persisted as a task-scoped artifact file in `.steroids` (ignored by git).
2. Coder and reviewer prompts always include a path to full rejection history artifacts.
3. No hard character-limit truncation on rejection notes passed from reviewer resolution to coder.
4. Review orchestration remains robust for huge outputs, but notes persisted in audit/artifacts are full-fidelity.
5. Resume-delta prompts include structured rejection history from DB (same source as full prompt), not only the latest rejection.
6. Prompt instructions are internally consistent (read-only access to rejection archive is explicitly allowed even though `.steroids/` remains protected from mutation).

## 4. Design

### 4.1 Canonical source + artifact mirror

Add a small utility module (e.g., `src/orchestrator/rejection-artifacts.ts`) to persist:
- Directory: `<projectPath>/.steroids/rejection-history/<taskId>/`
- Files:
  - `index.json` (ordered metadata: rejection number, `audit.id`, timestamp, actor, commit, note file name)
  - `rejection-<nnn>.md` (full notes, verbatim)
  - Optional `latest.md` symlink/copy for convenience

Write policy:
- SQLite audit remains canonical source of truth.
- Artifacts are a mirrored convenience cache for LLM/file-tool consumption.
- On every reject/fail transition (`review -> in_progress` and `review -> failed`), mirror the finalized notes.
- Use `audit.id` (or rejection number derived from audit ordering by `created_at, id`) as canonical sequence key.
- For empty/null notes, write a normalized placeholder (`(no notes provided)`) to keep structure deterministic.

### 4.2 Prompt wiring (coder and reviewer)

Inject a reusable prompt section:
- `## Full Rejection Archive`
- Absolute/relative path to task rejection folder
- Explicit instruction: read `index.json` + all `rejection-*.md` before deciding/implementing

Apply to:
- `generateCoderPrompt()`
- `generateResumingCoderDeltaPrompt()`
- `generateReviewerPrompt()`
- `generateResumingReviewerDeltaPrompt()`

Also fix the root cause directly:
- `generateResumingCoderDeltaPrompt()` must include the same DB-based structured rejection history section used by full coder prompts (titles + detailed recent notes), not only last rejection.

Instruction consistency:
- Keep "do not modify `.steroids/`" rule.
- Add explicit exception: read-only inspection of `.steroids/rejection-history/<taskId>/` is allowed.

### 4.3 Remove lossy truncation of rejection notes

Fix decision resolution path:
- Replace `stdout.slice(-3000)` in multi-reviewer reject fallback with full parsed reject notes; only fall back to full stdout when parser provides no notes.
- Preserve full notes in `audit.notes` and artifacts.

Fix orchestrator reviewer input shaping:
- Keep current tailing only for decision-token recovery paths.
- For persisted rejection content, use one authoritative source: parsed reviewer notes from the resolved reject decision.

### 4.4 Safety bounds without dropping history

To avoid massive prompt bloat:
- Do not inline all old rejection text into prompt body.
- Pass path-based archive reference + concise summaries in prompt.
- Cap inline summaries only, never the persisted source data.

## 5. Implementation Order

1. Fix resume-delta root cause: inject DB-based rejection history into `generateResumingCoderDeltaPrompt()`.
2. Add rejection-artifact utility + tests (write/read/ordering by `audit.id`).
3. Hook artifact writes in canonical reject/fail transition path.
4. Add prompt section generator and inject into coder/reviewer (full + resume), with explicit read-only `.steroids` exception text.
5. Remove/replace 3000-char reject-note fallback and align parsing paths to authoritative parsed notes.
6. Add integration tests for:
   - Long (>10k chars) rejection retained in audit and artifact file.
   - Resume coder prompt includes archive path.
   - Resume coder prompt includes structured rejection history (not latest-only).
   - Reviewer prompt includes archive path.
7. Update docs (`README.md`, `AGENTS.md` if needed, and CLI/orchestrator docs).

## 6. Edge Cases

| Scenario | Handling |
|---|---|
| Rejection notes are empty/null | Normalize to `(no notes provided)` and persist deterministic artifact |
| Duplicate orchestrator retry writes same rejection | Upsert by `audit.id` (or skip if artifact for that `audit.id` already exists) |
| Large rejection notes (50k+) | Persist full file; prompt references path, does not inline |
| Workspace path changes (pool clone/symlink) | Use `projectPath/.steroids/...` at runtime so artifacts stay local to active project context |
| Artifact write failure | Log warning; keep DB as source of truth; prompt omits archive path and relies on DB-inline rejection history for that run |

## 7. Non-Goals

- Replacing the full audit DB with file-based history.
- Adding vector search/summarization for rejection history.
- Changing reviewer decision policy semantics.
- Refactoring unrelated token-guard/session-resume logic.

## 8. Cross-Provider Review

### Reviewer: Codex (`timeout 300 codex exec ...`)

1. **Finding:** `.steroids` access rule conflict with new archive path.
Assessment: Valid. Current coder prompt says never touch `.steroids`; archive-read instruction would conflict.
Decision: **ADOPT**. Add explicit read-only exception for `.steroids/rejection-history/<taskId>/`.

2. **Finding:** `review -> failed` path can miss final rejection if mirroring only `review -> in_progress`.
Assessment: Valid. Max-rejection failure path is important and must be mirrored too.
Decision: **ADOPT**. Mirror both reject and fail transitions.

3. **Finding:** ordering/idempotency keyed by `created_at` is unstable.
Assessment: Valid. We should use `audit.id` for stable ordering and identity.
Decision: **ADOPT**. Use `audit.id` in `index.json` and write sequence.

4. **Finding:** removing only `slice(-3000)` is insufficient; need a single authoritative notes source.
Assessment: Valid. Reject notes currently come from mixed sources.
Decision: **ADOPT**. Persist parsed reject notes as authoritative; use raw stdout only as fallback.

5. **Finding:** resume prompt can still bloat by inlining large latest rejection.
Assessment: Valid risk. Current resume path quotes last rejection verbatim.
Decision: **ADOPT**. Shift resume path to concise inline summary + structured history section + archive reference.

6. **Finding:** artifact-write failure policy was contradictory.
Assessment: Valid. Previous draft lacked deterministic fallback.
Decision: **ADOPT**. On artifact failure, omit archive path and rely on DB-inline history.

7. **Finding:** empty-notes policy inconsistent.
Assessment: Valid.
Decision: **ADOPT**. Normalize empty notes to a deterministic placeholder.

### Reviewer: Claude (`claude -p ...`)

1. **Finding:** root cause is resume-delta prompt depth; artifact layer alone is wrong layer.
Assessment: Valid and important. We should fix resume-delta directly regardless of artifact mirroring.
Decision: **ADOPT**. Make resume-delta include DB-based structured history.

2. **Finding:** problem statement overstates truncation scope.
Assessment: Partially valid. Storage is not broadly truncating, but there are real truncation points in resolution/prompt summaries.
Decision: **ADOPT (partial)**. Clarify scope in implementation notes and target actual lossy paths.

3. **Finding:** path-reference prompting can be non-deterministic.
Assessment: Valid risk, but user explicitly wants persisted file history accessible to agents.
Decision: **ADOPT (mitigated)**. Keep archive as supplemental context only; DB-inline history remains required fallback.

4. **Finding:** idempotency key is over-engineered.
Assessment: Mostly valid if we anchor on `audit.id`.
Decision: **ADOPT**. Use sequence-based write strategy keyed by `audit.id`/rejection number.

5. **Finding:** reviewer 800-char history cap may be intentional.
Assessment: Valid. Reviewer doesn’t always need full raw history inline.
Decision: **DEFER**. Keep reviewer inline summary cap for now; rely on archive path for optional deep history.
