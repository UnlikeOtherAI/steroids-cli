/**
 * Hooks System
 *
 * Complete hooks implementation including:
 * - Event definitions
 * - Payload schemas
 * - Template variable resolution
 * - Script and webhook runners
 * - Hook merging and orchestration
 */

// Events
export * from './events.js';

// Payloads
export * from './payload.js';

// Templates
export * from './templates.js';

// Runners
export {
  type ScriptHookConfig,
  type ScriptResult,
  executeScript,
  validateScriptConfig,
} from './script-runner.js';

export {
  type HttpMethod,
  type WebhookHookConfig,
  type WebhookResult,
  executeWebhook,
  validateWebhookConfig,
  parseTimeout,
} from './webhook-runner.js';

// Merge logic
export * from './merge.js';

// Orchestrator
export * from './orchestrator.js';

// Integration helpers
export * from './integration.js';
