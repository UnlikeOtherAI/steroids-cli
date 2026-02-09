# Prompt Templates

> Complete prompts for coder and reviewer roles.
> For orchestrator flow, see [ORCHESTRATOR.md](./ORCHESTRATOR.md)

---

## Overview

Prompts are **hardcoded templates** with variable substitution. The orchestrator does NOT generate prompts dynamically - it fills in templates with task-specific data.

This approach is:
- Predictable and testable
- No LLM deciding what instructions to give
- Consistent behavior across all tasks

---

## CLI Invocation

### Claude Code CLI

```bash
# Non-interactive mode with prompt file
claude -p "$(cat /tmp/prompt.txt)" --model claude-sonnet-4

# Or with print flag for cleaner output
claude --print -p "$(cat /tmp/prompt.txt)" --model claude-sonnet-4

# With custom system prompt appended
claude -p "$(cat /tmp/prompt.txt)" \
  --append-system-prompt "You are working on the steroids task system." \
  --model claude-sonnet-4
```

### Gemini CLI

```bash
# Using gcloud AI
echo "$(cat /tmp/prompt.txt)" | gcloud ai models predict gemini-pro

# Or standalone gemini-cli if installed
gemini-cli generate --model gemini-pro < /tmp/prompt.txt
```

### OpenAI CLI

```bash
# Using official openai CLI
openai api chat.completions.create \
  --model gpt-4 \
  --message "$(cat /tmp/prompt.txt)"
```

---

## Coder Prompt (Complete)

This is the EXACT prompt sent to the coder LLM:

```markdown
# STEROIDS CODER TASK

You are a CODER in an automated task execution system. Your job is to implement the task below according to the specification.

---

## Task Information

**Task ID:** {task_id}
**Title:** {task_title}
**Status:** {previous_status} → in_progress
**Rejection Count:** {rejection_count}/15
**Project:** {project_path}

---

## Specification

The full specification is in: {source_file}

{source_file_content}

---

## Project Guidelines

{agents_md_content}

---

## Existing Code Context

{relevant_files_summary}

---

## Previous Rejection Feedback

{if_rejected}
The reviewer rejected your previous attempt with this feedback:

> {reviewer_notes}

You MUST address this feedback. This is rejection #{rejection_count} of 15.
After 15 rejections, this task will require human intervention.

If you believe the reviewer is wrong, you may dispute:
```bash
steroids dispute create {task_id} --reason "explanation" --type coder
```

But only dispute if there's a genuine specification disagreement. Frivolous disputes will be deleted.
{end_if}

---

## Your Instructions

1. Read the specification carefully
2. Implement the feature/fix as specified
3. Write tests if the project has a test directory
4. Keep files under 500 lines
5. Follow the coding standards in AGENTS.md

---

## CRITICAL RULES

1. **NEVER touch .steroids/ directory**
   - Do NOT read, write, or modify any files in .steroids/
   - This includes .db, .yaml, and .yml files

2. **BUILD AND TESTS MUST PASS before submitting**
   - Run the project's build command
   - Run the project's test command
   - Fix any errors until BOTH pass
   - **Do NOT submit for review if build OR tests fail**

3. **Use CLI for status updates**
   When you are DONE and BUILD PASSES, run:
   ```bash
   steroids tasks update {task_id} --status review
   ```

4. **Commit your work**
   Before marking as review, commit your changes:
   ```bash
   git add <files>
   git commit -m "feat: {task_title}"
   ```

5. **Never modify TODO.md directly**
   The CLI manages task status.

---

## When You Are Done

**CRITICAL: You MUST verify the project builds AND tests pass before submitting for review.**

Run these commands in order:
```bash
# 1. Build the project - THIS MUST PASS
{build_command}

# 2. Run tests - THIS MUST PASS
{test_command}

# 3. If build OR tests fail, fix the errors. Do NOT proceed until BOTH pass.

# 4. Only after build and tests pass, commit your work
git add <your-changed-files>
git commit -m "feat: {task_title}"

# 5. Submit for review
steroids tasks update {task_id} --status review
```

**Both build AND tests MUST pass.** If you submit code that doesn't build or has failing tests, it will be rejected, wasting a review cycle. The orchestrator will verify BOTH before accepting your submission.

If you do NOT run `steroids tasks update`, your work will not be submitted and you will be restarted on the next cycle.

---

## Start Now

Begin by reading {source_file} and implementing the task.
```

---

## Coder Prompt (Resuming Partial Work)

When a task is already `in_progress` (previous coder crashed or timed out):

```markdown
# STEROIDS CODER TASK (RESUMING)

You are a CODER resuming work on a partially completed task.

---

## Task Information

**Task ID:** {task_id}
**Title:** {task_title}
**Status:** in_progress (resuming)
**Project:** {project_path}

---

## Previous Work Detected

A previous coder started this task but did not complete it. You may find:
- Uncommitted changes in the working directory
- Partial implementations in progress

**Git Status:**
```
{git_status_output}
```

**Uncommitted Changes:**
```diff
{git_diff_output}
```

---

## Your Instructions

1. Review what the previous coder did
2. If the work looks good, complete it
3. If the work looks wrong, you may start fresh
4. Commit all changes when done

---

## Specification

{source_file_content}

---

## CRITICAL RULES

1. **NEVER touch .steroids/ directory**
2. **Commit your work before submitting**
3. **Run `steroids tasks update {task_id} --status review` when done**

If you do NOT update the task status, you will be restarted.

---

## Complete the Task Now

Review the existing work and finish the implementation.
```

---

## Reviewer Prompt (Complete)

This is the EXACT prompt sent to the reviewer LLM:

```markdown
# STEROIDS REVIEWER TASK

You are a REVIEWER in an automated task execution system. Your job is to verify the coder's implementation matches the specification.

---

## Task Information

**Task ID:** {task_id}
**Title:** {task_title}
**Status:** review (submitted by coder)
**Rejection Count:** {rejection_count}/15
**Project:** {project_path}

---

## Original Specification

From {source_file}:

{source_file_content}

---

## Changes Made by Coder

```diff
{git_diff_output}
```

---

## Files Modified

{modified_files_list}

---

## Review Checklist

Answer these questions:
1. Does the implementation match the specification?
2. Are there bugs, security issues, or logic errors?
3. Are tests present and adequate?
4. Does code follow AGENTS.md guidelines?
5. Are all files under 500 lines?

---

## Your Decision

You MUST choose ONE of these actions:

### APPROVE (implementation is correct)
If the code correctly implements the specification:
```bash
steroids tasks approve {task_id} --model {reviewer_model}
```

### REJECT (needs changes)
If there are issues that must be fixed:
```bash
steroids tasks reject {task_id} --model {reviewer_model} --notes "specific feedback"
```
Be specific in your notes. The coder will use them to fix the issues.
This will be rejection #{rejection_count + 1}.

### APPROVE WITH NOTE (minor issues, not blocking)
If you have minor concerns but the implementation is acceptable:
```bash
steroids tasks approve {task_id} --model {reviewer_model} --notes "Minor: prefer X over Y"
```
This approves the task but logs your feedback. The coder may address it later or ignore it.

### DISPUTE (fundamental disagreement)
Only if there's a genuine specification or architecture conflict:
```bash
steroids dispute create {task_id} --reason "explanation" --type reviewer
```
Use sparingly. Most issues should be resolved via reject/fix cycle.

---

## CRITICAL RULES

1. **NEVER touch .steroids/ directory**
2. **NEVER modify code yourself** - only review it
3. **Be specific in rejection notes** - vague feedback wastes cycles
4. **Approve if it works** - don't reject for style preferences
5. **You MUST run one of the commands above**

If you do NOT run a command, the task will remain in review and you will be invoked again.

---

## Review Now

Examine the diff above and make your decision.
```

---

## Variable Substitution

The orchestrator fills these variables before sending:

| Variable | Source | Description |
|----------|--------|-------------|
| `{task_id}` | database | Full UUID of the task |
| `{task_title}` | database | Task title text |
| `{previous_status}` | database | Status before this invocation |
| `{rejection_count}` | database | Number of times rejected (0-15) |
| `{project_path}` | cwd | Absolute path to project |
| `{source_file}` | database | Path to specification file |
| `{source_file_content}` | File read | Contents of specification |
| `{agents_md_content}` | AGENTS.md | Project guidelines |
| `{relevant_files_summary}` | File scan | Key files in project |
| `{reviewer_notes}` | Last rejection | Feedback from reviewer |
| `{git_status_output}` | `git status` | Current git status |
| `{git_diff_output}` | `git diff` | Changes for review |
| `{modified_files_list}` | `git diff --name-only` | List of changed files |
| `{reviewer_model}` | config | Model name for audit |
| `{build_command}` | config/auto-detect | Command to verify build compiles |
| `{test_command}` | config/auto-detect | Command to verify tests pass |

---

## Output Validation

After each LLM invocation, the orchestrator checks if the expected action occurred.

### Structured Output Verification

The orchestrator verifies that the LLM actually ran the CLI commands by:

1. **Re-reading database state** - Check if task status changed
2. **Verifying CLI was called** - Status change = CLI was executed
3. **Running build/test verification** - Independent validation

If the LLM outputs "I ran the command" but the database wasn't updated, the task is retried next cycle.

### For Coder

```python
def validate_coder_output(task_id):
    task = db.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()

    if task.status == "review":
        # Coder submitted - verify build AND tests pass
        build_result = run_build_command()

        if build_result.exit_code != 0:
            # Build failed - reject back to coder
            log_error("Build failed after coder submission")
            db.execute("""
                UPDATE tasks SET status = 'in_progress' WHERE id = ?
            """, (task_id,))
            db.execute("""
                INSERT INTO audit (task_id, from_status, to_status, actor, notes)
                VALUES (?, 'review', 'in_progress', 'orchestrator', 'Build failed')
            """, (task_id,))
            return "build_failed"

        # Now verify tests pass
        test_result = run_test_command()

        if test_result and test_result.exit_code != 0:
            # Tests failed - reject back to coder
            log_error("Tests failed after coder submission")
            db.execute("""
                UPDATE tasks SET status = 'in_progress' WHERE id = ?
            """, (task_id,))
            db.execute("""
                INSERT INTO audit (task_id, from_status, to_status, actor, notes)
                VALUES (?, 'review', 'in_progress', 'orchestrator', 'Tests failed')
            """, (task_id,))
            return "tests_failed"

        # Build passed - ready for review
        return "success"

    if task.status == "in_progress":
        # Coder did NOT update status
        git_status = run("git status --porcelain")

        if git_status:
            log_warning("Coder has uncommitted work but didn't submit")
            return "retry_next_cycle"
        else:
            log_warning("Coder produced no changes")
            return "retry_next_cycle"

    return "unexpected_state"

def run_build_command():
    """Run the project's build command from config or auto-detect."""
    config = load_project_config()

    # Use configured build command or auto-detect
    build_cmd = config.get('build', {}).get('command')

    if not build_cmd:
        build_cmd = detect_build_command()

    if not build_cmd:
        log_warning("No build command found - skipping build verification")
        return Result(exit_code=0)  # Pass if no build system

    return run(build_cmd, timeout=300)  # 5 min timeout

def detect_build_command():
    """Auto-detect build command from project files."""
    if exists("package.json"):
        pkg = json.load(open("package.json"))
        if "build" in pkg.get("scripts", {}):
            return "npm run build"
        return "npm install"  # At minimum, deps should install

    if exists("Cargo.toml"):
        return "cargo build"

    if exists("go.mod"):
        return "go build ./..."

    if exists("pyproject.toml") or exists("setup.py"):
        return "pip install -e . && python -m py_compile $(find . -name '*.py')"

    if exists("Makefile"):
        return "make"

    return None
```

### For Reviewer

```python
def validate_reviewer_output(task_id, previous_status):
    task = read_task(task_id)

    if task.status == "completed":
        # Reviewer approved
        return "approved"

    if task.status == "in_progress":
        # Reviewer rejected, back to coder
        return "rejected"

    if task.status == "disputed":
        # Reviewer created dispute
        return "disputed"

    if task.status == "review":
        # Reviewer did NOT take action
        log_warning("Reviewer did not approve/reject/dispute")
        return "retry_next_cycle"

    return "unexpected_state"
```

### Retry Behavior

If LLM doesn't update status:
1. Log the failure with full output
2. On next cron cycle, same task is picked up again
3. If resuming coder work, include `git diff` in prompt so new LLM sees partial work
4. No automatic retry limit - human can manually skip if stuck

---

## Rejection Limits

### Max 15 Rejections

After 15 rejections, the task is marked as `failed`:

```python
def handle_rejection(task_id):
    task = read_task(task_id)
    task.rejection_count += 1

    if task.rejection_count >= 15:
        task.status = "failed"
        log_error("Task exceeded max rejections", task_id)
        create_dispute(
            task_id,
            reason="Exceeded 15 rejections without resolution",
            type="system",
            auto=True
        )
        return "failed"

    task.status = "in_progress"
    return "retry"
```

### Failed Status

`failed` is a **terminal state**. The project cannot continue automatically.

When a task fails:
1. Loop stops for this task
2. Dispute is auto-created with full history
3. Human must intervene
4. Human can: resolve the dispute, manually complete, or delete the task

This should be rare. If tasks are regularly hitting 15 rejections, the specification is unclear.

---

## Dispute Flow (Updated)

### From Coder

Coder can dispute reviewer's rejection:
```bash
steroids dispute create {task_id} --reason "I believe X is correct because..." --type coder
```

### From Reviewer

Reviewer has two options:

**Hard dispute** (blocks task):
```bash
steroids dispute create {task_id} --reason "Architecture issue" --type reviewer
```

**Soft dispute** (approve anyway):
```bash
steroids tasks approve {task_id} --model X --notes "Minor: I disagree with Y but approving"
```

The soft dispute is logged but doesn't block. Coder can:
- Address it in a future task
- Ignore it if they disagree
- No formal resolution needed

### Dispute Types

| Type | Created By | Effect |
|------|------------|--------|
| `coder` | Coder after rejection | Task → disputed, blocks |
| `reviewer` | Reviewer during review | Task → disputed, blocks |
| `minor` | Reviewer with approve | Logged, task → completed |
| `system` | Auto after 15 rejections | Task → failed |

---

## File Discovery

How the orchestrator finds relevant files for prompts:

```python
def find_relevant_files(project_path, source_file):
    files = []

    # 1. Parse source file for referenced paths
    spec_content = read_file(source_file)
    paths_in_spec = extract_paths(spec_content)  # regex for file paths
    files.extend(paths_in_spec)

    # 2. Find files matching keywords in task title
    keywords = task_title.lower().split()
    for keyword in keywords:
        matches = glob(f"**/*{keyword}*", project_path)
        files.extend(matches[:5])  # Limit to 5 per keyword

    # 3. Always include key files
    standard_files = [
        "AGENTS.md",
        "CLAUDE.md",
        "README.md",
        "package.json",
        "tsconfig.json",
        "pyproject.toml"
    ]
    for f in standard_files:
        if exists(join(project_path, f)):
            files.append(f)

    # 4. Limit total context size
    return dedupe(files)[:20]  # Max 20 files
```

---

## Prompt Size Limits

To avoid context overflow:

| Component | Max Size |
|-----------|----------|
| Specification content | 10,000 chars |
| AGENTS.md content | 5,000 chars |
| Git diff | 20,000 chars |
| Relevant files summary | 10,000 chars |
| **Total prompt** | ~50,000 chars |

If content exceeds limits, truncate with note:
```
[Content truncated. Full file at: {path}]
```

---

## Related Documentation

- [ORCHESTRATOR.md](./ORCHESTRATOR.md) - Main loop and how prompts are used
- [AI-PROVIDERS.md](./AI-PROVIDERS.md) - CLI invocation and logging
- [DISPUTES.md](./DISPUTES.md) - Dispute handling
