# Steroids Roadmap

## Multi-Agent Parallel Reviews

**Status:** Planned

Currently each task gets one reviewer. This feature enables multiple AI agents to review the same submission in parallel, producing a richer, more reliable review.

### Vision
- Configure N reviewers per task (e.g., Claude + Gemini + Codex reviewing simultaneously)
- Each reviewer produces an independent verdict (approve/reject with notes)
- Configurable consensus strategy: unanimous, majority, any-approve
- Combined feedback is merged and sent back to the coder on rejection
- Catches blind spots that a single reviewer misses (different models have different strengths)

### Design Considerations
- New config section: `ai.reviewers[]` — array of reviewer configs instead of single `ai.reviewer`
- Parallel invocation: all reviewers run concurrently, wait for all to complete
- Consensus resolution: if 2/3 approve but one rejects, what happens? Configurable policy.
- Cost awareness: N reviewers = N invocations per review cycle. Need clear cost visibility.
- Backward compatible: single reviewer config still works (array of one)
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
