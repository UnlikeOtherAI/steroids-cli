import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntakeResolutionCode } from './types.js';

export const DEFAULT_INTAKE_RESULT_FILE = 'intake-result.json';

export type IntakePipelinePhase = 'triage';
export type IntakeTriageDecision = 'close' | 'reproduce' | 'fix';

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

export type IntakeTriageResult = IntakeTriageCloseResult | IntakeTriageAdvanceResult;
export type IntakeResult = IntakeTriageResult;

export interface IntakePipelineCloseTransition {
  action: 'complete';
  phase: 'triage';
  summary: string;
  comment?: string;
  resolutionCode: IntakeResolutionCode;
}

export interface IntakePipelineAdvanceTransition {
  action: 'advance';
  phase: 'triage';
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
  if (value !== 'triage') {
    throw new Error(`intake-result.json field "phase" must be "triage", got: ${String(value)}`);
  }

  return value;
}

function parseDecision(value: unknown): IntakeTriageDecision {
  if (value === 'close' || value === 'reproduce' || value === 'fix') {
    return value;
  }

  throw new Error(
    `intake-result.json field "decision" must be one of "close", "reproduce", or "fix", got: ${String(value)}`
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
  const decision = parseDecision(parsed.decision);
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

  return {
    phase,
    decision,
    summary,
    comment,
    nextTaskTitle,
  };
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
  switch (result.decision) {
    case 'close':
      return {
        action: 'complete',
        phase: result.phase,
        summary: result.summary,
        comment: result.comment,
        resolutionCode: result.resolutionCode,
      };
    case 'reproduce':
      return {
        action: 'advance',
        phase: result.phase,
        nextPhase: 'reproduction',
        summary: result.summary,
        comment: result.comment,
        nextTaskTitle: result.nextTaskTitle,
      };
    case 'fix':
      return {
        action: 'advance',
        phase: result.phase,
        nextPhase: 'fix',
        summary: result.summary,
        comment: result.comment,
        nextTaskTitle: result.nextTaskTitle,
      };
  }
}
