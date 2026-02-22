# Steroids Agent Guidelines

> **IMPORTANT:** This file is a companion to [CLAUDE.md](./CLAUDE.md). You MUST read both files before starting any work. They are always linked — changes to one may require updates to the other.

## Cross-Provider Design Reviews (CRITICAL)

**For any significant design or architectural change, you MUST get a second opinion from a different AI provider before implementation.**

This applies to:
- New features spanning 3+ files
- Architectural changes (new tables, new API routes, new component patterns)
- Design documents and specifications
- Changes to the orchestrator, loop, or provider systems
- Prompt changes (already covered in CLAUDE.md, but reinforced here)

### How to Conduct a Review

1. **Write the design/spec first.** Complete your thinking before seeking review.
2. **Send to a different provider.** If Claude wrote it, send to Codex or Gemini. If Codex wrote it, send to Claude or Gemini.
3. **Strict Adversarial Persona (MANDATORY):** You must instruct the reviewer to be **adversarial**. It is not enough to check if it "works." The reviewer must explicitly look for:
   - **Technical Debt**: Are we taking shortcuts that will hurt us later?
   - **Architectural Regression**: Are we losing features (like streaming or isolation) that other providers have?
   - **Type Safety**: Are we using `any` or bypassing the type system?
   - **Logic Gaps**: Does `isAvailable` actually mean the service is ready for the specific task?
4. **Non-Interactive Mode (CRITICAL):** Reviews MUST be run in non-interactive mode (e.g., using `--print` or `--exec` flags) to ensure that output is captured correctly and the automated workflow is not blocked by interactive prompts.
5. **The review is advisory, NOT the source of truth.** The reviewing model may be wrong, may miss context, or may over-engineer. Treat its output as additional data points, not mandates.
6. **Assess each finding independently.** For each point the reviewer raises:
   - Is it valid given the actual codebase? (Check the code, don't assume)
   - Is it relevant to the current scope?
   - Is it actionable now, or a future concern?
   - Does it conflict with existing patterns?
7. **Document both perspectives.** Append a "Cross-Provider Review" section to your design doc showing: the finding, your assessment, and the decision (adopt/defer/reject with reasoning).
8. **Commit the combined document.** The review trail is valuable for future reference.

### What NOT to Do

- Do NOT blindly implement everything the reviewer suggests
- Do NOT treat the review as a blocker — if the reviewer is unresponsive or unhelpful, proceed with your own judgment and note that review was attempted
- Do NOT skip the review for "small" changes that turn out to be big (when in doubt, review)
- Do NOT let a reviewer push you toward over-engineering; keep solutions minimal

### When to Skip Review

- Typo fixes, formatting changes, documentation-only updates
- Bug fixes with clear root cause and minimal blast radius
- Changes to a single file under 50 lines
- Urgent hotfixes (review post-merge)

---

## Design Document Standards

When creating design documents for new features:

1. **Problem Statement**: What's broken or missing, and why it matters
2. **Current Behavior**: How the system works today (with file references)
3. **Desired Behavior**: What should happen instead
4. **Design**: Technical approach with code sketches (not final code)
5. **Implementation Order**: Phased plan with dependencies
6. **Edge Cases**: Table of scenarios and their handling
7. **Non-Goals**: Explicitly state what's out of scope
8. **Cross-Provider Review**: Appendix with review findings and assessments

Design docs live in `docs/` and are committed to the repo before implementation begins.

---

## Task Creation from Design Docs

After a design document is reviewed and finalized:

1. Create steroids tasks for each implementation phase
2. Tasks should be granular enough for a single coder session (1-3 files changed)
3. Reference the design doc in each task description
4. Set section and dependencies appropriately
5. Let the runner pick up the tasks — do not implement manually unless the runner is broken

---

## Agent Behavior Rules

### File References
- Always read CLAUDE.md and AGENTS.md before starting work
- Follow the coding standards in CLAUDE.md strictly
- Follow the review and design process in AGENTS.md

### Linked Files
| File | Purpose |
|------|---------|
| [CLAUDE.md](./CLAUDE.md) | Coding standards, workflow, constraints |
| [AGENTS.md](./AGENTS.md) | Design reviews, agent behavior, task process |
| [docs/](./docs/) | Feature designs and architecture documentation |

Any agent (Claude, Codex, Gemini, or future providers) working on this codebase must read both CLAUDE.md and AGENTS.md as their first action.

---

## Follow-up Tasks (Non-blocking improvements)

When acting as a **REVIEWER**, if you identify improvements that are valuable but **not blocking** for the current task, you should suggest them as **Follow-up Tasks** rather than rejecting the submission.

### When to create a Follow-up
- Adding more comprehensive tests where basic tests exist
- Minor refactors for readability
- Documentation improvements
- Extracting hardcoded values to config
- Performance optimizations where current performance is acceptable

### When to REJECT instead
- Missing critical functionality from task requirements
- Security vulnerabilities
- Data corruption risks
- Test failures or zero test coverage
- Required functionality not working

### Follow-up Task Requirements
Each follow-up must include:
1. **WHAT**: Specific work to be done (files, modules, functions)
2. **WHY**: Reason it's needed (technical debt, missing functionality, etc.)
3. **HOW**: Suggested approach or implementation hints

**Limit:** Suggest a maximum of 3 follow-up tasks per approval. Prioritize the most impactful ones.
