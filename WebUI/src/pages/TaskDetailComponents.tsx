/**
 * Sub-components for TaskDetailPage
 * Extracted to keep page under 500 lines
 */

import React, { useState } from 'react';
import { AuditEntry, TaskInvocation, TaskDispute } from '../types';
import { Badge } from '../components/atoms/Badge';

// ============ Shared Utilities ============

const STATUS_VARIANTS: Record<string, 'success' | 'danger' | 'warning' | 'info' | 'default'> = {
  pending: 'default',
  in_progress: 'info',
  review: 'warning',
  completed: 'success',
  skipped: 'warning',
  failed: 'danger',
  disputed: 'danger',
  blocked_error: 'danger',
  blocked_conflict: 'warning',
};

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

function getActorIcon(actorType: string | null): string {
  switch (actorType) {
    case 'coder': return 'fa-code';
    case 'reviewer': return 'fa-magnifying-glass';
    case 'orchestrator': return 'fa-arrows-rotate';
    case 'human': return 'fa-user';
    default: return 'fa-robot';
  }
}

function getActorLabel(actorType: string | null, model: string | null): string {
  const type = actorType || 'unknown';
  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  return model ? `${typeLabel} (${model})` : typeLabel;
}

// ============ AuditLogRow ============

interface AuditLogRowProps {
  entry: AuditEntry;
  isLatest: boolean;
  githubUrl: string | null;
}

export const AuditLogRow: React.FC<AuditLogRowProps> = ({ entry, isLatest, githubUrl }) => {
  const isCoordinatorNote = entry.from_status === entry.to_status && entry.actor_type === 'orchestrator';

  return (
    <div className={`p-4 border-l-4 ${isCoordinatorNote ? 'border-accent bg-accent/5' : isLatest ? 'border-accent bg-bg-surface' : 'border-border bg-bg-base'}`}>
      <div className="flex items-start gap-4">
        <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${isCoordinatorNote ? 'bg-accent/20' : 'bg-bg-surface'}`}>
          <i className={`fa-solid ${getActorIcon(entry.actor_type)} ${isCoordinatorNote ? 'text-accent' : 'text-text-muted'} text-sm`}></i>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-text-primary">{getActorLabel(entry.actor_type, entry.model)}</span>
            {isCoordinatorNote ? (
              <Badge variant="info">Coordinator Intervention</Badge>
            ) : (
              <>
                {entry.from_status ? (
                  <>
                    <span className="text-text-muted">changed status from</span>
                    <Badge variant="default">{entry.from_status}</Badge>
                    <span className="text-text-muted">to</span>
                  </>
                ) : (
                  <span className="text-text-muted">set status to</span>
                )}
                <Badge variant={STATUS_VARIANTS[entry.to_status] || 'default'}>
                  {entry.to_status}
                </Badge>
              </>
            )}
          </div>
          {entry.notes && (
            <div className={`mt-2 p-3 rounded-lg text-sm font-mono whitespace-pre-wrap ${isCoordinatorNote ? 'bg-accent/10 text-text-primary border border-accent/20' : 'bg-bg-base text-text-secondary'}`}>
              {entry.notes}
            </div>
          )}
          {entry.commit_sha && (
            <div className="mt-2 text-xs text-text-muted">
              {githubUrl ? (
                <a
                  href={`${githubUrl}/commit/${entry.commit_sha}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:text-accent transition-colors"
                >
                  <i className="fa-brands fa-github"></i>
                  <code className="bg-bg-surface px-1 rounded">{entry.commit_sha.slice(0, 7)}</code>
                  <i className="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
                </a>
              ) : (
                <>
                  <i className="fa-solid fa-code-commit mr-1"></i>
                  Commit: <code className="bg-bg-surface px-1 rounded">{entry.commit_sha.slice(0, 7)}</code>
                </>
              )}
            </div>
          )}
          <div className="mt-2 flex items-center gap-4 text-xs text-text-muted">
            <span>
              <i className="fa-regular fa-clock mr-1"></i>
              {formatTimestamp(entry.created_at)}
            </span>
            {entry.duration_seconds !== undefined && entry.duration_seconds > 0 && (
              <span>
                <i className="fa-solid fa-hourglass-half mr-1"></i>
                Duration: {formatDuration(entry.duration_seconds)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============ InvocationCard ============

interface InvocationCardProps {
  invocation: TaskInvocation;
  taskId: string;
  projectPath: string;
}

interface InvocationDetails {
  prompt: string;
  response: string | null;
  error: string | null;
}

function getFirstLines(text: string, n: number): { preview: string; hasMore: boolean } {
  const lines = text.split('\n');
  if (lines.length <= n) return { preview: text, hasMore: false };
  return { preview: lines.slice(0, n).join('\n'), hasMore: true };
}

export const InvocationCard: React.FC<InvocationCardProps> = ({ invocation, taskId, projectPath }) => {
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState<InvocationDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [responseExpanded, setResponseExpanded] = useState(false);

  const isOngoing = invocation.status === 'running';
  const isSuccess = invocation.success === 1;
  const isTimedOut = invocation.timed_out === 1;
  const isCoder = invocation.role === 'coder';
  const roleLabel = isCoder ? 'Coder Agent' : 'Reviewer Agent';

  let accentColor = 'border-success';
  if (isOngoing) accentColor = 'border-info';
  else if (isTimedOut) accentColor = 'border-warning';
  else if (!isSuccess) accentColor = 'border-danger';

  const handleToggle = async () => {
    const opening = !expanded;
    setExpanded(opening);
    if (opening && !details) {
      setLoading(true);
      try {
        const resp = await fetch(
          `/api/tasks/${taskId}/invocations/${invocation.id}?project=${encodeURIComponent(projectPath)}`
        );
        const data = await resp.json();
        if (data.success) {
          setDetails({
            prompt: data.invocation.prompt,
            response: data.invocation.response,
            error: data.invocation.error,
          });
        }
      } catch (err) {
        console.error('Failed to fetch invocation details:', err);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className={`border-l-4 ${accentColor} rounded-lg overflow-hidden bg-bg-base`}>
      {/* Header — always visible */}
      <button
        onClick={handleToggle}
        className="w-full p-3 flex items-center gap-3 hover:bg-bg-surface transition-colors text-left"
      >
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-bg-surface flex items-center justify-center">
          <i className={`fa-solid ${isCoder ? 'fa-code' : 'fa-magnifying-glass'} text-text-muted text-xs`}></i>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-text-primary text-sm">{roleLabel}</span>
            <span className="text-text-muted text-xs">{invocation.model}</span>
            {isOngoing ? (
              <Badge variant="info">
                <i className="fa-solid fa-spinner fa-spin mr-1 text-[10px]"></i>
                Running
              </Badge>
            ) : isSuccess ? (
              <Badge variant="success">OK</Badge>
            ) : isTimedOut ? (
              <Badge variant="warning">Timed Out</Badge>
            ) : (
              <Badge variant="danger">Failed (exit {invocation.exit_code})</Badge>
            )}
            {isCoder && invocation.rejection_number !== null && invocation.rejection_number > 0 && (
              <Badge variant="warning">Attempt #{invocation.rejection_number}</Badge>
            )}
          </div>
          <div className="mt-1 flex items-center gap-4 text-xs text-text-muted">
            <span>
              <i className="fa-regular fa-clock mr-1"></i>
              {formatTimestamp(invocation.created_at)}
            </span>
            {invocation.duration_ms > 0 && (
              <span>
                <i className="fa-solid fa-stopwatch mr-1"></i>
                {formatDuration(Math.round(invocation.duration_ms / 1000))}
              </span>
            )}
          </div>
        </div>
        <i className={`fa-solid ${expanded ? 'fa-chevron-up' : 'fa-chevron-down'} text-text-muted flex-shrink-0`}></i>
      </button>

      {/* Expanded body — prompt, response, error */}
      {expanded && (
        <div className="border-t border-border p-3 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <i className="fa-solid fa-spinner fa-spin text-accent text-xl"></i>
            </div>
          ) : details ? (
            <>
              {/* Prompt */}
              <div className="rounded-lg overflow-hidden border border-border">
                <div className="px-3 py-2 bg-bg-surface flex items-center justify-between">
                  <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                    <i className="fa-solid fa-paper-plane mr-1"></i>
                    Prompt sent ({details.prompt.length.toLocaleString()} chars)
                  </span>
                  {getFirstLines(details.prompt, 4).hasMore && (
                    <button
                      onClick={() => setPromptExpanded(!promptExpanded)}
                      className="text-xs text-accent hover:underline"
                    >
                      {promptExpanded ? 'Collapse' : 'Show full prompt'}
                    </button>
                  )}
                </div>
                <pre className="p-3 text-sm overflow-x-auto bg-bg-base max-h-96">
                  <code className="text-text-secondary font-mono whitespace-pre-wrap">
                    {promptExpanded ? details.prompt : getFirstLines(details.prompt, 4).preview}
                    {!promptExpanded && getFirstLines(details.prompt, 4).hasMore && (
                      <span className="text-text-muted"> ...</span>
                    )}
                  </code>
                </pre>
              </div>

              {/* Response */}
              {details.response && (
                <div className="rounded-lg overflow-hidden border border-border">
                  <div className="px-3 py-2 bg-bg-surface flex items-center justify-between">
                    <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                      <i className="fa-solid fa-reply mr-1"></i>
                      Agent responded ({details.response.length.toLocaleString()} chars)
                    </span>
                    {getFirstLines(details.response, 4).hasMore && (
                      <button
                        onClick={() => setResponseExpanded(!responseExpanded)}
                        className="text-xs text-accent hover:underline"
                      >
                        {responseExpanded ? 'Collapse' : 'Show full response'}
                      </button>
                    )}
                  </div>
                  <pre className="p-3 text-sm overflow-x-auto bg-bg-base max-h-96">
                    <code className="text-text-secondary font-mono whitespace-pre-wrap">
                      {responseExpanded ? details.response : getFirstLines(details.response, 4).preview}
                      {!responseExpanded && getFirstLines(details.response, 4).hasMore && (
                        <span className="text-text-muted"> ...</span>
                      )}
                    </code>
                  </pre>
                </div>
              )}

              {/* Error */}
              {details.error && (
                <div className="rounded-lg overflow-hidden border-2 border-danger bg-danger/5">
                  <div className="px-3 py-2 flex items-center gap-2">
                    <i className="fa-solid fa-triangle-exclamation text-danger text-xs"></i>
                    <span className="text-xs font-semibold text-danger uppercase tracking-wide">Error</span>
                  </div>
                  <pre className="p-3 text-sm overflow-x-auto bg-danger/10 max-h-48">
                    <code className="text-danger font-mono whitespace-pre-wrap">{details.error}</code>
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="text-center text-text-muted text-sm py-4">Failed to load details</div>
          )}
        </div>
      )}
    </div>
  );
};

// ============ InvocationsPanel ============

interface InvocationsPanelProps {
  invocations: TaskInvocation[] | undefined;
  taskId: string;
  projectPath: string;
}

export const InvocationsPanel: React.FC<InvocationsPanelProps> = ({ invocations, taskId, projectPath }) => {
  const count = invocations?.length || 0;
  const [collapsed, setCollapsed] = useState(false);

  if (!invocations || invocations.length === 0) return null;

  return (
    <div className="mb-6">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between mb-3 group"
      >
        <h2 className="text-lg font-semibold text-text-primary">
          <i className="fa-solid fa-robot mr-2"></i>
          Agent Sessions
          <span className="text-sm font-normal text-text-muted ml-2">({count})</span>
        </h2>
        <i className={`fa-solid ${collapsed ? 'fa-chevron-down' : 'fa-chevron-up'} text-text-muted group-hover:text-text-primary transition-colors`}></i>
      </button>
      {!collapsed && (
        <div className="space-y-2">
          {invocations
            .slice()
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .map((inv) => (
              <InvocationCard
                key={`invocation-${inv.id}`}
                invocation={inv}
                taskId={taskId}
                projectPath={projectPath}
              />
            ))}
        </div>
      )}
    </div>
  );
};

// ============ DisputePanel ============

interface DisputePanelProps {
  status: string;
  rejectionCount: number;
  disputes: TaskDispute[];
  auditTrail: AuditEntry[];
  restartNotes: string;
  onNotesChange: (notes: string) => void;
  onRestart: (notes: string) => void;
  restarting: boolean;
}

export const DisputePanel: React.FC<DisputePanelProps> = ({
  status, rejectionCount, disputes, auditTrail, restartNotes, onNotesChange, onRestart, restarting,
}) => {
  const openDisputes = disputes.filter(d => d.status === 'open');
  const isZeroOutputTimeout = auditTrail.some(e => e.error_code === 'REVIEWER_ZERO_OUTPUT_TIMEOUT');

  return (
    <div className="card border-2 border-danger/30 p-5 mb-6">
      <h3 className="text-lg font-semibold text-danger mb-3">
        <i className="fa-solid fa-triangle-exclamation mr-2"></i>
        {status === 'disputed' ? 'Task Disputed' : 'Task Failed'}
        {status === 'failed' && ` (${rejectionCount} rejections)`}
      </h3>
      {isZeroOutputTimeout && (
        <div className="mb-4 p-4 bg-warning/10 border border-warning/40 rounded-lg">
          <div className="flex items-start gap-3">
            <i className="fa-solid fa-terminal text-warning mt-0.5 flex-shrink-0"></i>
            <div className="text-sm">
              <p className="font-semibold text-warning mb-1">Reviewer CLI blocked by interactive setup prompt</p>
              <p className="text-text-secondary mb-2">
                The reviewer timed out with zero output on every attempt. This means the CLI is waiting
                for interactive input it can never receive — typically a first-run machine/toolchain
                setup prompt (e.g. Claude Code onboarding).
              </p>
              <p className="text-text-secondary font-medium">Fix: open a terminal and run the reviewer CLI once manually to complete setup, then restart this task.</p>
            </div>
          </div>
        </div>
      )}
      {openDisputes.length > 0 && (
        <div className="mb-4 space-y-3">
          {openDisputes.map(d => (
            <div key={d.id} className="p-3 bg-bg-base rounded-lg text-sm border border-border">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="danger">{d.type}</Badge>
                <span className="text-text-muted">{d.reason}</span>
              </div>
              {d.coder_position && (
                <div className="mb-1">
                  <span className="text-text-muted font-medium">Coder: </span>
                  <span className="text-text-secondary">{d.coder_position}</span>
                </div>
              )}
              {d.reviewer_position && (
                <div>
                  <span className="text-text-muted font-medium">Reviewer: </span>
                  <span className="text-text-secondary">{d.reviewer_position}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="space-y-3">
        <label className="block text-sm font-medium text-text-primary">
          <i className="fa-solid fa-pen mr-1"></i>
          Your guidance (will be shown to the coder)
        </label>
        <textarea
          value={restartNotes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="Tell the coder what to do differently..."
          rows={3}
          className="w-full px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary placeholder-text-muted text-sm focus:outline-none focus:border-accent resize-y"
        />
        <button
          onClick={() => onRestart(restartNotes)}
          disabled={restarting}
          className="px-5 py-2 bg-accent hover:bg-accent/80 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {restarting ? (
            <>
              <i className="fa-solid fa-spinner fa-spin"></i>
              Restarting...
            </>
          ) : (
            <>
              <i className="fa-solid fa-rotate-right mr-1"></i>
              Restart Task
            </>
          )}
        </button>
      </div>
    </div>
  );
};
