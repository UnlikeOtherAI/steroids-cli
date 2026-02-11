# Implementation Guide

> **Canonical paths and status values are defined in [brief.md](./brief.md).** This document uses those paths.
> **Prompt specifications are in [prompt-specifications.md](./prompt-specifications.md).**

## Repo File Structure (Git-Committed + State)

> **See [brief.md](./brief.md) for the canonical path table.**

### Committed to Git (Stable Artifacts)

```
my-project/
├── docs/
│   ├── blueprints/                        # ✅ Approved blueprint docs
│   │   ├── auth-flow/
│   │   │   ├── blueprint.md               # Main doc (committed)
│   │   │   └── assets/
│   │   │       ├── 2026-02-11-login-screen.png
│   │   │       ├── 2026-02-11-signup-flow.png
│   │   │       └── annotations.json
│   │   └── billing-system/
│   │       ├── blueprint.md
│   │       └── assets/
│   │
│   ├── personas/                          # ✅ Reusable persona definitions
│   │   ├── per-001-pm-growth.yaml
│   │   ├── per-002-staff-backend.yaml
│   │   ├── per-003-designer-lead.yaml
│   │   └── per-004-security-lead.yaml
│   │
│   ├── decisions/                         # ✅ Decision logs (DEC-### prefix)
│   │   ├── dec-001-polling-vs-realtime.md
│   │   ├── dec-002-new-deps-policy.md
│   │   └── [more decisions...]
│   │
│   └── architecture/
│       └── snapshot.md                    # ✅ Generated (updated via wizard)
│
└── specs/                                 # Generated task specs (from approved blueprints)
    └── auth-flow/
        ├── sign-in.md
        ├── oauth-integration.md
        └── token-management.md
```

### In `.steroids/` (Generated State, Not Committed)

```
.steroids/
├── blueprints/
│   ├── manifests.json                    # Index of all blueprints + metadata
│   │  {
│   │    "auth-flow-001": {
│   │      "id": "auth-flow-001",
│   │      "title": "Auth Flow",
│   │      "status": "approved",
│   │      "path": "docs/blueprints/auth-flow/blueprint.md",
│   │      "personas": ["per-001", "per-002"],
│   │      "requirements": ["REQ-001", "REQ-002", ...],
│   │      "decisions": ["DEC-001"],
│   │      "created": "2026-02-10T14:30Z",
│   │      "last_review_run": "2026-02-11T08:00Z",
│   │      "approval_status": "approved_by_per-001",
│   │      "repo_commit_hash": "abc123..."
│   │    }
│   │  }
│   │
│   ├── requirements/                    # Indexed requirements
│   │  {
│   │    "REQ-001": {
│   │      "id": "REQ-001",
│   │      "document": "auth-flow-001",
│   │      "title": "User login",
│   │      "type": "Functional",
│   │      "source_personas": ["per-001", "per-002"],
│   │      "priority": "P0",
│   │      "acceptance_criteria": [...],
│   │      "conflicts_with": ["REQ-004"],
│   │      "resolution_decision": "DEC-001"
│   │    }
│   │  }
│   │
│   ├── review-runs/                     # Execution history (temp, can be pruned)
│   │  └── <review-run-id>.json
│   │     {
│   │       "id": "uuid-...",
│   │       "blueprint_id": "auth-flow-001",
│   │       "blueprint_revision": "abc123...",
│   │       "timestamp": "2026-02-11T08:00Z",
│   │       "models_used": ["claude-opus", "gpt-5-codex", "gemini-2.5"],
│   │       "outputs": {
│   │         "claude-opus": "raw output...",
│   │         "gpt-5-codex": "raw output...",
│   │         "gemini-2.5": "raw output..."
│   │       },
│   │       "extracted_issues": [
│   │         {
│   │           "id": "ISS-...",
│   │           "severity": "HIGH",
│   │           "category": "architecture",
│   │           "section": "7. Architecture",
│   │           "finding": "Proposes new pattern not in guardrails",
│   │           "model": "gemini-2.5",
│   │           "recommendation": "Use existing Service layer pattern"
│   │         }
│   │       ],
│   │       "synthesis_result": "path/to/synthesized/doc.md",
│   │       "status": "success"
│   │     }
│   │
│   └── db.yaml                          # Blueprint-related DB state
│      (manages concurrency, locks, etc.)
```

---

## Configuration (`.steroids/config.yaml`)

### Existing Section
```yaml
ai:
  default_provider: claude
  models:
    claude:
      api_key: ${ANTHROPIC_API_KEY}
      model: claude-sonnet-4-5-20250929
    codex:
      api_key: ${OPENAI_API_KEY}
      model: gpt-5-codex  # or fallback to gpt-5.2-codex
    gemini:
      api_key: ${GOOGLE_API_KEY}
      model: gemini-2.5-flash
```

### New Section (Blueprint Studio)
```yaml
docs:
  enabled: true

  # Repo paths (configurable, canonical defaults shown)
  paths:
    doc_root: docs
    blueprints_dir: docs/blueprints
    personas_dir: docs/personas
    decisions_dir: docs/decisions
    architecture_dir: docs/architecture
    assets_pattern: "docs/blueprints/{slug}/assets"

  # Orchestration roles
  orchestration:
    orchestrator:
      provider: claude
      model: claude-sonnet-4-5-20250929
    writer:
      provider: claude
      model: claude-sonnet-4-5-20250929
    reviewers:
      - name: code-feasibility
        provider: codex
        model: gpt-5-codex              # fallback: gpt-5.2-codex or codex-mini-latest
      - name: architecture
        provider: gemini
        model: gemini-2.5-flash
      - name: clarity
        provider: claude
        model: claude-opus-4-6          # optional; can be same as orchestrator

  # Quality gates
  verification_gate:
    required_sections:
      - Executive Summary
      - Goals / Non-goals
      - Personas & Stakeholders
      - Requirements Matrix
      - User Journeys
      - UX/UI Specification
      - Architecture Fit
      - Data Model / API Contracts
      - Edge Cases & Failure Modes
      - Security / Privacy Considerations
      - Observability
      - Test Plan
      - Rollout Plan
      - Open Questions
      - Review Status

    max_unresolved_critical: 0
    max_unresolved_high: 0
    max_unresolved_medium: 3

    # Architecture guardrails enforcement
    architecture_enforcement: strict  # options: strict, moderate, permissive
    open_questions_allowed: false

  # Review execution
  review_config:
    token_budget: 50000              # tokens per review run
    cost_ceiling: 25.00              # USD
    stop_after_n_criticals: 1        # escalate if repeated failures
    run_in_parallel: true

  # Templates
  templates:
    auto_load_from: .steroids/blueprints/templates
    available:
      - feature-spec
      - ui-spec
      - adr
      - bugfix-plan
      - refactor-plan

  # Integration
  export_tasks_enabled: true
  export_creates_steroids_specs: true

  # Persona library (project-level config)
  personas:
    library_path: docs/personas
    required_fields:
      - name
      - role
      - technical_level
    defaults:
      technical_level: 3
      decision_power: Contributor
```

---

## API Endpoints (WebUI Backend)

The Web Dashboard calls these endpoints. (Assume all return JSON unless noted.)

### Blueprint Management

```
GET  /api/v1/projects/:projectId/blueprints
     Query: ?status=draft|in-review|approved&type=feature-spec&limit=50&offset=0
     Returns: { blueprints: [...], total: 100, offset: 0 }

POST /api/v1/projects/:projectId/blueprints
     Body: { title, type, owner_personas: [...] }
     Returns: { id, status: "draft", ... }

GET  /api/v1/projects/:projectId/blueprints/:blueprintId
     Returns: { id, title, status, doc_path, personas, requirements, ... }

PATCH /api/v1/projects/:projectId/blueprints/:blueprintId
      Body: { title?, description?, status? }
      Returns: { updated blueprint }

POST /api/v1/projects/:projectId/blueprints/:blueprintId/commit
     Body: { commit_message? }
     Returns: { commit_hash, doc_path }

DELETE /api/v1/projects/:projectId/blueprints/:blueprintId
       Returns: { status: "archived" }
```

### Persona Management

```
GET  /api/v1/projects/:projectId/personas
     Returns: { personas: [...] }

POST /api/v1/projects/:projectId/personas
     Body: { name, role, technical_level, priorities, ... }
     Returns: { id, ... } + writes to docs/personas/<id>.yaml

GET  /api/v1/projects/:projectId/personas/:personaId
     Returns: { id, name, role, ... }

PATCH /api/v1/projects/:projectId/personas/:personaId
      Body: { updated fields }
      Returns: { updated persona }

POST /api/v1/personas/export
     Body: { persona_ids: [...] }
     Returns: { personas: [...] } as YAML download
```

### Requirements Management

```
GET  /api/v1/blueprints/:blueprintId/requirements
     Returns: { requirements: [...] }

POST /api/v1/blueprints/:blueprintId/requirements
     Body: { title, type, priority, source_personas, acceptance_criteria }
     Returns: { id: "REQ-###", ... }

PATCH /api/v1/blueprints/:blueprintId/requirements/:reqId
      Body: { priority?, status?, conflicts_with? }
      Returns: { updated requirement }

POST /api/v1/blueprints/:blueprintId/requirements/:reqId/merge
     Body: { merge_with_req_id }
     Returns: { deleted: REQ-ID, updated: REQ-ID }
```

### Review Management

```
POST /api/v1/blueprints/:blueprintId/reviews
     Body: { reviewers: ["code-feasibility", "architecture"], budget_tokens?: 50000 }
     Returns: { review_run_id, status: "queued" }

GET  /api/v1/blueprints/:blueprintId/reviews/:reviewRunId
     Returns: { id, models_used, issues: [...], status, timestamps }

POST /api/v1/blueprints/:blueprintId/reviews/:reviewRunId/synthesize
     Body: { generated_doc_path }
     Returns: { synthesis_status, doc_diff, updated_issues }

POST /api/v1/blueprints/:blueprintId/reviews/:reviewRunId/cancel
     Returns: { status: "cancelled" }
```

### Task Export

```
POST /api/v1/blueprints/:blueprintId/export-tasks
     Body: { section_name?: "Feature: Auth Flow", task_templates?: [...] }
     Returns: { task_ids: [...], section_id, created_specs: [...] }
```

### Architecture & Context

```
GET  /api/v1/projects/:projectId/architecture-snapshot
     Returns: { stack, patterns, forbidden_patterns, snapshot_content }

POST /api/v1/projects/:projectId/architecture-snapshot/generate
     Returns: { status: "generating..." } (async; webhook to poll)
```

### Document Edit

```
GET  /api/v1/blueprints/:blueprintId/document
     Returns: { markdown_content, frontmatter, last_edited_at }

PUT  /api/v1/blueprints/:blueprintId/document
     Body: { markdown_content, commit_message? }
     Returns: { saved, commit_hash? }
```

### Image Upload

```
POST /api/v1/blueprints/:blueprintId/assets/upload
     Body: FormData { files: [File, File, ...], tags?: [...] }
     Returns: { uploaded: [{ filename, path, relative_url }] }

GET  /api/v1/blueprints/:blueprintId/assets
     Returns: { assets: [{ filename, path, tags, caption, extracted_tokens }] }

DELETE /api/v1/blueprints/:blueprintId/assets/:assetId
       Returns: { deleted: true }
```

---

## Codex Integration (Technical Details)

### Option A – Codex CLI for Reviews (Recommended MVP)

Uses `codex exec` (non-interactive CLI mode) for deterministic review runs.

**Example command:**
```bash
codex exec \
  --workspace-mode read-only-sandbox \
  --output-schema '{"issues": [{"severity": "string", "finding": "string"}]}' \
  --image docs/blueprints/auth-flow/assets/login.png \
  -m gpt-5-codex \
  --temperature 0.3 \
  < review-prompt.txt
```

**Implementation:**
- Wrap `codex exec` calls in Node.js or Go subprocess
- Validate output against schema
- Extract structured issues from JSON response
- Store raw output in `.steroids/blueprints/review-runs/`

**Advantages:**
- Fast to ship (CLI wrapping)
- Deterministic (schema validation)
- Supports images (`--image` flag)
- Cheaper than full API (uses Codex CLI pricing)

**Limitations:**
- No multi-turn context (each review is stateless)
- Cannot use Codex App Server rich features

### Option B – Codex SDK for Orchestrator (Future Enhancement)

If you want Codex to be the orchestrator (multi-turn context preservation):

**Setup:**
```bash
npm install @openai/codex-sdk
```

**Example usage:**
```typescript
import { CodexClient } from '@openai/codex-sdk';

const client = new CodexClient({ apiKey: process.env.OPENAI_API_KEY });

// Start thread
const thread = await client.threads.create();

// Generate draft
const draftMessage = await client.messages.create(thread.id, {
  content: `Using these requirements..., generate a blueprint document...`,
  model: 'gpt-5-codex'
});

// Persona interview (multi-turn)
const interviewMessage = await client.messages.create(thread.id, {
  content: `Interview as PM: ...`,
  model: 'gpt-5-codex'
});

// Resume thread later
const resumed = await client.threads.retrieve(thread.id);
```

**Advantages:**
- Multi-turn context (persona threading)
- Thread lifecycle management (persist context)
- Rich structured outputs

**Limitations:**
- More complex implementation
- Higher latency (API calls vs CLI)
- Needs error handling for long-running threads

### Option C – Codex App Server (Rich Interactive UI)

Full bidirectional JSON-RPC for agent orchestration. Out of scope for MVP.

**Reference:** https://developers.openai.com/codex/app-server (See Codex docs for JSON-RPC spec)

---

## Multi-LLM Review Process (Technical)

### Parallel Execution (Pseudo-Code)

```typescript
async function runReviews(blueprint, selectedReviewers) {
  const reviewStreams = selectedReviewers.map(reviewer => {
    return runReviewStream(blueprint, reviewer);
  });

  // Wait for all in parallel (allSettled to handle partial failures)
  const settled = await Promise.allSettled(reviewStreams);
  const results = settled
    .filter(r => r.status === 'fulfilled')
    .map(r => (r as PromiseFulfilledResult<any>).value);
  const failures = settled
    .filter(r => r.status === 'rejected')
    .map(r => (r as PromiseRejectedResult).reason);

  // Extract + deduplicate issues
  const allIssues = results.flatMap(r => r.extracted_issues);
  const deduplicatedIssues = deduplicateIssues(allIssues);

  // Determine run status based on results
  const runStatus = results.length === 0
    ? 'failed'
    : failures.length > 0
      ? 'partial'
      : 'success';

  // Save review run
  const reviewRun = {
    id: generateUUID(),
    blueprint_id: blueprint.id,
    timestamp: new Date(),
    models_used: selectedReviewers.map(r => r.model),
    outputs: results.map(r => r.raw_output),
    extracted_issues: deduplicatedIssues,
    failures: failures.map(f => ({ error: f.message })),
    status: runStatus
  };

  await saveReviewRun(reviewRun);
  return reviewRun;
}

async function runReviewStream(blueprint, reviewer) {
  const prompt = buildReviewPrompt(blueprint, reviewer.role);

  // Call model (via API or CLI)
  const rawOutput = await callModel(reviewer.provider, prompt, {
    model: reviewer.model,
    images: blueprint.assets,
    schema: REVIEW_SCHEMA  // for Codex: --output-schema
  });

  // Parse output
  const parsed = JSON.parse(rawOutput);

  // Extract issues
  const issues = parsed.issues.map(issue => ({
    severity: issue.severity,
    category: issue.category,
    section: mapToDocSection(issue.section),
    finding: issue.finding,
    recommendation: issue.recommendation,
    model: reviewer.model,
    evidence: issue.evidence || null
  }));

  return {
    model: reviewer.model,
    raw_output: rawOutput,
    extracted_issues: issues
  };
}
```

### Synthesis (Integration, Not Append)

```typescript
async function synthesize(blueprint, reviewRun) {
  const doc = loadDocument(blueprint.path);

  // Group issues by section
  const issuesBySection = groupBy(reviewRun.extracted_issues, 'section');

  // For each section with issues, regenerate/update
  for (const [section, issues] of Object.entries(issuesBySection)) {
    const prompt = buildSynthesisPrompt(doc[section], issues);

    const updatedSection = await callOrchestratorModel(prompt);

    doc[section] = updatedSection;
  }

  // Add Review Status section
  doc['Review Status'] = generateReviewStatusSection(reviewRun);

  // Save updated doc
  await saveDocument(blueprint.path, doc);

  // Return diff for user review
  return computeDiff(originalDoc, doc);
}
```

---

## MVP Implementation Scope (Phase 1)

**Ship these features:**

1. ✅ **Persona CRUD**
   - Create, edit, delete personas
   - Save to `docs/personas/*.yaml`
   - Reuse across blueprints

2. ✅ **New Blueprint Wizard** (Steps A–G, simplified)
   - Basics, Context, Personas, Inputs, Interviews, Consolidation, Draft
   - Store draft in `.steroids/blueprints/manifests.json`
   - Generate initial doc

3. ✅ **Multi-LLM Review**
   - Parallel Codex + Gemini + Claude (via CLI or SDK)
   - Issue extraction
   - Store review runs in `.steroids/blueprints/review-runs/`

4. ✅ **Synthesis**
   - Integrate findings into doc
   - Update sections (not append)
   - Generate Review Status section

5. ✅ **Verification Gate**
   - Checklist enforcement
   - Block approval if checks fail

6. ✅ **Commit & Export**
   - Commit doc + assets to git
   - Generate implementation tasks

7. ✅ **CLI Document Editing**
   - View/edit blueprint markdown via CLI
   - View review findings via CLI
   - View commit + review history via CLI

**Defer to v2:**

- Image token extraction UI (auto-generate component table)
- Pixel-diff visual match scoring
- Requirements Register interactive board (WebUI)
- Decisions tab / ADR editor (WebUI)
- Conflict resolver UI (WebUI)
- Import existing docs
- Document Workspace (WebUI tabs)
- Persona Library full management (WebUI)
- Architecture Guardrails explicit UI (WebUI)
- Persona-aware interview questions (v1: generic template; v2: role-tailored)

**Rationale:** MVP is ~4-6 weeks work; v2 adds UX polish and advanced features.

---

## Test Plan

### Unit Tests
- Persona schema validation
- Requirement deduplication logic
- Issue extraction from review outputs
- Architecture snapshot generation

### Integration Tests
- End-to-end: Create blueprint → Run reviews → Synthesize → Approve → Export tasks
- Multi-model orchestration (Codex + Gemini + Claude)
- Git commit + asset storage
- Requirement conflict detection

### E2E Tests (WebUI)
- Create new blueprint (all 8 steps)
- Import and edit existing doc
- Run reviews and view results
- Edit document and re-run reviews
- Approve and export tasks

### Manual QA
- Test with each provider individually (Codex-only, Gemini-only, Claude-only)
- Test with reduced token budgets (verify failure handling)
- Test with network failures (retry logic)
- Test with large images (asset upload scaling)

---

## Rollout Plan

### Phase 1 (Weeks 1–6): CLI MVP
- CLI commands for full workflow (steroids blueprints new/review/synthesize/verify/commit/tasks)
- Persona CRUD (CLI)
- Architecture snapshot generation
- Multi-LLM parallel review
- Synthesis + verification gate
- Task export
- Internal alpha: Steroids team uses for their own docs

### Phase 2 (Weeks 7–12): WebUI + Polish
- Web dashboard (document workspace, persona library, requirements register)
- Decision Log editor (WebUI)
- Architecture Guardrails UI
- Improved image handling
- Limited public beta

### Phase 3 (Weeks 13–16): Advanced Features
- Persona simulation reviews
- Import existing docs
- Advanced visual spec extraction
- General availability

### Phase 4 (Future)
- Codex App Server integration (if rich interactive UI desired)
- Advanced persona interviewing
- Pixel-diff visual verification
- Multi-repo persona sharing

---

## Developer Notes

### Key Implementation Challenges

1. **Async Multi-Model Coordination**
   - Parallel review runs must not block each other
   - Timeouts + fallbacks for slow models
   - Cost tracking per model per project

2. **Architecture Snapshot Generation**
   - Fast enough to not block UX (~5-10s target)
   - Accurate pattern detection (may need custom heuristics per stack)
   - Caching strategy (invalidate on file changes)

3. **Markdown Diff + Merge**
   - Synthesis can conflict with user edits
   - Three-way merge (original, user-edited, synthesized)
   - Clear conflict markers in UI

4. **Image Asset Management**
   - Scale images for display (web + archive full res)
   - Extract text from screenshots (OCR optional, for future)
   - Version control strategy (commit large files vs store externally)

5. **Deterministic Gating**
   - "Approval gate" must be non-ambiguous
   - No manual override without audit trail
   - Disputes must be resolvable

### Recommended Tech Stack

- **Backend:** Existing Steroids stack (Node.js / TypeScript)
- **Database:** Existing `.steroids/` storage + new JSON/YAML manifests
- **Web UI:** Existing Steroids dashboard framework (React + Vite assumed)
- **LLM Calls:** Existing Steroids orchestrator abstraction (add Docs roles)
- **Git Integration:** Existing Steroids git helpers
- **File Storage:** Git (for committed assets); `.steroids/` for temp

### Performance Targets

- **New Blueprint Wizard:** Each step <2s (local validation)
- **Architecture Snapshot:** <10s (async, show progress)
- **Review Run:** <5min (parallel; depends on model response time)
- **Synthesis:** <1min (edit existing doc)
- **Commit:** <5s (git operation)
- **Task Export:** <30s (generate spec + create tasks)

### Security Considerations

- All LLM calls use configured API keys (no defaults exposed)
- Architecture snapshots don't expose secrets
- Review outputs sanitized before display (no credential leaks)
- Git commits signed if repo requires it
- Role-based approval (only approvers can approve)

---

## Debugging & Observability

### Logs to Generate

```
[docs] blueprint created: auth-flow-001
[docs] review run started: uuid-..., models: [codex, gemini, claude]
[docs] codex review stream: 5 issues extracted
[docs] gemini review stream: 3 issues extracted
[docs] claude review stream: 2 issues extracted
[docs] synthesis started: mapping issues to sections
[docs] doc updated: auth-flow-001, sections: [7, 8, 14]
[docs] verification gate: PASS (0 critical, 2 high, 1 medium)
[docs] commit started: auth-flow-001
[docs] commit succeeded: abc123..., path: docs/blueprints/auth-flow/blueprint.md
[docs] task export: 5 tasks created
```

### Metrics to Track

- Blueprints created per project
- Review run duration (by model)
- Token usage (by model, by project)
- Approval rate (% of docs that reach Approved status)
- Time to approval (avg, by doc type)
- Model failure rate (timeouts, errors)
- Cost per blueprint (aggregate + breakdown by model)

---

## Error Handling Matrix

| Scenario | Detection | Recovery | Final State |
|----------|-----------|----------|-------------|
| Single reviewer returns non-JSON | JSON.parse fails | Retry with stricter prompt (max 2 retries). If still fails, mark reviewer as `failed`, continue with others. | ReviewRun status: `partial` |
| Single reviewer times out | Activity timeout (15min default) | Kill process, mark as `failed`. Do NOT auto-retry (user can trigger). | ReviewRun status: `partial` |
| All reviewers fail | All streams in `failed` state | ReviewRun status: `failed`. Blueprint stays in `draft`. Show error per reviewer. | Blueprint: `draft` |
| Synthesis LLM fails midway | Orchestrator call throws | **Atomic rollback**: synthesis writes to a temp copy, only replaces original on full success. Original doc untouched on failure. | Blueprint: `in-review` (unchanged) |
| User edits during active review | Check for write lock | Block edits while review is running. Show "Review in progress" banner. | Review continues on original version |
| Cost ceiling exceeded mid-review | Running token counter per stream | Cancel remaining streams. Keep completed results. Mark as `partial`. | ReviewRun: `partial` |
| Rate limit hit (429) | Provider `classifyError()` returns `rate_limit` | Exponential backoff (1s, 2s, 4s). Max 3 retries. Then mark as `failed`. | Stream: `failed` if all retries exhausted |
| Credit exhaustion | Provider returns `credit_exhaustion` | Record incident (reuse existing `recordCreditIncident`). Block that provider. Continue with others. | Stream: `failed`, others continue |
| Git commit fails (dirty worktree) | `git status` pre-check | Show error with specific files blocking commit. User must resolve manually. | Blueprint: `approved` but not committed |
| Network failure during any LLM call | Connection error | Retry once after 5s. Then mark as `failed`. | Stream/operation: `failed` |

### Synthesis Atomicity (Critical)

Synthesis MUST be atomic to prevent data loss:

```
1. Read original doc → save as `original_snapshot`
2. For each section with issues → generate updated section → save to `temp_synthesis/`
3. If ALL sections succeed → replace original with synthesized version
4. If ANY section fails → discard temp, keep original, report which sections failed
5. Generate diff between original and synthesized for user review
```

The user can then re-run synthesis on failed sections only.

---

## Integration with Existing Steroids Codebase

### Provider Registry Extension

The existing provider registry supports roles: `orchestrator | coder | reviewer`. Blueprint Studio needs additional roles. **Approach: reuse existing roles with sub-role context.**

```typescript
// No change to InvokeOptions.role type. Instead, pass sub-role via prompt context.
// The existing `reviewer` role is used for all review subtypes.
// The existing `orchestrator` role is used for draft generation and synthesis.

// In config, the new `docs.orchestration` section maps to existing providers:
// docs.orchestration.orchestrator → uses ai.orchestrator provider
// docs.orchestration.writer → uses ai.coder provider (same generative capability)
// docs.orchestration.reviewers[*] → uses ai.reviewer provider with different prompts
```

This avoids breaking changes to the provider interface while allowing Blueprint Studio to use different models per role via the `docs.orchestration` config.

### Config Loader Extension

Add to `SteroidsConfig` interface in `src/config/loader.ts`:

```typescript
docs?: {
  enabled?: boolean;
  paths?: {
    doc_root?: string;
    blueprints_dir?: string;
    personas_dir?: string;
    decisions_dir?: string;
    architecture_dir?: string;
    assets_pattern?: string;
  };
  orchestration?: {
    orchestrator?: { provider?: string; model?: string };
    writer?: { provider?: string; model?: string };
    reviewers?: Array<{ name: string; provider: string; model: string }>;
  };
  verification_gate?: {
    required_sections?: string[];
    max_unresolved_critical?: number;
    max_unresolved_high?: number;
    max_unresolved_medium?: number;
    architecture_enforcement?: 'strict' | 'moderate' | 'permissive';
    open_questions_allowed?: boolean;
  };
  review_config?: {
    token_budget?: number;
    cost_ceiling?: number;
    stop_after_n_criticals?: number;
    run_in_parallel?: boolean;
  };
};
```

Also extend `CONFIG_SCHEMA` in `src/config/schema.ts` and the validator so `steroids config set docs.*` works.

### Dispute System Extension

The existing dispute system requires `task_id` (FK). Blueprint disputes need a different entity. **Two options:**

**Option A (Recommended): Add `blueprint_id` to disputes table**
```sql
-- Migration: add nullable blueprint_id column
ALTER TABLE disputes ADD COLUMN blueprint_id TEXT;
-- Constraint: exactly one of task_id or blueprint_id must be non-null
```

**Option B: Separate blueprint_disputes table**
- More isolated but duplicates dispute resolution logic

For MVP, use Option A.

### Invocation Logging

Blueprint Studio LLM calls must be logged like task invocations. Extend `task_invocations` table:

```sql
ALTER TABLE task_invocations ADD COLUMN blueprint_id TEXT;
-- When blueprint_id is set, task_id can be null
```

### Database Migration

A new migration file is required:

```sql
-- migrations/<next-sequential-number>_add_blueprint_support.sql
-- (Check migrations/manifest.json for the current highest number and use N+1)

-- UP
ALTER TABLE disputes ADD COLUMN blueprint_id TEXT;
ALTER TABLE task_invocations ADD COLUMN blueprint_id TEXT;

CREATE TABLE IF NOT EXISTS blueprint_metadata (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  doc_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  commit_hash TEXT,
  schema_version TEXT NOT NULL DEFAULT '1.0.0'
);

-- DOWN
-- SQLite doesn't support DROP COLUMN, so down migration recreates tables
```

**Note:** JSON manifests in `.steroids/blueprints/` are the primary data store for blueprint state. The SQLite table is for cross-referencing with tasks and disputes only. This avoids dual-storage contradictions.

### Parallel Execution Infrastructure

The existing steroids loop is single-threaded. Blueprint Studio needs parallel LLM calls. Implementation approach:

```typescript
// Use Promise.allSettled (not Promise.all) to handle partial failures
const results = await Promise.allSettled(
  selectedReviewers.map(reviewer => runReviewStream(blueprint, reviewer))
);

// Classify results
const succeeded = results.filter(r => r.status === 'fulfilled');
const failed = results.filter(r => r.status === 'rejected');

// If all failed → ReviewRun.status = 'failed'
// If some failed → ReviewRun.status = 'partial'
// If all succeeded → ReviewRun.status = 'success'
```

No new infrastructure needed -- just `Promise.allSettled` with per-stream error handling.

---

## Concurrency & Locking

### MVP: Single-Writer Lock

When a blueprint is being edited or reviewed, a write lock prevents concurrent modifications:

```
.steroids/blueprints/locks/<blueprint-id>.lock
{
  "owner": "user@hostname",
  "acquired_at": "2026-02-11T14:30Z",
  "expires_at": "2026-02-11T15:30Z",
  "operation": "review"  // or "edit"
}
```

- Lock acquired before edit or review
- Lock released on save, cancel, or expiry (1 hour default)
- Stale locks (expired) can be force-acquired
- Reviews block edits; edits block reviews

### Future: Optimistic Concurrency

- Track `version` (git SHA) at load time
- On save, compare with current SHA
- If changed, show three-way merge UI

---

## Blueprint Schema Versioning

All blueprint manifests include a `schema_version` field:

```json
{
  "schema_version": "1.0.0",
  "blueprints": { ... }
}
```

**Compatibility rules:**
- Patch version (1.0.x): additive fields only, backward compatible
- Minor version (1.x.0): new required fields with defaults, auto-migrated
- Major version (x.0.0): breaking changes, requires explicit migration

---

## Migration Path for Existing Projects

1. **Opt-in activation:** `steroids blueprints init` adds `docs.enabled: true` to `.steroids/config.yaml`
2. **Directory creation:** Creates `docs/blueprints/`, `docs/personas/`, `docs/decisions/`, `docs/architecture/`
3. **Existing docs import:** `steroids blueprints import <path>` converts existing markdown into managed blueprints
4. **No breaking changes:** Projects that don't use Blueprint Studio are completely unaffected
5. **Config schema:** New `docs.*` keys are ignored by older steroids versions (forward-compatible)

---

## MVP Scope Alignment Table

| Feature | MVP (v1) | v2 | Notes |
|---------|----------|-----|-------|
| Persona CRUD (CLI) | Yes | -- | `steroids blueprints personas add/list/edit` |
| Persona Library (WebUI) | No | Yes | Requires WebUI |
| New Blueprint Wizard (CLI, steps A-G) | Yes | -- | Interactive prompts |
| New Blueprint Wizard (WebUI, 8 steps) | No | Yes | Requires WebUI |
| Architecture Snapshot Generation | Yes | -- | LLM-based, CLI command |
| Multi-LLM Parallel Review | Yes | -- | `Promise.allSettled` |
| Synthesis (integrate findings) | Yes | -- | Atomic, section-by-section |
| Verification Gate | Yes | -- | CLI checklist enforcement |
| Git Commit of Blueprint | Yes | -- | `steroids blueprints commit` |
| Task Export | Yes | -- | Creates pending tasks + spec files |
| Document Workspace (WebUI tabs) | No | Yes | Requires WebUI |
| Visual Spec / Image Token Extraction | No | v2+ | Complex CV pipeline |
| Pixel-Diff Match Scoring | No | v3+ | Requires headless rendering |
| Requirements Register (interactive board) | No | Yes | WebUI feature |
| Decisions Tab (ADR editor) | No | Yes | WebUI feature |
| Import Existing Docs | No | Yes | `steroids blueprints import` |
| Persona-Aware Interview Questions | Partial | Yes | v1: generic template; v2: role-tailored |
| CLI Commands (full tree) | Yes | -- | Primary interface for MVP |
| Cost Tracking per Review | No | Yes | Needs token counting per provider |

---

## Known Limitations & Future Work

1. **Single Orchestrator per Run**
   - Today: One orchestrator (Claude) for draft + synthesis
   - Future: Allow different models for draft vs synthesis

2. **No Incremental Reviews**
   - Today: Re-review entire doc if changed
   - Future: Run reviews on changed sections only

3. **Architecture Snapshot Manual**
   - Today: Generated once; user must manually update if code changes
   - Future: Watch files, auto-regenerate, version history

4. **No Persona Simulation Review**
   - Today: Reviews from actual models (Codex, Gemini, Claude)
   - Future: Simulate personas (PM wants this; Architect objects; Security concerned)

5. **No Visual Component Library Export**
   - Today: Extracted tokens shown in doc
   - Future: Export as Figma plugin, Storybook, design tokens JSON

6. **No Collaborative Editing**
   - Today: Single-user edits; conflicts require re-run
   - Future: Multi-user editing with conflict resolution

---

## References & Links

- **Steroids CLI:** https://github.com/UnlikeOtherAI/steroids-cli
- **Codex CLI Docs:** https://developers.openai.com/codex/cli/
- **Codex SDK:** https://developers.openai.com/codex/sdk
- **Codex App Server:** https://developers.openai.com/codex/app-server
- **OpenAI API Models:** https://platform.openai.com/docs/models/
- **Gemini API:** https://ai.google.dev/
