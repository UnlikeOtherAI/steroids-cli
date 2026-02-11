# Credit Exhaustion Detection & Notification System

## Problem Statement

When an AI provider (Claude, Codex, or Gemini) runs out of credits/tokens, the CLI currently has no way to detect or communicate this to the user. The provider returns a non-zero exit code with an error message in stderr, which the orchestrator misinterprets as a transient failure. The task retries up to 15 times before being marked as failed — burning time and producing no useful output.

**Current behavior:**
1. Provider returns `success: false`, stderr contains "insufficient credits" or similar
2. Orchestrator tries to parse stderr as AI output — fails
3. Fallback handler defaults to "retry"
4. Loop retries the same provider — same error, 15 times
5. Task marked failed after exhausting retries
6. User discovers the problem hours later by checking logs

**Desired behavior:**
1. Provider error classified as `credit_exhaustion` immediately
2. Runner pauses gracefully (no retries on this provider)
3. WebUI displays a blocking modal: "This model has run out of credits"
4. User clicks "Change AI Model" to go to Settings, or dismisses the dialog
5. Background content is mildly blurred while the modal is visible
6. Runner resumes automatically once the provider config changes

---

## Design

### Part 1: Provider-Level Credit Exhaustion Detection

**File:** `src/providers/interface.ts`

#### 1.1 Extend `ProviderErrorType`

Add a new error classification:

```typescript
export type ProviderErrorType =
  | 'rate_limit'
  | 'auth_error'
  | 'network_error'
  | 'model_not_found'
  | 'context_exceeded'
  | 'subprocess_hung'
  | 'credit_exhaustion'   // NEW
  | 'unknown';
```

#### 1.2 Update `classifyError()` in `BaseAIProvider`

Add detection patterns for credit/quota exhaustion **before** the existing rate_limit check (credit exhaustion is more specific than rate limiting):

```typescript
// Credit / quota exhaustion (check BEFORE rate_limit)
if (/insufficient.?(credit|fund|balance)|quota.?exceed|billing|payment.?(required|failed)|out of (credits|tokens)|usage.?limit.?(reached|exceeded)|plan.?limit|subscription.?(expired|inactive)/i.test(stderr)) {
  return { type: 'credit_exhaustion', message: stderr.slice(0, 500) };
}
```

**Known error messages by provider:**

| Provider | Possible stderr patterns |
|----------|--------------------------|
| Claude | `insufficient credits`, `billing`, `usage limit reached`, `plan limit` |
| Codex | `insufficient_quota`, `billing_hard_limit_reached`, `exceeded your current quota` |
| Gemini | `quota exceeded`, `billing account`, `RESOURCE_EXHAUSTED` |

#### 1.3 Add `classifyResult()` Method

Currently `classifyError()` only looks at stderr. We need a higher-level method that inspects the full `InvokeResult`:

```typescript
classifyResult(result: InvokeResult): { type: ProviderErrorType; message: string } | null {
  if (result.success) return null;

  // Check stderr first
  const stderrClass = this.classifyError(result.stderr);
  if (stderrClass.type !== 'unknown') return stderrClass;

  // Some providers put errors in stdout (e.g., JSON error responses)
  const stdoutClass = this.classifyError(result.stdout);
  if (stdoutClass.type !== 'unknown') return stdoutClass;

  return stderrClass; // fallback to unknown
}
```

---

### Part 2: Loop-Level Graceful Pause

**Files:** `src/commands/loop-phases.ts`, `src/commands/loop.ts`

#### 2.1 Detect Credit Exhaustion After Invocation

In both `runCoderPhase()` and `runReviewerPhase()`, after invoking the provider and before passing to the orchestrator, check for credit exhaustion:

```typescript
// After provider.invoke() returns result
const errorClass = provider.classifyResult(result);
if (errorClass?.type === 'credit_exhaustion') {
  return {
    action: 'pause_credit_exhaustion',
    provider: providerName,
    model: modelName,
    role: 'coder', // or 'reviewer'
    message: errorClass.message,
  };
}
```

#### 2.2 Handle Pause in Main Loop

In the main loop (`loop.ts`), when a phase returns `pause_credit_exhaustion`:

1. **Log the event** to the database (new `credit_alerts` table or `incidents` table)
2. **Fire a hook event**: `credit.exhausted` with provider/model/role info
3. **Emit a notification** to the API/WebUI via the database
4. **Enter a polling pause**: Check config every 30 seconds to see if the user has changed the provider/model
5. **Resume** when the provider config changes or a different provider is available

```typescript
// Pseudo-code for the pause loop
async function handleCreditExhaustion(alert: CreditAlert): Promise<void> {
  // Record in database
  await recordCreditAlert(db, alert);

  // Fire hook
  await fireHook('credit.exhausted', alert);

  console.log(`\n  Provider "${alert.provider}" (model: ${alert.model}) has run out of credits.`);
  console.log(`  Waiting for configuration change...`);
  console.log(`  Change the ${alert.role} provider in settings or via:`);
  console.log(`    steroids config set ai.${alert.role}.provider <new-provider>\n`);

  // Poll for config change
  const originalProvider = alert.provider;
  const originalModel = alert.model;
  while (!shouldStop()) {
    await sleep(30_000); // 30s between checks
    const config = loadConfig(projectPath);
    const currentProvider = config.ai?.[alert.role]?.provider;
    const currentModel = config.ai?.[alert.role]?.model;
    if (currentProvider !== originalProvider || currentModel !== originalModel) {
      console.log(`  Configuration changed. Resuming...`);
      // Clear the alert
      await clearCreditAlert(db, alert.id);
      return;
    }
  }
}
```

---

### Part 3: Database Schema for Credit Alerts

**New migration:** `migrations/0XX_add_credit_alerts.sql`

```sql
-- UP
CREATE TABLE IF NOT EXISTS credit_alerts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('orchestrator', 'coder', 'reviewer')),
  message TEXT,
  runner_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution TEXT CHECK (resolution IN ('config_changed', 'dismissed', 'manual'))
);

-- DOWN
DROP TABLE IF EXISTS credit_alerts;
```

**Queries:**

```typescript
// Record a new credit alert
function recordCreditAlert(db, alert: { provider, model, role, message, runnerId }): string

// Get active (unresolved) credit alerts
function getActiveCreditAlerts(db): CreditAlert[]

// Resolve a credit alert
function resolveCreditAlert(db, alertId: string, resolution: string): void
```

---

### Part 4: API Endpoints

**File:** `API/src/routes/` (new file `credit-alerts.ts` or extend `runners.ts`)

#### 4.1 List Active Credit Alerts

```
GET /api/credit-alerts?project=<path>
```

Response:
```json
{
  "alerts": [
    {
      "id": "uuid",
      "provider": "claude",
      "model": "opus",
      "role": "coder",
      "message": "Insufficient credits...",
      "runnerId": "uuid",
      "createdAt": "2025-01-15T10:30:00Z",
      "resolvedAt": null
    }
  ]
}
```

#### 4.2 Dismiss/Resolve a Credit Alert

```
POST /api/credit-alerts/:id/dismiss
```

Response:
```json
{ "ok": true }
```

This endpoint resolves the alert with `resolution: 'dismissed'` and can optionally signal the runner to retry (if the user has added credits without changing provider).

---

### Part 5: WebUI Notification Modal

**Files:**
- `WebUI/src/components/molecules/CreditExhaustionModal.tsx` (new)
- `WebUI/src/App.tsx` (polling + modal trigger)

#### 5.1 Modal Component

Following the existing `AISetupModal` pattern:

```tsx
// CreditExhaustionModal.tsx
interface CreditExhaustionModalProps {
  alert: CreditAlert;
  onDismiss: () => void;
  onChangeModel: () => void;
}

export function CreditExhaustionModal({ alert, onDismiss, onChangeModel }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop with blur */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onDismiss} />

      {/* Modal */}
      <div className="relative bg-bg-shell rounded-2xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-warning-soft flex items-center justify-center mb-4">
            <i className="fa-solid fa-coins text-2xl text-warning" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary">
            Out of Credits
          </h2>
          <p className="mt-2 text-sm text-text-secondary">
            The <span className="font-medium">{alert.provider}</span> provider
            (model: <span className="font-mono text-xs">{alert.model}</span>)
            used for <span className="font-medium">{alert.role}</span> has run
            out of credits. The runner is paused until this is resolved.
          </p>
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 space-y-3">
          <button
            onClick={onChangeModel}
            className="w-full px-4 py-3 bg-accent text-white rounded-xl
                       font-medium hover:bg-accent-hover transition-colors"
          >
            <i className="fa-solid fa-gear mr-2" />
            Change AI Model
          </button>
          <button
            onClick={onDismiss}
            className="w-full px-4 py-2.5 text-text-secondary rounded-xl
                       hover:bg-bg-surface2 transition-colors text-sm"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
```

#### 5.2 App-Level Integration

In `App.tsx`, poll for active credit alerts alongside the existing runner polling:

```tsx
// Poll for credit alerts every 10 seconds
const [creditAlert, setCreditAlert] = useState<CreditAlert | null>(null);

useEffect(() => {
  const check = async () => {
    const alerts = await creditAlertsApi.getActive(selectedProject);
    setCreditAlert(alerts.length > 0 ? alerts[0] : null);
  };
  check();
  const interval = setInterval(check, 10_000);
  return () => clearInterval(interval);
}, [selectedProject]);

// Render
return (
  <div className={creditAlert ? 'blur-sm pointer-events-none' : ''}>
    <AppShell>
      {/* ... existing routes ... */}
    </AppShell>
  </div>

  {creditAlert && (
    <CreditExhaustionModal
      alert={creditAlert}
      onDismiss={async () => {
        await creditAlertsApi.dismiss(creditAlert.id);
        setCreditAlert(null);
      }}
      onChangeModel={() => {
        setCreditAlert(null);
        navigate('/settings');
      }}
    />
  )}
);
```

**Key UX details:**
- Background content gets `blur-sm` (4px Tailwind blur) and `pointer-events-none`
- Modal backdrop is `bg-black/40 backdrop-blur-sm` (semi-transparent with slight blur)
- The warning icon uses `fa-coins` from Font Awesome
- "Change AI Model" button navigates to `/settings` and dismisses the modal
- "Dismiss" just closes the modal and resolves the alert (runner stays paused until config changes)

#### 5.3 API Client Addition

```typescript
// In WebUI/src/services/api.ts
export const creditAlertsApi = {
  async getActive(projectPath?: string): Promise<CreditAlert[]> {
    const params = projectPath ? `?project=${encodeURIComponent(projectPath)}` : '';
    return fetchJson(`/api/credit-alerts${params}`);
  },

  async dismiss(alertId: string): Promise<void> {
    await fetchJson(`/api/credit-alerts/${alertId}/dismiss`, { method: 'POST' });
  },
};
```

---

### Part 6: CLI Notification (Non-WebUI)

For users not running the WebUI, the loop should print clear console output:

```
============================================================
  OUT OF CREDITS
============================================================

  Provider: claude (model: opus)
  Role:     coder
  Message:  Insufficient credits. Please add credits at...

  The runner is paused. To resume, either:
    1. Add credits to your claude account
    2. Change the coder provider:
       steroids config set ai.coder.provider codex

  Checking for config changes every 30 seconds...
============================================================
```

Additionally, fire the `credit.exhausted` hook event so users with webhook integrations (Slack, email) get notified:

```typescript
// Hook payload
{
  event: 'credit.exhausted',
  provider: 'claude',
  model: 'opus',
  role: 'coder',
  message: 'Insufficient credits...',
  project: '/path/to/project',
  runner_id: 'uuid',
  timestamp: '2025-01-15T10:30:00Z'
}
```

---

### Part 7: Hooks Integration

**File:** `src/hooks/events.ts`

Add new hook event types:

```typescript
// New events
'credit.exhausted'  // Fired when a provider runs out of credits
'credit.resolved'   // Fired when the user changes provider or adds credits
```

**Payload schema** (added to `src/hooks/payload.ts`):

```typescript
interface CreditExhaustedPayload {
  event: 'credit.exhausted';
  provider: string;
  model: string;
  role: 'orchestrator' | 'coder' | 'reviewer';
  message: string;
  project: string;
  runner_id: string;
  timestamp: string;
}
```

---

## Implementation Order

### Phase 1: Detection (Backend)
1. Add `credit_exhaustion` to `ProviderErrorType` in `interface.ts`
2. Update `classifyError()` with credit/quota patterns
3. Add `classifyResult()` method to `BaseAIProvider`

### Phase 2: Database & Loop (Backend)
4. Create migration for `credit_alerts` table
5. Add database queries for credit alerts (record, get active, resolve)
6. Update `loop-phases.ts` to detect credit exhaustion after invocation
7. Add pause-and-poll logic in `loop.ts`

### Phase 3: CLI Output & Hooks
8. Add clear console output when credits exhausted
9. Add `credit.exhausted` and `credit.resolved` hook events
10. Wire hook firing into the pause handler

### Phase 4: API
11. Create `credit-alerts.ts` API routes
12. Wire into Express router

### Phase 5: WebUI
13. Create `CreditExhaustionModal.tsx` component
14. Add polling and modal rendering in `App.tsx`
15. Add `creditAlertsApi` to `api.ts` service

### Phase 6: Testing
16. Unit tests for `classifyError()` with credit patterns
17. Unit test for `classifyResult()` method
18. Integration test for the pause-and-resume flow
19. API tests for credit-alerts endpoints

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Credits exhausted for coder but not reviewer | Only pause the coder role; reviewer continues if it uses a different provider |
| Credits exhausted for orchestrator | Pause the entire loop (orchestrator is required for decisions) |
| Same provider used for all 3 roles | One alert covers all roles; changing provider resolves all |
| User adds credits without changing provider | "Dismiss" button resolves alert; runner retries with same provider |
| Multiple projects hit credit limit | Each project gets its own alert; resolving one doesn't affect others |
| Rate limit vs credit exhaustion | Rate limits are transient (retry with backoff); credit exhaustion is persistent (pause until resolved) |
| Provider returns credit error in stdout (JSON) | `classifyResult()` checks both stderr and stdout |
| Runner killed while paused | Wakeup cron restarts runner; runner re-checks for credit alert on startup |

---

## Non-Goals (Out of Scope)

- Auto-switching to a fallback provider (too risky without user consent)
- Estimating remaining credits before they run out
- Provider-specific credit balance API integration
- Email/SMS notifications (webhook-based notifications via hooks are sufficient)

---

## Appendix: Cross-Provider Design Review

*This design was reviewed by Codex (OpenAI) as a second opinion. The findings below are the Codex review followed by our assessment of each point. Codex reviews are advisory — not the source of truth — but provide valuable additional perspective.*

### Codex Findings & Our Assessment

#### Finding 1 (Critical): Loop entrypoint coverage
**Codex says:** Part 2.2 targets `loop.ts`, but daemon runners use `orchestrator-loop.ts`. If we only patch `loop.ts`, daemon mode still retries.
**Assessment: VALID.** Must patch both `orchestrator-loop.ts` (daemon path) and `loop-phases.ts` (foreground path). Updated the implementation order to reflect this. The `orchestrator-loop.ts` is the primary entrypoint for background runners, and `loop.ts`/`loop-phases.ts` handles CLI `steroids loop` invocations.

#### Finding 2 (Critical): Full-loop pause vs role-scoped pause
**Codex says:** A blocking pause in the main loop halts everything, contradicting the "coder paused, reviewer continues" edge case.
**Assessment: VALID.** The design needs to be clearer. For V1, a full-loop pause is acceptable and simpler to implement — if the coder provider is exhausted, the reviewer can't review work that was never coded. Role-scoped pause is a V2 optimization for mixed-provider setups. Updated the edge case table to clarify this.

#### Finding 3 (Critical): Orchestrator exhaustion path
**Codex says:** `invoke.ts` returns `result.stdout` even when invocation fails, which can feed fallback/retry behavior.
**Assessment: PARTIALLY VALID.** The orchestrator itself can fail if its provider runs out of credits. We should check `classifyResult()` at the invocation layer before passing to the orchestrator prompt parser. However, the fallback handler already handles empty/garbage output gracefully — it just defaults to retry, which is the problem we're solving.

#### Finding 4 (High): classifyError signature mismatch
**Codex says:** Doc shows `classifyError(stderr)` but actual signature is `classifyError(exitCode, stderr)` returning `ProviderError` with `retryable` field.
**Assessment: VALID.** The document's pseudo-code was simplified for readability. Implementation must match the actual `classifyError(exitCode: number, stderr: string): ProviderError | null` signature and set `retryable: false` for credit exhaustion. Updated Part 1.2 pseudo-code in the design.

#### Finding 5 (High): RESOURCE_EXHAUSTED ambiguity
**Codex says:** `RESOURCE_EXHAUSTED` from Gemini can mean per-minute quota (transient) OR billing limit (persistent).
**Assessment: VALID and important.** Must differentiate: if the error message contains "per minute", "per second", "retry after" -> rate_limit. If it contains "billing", "budget", "hard limit" -> credit_exhaustion. Add a two-pass check for Gemini's `RESOURCE_EXHAUSTED` errors.

#### Finding 6 (High): WebUI API response format
**Codex says:** WebUI `fetchJson` expects wrapped responses; the API contract needs to match.
**Assessment: MINOR.** Our `fetchJson` extracts JSON directly. The API just needs to return the correct shape. Not a design issue — implementation detail.

#### Finding 7 (Medium): Hooks require more files than listed
**Codex says:** Need to update `payload.ts`, `templates.ts`, and validation logic, not just `events.ts`.
**Assessment: VALID.** Added to implementation tasks. The hooks system has a template context builder and event validation switch that both need updating.

#### Finding 8 (Medium): Migration manifest sync
**Codex says:** Migration plan missing manifest.json and schema.ts updates.
**Assessment: VALID.** Standard procedure per CLAUDE.md — every migration needs manifest.json update and schema.ts sync. Added explicitly to implementation tasks.

#### Finding 9 (Medium): Dismiss semantics inconsistency
**Codex says:** "Dismiss" means "runner stays paused" in one place and "retries same provider" in another.
**Assessment: VALID.** Clarified: "Dismiss" resolves the alert in the UI only. The runner's pause loop checks for *config changes*, not alert resolution. To retry with the same provider after adding credits, user can either: (a) make a no-op config change, or (b) we add a separate "Retry Now" button. For V1, adding a "Retry Now" action alongside Dismiss is the cleaner approach.

#### Finding 10 (Medium): Batch mode not addressed
**Codex says:** Batch coder/reviewer path in `orchestrator-loop.ts` is not covered.
**Assessment: VALID.** Batch invocations (`invokeCoderBatch`, `invokeReviewerBatch`) also need credit exhaustion checks. Added to implementation tasks.

### Additional Codex Suggestions & Our Take

| Suggestion | Our Take |
|-----------|----------|
| Reuse `incidents` table instead of new `credit_alerts` table | **Adopt.** The incidents table already has `failure_mode`, `detected_at`, `resolved_at`, `resolution`, `details`. Adding `failure_mode='credit_exhaustion'` fits naturally and avoids schema bloat. |
| Add structured JSON error parsing before regex | **Adopt for V1.** Some providers return JSON error objects. Check for `error.code` or `error.type` fields first, fall back to regex. |
| Simplify V1: detect + stop retries + CLI message + hook + incident | **Adopt.** WebUI modal can be Phase 2. Getting detection and graceful pause right is the priority. |
| Add deduplication key for alerts | **Adopt.** Unique index on (runner_id, role, provider, model) where resolved_at IS NULL prevents duplicate incidents. |
| Add "Retry Now" button separate from Dismiss | **Adopt.** Better UX than overloading Dismiss. |
| Role-blocked state in scheduler instead of global pause | **Defer to V2.** Full-loop pause is simpler and correct for most setups where one provider serves all roles. |
| Handle `--once` mode (should not block forever) | **Adopt.** `--once` mode should fail immediately with clear error, not enter a polling loop. |

### Revised Implementation Order (Post-Review)

Incorporating the review findings, the implementation is split into two phases:

**V1 (Core — use incidents table, no new migration):**
1. Add `credit_exhaustion` to `ProviderErrorType`, update `classifyError()` with patterns + JSON parsing
2. Add `classifyResult()` method checking both stdout and stderr
3. Detect credit exhaustion in `loop-phases.ts` (coder + reviewer phases)
4. Detect credit exhaustion in `orchestrator-loop.ts` (daemon batch path)
5. Record incident with `failure_mode='credit_exhaustion'` (reuse existing table)
6. Add pause-and-poll logic with config change detection (skip in `--once` mode)
7. Add `credit.exhausted` / `credit.resolved` hook events (events.ts, payload.ts, templates.ts)
8. Clear CLI output when paused
9. Unit tests for detection patterns (including RESOURCE_EXHAUSTED disambiguation)
10. Integration test for pause/resume flow

**V2 (WebUI — after V1 is proven stable):**
11. API endpoint to query active credit incidents
12. API endpoint to dismiss/retry
13. `CreditExhaustionModal.tsx` component with blur backdrop
14. App-level polling and modal rendering
15. "Change AI Model" -> Settings navigation
16. "Retry Now" action
17. Persistent warning banner (post-dismiss visibility)
