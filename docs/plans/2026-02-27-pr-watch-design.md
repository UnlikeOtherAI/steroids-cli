# PR Watch — Automated Pull Request Reviews

> **Status:** Draft (v3 — post Round 3 review, BLOCKED on branch-targeting prerequisite)
> **Prerequisite:** [Branch Targeting Design](./2026-02-27-branch-targeting-design.md) must be implemented first
> **Date:** 2026-02-27
> **Author:** Claude (design), Human (requirements)

## Problem Statement

Steroids automates task-based development but has no way to handle incoming pull requests. Teams must manually review PRs, which is slow for trusted contributors and risky for untrusted ones on public repos.

We need a system that:
1. Monitors a GitHub repo for new/updated PRs on each wakeup cycle
2. Triages PRs based on author trust (org member vs external contributor)
3. Runs automated code reviews and posts comments on the PR
4. Can merge PRs when a human signals readiness via a label

## Current Behavior

The wakeup loop (`src/runners/wakeup.ts`) iterates registered projects and starts runners when pending tasks exist. The global project registry (`projects` table) tracks project paths with an `enabled` flag. There is no concept of "watch an external event source and create work from it."

## Desired Behavior

A new project type — `pr-watch` — that polls GitHub for PRs, creates review tasks, and posts results back to GitHub.

## Design

### Architecture: Separate Project Type

PR-watch is a new first-class project type. Rationale:

- **Clean UX** — `steroids pr-watch init` vs configuring modes on an existing project
- **Separation of concerns** — PR review logic doesn't pollute task/section/runner code
- **Minimal wakeup change** — type check dispatches to a different handler
- **Full infrastructure reuse** — global registry, heartbeat, runners, providers all shared

### Initialization

Command: `steroids pr-watch init [owner/repo]`

Creates `.steroids/steroids.db` (same schema as regular projects plus `pr_watch_state` and `pr_watch_meta` tables) and `.steroids/config.yaml`. Registers in the global project registry with `project_type = 'pr-watch'`.

Auto-detection: if run inside a git clone, extracts `owner/repo` from the `origin` remote.

**Label setup** — creates two GitHub labels via `gh label create --force`:

| Label | Purpose |
|---|---|
| `st:review-requested` | Human signals this PR is ready for Steroids to review |
| `st:ready-to-merge` | Human signals this PR should be merged when CI passes |

All other PR state (approved, changes requested, merged) is tracked through GitHub's native review and merge state — no duplicate labels.

Prerequisites verified during init:
- `gh` CLI is installed and authenticated
- User has write access to the repo
- AI provider is configured

### Configuration Schema

```yaml
prWatch:
  enabled: true
  repo: "owner/repo"

  trust:
    mode: "label"           # "label" | "org-auto"
    orgMembers: []          # Additional trusted usernames beyond org membership

  review:
    goalsFile: ""           # File describing project goals (default: README.md)
    instructions: ""        # Custom review guidance, e.g. "Reject PRs that add new dependencies
                            # without justification. We prefer vanilla JS over frameworks.
                            # Security-sensitive files: src/auth/, src/crypto/"
    maxDiffLines: 2000      # PRs larger than this get a "please split" comment

  merge:
    enabled: false          # Allow Steroids to merge PRs
    strategy: "squash"      # "merge" | "squash" | "rebase"
    requireCI: true         # Wait for CI checks to pass
    instructions: ""        # Custom merge guidance, e.g. "Never merge PRs that modify
                            # the CI pipeline without explicit admin approval.
                            # Squash commits must have conventional commit format."

  poll:
    minIntervalSeconds: 120 # Minimum seconds between polls
    searchBufferSeconds: 120 # Overlap window to compensate for GitHub search indexing lag
```

PR review uses the existing `ai.reviewer` provider/model config — same provider that reviews task submissions. No separate provider config needed.

**Trust modes:**

| Author Type | `label` mode | `org-auto` mode |
|---|---|---|
| Org member | Needs `st:review-requested` | Auto-review |
| Trusted user (in `orgMembers`) | Needs `st:review-requested` | Auto-review |
| External contributor | Needs `st:review-requested` | Needs `st:review-requested` |

- `label`: Default. Every PR needs the label before Steroids touches it.
- `org-auto`: Org members get auto-reviewed; externals need a human to add the label.

Org membership checked via `gh api /orgs/{org}/members/{user}` (204 = member, else external). On API failure, fail safe: treat as external.

### Database Schema

New tables in the project DB:

```sql
-- Per-PR tracking
CREATE TABLE IF NOT EXISTS pr_watch_state (
  pr_number INTEGER PRIMARY KEY,
  head_sha TEXT NOT NULL,
  reviewed_head_sha TEXT,             -- SHA that was actually reviewed (for merge safety)
  pr_state TEXT NOT NULL DEFAULT 'open',  -- open | closed | merged | draft
  base_branch TEXT NOT NULL DEFAULT 'main',
  author TEXT NOT NULL,
  author_is_trusted INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending',
  last_reviewed_at TEXT,
  last_comment_id INTEGER,            -- NULL = no comments seen; tracks latest non-bot comment
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Project-level metadata (single-row key-value)
CREATE TABLE IF NOT EXISTS pr_watch_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: 'last_polled_at', 'bot_username', 'consecutive_poll_failures'
```

`review_status` values: `pending`, `reviewing`, `approved`, `changes_requested`, `merged`, `closed`.

New column in global DB `projects` table:

```sql
ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT 'tasks';
```

### Runner Dispatch for PR Review Tasks

The existing runner loop (`loop.ts`) dispatches tasks to coder or reviewer phases based on task status. PR review tasks require a **different execution path** — they don't run a coder or a standard reviewer. They run a PR-specific review flow that reads a diff from GitHub and posts results back.

**Dispatch mechanism:** Tasks created for PR reviews are placed in a `__pr_reviews__` section. The runner loop checks the section name before dispatching:

```typescript
// In orchestrator-loop.ts, after selectNextTask()
if (selected.task.section_id && getSectionName(db, selected.task.section_id) === '__pr_reviews__') {
  await runPrReviewPhase(selected.task, projectPath, config);
  continue;
}
// ... existing coder/reviewer dispatch
```

`runPrReviewPhase` is a new function in `src/pr-watch/review.ts` that:
1. Reads the PR diff via `gh pr diff`
2. Builds the review prompt (with goals, custom instructions, delimiters)
3. Invokes the `ai.reviewer` provider
4. Parses the structured output (verdict token + JSON comments)
5. Posts the review to GitHub
6. Updates `pr_watch_state` and task status

This keeps the dispatch simple (section name check) and avoids adding a `task_type` column to the tasks schema.

**Merge tasks** follow the same pattern — when a reviewed PR gets `st:ready-to-merge`, the poll creates a new task in the `__pr_reviews__` section with a title prefix `[MERGE]`. The dispatch checks for this prefix and routes to `runPrMergePhase` instead.

### Wakeup Integration

Type-based dispatch in both `wakeup()` and `checkWakeupNeeded()`:

```typescript
// In wakeup() project iteration
for (const project of registeredProjects) {
  if (project.type === 'pr-watch') {
    await handlePrWatchWakeup(project, globalDb, options);
    continue;
  }
  // ... existing task-based wakeup logic (unchanged)
}

// In checkWakeupNeeded() — also needs the dispatch
for (const project of registeredProjects) {
  if (project.type === 'pr-watch') {
    if (existsSync(project.path) && prWatchHasPendingWork(project.path)) {
      projectsWithWork++;
    }
    continue;
  }
  // ... existing pending work check
}
```

`handlePrWatchWakeup`:

1. **Skip if too soon** — read `last_polled_at` from `pr_watch_meta`; skip if less than `minIntervalSeconds` elapsed
2. **Poll GitHub** — `gh pr list --repo owner/repo --json number,title,labels,author,headRefOid,state,updatedAt,isDraft --state all --search "updated:>POLL_TIMESTAMP"`
   - Timestamp format: ISO 8601 with Z suffix (e.g., `2026-02-27T10:00:00Z`)
   - `POLL_TIMESTAMP` = `last_polled_at` minus `searchBufferSeconds` (default 120s overlap to handle GitHub search indexing lag)
   - **First poll** (no `last_polled_at`): use `--state open` without `--search` filter (only current open PRs, not historical)
3. **Filter by trust model** — apply trust rules
4. **Diff against `pr_watch_state`** — detect new PRs, updated PRs (head_sha changed), state transitions (closed, merged, draft→ready, reopened)
5. **Create/update tasks** — new PRs become pending tasks in `__pr_reviews__` section; updated PRs get their task reset to pending
6. **Handle state transitions:**
   - `draft` PRs: tracked in `pr_watch_state` but no task created until `isDraft=false`
   - `reopened` PRs (state was closed, now open): reset to pending if previously closed
   - Label removed (`st:ready-to-merge`): cancel pending merge task if any
7. **Start runner** — if pending tasks exist, reuse existing `startRunner()` logic
8. **Track failures** — on poll error, increment `consecutive_poll_failures` in `pr_watch_meta`; auto-disable project after 10 consecutive failures; reset to 0 on success

`prWatchHasPendingWork()` queries `pr_watch_state` for rows with `review_status = 'pending'`, not the generic `projectHasPendingWork()` which uses `selectNextTask()`.

### PR Review Lifecycle

```
PR opened/labeled → task created (pending)
                         ↓
                  Runner picks up task (section = __pr_reviews__)
                         ↓
            ┌──────────────────────────┐
            │ Review                   │
            │ - Diff analysis          │
            │ - Project goals context  │
            │ - Custom instructions    │
            │ - Line-specific feedback │
            │ - Security check         │
            │ - Overall verdict        │
            └────────────┬─────────────┘
                         ↓
            Post overall verdict: gh pr review --body-file (approve/request changes)
            Post line comments: gh api for inline review comments
            Record reviewed_head_sha in pr_watch_state
                         ↓
            Task → completed
                         ↓ (if merge.enabled + st:ready-to-merge label)
            ┌──────────────────────────┐
            │ Merge                    │
            │ - Verify head_sha ==     │
            │   reviewed_head_sha      │
            │ - Check CI via gh        │
            │ - Apply merge.instructions│
            │ - gh pr merge (remote)   │
            │ - If conflicts: comment  │
            │   asking author to       │
            │   rebase, remove label   │
            └──────────────────────────┘
```

### Review Prompt

The PR review prompt is distinct from the task reviewer. It receives:

- **PR metadata**: title, description, author, base branch
- **Full diff**: from `gh pr diff PR_NUMBER`
- **Project goals**: content from README.md or configured `goalsFile`
- **Custom instructions**: user-provided `review.instructions`
- **Previous review**: if this is a re-review after new commits

All untrusted content (diff, title, description, comments) is wrapped in explicit delimiters (e.g., `<pr-diff>...</pr-diff>`) to mitigate prompt injection. The LLM's verdict token is validated by a deterministic policy gate — the LLM cannot directly trigger merge/approve actions.

Output format: first line = `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`. Followed by a JSON block:

```json
{
  "summary": "Overall review summary",
  "comments": [
    { "path": "src/foo.ts", "line": 42, "body": "This null check is missing" }
  ]
}
```

**Malformed output handling:** If the verdict line is missing or the JSON block fails to parse, the review is treated as a failure — task stays in `reviewing`, the runner retries on the next cycle (up to the standard retry limit). No review is posted to GitHub on parse failure.

**Posting to GitHub:**
- Overall verdict: `gh pr review PR_NUMBER --approve --body-file /tmp/review.md` or `--request-changes --body-file /tmp/review.md`
- Line-specific comments: `gh api repos/{owner}/{repo}/pulls/{pr}/reviews --method POST` with comment positions mapped from the JSON output
- If line mapping fails for a specific comment (e.g., line not in diff), fall back to including it in the overall review body

### Merge Flow

When `merge.enabled` is true and a PR has `st:ready-to-merge`:

1. **Verify reviewed SHA** — check `pr_watch_state.reviewed_head_sha == current head_sha`. If different, the PR has unreviewed commits — post comment "New commits since last review. Please request a new review before merging." Remove `st:ready-to-merge`.
2. Check CI via `gh pr checks PR_NUMBER`
3. Apply custom `merge.instructions` policy (e.g., block merges that touch CI pipeline files)
4. If CI passing and policy satisfied: `gh pr merge PR_NUMBER --squash` (remote operation, no local git)
5. If conflicts: post comment asking author to rebase, remove `st:ready-to-merge`
6. If CI failing: post comment, wait for next cycle

No auto conflict resolution in v1. No local git operations for merge — `gh pr merge` is a remote API call.

### State Change Detection

On each poll cycle:

| Change | Detection | Action |
|---|---|---|
| New PR (non-draft) | PR number not in `pr_watch_state` | Create task |
| New commits | `head_sha` changed | Reset task to pending |
| Draft → ready | `isDraft` changed to false | Create task |
| PR reopened | `pr_state` was closed, now open | Reset to pending |
| Label added (`st:review-requested`) | Label present, no task | Create task |
| Label added (`st:ready-to-merge`) | Label present, review done, SHA matches | Create merge task |
| Label removed (`st:ready-to-merge`) | Label absent, merge task pending | Cancel merge task |
| PR closed/merged | `pr_state` changed | Mark task completed |

Comments from the bot's own GitHub user (detected via `gh api user` on first poll, cached in `pr_watch_meta`) are filtered out to prevent self-triggering review loops. Re-reviews are debounced: minimum 5 minutes between reviews of the same PR.

DB writes happen BEFORE GitHub API calls. If the GitHub call fails, DB still reflects intent — next poll cycle retries. This prevents duplicate GitHub posts on retry.

Concurrent review cap: task creation uses a SQL transaction — `BEGIN IMMEDIATE; SELECT COUNT(*) FROM pr_watch_state WHERE review_status = 'reviewing'; [only INSERT if under limit]; COMMIT;`. The `busy_timeout` pragma handles contention.

### CLI Commands

```
steroids pr-watch init [owner/repo]     Initialize PR watching
steroids pr-watch status                Show watched PRs and their state
steroids pr-watch review <PR_NUMBER>    Manually trigger review
steroids pr-watch merge <PR_NUMBER>     Manually trigger merge
```

Other operations reuse existing commands:
- `steroids projects list` — shows pr-watch projects (with type column)
- `steroids projects disable <path>` — pauses watching (auto-disabled projects show warning in `pr-watch status`)
- `steroids projects enable <path>` — re-enables + resets `consecutive_poll_failures` to 0
- `steroids config` — edits pr-watch config

### File Structure

```
src/pr-watch/
  index.ts              Module exports
  poll.ts               GitHub polling, triage, state tracking, pr_watch_meta queries
  review.ts             PR review prompt generation, output parsing, posting to GitHub
  merge.ts              SHA verification, CI check, gh pr merge
  types.ts              TypeScript interfaces

src/commands/
  pr-watch.ts           CLI command group
```

### Infrastructure Reuse

**Reused without changes:**
- Global project registry, runner heartbeat, provider invocation + logging
- Wakeup scheduling (cron/launchd), config loading, health monitoring

**Extended minimally:**
- `projects` table: new `project_type` column (migration)
- `RegisteredProject` interface + `getRegisteredProjects()` / `registerProject()` + all callers
- `wakeup()` and `checkWakeupNeeded()`: type-based dispatch
- `orchestrator-loop.ts`: section-name dispatch for `__pr_reviews__` tasks
- Config schema: new `prWatch` section

**Not duplicated (use GitHub's own):**
- Branch deletion on merge (GitHub repo setting)
- CI checks (GitHub Actions / checks API)
- Review state display (GitHub's "approved" / "changes requested" badges)
- Merge state (GitHub's own merged indicator)
- Notifications (GitHub's PR notification system)

## Implementation Order

### Phase 1: Foundation
1. Global DB migration: `project_type` column on `projects`
2. Update `RegisteredProject` interface, `getRegisteredProjects()`, `registerProject()`, and all callers
3. Project DB migration: `pr_watch_state` + `pr_watch_meta` tables
4. Config schema: `prWatch` section
5. `src/pr-watch/types.ts`

### Phase 2: Polling + Wakeup
6. `src/pr-watch/poll.ts`: GitHub polling via `gh`, triage, state tracking, meta queries
7. Wakeup integration: type dispatch in both `wakeup()` and `checkWakeupNeeded()`
8. `prWatchHasPendingWork()` function

### Phase 3: Review
9. `src/pr-watch/review.ts`: prompt generation, output parsing, GitHub posting
10. Runner dispatch: section-name check in `orchestrator-loop.ts` for `__pr_reviews__`

### Phase 4: Merge + CLI
11. `src/pr-watch/merge.ts`: SHA verification, CI check, merge
12. `src/commands/pr-watch.ts`: init (with label setup), status, review, merge

## Edge Cases

| Scenario | Handling |
|---|---|
| PR updated while review in progress | Current review finishes; next poll detects SHA mismatch, re-queues |
| Merge requested but SHA doesn't match reviewed SHA | Post comment requiring re-review; remove `st:ready-to-merge` |
| Merge conflicts | Post comment asking author to rebase; remove `st:ready-to-merge` |
| CI fails | Post comment; wait for next cycle |
| GitHub API rate limiting | Exponential backoff via existing `provider_backoffs` table |
| PR closed while merge in progress | Detect closed state, abort, mark completed |
| Multiple PRs open | Each is an independent task; runner processes sequentially |
| Fork PR | Review works (read diff); merge posts comment if conflicts |
| Large PR (>2000 lines) | Skip review, post comment suggesting split |
| `gh` CLI missing | Error during init; skip during wakeup with warning |
| Repo access revoked | Detect 403; auto-disable after 10 consecutive failures |
| Prompt injection in PR content | Untrusted content in delimited blocks; deterministic policy gate for verdicts |
| Draft PR | Tracked but no task created until draft status removed |
| PR reopened after close | Reset to pending, eligible for review again |
| `st:ready-to-merge` removed | Cancel pending merge task |
| Malformed review output | Treated as failure; retry on next cycle; no review posted |
| First poll on new project | Uses `--state open` only (no historical lookback) |
| Review output line mapping fails | Comment falls back to overall review body |
| Auto-disabled project re-enabled | `consecutive_poll_failures` reset to 0; `pr-watch status` shows warning |

## Non-Goals

- **Webhook-based triggers** — polling is sufficient for v1
- **Auto conflict resolution** — deferred to v2 with author opt-in
- **Multi-repo in one project** — each repo is a separate pr-watch project
- **PR creation** — Steroids reviews PRs, doesn't create them
- **Issue triage** — PRs only
- **Large PR chunked review** — v2 feature
- **GitLab/Bitbucket/Azure DevOps** — GitHub only for v1
- **Parallel PR reviews** — single runner processes tasks sequentially; parallel is a v2 optimization
- **Outbox pattern for GitHub API idempotency** — DB-before-GitHub write order is sufficient for v1

---

## Cross-Provider Review (Round 1)

> Reviewed by: **Codex** (gpt-5.3-codex) and **Claude Opus 4.6** — Date: 2026-02-27

Findings consolidated with adopt/defer/reject decisions. The design incorporates all "ADOPT" decisions:

- **C1. Prompt injection** — ADOPTED: delimited blocks + deterministic policy gate
- **C2. Shell injection** — ADOPTED: `--body-file` with temp files, no string interpolation
- **C3. Polling misses state transitions** — ADOPTED: `--state all --search "updated:>TIMESTAMP"`
- **C4. `projectHasPendingWork()` mismatch** — ADOPTED: dedicated `prWatchHasPendingWork()`
- **C5. No concurrency locking** — ADOPTED: `review_status` as lock + transactional cap
- **H1. Self-triggering loops** — ADOPTED: filter bot comments + 5-min debounce
- **H2. Working tree isolation** — ADOPTED: all operations via `gh` remote API, no local git
- **H3. Rate limiting** — ADOPTED: `minIntervalSeconds: 120` + backoff
- **H4. Large PRs** — ADOPTED: hard limit (2000 lines) with "please split" comment
- **H5. RegisteredProject scope** — ADOPTED: full audit of callers in implementation
- **H6. Non-atomic side effects** — ADOPTED: DB-before-GitHub write order
- **M1. No auto conflict resolution in v1** — ADOPTED
- **M3. Org membership fail-safe** — ADOPTED: treat unknown as external
- **M6. Label reconciliation** — ADOPTED: `--force` flag
- **M7. Max concurrent reviews** — ADOPTED (removed config; single runner = sequential)
- **L1. NULL for last_comment_id** — ADOPTED
- **L2. Auto-disable after failures** — ADOPTED: 10 consecutive failures
- **L3. Events config** — ADOPTED: removed entirely, always check everything

Deferred: `gh` CLI vs GraphQL client (M4), separate DB (M2), config location (M5).

## Cross-Provider Review (Round 2)

> Reviewed by: **Codex** and **Claude Opus 4.6** — Date: 2026-02-27
> Focus: issues remaining after simplification pass

Round 2 findings and decisions:

- **R2-C1. Merge not pinned to reviewed SHA** (Codex) — ADOPTED: added `reviewed_head_sha` column; merge verifies match
- **R2-C2. Runner has no PR-review dispatch path** (Codex, Claude) — ADOPTED: section-name dispatch via `__pr_reviews__`; merge tasks use `[MERGE]` title prefix
- **R2-H1. `last_polled_at` has no storage** (Claude) — ADOPTED: added `pr_watch_meta` table
- **R2-H2. `maxConcurrentReviews` vs single runner** (Codex) — ADOPTED: removed config; single runner processes sequentially; parallel is a v2 non-goal
- **R2-H3. Inline comments need `gh api`, not `gh pr review`** (Codex, Claude) — ADOPTED: specified exact API paths; fallback for unmappable lines
- **R2-H4. `checkWakeupNeeded()` also needs dispatch** (Claude) — ADOPTED: added to wakeup integration
- **R2-H5. `RegisteredProject` interface update scope** (Claude) — ADOPTED: explicit Phase 1 task
- **R2-M1. Timestamp format fragile** (Claude) — ADOPTED: ISO 8601 with Z suffix; `searchBufferSeconds` overlap
- **R2-M2. Concurrent review cap race** (Claude) — ADOPTED: SQL `BEGIN IMMEDIATE` transaction
- **R2-M3. Review output malformed handling** (Codex) — ADOPTED: hard-fail, no post, retry next cycle
- **R2-M4. Draft/reopened/label-removal transitions** (Codex) — ADOPTED: full state transition table
- **R2-M5. AI provider config unspecified** (Claude) — ADOPTED: explicitly reuses `ai.reviewer`
- **R2-L1. First poll returns all PRs** (Claude) — ADOPTED: first poll uses `--state open` only
- **R2-L2. Auto-disable recovery path** (Claude) — ADOPTED: `projects enable` resets counter; `pr-watch status` shows warning

Deferred: outbox pattern (R2-H5, Codex), label actor authorization (R2-M7, Codex — GitHub permissions handle this).

## Simplification Pass

Removed from original design per AGENTS.md "Simplification First":

| Removed | Reason |
|---|---|
| `open` trust mode | Dangerous for public repos; user explicitly wants triage |
| `st:approved`, `st:changes-requested`, `st:merged` labels | Duplicate GitHub's native review/merge state |
| Separate "Goals Alignment" phase | Just context in the review prompt, not a separate phase |
| `poll.triggers` / `poll.events` config | Always check everything; no user benefit to partial detection |
| `review.postComments` toggle | If reviewing, always post |
| `review.requestChanges` toggle | Always use GitHub's "request changes" review type |
| `merge.deleteBranch` | User said "don't duplicate GitHub's own settings" |
| `merge.autoRebase` | No auto conflict resolution in v1 |
| `queued_head_sha` column | Natural poll cycle handles re-queue |
| `poll.maxProjectsPerCycle` | `minIntervalSeconds` per-project is sufficient |
| `botUsername` config | Auto-detected at runtime via `gh api user` |
| `maxConcurrentReviews` config | Single runner = sequential processing; parallel is v2 |
| 4 CLI commands (list, config, pause, resume) | Reuse existing `projects` and `config` commands |
| 4 source files (labels.ts, triage.ts, state.ts, review-post.ts) | Consolidated into poll.ts, review.ts |
| `review.autoApprove` config | v1 always posts review; human decides to merge |
