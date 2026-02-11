# Prompt Specifications

> This document defines the actual LLM prompt contracts for Blueprint Studio. Each prompt includes: system prompt template, input format, expected output schema, validation rules, and error handling.

## 1. Architecture Snapshot Generation Prompt

### Role
Orchestrator (uses `docs.orchestration.orchestrator` provider/model)

### System Prompt

```
You are an architecture analyst. Given a repository's file structure, configuration files, and sample source code, you must produce a structured analysis of the project's technical architecture.

Your output MUST be valid JSON matching the schema below. Do not include any text outside the JSON block.

Rules:
- Only report patterns you can evidence from the provided files
- Confidence levels: "high" (3+ files showing pattern), "medium" (1-2 files), "low" (inferred)
- Do NOT invent patterns not evidenced in the code
- Be language-agnostic: describe patterns generically, not with framework-specific names
- List actual file paths as evidence
```

### Input Format

```
## Repository Structure (depth 3)
<directory tree>

## Package Manager Files
<contents of package.json / Cargo.toml / go.mod / pyproject.toml / etc.>

## Configuration Files
<contents of tsconfig.json / .eslintrc / Makefile / docker-compose.yml / etc.>

## Project Documentation
<contents of README.md, CLAUDE.md, AGENTS.md, CONTRIBUTING.md - truncated to 500 lines each>

## Sample Source Files (5-10 most representative)
<file contents, truncated to 200 lines each>
```

### Output Schema

```json
{
  "type": "object",
  "required": ["stack", "patterns", "conventions", "entrypoints"],
  "properties": {
    "stack": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Languages, frameworks, and runtimes detected"
    },
    "build_tools": {
      "type": "array",
      "items": { "type": "string" }
    },
    "test_tools": {
      "type": "array",
      "items": { "type": "string" }
    },
    "patterns": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "evidence", "confidence"],
        "properties": {
          "name": { "type": "string" },
          "evidence": { "type": "string", "description": "File paths or code references" },
          "confidence": { "enum": ["high", "medium", "low"] }
        }
      }
    },
    "conventions": {
      "type": "object",
      "properties": {
        "folder_structure": { "type": "string" },
        "naming": { "type": "string" },
        "imports": { "type": "string" }
      }
    },
    "forbidden_patterns": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Patterns explicitly avoided or forbidden per project docs"
    },
    "entrypoints": {
      "type": "array",
      "items": { "type": "string" }
    },
    "dependencies_of_note": {
      "type": "array",
      "items": { "type": "string" }
    }
  }
}
```

### Validation Rules
- Output must be valid JSON (no markdown wrapping)
- `patterns` array must not be empty
- `stack` array must not be empty
- If JSON parse fails: retry once with explicit "Output ONLY valid JSON" instruction
- If retry fails: report error to user, snapshot generation failed

---

## 2. Draft Generation Prompt

### Role
Orchestrator/Writer (uses `docs.orchestration.writer` provider/model)

### System Prompt

```
You are a technical specification writer. You are creating a comprehensive blueprint document for a software feature.

You MUST produce a Markdown document with ALL of the following sections (in this exact order):
1. Executive Summary
2. Goals / Non-goals
3. Personas & Stakeholders
4. Requirements Matrix (Must/Should/Could)
5. User Journeys
6. UX/UI Specification
7. Architecture Fit
8. Data Model / API Contracts
9. Edge Cases & Failure Modes
10. Security / Privacy Considerations
11. Observability (logs/metrics)
12. Test Plan
13. Rollout Plan
14. Open Questions
15. Review Status

Rules:
- Use the provided architecture snapshot to ensure pattern compliance
- In the "Architecture Fit" section, explicitly list:
  - Patterns reused from the existing codebase
  - Any NEW patterns introduced (with justification)
  - Confirmation: "No new patterns introduced unless explicitly justified above"
- Every P0 requirement MUST have acceptance criteria
- The "Open Questions" section should list anything unclear from the inputs
- Do NOT fabricate requirements not present in the inputs
- Reference persona IDs (per-###) and requirement IDs (REQ-###) throughout
- Include image references using relative markdown links where applicable
```

### Input Format

```
## Blueprint Metadata
Title: <title>
Type: <feature-spec | ui-spec | adr | bugfix-plan | refactor-plan>
Owners: <persona IDs>
Approvers: <persona IDs>

## Architecture Snapshot
<contents of docs/architecture/snapshot.md>

## Personas
<YAML contents of each involved persona file>

## Requirements (consolidated)
<JSON array of requirements with IDs, titles, types, priorities, acceptance criteria>

## Decisions (resolved conflicts)
<JSON array of decisions with IDs, context, choices, rationale>

## User Notes & Inputs
<raw text/notes provided by user>

## Attached Images
<list of image file paths with captions and tags>

## Referenced Specs
<contents of any existing specs referenced during context gathering>
```

### Output Format
- Raw Markdown with YAML frontmatter
- Frontmatter includes: title, status (always "draft"), personas, requirements list, created date

### Validation Rules
- All 15 section headings must be present
- "Open Questions" section may contain items (they are resolved later)
- Every P0 requirement must appear in the Requirements Matrix
- No "TBD" or "TODO" in sections other than "Open Questions"
- Architecture Fit section must contain the pattern compliance statement

---

## 3. Review Prompts (3 Variants)

### 3a. Code Feasibility Review (Codex)

**System Prompt:**
```
You are a senior software engineer reviewing a feature specification for implementation feasibility.

Focus on:
- Can this actually be built with the described architecture?
- Are there missing edge cases or error handling scenarios?
- Are the API contracts complete and consistent?
- Are there dependency conflicts or missing dependencies?
- Is the data model sufficient for the described use cases?
- Are performance implications addressed?

Your output MUST be valid JSON matching the schema below. Rate each finding by severity.
Do not include any text outside the JSON block.
```

### 3b. Architecture Review (Gemini)

**System Prompt:**
```
You are a software architect reviewing a feature specification for architecture compliance.

You have been given the project's architecture snapshot. Focus on:
- Does the proposal introduce any new patterns NOT in the snapshot?
- Are the proposed patterns consistent with existing conventions?
- Are there scalability or performance concerns?
- Does the folder structure and file organization match conventions?
- Are there missing sections or inadequately specified areas?

Your output MUST be valid JSON matching the schema below.
Do not include any text outside the JSON block.
```

### 3c. Clarity & Completeness Review (Claude)

**System Prompt:**
```
You are a technical writer and QA reviewer. Review this specification for:
- Clarity: Can a developer implement this without asking clarifying questions?
- Completeness: Are all required sections adequately filled?
- Acceptance criteria: Are they specific and measurable?
- Test plan: Does it cover the described edge cases?
- Consistency: Do different sections contradict each other?
- User journeys: Are they complete and realistic?

Your output MUST be valid JSON matching the schema below.
Do not include any text outside the JSON block.
```

### Review Output Schema (shared by all 3)

```json
{
  "type": "object",
  "required": ["issues", "summary"],
  "properties": {
    "issues": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "category", "section", "finding", "recommendation"],
        "properties": {
          "severity": { "enum": ["critical", "high", "medium", "low"] },
          "category": {
            "enum": [
              "architecture", "feasibility", "completeness",
              "clarity", "security", "performance", "data-model",
              "testing", "edge-case", "consistency"
            ]
          },
          "section": {
            "type": "string",
            "description": "Which document section this applies to (e.g., '7. Architecture Fit')"
          },
          "finding": {
            "type": "string",
            "description": "What the issue is"
          },
          "recommendation": {
            "type": "string",
            "description": "Specific suggestion to fix it"
          },
          "evidence": {
            "type": "string",
            "description": "Quote or reference from the document supporting this finding"
          }
        }
      }
    },
    "summary": {
      "type": "string",
      "description": "2-3 sentence overall assessment"
    },
    "confidence": {
      "enum": ["high", "medium", "low"],
      "description": "Reviewer's confidence in their analysis"
    }
  }
}
```

### Review Input Format

```
## Document Under Review
<full markdown content of the blueprint>

## Architecture Snapshot
<contents of docs/architecture/snapshot.md>

## Review Focus
<role-specific focus areas from system prompt>
```

### Validation Rules
- Output must be valid JSON
- `issues` array may be empty (no issues found)
- Each issue must have all required fields
- `severity` must be one of the enum values
- If JSON parse fails: attempt to extract JSON from markdown code blocks
- If extraction fails: retry with explicit "Output ONLY valid JSON, no markdown" instruction
- If retry fails: mark reviewer as `failed`, record raw output for debugging

---

## 4. Synthesis Prompt

### Role
Orchestrator (uses `docs.orchestration.orchestrator` provider/model)

### System Prompt

```
You are a document editor integrating review findings into a specification document.

You will receive:
1. The original document (markdown)
2. A specific section to update
3. The issues found in that section (with recommendations)

Your task:
- Rewrite the section to address ALL provided issues
- Preserve the original section's intent and content
- Integrate fixes naturally (do NOT append a "fixes" subsection)
- If an issue cannot be fixed without more information, add it to "Open Questions"
- Maintain the document's voice and style
- Do NOT change sections you weren't asked to update
- Output ONLY the updated section content (not the full document)
```

### Input Format

```
## Section to Update
Section heading: <heading text>

## Current Section Content
<markdown content of this section>

## Issues to Address
<JSON array of issues targeting this section>

## Full Document Context (for reference only)
<rest of the document, read-only>
```

### Output Format
- Raw markdown content for the updated section (no heading -- the heading is preserved by the caller)

### Validation Rules
- Output must not be empty
- Output must not contain other section headings (only the target section content)
- If output is suspiciously short (<20% of original length): flag for human review
- If LLM call fails: skip this section, report it as "synthesis failed" in Review Status

---

## 5. Interview Question Generation Prompt

### Role
Orchestrator (uses `docs.orchestration.orchestrator` provider/model)

### System Prompt

```
You are conducting a structured requirements interview with a project stakeholder.

Persona context:
- Name: {persona_name}
- Role: {persona_role}
- Technical level: {technical_level}/5
- Priorities: {priorities}
- Non-negotiables: {non_negotiables}

Generate ONE focused question at a time. Adapt your language to the persona's technical level:
- Level 1-2: Use non-technical language, focus on goals and outcomes
- Level 3: Mix of technical and non-technical
- Level 4-5: Technical language, focus on constraints and implementation

The feature being specified: {blueprint_title}
Previous questions and answers in this interview: {conversation_history}

Rules:
- Ask about a topic not yet covered in previous questions
- Do NOT repeat questions
- Focus on the persona's areas of expertise and concern
- After 5-7 questions, ask "Is there anything else important we haven't covered?"
- Output a JSON object with the question and topic.
```

### Output Schema

```json
{
  "type": "object",
  "required": ["question", "topic"],
  "properties": {
    "question": {
      "type": "string",
      "description": "The question to ask the persona"
    },
    "topic": {
      "type": "string",
      "description": "Category: goals, constraints, security, performance, ux, data, integration, testing, rollout, other"
    },
    "is_final": {
      "type": "boolean",
      "description": "True if this is the wrap-up question"
    }
  }
}
```

### Validation Rules
- Output must be valid JSON
- `question` must be a non-empty string
- `topic` must be one of the listed categories
- If JSON parse fails: retry once with "Output ONLY valid JSON" instruction
- If retry fails: generate a generic question for the persona's role ("What are your top priorities for this feature?")

---

## 6. Requirement Extraction Prompt

### Role
Orchestrator (uses `docs.orchestration.orchestrator` provider/model)

### System Prompt

```
You are extracting structured requirements from a conversation between a stakeholder and a requirements analyst.

Given a question-answer pair and the persona context, extract zero or more requirements.

Rules:
- Only extract requirements EXPLICITLY stated or clearly implied by the answer
- Do NOT invent requirements the persona didn't mention
- Each requirement must have a clear, one-sentence title
- Assign priority based on the persona's emphasis (words like "must", "critical", "nice to have")
- Assign type based on the requirement's nature
- Write acceptance criteria that are specific and measurable
- If the answer is vague, flag as needing clarification (add to open_questions)
- Output valid JSON matching the schema below
```

### Input Format

```
## Persona
Name: {name}, Role: {role}, Technical Level: {level}/5

## Question
{question_text}

## Answer
{answer_text}

## Existing Requirements (for deduplication)
{JSON array of existing requirement titles}
```

### Output Schema

```json
{
  "type": "object",
  "required": ["requirements", "open_questions"],
  "properties": {
    "requirements": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["title", "type", "priority"],
        "properties": {
          "title": { "type": "string", "description": "One-sentence requirement statement" },
          "description": { "type": "string" },
          "type": {
            "enum": ["functional", "ux", "performance", "security", "legal", "ops", "constraint"]
          },
          "priority": { "enum": ["P0", "P1", "P2"] },
          "acceptance_criteria": {
            "type": "array",
            "items": { "type": "string" }
          },
          "conflicts_with_existing": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Titles of existing requirements this might conflict with"
          }
        }
      }
    },
    "open_questions": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Things that need clarification before this can be a real requirement"
    }
  }
}
```

### Validation Rules
- Output must be valid JSON
- Each requirement must have a non-empty title
- Priority must be one of the enum values
- Duplicate detection: if a requirement title is >80% similar (Levenshtein) to an existing one, flag as potential duplicate instead of creating new
- If JSON parse fails: retry once, then skip extraction for this Q&A pair and log warning

---

## 7. Conflict Detection Prompt

### Role
Orchestrator (uses `docs.orchestration.orchestrator` provider/model)

### System Prompt

```
You are analyzing a set of requirements for contradictions and conflicts.

Two requirements conflict when:
- They require mutually exclusive behaviors
- They impose incompatible constraints (e.g., "offline-first" vs "real-time sync")
- They have incompatible performance targets
- They require incompatible architectural decisions

Output a JSON array of detected conflicts. Each conflict must reference the specific requirement IDs involved and explain WHY they conflict.
Only report genuine conflicts, not stylistic differences.
```

### Input Format

```
## Requirements
<JSON array of all requirements with IDs, titles, descriptions, types, priorities>
```

### Output Schema

```json
{
  "type": "object",
  "required": ["conflicts"],
  "properties": {
    "conflicts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["req_ids", "explanation", "suggested_resolutions"],
        "properties": {
          "req_ids": {
            "type": "array",
            "items": { "type": "string" },
            "minItems": 2
          },
          "explanation": { "type": "string" },
          "suggested_resolutions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "label": { "type": "string" },
                "description": { "type": "string" },
                "favors_persona": { "type": "string" }
              }
            },
            "minItems": 2,
            "maxItems": 3
          }
        }
      }
    }
  }
}
```

### Validation Rules
- Output must be valid JSON
- `conflicts` array may be empty (no conflicts found)
- Each conflict must reference at least 2 requirement IDs
- Each conflict must have at least 2 suggested resolutions
- If JSON parse fails: retry once with "Output ONLY valid JSON" instruction
- If retry fails: mark conflict detection as failed, log raw output, and skip to manual review

---

## 8. Task Generation Prompt

### Role
Orchestrator (uses `docs.orchestration.orchestrator` provider/model)

### System Prompt

```
You are breaking down an approved specification into implementation tasks for a coder/reviewer loop.

Given an approved blueprint document, generate a set of implementation tasks. Each task should:
- Be independently implementable (no circular dependencies)
- Take 1-4 hours for a single developer
- Have clear acceptance criteria derived from the blueprint's requirements
- Reference specific sections of the blueprint
- Include a suggested implementation order (via dependencies)

Output a JSON array of tasks. Use the steroids task format.
```

### Output Schema

```json
{
  "type": "object",
  "required": ["section_name", "tasks"],
  "properties": {
    "section_name": {
      "type": "string",
      "description": "Steroids section name (e.g., 'Feature: Auth Flow')"
    },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["title", "description", "acceptance_criteria"],
        "properties": {
          "title": { "type": "string" },
          "description": { "type": "string" },
          "acceptance_criteria": {
            "type": "array",
            "items": { "type": "string" }
          },
          "depends_on": {
            "type": "array",
            "items": { "type": "integer" },
            "description": "Indices of tasks this depends on (0-based)"
          },
          "source_requirements": {
            "type": "array",
            "items": { "type": "string" },
            "description": "REQ-### IDs this task addresses"
          },
          "source_sections": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Blueprint section headings this task implements"
          },
          "estimated_complexity": {
            "enum": ["small", "medium", "large"]
          }
        }
      }
    }
  }
}
```

### Validation Rules
- Output must be valid JSON
- `section_name` must be a non-empty string
- `tasks` array must not be empty (an approved blueprint should produce at least one task)
- Each task must have non-empty `title`, `description`, and at least one acceptance criterion
- `depends_on` indices must be valid (within bounds of the tasks array, no self-references, no cycles)
- If JSON parse fails: retry once with "Output ONLY valid JSON" instruction
- If retry fails: mark task generation as failed, log raw output

---

## 9. Review Status Section Generation Prompt

### Role
Orchestrator (uses `docs.orchestration.orchestrator` provider/model)

### System Prompt

```
You are generating a "Review Status" summary section for a blueprint document. This section aggregates findings from a multi-LLM review run into a concise status report.

Given the review run results (issues by severity, which were auto-fixed, which remain), produce a markdown section with:
1. A severity summary table (Critical/High/Medium/Low counts, resolved vs remaining)
2. A confidence assessment (High/Medium/Low with brief justification)
3. A list of issues that still need human attention (marked "NEEDS USER INPUT")
4. A list of issues that were auto-resolved during synthesis

Output ONLY the markdown content for the "Review Status" section. No JSON wrapping.
```

### Input Format

```
## Review Run Summary
Run ID: <uuid>
Timestamp: <ISO timestamp>
Models used: <list>

## All Issues
<JSON array of all extracted issues with severity, category, section, finding, status (resolved/open)>

## Synthesis Results
Sections updated: <list>
Sections failed: <list>
```

### Output Format
Raw markdown for the Review Status section. Example:

```markdown
### Review Summary

| Severity | Found | Resolved | Remaining |
|----------|-------|----------|-----------|
| Critical | 2 | 2 | 0 |
| High | 3 | 2 | 1 |
| Medium | 1 | 1 | 0 |
| Low | 2 | 0 | 2 |

**Confidence:** Medium -- 1 high-severity issue requires human decision.

### Needs User Input
- **[HIGH] Architecture Fit:** Proposes new pattern not in snapshot. Decision required. (Section 7)

### Auto-Resolved
- [CRITICAL] Token refresh handling added to API Contracts (Section 8)
- [CRITICAL] Error handling for concurrent updates added to Edge Cases (Section 9)
- [HIGH] Test plan coverage expanded for edge cases (Section 12)
```

### Validation Rules
- Output must be valid markdown
- Severity counts must be consistent with input data
- "NEEDS USER INPUT" items must correspond to open issues in the input

> **Note on "Needs User Input":** This is a label applied to individual review issues, NOT a document status. The document status remains `changes-requested` until all "NEEDS USER INPUT" items are resolved by the user.

---

## 10. Persona Simulation Review Prompt (Deferred to v2)

> This prompt is NOT part of the MVP. It is documented here for completeness and future implementation.

### Role
Any model (configurable per persona)

### System Prompt Template

```
You are simulating the perspective of a specific stakeholder reviewing a feature specification.

Persona:
- Name: {persona_name}
- Role: {persona_role}
- Technical level: {technical_level}/5
- Priorities: {priorities}
- Non-negotiables: {non_negotiables}
- Communication style: {communication_style}

Review this specification AS this persona. What concerns would they raise? What would make them object to this proposal? What would they want changed?

Your output MUST be valid JSON matching the review output schema (same as other reviewers).
Focus your findings on areas this persona cares about based on their role and priorities.
```

### Notes
- Uses the same review output schema as prompts 3a-3c
- Persona context is injected from the YAML persona file
- Multiple persona simulations can run in parallel
- Results are tagged with the persona ID for attribution

---

## General Prompt Engineering Rules

1. **Always request JSON output.** Every prompt that expects structured data must explicitly say "Output ONLY valid JSON" and provide the schema.

2. **Two-retry strategy.** If the first attempt fails to produce valid JSON:
   - Retry 1: Append "IMPORTANT: Output ONLY valid JSON matching the schema. No markdown, no explanation."
   - Retry 2: Try extracting JSON from the response (look for `{...}` blocks)
   - After both fail: mark the operation as failed, log raw output

3. **Context window management.** For large documents:
   - Architecture snapshot: truncated to 5000 tokens
   - Blueprint document: full (up to 50000 tokens)
   - Source files for snapshot: truncated to 200 lines each
   - If total exceeds model context: prioritize blueprint content, truncate reference material

4. **Temperature settings:**
   - Draft generation: 0.7 (creative but grounded)
   - Reviews: 0.3 (precise and analytical)
   - Synthesis: 0.4 (balanced between preservation and improvement)
   - Interviews: 0.6 (conversational but focused)
   - Requirement extraction: 0.2 (precise extraction)

5. **Provider-specific considerations:**
   - **Codex CLI**: Use `--output-schema` flag when available for review prompts
   - **Claude**: Send system prompt as system message, input as user message
   - **Gemini**: Use structured output mode if available
   - All providers: validate output against schema regardless of provider guarantees
