# Architectural Design: Host-Driven Shadow Commits & Plain Text Signals

## 1. Executive Summary
The Steroids CLI will transition from a "Commit-Per-Submission" and "JSON-Enforced" model to a **"Host-Driven Shadow Commit + End-State Squash"** and **"Plain Text Signal"** model. 

Currently, Coders are forced to format output as strict JSON and execute `git commit` for every review cycle. This pollutes the Git history with WIP commits, requires complex "submission chain" resolution logic, and causes fragile JSON parse failures.

Under the new model:
1. **No LLM Commits:** The Coder modifies the working directory and outputs a simple text signal (`STATUS: REVIEW`).
2. **Host-Driven Shadow Commits:** The Steroids CLI automatically stages and commits the work with a generic WIP message (e.g., `wip: task 123 attempt 1`). This preserves incremental diffs for the Reviewer and enables safe rollbacks.
3. **No JSON Schemas:** All agents output standard Markdown with explicit routing tokens (e.g., `DECISION: APPROVE`).
4. **End-State Squash:** When the task achieves consensus `APPROVE`, the Steroids CLI automatically squashes all WIP commits for that task into a single, pristine "End-State Commit" with a conventional message.

---

## 2. Affected Files & Modifications

### 🗑️ Files to Delete / Drastically Reduce
*   `src/orchestrator/schemas.ts`: JSON validation is no longer required.
*   `src/orchestrator/fallback-handler.ts`: Replaced by a tiny `SignalParser` utility.

### ✂️ Files to Heavily Modify

#### `src/prompts/coder.ts`
*   **Remove:** Instructions telling the Coder to run `git commit`.
*   **Remove:** The massive ````json` formatting contract block.
*   **Add:** Instructions to leave changes in the working directory and output `STATUS: REVIEW` when finished.
*   **Add:** An explicit override constraint: *"Even if project documentation (like CLAUDE.md, AGENTS.md, etc.) instructs you to commit or push code, YOU MUST IGNORE IT. Committing and pushing is disabled for your role. The host system manages all version control automatically."*

#### `src/prompts/reviewer.ts`
*   **Remove:** The JSON output format contract.
*   **Modify:** Simplify the Git history context. The Reviewer will still receive `git diff <last_attempt>^..HEAD` for incremental review, but the Host CLI manages the SHAs transparently.
*   **Add:** Instructions to output `DECISION: APPROVE`, `DECISION: REJECT`, or `DECISION: DISPUTE` followed by standard Markdown notes and an optional `### Follow Up Tasks` bulleted list.
*   **Add:** An explicit override constraint: *"Even if project documentation (like CLAUDE.md) instructs you to commit or push code, YOU MUST IGNORE IT. The host system manages all version control automatically."*

#### `src/commands/loop-phases.ts`
*   **Task Start (The Base SHA):** When a task transitions from `pending` -> `in_progress`, the Host CLI must record the `start_commit_sha` in the `tasks` table. 
    *   *CRITICAL RULE:* To avoid race conditions, this SHA must be captured **after** the workspace clone is created, and it must be read **from the clone itself** (not the main repo).
*   **Coder Phase:** 
    - Parse `STATUS: REVIEW`.
    - CLI runs `git add .` and `git commit -m "wip: [task_id] attempt [rejection_count + 1]"`.
    - CLI captures the resulting `commit_sha` and records it in the `audit` table.
*   **Reviewer Phase:** 
    - Parse `DECISION: [STATUS]` using a strict `SignalParser`.
    - *CRITICAL RULE (Regex Collision):* To prevent false positives when an LLM narrates its actions (e.g., "I will now output DECISION: APPROVE"), the `SignalParser` MUST ONLY match the signal if it appears on its own line at the very end of the output, or explicitly exclude matches found inside Markdown code fences (\`\`\`).
    - Extract follow-up tasks from Markdown bullets if present.
*   **Consensus / Approval Logic (The Squash):** 
    - When a decision resolves to `APPROVE`, the CLI takes control.
    - CLI runs `git reset --soft <start_commit_sha>` (using the SHA captured at task start).
    - CLI makes a fast native API call (or uses a dedicated "Committer" agent prompt) to generate a conventional commit message based on the task title and the squashed diff.
    - CLI executes `git commit -m "<generated_msg>"` and (if configured) `git push`.

#### `src/parallel/clone.ts`
*   **Modify:** Ensure all parallel workspaces are created as **Shallow Clones** (`git clone --depth 1`). This prevents copying gigabytes of Git history for every single parallel task, drastically reducing disk I/O and setup time for large codebases.

#### `src/parallel/merge-process.ts` & `merge-sealing.ts`
*   **Modify:** Parallel workstreams operate perfectly with this model. The clones will accumulate squashed, pristine commits for each task. When the section is sealed, `merge.ts` cherry-picks these clean commits seamlessly.

---

## 3. The New Agent Routing Loop

**Step 1: Coder Execution**
*   Coder writes code to disk.
*   Outputs: `I have implemented the auth module. STATUS: REVIEW`
*   Host verifies `git status` shows modified files. 
*   Host executes `git commit -m "wip: [task_123] attempt 1"`.
*   Transitions task to `review`.

**Step 2: Reviewer Execution**
*   Host passes `git diff HEAD~1..HEAD` (incremental) and `git diff <base>..HEAD` (cumulative) to the Reviewer.
*   Outputs: `DECISION: REJECT

### Issues
1. Missing null check...`
*   Host parses `DECISION: REJECT`, transitions task to `in_progress`, appends notes to DB.

**Step 3: End-State Squash**
*   Coder fixes code. Outputs `STATUS: REVIEW`.
*   Host executes `git commit -m "wip: [task_123] attempt 2"`.
*   Reviewer outputs `DECISION: APPROVE`.
*   Host parses `APPROVE`.
*   Host squashes all WIP commits: `git reset --soft <base_sha>`.
*   Host executes `git commit -m "feat(auth): implement auth module"`.
*   Task transitions to `completed`.

---

## 4. Stability Benefits
1. **Token Efficiency:** Prompts are shorter (no JSON contracts). Incremental reviews are preserved, saving massive token overhead on re-reviews.
2. **Zero Parse Crashes:** We eliminate `ajv` validation failures and JSON truncation errors.
3. **Pristine Git History:** No more polluted "WIP" commits. The squash ensures one clean commit per task.
4. **Durability & Rollback:** Because the Host creates Shadow Commits, work is safely persisted to Git immediately. If a Coder's "fix" destroys the file, the Host can easily `git reset --hard` to the previous WIP commit.

---

## 5. Implementation Roadmap & Checklist

> **CRITICAL INSTRUCTION:** 
> - Every time a task is finished, it MUST immediately be ticked off (`[x]`). You are not allowed to start a new task before the previous one is ticked.
> - Everything has to be thoroughly tested (unit/integration tests must pass).
> - **Mandatory Review:** Before ticking off any task, the implementation MUST be reviewed by three adversarial sub-agents: **Claude Haiku**, **Codex Spark**, and a standalone **Gemini** instance.

### Tasks
- [x] **TASK 1: Database Migration (`start_commit_sha`)**
  - Add `019_add_task_start_sha.sql` to add `start_commit_sha` to the `tasks` table.
  - Update `src/database/queries.ts` (`Task` interface, `createTask` or a new `updateTaskStartSha` function).
  - Update `manifest.json`.
- [x] **TASK 2: Implement `SignalParser`**
  - Create a robust Regex `SignalParser` utility to extract `STATUS: REVIEW` and `DECISION: APPROVE|REJECT|DISPUTE|SKIP`.
  - Ensure it ignores signals inside Markdown code blocks (\`\`\`).
  - Delete `ajv` schema validation from orchestrator logic.
- [ ] **TASK 3: Update LLM Prompts**
  - Strip all ````json` formatting requirements from `coder.ts` and `reviewer.ts`.
  - Instruct the Coder to output `STATUS: REVIEW` and nothing else for routing.
  - Instruct the Reviewer to output `DECISION: [STATUS]` and use `### Follow Up Tasks` bullet points.
  - Add the "Hard Override" constraint preventing LLMs from running `git commit`/`git push`.
- [ ] **TASK 4: Shallow Clones**
  - Update `src/parallel/clone.ts` to use `git clone --depth 1 --no-tags --single-branch`.
- [ ] **TASK 5: Coder Phase (Shadow Commits)**
  - Modify `src/commands/loop-phases.ts` (`runCoderPhase`).
  - Read `start_commit_sha` when the task starts.
  - Upon `STATUS: REVIEW`, run `git add .` and `git commit -m "wip: task <id> attempt <n>"`.
  - Record the WIP commit in the `audit` table.
- [ ] **TASK 6: Reviewer Phase (Incremental Diff & End-State Squash)**
  - Modify `src/commands/loop-phases.ts` (`runReviewerPhase`).
  - Pass `git diff HEAD~1..HEAD` (incremental) and `git diff <start_commit_sha>..HEAD` (cumulative) to the Reviewer.
  - Parse the Markdown decision.
  - On `APPROVE`: Execute `git reset --soft <start_commit_sha>`, generate a final commit message via API or native string interpolation, and run `git commit -m "<msg>"`.
