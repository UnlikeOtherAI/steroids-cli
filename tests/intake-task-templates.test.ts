import { describe, expect, it } from '@jest/globals';

import {
  buildIntakeTaskDescription,
  buildIntakeTaskTemplate,
  buildIntakeTaskTitle,
  DEFAULT_INTAKE_PIPELINE_SOURCE_FILE,
  getIntakeTaskSectionName,
} from '../src/intake/task-templates.js';
import type { IntakeTaskTemplateReport } from '../src/intake/task-templates.js';

function createReport(overrides: Partial<IntakeTaskTemplateReport> = {}): IntakeTaskTemplateReport {
  return {
    source: 'github',
    externalId: '42',
    url: 'https://github.com/acme/widgets/issues/42',
    title: 'Checkout fails on empty cart',
    summary: 'Stack trace attached by support',
    severity: 'high',
    status: 'open',
    ...overrides,
  };
}

describe('intake task templates', () => {
  it('builds a deterministic triage template with the shared pipeline spec path', () => {
    const report = createReport();

    expect(buildIntakeTaskTemplate('triage', report)).toEqual({
      phase: 'triage',
      sectionName: 'Bug Intake: Triage',
      title: 'Triage intake report github#42: Checkout fails on empty cart',
      sourceFile: DEFAULT_INTAKE_PIPELINE_SOURCE_FILE,
      description: [
        'External report: github#42',
        'Title: Checkout fails on empty cart',
        'Severity: high',
        'Current intake status: open',
        'Report URL: https://github.com/acme/widgets/issues/42',
        'Summary: Stack trace attached by support',
        '',
        'Goal: classify the report as close, reproduce, or fix without broadening scope.',
        'Required output: write intake-result.json in the project root using the triage contract from the linked spec.',
        'If you choose close, include resolutionCode. If you choose reproduce or fix, keep the next task title phase-specific and deterministic.',
      ].join('\n'),
    });
  });

  it('builds reproduction and fix templates with phase-specific sections and titles', () => {
    const report = createReport();

    expect(getIntakeTaskSectionName('reproduction')).toBe('Bug Intake: Reproduction');
    expect(buildIntakeTaskTitle('reproduction', report)).toBe(
      'Reproduce intake report github#42: Checkout fails on empty cart'
    );
    expect(buildIntakeTaskTitle('fix', report)).toBe(
      'Fix intake report github#42: Checkout fails on empty cart'
    );
    expect(buildIntakeTaskDescription('reproduction', report)).toContain(
      'Goal: produce a reliable reproduction with the narrowest defensible root-cause evidence.'
    );
    expect(buildIntakeTaskDescription('reproduction', report)).toContain(
      'Required output: write intake-result.json in the project root using the reproduction contract from the linked spec.'
    );
    expect(buildIntakeTaskDescription('fix', report)).toContain(
      'Goal: implement the narrowest safe fix for the linked intake report and validate it with targeted tests.'
    );
  });

  it('normalizes whitespace in report titles and summaries', () => {
    const report = createReport({
      title: 'Checkout fails\n\n on empty cart',
      summary: '  First line\nSecond line  ',
    });

    const template = buildIntakeTaskTemplate('triage', report);

    expect(template.title).toBe('Triage intake report github#42: Checkout fails on empty cart');
    expect(template.description).toContain('Title: Checkout fails on empty cart');
    expect(template.description).toContain('Summary: First line Second line');
  });

  it('omits the summary line when no summary is present and allows source-file override', () => {
    const template = buildIntakeTaskTemplate(
      'fix',
      createReport({ summary: undefined }),
      { sourceFile: 'docs/custom/intake-fix.md' }
    );

    expect(template.sourceFile).toBe('docs/custom/intake-fix.md');
    expect(template.description).not.toContain('Summary:');
  });

  it('supports deterministic retry title and description suffixes for retried intake tasks', () => {
    const template = buildIntakeTaskTemplate(
      'reproduction',
      createReport(),
      { retryAttempt: 2 }
    );

    expect(template.title).toBe(
      'Reproduce intake report github#42: Checkout fails on empty cart (retry 2)'
    );
    expect(template.description).toContain('Retry attempt: 2');
  });

  it('rejects invalid retry attempts', () => {
    expect(() => buildIntakeTaskTemplate('reproduction', createReport(), { retryAttempt: 1 })).toThrow(
      'Intake retry attempt must be an integer >= 2, got: 1'
    );
  });
});
