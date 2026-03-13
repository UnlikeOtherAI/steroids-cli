import type {
  IntakeReportReference,
  IntakeReportStatus,
  IntakeSeverity,
} from './types.js';

export const DEFAULT_INTAKE_PIPELINE_SOURCE_FILE = 'docs/plans/bug-intake/pipeline.md';

export type IntakeTaskPhase = 'triage' | 'reproduction' | 'fix';

export interface IntakeTaskTemplateReport extends IntakeReportReference {
  title: string;
  summary?: string;
  severity: IntakeSeverity;
  status: IntakeReportStatus;
}

export interface IntakeTaskTemplate {
  phase: IntakeTaskPhase;
  sectionName: string;
  title: string;
  sourceFile: string;
  description: string;
}

export interface BuildIntakeTaskTemplateOptions {
  sourceFile?: string;
  retryAttempt?: number;
}

const PHASE_SECTION_NAMES: Record<IntakeTaskPhase, string> = {
  triage: 'Bug Intake: Triage',
  reproduction: 'Bug Intake: Reproduction',
  fix: 'Bug Intake: Fix',
};

const PHASE_VERBS: Record<IntakeTaskPhase, string> = {
  triage: 'Triage',
  reproduction: 'Reproduce',
  fix: 'Fix',
};

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeRetryAttempt(retryAttempt: number | undefined): number | undefined {
  if (retryAttempt === undefined) {
    return undefined;
  }

  if (!Number.isInteger(retryAttempt) || retryAttempt < 2) {
    throw new Error(`Intake retry attempt must be an integer >= 2, got: ${String(retryAttempt)}`);
  }

  return retryAttempt;
}

function formatReportLabel(report: IntakeTaskTemplateReport): string {
  return `${report.source}#${report.externalId}`;
}

function buildSharedDescriptionLines(report: IntakeTaskTemplateReport): string[] {
  const lines = [
    `External report: ${formatReportLabel(report)}`,
    `Title: ${normalizeInlineText(report.title)}`,
    `Severity: ${report.severity}`,
    `Current intake status: ${report.status}`,
    `Report URL: ${report.url}`,
  ];

  if (report.summary && normalizeInlineText(report.summary) !== '') {
    lines.push(`Summary: ${normalizeInlineText(report.summary)}`);
  }

  return lines;
}

function buildPhaseInstructions(phase: IntakeTaskPhase): string[] {
  switch (phase) {
    case 'triage':
      return [
        'Goal: classify the report as close, reproduce, or fix without broadening scope.',
        'Required output: write intake-result.json in the project root using the triage contract from the linked spec.',
        'If you choose close, include resolutionCode. If you choose reproduce or fix, keep the next task title phase-specific and deterministic.',
      ];
    case 'reproduction':
      return [
        'Goal: produce a reliable reproduction with the narrowest defensible root-cause evidence.',
        'Required output: write intake-result.json in the project root using the reproduction contract from the linked spec.',
        'Capture exact steps, environment assumptions, expected behavior, and actual behavior.',
        'Choose retry only when another reproduction pass is justified; choose fix when the evidence is strong enough to proceed; choose close when the report should be resolved without a fix.',
        'Do not start unrelated cleanup or speculative refactors in this phase.',
      ];
    case 'fix':
      return [
        'Goal: implement the narrowest safe fix for the linked intake report and validate it with targeted tests.',
        'Preserve the intake scope. Defer broader cleanup or follow-up work instead of widening this task.',
        'Document any residual risk or follow-up idea in reviewer notes rather than folding it into the implementation.',
      ];
  }
}

export function getIntakeTaskSectionName(phase: IntakeTaskPhase): string {
  return PHASE_SECTION_NAMES[phase];
}

export function buildIntakeTaskTitle(
  phase: IntakeTaskPhase,
  report: IntakeTaskTemplateReport,
  options: Pick<BuildIntakeTaskTemplateOptions, 'retryAttempt'> = {}
): string {
  const retryAttempt = normalizeRetryAttempt(options.retryAttempt);
  const retrySuffix = retryAttempt ? ` (retry ${retryAttempt})` : '';
  return `${PHASE_VERBS[phase]} intake report ${formatReportLabel(report)}: ${normalizeInlineText(report.title)}${retrySuffix}`;
}

export function buildIntakeTaskDescription(
  phase: IntakeTaskPhase,
  report: IntakeTaskTemplateReport,
  options: Pick<BuildIntakeTaskTemplateOptions, 'retryAttempt'> = {}
): string {
  const retryAttempt = normalizeRetryAttempt(options.retryAttempt);
  const lines = [
    ...buildSharedDescriptionLines(report),
    ...(retryAttempt ? [`Retry attempt: ${retryAttempt}`] : []),
    '',
    ...buildPhaseInstructions(phase),
  ];

  return lines.join('\n');
}

export function buildIntakeTaskTemplate(
  phase: IntakeTaskPhase,
  report: IntakeTaskTemplateReport,
  options: BuildIntakeTaskTemplateOptions = {}
): IntakeTaskTemplate {
  return {
    phase,
    sectionName: getIntakeTaskSectionName(phase),
    title: buildIntakeTaskTitle(phase, report, options),
    sourceFile: options.sourceFile ?? DEFAULT_INTAKE_PIPELINE_SOURCE_FILE,
    description: buildIntakeTaskDescription(phase, report, options),
  };
}
