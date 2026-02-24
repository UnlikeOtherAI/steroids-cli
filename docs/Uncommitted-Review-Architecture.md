# Architectural Design: Uncommitted Review & Plain Text Signals

## 1. Executive Summary
The Steroids CLI will transition from a "Commit-Per-Submission" and "JSON-Enforced" model to an **"Uncommitted Review + End-State Commit"** and **"Plain Text Signal"** model. 

Currently, Coders are forced to format output as strict JSON and execute `git commit` for every review cycle. This pollutes the Git history with WIP commits, requires complex "submission chain" resolution logic, and causes fragile JSON parse failures.

Under the new model:
1. **No LLM Commits:** The Coder modifies the working directory and outputs a text signal (`STATUS: REVIEW`). The code remains uncommitted.
2. **Uncommitted Reviews:** The Reviewer inspects `git diff HEAD`.
3. **No JSON Schemas:** All agents output standard Markdown with explicit routing tokens (e.g., `DECISION: APPROVE`).
4. **End-State Commit:** Only when the task achieves consensus `APPROVE` does the Host System (Steroids CLI) automatically generate a commit message and execute `git commit`.

---

## 2. Affected Files & Deletions

### 🗑️ Files to Delete Entirely
*   `src/git/submission-resolution.ts`: We no longer have "submission chains" or need to recover unreachable commits. The diff is always just `HEAD`.
*   `src/orchestrator/schemas.ts`: JSON validation is no longer required.
*   (Potentially) `src/orchestrator/fallback-handler.ts`: Replaced by a tiny ~20 line `SignalParser` utility.

### ✂️ Files to Heavily Modify

#### `src/prompts/coder.ts`
*   **Remove:** Instructions telling the Coder to run `git commit`.
*   **Remove:** The massive ````json` formatting contract block.
*   **Add:** Instructions to leave changes in the working directory and output `STATUS: REVIEW` when finished.

#### `src/prompts/reviewer.ts`
*   **Remove:** Logic that calculates `oldest_commit^..latest_commit` and provides `git show <sha>` commands.
*   **Remove:** The JSON output format contract.
*   **Add:** Instructions to review `git diff HEAD` and `git diff --stat HEAD`.
*   **Add:** Instructions to output `DECISION: APPROVE`, `DECISION: REJECT`, or `DECISION: DISPUTE` followed by standard Markdown notes.

#### `src/commands/loop-phases.ts`
*   **Coder Phase:** Instead of checking for new commits, check if `git diff HEAD` or `git status --porcelain` is non-empty.
*   **Reviewer Phase:** Pass the uncommitted working tree diff to the reviewer.
*   **Consensus / Approval Logic:** 
    - When a decision resolves to `APPROVE`, the CLI takes control.
    - CLI runs `git add .`.
    - CLI makes a fast native API call (or uses a dedicated "Committer" agent prompt) to generate a conventional commit message based on the task title and the diff.
    - CLI executes `git commit -m "<msg>"` and (if configured) `git push`.

#### `src/database/queries.ts`
*   **Modify:** `addAuditEntry`. We no longer need to store `commit_sha` for every `review` or `in_progress` transition. The `commit_sha` will only be recorded on the final `completed` transition.

#### `src/parallel/merge-process.ts` & `merge-sealing.ts`
*   **Modify:** Parallel workstreams operate in clones. The End-State Commit logic works perfectly here: the clone will accumulate one clean commit per task. When the section is sealed, the `sealed_commit_shas` array will contain exactly one pristine commit per task, which `merge.ts` can cherry-pick seamlessly.

---

## 3. The New Agent Routing Loop

**Step 1: Coder Execution**
*   Coder writes code to disk.
*   Outputs: `I have implemented the auth module. STATUS: REVIEW`
*   Host verifies `git status` shows modified files. Transitions task to `review`.

**Step 2: Reviewer Execution**
*   Host captures `git diff HEAD`.
*   Reviewer analyzes the uncommitted diff.
*   Outputs: `DECISION: REJECT

### Issues
1. Missing null check...`
*   Host parses `DECISION: REJECT`, transitions task to `in_progress`, appends notes to DB.

**Step 3: End-State Commit**
*   Coder fixes code. Outputs `STATUS: REVIEW`.
*   Reviewer outputs `DECISION: APPROVE`.
*   Host parses `APPROVE`.
*   Host stages all files (`git add .`).
*   Host executes `git commit -m "feat(auth): implement auth module (Task: abc1234)"`.
*   Task transitions to `completed`.

---

## 4. Stability Benefits
1. **Token Efficiency:** Prompts are shorter (no massive JSON contracts), and outputs are shorter.
2. **Zero Parse Crashes:** We eliminate `ajv` validation failures and JSON truncation errors.
3. **Pristine Git History:** No more polluted "WIP" commits or orphaned submission hashes. One task = one commit.
4. **Simpler Review Context:** The Reviewer always looks at the exact current state of the working directory (`HEAD`), completely eliminating the complex Git history reconstruction logic that currently plagues the system.