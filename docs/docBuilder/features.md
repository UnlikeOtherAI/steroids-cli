# Features & Workflows

> **Canonical paths and status values are defined in [brief.md](./brief.md).** This document uses those paths.
> **LLM prompt contracts are defined in [prompt-specifications.md](./prompt-specifications.md).**

## New Document Wizard (8-Step Guided Workflow)

The core user-facing experience. Deterministic, opinionated, but gated to ensure quality.

### Step A – Basics
Establish document scope and ownership.

**Inputs:**
- Document title
- Document type (template selector): Feature Spec / UX Spec / Architecture Proposal / ADR / Bugfix Plan / Refactor Plan
- Output path picker (repo-relative; default: `docs/blueprints/<slug>/blueprint.md`)
- Owners (who will author/edit)
- Required approvers (select personas)

**Behavior:**
- Document type selection loads a template framework
- Output path auto-generates slug from title (editable)
- Approvers determine who signs off

### Step B – Context Sources
Ground the specification in existing code and documentation.

**Inputs:**
- Relevant directories (checkbox tree of repo structure)
- Existing specs to reference (e.g., `specs/auth.md`)
- Existing architecture docs (AGENTS.md, CLAUDE.md, etc.)
- Related issues/PR links (optional; for context)

**Behavior:**
- "Generate Architecture Snapshot" button
  - Scans repo for patterns, stack, conventions
  - Outputs `docs/architecture/snapshot.md` (committed)
  - Lists "allowed patterns", "forbidden patterns", "do not introduce unless requested"
  - Identifies entrypoints and dependencies

**Output:**
- Architecture Snapshot in repo
- Constraint profile passed to LLMs

### Step C – Personas & Stakeholders
Define who we're building for and who's deciding.

**Inputs (for each persona):**
- Use existing persona (dropdown from Persona Library)
- **OR** create new persona inline:
  - Name (e.g., "Backend Lead")
  - Job/Role
  - Technical level (slider: Non-technical → Highly technical)
  - Priorities (3 sliders):
    - Speed vs Safety
    - Consistency vs Innovation
    - UX Polish vs Core Function
  - Decision power (Contributor / Approver / Veto)
  - "What success looks like" (free text)
  - "Non-negotiables" (list of hard constraints)

**Behavior:**
- New personas automatically saved to git: `docs/personas/<id>-<name>.yaml`
- Multiple personas can be assigned to one doc
- Personas weight the requirements gathering and review process

### Step D – Inputs (Notes + Screenshots)
Capture raw material for the specification.

**Supported inputs:**
- Rich markdown notes (editor)
- Paste from clipboard (auto-detects images)
- Drag/drop multiple images
- Upload files

**Image handling (each becomes an Attachment Card):**
- Thumbnail preview
- Filename (editable)
- Tags (e.g., "wireframe", "reference", "final design", "existing UI")
- Caption/intent field
- "Link to section" (insert into specific doc section)
- Category: reference | must-match | inspiration

**Storage:**
- Images written to repo: `docs/blueprints/<slug>/assets/<timestamp>-<name>.png`
- Doc references via relative markdown links
- Metadata stored in `.steroids/` for indexing

### Step E – Persona-Aware Requirement Interviews
Multi-stakeholder input gathering that's conversational but structured.

**UX Layout:**
- Left: Persona selector (tab-like)
- Center: Q/A thread (like chat, but structured)
- Right: Live "Extracted Requirements" panel

**For each persona, user chooses mode:**

**Option 1 – Interview Mode:**
- Orchestrator asks LLM-powered questions tailored to:
  - Their technical level
  - Their role (PM → high-level goals; Engineer → constraints; Designer → user flows)
- User answers conversationally
- Requirements extracted and structured automatically

**Option 2 – Paste Notes:**
- Copy/paste meeting notes, emails, Slack threads
- Orchestrator parses into requirements

**Option 3 – Import from Document:**
- Drop in a PRD, ticket description, or existing proposal
- Orchestrator extracts and structures

**Output (live in right panel):**
- Requirements Register preview (REQ-###, source persona, priority, type)
- Open Questions (things that need clarification)
- Detected conflicts (contradictions between personas)

### Step F – Consolidation & Conflict Resolution
Merge duplicates, set priorities, resolve contradictions.

**Inputs:**
- Requirements Register interactive view
- "Merge duplicates" UI (checkbox pairs → merge button)
- Priority selector (P0/P1/P2) for each requirement
- Conflict view (side-by-side comparison)

**Conflict resolution:**
- For each conflict, propose 2-3 options
- User chooses → creates Decision Log entry (ADR-style)
- Requirement status updated to "Resolved by DEC-###"

**Output:**
- Consolidated, deduplicated, prioritized requirements
- Decision Log entries for all conflicts
- Clean input to draft generation

### Step G – Draft Generation
Orchestrator synthesizes all inputs into a unified proposal.

**Orchestrator inputs:**
- All persona inputs and requirements
- Architecture Snapshot and constraints
- Images and annotations
- Decisions from conflict resolution

**Orchestrator outputs:**
- Complete Markdown document with:
  - Executive Summary
  - Goals / Non-goals
  - Personas & Stakeholders section
  - Requirements Matrix (organized by priority)
  - User Journeys (step-by-step flows)
  - UX/UI Spec (sections for each screen/flow)
  - Architecture Fit section (patterns reused, new patterns with justification)
  - Data Model / API Contracts
  - Edge Cases & Failure Modes
  - Security / Privacy Considerations
  - Observability (logs/metrics)
  - Test Plan
  - Rollout Plan
  - Open Questions
  - Review Status (prepared for reviews)

**Preview:**
- Doc rendered in right panel (live markdown preview)
- Sections highlighted where "human input needed"
- "Run QA" CTA (proceed to reviews)

### Step H – Multi-LLM Review & Synthesis
Parallel expert reviews followed by integration.

**Review configuration:**
- Select orchestrator model (default: Claude)
- Choose reviewers:
  - Code feasibility (Codex)
  - Architecture/perf consistency (Gemini)
  - Doc clarity & completeness (Claude or general)
  - Optional: persona simulations
- Budget controls:
  - Token/cost ceiling
  - "Stop after N unresolved criticals"

**Execution:**
- All reviewers run in parallel
- Progress indicators shown (live status cards)
- Each reviewer produces:
  - Raw output (stored in `.steroids/`)
  - Extracted issues (severity, category, section, recommendation)

**Synthesis:**
- User clicks "Synthesize"
- Orchestrator integrates findings throughout doc (not append)
- Creates "Review Status" summary (Critical/High/Medium/Low addressed)
- Highlights diffs

**Sign-off:**
- Approver checkbox + optional comment
- "Commit to git" button
- Optional: create PR

---

## Document Workspace (Editor + Reviews + Approval)

Day-to-day editing and review interface.

### Layout
- **Left:** Outline/sections list + coverage indicators
- **Center:** Rendered preview (markdown, tables, images)
- **Right:** Orchestrator panel (chat + actions + checklist)

### Tabs

#### Document Tab
- Markdown editor with guardrails:
  - "Required sections" checklist (visual indicator)
  - "No TODOs allowed on approval" warning
  - Section collapsing/expanding
- Inline comments (human + AI)
- "Generate tasks from doc" button (disabled until Approved)
- Edit history (git commit metadata)

#### Visual Spec Tab
- Gallery of attached images
- For each image:
  - Extracted tokens table (colors, typography, shadows, radius, spacing)
  - Component breakdown table (Button: 12px radius, #..., shadow..., font...)
  - "Match confidence" badge (High/Med/Low)
  - "Needs user correction" prompts
  - Editable fields for manual correction
  - Color picker eyedropper
  - Measure tool

#### Reviews Tab
- Each review run listed with:
  - Timestamp
  - Models used
  - Severity counts (Critical/High/Medium/Low)
- Diff view (pre/post synthesis)
- "Re-run reviews" button (select subset; parallel by default)
- Issue checklist (filterable by severity/category/section)

#### Requirements Tab
- Requirements Matrix view:
  - Columns: ID, Title, Type, Source Persona(s), Priority, Status, Acceptance Criteria
  - Filters: Persona, Type, Priority, Status, Conflicts
- "Show conflicts only" toggle
- Merge/split requirements UI
- Mark as "Non-goal" or "Needs decision"
- Link requirements to doc sections

#### Decisions Tab
- Structured decision log (ADR-lite):
  - Decision title
  - Context (why this decision was needed)
  - Options considered (A/B/C)
  - Choice (which was selected)
  - Rationale (why)
  - Consequences (what this enables/constrains)
  - Linked requirements (REQ-### affected)
  - Linked architecture constraints
- "Create new decision" button
- Edit and archive decisions

#### History Tab
- Git commit history (commits affecting this doc)
- Review run history (timeline of reviews)
- Approval history (who approved when)
- Version comparison (diff any two commits)

---

## Personas Library

Reusable stakeholder definitions, project-scoped but portable.

### Persona List View
- Cards or table: name, role, technical level, last used, tags
- Filters: role, technical level, domain (security, design, PM, etc.)
- Actions: Create, Duplicate, Archive, Export

### Persona Detail Page
- Edit all fields (name, role, technical level, priorities, constraints, communication style)
- "Question style preview" (how this persona will be interviewed)
- Associated documents (which blueprints use this persona)
- "Default review preferences" (e.g., architects always want Gemini review)
- "Export persona pack" (for sharing across repos)

### Persona Impact
- Interview questions tailored to technical level
- Review prompts reflect their role and priorities
- Approval workflows respect decision power (Approver vs Veto)

---

## Requirements Register

Structured view of all requirements for a document.

### Display Modes
- **Table view:** All columns visible; sortable/filterable
- **Board view:** Kanban-style (Proposed → Accepted → Needs Decision → Resolved)

### Columns
- ID (REQ-###)
- Title (one-liner)
- Type (Functional/UX/Perf/Security/Legal/Ops)
- Source Persona(s)
- Priority (P0/P1/P2)
- Status
- Conflicts with (REQ-### references)

### Filters
- Persona
- Type
- Priority
- Status
- Conflict state (has conflicts / no conflicts)
- Coverage (reviewed by LLM / not reviewed)

### Actions per Requirement
- Edit (inline or modal)
- Merge with another (deduplication)
- Split into multiple
- Mark as "Out of scope" or "Non-goal"
- Promote/demote priority
- Resolve conflict (if involved in one)
- View "Needs User Input" feedback task (if blocking approval)

---

## Review Runs Archive

Historical record of all multi-LLM review executions.

### Review Run List
- Each run shows:
  - Document name and revision (git SHA)
  - Timestamp
  - Models used
  - Issue counts (Critical/High/Medium/Low)
  - Status (Success/Partial/Failed)
  - Actions: View, Compare with previous, Re-run

### Review Run Detail
- Raw outputs from each reviewer (read-only, archived)
- Extracted issues (structured list)
- Synthesis result (doc generated from this review)
- Diff against previous review run (if available)

---

## Settings (Blueprint-specific)

Per-project configuration.

### Paths & Organization
- Doc root folder (default: `docs/`)
- Blueprints subfolder (default: `blueprints/`)
- Asset folder pattern (default: `docs/blueprints/<doc-slug>/assets/`)
- Persona storage location (default: `docs/personas/`)
- Decision storage location (default: `docs/decisions/`)

### Approval Gate Rules
- Required sections (checklist; defaults provided)
- Maximum unresolved issues to allow Approval (by severity)
- Architecture guardrail enforcement level (strict / moderate / permissive)
- Open Questions must be empty (enforced / warning only)

### Default Models
- Orchestrator model (Claude Opus / Sonnet)
- Default reviewers (Codex, Gemini, etc.)
- Fallback models (if preferred not available)

### Review Thresholds
- Token budget per review
- Cost ceiling per run
- Max review iterations before escalation

---

## Multi-LLM Review Process (Detailed)

### Phase 0 – Prepare Context
1. Scan repo for patterns, stack, conventions
2. Generate Architecture Snapshot
3. Validate persona definitions exist
4. Check that doc doesn't have obvious lint errors

### Phase 1 – Draft
1. Orchestrator receives all structured inputs
2. Generates unified doc (includes architecture guardrails section)

### Phase 2 – Parallel Reviews (Parallel Execution)

**Codex Review Stream:**
- Input: Document + Architecture Snapshot
- Prompt: "Review for implementation feasibility, edge cases, dependencies, error handling"
- Output: Structured findings (JSON or schema-validated)
- Example issues:
  - "This API design would require a new library (graphql-ws). Approved dependencies: X, Y, Z. Recommend using existing WebSocket wrapper instead."
  - "Edge case: error handling for concurrent updates not covered. Suggest section on race conditions."

**Gemini Review Stream:**
- Input: Document + Architecture Snapshot + Codebase patterns
- Prompt: "Review for architecture fit, performance implications, scalability concerns"
- Output: Structured findings
- Example issues:
  - "Proposes new pattern 'Command Queue' not in current architecture. Recommend using existing Service layer pattern."
  - "Caching strategy not discussed. This component will see high throughput; recommend adding caching section."

**Claude Review Stream (clarity):**
- Input: Document + Requirements
- Prompt: "Review for clarity, completeness, acceptance criteria specificity, test plan coverage"
- Output: Structured findings
- Example issues:
  - "Acceptance criteria for REQ-012 too vague. 'Fast' is not measurable. Suggest defining: <100ms p95 latency."
  - "Missing section: Data migration plan for existing users."

**Optional Persona Simulation (if configured):**
- Input: Document + Persona definition
- Prompt: "Review as [Persona]. What concerns does [role] have? What would make [persona] object?"
- Output: Persona-specific concerns and objections

### Phase 3 – Synthesis
1. Orchestrator receives all raw review outputs
2. Parses and deduplicates findings
3. Maps issues to sections (which doc heading is affected)
4. Groups by severity (Critical/High/Medium/Low)
5. For each issue, generates a proposed fix
6. Integrates fixes into doc (updates sections, not appends findings)
7. Creates "Review Status" section:
   - Critical issues resolved: Y/N + count
   - High issues resolved: Y/N + count
   - Confidence score + why
8. Preserves decision reasoning in doc

### Phase 4 – Validation Gate (Human)
1. User reviews synthesized output
2. Diff shown (before/post synthesis)
3. Issue checklist (filterable by severity)
4. User can:
   - Approve (if all Criticals resolved)
   - Request changes (add comment, resolve issues, re-run reviews)
   - Escalate as dispute (if deadlocked)

---

## Export to Tasks (Bridge to Implementation)

After doc is Approved, convert to implementation tasks.

### UX
1. Open Approved doc
2. Click "Generate Implementation Plan"
3. Proposed Steroids section + task breakdown shown
4. User can:
   - Edit task titles/descriptions before creation
   - Split/merge tasks
   - Add dependencies between tasks

### Output
- Creates Steroids section (e.g., "Feature: Authentication Flow")
- Creates tasks in "pending" state (the steroids task system has no "draft" status)
- Each task references source blueprint: `--source docs/blueprints/feature-slug/blueprint.md`
- Optional: generates smaller `specs/<feature>/...md` files (per task) if preferred

### Safeguards
- Cannot export until doc is Approved
- Cannot export if verification gate failed
- Can re-run reviews if doc changes post-export

---

## Conflict Resolution Workflow

When requirements or architecture decisions conflict:

1. **Detection:** System identifies contradiction (explicit OR via LLM)
2. **Escalation:** Conflict card appears in Requirements view
3. **Proposal:** Orchestrator suggests 2-3 resolution paths:
   - Prioritize one persona's needs
   - Compromise/phased approach
   - Deferred decision (track as open question)
4. **Resolution:** User selects → Decision entry created automatically
5. **Update:** Requirements + doc updated with decision link
6. **Verification:** If conflict recurs after N cycles → Blueprint Dispute

---

## Codex Integration Strategies

Blueprint Studio supports three levels of Codex integration:

### Option A – Codex CLI for Reviewer Runs (Fastest MVP)
- Use `codex exec` for "read-only sandbox" reviews
- Capture output with `--output-last-message`
- Attach images via `--image` flag
- Enforce schema output with `--output-schema` for determinism
- Ideal for: parallel expert reviews, fast iteration

### Option B – Codex SDK as Orchestrator (Better Long-term)
- Install: `npm install @openai/codex-sdk`
- Use for project-threaded, multi-turn orchestration
- Leverage thread lifecycle methods (`thread/start`, `thread/resume`, `thread/list`)
- Ideal for: stateful orchestration, context preservation

### Option C – Codex App Server for Rich Interactive UI (Most Powerful)
- JSON-RPC protocol over stdio (streaming JSONL)
- Thread lifecycle methods for multi-agent coordination
- Bidirectional approvals (UI can accept/decline)
- Rich image inputs (`localImage`, `image url` per turn)
- Ideal for: desktop app-style multi-agent UI (future; out of scope for MVP)

**Recommended for MVP:** Option A (reviewers) + Optional Option B later (orchestrator)

---

## Visual Input Handling (Images)

### Drag/Drop + Paste UX
- Drag zone anywhere in editor
- Paste handler (Ctrl/Cmd+V) detects image clipboard
- Auto-saves to `docs/blueprints/<slug>/assets/<timestamp>-<name>.png`
- Inserts markdown link at cursor

### Image Gallery Sidebar
- Rename, caption, tag each image
- "Include in reviewer context" toggle
- "Insert into doc" button
- Delete / archive

### Token Extraction & Verification
- **Extract:** AI parses colors (hex + alpha), typography (family/size/weight), shadows, radius, spacing
- **Verify:** User reviews extracted tokens, corrects using inline editing
- **Output:** Embedded "Visual Spec" section in markdown (portable; not image-dependent)
- **Optional:** Pixel-diff match scoring (compare generated replica to original)

---

## Import Existing Documentation

Allow users to turn existing markdown docs into managed blueprints.

### UX
1. Blueprints list → "Import existing doc"
2. Select markdown file from repo
3. System parses into:
   - Sections (maps to required headings)
   - Requirements (if structured)
   - Open questions (if marked with ??? or TODO)
4. Run Multi-LLM Review on existing doc
5. Synthesize improvements
6. Verify & Commit (creates new commit updating doc)

### Outcome
- Existing doc gains credibility via multi-LLM review
- Open questions extracted and resolved
- Can now generate tasks from it
