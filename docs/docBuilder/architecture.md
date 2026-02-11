# System Architecture

> **Canonical paths and status values are defined in [brief.md](./brief.md).** This document MUST NOT introduce alternative paths or status names.

## Design Philosophy

Blueprint Studio extends Steroids' core philosophy to the pre-implementation phase:

- **Spec-driven** – Documentation is the contract, just like task specs
- **Deterministic gating** – Nothing progresses without approval
- **Multi-provider** – Supports Claude, Codex, Gemini orchestration
- **Orchestrator-led** – Coordinator role breaks deadlocks and synthesizes
- **Repo-native** – All outputs committed to git (not hidden in `.steroids/`)
- **Architecture-aware** – Prevents accidental new patterns

## Information Architecture

### Global Navigation Model

Blueprint Studio integrates into Steroids' existing navigation with one new global module and one project-level section:

**Global Level (WebUI Sidebar)**
- Projects (existing)
- Tasks (existing)
- Runners (existing)
- Disputes (existing)
- **Blueprints** (new) – entry point for all documentation work
- Settings (existing)

**Project Level (after selecting project)**
- Overview (existing)
- Tasks (existing)
- Specs (existing)
- **Docs** (new) – primary workspace
  - Documents (list)
  - Personas (library)
  - Requirements (register)
  - Review Runs (archive)
  - Settings (Blueprint-specific)

### Information Flow

```
Project Selection
    ↓
Blueprints → Docs List
    ↓
New Doc Wizard (8 steps)
    ↓
Draft Generated
    ↓
Parallel Multi-LLM Reviews
    ↓
Synthesis & Integration
    ↓
Verification Gate
    ↓
Commit to Repo
    ↓
Generate Implementation Tasks
```

## Core Data Model

### Persona
Represents a stakeholder with stable identity across projects.

**Fields:**
- `id` – Stable identifier (per-xxx format)
- `name` – Display name
- `role` – Job title (PM, Engineer, Designer, Security, QA, Ops)
- `team` – Domain/area (optional)
- `technical_level` – Scale 1-5 (Non-tech to Deep-tech)
- `priorities` – Multi-slider: (Speed vs Safety), (Consistency vs Innovation), (UX vs Core)
- `decision_power` – Contributor | Approver | Veto
- `constraints` – List of non-negotiables
- `communication_style` – Bullets-only | Concise | Narrative | Exhaustive
- `review_focus` – What they emphasize when reviewing docs

**Storage:** Git-committed YAML files in `docs/personas/` (e.g., `docs/personas/per-001-pm-growth.yaml`)

### Requirement
Structured object capturing a single requirement or constraint.

**Fields:**
- `id` – REQ-### (auto-incrementing per document)
- `title` – One-sentence statement
- `description` – Full details
- `type` – Functional | UX | Performance | Security | Legal | Ops | Constraint
- `source_personas` – Which personas raised this
- `priority` – P0 (Must) | P1 (Should) | P2 (Could)
- `acceptance_criteria` – Bullets; required for P0
- `status` – Proposed | Accepted | Rejected | Needs Decision | Blocked | Resolved

> **Requirement Status Vocabulary:**
> - `Proposed` – Newly extracted, not yet reviewed
> - `Accepted` – Confirmed as a valid requirement
> - `Rejected` – Not a valid requirement (removed from scope)
> - `Needs Decision` – Requires stakeholder input to resolve ambiguity
> - `Blocked` – Conflicts with another requirement (pending conflict resolution)
> - `Resolved` – Was blocked, now resolved via a Decision entry (linked to DEC-###)
- `conflicts_with` – List of conflicting REQ-### IDs
- `resolution_decision` – Link to Decision Log entry (if resolved)

**Storage:** Embedded in document YAML frontmatter + `.steroids/` for indexed lookups

### Decision
ADR-lite decision record for resolving conflicts.

**Fields:**
- `id` – DEC-### (decision ID prefix is always `DEC-`; the template type "ADR" is a document type, not an ID prefix)
- `title` – Decision title
- `context` – Why this decision was needed
- `options` – Array of [Option A, Option B, Option C...]
- `choice` – Which option was selected
- `consequences` – What this enables/constrains
- `rationale` – Why this choice
- `decided_by` – Persona or human name
- `linked_requirements` – REQ-### IDs affected

**Storage:** Git-committed Markdown (e.g., `docs/decisions/dec-001-polling-vs-realtime.md`)

### Document (Blueprint)
The unified specification artifact.

**Frontmatter (YAML):**
- `title` – Doc title
- `status` – Draft | In Review | Changes Requested | Approved | Archived
- `owner(s)` – Persona(s) who authored/own
- `personas_included` – List of involved personas
- `architecture_guardrails` – Explicit statement
- `last_review_run` – Timestamp of last multi-LLM review
- `reviewers_used` – ["claude-opus", "gpt-5-codex", "gemini-2.5"]
- `approval_gate_passed` – Boolean; only true after verification
- `git_commit_hash` – After commit
- `repo_path` – Where this lives in git

**Sections:** (See brief.md for the 15 mandatory sections)

**Storage:** Git-committed Markdown + assets folder (e.g., `docs/blueprints/feature-slug/blueprint.md`)

### ReviewRun
Record of a multi-LLM review execution.

**Fields:**
- `id` – UUID
- `document_id` – Which blueprint was reviewed
- `document_revision` – Git SHA at review time
- `timestamp` – When review ran
- `models_used` – Array of model names (claude-opus, gpt-5-codex, gemini-2.5-flash, etc.)
- `outputs` – Dict[model_name → raw review output]
- `extracted_issues` – Array of [severity, category, section, recommendation, evidence]
- `synthesis_result` – Final integrated doc output
- `status` – Success | Partial (some reviewers failed) | Failed

**Storage:** `.steroids/blueprints/review-runs/` (generated state, not committed)

## Multi-LLM Orchestration Model

### Role Mapping (Default)

| Role | Model | Responsibility |
|------|-------|-----------------|
| **Orchestrator/Synthesizer** | Claude Sonnet/Opus | Workflow orchestration, doc generation, synthesis of findings |
| **Writer** | Claude | Final document quality and coherence |
| **Code Feasibility Reviewer** | Codex (GPT-5-Codex) | Implementation realism, edge cases, dependencies |
| **Architecture Reviewer** | Gemini | Pattern compliance, performance, scalability |
| **UX/Clarity Reviewer** | Claude or general | Document clarity, completeness, user journeys |
| **Persona Simulator** | Any | Simulate specific persona's concerns (optional) |

### Review Phases

#### Phase 0 – Prepare Context
- Generate or update "Architecture Snapshot" from repo
- Ensure AGENTS.md, patterns documentation exist
- Compile constraint profile (patterns, deps, conventions)

#### Phase 1 – Draft
- Orchestrator creates initial doc from persona inputs + repo context
- Doc includes architecture guardrails section explicitly

#### Phase 2 – Parallel Reviews
- All reviewers run simultaneously on the same draft
- Each produces independent findings (no cross-contamination)
- Codex can be constrained to JSON schema output for determinism
- Gemini checks against architecture snapshot

#### Phase 3 – Synthesis
- Orchestrator integrates findings *throughout* the doc (not appended)
- Updates sections with fixes
- Creates "Review Status" summary (what was fixed, what remains)
- Preserves decision reasoning in doc

#### Phase 4 – Validation Gate
- Human review of synthesized output
- Diffs highlighted between pre/post synthesis
- Conflicts become "Needs User Input" (block approval)
- Architecture conflicts trigger "Blueprint Dispute" flow (mirrors Steroids disputes)

### Parallel Review Mechanics

- **Artifact:** Single document version; reviewers see same content
- **Storage:** Raw outputs in `.steroids/` (temporary); only final integrated version committed
- **Concurrency:** All reviewers run in parallel by default
- **Conflict Detection:** If reviewers disagree significantly on same section, surface as explicit conflict item

## Architecture Guardrails Implementation

### Snapshot Generation
Runs once per project (or on-demand):

```
Architecture Snapshot
├─ Stack & frameworks (detected from package.json, imports, etc.)
├─ Existing patterns (e.g., "Service layer", "Factory pattern", "Component composition")
├─ Conventions (folder structure, naming, file organization)
├─ "Do not introduce" list (forbidden deps, patterns, architectures)
├─ Relevant entrypoints (main files, bootstrap logic)
└─ Source references (which files were analyzed)
```

### Guardrails Enforcement

1. **Generation Phase** – Snapshot is passed to writer model; writer avoids new patterns
2. **Review Phase** – Architecture reviewer explicitly checks:
   - New dependencies proposed?
   - New patterns introduced?
   - Violates folder conventions?
3. **Verification Phase** – Document must include:
   - List of patterns reused
   - Any new patterns (with justification)
   - Explicit "no new patterns unless requested" confirmation

### Conflict Resolution for Guardrails Violations

If new pattern is proposed but guardrails forbid it:
- Flag as "Architecture Fit" Critical issue
- Require explicit decision (create ADR)
- User chooses: keep existing pattern OR allow new pattern (with rationale)
- If overridden, add to Decision Log

## Visual Specification Pipeline

### Phase 1: Extract (AI + Light CV)
For each attached screenshot:

1. **Visual parsing** – Identify layout regions and components
2. **Token extraction** – Colors (hex + alpha), typography (family/size/weight/line-height), shadows, radius, spacing
3. **Component table** – Per identified component:
   - Name ("Primary Button", "Card Header", etc.)
   - Bounding box (x, y, width, height)
   - Styles (fill, border, radius, shadow, font)
   - States (if detectable: hover, active, disabled, loading)

### Phase 2: Verify (Human-in-the-Loop)
UI tools make correction trivial:
- Click component row → highlight region on image
- Editable fields for radius, font size, colors
- Color picker eyedropper
- Measure tool (drag to measure pixel distances)

### Output Artifact
- Image file(s) committed to repo
- Optional `annotations.json` with measurements/corrections
- "Visual Spec" section embedded in markdown (portable, not image-dependent)
- Match confidence score (high/med/low)

### Optional "Bulletproof" Verification
- Generate HTML/CSS replica from extracted tokens (internal, not committed)
- Render headlessly
- Pixel diff vs original screenshot
- Produce match score (e.g., "92% match; button shadow too strong; font off by ~1px")

## Conflict Resolution for Multi-Stakeholder Requirements

### Conflict Detection
System identifies contradictions:
- "Must be offline" vs "Must sync live"
- "Ship in 2 weeks" vs "Must have full accessibility"
- "Zero new dependencies" vs "Need real-time features"

### Resolution Flow (in Requirements Register)
1. Conflict flagged with affected REQ-### IDs
2. Orchestrator proposes 2-3 resolution paths:
   - Option A (prioritize persona 1)
   - Option B (compromise/phased approach)
   - Option C (prioritize persona 2)
3. User selects → creates Decision entry
4. Requirements updated with status + linked decision
5. Doc regenerated to reflect choice

### Escalation (Unresolved After N Rounds)
- Becomes a "Blueprint Dispute" (mirrors Steroids' existing dispute concept)
- Requires coordinator-level intervention or stakeholder meeting
- Document status → "Changes Requested" until resolved

## Repo File Structure

> **See [brief.md](./brief.md) for the canonical path table.** This section expands with detail.

### Committed (Production)

```
my-project/
├── docs/
│   ├── blueprints/                      # approved blueprint documents
│   │   ├── feature-auth/
│   │   │   ├── blueprint.md             # main blueprint doc
│   │   │   └── assets/
│   │   │       ├── 2026-02-11-login-wireframe.png
│   │   │       ├── 2026-02-11-signup-flow.png
│   │   │       └── annotations.json
│   │   └── feature-billing/
│   │       └── blueprint.md
│   │
│   ├── personas/                        # reusable stakeholder definitions
│   │   ├── per-001-pm-growth.yaml
│   │   ├── per-002-staff-backend.yaml
│   │   └── per-003-security-lead.yaml
│   │
│   ├── decisions/                       # Decision logs (DEC-### prefix)
│   │   ├── dec-001-polling-vs-realtime.md
│   │   └── dec-002-new-deps-policy.md
│   │
│   └── architecture/
│       └── snapshot.md                  # current patterns + constraints
│
└── specs/                               # generated task specs (from approved blueprints)
    └── <feature-slug>/
        ├── sign-in.md
        ├── oauth-integration.md
        └── token-management.md
```

### Generated State (NOT Committed)

```
.steroids/
├── blueprints/
│   ├── manifests.json                   # index of all blueprints + metadata
│   ├── requirements/                    # indexed requirements (JSON, per blueprint)
│   │   └── <blueprint-id>.json
│   ├── review-runs/                     # review execution history
│   │   └── <review-run-id>.json
│   ├── templates/                       # default document templates
│   │   ├── feature-spec.md
│   │   ├── ui-spec.md
│   │   ├── adr.md
│   │   └── bugfix-plan.md
│   └── locks/                           # write locks for concurrency
│       └── <blueprint-id>.lock
```

### Why Split `docs/` vs `specs/`

- `docs/blueprints/*.md` = **Human-facing**, "what we're building" (documentation/discovery)
- `specs/*.md` = **Steroids task contract** (what coder/reviewer loop executes on)

This split allows:
- Docs to be portable to other tooling
- Steroids to generate deterministic task specs
- Clear separation of concerns

### Persona Storage

**Canonical location:** `docs/personas/*.yaml`

Personas live in `docs/` because they are documentation artifacts, not task specs. They are human-authored stakeholder definitions used during the documentation phase, before any task specs exist. The `specs/` directory is for generated task specs that feed the coder/reviewer loop.

## Deterministic Gating (Quality Assurance)

### Non-LLM Linting (Fast, Pre-token)
Before running any multi-LLM reviews:
- Ensure required sections present
- Ensure "Open Questions" not empty or explicitly acknowledged
- Ensure all referenced images exist in repo
- Validate persona references exist

### LLM-Based Validation
- "Does this doc contradict itself?"
- "Does it violate architecture guardrails?"
- "Is it implementable in this codebase?"
- "Are all P0 requirements adequately specified?"

### Verification Checklist (Must be Green)
- ✅ No CRITICAL issues open
- ✅ No unresolved conflicts
- ✅ No TBD in required sections
- ✅ Architecture guardrails section present
- ✅ UI spec present (if feature has visual component)
- ✅ Acceptance criteria present for all P0 requirements
- ✅ Test plan section complete
- ✅ Open Questions section empty or all deferred to future docs

### Approval Gate Logic
```
if (all_criticals_resolved &&
    no_missing_sections &&
    architecture_fit_confirmed &&
    visual_specs_verified &&
    open_questions_empty) {
  allow_approval();
} else {
  status = "Changes Requested";
  block_task_export();
}
```

## Blueprint State Machine (Formal)

| Current State | Event | Guard | Action | Next State |
|---------------|-------|-------|--------|------------|
| (none) | `create` | -- | Create manifest entry, write draft to `.steroids/` | `draft` |
| `draft` | `edit` | -- | Update content in working path | `draft` |
| `draft` | `start_review` | All required sections present, no TBD placeholders | Queue review runs, fan out to reviewers | `in-review` |
| `in-review` | `review_complete` | All reviewer streams finished (success or partial) | Store results in `.steroids/blueprints/review-runs/` | `in-review` |
| `in-review` | `synthesize` | At least one reviewer succeeded | Run synthesis orchestrator, update doc sections | `changes-requested` (always -- human must approve even clean synthesis) |
| `in-review` | `review_failed` | All reviewers failed | Log failure, keep existing doc | `draft` (with error notice) |
| `changes-requested` | `edit` | -- | User resolves issues | `changes-requested` |
| `changes-requested` | `start_review` | Same as draft→start_review | Re-run reviews | `in-review` |
| `changes-requested` | `approve` | All criticals resolved, no missing sections, arch fit confirmed, open questions empty | Lock document, record approval | `approved` |
| `approved` | `export_tasks` | -- | Generate specs + create steroids tasks (status=`pending`) | `approved` |
| `approved` | `commit` | -- | Git commit doc + assets | `approved` (with commit hash) |
| `approved` | `archive` | -- | Mark as superseded | `archived` |
| `approved` | `reopen` | Explicit user action | Unlock, reset approval | `draft` |
| any | `escalate` | N review cycles without resolution | Create Blueprint Dispute | `changes-requested` |
| any | `archive` | Explicit user action | Mark as not progressing | `archived` |

**Retry policy:** If a single reviewer fails during a parallel review, the run is marked `partial`. The user can re-trigger that specific reviewer without re-running all. Max 3 automatic retries per reviewer per run (with exponential backoff).

**Task export note:** Tasks are created with status `pending` (not `draft` -- there is no draft status in the steroids task system).

## Architecture Snapshot Generation Algorithm

The architecture snapshot is generated via **LLM analysis** of repository structure, not deterministic heuristics alone. Target execution time: <15 seconds.

### Algorithm

1. **Gather inputs** (deterministic, <2s):
   - List all files by extension (group by language: `.ts`, `.py`, `.rs`, `.go`, etc.)
   - Read `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `requirements.txt` (any that exist)
   - Read top-level config files (`.eslintrc`, `tsconfig.json`, `Makefile`, `docker-compose.yml`)
   - Read `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` (if they exist)
   - Sample 5-10 representative source files (largest, most-imported, entry points)
   - Get directory tree (depth 3)

2. **LLM analysis** (single call, <10s):
   - Send gathered context to the configured orchestrator model
   - System prompt requests structured output (see [prompt-specifications.md](./prompt-specifications.md))
   - Output schema:
     ```json
     {
       "stack": ["Node.js", "TypeScript", "React"],
       "build_tools": ["npm", "webpack"],
       "test_tools": ["jest", "playwright"],
       "patterns": [
         { "name": "Service Layer", "evidence": "src/services/*.ts", "confidence": "high" }
       ],
       "conventions": {
         "folder_structure": "src/{module}/{entity}.ts",
         "naming": "camelCase files, PascalCase classes",
         "imports": "ESM with .js extensions"
       },
       "forbidden_patterns": ["Patterns not detected but should be avoided"],
       "entrypoints": ["src/index.ts", "src/cli.ts"],
       "dependencies_of_note": ["better-sqlite3", "commander"]
     }
     ```

3. **Write snapshot** (deterministic, <1s):
   - Render structured output into `docs/architecture/snapshot.md`
   - Include source references (which files were analyzed)
   - Include generation timestamp

### Cache Invalidation
- Snapshot is valid until any source file changes (tracked via git status)
- User can force regeneration via `steroids blueprints snapshot --force`
- Stale snapshot (>7 days) shows warning in CLI

### Language-Agnostic Design
The algorithm works with ANY project by:
- Using file extension detection (not hardcoded tool names)
- Reading whatever package manager file exists (or none)
- Letting the LLM infer patterns from source samples

## Orchestrator Intervention Model

Reuses Steroids' existing orchestrator/coordinator patterns:

- **Threshold:** After N rejection cycles (e.g., 3), escalate
- **Intervention:** Coordinator (human + LLM) reviews blockers
- **Options:**
  1. Break the deadlock with a decision (create ADR)
  2. Escalate to stakeholder meeting
  3. Convert to "Blueprint Dispute" (requires explicit owner decision)
  4. Archive blueprint (mark as superseded/not progressing)

**Disputes** map directly to Steroids' existing dispute model – when a blueprint can't be approved due to fundamental disagreement, it becomes a dispute requiring higher-level resolution.
