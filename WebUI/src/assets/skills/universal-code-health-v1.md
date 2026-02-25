# SKILL: UNIVERSAL_CODE_HEALTH_V1

## Purpose

Maximize maintainability: fast comprehension + safe modification + low blast radius + high change confidence.

## Scope

Language-agnostic. Architecture-neutral. Structural and behavioral practices only.

---

## 1. CORE PRINCIPLE

Maintainability =

```text
Comprehension_speed ↑
Change_risk ↓
Ripple_effect ↓
Test_confidence ↑
```

Metrics are tripwires, not proofs of quality.

---

## 2. SIZE & COMPLEXITY CONSTRAINTS

### 2.1 Function / Method

```text
Target_LOC <= 25–30
Rethink_LOC >= 40
Avoid_LOC > 80 (unless simple dispatcher / perf-critical + strong tests)

Cyclomatic_Complexity (CC):
  Target <= 10
  Design_time_target <= 7
  High_risk >= 11–15
  Avoid > 15 (especially safety-critical)

Nesting_depth:
  Target <= 3
  Avoid > 4
```

If:

```text
LOC ↑ AND CC ↑ → Mandatory refactor
```

Over-extraction risk:

- Excess indirection
- Narrative fragmentation

Under-extraction risk:

- Coupled sub-tasks
- Hard partial testing

### 2.2 File / Module

```text
Target_LOC <= 400–600
Rethink >= 800–1000
Rare > 2000 only if justified: generated, cohesive dispatcher, or data table
```

Each file should represent one headline concept.

Smells:

- Shotgun_surgery
- Divergent_change
- Mixed_responsibilities

Over-splitting risk:

- Navigation overhead
- Import fragmentation

Under-splitting risk:

- Implicit coupling
- Review difficulty

---

## 3. RESPONSIBILITY & DESIGN RULES

### 3.1 SRP (Single Responsibility Principle)

Definition:

```text
1 module/class/function = 1 reason_to_change
```

Test:
If explanation contains “and”, SRP may be violated.

Over-application risk:

- Micro-type explosion
- Excess indirection

Under-application risk:

- Divergent change
- Regression amplification

### 3.2 Cohesion & Coupling (OO metrics aligned)

```text
High_cohesion
Low_coupling
```

Metrics triggers:

```text
LCOM ↑ → split
CBO ↑ → reduce dependencies
Public_API_surface ↑ → shrink
```

Split triggers:

- Unrelated fields
- Multiple actors
- Frequent multi-reason edits

### 3.3 Inheritance vs Composition

Rule:

```text
Prefer composition
Use inheritance only if true behavioral substitutability (LSP holds)
```

Avoid:

- Deep inheritance trees
- Subclass overriding internals

If inheriting:

- Document invariants
- Lock behavior with tests

---

## 4. MODULARITY & BOUNDARIES

### 4.1 Information Hiding

Put volatile details behind stable interfaces.

- Stable:
  - Domain concepts
  - Policies
- Volatile:
  - DB schemas
  - File formats
  - Caching strategies
  - Frameworks

Ripple test:
Change in module A should not cascade widely.

### 4.2 Layering Rule

Dependency direction:

```text
UI -> App -> Domain
Infra -> App
Domain !=> UI
```

Domain:

- No framework imports
- No IO dependencies

Side-effects:

- Isolated at edges
- Behind interfaces

---

## 5. DEPENDENCY HYGIENE

### 5.1 Structural

Rules:

```text
No cyclic deps
High-level policy must not depend on low-level IO
Depend on interfaces
```

### 5.2 Third-party

Rules:

```text
Minimize dependencies
Justify additions
Use semantic versioning
Lock dependency trees
Commit lockfiles
```

Pinning trade-off:

```text
Too tight -> upgrade burden
Too loose -> nondeterminism
```

---

## 6. NAMING

Empirical findings:

- Descriptive compound names improve comprehension.
- Excessively long identifiers increase cognitive overload.

Rules:

```text
Name = purpose (+ units when useful)
Avoid cryptic abbreviations
Use consistent domain vocabulary
Follow local style conventions
```

Prefer:

- `cacheTtlMs`
- `userId`
- `netAmount`

Avoid:

- `d`
- `proc`
- `handle`

---

## 7. ERROR HANDLING

Rule:

```text
No silent failures
Every error: handle | propagate | explicitly silence with rationale
```

Do:

- Preserve context
- Wrap with semantic meaning
- Avoid leaking sensitive data

Avoid:

```text
catch (...) {}
except: pass
```

Errors are not normal control flow unless idiomatic and tested.

---

## 8. COMMENTS & DOCUMENTATION

Rule:

```text
Comment WHY, not WHAT
```

Good:

- Constraints
- Invariants
- Rationale
- Non-obvious trade-offs

Bad:

- Narrating obvious code

Drift risk:

Comment updates that lag behavior increase bug probability.

If behavior changes, update comments in the same change.

Provide file overview when behavior is not obvious.

---

## 9. TESTING INFRASTRUCTURE

Primary purpose:

```text
Enable safe change
Increase dev productivity
```

Distribution:

- Majority: small deterministic unit tests
- Fewer integration tests
- Large tests only when purposeful

Test qualities:

- Deterministic
- Fast
- Behavior-focused
- Refactor-safe

Before refactor:

```text
Add missing tests
```

---

## 10. FORMATTING & CONSISTENCY

Rules:

```text
Use auto-formatter
Run formatting in CI
Treat style guide as authority
Adopt EditorConfig
Avoid style bikeshedding
```

Consistency outweighs preference.

Exceptions only if readability materially improves.

---

## 11. METRICS USAGE POLICY

Metrics are tripwires, not scorecards.

Use metrics to trigger:

- Refactor discussion
- Extra reviewer
- Test strengthening
- Boundary redesign

Key metrics:

```text
LOC
CC
LCOM
CBO
Churn
```

LOC alone is a weak predictor.

Churn is useful at extremes.

---

## 12. CODE SMELLS (TRIGGERS)

Common triggers:

- Long method
- Complex class
- Divergent change
- Shotgun surgery
- Feature envy
- God class
- Excessive nesting
- High CC + high LOC

Empirical finding:
Smelly classes are more change-prone and fault-prone.

Refactor loop:

```text
Detect → Add tests → Refactor → Re-measure → Review
```

---

## 13. CODE REVIEW PRACTICE

Goals:

- Improve code health over time
- Optimize for understanding
- Enable knowledge transfer

Rules:

- Small, coherent changes
- Reject oversized diffs
- Require tests for logic changes
- Focus on readability
- Respect metrics thresholds
- Prefer improvement over perfection

Review participation and expertise matter.

---

## 14. TRADE-OFF MATRIX

| Practice | Overuse Risk | Underuse Risk |
|---|---|---|
| Small functions | Indirection overload | Coupled logic |
| SRP | Micro-type explosion | Divergent change |
| Abstraction | Interface soup | Volatile leakage |
| Pinning dependencies | Upgrade burden | Non-reproducible builds |
| Comments | Stale drift | Lost rationale |
| Unit tests | Missed integration wiring | Flaky heavy tests |

---

## 15. GLOBAL INVARIANTS

Always optimize for:

```text
Low blast radius
High local reasoning
Explicit dependencies
Clear contracts
Narrow public APIs
Stable boundaries
Deterministic builds
Reproducible tests
Readable code > clever code
```

---

## 16. AGENT EXECUTION RULES

When generating or modifying code:

1. Enforce size + CC limits.
2. Reject deep nesting.
3. Enforce SRP.
4. Enforce low coupling.
5. Prefer composition.
6. Isolate side effects.
7. Preserve domain purity.
8. Require tests for logic changes.
9. Use descriptive naming.
10. Prevent silent errors.
11. Maintain formatting automatically.
12. Avoid cyclic dependencies.
13. Trigger refactor if metrics exceed thresholds.
14. Shrink public API surface.
15. Keep changes small and reviewable.
