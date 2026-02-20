# Parallelism: Worktree-Orchestrated Execution (Hardened)

> Run independent sections in parallel using Git worktrees. Each workstream gets a dedicated branch + worktree + runner lease. Merge and cleanup are fenced, resumable, and crash-safe.

---

## 1. Problem Statement

Steroids currently leaves throughput on the table when independent sections are processed serially. Parallel execution can reduce wall-clock time, but only if race conditions, crash recovery, merge correctness, and cleanup are deterministic.

---

## 2. Current Behavior (Codebase References)

- Runner lifecycle: `src/commands/runners.ts`, `src/runners/daemon.ts`.
- Wakeup/restart flow: `src/runners/wakeup.ts`.
- Parallel scaffolding: `src/commands/runners-parallel.ts`, `src/commands/workspaces.ts`.
- Loop orchestration: `src/commands/loop.ts`, `src/commands/loop-phases.ts`.
- Parallel merge helpers: `src/parallel/merge.ts`, `src/parallel/merge-lock.ts`, `src/parallel/merge-progress.ts`.

Current behavior is not fully hardened for worktree-parallel crash/recovery edge cases.

---

## 3. Desired Behavior

1. Partition sections into independent workstreams.
2. Create one branch + one worktree per workstream.
3. Run one leased runner per workstream.
4. Seal each completed workstream to immutable merge input.
5. Merge in a dedicated integration worktree (not the user checkout).
6. Resolve merge conflicts with existing coder/reviewer flow.
7. Validate merged state before push.
8. Cleanup branches/worktrees with quiesce+verification gates.
9. Resume safely after crashes with deterministic reconciliation.

---

## 4. Design

### 4.1 Workstream Partitioning

1. Validate section dependency graph is acyclic.
2. Build connected components (undirected dependency edges).
3. Each component becomes one workstream.
4. Topologically order sections inside each workstream.

### 4.2 Identity, Admission, and Naming

Canonical repo identity:

- `project_repo_id = realpath(git rev-parse --show-toplevel)`

Parallel session admission:

- Exactly one active session per `project_repo_id`.
- Enforce with unique-active-session constraint for all non-terminal statuses.
- Terminal statuses are only:
  - `completed`, `aborted`, `failed`
- Blocked statuses remain active (must prevent new sessions):
  - `blocked_conflict`, `blocked_recovery`, `blocked_validation`

Naming:

- Worktree directory: `~/.steroids/worktrees/<project-repo-hash>/ws-<session-hash>-<workstream-id>`
- Workstream branch: `steroids/ws-<session-hash>-<workstream-id>`

### 4.3 Workstream Ownership and Fencing

Each workstream row includes:

- `runner_id`
- `claim_generation` (monotonic fence)
- `lease_expires_at`

Rules:

1. Runner claim must be CAS-based.
2. Lease renewal interval: 30s.
3. Lease TTL: 120s.
4. Every mutating action must verify current `claim_generation`:
   - commit
   - push
   - seal operation
   - workstream status transition
5. If fence check fails, runner must stop immediately (read-only/exit).

### 4.4 Process Launch and CWD Safety

All spawned runner/provider processes must set explicit `cwd`:

- Runner `cwd = worktree_path`
- Provider subprocess `cwd = worktree_path`

No inherited cwd is allowed in detached or wakeup paths.

### 4.5 Shared Steroids State and DB Guardrails

State coherence requirement:

- Workstreams share Steroids task state (single source of truth) for locks/rejections/audit.

DB guardrails:

1. Preflight migration runs once before fan-out.
2. Migration is serialized by schema gate lock.
3. Write-heavy paths use retry with backoff+jitter.
4. Parallelism is capped (`maxClones` default 3).
5. If lock contention exceeds threshold, fail session fast to `blocked_recovery`.
6. High-frequency logs should not saturate the shared DB write path (file-backed runner logs preferred; DB stores status transitions and summaries).

### 4.6 Worktree Hydration

Before launching each runner:

1. Apply configured env hydration strategy:
   - copy/symlink required env files
2. Apply dependency hydration strategy:
   - configured install command or supported shared-cache strategy
   - shared mutable dependency directories across workstreams are forbidden
3. Validate hydration success before claiming workstream `running`.

### 4.7 Sealed Workstream Completion

When a workstream finishes:

1. Push branch.
2. Seal immutable merge input:
   - `sealed_base_sha`
   - ordered `sealed_commit_shas[]`
   - `sealed_head_sha`
3. Mark `completed`.

Post-seal rule:

- Any further pushes/commits to the workstream branch are rejected.

### 4.8 Merge Orchestrator (Dedicated Integration Worktree)

Merge runs in `ws-integration` worktree, never in the user’s primary checkout.

Integration branch rule:

- Integration worktree uses a temporary branch:
  - `steroids/integration-<session-hash>`
- It is forked from merge target (for example `main`) and deleted during cleanup.

Steps:

1. Acquire merge lock using atomic CAS with fencing token:
   - `merge_locks.lock_epoch`
   - lock TTL: 600s
   - heartbeat/renewal interval: 60s
2. Verify lock epoch before every mutating step:
   - cherry-pick/merge application
   - conflict continuation commit
   - push
   - merge-progress write
3. Fetch all sealed workstream branches.
4. Update integration base (`pull --ff-only`).
   - if ff-only fails, attempt rebase of integration branch onto target head
   - if rebase drift exceeds `max_base_drift_commits` (default 50), set `blocked_recovery`
   - rebase is allowed only before first commit reaches `merge_progress.state = applying/applied`
   - if any commit application already started, ff-only failure must set `blocked_recovery` (no mid-merge rebase)
5. Merge strategy is explicit: cherry-pick.
   - apply exactly `sealed_commit_shas[]` in deterministic order
   - record `applied_commit_sha` for each sealed source commit
   - persist provenance mapping `sealed_commit_sha -> applied_commit_sha` (or equivalent durable metadata)
6. On conflict:
   - create conflict task
   - run coder/reviewer inline
   - persist conflict attempts and backoff
7. After all applied, run integration validation gate.
   - validation failure must hard-stop push and set `blocked_validation`
8. Push integration branch (and main target as configured).

Deterministic order:

- `completion_order` only (monotonic integer assigned atomically at completion).
- `completed_at` is diagnostic only.

### 4.9 Merge Progress Durability

Persist per-commit state machine:

- `planned -> applying -> applied`
- `conflict` / `skipped` / `failed` as explicit terminal markers
- include `applied_commit_sha` for successful cherry-picks

Crash recovery rule:

1. On resume, for each sealed commit:
   - check durable provenance mapping (`sealed_commit_sha -> applied_commit_sha`)
   - verify `applied_commit_sha` reachability in integration history
2. Reconcile state and continue without double-apply or silent skip.

### 4.10 Conflict Resolution Limits

Persist per-conflict fields:

- `conflict_attempts`
- `last_conflict_error`
- `next_retry_at`

Policy:

- max conflict attempts default 5
- exponential backoff between attempts
- on cap: mark `blocked_conflict` and pause session for manual unblock

### 4.11 Cleanup (Quiesce First, Then Delete)

Cleanup is idempotent and resumable.

Mandatory sequence:

1. Enter `cleanup_draining`.
2. Revoke leases for all workstreams.
3. Terminate/confirm dead all runners (PID+identity check).
4. Wait for lease expiry + runner-dead confirmation.
5. Verify all `sealed_head_sha` are integrated.
   - for cherry-pick mode, verify all sealed commits have `merge_progress.state = applied` and reachable `applied_commit_sha`
6. Remove local worktrees.
   - use `git worktree remove --force` after integration verification
7. Remove local workstream branches.
8. Delete remote workstream branches (non-blocking if permission/hook rejects).
9. Prune worktree metadata.
10. Mark workstreams `cleaned`, session `completed`.

Failure policy:

- Persist `cleanup_status`, `cleanup_error`, `cleanup_warnings`.
- Resume from last successful cleanup step.
- Remote branch deletion failure may produce warning but must not block session completion.

### 4.12 Recovery and Reconciliation Matrix

Reconcile tuple:

- `{session_status, workstream_status, worktree_exists, branch_exists, runner_alive, lease_valid}`

Requirements:

1. Deterministic action mapping table is mandatory.
2. Unknown tuple -> `alert_and_noop` (no destructive guessing).
3. Persist `last_reconciled_at`, `last_reconcile_action`.
4. Persist `recovery_attempts` per workstream/session.
5. Use exponential backoff for repeated recovery attempts.
6. On cap, mark `blocked_recovery`.

Canonical reconciliation table (minimum required):

| session | workstream | worktree | branch | runner | lease | action |
|---|---|---|---|---|---|---|
| running | running | yes | yes | yes | yes | noop (healthy) |
| running | running | yes | yes | no | yes/no | revoke lease, mark interrupted, re-claim on wakeup |
| running | running | yes | yes | yes | no | fence-stop runner, revoke lease, mark interrupted |
| running | running | no | yes | no | any | mark `blocked_recovery` (worktree lost) |
| running | running | yes | no | any | any | mark `blocked_recovery` (branch lost) |
| running | completed | yes/no | yes | no | yes/no | eligible for merge |
| running | completed | any | no | any | any | mark `blocked_recovery` (sealed branch lost) |
| cleanup_draining | any | yes | any | yes | any | terminate runner, wait, retry cleanup |
| cleanup_draining | any | yes | any | no | any | remove worktree, continue cleanup |
| any | cleaned | no | no | no | no | noop (already clean) |
| any unknown tuple | any | any | any | any | any | alert_and_noop |

### 4.13 Session Limits and Cost Guardrails

1. `max_duration_seconds` per session (default 4h).
2. Optional API call budget per session.
3. Resource preflight before fan-out:
   - memory / disk / runner capacity checks
4. Auto-downshift `maxClones` if resources are below safe thresholds.

---

## 5. Data Model

### Global DB

- `parallel_sessions(...)`
  - includes: `project_repo_id`, `status`, `cleanup_status`, `cleanup_error`, `cleanup_warnings`, `max_duration_seconds`, `created_at`, `completed_at`
- `workstreams(...)`
  - includes: `branch_name`, `worktree_path`, `runner_id`, `claim_generation`, `lease_expires_at`, `sealed_base_sha`, `sealed_head_sha`, `sealed_commit_shas`, `conflict_attempts`, `recovery_attempts`, `next_retry_at`, `last_error`, `cleaned_at`
- `runners.parallel_session_id`

### Project DB

- `merge_locks(...)`
  - includes: `lock_epoch`, `runner_id`, `expires_at`, `heartbeat_at`
- `merge_progress(...)`
  - includes: `sealed_commit_sha`, `applied_commit_sha`, `state(planned|applying|applied|conflict|skipped|failed)`, `attempts`, `applied_at`
  - invariant: `(session_id, workstream_id, sealed_commit_sha)` is unique
  - invariant: `applied_commit_sha` is required when `state = applied`

---

## 6. Implementation Order

### Phase 1: Admission + Ownership Hardening

1. Add `project_repo_id` and active-session uniqueness.
2. Add workstream CAS leases and fence checks.
3. Add deterministic completion ordering.

### Phase 2: Worktree Provisioning + Hydration

1. Implement worktree create/list/remove/reconcile module.
2. Implement env/dependency hydration strategy.
3. Launch runners with strict worktree cwd.

### Phase 3: Sealed Merge + Validation

1. Add sealing fields and immutable commit-set capture.
2. Implement integration-worktree merge.
3. Implement merge lock epoch fencing.
4. Implement post-merge validation gate.

### Phase 4: Durable Recovery + Cleanup

1. Implement merge-progress state machine resume logic.
2. Implement reconciliation matrix and bounded retries.
3. Implement cleanup_draining and idempotent cleanup resume.

### Phase 5: Operational Guardrails

1. Session duration/API budget enforcement.
2. Resource preflight + auto-downshift.
3. Diagnostics and repair commands.

---

## 7. Edge Cases

| Scenario | Risk | Handling |
|---|---|---|
| Double session start for same repo | Branch/worktree collision | Unique active-session admission lock on `project_repo_id` |
| Stale runner keeps mutating after lease loss | Branch corruption | `claim_generation` fencing on every git/db mutation |
| Merge lock expires mid-merge | Dual merger writes | `lock_epoch` fencing check before each mutating step |
| Commit-set drift after completion | Wrong commits merged | immutable `sealed_commit_shas[]` merge input |
| Resume after crash double-applies commit | History corruption | durable per-commit merge state machine + ancestry check |
| Cleanup removes while runner alive | data loss / flapping | mandatory `cleanup_draining` first |
| Recovery loops forever | stuck project | bounded `recovery_attempts` + `blocked_recovery` |
| Conflict loops forever | stalled merge | bounded `conflict_attempts` + `blocked_conflict` |
| Merge breaks build without git conflicts | broken integration push | required post-merge validation gate |
| User working tree has local edits | automation disrupts user | merge only in dedicated integration worktree |

---

## 8. Non-Goals

1. Cross-machine distributed execution.
2. Fine-grained file-level concurrent editing inside one section.
3. Unlimited automatic self-healing without escalation.
4. Long-lived preservation of temporary workstream branches.

---

## 9. Cross-Provider Review (Strict Pass #2)

### 9.1 Claude

Key findings:

- Merge in primary checkout is unsafe.
- No post-merge validation gate.
- Lease/reconciliation/timeout details needed to prevent hangs.

Decision:

- Adopted.
- Strict pass #2 additions adopted:
  - explicit cherry-pick strategy wording
  - integration temporary branch in integration worktree
  - merge lock ttl/renewal
  - deterministic `completion_order` only
  - concrete reconciliation table

### 9.2 Gemini

Key findings:

- Dedicated integration worktree needed.
- Hydration and process identity cleanup hardening needed.
- Shared high-frequency logging into DB can create contention pressure.

Decision:

- Adopted integration-worktree merge and hydration requirements.
- Adopted cleanup runner identity checks and stronger cleanup status persistence.
- Adopted DB contention guardrails; detailed log-routing implementation deferred to implementation phase.
- Strict pass #2 additions adopted:
  - cherry-pick recovery must use `applied_commit_sha` mapping, not source-sha ancestry
  - hydration now explicitly forbids shared mutable dependency directories

### 9.3 Codex

Key findings:

- Missing fencing semantics for merge and runner leases.
- Sealed head alone insufficient; sealed commit list required.
- Merge progress needed explicit durable per-commit state machine.
- Cleanup/recovery needed bounded retries and quiesce gate.

Decision:

- Adopted.
- Strict pass #2 additions adopted:
  - blocked states are active for session-admission lock purposes
  - validation failure semantics now explicitly block push and set `blocked_validation`

---

## 10. PR-Sized Implementation Task Board

Status legend:

- `[ ]` not started
- `[-]` started / in progress
- `[x]` completed

Execution rules:

- Every task below is PR-sized (target: 1-3 files changed).
- Commit after each chunk before starting the next chunk.
- Commit message format: `feat(parallelism): <chunk-id> <short-summary>`.

Checklist:

- `[x]` `CHUNK-01` Add active-session admission guard by `project_repo_id` and non-terminal status gating.
: Files: `src/runners/global-db.ts`, `src/commands/runners-parallel.ts`, `migrations/<new>.sql`
- `[x]` `CHUNK-02` Add workstream lease fields and CAS claim logic (`claim_generation`, `lease_expires_at`).
: Files: `src/runners/global-db.ts`, `src/commands/runners-parallel.ts`, `src/runners/wakeup.ts`
- `[x]` `CHUNK-03` Enforce fencing checks on runner-side mutating actions (status, commit, push, seal).
: Files: `src/runners/orchestrator-loop.ts`, `src/commands/loop-phases.ts`, `src/parallel/merge-conflict.ts`
- `[x]` `CHUNK-04` Add integration worktree bootstrap using temporary integration branch.
: Files: `src/parallel/merge.ts`, `src/parallel/clone.ts`, `src/commands/merge.ts`
- `[x]` `CHUNK-05` Add merge lock epoch fencing + TTL/heartbeat renewal semantics.
: Files: `src/parallel/merge-lock.ts`, `src/parallel/merge.ts`, `src/database/schema.ts`
- `[x]` `CHUNK-06` Persist sealed merge input (`sealed_base_sha`, `sealed_head_sha`, `sealed_commit_shas`) at workstream completion.
: Files: `src/runners/global-db.ts`, `src/commands/runners-parallel.ts`, `src/parallel/merge.ts`
- `[ ]` `CHUNK-07` Implement durable merge-progress mapping (`sealed_commit_sha` -> `applied_commit_sha`) with unique constraints.
: Files: `src/parallel/merge-progress.ts`, `src/database/schema.ts`, `migrations/<new>.sql`
- `[ ]` `CHUNK-08` Implement crash-safe merge resume using provenance mapping and reachability checks.
: Files: `src/parallel/merge.ts`, `src/parallel/merge-progress.ts`, `src/commands/merge.ts`
- `[ ]` `CHUNK-09` Add post-merge validation gate and blocked-validation transition on failure.
: Files: `src/parallel/merge.ts`, `src/commands/merge.ts`, `src/runners/global-db.ts`
- `[ ]` `CHUNK-10` Implement cleanup-draining phase (lease revoke, runner termination verification, then deletion).
: Files: `src/commands/workspaces.ts`, `src/runners/wakeup.ts`, `src/runners/global-db.ts`
- `[ ]` `CHUNK-11` Implement deterministic reconciliation matrix and bounded recovery retries/backoff.
: Files: `src/runners/wakeup.ts`, `src/runners/global-db.ts`, `src/commands/runners-parallel.ts`
- `[ ]` `CHUNK-12` Add hydration isolation guardrails (forbid shared mutable dependency directories).
: Files: `src/parallel/clone.ts`, `src/commands/runners-parallel.ts`, `src/config/schema.ts`
- `[ ]` `CHUNK-13` Add resource preflight + auto-downshift of `maxClones`.
: Files: `src/commands/runners-parallel.ts`, `src/config/loader.ts`, `src/config/schema.ts`
- `[ ]` `CHUNK-14` Add/update tests for provider cwd/worktree safety, locking, merge progress, and cleanup flow.
: Files: `src/**/__tests__/*` (targeted new/updated test files only)
