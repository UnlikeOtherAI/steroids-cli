import { createFollowUpTask, getFollowUpDepth, getTask } from '../database/queries.js';
import type { openDatabase } from '../database/connection.js';
import { loadConfig } from '../config/loader.js';

export async function createFollowUpTasksIfNeeded(
  db: ReturnType<typeof openDatabase>['db'],
  task: ReturnType<typeof getTask>,
  projectPath: string,
  followUpTasks: Array<{ title: string; description: string }> | undefined,
  submissionCommitSha: string,
  jsonMode: boolean
): Promise<void> {
  if (!task || !followUpTasks || followUpTasks.length === 0) {
    return;
  }

  const followUpConfig = loadConfig(projectPath);
  const depth = getFollowUpDepth(db, task.id);
  const maxDepth = followUpConfig.followUpTasks?.maxDepth ?? 2;

  if (depth < maxDepth) {
    for (const followUp of followUpTasks) {
      try {
        const nextDepth = depth + 1;
        let requiresPromotion = true;
        if (nextDepth === 1 && followUpConfig.followUpTasks?.autoImplementDepth1) {
          requiresPromotion = false;
        }

        const followUpId = createFollowUpTask(db, {
          title: followUp.title,
          description: followUp.description,
          sectionId: task.section_id,
          referenceTaskId: task.id,
          referenceCommit: submissionCommitSha,
          requiresPromotion,
          depth: nextDepth,
        });

        if (!jsonMode) {
          const statusLabel = requiresPromotion ? '(deferred)' : '(active)';
          console.log(`\n+ Created follow-up task ${statusLabel}: ${followUp.title} (${followUpId.substring(0, 8)})`);
        }
      } catch (error) {
        console.warn(`Failed to create follow-up task "${followUp.title}":`, error);
      }
    }
  } else if (!jsonMode) {
    console.log(`\n! Follow-up depth limit reached (${depth}), skipping new follow-ups.`);
  }
}
