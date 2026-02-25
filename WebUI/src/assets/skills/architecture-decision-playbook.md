# Skill: Architecture Decision Playbook (multi-language, ~95% use cases)

## GOAL

Given a product and constraints, choose sane default architecture + evolution paths across common stacks (C/C++, Swift, Kotlin, Web FE, Node.js, C#/.NET, PHP, and common workflow languages).

This doc is **architecture-only** (not implementation style).

## EVAL AXES (use for every decision)

- DeployTarget: `embedded/baremetal`, `mobile/desktop client`, `browser FE`, `server/backend`, `edge`
- LatencyCritical: `yes/no`
- Statefulness: `stateless/stateful`
- ConcurrencyModel: `event-loop`, `threads`, `async/await`, `actor`, `RTOS`
- TeamTopology: `1 team` or `multi-team`
- ReleaseIndependence: `needed/not`
- SecurityPosture: `normal` or `high-reg/audit` (identity-first)
- DataConsistencyNeed: `strong/ACID`, `mixed`, `eventual ok`
- WorkloadShape: `steady` or `bursty/event-triggered`
- OpsMaturity: `low`, `medium`, `high` (CI/CD, observability, incident response)
- CostSensitivity: `low`, `med`, `high`

## GLOBAL PRINCIPLES (default until disproven)

1. **P0**: Optimize for clear boundaries, evolvable deployment, and observability.
2. **P1**: Prefer boring, standard integration and operations; avoid novelty unless justified.
3. **P2**: Distributed systems have real tax—don’t pay it early.

## DEFAULT ARCH (sensible default for most products)

- **A0**: Modular monolith (single deploy unit) with hard module boundaries
- **A1**: Clean/Hexagonal architecture (core domain/application, infra at edges via ports/adapters)
- **A2**: One relational DB as system of record, kept behind domain boundary
- **A3**: Async edges with background workers + queues/events for slow/decoupled flows
- **A4**: Observability and security as architectural requirements, not afterthoughts

## WHEN TO SWITCH ARCHITECTURE

### Microservices (only when triggers hold)

Use microservices only if all are true:

- Multi-team autonomy is required
- Bounded contexts are clear
- Independent deploy/scale/isolation is necessary for blast-radius control
- Operations platform is mature enough (discovery, CI/CD automation, tracing, policy, secrets, incident response)

Otherwise stay with a modular monolith and extract services later when boundaries are proven.

### Serverless / Event-based compute

Use serverless/event pipeline when:

- Workload is bursty or event-triggered
- Pay-per-use + managed scaling is a net benefit
- Team accepts managed-runtime constraints and tradeoffs (cold starts, limits)

Design note: use durable queues between stages for backpressure.

### CQRS / Event Sourcing

Adopt only when there is:

- A real need for separate read/write models
- Audit/time-travel/history requirements
- Complex read scaling that justifies added complexity

Otherwise default CRUD + async events.

## INTEGRATION PRIMITIVES (use a small standard set)

- HTTP REST for compatibility and cache semantics
- gRPC for strict internal service contracts and performance
- GraphQL for complex client-driven query needs
- Async messaging/streaming for decoupling and backpressure
- Common event envelope (CloudEvents-style) for interoperability

## DATA ARCHITECTURE RULES

- Make consistency trade-offs explicit (distributed consistency is not free).
- Avoid distributed transactions; use domain events + eventual consistency where acceptable.
- If global strong consistency is required, accept added complexity/cost and operational discipline.

## SECURITY ARCHITECTURE (default posture)

- Identity-centric, zero-trust mindset
- Continuous verification, least privilege, policy enforcement
- OAuth2 for delegated auth, JWT for compact claims
- OpenAPI for HTTP API contracts (shared schema + tooling)

## OBSERVABILITY (mandatory baseline)

- Instrument traces, metrics, and logs with correlation IDs/context propagation
- Prefer OpenTelemetry semantics

## DEPLOYMENT DEFAULTS

- Start with simplest viable: single deployable artifact (artifact/VM/PaaS).
- Add containers/Kubernetes only when orchestration and scale automation justify it.
- Twelve-factor posture: externalized config, stateless processes, event-stream logs, disposability.

## DECISION TREE (compressed)

1. If `DeployTarget=embedded`: layered `HAL → middleware → app`, with event loop or RTOS tasks/queues.
2. If `DeployTarget=mobile/desktop`: layered client (`UI state ↔ domain ↔ data/services`).
3. If `DeployTarget=browser FE`: use SSR/SSG hybrid when SEO/first-load is critical, else SPA.
4. If `DeployTarget=server/backend`:
   - Use modular monolith + Clean/Hex when one team or unclear boundaries.
   - Use microservices when multi-team + stable bounded contexts + sufficient operations maturity.
5. If `WorkloadShape=bursty/event`: consider serverless/event pipeline with queues.
6. If `SecurityPosture=high`: enforce zero-trust + auditability + stronger observability.

---

## ECOSYSTEM PLAYBOOKS (format: Typical Apps / Default Arch / Deviate When / Notes)

### C (embedded/firmware/RTOS)

- Typical: MCU firmware, drivers, RTOS apps, safety/auto ECUs
- Default: Layered `HAL → middleware → app`, state machines/event loop; RTOS tasks/queues for timing and concurrency
- Deviate when: AUTOSAR-style layering for automotive/safety; stricter partitioning for hard real-time
- Notes: OTA updates and fault recovery are required; constrained telemetry/logging; persistent state via flash/EEPROM; HAL seams support simulation/HIL

### C++

- Typical: systems, games, finance, compute, embedded
- Default: Modular monolith + strong component/library boundaries + ports/adapters on volatile edges
- Deviate when: multi-team independent delivery or hard isolation requires services; internal RPC often gRPC
- Notes: keep hot-path state in-process; distributed deployments add observability and latency overhead

### Swift

- Typical: iOS/iPadOS/macOS
- Default: SwiftUI apps use state/data-flow layering (MVVM/UDF-ish); UIKit/AppKit use disciplined MVC with domain boundary
- Deviate when: complexity increases (stronger feature modules, richer domain layer)
- Notes: offline-first and secure local storage are architectural; stable backend contracts via OpenAPI/GraphQL

### Kotlin

- Typical: Android apps, JVM services (Spring/Ktor), multiplatform sharing
- Default: Android layered UI + data (+ optional domain); server modular monolith with clean boundaries
- Deviate when: lightweight async services (Ktor/coroutines) or team-scale extraction
- Notes: coroutines scale I/O but do not erase distributed complexity; shared models/validation via multiplatform when useful

### Rust

- Typical: high-assurance components, network services, embedded
- Default: Modular monolith with crate boundaries, ports/adapters, async runtime for network services
- Deviate when: actor model for isolated state concurrency or justified microservice split
- Notes: safety/perf bias; containerization works well; distributed split still carries ops burden

### Web Front-End (JS/TS)

- Typical: SPA, SSR/SSG, hybrid apps
- Default: component architecture + explicit state boundaries
- Rendering:
  - SEO/content/performance critical: SSR/SSG hybrid meta-framework
  - App-like with lower SEO needs: SPA
- Deviate when: micro-frontends for very large organizational boundaries
- Notes: keep server state on server; cache with CDN and SSG; FE observability should include perf/errors and trace correlation

### Node.js

- Typical: APIs, BFF, real-time/event-driven services
- Default: modular monolith with event-driven I/O
- Deviate when: CPU-heavy workloads (worker threads/processes or separate service), justified microservices/serverless
- Notes: avoid blocking event loop; use async messaging; contract-first APIs

### C# /.NET

- Typical: enterprise backends, internal platforms, cloud services
- Default: Clean Architecture modular monolith with domain/application core and infra adapters
- Deviate when: bounded contexts + multi-team independence
- Notes: REST/OpenAPI externally, gRPC internally, OTel tracing; domain events to avoid distributed transactions

### PHP (Laravel/Symfony)

- Typical: web apps, CMS, APIs
- Default: framework-structured modular monolith leveraging DI/container conventions
- Deviate when: clear isolation needs or larger organizational boundaries demand services
- Notes: stateless scaling; sessions kept out-of-process; request lifecycle/event-driven patterns available

### Java

- Typical: enterprise services and platforms
- Default: modular monolith + DI + clean boundaries (Spring Boot style)
- Deviate when: bounded-context-driven independent delivery requires microservices; event streaming for EDA
- Notes: containerized or serverless handlers; same ops principles always apply

### Python

- Typical: web apps (Django), APIs (FastAPI), automation/data workers (Celery)
- Default: modular monolith with background workers over broker
- Deviate when: API-first high-throughput service needs, or async for I/O hotspots
- Notes: keep strong boundaries; enable OTel when distribution/async complexity grows

### Go

- Typical: cloud services, infra tooling, high-concurrency servers
- Default: modular monolith/service with explicit interfaces and goroutines/channels
- Deviate when: organization-level microservices are justified (toolkit patterns like go-kit, gRPC)
- Notes: propagate context for cancellation and tracing; standard HTTP/gRPC

### Other common workflow ecosystems

- **TypeScript**: architecture enabler via typed boundaries/contracts; otherwise follow Web FE + Node defaults
- **Ruby on Rails**: best as modular monolith under conventions; extract services only when forced
- **Dart/Flutter**: layered presentation/state/data; predictable state flow
- **Erlang/Elixir**: actor/message-driven with supervision; isolated state in processes/actors; integrate via ports/adapters/events
- **Scala**: JVM modular monolith or actor/message-driven (Akka-style) where it fits

## PRIMARY REFERENCES (names only)

AWS Well-Architected pillars; Azure Well-Architected pillars; Google Cloud Architecture Framework; Twelve-Factor App; Hexagonal (Ports & Adapters); Clean Architecture guidance (.NET); Microservices trade-offs (Fowler); REST dissertation (Fielding); gRPC docs + Protocol Buffers; GraphQL specification; CloudEvents; Kafka docs; Zero-Trust Architecture (NIST); OpenTelemetry concepts/specs; CAP theorem (Gilbert/Lynch); Spanner paper; Android architecture guide; SwiftUI data flow; Spring Boot docs; Laravel/Symfony architecture docs; Django docs; Go tour (concurrency); Ktor/Kotlin server docs
