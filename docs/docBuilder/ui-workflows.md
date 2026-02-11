# UI/UX & User Workflows

> **Note:** The WebUI is Phase 2. The MVP is CLI-first. These wireframes document the target web experience for when the WebUI comes off "On Hold" status. All workflows described here MUST also be achievable via `steroids blueprints` CLI commands.
> **Canonical paths and status values are defined in [brief.md](./brief.md).**

## Navigation & Page Structure (Web Dashboard)

### Global Level

**Sidebar Navigation**
```
- Projects
- Tasks
- Runners
- Disputes
- Blueprints ← Entry point for Blueprint Studio
- Settings
```

Clicking "Blueprints" takes you to the global Blueprints Home.

### Project Level (after selecting a project)

**Left Sidebar**
```
Project: [Project Name]
├── Overview
├── Tasks
├── Specs
├── Docs ← Blueprint Studio workspace
│   ├── Documents
│   ├── Personas
│   ├── Requirements
│   ├── Review Runs
│   └── Settings
└── Runners
```

---

## Page Map & Layout

### 1) Blueprints Home (Global Entry)

**Purpose:** Discover and start documentation work.

**Header:**
- Page title: "Blueprints"
- Global actions: "New Blueprint", "Browse templates"

**Main Content:**
- **Project Picker Cards** (if multiple projects):
  - Project name + repo path
  - "Recent blueprints" (3 most recent)
  - Status summary (Draft, In Review, Changes Requested, Approved)
  - CTA: "Open Project"

- **OR** Project Blueprints list (if single project or project already selected):
  - See "Project → Docs → Documents" page below

---

### 2) Project → Docs → Documents (List & Status)

**Purpose:** Overview of all documentation in a project; start new doc.

**Header:**
```
Project Name / Docs
[New Document ▼] [Import Existing Doc] [Manage Personas]
```

**Filter/Sort Bar:**
```
Status: [All ▼] | Type: [All ▼] | Tags: [Add filter]
Sort by: [Last Updated ▼]
```

**Document Table/Cards:**

| Status | Title | Type | Last Updated | Open Issues | Approvers | Actions |
|--------|-------|------|--------------|------------|-----------|---------|
| ✅ Approved | Auth Flow | Feature Spec | 2d ago | — | Sarah (✓) | Open, Archive |
| 🔄 In Review | Payment UI | UI Spec | now | 3 High, 1 Crit | Alex (pending) | Open, Run QA |
| ⚠️ Changes Requested | Billing | Feature Spec | 1h ago | 1 Critical | — | Open, Continue |
| 📝 Draft | Notifications | Feature Spec | 3d ago | — | (you) | Open, Run QA |

**Reliability Signals (right side of each row):**
- ✅ "Reviewed by Claude + Codex + Gemini"
- ⚠️ "Open questions remain (3)"
- 🧱 "Architecture-fit check failed"
- 🔒 "Locked (Approved)"

**Actions (per document):**
- **Open** – Opens Document Workspace
- **Run QA** – Trigger multi-LLM review
- **Export Tasks** – Generate implementation tasks (only if Approved)
- **Archive** – Mark as superseded/not progressing
- **Duplicate** – Clone for similar work

**Primary CTAs:**
- **New Document** → Opens Step A of wizard
- **Import Existing Doc** → File picker + import flow
- **Manage Personas** → Opens Personas Library

---

### 3) New Document Wizard (8-Step Flow)

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ Blueprint Studio → New Document                              │
├──────────────┬──────────────────────────────────────────┤
│   STEPPER    │          MAIN CANVAS                     │
│              │   ┌────────────────────────────────────┐ │
│ A. Basics    │   │  Form Inputs                       │ │
│ B. Context   │   │  [with validation errors]          │ │
│ C. Personas  │   └────────────────────────────────────┘ │
│ D. Inputs    │   ┌────────────────────────────────────┐ │
│ E. Interviews│   │  LIVE PREVIEW                      │ │
│ F. Conflicts │   │  [Rendered markdown doc]           │ │
│ G. Draft     │   │  [Updates as you fill form]        │ │
│ H. Review    │   └────────────────────────────────────┘ │
└──────────────┴──────────────────────────────────────────┘
[← Back] [Next →]
```

**Right side (when space available):**
- Live preview of doc being formed
- Always updated as user fills inputs
- Helps user visualize the end result

#### Step A – Basics

**Form:**
```
Document Title: [___________________________________]
Document Type:  [Feature Spec ▼]
Output Path:    [docs/blueprints/auth-flow/blueprint.md ▼]
Owners:         [+ Add owner persona]
Approvers:      [+ Select approvers]
```

**Sidebar:**
- "Choose a type" – shows available templates with descriptions

#### Step B – Context Sources

**Form:**
```
□ Scan repo for patterns
□ Include existing specs:
  □ specs/auth.md
  □ specs/database.md
□ Include architecture docs:
  □ AGENTS.md
  □ docs/architecture/snapshot.md

[Generate Architecture Snapshot] (running… 45s)

Architecture Snapshot Result:
├─ Stack: Node.js + TypeScript + React
├─ Patterns: Service layer, Repository pattern, Component composition
├─ Forbidden unless requested: GraphQL, New databases, Microservices
└─ Do not introduce: New authentication systems
```

#### Step C – Personas & Stakeholders

**Form:**
```
Selected Personas:

[PM – Growth] (Technical: 2/5)
  Priorities: Speed > Safety, Innovation > Consistency
  Decision power: Approver
  [Edit] [Remove]

[+ Add persona]
```

**"+ Add Persona" Modal:**
```
Persona Name:        [___________________]
Role:                [Product Manager ▼]
Technical Level:     [2 ─●─────────── 5]
Priorities (sliders):
  Speed ●─────── Safety
  Innovation ●─────── Consistency
  UX Polish ─●─────── Core Function

Decision Power: [Approver ▼]
What success looks like: [________________]
Non-negotiables: [+ Add constraint]

[Save to Library] [Save & Continue]
```

#### Step D – Inputs (Notes + Screenshots)

**Form:**
```
Rich Text Editor:
[Lorem ipsum dolor sit amet...]

Image Upload:
┌──────────────────────────────────────┐
│ Drag images here or click to upload  │
│            (Paste Ctrl+V)            │
└──────────────────────────────────────┘

Attachments:
[Image] login-wireframe.png
  Tags: wireframe, reference
  Caption: [Initial login screen mockup]
  [Link to section: none] [Delete]

[+ Add more images]
```

#### Step E – Persona-Aware Interviews

**Layout:**
```
┌─────────────────┬──────────────────────────┬──────────────────┐
│ Personas:       │ Conversation Thread      │ Extracted Reqs   │
│                 │                          │                  │
│ [PM ▼]          │ Q: What is the main      │ REQ-001: Login   │
│ [Engineer]      │    goal of this feature? │ (PM, P0)         │
│ [Designer]      │                          │                  │
│ [+ Add]         │ You: User authentication│ REQ-002: OAuth   │
│                 │      and security.      │ support          │
│                 │                          │ (Engineer, P1)   │
│                 │ Q: What about OAuth?    │                  │
│                 │                          │ REQ-003: Offline │
│                 │ You: [text input...]    │ login            │
│                 │                          │ (Designer, P2)   │
└─────────────────┴──────────────────────────┴──────────────────┘
[Next Question] [Skip] [Interview Complete]
```

**Behavior:**
- Orchestrator asks questions tailored to persona's technical level
- User types conversational answers
- Requirements extracted live in right panel
- Can skip questions
- User can manually add/edit requirements

#### Step F – Consolidation & Conflicts

**Requirements Matrix View:**
```
ID    | Title             | Type | Persona    | Priority | Status
──────┼──────────────────┼──────┼────────────┼──────────┼─────────
REQ-1 | User login       | Func | PM, Eng    | P0       | Accepted
REQ-2 | OAuth support    | Func | PM, Eng    | P1       | Accepted
REQ-3 | Offline login    | Func | Designer   | P2       | Proposed
REQ-4 | Real-time sync   | NFR  | Eng        | P1       | Conflicts
REQ-5 | Minimize traffic | NFR  | PM         | P0       | Conflicts
```

**Conflict View (for REQ-4 vs REQ-5):**
```
┌─────────────────────────────────────────┐
│ ⚠️ CONFLICT: REQ-4 vs REQ-5              │
├─────────────────────────────────────────┤
│ REQ-4 (Engineer, P1)                    │
│ "Must sync in real-time"                │
│                                         │
│ vs                                      │
│                                         │
│ REQ-5 (PM, P0)                          │
│ "Minimize network traffic"              │
├─────────────────────────────────────────┤
│ Proposed Resolutions:                   │
│ ☐ Option A: Use polling (compromise)   │
│ ☐ Option B: Real-time with rate limits │
│ ☐ Option C: Phased: MVP = polling,     │
│           v2 = real-time               │
├─────────────────────────────────────────┤
│ [Choose Option] [Defer Decision]        │
└─────────────────────────────────────────┘
```

**Selection Creates Decision:**
```
Created: DEC-001 – Sync Strategy
Context: Conflict between real-time sync (Engineer) vs
         minimize traffic (PM)
Choice: Option C – Phased approach
Linked: REQ-4, REQ-5
Status: Resolved
```

#### Step G – Draft Generation

**Status Screen:**
```
Generating draft proposal...

Orchestrator is:
• Creating document structure ✓
• Populating sections (50%)
• Integrating requirements...
• Adding architecture fit...

[Cancel]
```

**Completion:**
```
Draft generated! Review sections highlighted below:

📄 Live Preview
──────────────────────────────────────
# Auth Flow Feature Specification

## Executive Summary
...

## Personas & Stakeholders
✓ Complete

## Requirements
✓ Complete (5 requirements)

## Architecture Fit
⚠️ Needs Review: "No new patterns unless requested"

## Open Questions
❌ TODO: Add test plan details
```

**Actions:**
- [Continue to Reviews] or [Edit Manually] or [Back to Step F]

#### Step H – Multi-LLM Review & Synthesis

**Review Configuration:**
```
Orchestrator: [Claude Opus ▼]

Reviewers (select all that apply):
☑ Code Feasibility (Codex)
☑ Architecture Fit (Gemini)
☑ Clarity & Completeness (Claude)
☐ Simulate as: [PM persona ▼]

Budget:
  Token limit: [10000]
  Cost ceiling: [$5]

[Run Reviews in Parallel] [Cancel]
```

**Progress Display (during reviews):**
```
Running Reviews...

Codex Review:        ████░░░░░░ 45%
Gemini Review:       ████████░░ 80%
Claude Review:       ██████░░░░ 60%

[Stop reviews] [Pause]
```

**Results (after completion):**
```
Reviews Complete!

┌─────────────────────────────────────┐
│ FINDINGS SUMMARY                    │
├─────────────────────────────────────┤
│ Critical:  2                        │
│ High:      3                        │
│ Medium:    1                        │
│ Low:       2                        │
│                                     │
│ [View All Issues] [Re-run Reviews]  │
└─────────────────────────────────────┘

Critical Issues:
1. Authentication flow doesn't handle
   token refresh. (Codex)
   Section: "API Contracts"

2. Architecture Fit: Proposes new
   pattern not in snapshot. (Gemini)
   Section: "Architecture Fit"

[Synthesize Findings] [Manual Edit] [Back]
```

**After Synthesis:**
```
Synthesis Complete!

Diff View (before/after):
- OLD: "Open Questions: [empty]"
+ NEW: "Open Questions:
        - Token refresh handling"

Issue Resolution:
✅ Critical Issue 1: FIXED
   (Added section: Token Refresh Strategy)

⚠️ Critical Issue 2: NEEDS USER INPUT
   (Architecture pattern conflict - requires decision)

[Approve & Commit] [Request Changes] [Escalate]
```

---

### 4) Document Workspace (Core Editing Interface)

**Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│ Docs: Auth Flow Feature                          [← Back]    │
├───────────────┬──────────────────────┬─────────────────────┤
│  OUTLINE      │   MAIN EDITOR        │   ORCHESTRATOR      │
│               │                      │   PANEL             │
│ 1. Summary    │  ┌─────────────────┐ │  ┌──────────────┐  │
│ 2. Goals      │  │ # Auth Flow     │ │  │ QA Status:   │  │
│ 3. Personas   │  │                 │ │  │ ✅ No block- │  │
│ 4. Reqs       │  │ ## Executive    │ │  │    ing issues│  │
│ 5. Journeys   │  │ Summary...      │ │  │              │  │
│ 6. UX/UI      │  │                 │ │  │ Next steps:  │  │
│ 7. Arch       │  │ [markdown       │ │  │ - Approve    │  │
│ 8. Data       │  │  editor...]     │ │  │ - Export     │  │
│ 9. Edge Cases │  │                 │ │  │   tasks      │  │
│ 10. Security  │  │                 │ │  │              │  │
│ 11. Tests     │  │                 │ │  │ Open Items:  │  │
│ 12. Rollout   │  │                 │ │  │ - Pattern    │  │
│ 13. Questions │  │                 │ │  │   override   │  │
│ 14. Status    │  │                 │ │  │   decision   │  │
│               │  └─────────────────┘ │  │              │  │
│               │  Save (Ctrl+S)       │  └──────────────┘  │
└───────────────┴──────────────────────┴─────────────────────┘

[Document] [Visual Spec] [Reviews] [Requirements] [Decisions] [History]
```

#### Document Tab
- Markdown editor (with syntax highlighting)
- Required sections checklist (left margin)
- Inline comments (human + AI)
- "Cannot export to tasks" warning (if not Approved)

#### Visual Spec Tab
```
┌──────────────┬──────────────────────┐
│ Images       │ Component Details    │
│              │                      │
│ login.png    │ Component: Button    │
│ [thumbnail]  │ Radius: 12px         │
│              │ Fill: #0066FF        │
│ signup.png   │ Font: 14px, bold     │
│ [thumbnail]  │ Shadow: 0 2px 4px    │
│              │ [Edit] [Confirm]     │
│ flow.png     │                      │
│ [thumbnail]  │ Match confidence:    │
│              │ High [████████░░]    │
└──────────────┴──────────────────────┘
[Annotate] [Re-extract] [Upload more]
```

#### Reviews Tab
```
Review Run: 2026-02-11 14:33 UTC
Models: Claude, Codex, Gemini
Status: ✅ Synthesis Complete

Issues Summary:
Critical: 0 ✅
High: 2 ⚠️
Medium: 1 ⚠️
Low: 0

[View Issue Checklist]
[Diff: Before/After Synthesis]
[Re-run Specific Reviewers]

High Issues:
1. Section "Test Plan" needs coverage
   for edge cases. (Codex)
2. Rollout plan missing security
   considerations. (Gemini)

[Resolve] [Defer] [Mark As Non-Critical]
```

#### Requirements Tab
```
REQ-001 | Login Flow | Func | PM | P0
REQ-002 | OAuth | Func | PM, Eng | P1
REQ-003 | Offline Mode | Func | Designer | P2
REQ-004 | Real-time Sync | NFR | Eng | P1
REQ-005 | Minimize Traffic | NFR | PM | P0

[Merge] [Split] [Mark Non-Goal] [Add Conflict] [Link to Section]

⚠️ Conflicts: REQ-004 vs REQ-005
   Decision: DEC-001 – Use polling (phased approach)
```

#### Decisions Tab
```
DEC-001 – Sync Strategy

Context:
Engineer wants real-time updates; PM wants
minimal network traffic. These conflict in
v1 MVP.

Options:
A) Use polling (compromise)
B) Real-time with rate limits
C) Phased: v1 = polling, v2 = real-time

Choice: Option C (phased)

Rationale:
Allows ship v1 faster; unblocks real-time
feature request for v2 post-launch review.

Consequences:
- Delights users with MVP
- Defers real-time work (manage expectations)
- Easier to adopt real-time in v2 without
  breaking v1

Linked Requirements: REQ-004, REQ-005

[Edit] [Archive] [Create Related Decision]
```

#### History Tab
```
Recent Commits:
2026-02-11 14:33  Update: Added test plan section
2026-02-11 13:45  Synthesized review findings
2026-02-11 13:00  Initial draft generated

Review Runs:
2026-02-11 14:00  Multi-LLM Review (Claude, Codex, Gemini) → 2 High issues
2026-02-11 12:30  Codex feasibility review → 3 findings

Approvals:
2026-02-11 08:00  Sarah (PM) – Pending review
2026-02-10 18:00  [Not yet approved]

[Compare Versions] [Rollback] [View Diff]
```

---

### 5) Personas Library

**List View:**
```
Personas (5)

[PM – Growth]
Role: Product Manager
Technical: 2/5
Last used: Auth Flow doc
[Edit] [Duplicate] [Archive]

[Staff Backend]
Role: Engineer
Technical: 5/5
Last used: Billing Refactor doc
[Edit] [Duplicate] [Archive]

[Security Lead]
Role: Security Engineer
Technical: 4/5
Last used: 2 weeks ago
[Edit] [Duplicate] [Archive]

[+ Create New Persona]
```

**Detail Page:**
```
Persona: PM – Growth

Name:                    [PM – Growth ▼]
Role:                    [Product Manager ▼]
Technical Level:         [2 ─●─────────── 5]

Priorities:
Speed ●─────── Safety
Innovation ●─────── Consistency
UX Polish ─●─────── Core Function

Decision Power:          [Approver ▼]

What Success Looks Like:
[Ship features fast; users love the product]

Non-Negotiables:
• No massive rewrites
• Maintain backward compatibility
• Ship within sprint

Communication Style:     [Concise ▼]

Default Review Focus:    [Scope, schedule, UX]

Associated Docs:
• Auth Flow (current)
• Billing (current)
• Notifications (archived)

[Edit] [Export] [Duplicate] [Archive]
```

---

### 6) Requirements Register

**Table View:**
```
Filter: [All ▼] | Type: [All ▼] | Priority: [All ▼] | Conflicts: [Show All ▼]

ID    | Title           | Type     | Personas   | Pri | Status     | Conflicts
──────┼─────────────────┼──────────┼────────────┼─────┼────────────┼──────────
REQ-1 | User login      | Func     | PM, Eng    | P0  | Accepted   | —
REQ-2 | OAuth support   | Func     | PM         | P1  | Proposed   | —
REQ-3 | Real-time sync  | NFR      | Eng        | P1  | Blocked    | REQ-5
REQ-4 | Min traffic     | NFR      | PM         | P0  | Blocked    | REQ-3
REQ-5 | Offline mode    | Func     | Designer   | P2  | Proposed   | —

[Merge] [Split] [Mark Non-Goal] [Priority: ↑↓] [Add Conflict]
```

**Board View (Kanban):**
```
Proposed (2)      Accepted (1)      Blocked (2)       Resolved (0)
┌──────────┐      ┌──────────┐      ┌──────────┐
│ REQ-2    │      │ REQ-1    │      │ REQ-3    │
│ OAuth    │      │ Login    │      │ Sync     │
│ (P1)     │      │ (P0)     │      │ (P1)     │
└──────────┘      └──────────┘      │ Conflicts│
┌──────────┐                        │ w/REQ-5  │
│ REQ-5    │                        └──────────┘
│ Offline  │                        ┌──────────┐
│ (P2)     │                        │ REQ-4    │
└──────────┘                        │ Traffic  │
                                    │ (P0)     │
                                    └──────────┘

[Drag to move] [Resolve Conflicts]
```

---

## End-to-End User Journeys

### Journey 1: Create Spec from Scratch (Happy Path)

1. **Start** → Blueprints → New Document
2. **Step A** – Name it "Auth Flow", type "Feature Spec"
3. **Step B** – Generate Architecture Snapshot
4. **Step C** – Add personas: PM (Approver) + Backend Lead (Approver) + Designer (Contributor)
5. **Step D** – Paste meeting notes + 3 UI wireframes
6. **Step E** – Interview each persona (5-7 questions each)
7. **Step F** – Resolve conflict: "Real-time sync vs minimal traffic" → Choose phased approach (Polling v1, Real-time v2)
8. **Step G** – Generate draft (document auto-created with 15 sections)
9. **Step H** – Run parallel reviews (Codex, Gemini, Claude)
10. **Synthesis** – Findings integrated; 2 High issues fixed
11. **Verification** – All Critical resolved; Architecture Fit confirmed
12. **Approve & Commit** – Doc and assets committed to `docs/blueprints/auth-flow/blueprint.md`
13. **Export Tasks** – Creates Steroids tasks (Sign-in flow, OAuth integration, etc.)
14. **Done** – Tasks fed into existing coder/reviewer loop

**Time estimate:** 45min (if well-organized inputs)

---

### Journey 2: Multiple Stakeholders Disagree

1. Persona interviews capture conflicting wants
2. Requirements Register highlights: REQ-3 vs REQ-5
3. Click "View Conflict"
4. See: Engineer wants real-time; PM wants minimal traffic
5. Orchestrator proposes 3 options; user selects phased approach
6. Decision entry created (DEC-001)
7. Docs updated to reference decision
8. Continue to reviews/synthesis

**Outcome:** Conflict documented, decision ratified, team aligned.

---

### Journey 3: QA an Existing Doc

1. Docs list → select existing doc
2. Click "Run QA"
3. Configure reviewers
4. Parallel reviews run
5. Issues extracted
6. Orchestrator synthesizes
7. User reviews diffs
8. Approve (if all Criticals resolved)
9. Export tasks

**Time estimate:** 15min (if few issues)

---

### Journey 4: Codex-Only Environment

1. Project Settings → Docs → "Orchestrator: [Codex SDK ▼]"
2. Create new doc normally
3. Draft generated by Codex
4. Reviews run with Codex + Gemini (if available; else 2x Codex with different prompts)
5. Synthesis by Codex
6. Continue to verification

**Outcome:** Works degraded but functional; UI shows "Reduced coverage" confidence.

---

## CLI UX (Parallel Command Tree)

```
steroids blueprints new
  Interactive: select project, name, type, personas
  Output: Document created in draft status

steroids blueprints list
  Filter: --status [draft|in-review|approved|archived]
  Filter: --type [feature-spec|ui-spec|adr]
  Output: Table of blueprints

steroids blueprints open <id>
  Preference: Launch web UI (better for editing/images)
  Fallback: Print doc to stdout (markdown)

steroids blueprints interview --blueprint <id> --persona <persona-id>
  Interactive: Run persona interview for existing blueprint
  Output: Requirements extracted and added

steroids blueprints draft <id>
  Generate draft for blueprint (idempotent)

steroids blueprints review --blueprint <id> --parallel
  Run multi-LLM reviews
  Output: Review run ID + status

steroids blueprints synthesize --review-run <id>
  Integrate findings into doc

steroids blueprints verify --blueprint <id>
  Check verification gate
  Output: Pass/Fail + checklist

steroids blueprints commit --blueprint <id>
  Commit doc to git
  Output: Commit hash

steroids blueprints tasks generate --blueprint <id>
  Create implementation tasks from approved blueprint
  Output: Task IDs created

steroids blueprints personas add
  Create new persona (interactive)

steroids blueprints personas list
  Output: All personas with metadata

steroids blueprints personas export --format [yaml|json]
  Export persona pack (for sharing)
```

**Usage pattern:**
```bash
# Quick flow
steroids blueprints new
# ... answer prompts, creates blueprint in draft
steroids blueprints review --blueprint auth-flow-001 --parallel
# ... wait for reviews
steroids blueprints synthesize --review-run <ID>
steroids blueprints verify --blueprint auth-flow-001
steroids blueprints commit --blueprint auth-flow-001
steroids blueprints tasks generate --blueprint auth-flow-001
```

---

## Reliability Signals (UX Patterns)

Throughout the UI, show these reliability indicators to build confidence:

### At Document Level
- ✅ "Reviewed by 3 models"
- ⚠️ "1 Critical issue pending"
- 🧱 "Architecture Fit: Passed"
- 🔒 "Locked (Approved)"
- ❓ "3 Open Questions"

### At Requirement Level
- ✅ "REQ-001: Covered by reviews"
- ⚠️ "REQ-003: Conflicts with REQ-005"
- 📝 "REQ-004: Needs clarification"

### At Review Level
- 📊 "92% Coverage" (confidence score)
- 📈 "2 reviews run; 0 reviewers missing"
- ✓ "Codex + Gemini + Claude completed"
- ❌ "Codex unavailable; using Gemini + Claude"

### At Persona Level
- 🎯 "PM – Growth: [5 requirements] [3 conflicts] [2 decisions]"
- ✓ "PM: Approved"
- ⏳ "Engineer: Review in progress"

---

## Accessibility Considerations

- All modals have keyboard navigation (Tab, Enter, Esc)
- Color indicators have text labels (not color-only)
- Image upload supports screen reader descriptions
- Markdown editor has syntax help (Ctrl+? for shortcuts)
- Conflict resolution options described in plain English (not icons-only)
- Copy buttons on all code/IDs (e.g., "Copy REQ-ID")
