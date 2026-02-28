# Claude Session Resume Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix Claude session resume failures caused by session transcripts being stored in per-invocation temp directories that are deleted at process exit.

**Architecture:** Mirror the `getPersistentHome()` pattern already used by Codex and Gemini providers — store Claude's session data in `.steroids/provider-homes/claude/` inside the project directory so it persists across invocations. Fix the base class `setupIsolatedHome` loop to not crash when a directory entry is passed. Strip `CLAUDE_CONFIG_DIR` from the spawned env to prevent the real config dir from leaking through. Fix a stale doc.

**Tech Stack:** TypeScript, Node.js `fs` module, Claude CLI (`claude --resume`)

---

## Problem Statement

Every reviewer invocation for Claude provider tries `mode: resume` first. It fails with `SessionNotFoundError` every time, falling back to `mode: fresh`. The fresh fallback reconstructs full conversation history (expensive) and loses prompt-caching benefits on resumed invocations.

**Evidence:** `.steroids/invocations/655.log` — mode: resume, failed in 1136ms, `"Failed to resume Claude session 3e2744d1-..."`. The following invocation (#656) used mode: fresh and succeeded in 93s.

---

## Current Behavior

`ClaudeProvider.invokeWithFile()` calls:

```typescript
const isolatedHome = this.setupIsolatedHome(
  '.claude',
  ['config.json', '.credentials.json', 'settings.json'],
  undefined,      // ← always creates a new temp dir
  ['.claude.json']
);
```

`setupIsolatedHome()` with `baseDir=undefined` creates a fresh `os.tmpdir()/steroids-claude-{uuid}` on every invocation. Claude writes session transcripts to `{tmpdir}/.claude/projects/{cwd-slug}/{session-id}.jsonl`. At process exit, `rmSync(isolatedHome, { recursive: true, force: true })` deletes the entire temp dir — including the session transcript. The next invocation gets a new empty temp dir, finds no session file, and exits non-zero with no output.

Codex (`src/providers/codex.ts:226-248`) and Gemini (`src/providers/gemini.ts:193-210`) already solve this with `getPersistentHome(cwd)`, which stores session state in `{project}/.steroids/provider-homes/{provider}/` and skips `rmSync` for persistent homes.

---

## Desired Behavior

1. When a project has a `.steroids/` directory, Claude uses `.steroids/provider-homes/claude/` as its HOME — persisting session transcripts across invocations.
2. `claude --resume <id>` finds the session file and resumes successfully.
3. If `.steroids/` is not present (no project context), fall back to a temp dir as today.
4. `CLAUDE_CONFIG_DIR` is stripped from the spawned environment so a user's shell export cannot bypass HOME isolation.
5. `setupIsolatedHome` does not crash (even silently) when a directory path is included in `authFiles`.

---

## Design

### Task 1: Guard `setupIsolatedHome` against EISDIR and EEXIST

**File:** `src/providers/interface.ts`

Round 2 review found two bugs the original sketch missed:
- **EEXIST**: On re-invocation with a persistent home, `symlinkSync` throws `EEXIST`. The existing catch fallback then calls `writeFileSync(dest, readFileSync(src))`, which follows the symlink and **overwrites the real `~/.claude/config.json`**. Must skip on EEXIST.
- **EISDIR**: `readFileSync` throws on directories; fixed by skipping the copy fallback for directories.

Replace the inner loop with a single `statSync`-first approach that handles ENOENT, EEXIST, and EISDIR:

```typescript
// interface.ts line 1 — update import
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';

// interface.ts lines 520-535 — replace loop body
for (const file of authFiles) {
  const src = join(realProviderPath, file);
  const dest = join(isolatedProviderPath, file);

  let srcStat;
  try { srcStat = statSync(src); } catch { continue; } // ENOENT — skip

  try {
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(src, dest);
  } catch (e: any) {
    if (e?.code === 'EEXIST') continue; // symlink already present — leave it
    if (!srcStat.isDirectory()) {
      // File copy fallback — only for regular files, not directories
      try {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(src));
      } catch { /* ignore copy failure */ }
    }
  }
}
```

This is a base-class fix that benefits all providers (Codex and Gemini have the same EEXIST bug today).

### Task 2: Add `getPersistentHome()` to `ClaudeProvider`

**File:** `src/providers/claude.ts`

Add `realpathSync` to imports. Add `getPersistentHome()` private method, identical in structure to `codex.ts:226-248`:

```typescript
import { writeFileSync, unlinkSync, existsSync, rmSync, mkdirSync, realpathSync } from 'node:fs';

// Add inside ClaudeProvider class:
private getPersistentHome(cwd: string): { home: string; isPersistent: boolean } {
  try {
    const steroidsDir = join(cwd, '.steroids');
    if (existsSync(steroidsDir)) {
      const realSteroidsDir = realpathSync(steroidsDir);
      const persistentHome = join(realSteroidsDir, 'provider-homes', 'claude');
      mkdirSync(persistentHome, { recursive: true });
      this.setupIsolatedHome('.claude', ['config.json', '.credentials.json', 'settings.json'], persistentHome, ['.claude.json']);
      return { home: persistentHome, isPersistent: true };
    }
  } catch {
    console.warn(`Claude persistent home unavailable, falling back to temporary home`);
  }
  return {
    home: this.setupIsolatedHome('.claude', ['config.json', '.credentials.json', 'settings.json'], undefined, ['.claude.json']),
    isPersistent: false,
  };
}
```

### Task 3: Wire `getPersistentHome()` into `invokeWithFile()`

**File:** `src/providers/claude.ts`

Replace the direct `setupIsolatedHome` call and the unconditional `rmSync` cleanup:

```typescript
// Replace line 225:
const { home: isolatedHome, isPersistent } = this.getPersistentHome(cwd);

// Replace both rmSync cleanup blocks (in 'close' and 'error' handlers):
if (!isPersistent) {
  try {
    rmSync(isolatedHome, { recursive: true, force: true });
  } catch { /* Ignore */ }
}
```

Both the `child.on('close')` handler and the `child.on('error')` handler have a cleanup block — both need the `!isPersistent` guard.

### Task 4: Strip `CLAUDE_CONFIG_DIR` from spawned environment

**File:** `src/providers/interface.ts`

Add `'CLAUDE_CONFIG_DIR'` to the `keysToStrip` array in `getSanitizedCliEnv()`:

```typescript
const keysToStrip = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'MISTRAL_API_KEY',
  'CLAUDECODE',
  'CLAUDE_CONFIG_DIR',   // ← add this
];
```

Rationale: `CLAUDE_CONFIG_DIR` overrides `$HOME/.claude` lookup in the CLI source (`HA()` function). Without stripping it, a user's shell export bypasses HOME isolation entirely.

### Task 5: Fix stale documentation (three files)

Round 2 review confirmed the `sessions/` path error appears in three places:

**File 1:** `docs/cli/providers/claude.md` line 88 — Session Management table:
```
| Session storage | `~/.claude/projects/` |
```

**File 2:** `docs/cli/design/session-context-reuse.md` line 68 — Provider comparison table:
```
| **Claude** | `claude -c` | `claude -r <id>` | `claude -p --resume <id> "msg"` | `~/.claude/projects/` |
```

**File 3:** `docs/cli/design/session-context-reuse.md` line 769 — Disk accumulation note:
```
Provider CLIs accumulate session files on disk (`~/.claude/projects/`, ...
```

Was `~/.claude/sessions/` in all three — this path does not exist on the filesystem.

---

## Implementation Order

```
Task 1 (base class guard) → Task 2+3 (persistent home) → Task 4 (env strip) → Task 5 (docs)
Tests inline with each task (TDD).
```

Tasks 2 and 3 are coupled and should be done together in one commit.

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| `.steroids/` absent (no project) | Falls back to temp dir; resume still fails as today, but that's acceptable outside a project context |
| `.steroids/` is a symlink (worktree) | `realpathSync` resolves to canonical project path; both main and worktree share the same persistent home, so sessions created in either are visible to both |
| Two parallel runners, different sessions | Each session has its own UUID filename under `provider-homes/claude/.claude/projects/{slug}/`; different files, no conflict |
| Two parallel runners resume same session | Should not happen — task locking prevents it. If it does: both append to the same `.jsonl` file, corrupting the transcript. This is the same risk as today and is not made worse; the lock is the safety guarantee |
| Persistent home exists but session file missing (e.g., first run) | Claude CLI exits non-zero, `SessionNotFoundError` triggers, fresh fallback runs — same as today |
| `CLAUDE_CONFIG_DIR` set in user env | Stripped before spawn; isolated HOME takes effect as intended |
| `setupIsolatedHome` symlink fails for `projects/` dir | Outer `try/catch` logs a warning; function returns home without the symlink. Invocation proceeds, resume fails, fresh fallback triggers — degraded but not broken |

---

## Non-Goals

- Fixing the over-broad `SessionNotFoundError` heuristic (empty output = any error, not just missing session). Pre-existing issue; separate task.
- Investigating whether `session-env/` or `tasks/` subdirs under `~/.claude/` are needed for resume. The persistent home contains the full `~/.claude/` directory tree via the HOME redirect; all subdirs Claude writes will be preserved naturally.
- Surgical per-session-file copy approach. The persistent home pattern is architecturally consistent with Codex/Gemini and simpler.
- Fixing default model config in the docs (`orchestrator=opus` vs current code defaulting to `sonnet`).

---

## Cross-Provider Review

Parallel adversarial reviews run 2026-02-28 before implementation. Both reviewers received the original naive fix (symlink `projects/` via `authFiles`). Key findings that shaped this design:

| Finding | Source | Decision |
|---------|--------|----------|
| `readFileSync` fallback throws `EISDIR` for directory entries in `setupIsolatedHome` | Claude + Codex | **Adopted** — Task 1 adds `statSync` guard |
| Naive `authFiles += 'projects'` symlink exposes all global sessions across all projects (isolation regression) | Codex | **Adopted** — replaced with scoped `getPersistentHome()` pattern |
| Codex + Gemini already have `getPersistentHome()` — architecturally consistent fix exists | Codex | **Adopted** — Task 2/3 mirrors this pattern exactly |
| `CLAUDE_CONFIG_DIR` env var bypasses HOME isolation entirely | Claude | **Adopted** — Task 4 strips it |
| Session storage docs say `~/.claude/sessions/` but real path is `~/.claude/projects/` | Codex | **Adopted** — Task 5 fixes the doc |
| `rmSync` not verified to avoid following symlinks (would delete real `~/.claude/projects/`) | Claude | **N/A** — moot; persistent home approach doesn't symlink `projects/` |
| Concurrency failure mode shifts from loss to corruption | Claude | **Acknowledged** — task locking is the invariant; documented in Edge Cases |
| Surgical per-session-file copy as alternative | Claude | **Rejected** — persistent home is simpler and already the established pattern |
| Over-broad `SessionNotFoundError` heuristic | Both | **Deferred** — pre-existing, separate issue |
| cwd mismatch for cross-worktree sessions | Codex | **Deferred** — `realpathSync` mitigates the worktree case; other cwd changes are out of scope |

---

## Tasks Detail

### Task 1: Guard `setupIsolatedHome` against directory entries

**Files:**
- Modify: `src/providers/interface.ts`
- Test: `tests/providers-claude.test.ts` (or a new `tests/providers-base.test.ts`)

**Step 1: Write failing tests**

In `tests/providers-claude.test.ts`. Use `jest.spyOn(os, 'homedir')` to control what homedir the method sees — do not add a parameter to `setupIsolatedHome`.

```typescript
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

describe('setupIsolatedHome', () => {
  let fakeHome: string;
  let homedirSpy: jest.SpyInstance;

  beforeEach(() => {
    fakeHome = join(os.tmpdir(), `test-home-${Date.now()}`);
    mkdirSync(join(fakeHome, '.claude', 'projects'), { recursive: true });
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('does not throw when authFiles includes a directory', () => {
    const provider = new ClaudeProvider();
    const destHome = join(os.tmpdir(), `test-dest-${Date.now()}`);
    expect(() => {
      (provider as any).setupIsolatedHome('.claude', ['projects'], destHome);
    }).not.toThrow();
    rmSync(destHome, { recursive: true, force: true });
  });

  it('does not overwrite existing symlink on re-invocation (EEXIST safe)', () => {
    const provider = new ClaudeProvider();
    const destHome = join(os.tmpdir(), `test-dest2-${Date.now()}`);
    // First call creates symlink
    (provider as any).setupIsolatedHome('.claude', ['config.json'], destHome);
    // Second call must not throw or overwrite
    expect(() => {
      (provider as any).setupIsolatedHome('.claude', ['config.json'], destHome);
    }).not.toThrow();
    rmSync(destHome, { recursive: true, force: true });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /System/Volumes/Data/.internal/projects/Projects/steroids-cli
npx jest tests/providers-claude.test.ts -t "setupIsolatedHome" --no-coverage 2>&1 | tail -20
```

Expected: FAIL (current code throws or overwrites on second call).

**Step 3: Apply EEXIST + EISDIR fix in `interface.ts`**

1. Add `statSync` to the `fs` import on line 1.
2. In the `authFiles` loop (lines 520-535), add `isDir` check before the fallback.

```typescript
// interface.ts line 1 — update import
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';

// interface.ts lines 520-535 — replace loop body
for (const file of authFiles) {
  const src = join(realProviderPath, file);
  const dest = join(isolatedProviderPath, file);

  if (existsSync(src)) {
    const isDir = statSync(src).isDirectory();
    try {
      mkdirSync(dirname(dest), { recursive: true });
      symlinkSync(src, dest);
    } catch {
      if (!isDir) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(src));
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx jest tests/providers-claude.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS (all existing tests + new directory entry test).

**Step 5: Commit**

```bash
git add src/providers/interface.ts tests/providers-claude.test.ts
git commit -m "fix: guard setupIsolatedHome against EISDIR when authFiles includes a directory"
```

---

### Task 2+3: Add `getPersistentHome()` and wire into `invokeWithFile()`

**Files:**
- Modify: `src/providers/claude.ts`
- Test: `tests/providers-claude.test.ts`

**Step 1: Write failing test for `getPersistentHome`**

```typescript
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

describe('getPersistentHome', () => {
  it('returns persistent home inside .steroids when it exists', () => {
    const provider = new ClaudeProvider();
    const projectDir = join(os.tmpdir(), `test-project-${Date.now()}`);
    mkdirSync(join(projectDir, '.steroids'), { recursive: true });

    const result = (provider as any).getPersistentHome(projectDir);

    expect(result.isPersistent).toBe(true);
    expect(result.home).toContain(join('provider-homes', 'claude'));
    expect(existsSync(result.home)).toBe(true);
  });

  it('returns non-persistent temp home when .steroids is absent', () => {
    const provider = new ClaudeProvider();
    const dir = join(os.tmpdir(), `no-steroids-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const result = (provider as any).getPersistentHome(dir);

    expect(result.isPersistent).toBe(false);
    expect(result.home).toContain(os.tmpdir());
  });
});
```

**Step 2: Run to verify fails**

```bash
npx jest tests/providers-claude.test.ts -t "getPersistentHome" --no-coverage 2>&1 | tail -10
```

Expected: FAIL — `getPersistentHome is not a function`.

**Step 3: Implement `getPersistentHome` and update `invokeWithFile`**

In `src/providers/claude.ts`:

1. Update the import on line 7 to include `realpathSync`:

```typescript
import { writeFileSync, unlinkSync, existsSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
```

2. Add `getPersistentHome` as a private method before `invoke()`:

```typescript
private getPersistentHome(cwd: string): { home: string; isPersistent: boolean } {
  try {
    const steroidsDir = join(cwd, '.steroids');
    if (existsSync(steroidsDir)) {
      const realSteroidsDir = realpathSync(steroidsDir);
      const persistentHome = join(realSteroidsDir, 'provider-homes', 'claude');
      mkdirSync(persistentHome, { recursive: true });
      this.setupIsolatedHome('.claude', ['config.json', '.credentials.json', 'settings.json'], persistentHome, ['.claude.json']);
      return { home: persistentHome, isPersistent: true };
    }
  } catch {
    console.warn(`Claude persistent home unavailable, falling back to temporary home`);
  }
  return {
    home: this.setupIsolatedHome('.claude', ['config.json', '.credentials.json', 'settings.json'], undefined, ['.claude.json']),
    isPersistent: false,
  };
}
```

3. In `invokeWithFile`, replace the isolated home setup on line 225:

```typescript
// Replace:
const isolatedHome = this.setupIsolatedHome('.claude', ['config.json', '.credentials.json', 'settings.json'], undefined, ['.claude.json']);
// With:
const { home: isolatedHome, isPersistent } = this.getPersistentHome(cwd);
```

4. In `child.on('close')` handler, wrap the `rmSync` block:

```typescript
if (!isPersistent) {
  try {
    rmSync(isolatedHome, { recursive: true, force: true });
  } catch { /* Ignore cleanup errors */ }
}
```

5. In `child.on('error')` handler, same wrap:

```typescript
if (!isPersistent) {
  try {
    rmSync(isolatedHome, { recursive: true, force: true });
  } catch { /* Ignore cleanup errors */ }
}
```

**Step 4: Run tests**

```bash
npx jest tests/providers-claude.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/providers/claude.ts tests/providers-claude.test.ts
git commit -m "fix: add getPersistentHome to ClaudeProvider so session transcripts survive across invocations"
```

---

### Task 4: Strip `CLAUDE_CONFIG_DIR` from spawned env

**Files:**
- Modify: `src/providers/interface.ts`
- Test: existing test coverage in `tests/providers-claude.test.ts` (check if `getSanitizedCliEnv` is tested)

**Step 1: Check whether `getSanitizedCliEnv` has a test**

```bash
grep -n "getSanitizedCliEnv\|CLAUDE_CONFIG_DIR\|keysToStrip" tests/providers-claude.test.ts
```

**Step 2: If no test exists, write one**

```typescript
describe('getSanitizedCliEnv', () => {
  it('strips CLAUDE_CONFIG_DIR from spawned environment', () => {
    const provider = new ClaudeProvider();
    const originalEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/some/path';

    const env = (provider as any).getSanitizedCliEnv();

    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    // Restore
    if (originalEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalEnv;
  });
});
```

**Step 3: Run to verify fails**

```bash
npx jest tests/providers-claude.test.ts -t "CLAUDE_CONFIG_DIR" --no-coverage 2>&1 | tail -10
```

Expected: FAIL.

**Step 4: Add to `keysToStrip`**

In `src/providers/interface.ts`, line ~479:

```typescript
const keysToStrip = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'MISTRAL_API_KEY',
  'CLAUDECODE',
  'CLAUDE_CONFIG_DIR',
];
```

**Step 5: Run tests**

```bash
npx jest tests/providers-claude.test.ts --no-coverage 2>&1 | tail -10
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/providers/interface.ts tests/providers-claude.test.ts
git commit -m "fix: strip CLAUDE_CONFIG_DIR from spawned env to prevent HOME isolation bypass"
```

---

### Task 5: Fix stale session storage path in docs

**Files:**
- Modify: `docs/cli/providers/claude.md`

**Step 1: Find and fix the wrong path**

In `docs/cli/providers/claude.md`, find the Session Management table. Change:

```
| Session storage | `~/.claude/sessions/` |
```

To:

```
| Session storage | `~/.claude/projects/` |
```

**Step 2: Verify with grep**

```bash
grep -n "sessions" docs/cli/providers/claude.md
```

Expected: no more `~/.claude/sessions/` references (only legitimate uses of the word if any).

**Step 3: Fix all three stale references**

```bash
# claude.md
sed -i '' 's|~/.claude/sessions/|~/.claude/projects/|g' docs/cli/providers/claude.md
# session-context-reuse.md (two occurrences)
sed -i '' 's|~/.claude/sessions/|~/.claude/projects/|g' docs/cli/design/session-context-reuse.md
```

**Step 4: Verify**

```bash
grep -rn "\.claude/sessions/" docs/
```

Expected: no matches.

**Step 5: Commit**

```bash
git add docs/cli/providers/claude.md docs/cli/design/session-context-reuse.md
git commit -m "docs: fix Claude session storage path across all references (projects/ not sessions/)"
```

---

## Full Test Run

After all tasks:

```bash
cd /System/Volumes/Data/.internal/projects/Projects/steroids-cli
npx jest --no-coverage 2>&1 | tail -20
```

Expected: all tests pass, no regressions.

```bash
npm run build 2>&1 | tail -10
```

Expected: clean TypeScript build.

---

## Follow-up Tasks (Non-blocking)

These are out of scope for this fix but must be tracked:

**FU-1: Centralize `getPersistentHome` into `BaseAIProvider`**
Three providers (Claude, Codex, Gemini) each have an identical private `getPersistentHome` method. Per Simplification First, this should be one shared implementation in `BaseAIProvider` with parameterized `providerDir`, `authFiles`, `rootFiles`, and `providerName`. WHAT: extract to `src/providers/interface.ts`. WHY: three drift-prone copies of the same invariant. HOW: add `protected getPersistentHome(providerName: string, providerDir: string, authFiles: string[], rootFiles?: string[]): { home: string; isPersistent: boolean }` to `BaseAIProvider`, then delegate from each provider.

**FU-2: GC for session transcript accumulation in persistent home**
`.steroids/provider-homes/claude/.claude/projects/{slug}/` accumulates one `.jsonl` file per session, never deleted. On long-running projects this can grow significantly. WHAT: add TTL-based cleanup (e.g., delete sessions older than 30 days). WHERE: `src/providers/claude.ts`, triggered at end of `getPersistentHome` (same as Codex/Gemini if they have it — check). WHY: disk growth is unbounded.

**FU-3: Fix over-broad `SessionNotFoundError` heuristic**
`claude.ts:344`: empty output + non-zero exit → `SessionNotFoundError`, but this also matches OOM kills, auth failures, and network timeouts. These should not trigger full history reconstruction. WHAT: distinguish session-missing from other failure modes by checking stderr content before falling back to the empty-output heuristic. WHERE: `src/providers/claude.ts:344`.

---

## Round 2 Cross-Provider Review

Second parallel adversarial review run 2026-02-28 after plan was drafted. Both reviewers received the full plan text.

| Finding | Source | Decision |
|---------|--------|----------|
| **Critical**: `symlinkSync` throws `EEXIST` on re-invocation; catch fallback calls `writeFileSync` which follows the existing symlink and overwrites the real `~/.claude/config.json` | Both | **Adopted** — Task 1 code sketch updated to check `EEXIST` and skip, not copy |
| **Critical**: Task 1's original sketch uses `existsSync` + `statSync` double-check; simpler to use `statSync`-first with error code inspection | Claude | **Adopted** — Task 1 code sketch replaced with single `statSync`-first approach |
| **Critical**: Three copies of `getPersistentHome` violate Simplification First | Codex | **Deferred to FU-1** — immediate fix adds Claude copy to match existing Codex/Gemini pattern; base class centralization is a follow-up to avoid scope creep |
| **Important**: Task 1 test sketch used non-existent sixth parameter; `jest.spyOn(os, 'homedir')` is the correct testing approach | Claude | **Adopted** — test sketch updated |
| **Important**: `getPersistentHome` catch block silently swallows errors; Gemini logs a warning | Claude | **Adopted** — `console.warn` added to both `getPersistentHome` sketches |
| **Important**: Docs sweep incomplete — stale `sessions/` appears in two files, not one | Codex ✓ verified | **Adopted** — Task 5 expanded to fix all three occurrences |
| **Important**: Session transcript accumulation in persistent home is unbounded | Claude | **Deferred to FU-2** — out of scope for this fix |
| **Important**: Worktree sharing via `realpathSync` may cause cross-branch context bleed | Codex | **Acknowledged** — intentional; same canonical project root = same session context. Documented in Edge Cases. Explicit scope decision: worktrees of the same project share provider home. |
| **Medium**: Timeout hard-failure path leaks temp home (pre-existing) | Codex | **Deferred to FU-3 area** — pre-existing, separate issue |
| **Low**: `CLAUDE_HOME` env var might bypass HOME isolation | Claude | **N/A** — not present in Claude CLI source or codebase; not a concern for current CLI version |
