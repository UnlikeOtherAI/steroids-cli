import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { addAuditEntry, createTask } from '../database/queries.js';

function buildMergeConflictSectionName(): string {
  return 'merge-conflicts';
}

function getNowISOString(): string {
  return new Date().toISOString();
}

function createMergeConflictSection(db: Database.Database): string {
  const sectionName = buildMergeConflictSectionName();
  const existing = db
    .prepare('SELECT id FROM sections WHERE name = ? LIMIT 1')
    .get(sectionName) as { id: string } | undefined;

  if (existing) {
    return existing.id;
  }

  const maxPosRow = db
    .prepare('SELECT MAX(position) as maxPos FROM sections')
    .get() as { maxPos: number | null };

  const position = (maxPosRow?.maxPos ?? -1) + 1;
  const sectionId = createHash('sha1').update(sectionName + position).digest('hex');

  db.prepare(
    `INSERT INTO sections (id, name, position, priority, skipped, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sectionId, sectionName, position, 80, 0, getNowISOString());

  return sectionId;
}

export function ensureMergeConflictTask(
  db: Database.Database,
  workstreamId: string,
  shortSha: string,
  branchName: string,
  commitMessage: string,
  conflictedFiles: string[],
  conflictPatch: string,
  forceNew = false
): string {
  const sectionId = createMergeConflictSection(db);

  if (!forceNew) {
    const existing = db
      .prepare(
        `SELECT t.id
         FROM tasks t
         INNER JOIN sections s ON s.id = t.section_id
         WHERE s.name = ? AND t.title LIKE ?
         ORDER BY t.created_at DESC
         LIMIT 1`
      )
      .get(buildMergeConflictSectionName(), `Merge conflict: cherry-pick ${shortSha}%`) as { id: string } | undefined;

    if (existing?.id) {
      return existing.id;
    }
  }

  const title = `Merge conflict: cherry-pick ${shortSha} from ${branchName}`;
  const created = createTask(db, title, {
    sectionId,
    sourceFile: `merge-conflict (${workstreamId})`,
    filePath: conflictedFiles.join(', '),
    status: 'pending',
    fileContentHash: conflictPatch.substring(0, 2048),
    fileCommitSha: commitMessage,
  });

  addAuditEntry(
    db,
    created.id,
    'null',
    'pending',
    'merge',
    {
      actorType: 'orchestrator',
      notes: `Generated from conflict while cherry-picking ${shortSha} from ${branchName}:\n${commitMessage}`,
    }
  );

  return created.id;
}
