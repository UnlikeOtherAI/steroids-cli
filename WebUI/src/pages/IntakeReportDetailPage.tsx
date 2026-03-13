import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageLayout } from '../components/templates/PageLayout';
import type { Project } from '../types';
import type { ConnectorHealth, IntakeReport, IntakeSeverity, IntakeSource, IntakeStatus } from './intakePageData';
import {
  IntakePipelineStep,
  IntakeReportDetailData,
  loadIntakeReportDetailData,
  updateIntakeReportStatus,
} from './intakeReportDetailData';

const STATUS_LABELS: Record<IntakeStatus, string> = {
  open: 'Open',
  triaged: 'Triaged',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  ignored: 'Ignored',
};

const SEVERITY_LABELS: Record<IntakeSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

const SOURCE_LABELS: Record<IntakeSource, string> = {
  github: 'GitHub',
  sentry: 'Sentry',
};

export interface IntakeReportDetailPageProps {
  project?: Project | null;
  source?: IntakeSource;
  externalId?: string;
  loader?: (projectPath: string, source: IntakeSource, externalId: string) => Promise<IntakeReportDetailData>;
  updateStatus?: (
    projectPath: string,
    source: IntakeSource,
    externalId: string,
    status: IntakeStatus,
    resolvedAt?: string | null
  ) => Promise<IntakeReport>;
}

function formatDateTime(value?: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function statusBadgeClass(status: IntakeStatus | ConnectorHealth['status']): string {
  switch (status) {
    case 'resolved':
    case 'healthy':
      return 'badge-success';
    case 'triaged':
    case 'idle':
      return 'badge-warning';
    case 'in_progress':
      return 'badge-info';
    case 'open':
    case 'error':
      return 'badge-danger';
    case 'ignored':
    case 'disabled':
    case 'unsupported':
      return 'badge-accent';
    default:
      return 'badge-accent';
  }
}

function severityBadgeClass(severity: IntakeSeverity): string {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'badge-danger';
    case 'medium':
      return 'badge-warning';
    case 'low':
      return 'badge-info';
    case 'info':
      return 'badge-accent';
    default:
      return 'badge-accent';
  }
}

function stepClasses(state: IntakePipelineStep['state']): string {
  switch (state) {
    case 'complete':
      return 'border-success bg-success/10 text-success';
    case 'current':
      return 'border-accent bg-accent/10 text-accent';
    case 'pending':
      return 'border-border-subtle bg-bg-surface text-text-muted';
    default:
      return 'border-border-subtle bg-bg-surface text-text-muted';
  }
}

function renderMissingState(message: string) {
  return (
    <div className="card p-8 text-center text-text-muted">
      {message}
    </div>
  );
}

export const IntakeReportDetailPage: React.FC<IntakeReportDetailPageProps> = ({
  project,
  source: sourceOverride,
  externalId: externalIdOverride,
  loader = loadIntakeReportDetailData,
  updateStatus = updateIntakeReportStatus,
}) => {
  const params = useParams<{ source: string; externalId: string }>();
  const navigate = useNavigate();
  const source = (sourceOverride ?? params.source) as IntakeSource | undefined;
  const externalId = externalIdOverride ?? params.externalId;

  const [data, setData] = useState<IntakeReportDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => {
    let active = true;

    async function fetchData() {
      if (!project?.path || !source || !externalId) {
        setData(null);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const result = await loader(project.path, source, externalId);
        if (active) {
          setData(result);
        }
      } catch (err) {
        if (active) {
          setData(null);
          setError(err instanceof Error ? err.message : 'Failed to load intake report');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    fetchData();
    return () => {
      active = false;
    };
  }, [externalId, loader, project?.path, source]);

  async function handleStatusUpdate(nextAction: 'approve' | 'reject') {
    if (!project?.path || !source || !externalId || !data) return;

    setPendingAction(nextAction);
    setActionError(null);

    const nextStatus: IntakeStatus = nextAction === 'approve' ? 'resolved' : 'ignored';
    const resolvedAt = new Date().toISOString();

    try {
      const report = await updateStatus(project.path, source, externalId, nextStatus, resolvedAt);
      setData({
        ...data,
        report,
        pipeline: {
          ...data.pipeline,
          steps: data.pipeline.steps.map((step) => ({ ...step, state: 'complete' })),
          outcomeLabel: STATUS_LABELS[nextStatus],
        },
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update intake report');
    } finally {
      setPendingAction(null);
    }
  }

  if (!project?.path) {
    return (
      <PageLayout title="Intake Report" backTo={() => navigate(-1)} maxWidth="max-w-5xl">
        {renderMissingState('Select a project before opening intake report details.')}
      </PageLayout>
    );
  }

  if (!source || !externalId) {
    return (
      <PageLayout title="Intake Report" backTo={() => navigate(-1)} maxWidth="max-w-5xl">
        {renderMissingState('This page requires both an intake source and external report ID.')}
      </PageLayout>
    );
  }

  const report = data?.report;
  const connector = data?.connector;
  const canApprove = report && report.status !== 'resolved';
  const canReject = report && report.status !== 'ignored';

  return (
    <PageLayout
      title={report?.title ?? `Intake report ${source}#${externalId}`}
      titleSuffix={project.name ? `for ${project.name}` : undefined}
      subtitle={report ? `${SOURCE_LABELS[report.source]} report #${report.externalId}` : undefined}
      backTo={() => navigate(-1)}
      backLabel="Back"
      loading={loading}
      loadingMessage="Loading intake report..."
      error={error}
      maxWidth="max-w-5xl"
      actions={
        report && (
          <>
            <button
              type="button"
              onClick={() => handleStatusUpdate('approve')}
              disabled={!canApprove || pendingAction !== null}
              className="btn-pill disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pendingAction === 'approve' ? 'Approving...' : 'Approve'}
            </button>
            <button
              type="button"
              onClick={() => handleStatusUpdate('reject')}
              disabled={!canReject || pendingAction !== null}
              className="px-4 py-2 rounded-full border border-border-subtle text-text-primary hover:bg-bg-surface disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pendingAction === 'reject' ? 'Rejecting...' : 'Reject'}
            </button>
          </>
        )
      }
    >
      {report && data && (
        <div className="space-y-6">
          <section className="card p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <span className={severityBadgeClass(report.severity)}>{SEVERITY_LABELS[report.severity]}</span>
                  <span className={statusBadgeClass(report.status)}>{STATUS_LABELS[report.status]}</span>
                  {data.pipeline.outcomeLabel && (
                    <span className="badge-success">{data.pipeline.outcomeLabel}</span>
                  )}
                </div>

                <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                  <div>
                    <dt className="text-text-muted">Report ID</dt>
                    <dd className="text-text-primary font-medium">{report.source}#{report.externalId}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">Linked task</dt>
                    <dd className="text-text-primary font-medium">
                      {report.linkedTaskId ? (
                        <Link
                          to={`/task/${encodeURIComponent(report.linkedTaskId)}?project=${encodeURIComponent(project.path)}`}
                          className="text-accent hover:underline"
                        >
                          {report.linkedTaskId}
                        </Link>
                      ) : (
                        'Unlinked'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">Created</dt>
                    <dd className="text-text-primary font-medium">{formatDateTime(report.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">Updated</dt>
                    <dd className="text-text-primary font-medium">{formatDateTime(report.updatedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">Resolved</dt>
                    <dd className="text-text-primary font-medium">{formatDateTime(report.resolvedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">External link</dt>
                    <dd>
                      <a href={report.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        Open source report
                      </a>
                    </dd>
                  </div>
                </dl>
              </div>

              {connector && (
                <aside className="min-w-[260px] rounded-xl bg-bg-surface p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.08em] text-text-muted">Connector</div>
                      <div className="text-lg font-semibold text-text-primary">
                        {SOURCE_LABELS[connector.source]}
                      </div>
                    </div>
                    <span className={statusBadgeClass(connector.status)}>
                      {connector.status.replace('_', ' ')}
                    </span>
                  </div>
                  <p className="mt-3 text-sm text-text-muted">{connector.reason}</p>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-text-muted">Open reports</dt>
                      <dd className="text-text-primary font-medium">{connector.stats.openReports}</dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">Linked</dt>
                      <dd className="text-text-primary font-medium">{connector.stats.linkedReports}</dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">Last success</dt>
                      <dd className="text-text-primary font-medium">{formatDateTime(connector.pollState?.lastSuccessAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">Last error</dt>
                      <dd className="text-text-primary font-medium">{formatDateTime(connector.pollState?.lastErrorAt)}</dd>
                    </div>
                  </dl>
                </aside>
              )}
            </div>

            {report.summary && (
              <div className="mt-5 rounded-xl bg-bg-surface px-4 py-3 text-sm text-text-secondary">
                {report.summary}
              </div>
            )}

            {report.tags.length > 0 && (
              <div className="mt-5 flex flex-wrap gap-2">
                {report.tags.map((tag: string) => (
                  <span key={tag} className="px-2.5 py-1 rounded-full bg-bg-surface text-xs text-text-secondary">
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {actionError && (
              <div className="mt-5 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger">
                {actionError}
              </div>
            )}
          </section>

          <section className="card p-6">
            <div className="mb-5">
              <h2 className="text-xl font-semibold text-text-primary">Pipeline Progress</h2>
              <p className="mt-1 text-sm text-text-muted">
                Progress is derived from the report status and any recorded pipeline payload attached to this report.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {data.pipeline.steps.map((step) => (
                <article key={step.phase} className={`rounded-xl border p-4 ${stepClasses(step.state)}`}>
                  <div className="text-xs uppercase tracking-[0.08em]">{step.state}</div>
                  <div className="mt-2 text-lg font-semibold">{step.label}</div>
                </article>
              ))}
            </div>
          </section>

          <section className="card p-6">
            <div className="mb-5">
              <h2 className="text-xl font-semibold text-text-primary">Phase Outputs</h2>
              <p className="mt-1 text-sm text-text-muted">
                Recorded phase output is shown directly from the intake payload when available.
              </p>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              {data.pipeline.steps.map((step) => {
                const output = data.pipeline.outputs.find((entry) => entry.phase === step.phase);
                return (
                  <article key={step.phase} className="rounded-xl bg-bg-surface p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-text-primary">{step.label}</h3>
                        <p className="mt-1 text-sm text-text-muted">
                          {output ? `Status: ${output.status}` : 'No recorded output yet.'}
                        </p>
                      </div>
                      <span className={stepClasses(step.state)}>{step.state}</span>
                    </div>

                    {output ? (
                      <dl className="mt-4 space-y-3 text-sm">
                        {output.summary && (
                          <div>
                            <dt className="text-text-muted">Summary</dt>
                            <dd className="text-text-primary">{output.summary}</dd>
                          </div>
                        )}
                        {output.comment && (
                          <div>
                            <dt className="text-text-muted">Comment</dt>
                            <dd className="text-text-primary">{output.comment}</dd>
                          </div>
                        )}
                        {output.decision && (
                          <div>
                            <dt className="text-text-muted">Decision</dt>
                            <dd className="text-text-primary">{output.decision}</dd>
                          </div>
                        )}
                        {output.resolutionCode && (
                          <div>
                            <dt className="text-text-muted">Resolution</dt>
                            <dd className="text-text-primary">{output.resolutionCode}</dd>
                          </div>
                        )}
                        {output.nextTaskTitle && (
                          <div>
                            <dt className="text-text-muted">Next task</dt>
                            <dd className="text-text-primary">{output.nextTaskTitle}</dd>
                          </div>
                        )}
                        {(output.taskId || output.taskTitle) && (
                          <div>
                            <dt className="text-text-muted">Pipeline task</dt>
                            <dd className="text-text-primary">{output.taskTitle ?? output.taskId}</dd>
                          </div>
                        )}
                        {output.updatedAt && (
                          <div>
                            <dt className="text-text-muted">Recorded at</dt>
                            <dd className="text-text-primary">{formatDateTime(output.updatedAt)}</dd>
                          </div>
                        )}
                      </dl>
                    ) : (
                      <div className="mt-4 rounded-lg border border-dashed border-border-subtle px-4 py-6 text-sm text-text-muted">
                        This phase has no structured output stored in the intake payload yet.
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </PageLayout>
  );
};

export default IntakeReportDetailPage;
