import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntakeResolutionCode } from './types.js';

export const DEFAULT_INTAKE_RESULT_FILE = 'intake-result.json';

export type IntakePipelinePhase = 'triage' | 'reproduction';
export type IntakeTriageDecision = 'close' | 'reproduce' | 'fix';
export type IntakeReproductionDecision = 'close' | 'retry' | 'fix';

interface IntakeResultBase {
  phase: IntakePipelinePhase;
  summary: string;
  comment?: string;
}

export interface IntakeTriageCloseResult extends IntakeResultBase {
  phase: 'triage';
  decision: 'close';
  resolutionCode: IntakeResolutionCode;
  nextTaskTitle?: string;
}

export interface IntakeTriageAdvanceResult extends IntakeResultBase {
  phase: 'triage';
  decision: 'reproduce' | 'fix';
  nextTaskTitle?: string;
}

export interface IntakeReproductionCloseResult extends IntakeResultBase {
  phase: 'reproduction';
  decision: 'close';
  resolutionCode: IntakeResolutionCode;
  nextTaskTitle?: string;
}

export interface IntakeReproductionRetryResult extends IntakeResultBase {
  phase: 'reproduction';
  decision: 'retry';
  nextTaskTitle?: string;
}

export interface IntakeReproductionAdvanceResult extends IntakeResultBase {
  phase: 'reproduction';
  decision: 'fix';
  nextTaskTitle?: string;
}

export type IntakeTriageResult = IntakeTriageCloseResult | IntakeTriageAdvanceResult;
export type IntakeReproductionResult =
  | IntakeReproductionCloseResult
  | IntakeReproductionRetryResult
  | IntakeReproductionAdvanceResult;
export type IntakeResult = IntakeTriageResult | IntakeReproductionResult;

export interface IntakePipelineCloseTransition {
  action: 'complete';
  phase: IntakePipelinePhase;
  summary: string;
  comment?: string;
  resolutionCode: IntakeResolutionCode;
}

export interface IntakePipelineAdvanceTransition {
  action: 'advance' | 'retry';
  phase: IntakePipelinePhase;
  nextPhase: 'reproduction' | 'fix';
  summary: string;
  comment?: string;
  nextTaskTitle?: string;
}

export type IntakePipelineTransition =
  | IntakePipelineCloseTransition
  | IntakePipelineAdvanceTransition;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`intake-result.json field "${fieldName}" must be a non-empty string`);
  }

  return value.trim();
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireNonEmptyString(value, fieldName);
}

function parsePhase(value: unknown): IntakePipelinePhase {
  if (value !== 'triage' && value !== 'reproduction') {
    throw new Error(`intake-result.json field "phase" must be "triage" or "reproduction", got: ${String(value)}`);
  }

  return value;
}

function parseDecision(
  phase: IntakePipelinePhase,
  value: unknown
): IntakeTriageDecision | IntakeReproductionDecision {
  if (phase === 'triage') {
    if (value === 'close' || value === 'reproduce' || value === 'fix') {
      return value;
    }

    throw new Error(
      `intake-result.json field "decision" must be one of "close", "reproduce", or "fix" for phase "triage", got: ${String(value)}`
    );
  }

  if (value === 'close' || value === 'retry' || value === 'fix') {
    return value;
  }

  throw new Error(
    `intake-result.json field "decision" must be one of "close", "retry", or "fix" for phase "reproduction", got: ${String(value)}`
  );
}

function parseResolutionCode(value: unknown): IntakeResolutionCode {
  if (value === 'fixed' || value === 'duplicate' || value === 'wontfix' || value === 'invalid') {
    return value;
  }

  throw new Error(
    `intake-result.json field "resolutionCode" must be one of "fixed", "duplicate", "wontfix", or "invalid", got: ${String(value)}`
  );
}

export function parseIntakeResult(raw: string): IntakeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`intake-result.json is not valid JSON: ${message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error('intake-result.json must contain a JSON object');
  }

  const phase = parsePhase(parsed.phase);
  const decision = parseDecision(phase, parsed.decision);
  const summary = requireNonEmptyString(parsed.summary, 'summary');
  const comment = parseOptionalString(parsed.comment, 'comment');
  const nextTaskTitle = parseOptionalString(parsed.nextTaskTitle, 'nextTaskTitle');

  if (decision === 'close') {
    return {
      phase,
      decision,
      summary,
      comment,
      nextTaskTitle,
      resolutionCode: parseResolutionCode(parsed.resolutionCode),
    };
  }

  if (parsed.resolutionCode !== undefined) {
    throw new Error('intake-result.json field "resolutionCode" is only allowed when decision is "close"');
  }

  if (phase === 'triage') {
    return {
      phase,
      decision,
      summary,
      comment,
      nextTaskTitle,
    } as IntakeTriageAdvanceResult;
  }

  return {
    phase,
    decision,
    summary,
    comment,
    nextTaskTitle,
  } as IntakeReproductionAdvanceResult | IntakeReproductionRetryResult;
}

export function parseIntakeResultFile(
  projectPath: string,
  fileName: string = DEFAULT_INTAKE_RESULT_FILE
): IntakeResult {
  const resultPath = join(projectPath, fileName);

  let raw: string;
  try {
    raw = readFileSync(resultPath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${fileName}: ${message}`);
  }

  return parseIntakeResult(raw);
}

export function deriveIntakePipelineTransition(result: IntakeResult): IntakePipelineTransition {
  if (result.decision === 'close') {
    return {
      action: 'complete',
      phase: result.phase,
      summary: result.summary,
      comment: result.comment,
      resolutionCode: result.resolutionCode,
    };
  }

  if (result.phase === 'triage') {
    return {
      action: 'advance',
      phase: result.phase,
      nextPhase: result.decision === 'reproduce' ? 'reproduction' : 'fix',
      summary: result.summary,
      comment: result.comment,
      nextTaskTitle: result.nextTaskTitle,
    };
  }

  return {
    action: result.decision === 'retry' ? 'retry' : 'advance',
    phase: result.phase,
    nextPhase: result.decision === 'retry' ? 'reproduction' : 'fix',
    summary: result.summary,
    comment: result.comment,
    nextTaskTitle: result.nextTaskTitle,
  };
}
