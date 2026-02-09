# Code Quality Guidelines

These 50 rules apply to any modern software project. They are practical, opinionated but not dogmatic, and designed to produce maintainable, testable code.

---

## Architecture & Structure

1. Split code by **responsibility**, not by file type.
2. One module = one clear purpose.
3. A file should fit on one screen (~300–500 LOC max).
4. If you can't name a module clearly, it's doing too much.
5. Dependencies should point **inward** (core knows nothing about edges).
6. Avoid circular dependencies—treat them as design bugs.
7. Prefer composition over inheritance.
8. Keep business logic free of framework code.
9. Separate **read** models from **write** logic when complexity grows.
10. Make boundaries explicit (modules, packages, services).

---

## Code Quality & Maintainability

11. Code should be readable without comments.
12. Comments explain *why*, not *what*.
13. Prefer clarity over cleverness—always.
14. If logic needs explaining, refactor first.
15. Functions should do one thing.
16. Functions should be short enough to read without scrolling.
17. Avoid boolean flags that change function behavior drastically.
18. Name things for what they *mean*, not how they're implemented.
19. Delete dead code aggressively.
20. Optimize for future readers, not current writers.

---

## Testing & Reliability

21. Every important behavior must be testable.
22. Test logic, not frameworks.
23. Unit tests should run fast (< seconds).
24. Integration tests verify boundaries, not internals.
25. Avoid brittle tests tied to implementation details.
26. Tests should read like documentation.
27. One test = one reason to fail.
28. If it's hard to test, the design is wrong.
29. Don't mock what you don't own unless unavoidable.
30. Bugs get tests before fixes.

---

## Data & State

31. Make data flow explicit.
32. Avoid shared mutable state.
33. Validate inputs at boundaries.
34. Fail fast and loudly on invalid data.
35. Prefer immutable data structures when feasible.
36. Never trust external data.
37. Keep persistence concerns separate from domain logic.
38. Make side effects obvious.
39. Time, randomness, and IO should be injectable.
40. Schema changes are breaking changes—treat them seriously.

---

## Process & Team Practices

41. Code review is for correctness, clarity, and design—not style wars.
42. Small, frequent commits beat big heroic ones.
43. Every commit should leave the system deployable.
44. Automate formatting, linting, and checks.
45. CI should fail fast and loudly.
46. Document decisions, not implementations.
47. If it hurts to change, fix the design.
48. Prefer boring technology that works.
49. Measure before optimizing.
50. If it's not simple yet, you're not done.

---

## Quick Reference

### The Non-Negotiables

| Rule | Summary |
|------|---------|
| #3 | 300-500 LOC max per file |
| #5 | Dependencies point inward |
| #6 | No circular dependencies |
| #15 | Functions do one thing |
| #21 | Important behavior is testable |
| #28 | Hard to test = bad design |
| #33 | Validate at boundaries |
| #34 | Fail fast on bad data |
| #43 | Every commit is deployable |
| #50 | Simple or not done |

### Code Smells to Watch

- File too long → Split by responsibility
- Can't name it clearly → Doing too much
- Hard to test → Wrong design
- Needs explanation → Refactor first
- Boolean flag chaos → Extract strategies
- Dead code → Delete it

### The Mindset

> Optimize for future readers, not current writers.

Write code as if the person maintaining it is a violent psychopath who knows where you live.
