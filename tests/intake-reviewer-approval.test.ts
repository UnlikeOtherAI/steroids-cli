import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SCHEMA_SQL } from '../src/database/schema.js';
import {
  createSection,
  createTask,
  getSectionByName,
  listTasks,
} from '../src/database/queries.js';
import { getIntakeReport, upsertIntakeReport } from '../src/database/intake-queries.js';
import { handleIntakeTaskApproval } from '../src/intake/reviewer-approval.js';
import { DEFAULT_INTAKE_PIPELINE_SOURCE_FILE } from '../src/intake/task-templates.js';
import type { IntakeReport } from '../src/intake/types.js';

function createSampleReport(overrides: Partial<IntakeReport> = {}): IntakeReport {
  return {
    source: 'github',
    externalId: '42',
    url: 'https://github.com/acme/widgets/issues/42',
    fingerprint: 'github:acme/widgets#42',
    title: 'Checkout fails on empty cart',
    summary: 'Stack trace attached',
    severity: 'high',
    status: 'triaged',
    createdAt: '2026-03-10T10:00:00Z',
    updatedAt: '2026-03-10T11:00:00Z',
    tags: ['bug', 'checkout'],
    payload: { body: 'Stack trace attached' },
    ...overrides,
  };
}

describe('handleIntakeTaskApproval', () => {
  let db: Database.Database;
  let projectPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    projectPath = mkdtempSync(join(tmpdir(), 'steroids-intake-reviewer-'));
  });

  afterEach(() => {
    db.close();
    rmSync(projectPath, { recursive: true, force: true });
  });

  it('ignores tasks that are not intake pipeline triage tasks', () => {
    const section = createSection(db, 'General');
    const task = createTask(db, 'Normal task', { sectionId: section.id });

    expect(handleIntakeTaskApproval(db, task, projectPath)).toEqual({ handled: false });
  });

  it('marks a triage task closed as ignored for non-fixed resolution codes', () => {
    const triageSection = createSection(db, 'Bug Intake: Triage');
    const triageTask = createTask(
      db,
      'Triage intake report github#42: Checkout fails on empty cart',
      {
        sectionId: triageSection.id,
        sourceFile: DEFAULT_INTAKE_PIPELINE_SOURCE_FILE,
      }
    );

    upsertIntakeReport(db, createSampleReport(), { linkedTaskId: triageTask.id });
    writeFileSync(
      join(projectPath, 'intake-result.json'),
      JSON.stringify({
        phase: 'triage',
        decision: 'close',
        summary: 'This is a duplicate.',
        resolutionCode: 'duplicate',
      }),
      'utf-8'
    );

    const result = handleIntakeTaskApproval(db, triageTask, projectPath);

    expect(result.handled).toBe(true);
    expect(result.transition).toMatchObject({
      action: 'complete',
      resolutionCode: 'duplicate',
    });
    expect(getIntakeReport(db, 'github', '42')).toEqual(
      expect.objectContaining({
        status: 'ignored',
        linkedTaskId: triageTask.id,
      })
    );
    expect(getIntakeReport(db, 'github', '42')?.resolvedAt).toBeTruthy();
  });

  it('creates the next fix task, section, and report link for advance transitions', () => {
    const triageSection = createSection(db, 'Bug Intake: Triage');
    const triageTask = createTask(
      db,
      'Triage intake report github#42: Checkout fails on empty cart',
      {
        sectionId: triageSection.id,
        sourceFile: DEFAULT_INTAKE_PIPELINE_SOURCE_FILE,
      }
    );

    upsertIntakeReport(db, createSampleReport(), { linkedTaskId: triageTask.id });
    writeFileSync(
      join(projectPath, 'intake-result.json'),
      JSON.stringify({
        phase: 'triage',
        decision: 'fix',
        summary: 'The bug is well understood.',
        nextTaskTitle: 'Fix checkout failure from intake report github#42',
      }),
      'utf-8'
    );

    const result = handleIntakeTaskApproval(db, triageTask, projectPath);
    const fixSection = getSectionByName(db, 'Bug Intake: Fix');
    const tasks = listTasks(db, { status: 'all' });
    const nextTask = tasks.find((entry) => entry.id === result.createdTaskId);

    expect(result).toMatchObject({
      handled: true,
      createdTaskId: expect.any(String),
      transition: {
        action: 'advance',
        nextPhase: 'fix',
      },
    });
    expect(fixSection).not.toBeNull();
    expect(nextTask).toEqual(
      expect.objectContaining({
        title: 'Fix checkout failure from intake report github#42',
        section_id: fixSection?.id,
        source_file: DEFAULT_INTAKE_PIPELINE_SOURCE_FILE,
        status: 'pending',
      })
    );
    expect(getIntakeReport(db, 'github', '42')).toEqual(
      expect.objectContaining({
        status: 'in_progress',
        linkedTaskId: result.createdTaskId,
      })
    );
    expect(getIntakeReport(db, 'github', '42')?.resolvedAt).toBeUndefined();
  });
});
