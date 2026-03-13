import React, { useEffect, useMemo, useState } from 'react';
import { PageLayout } from '../components/templates/PageLayout';
import { StatTile } from '../components/molecules/StatTile';
import type { Project } from '../types';
import {
  ConnectorHealth,
  IntakePageData,
  IntakeSeverity,
  IntakeSource,
  IntakeStatus,
  loadIntakePageData,
} from './intakePageData';

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

const FILTER_ALL = 'all';
const FILTER_LINKED = 'linked';
const FILTER_UNLINKED = 'unlinked';

type LinkFilter = typeof FILTER_ALL | typeof FILTER_LINKED | typeof FILTER_UNLINKED;

export interface IntakePageProps {
  project?: Project | null;
  loader?: (projectPath: string) => Promise<IntakePageData>;
}

function formatDateTime(value?: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatRelativeSummary(connectors: ConnectorHealth[]): string {
  const healthyCount = connectors.filter((connector) => connector.status === 'healthy').length;
  return `${healthyCount} of ${connectors.length} connectors healthy`;
}

function statusBadgeClass(status: IntakeStatus | ConnectorHealth['status']): string {
  switch (status) {
    case 'resolved':
      return 'badge-success';
    case 'healthy':
      return 'badge-success';
    case 'triaged':
    case 'idle':
      return 'badge-warning';
    case 'in_progress':
      return 'badge-info';
    case 'error':
      return 'badge-danger';
    case 'ignored':
    case 'disabled':
    case 'unsupported':
      return 'badge-accent';
    case 'open':
      return 'badge-danger';
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

function renderEmptyProjectState() {
  return (
    <div className="card p-8 text-center">
      <h2 className="text-xl font-semibold text-text-primary mb-2">Select a project to view intake</h2>
      <p className="text-text-muted">
        Intake reports are stored per project, so this page requires an active project selection.
      </p>
    </div>
  );
}

export const IntakePage: React.FC<IntakePageProps> = ({
  project,
  loader = loadIntakePageData,
}) => {
  const [data, setData] = useState<IntakePageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<IntakeStatus | typeof FILTER_ALL>(FILTER_ALL);
  const [sourceFilter, setSourceFilter] = useState<IntakeSource | typeof FILTER_ALL>(FILTER_ALL);
  const [severityFilter, setSeverityFilter] = useState<IntakeSeverity | typeof FILTER_ALL>(FILTER_ALL);
  const [linkFilter, setLinkFilter] = useState<LinkFilter>(FILTER_ALL);
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    let active = true;

    async function fetchData() {
      if (!project?.path) {
        setData(null);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const result = await loader(project.path);
        if (active) {
          setData(result);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load intake data');
          setData(null);
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
  }, [loader, project?.path]);

  const filteredReports = useMemo(() => {
    if (!data) return [];

    const normalizedSearch = searchText.trim().toLowerCase();

    return data.reports.filter((report) => {
      if (statusFilter !== FILTER_ALL && report.status !== statusFilter) return false;
      if (sourceFilter !== FILTER_ALL && report.source !== sourceFilter) return false;
      if (severityFilter !== FILTER_ALL && report.severity !== severityFilter) return false;
      if (linkFilter === FILTER_LINKED && !report.linkedTaskId) return false;
      if (linkFilter === FILTER_UNLINKED && report.linkedTaskId) return false;
      if (!normalizedSearch) return true;

      return [
        report.title,
        report.summary ?? '',
        report.externalId,
        report.linkedTaskId ?? '',
        report.tags.join(' '),
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch);
    });
  }, [data, linkFilter, searchText, severityFilter, sourceFilter, statusFilter]);

  const unresolvedCount = data
    ? data.stats.byStatus.open + data.stats.byStatus.triaged + data.stats.byStatus.in_progress
    : 0;
  const criticalCount = data
    ? data.stats.bySeverity.critical + data.stats.bySeverity.high
    : 0;

  return (
    <PageLayout
      title="Intake"
      titleSuffix={project?.name ? `for ${project.name}` : undefined}
      subtitle={data ? `${data.reports.length} reports tracked across external connectors` : undefined}
      loading={loading}
      loadingMessage="Loading intake overview..."
      error={error}
      maxWidth="max-w-7xl"
      actions={
        project?.path ? (
          <button
            type="button"
            className="btn-pill"
            onClick={async () => {
              setLoading(true);
              setError(null);
              try {
                setData(await loader(project.path));
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to refresh intake data');
              } finally {
                setLoading(false);
              }
            }}
          >
            Refresh
          </button>
        ) : undefined
      }
    >
      {!project?.path && renderEmptyProjectState()}

      {project?.path && data && (
        <div className="space-y-6">
          <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <StatTile
              label="Total Reports"
              value={data.stats.total}
              description="All connector reports currently stored"
            />
            <StatTile
              label="Linked To Tasks"
              value={data.stats.linked}
              description={`${data.stats.unlinked} unlinked reports still need routing`}
              variant="info"
            />
            <StatTile
              label="Unresolved"
              value={unresolvedCount}
              description="Open, triaged, or currently in progress"
              variant="warning"
            />
            <StatTile
              label="Critical + High"
              value={criticalCount}
              description="Highest-severity items across all connectors"
              variant="danger"
            />
          </section>

          <section className="card p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between mb-6">
              <div>
                <h2 className="text-xl font-semibold text-text-primary">Reports</h2>
                <p className="text-sm text-text-muted mt-1">
                  Filter external intake reports before drilling into a detail view.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
                <label className="flex flex-col gap-1 text-sm text-text-secondary">
                  Search
                  <input
                    type="text"
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    placeholder="Title, task, tag..."
                    className="px-3 py-2 bg-bg-surface border border-transparent rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </label>

                <label className="flex flex-col gap-1 text-sm text-text-secondary">
                  Source
                  <select
                    value={sourceFilter}
                    onChange={(event) => setSourceFilter(event.target.value as IntakeSource | typeof FILTER_ALL)}
                    className="px-3 py-2 bg-bg-surface border border-transparent rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    <option value={FILTER_ALL}>All sources</option>
                    {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-sm text-text-secondary">
                  Status
                  <select
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value as IntakeStatus | typeof FILTER_ALL)}
                    className="px-3 py-2 bg-bg-surface border border-transparent rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    <option value={FILTER_ALL}>All statuses</option>
                    {Object.entries(STATUS_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-sm text-text-secondary">
                  Severity
                  <select
                    value={severityFilter}
                    onChange={(event) => setSeverityFilter(event.target.value as IntakeSeverity | typeof FILTER_ALL)}
                    className="px-3 py-2 bg-bg-surface border border-transparent rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    <option value={FILTER_ALL}>All severities</option>
                    {Object.entries(SEVERITY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-sm text-text-secondary">
                  Link State
                  <select
                    value={linkFilter}
                    onChange={(event) => setLinkFilter(event.target.value as LinkFilter)}
                    className="px-3 py-2 bg-bg-surface border border-transparent rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    <option value={FILTER_ALL}>All reports</option>
                    <option value={FILTER_LINKED}>Linked only</option>
                    <option value={FILTER_UNLINKED}>Unlinked only</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="flex items-center justify-between mb-4 text-sm text-text-secondary">
              <span>{filteredReports.length} matching reports</span>
              <span>{data.stats.total} total stored</span>
            </div>

            {filteredReports.length === 0 ? (
              <div className="rounded-lg bg-bg-surface p-8 text-center text-text-muted">
                No intake reports match the selected filters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] border-separate border-spacing-y-2">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-[0.08em] text-text-muted">
                      <th className="px-4 py-2">Report</th>
                      <th className="px-4 py-2">Source</th>
                      <th className="px-4 py-2">Severity</th>
                      <th className="px-4 py-2">Status</th>
                      <th className="px-4 py-2">Linked Task</th>
                      <th className="px-4 py-2">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReports.map((report) => (
                      <tr key={`${report.source}:${report.externalId}`} className="bg-bg-surface rounded-lg">
                        <td className="px-4 py-4 rounded-l-lg">
                          <div className="flex flex-col gap-1">
                            <a
                              href={report.url}
                              target="_blank"
                              rel="noreferrer"
                              className="font-semibold text-text-primary hover:text-accent"
                            >
                              {report.title}
                            </a>
                            <span className="text-xs text-text-muted">#{report.externalId}</span>
                            {report.summary && (
                              <p className="text-sm text-text-secondary mb-0">{report.summary}</p>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <span className="badge-accent">{SOURCE_LABELS[report.source]}</span>
                        </td>
                        <td className="px-4 py-4">
                          <span className={severityBadgeClass(report.severity)}>
                            {SEVERITY_LABELS[report.severity]}
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          <span className={statusBadgeClass(report.status)}>
                            {STATUS_LABELS[report.status]}
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          {report.linkedTaskId ? (
                            <code className="text-xs text-text-primary bg-bg-elevated px-2 py-1 rounded-md">
                              {report.linkedTaskId}
                            </code>
                          ) : (
                            <span className="text-sm text-text-muted">Unlinked</span>
                          )}
                        </td>
                        <td className="px-4 py-4 rounded-r-lg text-sm text-text-secondary">
                          {formatDateTime(report.updatedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card p-6">
            <div className="flex items-end justify-between mb-6">
              <div>
                <h2 className="text-xl font-semibold text-text-primary">Connector Health</h2>
                <p className="text-sm text-text-muted mt-1">{formatRelativeSummary(data.connectors)}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {data.connectors.map((connector) => (
                <article key={connector.source} className="rounded-lg bg-bg-surface p-5">
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div>
                      <h3 className="text-lg font-semibold text-text-primary">
                        {SOURCE_LABELS[connector.source]}
                      </h3>
                      <p className="text-sm text-text-muted mt-1">{connector.reason}</p>
                    </div>
                    <span className={statusBadgeClass(connector.status)}>
                      {connector.status.replace('_', ' ')}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <div>
                      <div className="text-xs uppercase tracking-[0.08em] text-text-muted">Reports</div>
                      <div className="text-xl font-semibold text-text-primary">{connector.stats.totalReports}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.08em] text-text-muted">Open</div>
                      <div className="text-xl font-semibold text-text-primary">{connector.stats.openReports}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.08em] text-text-muted">Linked</div>
                      <div className="text-xl font-semibold text-text-primary">{connector.stats.linkedReports}</div>
                    </div>
                  </div>

                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-text-muted">Enabled</dt>
                      <dd className="text-text-primary font-medium">{connector.enabled ? 'Yes' : 'No'}</dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">Implemented</dt>
                      <dd className="text-text-primary font-medium">{connector.implemented ? 'Yes' : 'No'}</dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">Last success</dt>
                      <dd className="text-text-primary font-medium">
                        {formatDateTime(connector.pollState?.lastSuccessAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">Last error</dt>
                      <dd className="text-text-primary font-medium">
                        {formatDateTime(connector.pollState?.lastErrorAt)}
                      </dd>
                    </div>
                  </dl>

                  {connector.configErrors.length > 0 && (
                    <div className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                      {connector.configErrors.join(' ')}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </PageLayout>
  );
};

export default IntakePage;
