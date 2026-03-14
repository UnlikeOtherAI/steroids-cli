# Claude Code — project context
@./AGENTS.md

## Claude-specific notes
- Keep instructions modular and prefer progressive disclosure.
- If deeper scoped behavior is needed, use `.claude/rules/` files.

## Debugging Protocol
- **Always check logs first** before using browser automation or code analysis. Look at server logs (`~/.steroids/logs/api.log`, `~/.steroids/logs/webui.log`), runner logs (`~/.steroids/runners/logs/`), and browser console errors before diving into source code.

## How to Run Parallel Adversarial Reviews (Claude + Codex)

When a design requires cross-provider review (see AGENTS.md for when), dispatch Claude and Codex **simultaneously** by sending a single message with two `Task` tool calls:

**Call 1 — Claude reviewer:**
```
Task tool:
  subagent_type: superpowers:code-reviewer
  prompt: "Adversarial review of the following design. Look for technical debt,
           architectural regressions, type safety gaps, and logic holes. Be harsh.
           Do not suggest over-engineering. [paste full design doc content here]"
```

**Call 2 — Codex reviewer:**
```
Task tool:
  subagent_type: Bash
  prompt: "Run: timeout 1800 codex exec \"[adversarial review prompt with full design text]\""
```

Both calls go in a **single message** so they execute in parallel. When both return, assess each finding independently per AGENTS.md §"How to Conduct a Review" and append a Cross-Provider Review section to the design doc with adopt/defer/reject decisions for each finding.
