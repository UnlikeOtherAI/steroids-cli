# Steroids Roadmap

## Multi-Agent Parallel Reviews

**Status:** Planned

Currently each task gets one reviewer. This feature enables multiple AI agents to review the same submission in parallel, producing a richer, more reliable review.

### Vision
- Configure N reviewers per task (e.g., Claude + Gemini + Codex reviewing simultaneously)
- Each reviewer produces an independent verdict (approve/reject with notes)
- All reviews are collected and sent to the **orchestrator**
- The orchestrator merges the reviews into a single coherent decision: approve or reject
- On rejection, the orchestrator synthesizes all reviewer feedback into unified, non-contradictory notes for the coder
- Catches blind spots that a single reviewer misses (different models have different strengths)

### Flow
```
Task in review
    ↓
Reviewer A (Claude)  ──┐
Reviewer B (Gemini)  ──┼──→  Orchestrator receives all reviews
Reviewer C (Codex)   ──┘         ↓
                          Merges into single verdict
                              ↓
                    Approve → completed
                    Reject  → unified feedback → coder
```

### Design Considerations
- New config section: `ai.reviewers[]` — array of reviewer configs instead of single `ai.reviewer`
- Parallel invocation: all reviewers run concurrently, wait for all to complete
- Orchestrator merging: the orchestrator sees all reviews and produces one decision. It resolves contradictions (e.g., one approves, another rejects the same thing) and prioritizes actionable feedback.
- Cost awareness: N reviewers = N invocations per review cycle. Need clear cost visibility.
- Backward compatible: single reviewer config still works (array of one, orchestrator pass-through)
- Coordinator impact: coordinator guidance must address all reviewers' concerns, not just one

---

## Parallel Branch Runners (Clone & Conquer)

**Status:** Planned

When sections have no dependencies on each other, there's no reason to work on them sequentially. This feature clones the project into isolated temp directories and runs independent branches of work in parallel.

### Vision
- Analyze the section dependency graph to find independent subgraphs
- For each independent subgraph, clone the repo into a temp working directory
- Spin up a dedicated runner per clone, each working its own branch
- Each runner creates a feature branch (e.g., `steroids/section-<id>`)
- When a runner completes all tasks in its subgraph, it pushes the branch
- A final merge phase brings all branches together (rebase or merge)
- Massive throughput improvement: N independent sections = N parallel workstreams

### Design Considerations
- Git branch strategy: each clone works on its own branch to avoid conflicts
- Merge conflicts: independent sections *should* be conflict-free, but need detection + human escalation
- Resource limits: config for max parallel clones (disk space, API rate limits, cost)
- Progress visibility: `steroids runners list` shows all clones and their progress
- Cleanup: temp clones are removed after successful merge
- Failure handling: if one branch fails, others continue. Failed branch stays for debugging.
- Section locking: once a section is claimed by a parallel runner, other runners skip it
- Cost controls: parallel runners multiply API costs linearly. Integrate with credit pause system.

### Workflow
```
steroids runners start --parallel          # auto-detect independent sections, clone & run
steroids runners start --parallel --max 3  # limit to 3 parallel clones
steroids runners list                      # shows main + cloned runners
steroids runners merge                     # merge completed branches back
```

### Prerequisites
- Section dependency graph must be accurate (garbage in, garbage out)
- Git remote must be configured (branches need to be pushed)
- Sufficient API credits for parallel invocations

---

## PR-Based Task Workflow

**Status:** Planned

Each task optionally creates a PR instead of committing directly to the main branch. A separate merge orchestrator handles bringing everything together.

### Vision
- Each task's coder works on a feature branch and opens a PR when done
- Reviewer reviews the PR (not just the code — the actual diff against main)
- On approval, a **merge orchestrator** is responsible for merging PRs into main
- If a merge conflict occurs, the merge orchestrator spins up a coder + reviewer pair to resolve it
- Clean git history: each task = one PR = one merge commit

### Flow
```
Task picked up
    ↓
Coder creates branch: steroids/task-<id>
Coder implements, commits, opens PR
    ↓
Reviewer reviews the PR
    ↓
Approved → Merge orchestrator merges PR
    ↓
Merge conflict? → Coder fixes conflicts → Reviewer re-reviews → Merge
    ↓
PR merged → task completed → next task
```

### Design Considerations
- Config toggle: `git.prWorkflow: true` to enable (default: false for backward compat)
- Merge orchestrator: separate from the task orchestrator, runs after task approval
- Conflict resolution: the coder gets the conflict diff + both sides and resolves. Reviewer verifies the resolution doesn't break anything.
- Branch cleanup: merged branches are deleted automatically
- Parallel synergy: combines with Clone & Conquer — each parallel runner creates PRs, merge orchestrator handles the merge queue
- GitHub/GitLab integration: use `gh pr create` / `glab mr create` based on provider

---

## MiniMax Provider

**Status:** Planned

Add [MiniMax](https://www.minimax.io/) as a provider. MiniMax offers competitive coding models that can serve as coder, reviewer, or parallel reviewer.

### Requirements
- New provider implementation in `src/providers/minimax.ts`
- Support for MiniMax API (API key auth, chat completions endpoint)
- Register in provider registry alongside claude, gemini, codex
- Add to `ai.*.provider` enum options in config schema
- CLI detection: determine if MiniMax has a CLI tool or if it's API-only
- If API-only: invoke via HTTP (like the OpenAI provider pattern) rather than spawning a CLI subprocess

---

## Ollama Provider (Local Models)

**Status:** Planned

Add [Ollama](https://ollama.com/) as a provider, enabling fully local/offline AI execution with no API costs.

### Vision
- Run coder and/or reviewer using local models via Ollama
- Zero API cost — useful for development, testing, and cost-sensitive workflows
- Mix and match: use a cloud model for coding and a local model for reviewing (or vice versa)
- Support any model Ollama can run (llama, codellama, deepseek-coder, mistral, etc.)

### Requirements
- New provider implementation in `src/providers/ollama.ts`
- Communicate via Ollama's local HTTP API (`http://localhost:11434/api/chat`)
- Config: model name, Ollama host/port (default localhost:11434)
- Register in provider registry
- Add to `ai.*.provider` enum options in config schema
- Health check: verify Ollama is running and the configured model is pulled
- No CLI subprocess — Ollama runs as a background service, provider talks to its API

### Config Example
```yaml
ai:
  coder:
    provider: ollama
    model: deepseek-coder-v2:latest
  reviewer:
    provider: claude
    model: claude-sonnet-4
```

### Considerations
- Performance: local models are slower and less capable than cloud models. May need longer timeouts.
- Context window: many local models have smaller context windows. Task specs + code may need truncation.
- Quality tradeoff: best suited for reviewer role or simpler tasks. Cloud models likely still better for complex coding.
- Ollama must be installed and running separately — Steroids doesn't manage it.
