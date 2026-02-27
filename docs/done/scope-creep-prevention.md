# Scope Creep Prevention — Final Implementation Plan

## Context

**Problem:** AI coders implement work outside their assigned task scope (e.g. building the full API + DB when only assigned a frontend task). This causes unnecessary rejections, wasted cycles, and tangled diffs.

**Root causes:**
1. Coder gets no info about sibling tasks — can't know what *not* to build
2. Reviewer has no instruction to treat out-of-scope work as a mandatory reject
3. Coordinator only checks "did reviewer demand too much?" — not "did coder do too much?"
4. The `[OUT_OF_SCOPE]` tag introduced for the reviewer doesn't survive the post-reviewer LLM rewrite before it hits the DB

---

## Work Already Done (5 files, build passes)

| File | Change |
|------|--------|
| `src/prompts/prompt-helpers.ts` | `formatSectionTasks()` dual-role: coder gets SCOPE BOUNDARY; reviewer gets `[OUT_OF_SCOPE]` flag instruction |
| `src/prompts/reviewer.ts` | Checklist item #6 (scope check) + `[OUT_OF_SCOPE]` tag in rejection format |
| `src/prompts/coder.ts` | `sectionTasks?: SectionTask[]` in `CoderPromptContext`; rendered in `generateCoderPrompt` |
| `src/orchestrator/coder.ts` | Fetches sibling tasks from DB (`withDatabase + listTasks`) when `section_id` present |
| `src/orchestrator/coordinator.ts` | Decision Framework #4 bidirectional scope; Analysis item #5 scope creep |

---

## Adversarial Review Findings — 4 Rounds (Codex R1, Claude R1, Codex R2, Claude R2)

| Finding | Severity | Decision |
|---------|----------|----------|
| `[OUT_OF_SCOPE]` dies in post-reviewer rewrite (2000-char tail + LLM paraphrase) | CRITICAL | FIX — 1a + 1b |
| Fix 1b must scan ALL reviewer results, not just `reviewerResults[0]` | CRITICAL | FIX — 1b |
| Fix 1b regex misses `**[OUT_OF_SCOPE]**` bold variants | HIGH | FIX — 1b |
| Fix 1b dedup check must use `.includes('[OUT_OF_SCOPE]')` | HIGH | FIX — 1b |
| Fix 5 wrong decision type: `narrow_scope` can approve scope-creep submissions | HIGH | FIX — 5, use `guide_coder` |
| `generateResumingCoderPrompt` missing scope boundary | HIGH | FIX — 2 |
| `generateResumingCoderDeltaPrompt` has no scope context (context window drift) | HIGH | FIX — 3 |
| Reviewer has no mandatory-reject rule for `[OUT_OF_SCOPE]` — approves helpful extra work | HIGH | FIX — 4 |
| Coordinator "validate" is misleading — can only see filenames, not diff | HIGH | FIX — 5 |
| `[OUT_OF_SCOPE]` has no `REVERTED` response type in coder's REJECTION_RESPONSE contract | HIGH | FIX — 6 |
| Appended items in Fix 1b lack ITEM-n numbering — breaks REJECTION_RESPONSE contract | MEDIUM | FIX — 1b (add labeled header) |
| Fix 6 REVERTED type missing from `formatRejectionHistoryForCoder` (4th location) | MEDIUM | FIX — 6 |
| "Revert these changes" not actionable — no git guidance | MEDIUM | FIX — 7 |
| CLI allow-list duplicated in 4 locations; only 1 updated | MEDIUM | FIX — 8 (all 4 locations) |
| Multi-reviewer verbatim guarantee is LLM-soft | MEDIUM | COVERED by Fix 1b |
| `SectionTask.status` typed as `string` | LOW | DEFER |
| Batch coder has no SCOPE BOUNDARY | LOW | DEFER |
| 15-task truncation limit | LOW | DEFER |

---

## Complete Implementation Plan

### Files to Change

| # | File | Change | Priority |
|---|------|--------|----------|
| 1a | `src/orchestrator/post-reviewer.ts` | Increase tail to 5000; prescribe verbatim checkbox NOTES format | CRITICAL |
| 1b | `src/commands/loop-phases.ts` | Deterministic regex extraction of `[OUT_OF_SCOPE]` items from all reviewer results; append with labeled header if post-reviewer dropped them | CRITICAL |
| 2 | `src/prompts/coder.ts` | Add `formatSectionTasks` to `generateResumingCoderPrompt` | HIGH |
| 3 | `src/prompts/coder.ts` | Add scope + revert reminder to `generateResumingCoderDeltaPrompt` | HIGH |
| 4 | `src/prompts/reviewer.ts` | Mandatory-reject statement + CRITICAL RULE #11 for `[OUT_OF_SCOPE]` | HIGH |
| 5 | `src/orchestrator/coordinator.ts` | Change "validate" to "trust reviewer"; use `guide_coder` (not `narrow_scope`) for scope creep; enumerate files to revert | HIGH |
| 6 | `src/prompts/coder.ts` + `src/prompts/prompt-helpers.ts` | Add `REVERTED` response type to REJECTION_RESPONSE contract in all 4 locations | HIGH |
| 7 | `src/prompts/reviewer.ts` | Update `[OUT_OF_SCOPE]` rule: list specific files to delete, not "git revert" | MEDIUM |
| 8 | `src/prompts/coder.ts` + `src/prompts/prompt-helpers.ts` | Apply read-only CLI allow list to all 4 `steroids tasks` restriction locations consistently | MEDIUM |

---

## Detailed Change Specs

### 1a — `src/orchestrator/post-reviewer.ts`
- Line 19: `stdout.slice(-2000)` → `stdout.slice(-5000)`
- In the NOTES section of the prompt, replace the one-line description with:
```
### NOTES
Required if REJECT. You MUST output the reviewer's rejection checklist verbatim — do NOT paraphrase or reformat.
Copy each checkbox item exactly as the reviewer wrote it, preserving ALL tags:
- [ ] [NEW] ...
- [ ] [UNRESOLVED] ...
- [ ] [OUT_OF_SCOPE] ...
```

### 1b — `src/commands/loop-phases.ts`
Add a small helper function:
```typescript
function extractOutOfScopeItems(stdout: string): string[] {
  // Robust pattern: handles bold variants, whitespace, checked boxes
  return stdout.match(/- \[\s*[x ]?\s*\]\s*(?:\*{1,2})?\[OUT_OF_SCOPE\](?:\*{1,2})?[^\n]*/gi) ?? [];
}
```
After the post-reviewer produces a REJECT decision, scan all raw reviewer outputs (multi-reviewer + single) and append any dropped `[OUT_OF_SCOPE]` items with a clear header:
```typescript
const allReviewerStdout = (reviewerResults ?? (reviewerResult ? [reviewerResult] : []))
  .map(r => r?.stdout ?? '').join('\n');
const outOfScopeItems = extractOutOfScopeItems(allReviewerStdout);
if (outOfScopeItems.length > 0 && !decision.notes?.includes('[OUT_OF_SCOPE]')) {
  decision = {
    ...decision,
    notes: `${decision.notes ?? ''}\n\n## Out-of-Scope Items (from reviewer)\n${outOfScopeItems.join('\n')}`
  };
}
```
The `includes('[OUT_OF_SCOPE]')` guard is O(1) and avoids double-append. The labeled `## Out-of-Scope Items` header disambiguates these from the numbered prose items in the post-reviewer's NOTES so the coder knows to respond with `REVERTED` (not ITEM-n numbering).

### 2 — `src/prompts/coder.ts` (`generateResumingCoderPrompt`)
After `${fileAnchorSection}` in the return template, add:
```typescript
${formatSectionTasks(task.id, sectionTasks, 'coder')}
```

### 3 — `src/prompts/coder.ts` (`generateResumingCoderDeltaPrompt`)
After the REMINDER block, add a scope reminder (only when rejection contains `[OUT_OF_SCOPE]` or when sectionTasks are non-empty):
```
**SCOPE REMINDER:** Your scope is limited to this task only — do not implement work assigned to sibling tasks. If your rejection notes contain `[OUT_OF_SCOPE]` items, you must revert those specific files/changes.
```

### 4 — `src/prompts/reviewer.ts`
After the `[OUT_OF_SCOPE]` rule, add:
```
**`[OUT_OF_SCOPE]` is a MANDATORY REJECT** — even if the extra work is correct, useful, and well-implemented, you MUST reject if the coder implemented work belonging to a sibling task. Quality is not a mitigating factor. The coder must remove those changes before approval.
```
Add to CRITICAL RULES:
```
11. **`[OUT_OF_SCOPE]` = mandatory reject** — always reject if coder did sibling work, even if correct
```

### 5 — `src/orchestrator/coordinator.ts`
Replace Analysis item #5:
```
5. **Scope creep?** Did the reviewer flag `[OUT_OF_SCOPE]` items? Trust the reviewer's finding — it has seen the actual diff; you only have a filename list and cannot independently validate scope boundaries. If scope creep is confirmed: use `guide_coder` decision type, enumerate the exact files the coder must delete or revert, and name which sibling task those changes belong to. Do NOT use `narrow_scope` for scope creep — that would reduce the reviewer's evaluation target and risk approving a submission that still contains the forbidden files.
```

### 6 — `src/prompts/coder.ts` + `src/prompts/prompt-helpers.ts`
In ALL 4 locations where the REJECTION_RESPONSE contract appears, extend it:
```
- `ITEM-n | IMPLEMENTED | <file:line> | <what changed>`
- `ITEM-n | REVERTED | <file path> | deleted/removed out-of-scope changes`  ← for [OUT_OF_SCOPE] items
- `ITEM-n | WONT_FIX | <reason>` ← NOT valid for [OUT_OF_SCOPE] items — those must be REVERTED
- For items under `## Out-of-Scope Items`: respond with `REVERTED | <file> | <what was deleted>`
```
Locations:
1. `coder.ts`: `generateCoderPrompt` (~line 202)
2. `coder.ts`: `generateResumingCoderPrompt` (~line 364)
3. `coder.ts`: `generateResumingCoderDeltaPrompt` (~line 79)
4. `prompt-helpers.ts`: `formatRejectionHistoryForCoder` (~line 260)

### 7 — `src/prompts/reviewer.ts`
Update rejection rule #4 for `[OUT_OF_SCOPE]` items:
```
4. For each `[OUT_OF_SCOPE]` item: name the sibling task, list the specific files to remove, and tell the coder to delete them directly (not `git revert` — just delete or empty the files; the orchestrator commits the cleanup)
```

### 8 — `src/prompts/coder.ts` + `src/prompts/prompt-helpers.ts`
Apply the read-only CLI allow list consistently in all 4 locations:
```
- **`steroids tasks` — READ-ONLY ONLY:** You may query task context with `steroids tasks list` or `steroids tasks show <id>`. NEVER use: `update`, `approve`, `reject`, `add`, `reset`, `skip` — the orchestrator owns all state changes.
```
Locations (same as Fix 6 above): `generateCoderPrompt`, `generateResumingCoderPrompt`, `generateBatchCoderPrompt`, `formatRejectionHistoryForCoder`.

---

## Non-Goals (Explicitly Out of Scope)

- No schema changes (no `scope_creep` field in DB) — separate PR
- No batch coder SCOPE BOUNDARY — batch mode is intentionally multi-task
- `SectionTask.status` type improvement — cosmetic, follow-up
- Reviewer delta prompt Rule 11 — session history carries it, low risk
- `steroids dispute create` restriction — intentional, separate concern

---

## Verification

1. `npm run build` — zero errors
2. `npm test` — 819+ tests pass
3. Coder prompt with siblings → "Other Tasks in This Section" + SCOPE BOUNDARY visible
4. Resuming coder prompt → SCOPE BOUNDARY visible
5. Resuming coder delta → SCOPE REMINDER visible
6. Reviewer prompt → checklist #6, mandatory-reject statement, CRITICAL RULE #11 visible
7. Post-reviewer prompt → NOTES section instructs verbatim checkbox preservation
8. `loop-phases.ts` → `extractOutOfScopeItems` helper present; scans all reviewer results; appends with header; uses `.includes('[OUT_OF_SCOPE]')` dedup
9. Coordinator prompt → analysis item #5 says "trust reviewer", uses `guide_coder` not `narrow_scope`
10. Coder prompt REJECTION_RESPONSE → `REVERTED` type present in all 4 locations
