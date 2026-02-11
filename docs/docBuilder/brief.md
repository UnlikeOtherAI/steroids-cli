# Blueprint Studio - Executive Overview

## What Are We Building?

**Blueprint Studio** is a guided documentation workflow feature integrated into the Steroids CLI that produces **implementation-ready documentation** through a deterministic, multi-stakeholder, multi-LLM verification process.

> **Naming Convention:** The feature is called **Blueprint Studio**. The CLI command prefix is `steroids blueprints`. Individual documents are called **blueprints**. The nav item is **Blueprints**. The Iron CLI referenced in CLAUDE.md is a separate, future scaffolding tool -- not this feature.

### Core Promise

Transform ad-hoc documentation into verified, architecture-aware specifications that:

- **Are repo-native** (Markdown + images committed to git; not in `.steroids/`)
- **Are architecture-aware** (read repo structure + current patterns; enforce "no new patterns unless requested")
- **Reconcile multiple stakeholders** (personas + requirements attribution + conflict resolution)
- **Are multi-LLM verified** (parallel expert reviews + synthesis + final validation)
- **Support visual specification** (paste/drag screenshots; extract design tokens; replicate precisely)

## How It Works

The feature follows a deterministic pipeline that mirrors Steroids' existing philosophy:

1. **Collect Context** – gather requirements from personas, inputs, and repo constraints
2. **Draft** – AI orchestrator creates unified proposal document
3. **Review** – parallel multi-LLM expert review (code feasibility, architecture fit, clarity)
4. **Synthesize** – orchestrator integrates findings into document (doesn't append)
5. **Verify** – human approval gate ensures quality standards
6. **Commit** – document and assets committed to repo
7. **Generate Tasks** – convert approved specs into implementation tasks

## Key Concepts

### Personas
First-class objects representing stakeholders with:
- Job role and technical level
- Priorities (speed, stability, security, cost, UX)
- Decision power (Contributor, Approver, Veto)
- Communication preferences

### Requirements
Structured objects (not free-text) with:
- Unique ID (REQ-###)
- Source persona(s)
- Priority (P0/P1/P2)
- Type (Functional, UX, Perf, Security, Legal, Ops)
- Acceptance criteria
- Conflict tracking and resolution status

### Architecture Guardrails
Explicitly enforced constraints:
- "Current patterns we must follow"
- "Patterns explicitly forbidden unless requested"
- Prevents accidental introduction of new patterns

### Multi-LLM Verification
Parallel expert reviews from:
- **Claude** – Document synthesis and orchestration
- **Codex** – Code feasibility and edge cases
- **Gemini** – Architecture and performance consistency
- Optional persona-simulated reviews

> **Primary Interface Decision:** The MVP is **CLI-first** (aligns with Steroids' philosophy and avoids the WebUI "on hold" blocker). The web dashboard is Phase 2. All features must be achievable via CLI commands; the web UI wraps them.

## Where It Lives

### Web Dashboard (Primary)
- Main menu navigation with project selection
- Docs list with status filtering
- New Doc Wizard (8-step guided workflow)
- Document Workspace with tabs (Overview, Personas, Requirements, Proposal, Reviews, Decisions, History)
- Persona Library management
- Requirements Register view
- Review Runs archive

### CLI (Primary for MVP)
- Power users and automation
- Mirrors web workflow in command structure
- Supports headless/CI integration
- All operations available via `steroids blueprints` commands

### Web Dashboard (Phase 2)
- Rich editing experience for personas, requirements, visual specs
- Requires WebUI to come off "On Hold" status first

## Document Lifecycle States (Canonical)

> **Status values are kebab-case in code/API, Title Case in UI.**

| Status | Code Value | Description |
|--------|-----------|-------------|
| Draft | `draft` | Initial creation and editing |
| In Review | `in-review` | Multi-LLM QA running |
| Changes Requested | `changes-requested` | Unresolved findings or missing sections |
| Approved | `approved` | Locked; ready to generate tasks |
| Archived | `archived` | Superseded or no longer relevant |

**Note:** "Needs Answers" mentioned in UI mocks is NOT a separate status. It is `changes-requested` with the sub-reason "unresolved open questions."

## Quality Gates

A document can only be **Approved** if:
- All **Critical** findings are resolved
- No missing required sections
- "Architecture Fit" section confirms pattern compliance
- Visual specs (if present) have high confidence or explicit human override
- Open Questions section is empty

## Output Artifact

The final document is a **bulletproof specification** with these mandatory sections:
1. Executive Summary
2. Goals / Non-goals
3. Personas & Stakeholders
4. Requirements Matrix (Must/Should/Could)
5. User Journeys
6. UX/UI Specification (with Visual Spec subsections)
7. Architecture Fit
8. Data Model / API Contracts
9. Edge Cases & Failure Modes
10. Security / Privacy Considerations
11. Observability (logs/metrics)
12. Test Plan
13. Rollout Plan
14. Open Questions (must be empty)
15. Review Status

## Integration with Steroids

- Follows Steroids' philosophy: **markdown specs as contract, strict gating, orchestrator intervention**
- Specs committed to repo (like existing Steroids workflow)
- Generated state in `.steroids/` (like existing workflow)
- Generated tasks feed directly into Steroids' coder/reviewer loop
- Personas map to existing stakeholder concepts
- Review runs map to existing coordinator/dispute resolution patterns
- Supports multi-provider AI (Claude, Codex, Gemini)

## Canonical Repo File Structure

> **IMPORTANT:** These are the canonical paths. All other documents in this suite MUST use these exact paths. Any deviation is a bug.

```
docs/
  blueprints/                          # Approved blueprint documents
    <slug>/
      blueprint.md                     # Main document (committed after approval)
      assets/
        <timestamp>-<name>.png         # Screenshots, wireframes, etc.
        annotations.json               # Optional visual corrections
  personas/                            # Reusable stakeholder definitions
    per-001-pm.yaml
    per-002-engineer.yaml
  decisions/                           # ADR-style decision logs
    dec-001-polling-vs-realtime.md     # Prefix: dec-### (not adr-###)
  architecture/
    snapshot.md                        # Generated patterns + constraints

specs/                                 # Steroids task specs (generated from blueprints)
  <feature-slug>/
    feature.md
```

**Generated state (NOT committed):**
```
.steroids/
  blueprints/
    manifests.json                     # Index of all blueprints + metadata
    requirements/                      # Indexed requirements (JSON)
    review-runs/                       # Review execution history (JSON)
      <review-run-id>.json
    templates/                         # Default document templates
    locks/                             # Write locks for concurrent edit safety
```

## Related Documents

- [architecture.md](./architecture.md) – System architecture, data model, state machine
- [features.md](./features.md) – Features & workflows (wizard steps, workspace)
- [ui-workflows.md](./ui-workflows.md) – UI wireframes and user journeys (Phase 2 WebUI)
- [implementation.md](./implementation.md) – Implementation guide, API, config, migration
- [prompt-specifications.md](./prompt-specifications.md) – All LLM prompt contracts and schemas

## Recommended MVP Scope

For a shippable v1 that delivers core value:

1. ✅ Persona CRUD + git-committed storage
2. ✅ New Doc Wizard (Basics → Personas → Inputs → Draft Settings → Generate Draft)
3. ✅ Blueprint document generator (Claude)
4. ✅ Parallel reviews (Codex + Gemini) with issue extraction
5. ✅ Synthesis (integrated doc output)
6. ✅ Verification gate + commit
7. ✅ Task generation from verified blueprint
8. 🔄 (defer) Importing existing docs
9. 🔄 (defer) Pixel-diff visual match scoring
10. 🔄 (defer) Full component token extractor UI
