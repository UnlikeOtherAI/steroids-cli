# Adversarial Review Specification

## Overview

The **Adversarial Reviewer** is a specialized review mode that treats the reviewer as an automated quality gate with cumulative, comprehensive context. Instead of incremental reviews, it examines the FULL history of a task (all rejections, all submission commits) and delivers a definitive PASS/FAIL contract.

## Design Goals

1. **Full Context** - Reviewer has complete history, not just recent attempts
2. **Cumulative Review** - Like reviewing a full PR with all its commits, not diffs
3. **Structured Output** - Machine-parseable PASS/FAIL contract with required fields
4. **Blocking Rules** - Clear constraints that can't be waived by prior guidance
5. **Adversarial Stance** - Actively questions assumptions, looks for edge cases

## Data Model

### What the Reviewer Gets (Enhanced Context)

**All Submission Commits (Cumulative)**
```
From audit table: SELECT commit_sha FROM audit
WHERE task_id = ? AND to_status = 'review'
Returns: [latest_sha, second_attempt_sha, first_attempt_sha, ...]
```

Each commit represents:
- Attempt 1: Initial submission
- Attempt 2: First revision after Rejection #1
- Attempt 3: Second revision after Rejection #2
- ... and so on

**All Rejection History (Untruncated)**
```
From audit + task_invocations:
- Rejection #1: notes + coder response + what changed in attempt 2
- Rejection #2: notes + coder response + what changed in attempt 3
- ... (all rejections, not limited to latest 2)
```

**Submission Notes Per Attempt**
```
Each coder submission can include notes explaining the approach:
- What was changed since last rejection
- Why they believe it addresses the feedback
- Any architectural decisions
```

## Output Contract

The reviewer's output MUST follow this structure:

```
ADVERSARIAL DECISION: PASS | FAIL

DECISION RATIONALE:
<Structured analysis of the decision>

PASS CERTIFICATIONS:
[ ] Specification fully implemented
[ ] No bugs or logic errors detected
[ ] Security review: No vulnerabilities introduced
[ ] Code quality: Follows project patterns
[ ] All files ≤ 500 lines
[ ] Tests adequate (if required)

FAIL BLOCKERS (if any):
- [ ] Critical Security Issue: <specific description>
- [ ] Logic Error: <specific description>
- [ ] Spec Gap: <specific description>
- [ ] Code Quality: <specific description>

CUMULATIVE HISTORY ANALYSIS:
- Total attempts: N
- Rejection pattern: <describe pattern if any>
- Most common feedback: <category>
- Evidence of convergence: Yes/No

NOTES FOR HUMAN REVIEW:
<Advisory feedback, architectural concerns, suggestions>
```

## Prompt Fields (REQUIRED)

The reviewer prompt MUST include:

1. **Submission History Table**
   ```
   | Attempt | Commit SHA | Notes | Issues Found |
   |---------|-----------|-------|--------------|
   | 1       | abc123    | Initial submission | [rejection notes] |
   | 2       | def456    | Updated X per feedback | [rejection notes] |
   | ...     | ...       | ...   | ...          |
   ```

2. **Full Rejection Archive**
   ```
   Rejection #1 (Attempt 2):
   - Notes: "..."
   - Coder's response/explanation: "..."
   - Changes in next attempt: "..."

   Rejection #2 (Attempt 3):
   - Notes: "..."
   - ...
   ```

3. **Current Submission Context**
   ```
   Latest submission: <commit SHA>
   Files changed since last attempt: [list]
   Coder's notes: "..."
   ```

4. **Specification**
   - Full task specification
   - File anchors if applicable
   - Any coordinator guidance (if applicable)

5. **Analysis Instructions**
   - Compare against original spec
   - Check if all rejection feedback was addressed
   - Verify each attempt shows genuine progress
   - Look for repeated patterns or circular feedback

## Blocking Rules

These rules CANNOT be overridden by coordinator guidance or task pressure:

1. **Security is Non-Negotiable**
   - Any vulnerability = FAIL
   - No "accept for now" on security issues
   - Code injection, path traversal, secrets exposure = automatic FAIL

2. **Specification Compliance**
   - Implementation must match stated spec
   - Missing features = FAIL
   - Partial implementation requires explicit MANUAL/SKIP in spec

3. **Logic Correctness**
   - No logic errors in critical paths
   - Edge cases must be handled
   - Off-by-one errors, null dereferences = FAIL

4. **File Size Constraint**
   - Files ≤ 500 lines (from CLAUDE.md)
   - Violations = FAIL
   - Extract functions/modules instead

5. **Convergence Requirement**
   - If task has 3+ rejections, there should be evidence of progress
   - If same issue rejected twice in a row, coder MUST change approach
   - Circular feedback patterns = FAIL (escalate to human/dispute)

## Decision Precedence

```
FAIL (any blocker) > PASS (all criteria met)
```

If ANY blocker is present, the decision is FAIL. There is no APPROVE-WITH-CAVEATS in adversarial mode.

## Integration Points

### 1. When to Invoke Adversarial Review

Option A: **High rejection count threshold**
- After 3+ rejections on the same task
- Activate adversarial review to break deadlock

Option B: **Explicit request**
- `steroids tasks update <task-id> --review-mode adversarial`
- User or coordinator explicitly requests thorough review

Option C: **Critical tasks**
- Tasks marked with `criticalReview: true` in spec
- Security-sensitive code paths
- Core infrastructure changes

### 2. Conflict Resolution

If adversarial review FAILS but regular reviewers APPROVEd:
- FAIL takes precedence (more conservative)
- Escalate to human reviewer or coordinator
- Document the disagreement for learning

### 3. Prompt Template

Create new file: `src/prompts/adversarial-reviewer.ts`

```typescript
export interface AdversarialReviewerContext {
  task: Task;
  allSubmissionCommits: string[];  // [latest, ..., earliest]
  allRejections: RejectionEntry[]; // ALL rejections, untruncated
  cumulativeChanges: {              // Map of what changed between attempts
    attempt: number;
    changesSincePrior: string;
    coderNotes: string | null;
  }[];
  submissionHistoryTable: string;   // Markdown table for display
  rejectionArchive: string;         // Full rejection history formatted
  config: SteroidsConfig;
  coordinatorGuidance?: string;
}

export function generateAdversarialReviewerPrompt(context: AdversarialReviewerContext): string {
  // ...
}
```

## Example Output

```
ADVERSARIAL DECISION: FAIL

DECISION RATIONALE:
The implementation addresses most of the specification but has a critical null-dereference
bug in the new error handling path (src/handlers/submit.ts:89). The coder has made genuine
progress across 4 attempts and appears to understand the feedback, but this latest issue was
not caught before submission.

PASS CERTIFICATIONS:
[x] Specification fully implemented (except critical bug)
[ ] No bugs or logic errors detected (BLOCKER: null dereference)
[x] Security review: No vulnerabilities introduced
[x] Code quality: Follows project patterns
[x] All files ≤ 500 lines
[x] Tests adequate (new tests cover 85% of modified files)

FAIL BLOCKERS:
- [x] Logic Error: src/handlers/submit.ts:89 dereferences `result.data` without null check.
      When API returns error response, `result.data` is undefined. Fix: Check `result.status`
      before accessing `.data`.

CUMULATIVE HISTORY ANALYSIS:
- Total attempts: 4
- Rejection pattern:
  - Rejection #1: Missing error handling
  - Rejection #2: Incomplete validation logic
  - Rejection #3: Test coverage gaps
  - Rejection #4: (Current) Introduced bug while fixing validation
- Evidence of convergence: Yes, each attempt addresses prior feedback, but
  this attempt introduced a new issue instead of following the existing error
  handling pattern already in handlers/query.ts

NOTES FOR HUMAN REVIEW:
The coder should have followed the existing error pattern in handlers/query.ts:87
(which uses optional chaining). Suggest adding this pattern to the code review
checklist for future tasks. The attempts show good understanding of requirements;
the issue is execution carefulness on the final submission.
```

## Testing the Feature

```bash
# 1. Create a test task that gets rejected multiple times
steroids tasks add "Test adversarial review" --section test

# 2. Let it fail/reject naturally 3-4 times
steroids loop --once

# 3. Trigger adversarial review
steroids config set ai.reviewer.mode adversarial
steroids loop --once

# 4. Verify output includes:
#    - All submission commits
#    - All rejection history
#    - Structured PASS/FAIL contract
#    - No truncated rejection notes
```

## Migration Path

Phase 1: Implement adversarial reviewer as new invocation mode
- Create `generateAdversarialReviewerPrompt()`
- Add database queries for full history
- Add to `invokeReviewer()` decision logic

Phase 2: Integrate with loop logic
- Add config option: `ai.reviewer.mode: 'standard' | 'adversarial'`
- Auto-activate after 3 rejections (if configured)
- Add CLI flag: `--review-mode adversarial`

Phase 3: Coordinator integration
- Coordinator can request adversarial review in guidance
- Adversarial FAIL blocks task progression
- Log decisions for post-hoc analysis

## Success Criteria

- ✅ Reviewer has full rejection history (not truncated)
- ✅ Reviewer receives all submission commits in sequence
- ✅ Output is structured, machine-parseable (PASS/FAIL contract)
- ✅ Blocking rules are enforced regardless of coordinator guidance
- ✅ Evidence of convergence is analyzed
- ✅ Tasks don't enter circular rejection loops
