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

// ============ InvocationRow ============

interface InvocationRowProps {
  invocation: TaskInvocation;
  taskId: string;
  projectPath: string;
}

interface InvocationDetails {
  prompt: string;
  response: string | null;
  error: string | null;
}

export const InvocationRow: React.FC<InvocationRowProps> = ({ invocation, taskId, projectPath }) => {
  const [showModal, setShowModal] = useState(false);
  const [details, setDetails] = useState<InvocationDetails | null>(null);
  const [loading, setLoading] = useState(false);

  const isSuccess = invocation.success === 1;
  const isTimedOut = invocation.timed_out === 1;
  const isCoder = invocation.role === 'coder';

  let borderColor = 'border-success';
  if (isTimedOut) borderColor = 'border-warning';
  else if (!isSuccess) borderColor = 'border-danger';

  const provider = invocation.provider.charAt(0).toUpperCase() + invocation.provider.slice(1);

  const handleClick = async () => {
    setShowModal(true);
    if (!details) {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/tasks/${taskId}/invocations/${invocation.id}?project=${encodeURIComponent(projectPath)}`
        );
        const data = await response.json();
        if (data.success) {
          setDetails({
            prompt: data.invocation.prompt,
            response: data.invocation.response,
            error: data.invocation.error,
          });
        }
      } catch (error) {
        console.error('Failed to fetch invocation details:', error);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <>
      <div
        className={`p-3 border-l-4 ${borderColor} bg-bg-base cursor-pointer hover:bg-bg-surface transition-colors`}
        onClick={handleClick}
      >
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-7 h-7 rounded-full bg-bg-surface flex items-center justify-center">
            <i className={`fa-solid ${isCoder ? 'fa-code' : 'fa-magnifying-glass'} text-text-muted text-xs`}></i>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-text-primary text-sm capitalize">{invocation.role}</span>
              <span className="text-text-muted text-xs">{provider} / {invocation.model}</span>
              {isSuccess ? (
                <Badge variant="success">OK</Badge>
              ) : isTimedOut ? (
                <Badge variant="warning">Timed Out</Badge>
              ) : (
                <Badge variant="danger">Failed (exit {invocation.exit_code})</Badge>
              )}
              {isCoder && invocation.rejection_number !== null && invocation.rejection_number > 0 && (
                <span className="text-xs text-warning">
                  <i className="fa-solid fa-rotate-left mr-1"></i>
                  Attempt #{invocation.rejection_number}
                </span>
              )}
              <span className="text-xs text-accent ml-auto">
                <i className="fa-solid fa-eye mr-1"></i>
                Click to view details
              </span>
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
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowModal(false)}>
          <div className="bg-bg-base rounded-lg max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-border flex items-center justify-between">
              <h2 className="text-xl font-bold text-text-primary">
                <i className={`fa-solid ${isCoder ? 'fa-code' : 'fa-magnifying-glass'} mr-2`}></i>
                {invocation.role.toUpperCase()} Invocation Details
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="w-8 h-8 rounded-full hover:bg-bg-surface flex items-center justify-center transition-colors"
              >
                <i className="fa-solid fa-times text-text-muted"></i>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <i className="fa-solid fa-spinner fa-spin text-accent text-2xl"></i>
                </div>
              ) : details ? (
                <>
                  <div>
                    <h3 className="text-sm font-semibold text-text-muted mb-2">
                      <i className="fa-solid fa-file-lines mr-2"></i>
                      PROMPT ({details.prompt.length.toLocaleString()} chars)
                    </h3>
                    <pre className="bg-bg-surface p-4 rounded-lg text-sm overflow-x-auto border border-border">
                      <code className="text-text-secondary font-mono whitespace-pre-wrap">{details.prompt}</code>
                    </pre>
                  </div>

                  {details.response && (
                    <div>
                      <h3 className="text-sm font-semibold text-text-muted mb-2">
                        <i className="fa-solid fa-reply mr-2"></i>
                        RESPONSE ({details.response.length.toLocaleString()} chars)
                      </h3>
                      <pre className="bg-bg-surface p-4 rounded-lg text-sm overflow-x-auto border border-border">
                        <code className="text-text-secondary font-mono whitespace-pre-wrap">{details.response}</code>
                      </pre>
                    </div>
                  )}

                  {details.error && (
                    <div>
                      <h3 className="text-sm font-semibold text-danger mb-2">
                        <i className="fa-solid fa-triangle-exclamation mr-2"></i>
                        ERROR
                      </h3>
                      <pre className="bg-danger/10 p-4 rounded-lg text-sm overflow-x-auto border border-danger/20">
                        <code className="text-danger font-mono whitespace-pre-wrap">{details.error}</code>
                      </pre>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

// ============ DisputePanel ============

interface DisputePanelProps {
  status: string;
  rejectionCount: number;
  disputes: TaskDispute[];
  restartNotes: string;
  onNotesChange: (notes: string) => void;
  onRestart: (notes: string) => void;
  restarting: boolean;
}

export const DisputePanel: React.FC<DisputePanelProps> = ({
  status, rejectionCount, disputes, restartNotes, onNotesChange, onRestart, restarting,
}) => {
  const openDisputes = disputes.filter(d => d.status === 'open');

  return (
    <div className="card border-2 border-danger/30 p-5 mb-6">
      <h3 className="text-lg font-semibold text-danger mb-3">
        <i className="fa-solid fa-triangle-exclamation mr-2"></i>
        {status === 'disputed' ? 'Task Disputed' : 'Task Failed'}
        {status === 'failed' && ` (${rejectionCount} rejections)`}
      </h3>
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
