/**
 * Public API re-exports — implementation split across focused modules.
 *
 * loop-phases-helpers.ts        — shared types, constants, and utility functions
 * loop-phases-coder.ts          — runCoderPhase implementation
 * loop-phases-coder-decision.ts — coordinator invocation + decision execution helpers
 * loop-phases-reviewer.ts       — runReviewerPhase implementation
 * loop-phases-reviewer-resolution.ts — reviewer decision resolution helper
 */

export { runCoderPhase } from './loop-phases-coder.js';
export { runReviewerPhase } from './loop-phases-reviewer.js';
export type { CreditExhaustionResult, LeaseFenceContext } from './loop-phases-helpers.js';
export type { CoordinatorResult } from '../orchestrator/coordinator.js';
