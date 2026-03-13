import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  deriveIntakePipelineTransition,
  parseIntakeResult,
  parseIntakeResultFile,
} from '../src/intake/pipeline-glue.js';

describe('intake pipeline glue', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('parses a close triage result with a required resolution code', () => {
    const result = parseIntakeResult(
      JSON.stringify({
        phase: 'triage',
        decision: 'close',
        summary: 'This is expected behavior, not a product defect.',
        comment: 'Closing after triage review.',
        resolutionCode: 'invalid',
      })
    );

    expect(result).toEqual({
      phase: 'triage',
      decision: 'close',
      summary: 'This is expected behavior, not a product defect.',
      comment: 'Closing after triage review.',
      nextTaskTitle: undefined,
      resolutionCode: 'invalid',
    });
    expect(deriveIntakePipelineTransition(result)).toEqual({
      action: 'complete',
      phase: 'triage',
      summary: 'This is expected behavior, not a product defect.',
      comment: 'Closing after triage review.',
      resolutionCode: 'invalid',
    });
  });

  it('maps a reproduce decision into a deterministic next-phase transition', () => {
    const result = parseIntakeResult(
      JSON.stringify({
        phase: 'triage',
        decision: 'reproduce',
        summary: 'The report needs a clean reproduction before coding starts.',
        nextTaskTitle: 'Reproduce checkout failure from intake report #42',
      })
    );

    expect(deriveIntakePipelineTransition(result)).toEqual({
      action: 'advance',
      phase: 'triage',
      nextPhase: 'reproduction',
      summary: 'The report needs a clean reproduction before coding starts.',
      comment: undefined,
      nextTaskTitle: 'Reproduce checkout failure from intake report #42',
    });
  });

  it('maps a fix decision into a deterministic next-phase transition', () => {
    const result = parseIntakeResult(
      JSON.stringify({
        phase: 'triage',
        decision: 'fix',
        summary: 'The bug is understood well enough to proceed directly to a fix.',
        nextTaskTitle: 'Fix checkout failure from intake report #42',
      })
    );

    expect(deriveIntakePipelineTransition(result)).toEqual({
      action: 'advance',
      phase: 'triage',
      nextPhase: 'fix',
      summary: 'The bug is understood well enough to proceed directly to a fix.',
      comment: undefined,
      nextTaskTitle: 'Fix checkout failure from intake report #42',
    });
  });

  it('maps a reproduction retry decision into a deterministic retry transition', () => {
    const result = parseIntakeResult(
      JSON.stringify({
        phase: 'reproduction',
        decision: 'retry',
        summary: 'The failure is still flaky; collect one tighter repro pass.',
        nextTaskTitle: 'Reproduce checkout failure from intake report github#42 (retry 2)',
      })
    );

    expect(deriveIntakePipelineTransition(result)).toEqual({
      action: 'retry',
      phase: 'reproduction',
      nextPhase: 'reproduction',
      summary: 'The failure is still flaky; collect one tighter repro pass.',
      comment: undefined,
      nextTaskTitle: 'Reproduce checkout failure from intake report github#42 (retry 2)',
    });
  });

  it('maps a reproduction fix decision into a deterministic fix transition', () => {
    const result = parseIntakeResult(
      JSON.stringify({
        phase: 'reproduction',
        decision: 'fix',
        summary: 'The reproduction is stable and the bug is isolated enough to fix.',
      })
    );

    expect(deriveIntakePipelineTransition(result)).toEqual({
      action: 'advance',
      phase: 'reproduction',
      nextPhase: 'fix',
      summary: 'The reproduction is stable and the bug is isolated enough to fix.',
      comment: undefined,
      nextTaskTitle: undefined,
    });
  });

  it('rejects invalid triage result shapes instead of guessing', () => {
    expect(() =>
      parseIntakeResult(
        JSON.stringify({
          phase: 'triage',
          decision: 'close',
          summary: 'Missing resolution code.',
        })
      )
    ).toThrow('intake-result.json field "resolutionCode" must be one of "fixed", "duplicate", "wontfix", or "invalid", got: undefined');

    expect(() =>
      parseIntakeResult(
        JSON.stringify({
          phase: 'triage',
          decision: 'fix',
          summary: 'Unexpected resolution code for non-close.',
          resolutionCode: 'fixed',
        })
      )
    ).toThrow('intake-result.json field "resolutionCode" is only allowed when decision is "close"');
  });

  it('rejects invalid reproduction result shapes instead of guessing', () => {
    expect(() =>
      parseIntakeResult(
        JSON.stringify({
          phase: 'reproduction',
          decision: 'close',
          summary: 'Missing resolution code.',
        })
      )
    ).toThrow('intake-result.json field "resolutionCode" must be one of "fixed", "duplicate", "wontfix", or "invalid", got: undefined');

    expect(() =>
      parseIntakeResult(
        JSON.stringify({
          phase: 'reproduction',
          decision: 'reproduce',
          summary: 'Wrong decision for reproduction phase.',
        })
      )
    ).toThrow('intake-result.json field "decision" must be one of "close", "retry", or "fix" for phase "reproduction", got: reproduce');
  });

  it('reads intake-result.json from the project root and validates invalid JSON', () => {
    const validDir = mkdtempSync(join(tmpdir(), 'steroids-intake-pipeline-'));
    tempDirs.push(validDir);
    writeFileSync(
      join(validDir, 'intake-result.json'),
      JSON.stringify({
        phase: 'triage',
        decision: 'fix',
        summary: 'Proceed to implementation.',
      }),
      'utf-8'
    );

    expect(parseIntakeResultFile(validDir)).toEqual({
      phase: 'triage',
      decision: 'fix',
      summary: 'Proceed to implementation.',
      comment: undefined,
      nextTaskTitle: undefined,
    });

    const invalidDir = mkdtempSync(join(tmpdir(), 'steroids-intake-pipeline-'));
    tempDirs.push(invalidDir);
    writeFileSync(join(invalidDir, 'intake-result.json'), '{not json', 'utf-8');

    expect(() => parseIntakeResultFile(invalidDir)).toThrow('intake-result.json is not valid JSON:');
  });
});
