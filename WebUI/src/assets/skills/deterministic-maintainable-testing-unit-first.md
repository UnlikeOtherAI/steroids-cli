# SKILL: Deterministic, Maintainable Testing (unit-first + test portfolio)

## Mission

Produce tests that are trustworthy contracts: fast, deterministic, hermetic, readable; failures should localize regressions. Prime rule: **never “fix CI” by weakening tests**. Change tests only if requirement changed or test was wrong (then usually strengthen).

## 0) Definitions / framing

- **Unit**: separately testable slice (function/class/module/component). Unit tests are executable behavior contracts.
- Mental model: **tests are oracle; code is suspect**.
- Always aim for reproducible local+CI execution, rerun-safe behavior, and order/parallel safety.

## 1) Non-negotiables (global invariants)

- **Determinism**: same inputs ⇒ same results across machines and reruns.
- **Hermeticity**: no hidden dependencies (network, DB, time, RNG, env, globals, shared filesystem).
- **Explicit deps**: time, RNG, config, I/O are injected; avoid ambient globals.
- **Behavior assertions**: assert outputs + observable effects; avoid implementation detail coupling.
- **Order/parallel safety**: tests pass in any order and under parallel execution.
- **Clarity**: one test = one behavior contract; failure message explains intent.

## 2) Canonical test structure

Pick one style and enforce consistently:

- **AAA**: Arrange → Act → Assert
- **GWT**: Given → When → Then

Rules:

- Name tests in domain language: `should_<behavior>_when_<condition>()`
- Keep setup minimal; prefer helpers/builders over duplicated boilerplate.

## 3) Determinism controls (flake sources and countermeasures)

### Time / timers

- ❌ `now()/DateTime.Now/system_clock` inside business logic.
- ✅ Inject `Clock/TimeProvider` (or equivalent), freeze/advance in tests.
- ❌ `sleep()` for synchronization.
- ✅ Fake timers or deterministic waits (event/condition driven).

### Randomness

- Inject RNG or seed and log seed on failure.
- Property-based testing must preserve seed + replay path.

### Concurrency / async

- Avoid shared mutable globals; per-test isolation.
- Ensure tests pass with runner parallelism enabled.
- If serialization is unavoidable, isolate via explicit grouping/fixtures.

### I/O / filesystem

- Use per-test temp directories/fixtures; no shared paths/artifact names.
- Automatic cleanup via fixture lifecycle.

### Environment / config / globals

- Avoid reading environment/globals in core logic; inject config.
- If patching environment/globals, scope and auto-revert per test.

### External dependencies (network/DB/queues/services)

- Unit tests: replace with fakes/stubs.
- Integration tests: use ephemeral real dependencies (containers), deterministic seed data.

### Locale / timezone / floats / rendering

- Fix locale/timezone where relevant.
- For floats, use tolerances.
- For visual tests: disable animations, keep stable viewport/fonts, and stable rendering environment.

## 4) Test doubles (deliberate use, avoid brittleness)

Default preference: state-based verification (return values, persisted state, emitted messages captured by fake).

Use interaction-based mocking only when interaction is the contract (e.g., must publish event once, must not call gateway on validation failure).

Avoid:

- Over-mocking internal orchestration.
- Strict call order assertions unless order is a requirement.

Good pattern: fake dependencies with minimal behavior and captured outputs (for example, `CapturingEmailSender.sent[]`).

## 5) Anti-patterns (defects)

- `sleep()` and timing-dependent tests.
- Assertion roulette (many assertions, unclear intent).
- Giant/eager tests with multiple behaviors.
- Shared mutable fixtures causing order dependence.
- Implementation-detail tests (private methods, internal call sequence).
- Snapshot spam or auto-updated snapshots without review.

## 6) Snapshot + visual regression rules

- Snapshots are baselines; updates require human review.
- Keep snapshots small (component fragment, not entire app/page).
- Stabilize environment: fonts, viewport, animations off; store diffs as CI artifacts.
- Prefer meaningful semantic assertions (roles/text/state) plus targeted small snapshots.

## 7) Test portfolio (beyond unit tests)

Use a practical portfolio:

- **Unit (many)**: pure logic, edge cases, deterministic, hermetic.
- **Integration (some)**: boundaries (DB queries, serialization, auth middleware, migrations) with ephemeral dependencies.
- **Contract (some, for services)**: consumer/provider agreements (avoid full E2E).
- **E2E (few)**: critical journeys only (login/checkout/billing).
- **Visual/screenshot (few/targeted)**: CSS/layout regressions.
- **Property-based (targeted)**: invariants for parsers/encoders/normalizers with replayable seeds.
- **Mutation testing (periodic/nightly)**: validates test strength; tests should fail on subtle mutants.

## 8) Test failure decision procedure

When a test fails after code change:

1. Determine if requirement changed.
   - If yes: update test and explicit spec/expectation; reviewer should state new contract.
2. If no: treat as bug/regression and fix product code; keep test.
3. If the test was genuinely wrong/incomplete: change it by making contract clearer/stronger (add assertions/cases).
4. If flaky: root-cause nondeterminism and fix isolation/time/RNG/parallelism; do not loosen assertions.

## 9) CI rules that preserve integrity

- Any test failure fails the build; no partial-green exception.
- Run in stages: unit → integration → contract → e2e/visual (expensive last).
- Capture repro artifacts: seeds/replay info, screenshots+diffs, logs, environment info.
- Pin and lock dependencies:
  - Python: pinned requirements
  - Node: lockfile + `npm ci`
  - Rust: `Cargo.lock`
  - Go: `go.sum`
  - .NET: `packages.lock.json`
- Use sandboxed/isolation where possible to reduce hidden dependencies.
- Quarantine is a last resort with owner, deadline, and root-cause plan.

## 10) Review checklist

### Behavior

- [ ] Test name states contract in domain terms.
- [ ] One behavior per test; failure pinpoints regression.

### Determinism

- [ ] No wall-clock reliance, no uncontrolled sleeps/RNG.
- [ ] Time injected/frozen; RNG seeded/injected; PBT replay info captured.
- [ ] Order + parallel safe.

### Isolation

- [ ] Unit tests use no real network/DB.
- [ ] Per-test temp dirs; no shared mutable fixtures.
- [ ] Doubles control inputs and capture outputs without mirroring internals.

### Integrity

- [ ] If test changed, reviewer can explain requirement change or test-bug correction.
- [ ] Assertions were not weakened to pass the pipeline.

### CI readiness

- [ ] Dependencies are locked.
- [ ] Build produces useful failure artifacts.

## 11) Tooling map (practical library shortlist)

### Java/JVM

- Unit: JUnit 5, Mockito
- Integration: Testcontainers
- Property-based: jqwik
- Mutation: PIT
- E2E/Browser: Selenium, Playwright

### JS/TS

- Unit: Jest, Vitest, Mocha
- E2E/component: Cypress, Playwright
- Visual/snapshots: Jest snapshots, jest-image-snapshot, Percy, Chromatic
- Property-based: fast-check
- Mutation: StrykerJS
- Integration deps: testcontainers-node

### Python

- Unit: pytest (+ fixtures `tmp_path`, monkeypatch), pytest-mock
- Property-based: Hypothesis (replay)
- Mutation: mutmut
- Integration deps: testcontainers-python
- Browser/E2E: Selenium, Playwright
- Time freeze: freezegun (if injection not possible)

### .NET

- Unit: xUnit / NUnit
- Mocks: Moq
- Time: TimeProvider
- Integration deps: Testcontainers for .NET
- Property-based: FsCheck
- Mutation: Stryker.NET
- Browser/E2E: Playwright for .NET

### Go

- Unit: stdlib `testing` (+ `t.Parallel`)
- Mocks: gomock
- Integration deps: testcontainers-go
- Property-based: rapid (or stdlib `testing/quick`)
- Mutation: go-mutesting
- Browser: chromedp (CDP)

### Rust

- Unit/integration: `cargo test`
- Property-based: quickcheck, proptest
- Mutation: cargo-mutants
- Browser/WebDriver: thirtyfour

## Decompile / loss-check (compression integrity)

Recovered topics preserved in this skill:

- Unit definition + tests as contracts/oracles.
- Determinism, hermeticity, explicit dependencies.
- AAA/GWT, naming conventions, and one-behavior tests.
- Full nondeterminism controls (time/timers/RNG/concurrency/IO/env/external/locale+floats/rendering).
- Test double guidance with state vs interaction distinction.
- Anti-patterns list.
- Snapshot/visual baseline rules.
- Test portfolio across unit/integration/contract/E2E/visual/property-based/mutation.
- CI integrity rules and dependency locking guidance across ecosystems.
- Failure decision procedure for not weakening tests.
- Review checklist.
- Tooling map across JVM/JS/Python/.NET/Go/Rust.
- Explicit note of intentional removals (only citations/examples/diagrams trimmed; rules retained).
