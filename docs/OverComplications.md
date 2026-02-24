# Over-Complications and Technical Debt Analysis

## Objective
This document identifies areas where the Steroids CLI architecture has become excessively complex, non-deterministic, or over-reliant on nested fallbacks. It provides a technical specification for aggressive simplification, verified through independent agent reviews.

---

## 🛑 MANDATORY CONSTRAINT: PROMPT INTEGRITY
The **structure and individual instructions** within all prompt templates (Persona rules, Critical constraints, Task Specifications) are **FROZEN**. 
*   Optimization of how these blocks are assembled, concatenated, or managed (e.g., modular section builder) is permitted and encouraged.
*   The **content** of the instructions themselves MUST NOT be changed, as they have been iteratively tuned for stable performance.
*   Focus of this refactor is exclusively on the **loop logic, database states, and deterministic recovery**.

---

## 1. Orchestration: From "Repair" to "Signal Interpretation"
The current "Repair" model (Layer 4) uses fragile regex to fix malformed JSON. This is often necessary because our JSON schema is too complex and misaligned with our prompts.

### Tasks
- [x] **TASK: Align Schema and Prompts**: Fix `schemas.ts` to include `follow_up_tasks` in the `reviewerSchema`.
- [x] **TASK: Flatten Schemas**: Move critical fields out of the `metadata` object to the top level. Reduce nesting depth.
- [x] **TASK: Reduce Required Fields**: Make most metadata fields optional, with safe defaults in the code.
- [x] **TASK: Delete Repair Logic**: Remove Layer 4 (regex JSON repair) from `OrchestrationFallbackHandler`.
- [x] **TASK: Implement Signal Extractor**: If JSON parsing (Direct + Substring) fails, use a "Signal Extractor" that scans the raw text for high-intent tokens (e.g., `DECISION: APPROVE`, `SUBMISSION_COMMIT: <sha>`) instead of trying to "fix" the JSON.

### Acceptance Criteria
- [x] AC: A unit test must verify that `reviewerSchema` now accepts valid `follow_up_tasks`.
- [x] AC: A unit test must verify that an orchestrator response missing the `metadata` object is still parsed successfully using safe defaults.
- [x] AC: A unit test must verify that a response containing conversational text AND a JSON block is correctly parsed via the "Substring" layer without needing regex repairs.

---

## 2. Resource Management: Unified Database Lifecycle
There are over 85 manual `.close()` calls across the codebase, often inside complex `try/finally` blocks that are inconsistently applied.

### Tasks
- [ ] **TASK: Implement withDatabase**: Add `withDatabase(path, callback)` and `withGlobalDatabase(callback)` wrappers that handle the open/try/finally/close cycle.
- [ ] **TASK: Delete Manual Closes**: Replace 85+ manual close patterns with the new higher-order functions.

### Acceptance Criteria
- [ ] AC: A test must verify that the database is closed automatically even when the callback function throws an error.
- [ ] AC: The total number of `close()` calls in `src/` is reduced by at least 80%.

---

## 3. Shared Core: History & Task Runners
Identical logic for lost sessions and context windows is duplicated in `coder.ts` and `reviewer.ts`.

### Tasks
- [ ] **TASK: Create HistoryManager**: Centralize session history reconstruction and `Token Guard` pruning logic.
- [ ] **TASK: Create BaseRunner**: Encapsulate the invocation lifecycle (temp files, logging, error classification) into a role-agnostic base class.

### Acceptance Criteria
- [ ] AC: `coder.ts` and `reviewer.ts` code size reduced by at least 100 lines each.
- [ ] AC: `HistoryManager` must include a test case simulating `SQLITE_BUSY` during history reconstruction to verify retry logic.
- [ ] AC: A unit test must verify that `Token Guard` pruning preserves the "Task Specification" even when pruning tool outputs.

---

## 4. Command Boilerplate: Unified CLI Structure
Every command in `src/commands/` manually handles help generation, argument parsing, and error logging.

### Tasks
- [ ] **TASK: Create BaseCommand**: Implement a higher-order function or base class that standardizes argument parsing (`parseArgs`), help display, and global error catching.
- [ ] **TASK: Refactor Commands**: Migrate all command files to use the `BaseCommand` infrastructure.

### Acceptance Criteria
- [ ] AC: Code size across `src/commands/` is reduced by ~20%.
- [ ] AC: A test must verify that uncaught errors in any command are automatically logged to the `System Logs` with a standardized exit code.

---

## 5. Database: Explicit State over String-Matching
The system makes architectural decisions by parsing strings in `audit.notes` (e.g., searching for `[must_implement]`).

### Tasks
- [ ] **TASK: Audit Schema Migration**: Add `category` (TEXT), `error_code` (TEXT), and `metadata` (JSON) columns to the `audit` table.
- [ ] **TASK: Implement Backfill**: Create a script that parses legacy `audit.notes` and populates the new columns.

### Acceptance Criteria
- [ ] AC: All internal queries in `src/database/queries.ts` must use column filters instead of `LIKE '%[...]%'`.
- [ ] AC: A test must verify that the backfill script correctly migrates 100% of existing "must_implement" and "rejected" markers in a sample DB.

---

## 6. Unification: Global Backoff Model
The system has two separate "pause" mechanisms: global rate limits and project-level hibernation.

### Tasks
- [ ] **TASK: Delete Project Hibernation**: Remove `hibernating_until` and `hibernation_tier` from the `projects` table.
- [ ] **TASK: Unified Backoff Table**: Use `provider_backoffs` in the Global DB for all delays. Add a `reason_type` column.
- [ ] **TASK: Provider-Aware Wakeup**: The `wakeup` daemon will query the project's configured providers and skip the runner if any required provider is currently backed off.

### Acceptance Criteria
- [ ] AC: The daemon must not start a runner for a project if its primary `coder` or `reviewer` provider is in a backoff state.
- [ ] AC: Integration test must verify that a 429 error correctly sets a global backoff that pauses all projects using that provider.

---

## Summary of Code Deletion Impact
By implementing these six simplifications, we can:
- Delete ~700+ lines of redundant/fragile logic.
- Remove 80+ manual resource management calls.
- Unify the system state and CLI structure into a single source of truth.
- Standardize the "Prompt Architecture" across all AI roles.
