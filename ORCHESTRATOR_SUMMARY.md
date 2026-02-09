# Orchestrator Design Summary

**Date:** 2026-02-09
**Purpose:** Replace unreliable CLI command execution in prompts with structured JSON-based workflow orchestration

---

## Problem Statement

Previously, coder and reviewer were instructed to run CLI commands to update task status:
```bash
steroids tasks update <id> --status review
steroids tasks approve <id>
steroids tasks reject <id>
```

**Issues:**
- LLMs forget to run commands
- Commands fail but execution continues
- Status parsing is brittle
- No way to handle ambiguous outcomes
- Coder/reviewer mix workflow logic with actual work

---

## New Approach

**Separation of Concerns:**
- **Coder**: Just implement the task, commit code, describe what was done
- **Reviewer**: Just review the code, provide feedback, state approval/rejection
- **Orchestrator**: Analyze their outputs, make all workflow decisions

**Orchestrators** are small, focused AI calls that:
1. Take coder/reviewer output + git state as input
2. Return structured JSON with workflow decisions
3. Have explicit decision rules and confidence scores
4. Are cheap to run (use fast models like Haiku/GPT-4o-mini)

---

## Architecture

```
┌─────────────────┐
│  Loop Manager   │
└────────┬────────┘
         │
         ├─► Coder Phase
         │   ├─► invoke coder (15-30min)
         │   ├─► gather git state
         │   └─► Coder Orchestrator (5-10sec)
         │       └─► JSON: {action, next_status, confidence}
         │
         └─► Reviewer Phase
             ├─► invoke reviewer (10-20min)
             ├─► gather git context
             └─► Reviewer Orchestrator (5-10sec)
                 └─► JSON: {decision, feedback, next_status, should_push}
```

### Orchestrator 1: Coder Output Analyzer

**Input:**
- Task metadata (id, title, description, rejection notes)
- Coder execution (stdout, stderr, exit code, timeout, duration)
- Git state (commits, files changed, uncommitted changes, diff summary)

**Output:**
```json
{
  "action": "submit | retry | stage_commit_submit | error",
  "reasoning": "1-2 sentence explanation",
  "next_status": "review | in_progress | failed",
  "commit_message": "...", // only if stage_commit_submit
  "error_type": "timeout | no_changes | invalid_state", // only if error
  "confidence": 0.85
}
```

**Actions:**
- **submit**: Work complete, move to review
- **retry**: Transient issue, try again
- **stage_commit_submit**: Work done but not committed, auto-commit then submit
- **error**: Fatal failure (timeout, no progress, cannot proceed)

### Orchestrator 2: Reviewer Output Analyzer

**Input:**
- Task metadata (id, title, rejection count)
- Reviewer execution (stdout, stderr, exit code, duration)
- Git context (commit hash, files changed)

**Output:**
```json
{
  "decision": "approve | reject | dispute | skip | ambiguous",
  "reasoning": "1-2 sentence explanation",
  "feedback": "Extracted notes for coder or audit trail",
  "next_status": "completed | in_progress | disputed | skipped | review",
  "confidence": 0.92,
  "should_push": true
}
```

**Decisions:**
- **approve**: Implementation correct, mark completed
- **reject**: Issues found, send back to coder with feedback
- **dispute**: Fundamental disagreement, escalate
- **skip**: External setup required, mark skipped
- **ambiguous**: Unclear decision, stay in review for retry

---

## Decision Rules (Explicit)

### Coder Orchestrator

| Condition | Action | Confidence |
|-----------|--------|------------|
| timed_out = true | error (timeout) | 0.95+ |
| no commits + no files changed + exit 0 | error (no_changes) | 0.90+ |
| exit 0 + commits + "ready for review" | submit | 0.90+ |
| exit 0 + files changed + uncommitted | stage_commit_submit | 0.75+ |
| exit 0 + commits + no errors in output | submit | 0.70-0.85 |
| exit != 0 + transient error signals | retry | 0.70+ |
| exit != 0 + no progress | error (invalid_state) | 0.80+ |

### Reviewer Orchestrator

| Condition | Decision | Confidence |
|-----------|----------|------------|
| stdout contains "steroids tasks approve" | approve | 0.95+ |
| stdout contains "steroids tasks reject" | reject | 0.95+ |
| stdout contains "steroids dispute create" | dispute | 0.95+ |
| stdout contains "APPROVED" or "LGTM" | approve | 0.85-0.92 |
| stdout contains "REJECTED" or "needs changes" | reject | 0.85-0.92 |
| stdout has checkbox list "- [ ]" | reject | 0.88+ |
| positive language, no issues | approve | 0.70-0.82 |
| specific bugs/issues mentioned | reject | 0.82+ |
| no clear decision | ambiguous | 0.30-0.60 |

---

## Confidence Scoring

**0.9-1.0**: Explicit signals (commands run, clear statements)
**0.7-0.89**: Strong signals (decision language, patterns)
**0.5-0.69**: Inferred from context (work done but no explicit "done")
**0.3-0.49**: Conflicting signals (mixed positive/negative)
**0.0-0.29**: Very unclear (fallback, parsing failed)

**Thresholds:**
- confidence < 0.50 → log warning, may need human review
- confidence < 0.30 → create feedback task for human
- For ambiguous reviewer decisions < 0.60 → retry with stricter prompt

---

## Example Scenarios

### Scenario 1: Clean Success

**Coder Output:**
```
Implemented user login endpoint.
Added tests: test_login_success, test_login_invalid_password
All tests pass.
Ready for review.
```
- Exit code: 0
- Commits: 1 ("feat: add user login endpoint")
- Files: ["src/api/auth.ts", "tests/auth.test.ts"]

**Coder Orchestrator Result:**
```json
{
  "action": "submit",
  "reasoning": "Coder completed work, created commit, tests pass, explicitly ready.",
  "next_status": "review",
  "confidence": 0.95
}
```

**Loop Action:** Move task to review status, invoke reviewer

---

**Reviewer Output:**
```
Implementation looks good.
Tests cover the main cases.
No security issues found.
APPROVED.
```
- Exit code: 0
- Ran: `steroids tasks approve abc123`

**Reviewer Orchestrator Result:**
```json
{
  "decision": "approve",
  "reasoning": "Reviewer explicitly approved and ran approve command.",
  "feedback": "Implementation good, tests adequate, no security issues.",
  "next_status": "completed",
  "confidence": 0.98,
  "should_push": true
}
```

**Loop Action:** Mark task completed, push to remote

---

### Scenario 2: Work Done But Not Committed

**Coder Output:**
```
Fixed the validation bug in validateForm().
Tested manually, works now.
```
- Exit code: 0
- Commits: 0
- Uncommitted changes: true
- Files changed: ["src/forms/validator.ts"]

**Coder Orchestrator Result:**
```json
{
  "action": "stage_commit_submit",
  "reasoning": "Work complete but not committed. Auto-committing before review.",
  "next_status": "review",
  "commit_message": "fix: correct validation logic in form handler",
  "confidence": 0.82
}
```

**Loop Action:**
1. Run `git add -A && git commit -m "fix: correct validation logic..."`
2. Move task to review status

---

### Scenario 3: Ambiguous Review

**Reviewer Output:**
```
The error handling is better but I'm not sure if this covers all edge cases.
Need to verify the timeout scenario.
Also the logging looks good.
```
- Exit code: 0
- No command visible

**Reviewer Orchestrator Result:**
```json
{
  "decision": "ambiguous",
  "reasoning": "Mixed feedback without clear approve/reject decision.",
  "feedback": "Uncertainty about edge cases, timeout verification needed. Logging approved.",
  "next_status": "review",
  "confidence": 0.45,
  "should_push": false
}
```

**Loop Action:**
1. Log warning about low confidence
2. Retry reviewer with more explicit prompt: "You MUST make a decision: approve or reject"
3. If still ambiguous after retry, create feedback task for human

---

### Scenario 4: Timeout Error

**Coder Output:**
```
Started refactoring database layer...
Extracting BaseRepository...
(output ends abruptly)
```
- Exit code: 124
- Timed out: true
- Commits: 0
- Files: []

**Coder Orchestrator Result:**
```json
{
  "action": "error",
  "reasoning": "Coder timed out with no commits or file changes. Task may be too large.",
  "next_status": "failed",
  "error_type": "timeout",
  "confidence": 0.98
}
```

**Loop Action:**
1. Mark task as failed
2. Log timeout error to audit trail
3. Create feedback task: "Task too large, consider splitting"

---

## Implementation Files

### Created Documents

1. **ORCHESTRATOR_PROMPTS.md** (6.5kb)
   - Full prompt templates for both orchestrators
   - Input/output schemas
   - 3 examples per orchestrator (happy/edge/error)
   - Explicit decision rules
   - Confidence scoring guide

2. **ORCHESTRATOR_IMPLEMENTATION.md** (12kb)
   - TypeScript type definitions
   - Prompt generation functions
   - JSON parsing with fallbacks
   - Loop integration code
   - Testing examples
   - Configuration setup
   - Performance optimizations
   - Migration path (4 phases)
   - Metrics tracking

3. **ORCHESTRATOR_SUMMARY.md** (this file, 5kb)
   - High-level overview
   - Architecture diagram
   - Decision rules table
   - Example scenarios with full flow

### Code Structure

```
src/orchestrator/
├── types.ts                    # Input/output interfaces
├── coder-analyzer.ts           # Coder orchestrator
├── reviewer-analyzer.ts        # Reviewer orchestrator
├── index.ts                    # Exports
└── __tests__/
    ├── coder-analyzer.test.ts
    └── reviewer-analyzer.test.ts

src/commands/
└── loop-phases.ts              # Enhanced with orchestrator calls
```

---

## Integration Steps

### 1. Add Types
```bash
# Copy type definitions from ORCHESTRATOR_IMPLEMENTATION.md
touch src/orchestrator/types.ts
```

### 2. Implement Analyzers
```bash
# Copy coder-analyzer.ts and reviewer-analyzer.ts
# Implement prompt generation and JSON parsing
```

### 3. Update Loop
```bash
# Modify loop-phases.ts to call orchestrators after coder/reviewer
# Use orchestrator decisions instead of parsing CLI commands
```

### 4. Test
```bash
# Run tests to verify JSON parsing
npm test

# Test in real loop
steroids loop --once
```

### 5. Monitor
```bash
# Track orchestrator metrics
steroids orchestrator stats

# View decisions for a task
steroids orchestrator explain <task-id>
```

---

## Metrics & Success Criteria

### Performance
- Orchestrator latency: < 10 seconds (target: 5s with Haiku)
- Parsing success rate: > 95% (valid JSON output)
- Fallback rate: < 5% (needed regex extraction)

### Accuracy
- Coder orchestrator agreement with manual labels: > 90%
- Reviewer orchestrator agreement: > 90%
- Low confidence decisions (<0.5): < 10% of total

### Confidence Distribution (Healthy)
```
0.9-1.0: 60%  (most decisions are clear)
0.7-0.89: 25% (some inference needed)
0.5-0.69: 10% (ambiguous but reasonable)
0.0-0.49: 5%  (unclear, may need human)
```

### Cost
- Orchestrator cost per task: ~$0.002 (Haiku at $0.80/$4.00 per MTok)
- Compared to coder/reviewer: ~$0.20-$0.50 per task
- Orchestration overhead: <1% of total AI cost

---

## Migration Path

### Phase 1: Observe (1-2 weeks)
- Add orchestrators to loop
- Log decisions alongside existing CLI parsing
- Compare: orchestrator vs CLI command results
- Measure: accuracy, confidence distribution, latency
- **No changes to task status logic yet**

### Phase 2: Advise (1 week)
- Show orchestrator decisions in loop output
- Keep CLI commands as primary decision method
- Flag disagreements for investigation
- Build confidence in orchestrator accuracy

### Phase 3: Decide (Implementation)
- Make orchestrator decisions authoritative
- Remove CLI command instructions from coder/reviewer prompts
- Simplify prompts to focus on work only
- **This is the breaking change**

### Phase 4: Optimize (Ongoing)
- Switch to faster/cheaper models
- Add consensus voting (multi-model)
- Implement confidence-based routing
- Track metrics and fine-tune decision rules

---

## Rollback Plan

If orchestrators don't work well:

1. **Immediate**: Set confidence threshold to 0.95 (only use very clear decisions)
2. **Short-term**: Revert to CLI command parsing, keep orchestrators for logging only
3. **Long-term**: Refine decision rules, add more examples, try different models

The system is designed to degrade gracefully:
- Low confidence → fallback to safe defaults (retry, ambiguous)
- Parsing failure → regex extraction as backup
- Orchestrator timeout → use existing CLI command parsing

---

## Future Enhancements

### 1. Self-Learning
- Store human corrections when orchestrator is wrong
- Fine-tune on (input, correct_decision) pairs
- Improve accuracy over time

### 2. Multi-Model Ensemble
- Run 3 orchestrators in parallel
- Use voting or confidence weighting
- Consensus improves accuracy

### 3. Contextual Adaptation
- Different prompts for different project types
- Learn project-specific patterns
- Adapt to team preferences

### 4. Interactive Debugging
```bash
steroids orchestrator explain <task-id>
steroids orchestrator reanalyze <task-id> --model gpt-4o
steroids orchestrator override <task-id> --action submit
```

---

## Security & Reliability

### Input Sanitization
- Truncate coder/reviewer output if > 50kb
- Strip ANSI codes and control characters
- Validate JSON before parsing

### JSON Parsing
- Primary: `JSON.parse()` with try/catch
- Fallback: Regex extraction
- Always validate required fields exist
- Clamp confidence to [0.0, 1.0]

### Error Handling
- Orchestrator timeout → fallback to retry
- Invalid JSON → use regex fallback, low confidence
- Missing fields → use safe defaults, log warning
- All errors logged to audit trail

### Prompt Injection Protection
- Orchestrator prompts are read-only templates
- User input (task titles, coder output) is clearly marked as "Input Context"
- Decision rules are hardcoded in prompt, not influenced by input
- Output is JSON only, no arbitrary code execution

---

## Cost Analysis

**Per task (with Haiku at $0.80/$4.00 per MTok):**

| Component | Input Tokens | Output Tokens | Cost |
|-----------|--------------|---------------|------|
| Coder | 8,000 | 4,000 | ~$0.023 |
| Reviewer | 6,000 | 2,000 | ~$0.013 |
| **Coder Orchestrator** | 4,000 | 150 | **~$0.004** |
| **Reviewer Orchestrator** | 3,500 | 150 | **~$0.003** |
| **Total** | 21,500 | 6,300 | **~$0.043/task** |

**Orchestration overhead: ~15% of total cost** (but catches errors before expensive retries)

**With GPT-4o-mini ($0.15/$0.60 per MTok):**
- Coder Orchestrator: ~$0.0009
- Reviewer Orchestrator: ~$0.0008
- **Total overhead: ~$0.002/task (4% of total)**

**Recommended:** Use GPT-4o-mini or Haiku for orchestrators, reserve expensive models for coder/reviewer.

---

## Questions & Answers

**Q: Why not just parse CLI commands from output?**
A: LLMs are unreliable at following multi-step instructions. They forget to run commands, commands fail silently, and parsing is brittle. Structured JSON with explicit decision rules is more robust.

**Q: What if the orchestrator gives the wrong decision?**
A: Confidence scores flag uncertain decisions. Low confidence triggers warnings, human review, or retries with stricter prompts. Over time, we can fine-tune on corrections.

**Q: Isn't this adding complexity?**
A: Yes, but it centralizes complexity. Instead of every prompt needing workflow logic, we have two focused orchestrators. Debugging is easier when decisions are logged as JSON.

**Q: Can we skip orchestrators and just use rules?**
A: Hard-coded rules would miss edge cases. LLMs can interpret nuanced situations ("work done but coder unsure" vs "work done confidently"). The prompts include explicit rules, but LLMs can reason beyond them.

**Q: What if coder/reviewer output is 100kb+ of logs?**
A: Truncate before sending to orchestrator (keep first 20kb + last 10kb). Most decisions can be made from summaries. For very large outputs, consider summarization step first.

**Q: How do we handle model drift (GPT-5, Claude 4, etc.)?**
A: Decision rules are explicit in prompts. New models should follow them. If behavior changes, we can adjust examples or switch back to previous model. Metrics track accuracy over time.

---

## Conclusion

This orchestrator design:
- ✅ Separates concerns (work vs workflow)
- ✅ Provides structured, parseable decisions
- ✅ Includes confidence scores for uncertainty handling
- ✅ Has explicit, testable decision rules
- ✅ Degrades gracefully on failure
- ✅ Is cost-effective (~2-4% overhead)
- ✅ Enables future improvements (ensemble, self-learning)

**Next Steps:**
1. Implement types and analyzers (1-2 days)
2. Integrate into loop with observe mode (1 day)
3. Test on real tasks, measure accuracy (1 week)
4. Phase 3: make authoritative (1 day)
5. Monitor and optimize (ongoing)

**Total estimated time:** 2 weeks to production-ready

---

**Document Version:** 1.0
**Last Updated:** 2026-02-09
**Author:** Claude Sonnet 4.5 (via steroids-cli development)
