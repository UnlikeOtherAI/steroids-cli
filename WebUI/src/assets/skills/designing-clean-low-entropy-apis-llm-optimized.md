# SKILL: Designing Clean, Low-Entropy APIs (LLM-Optimized)

Version: 1.0  
Audience: API designers, backend engineers, platform architects, AI tool builders  
Philosophy: Consistency > Cleverness. Standards > Custom. Contracts > Tribal Knowledge.

---

# 0. Definition: What Is a “Clean API”?

A clean API is:

- Predictable
- Idempotent
- Contract-first
- Backwards-compatible
- Machine-parseable
- Retry-safe
- Observability-aware
- Governed by standards, not opinions

A clean API minimizes entropy across:

- Naming
- Error formats
- Versioning
- Pagination
- Filtering
- Lifecycle behavior
- Retry semantics

---

# 1. Foundational Principles

## 1.1 Contract First (Mandatory)

Every API MUST:

- Be defined in OpenAPI 3.1 (HTTP)
- Use JSON Schema 2020-12
- Be linted in CI
- Block breaking changes automatically

For event systems:

- Use AsyncAPI
- Use CloudEvents envelope

For gRPC:

- Use Protobuf with Buf breaking checks

Never design implementation-first and document later.

---

## 1.2 Resource-Oriented Design

Default: RESTful resource modeling.

Rules:

- Collections are plural nouns
- Resources are nouns
- HTTP methods express verbs
- No verbs in paths (except structured custom actions)

Correct:

```text
GET    /users
GET    /users/{id}
POST   /users
PATCH  /users/{id}
DELETE /users/{id}
```

Wrong:

```text
POST /createUser
POST /deleteUser
```

---

## 1.3 Naming Rules (Non-Negotiable)

Paths:
- kebab-case
- plural collections

JSON fields:
- lowerCamelCase

Query parameters:
- lowerCamelCase

Timestamps:
- RFC3339 format
- Always UTC

Never mix naming conventions.

---

# 2. HTTP Semantics Discipline

## 2.1 Method Semantics

GET:
- Safe
- Idempotent

PUT:
- Idempotent (full replacement)

DELETE:
- Idempotent

POST:
- Must support idempotency keys

PATCH:
- Must support idempotency keys

If POST/PATCH cannot be retried safely → design is incomplete.

---

## 2.2 Idempotency (Required for Write Operations)

All write operations MUST be retry-safe.

Implementation:

Header:

```text
Idempotency-Key: <uuid-v4>
```

Server guarantees:

- Same key → same status + same body
- Dedup window documented (e.g., 24h)

LLM Rule:
If retrying → reuse same key.

---

# 3. Error Handling (Strict Standardization)

## 3.1 Mandatory Format

Use RFC 9457 Problem Details.

Content-Type:

```text
application/problem+json
```

Structure:

```json
{
  "type": "https://api.example.com/problems/validation-failed",
  "title": "Validation failed",
  "status": 400,
  "detail": "One or more fields are invalid.",
  "instance": "/orders",
  "errorCode": "badRequest",
  "errors": [
    { "field": "customerId", "code": "missing" }
  ]
}
```

Rules:

- `errorCode` must remain stable across versions
- Detailed codes go inside `errors`
- Include trace ID

Never invent ad-hoc error shapes.

---

## 3.2 Status Code Discipline

Use only standard HTTP codes.

429:

- Must include Retry-After when possible

4xx:

- Client correctable

5xx:

- Server fault

Never return 200 with embedded error state.

---

# 4. Pagination (From Day One)

Adding pagination later is a breaking change.

Default: Cursor-based pagination.

Request:

```text
GET /orders?limit=50&cursor=abc123
```

Response:

```json
{
  "data": [...],
  "nextCursor": "xyz456"
}
```

Rules:

- Never return unbounded arrays
- nextCursor must be opaque
- Document stability guarantees

LLM rule:
Loop until nextCursor is null.

---

# 5. Filtering

Preferred pattern:

```text
GET /orders?filter=status="PAID" AND total>100
```

Rules:

- Single `filter` parameter
- Typed fields only
- Grammar documented
- Version filter language intentionally

Avoid parameter sprawl:

Bad:

```text
?status=paid&minTotal=100&maxTotal=500
```

---

# 6. Versioning Strategy

Preferred (public APIs):

Header-based versioning:

```text
API-Version: 2026-02-01
```

or date-pinned header like Stripe.

Fallback:

Path major version:

```text
/v1/users
```

Never mix versioning mechanisms.

---

# 7. Deprecation and Sunset (Machine-Readable)

When deprecating:

Add header:

```text
Deprecation: true
Sunset: Wed, 01 Dec 2026 00:00:00 GMT
Link: <https://docs.example.com/migration>; rel="deprecation"
```

Lifecycle:

1. Ship replacement
2. Mark deprecated
3. Announce sunset
4. Enforce shutdown

Never silently change behavior.

---

# 8. Security Baseline

Transport:

- TLS 1.3 minimum

Authentication:

- OAuth 2.x
- Short-lived tokens
- PKCE for public clients

Service-to-service:

- mTLS preferred

JWT:

- Follow RFC 8725 best practices
- Never trust unsigned tokens

Authorization:

- Enforce object-level checks
- Never rely solely on gateway filtering

---

# 9. Rate Limiting and Retry Contract

On 429:

- Respect Retry-After

Retryable errors:

- Clearly documented
- SDKs enforce backoff with jitter

Never leave retry behavior undefined.

---

# 10. Observability Requirements

All APIs must:

- Propagate W3C trace context
- Include trace ID in error responses
- Log idempotency keys
- Emit structured logs

LLMs must surface trace ID when reporting failure.

---

# 11. gRPC Clean Patterns

- Use requestId for idempotency
- Enforce protobuf evolution rules
- Never reuse field numbers
- Never remove fields without version bump
- Use canonical gRPC status codes

Use Buf to block breaking changes.

---

# 12. Event-Driven Clean Patterns

Use CloudEvents envelope:

```json
{
  "specversion": "1.0",
  "type": "com.example.order.created",
  "source": "/orders-service",
  "id": "uuid",
  "time": "2026-02-21T12:34:56Z",
  "datacontenttype": "application/json",
  "data": { ... }
}
```

Rules:

- `id + source` must be unique
- Version event schemas explicitly
- Use AsyncAPI contract

Never publish undocumented event shapes.

---

# 13. API Gateway Architecture

Responsibilities:

- TLS termination
- Authentication
- Rate limiting
- Observability
- Response normalization

Never:

- Rewrite business logic
- Introduce divergent error formats

---

# 14. Breaking Change Policy

Breaking changes include:

- Removing fields
- Changing types
- Tightening validation
- Changing semantics

CI must block:

- OpenAPI breaking diffs
- Protobuf breaking diffs
- Schema incompatibilities

---

# 15. LLM Interaction Rules

When consuming an API:

1. Always consult OpenAPI spec.
2. Always send idempotency key for POST/PATCH.
3. Respect Retry-After.
4. Paginate fully unless instructed otherwise.
5. Surface trace IDs in failures.
6. Never assume undocumented behavior.

---

# 16. Anti-Patterns (Never Do These)

❌ Verbs in paths
❌ Multiple error formats
❌ Offset pagination on volatile datasets
❌ Unbounded list responses
❌ Breaking changes without version bump
❌ Silent behavior changes
❌ Retrying POST without idempotency key
❌ Returning 200 with error payload

---

# 17. Clean API Governance Stack

Mandatory Tooling:

- OpenAPI 3.1
- Spectral linting
- OpenAPI diff checker
- Buf (for gRPC)
- Contract tests (CDC)
- CI enforcement

Optional but recommended:

- SDK auto-generation
- API style rule enforcement
- Semantic version registry

---

# 18. Golden Rule

If a generic client cannot:

- Retry safely
- Paginate safely
- Parse errors generically
- Detect deprecation automatically

Then the API is not clean.

---

# END OF SKILL
