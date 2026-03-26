import {
  MULTI_REVIEW_SCENARIOS,
} from './scenarios.js';
import {
  getScenarioIdByTask,
  restampNewAuditEntries,
  type IntegrationHarnessState,
} from './harness.js';

type RunCoderPhase = typeof import('../../src/commands/loop-phases-coder.js').runCoderPhase;
type RunReviewerPhase = typeof import('../../src/commands/loop-phases-reviewer.js').runReviewerPhase;
type CompleteMergePendingTask = typeof import('../../src/orchestrator/merge-queue-completion.js').completeMergePendingTask;
type SelectNextTask = typeof import('../../src/orchestrator/task-selector.js').selectNextTask;
type MarkTaskInProgress = typeof import('../../src/orchestrator/task-selector.js').markTaskInProgress;
type UpdateTaskStatus = typeof import('../../src/database/queries.js').updateTaskStatus;
type HandleCreditExhaustion = typeof import('../../src/runners/credit-pause.js').handleCreditExhaustion;
type HandleAuthError = typeof import('../../src/runners/credit-pause.js').handleAuthError;
type CoordinatorResult = import('../../src/orchestrator/coordinator.js').CoordinatorResult;
type CreditResult =
  | Awaited<ReturnType<RunCoderPhase>>
  | Awaited<ReturnType<RunReviewerPhase>>;

export async function executeHarnessRun(options: {
  state: IntegrationHarnessState;
  runCoderPhase: RunCoderPhase;
  runReviewerPhase: RunReviewerPhase;
  completeMergePendingTask: CompleteMergePendingTask;
  taskSelector: {
    selectNextTask: SelectNextTask;
    markTaskInProgress: MarkTaskInProgress;
  };
  queries: {
    updateTaskStatus: UpdateTaskStatus;
  };
  pauseHandlers: {
    handleCreditExhaustion: HandleCreditExhaustion;
    handleAuthError: HandleAuthError;
  };
  setMultiReviewEnabled: (enabled: boolean) => void;
  projectPath: string;
  buildMergeCompletionOptions: (taskId: string) => Parameters<CompleteMergePendingTask>[2];
}) {
  const coordinatorCache = new Map<string, CoordinatorResult>();
  const maxIterations = 500;
  let iterations = 0;

  for (; iterations < maxIterations; iterations += 1) {
    const selected = options.taskSelector.selectNextTask(options.state.db);
    if (!selected) {
      break;
    }

    const scenarioId = getScenarioIdByTask(options.state, selected.task.id);
    options.state.activeTaskId = selected.task.id;
    options.setMultiReviewEnabled(MULTI_REVIEW_SCENARIOS.has(scenarioId));
    let creditResult: CreditResult = undefined;

    if (selected.action === 'start') {
      options.taskSelector.markTaskInProgress(options.state.db, selected.task.id);
      creditResult = await options.runCoderPhase(
        options.state.db,
        selected.task,
        options.projectPath,
        'start',
        true,
        coordinatorCache,
      );
    } else if (selected.action === 'resume') {
      creditResult = await options.runCoderPhase(
        options.state.db,
        selected.task,
        options.projectPath,
        'resume',
        true,
        coordinatorCache,
      );
    } else if (selected.action === 'review') {
      creditResult = await options.runReviewerPhase(
        options.state.db,
        selected.task,
        options.projectPath,
        true,
        coordinatorCache.get(selected.task.id),
      );
    } else if (selected.action === 'merge') {
      await options.completeMergePendingTask(
        options.state.db,
        selected.task,
        options.buildMergeCompletionOptions(selected.task.id),
      );
    }

    if (creditResult) {
      options.state.creditResults.set(selected.task.id, creditResult);
      const pauseOptions = {
        ...creditResult,
        db: options.state.db,
        projectPath: options.projectPath,
        runnerId: 'integration-harness',
        shouldStop: () => false,
        onceMode: false,
      };
      const pauseResult = creditResult.action === 'pause_auth_error'
        ? await options.pauseHandlers.handleAuthError(pauseOptions)
        : await options.pauseHandlers.handleCreditExhaustion(pauseOptions);

      if (!pauseResult.resolved) {
        options.queries.updateTaskStatus(
          options.state.db,
          selected.task.id,
          'blocked_error',
          'integration-test',
          `Paused after ${creditResult.action}; harness terminalized task after pause handler returned ${pauseResult.resolution}.`,
        );
      }
    }

    restampNewAuditEntries(options.state);
    options.state.activeTaskId = null;
    options.setMultiReviewEnabled(false);
  }

  const remaining = options.taskSelector.selectNextTask(options.state.db);
  return { state: options.state, iterations, maxIterations, remaining };
}
