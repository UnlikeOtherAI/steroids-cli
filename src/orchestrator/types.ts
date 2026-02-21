/**
 * Types for orchestrator decision results
 */

export interface CoderOrchestrationResult {
  action: 'submit' | 'retry' | 'stage_commit_submit' | 'error';
  reasoning: string;
  commits: string[];
  commit_message?: string;
  next_status: 'review' | 'in_progress' | 'failed';
  metadata: {
    files_changed: number;
    confidence: 'high' | 'medium' | 'low';
    exit_clean: boolean;
    has_commits: boolean;
  };
}

export interface ReviewerOrchestrationResult {
  decision: 'approve' | 'reject' | 'dispute' | 'skip' | 'unclear';
  reasoning: string;
  notes: string;
  next_status: 'completed' | 'in_progress' | 'disputed' | 'skipped' | 'review';
  metadata: {
    rejection_count: number;
    confidence: 'high' | 'medium' | 'low';
    push_to_remote: boolean;
    repeated_issue: boolean;
  };
}

export interface CoderContext {
  task: {
    id: string;
    title: string;
    description: string;
    rejection_notes?: string;
    rejection_count?: number;
  };
  coder_output: {
    stdout: string;
    stderr: string;
    exit_code: number;
    timed_out: boolean;
    duration_ms: number;
  };
  git_state: {
    commits: Array<{ sha: string; message: string }>;
    files_changed: string[];
    has_uncommitted_changes: boolean;
    diff_summary: string;
  };
}

export interface ReviewerContext {
  task: {
    id: string;
    title: string;
    rejection_count: number;
  };
  reviewer_output: {
    stdout: string;
    stderr: string;
    exit_code: number;
    timed_out: boolean;
    duration_ms: number;
  };
  git_context: {
    commit_sha: string;
    files_changed: string[];
    additions: number;
    deletions: number;
  };
}

export interface MultiReviewerContext {
  task: {
    id: string;
    title: string;
    rejection_count: number;
  };
  reviewer_results: Array<{
    provider: string;
    model: string;
    decision: string;
    stdout: string;
    stderr: string;
    duration_ms: number;
  }>;
  git_context: {
    commit_sha: string;
    files_changed: string[];
    additions: number;
    deletions: number;
  };
}
