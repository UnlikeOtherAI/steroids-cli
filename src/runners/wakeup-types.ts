export interface WakeupOptions {
  quiet?: boolean;
  dryRun?: boolean;
}

export interface WakeupResult {
  action: 'none' | 'started' | 'restarted' | 'cleaned' | 'would_start' | 'skipped';
  reason: string;
  runnerId?: string;
  pid?: number;
  staleRunners?: number;
  pendingTasks?: number;
  projectPath?: string;
  recoveredActions?: number;
  skippedRecoveryDueToSafetyLimit?: boolean;
  deletedInvocationLogs?: number;
  sanitisedActions?: number;
  polledIntakeReports?: number;
  intakePollErrors?: number;
  githubGateIssuesCreated?: number;
  githubGateApprovalsApplied?: number;
  githubGateRejectionsApplied?: number;
  githubGateErrors?: number;
}

export type WakeupLogger = (message: string) => void;
