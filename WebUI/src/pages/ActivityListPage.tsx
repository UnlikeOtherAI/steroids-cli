import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ActivityLogEntry, ActivityStatusType, TIME_RANGE_OPTIONS, TimeRangeOption } from '../types';
import { activityApi } from '../services/api';
import { TimeRangeSelector } from '../components/molecules/TimeRangeSelector';
import { Badge } from '../components/atoms/Badge';

const STATUS_LABELS: Record<ActivityStatusType, string> = {
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  partial: 'Partial',
  disputed: 'Disputed',
};

const STATUS_VARIANTS: Record<ActivityStatusType, 'success' | 'danger' | 'warning' | 'info' | 'default'> = {
  completed: 'success',
  failed: 'danger',
  skipped: 'warning',
  partial: 'info',
  disputed: 'default',
};

function truncateMiddle(str: string, maxLen: number = 40): string {
  if (str.length <= maxLen) return str;
  const ellipsis = '...';
  const charsToShow = maxLen - ellipsis.length;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);
  return str.slice(0, frontChars) + ellipsis + str.slice(-backChars);
}

export const ActivityListPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const statusParam = searchParams.get('status') as ActivityStatusType | null;
  const hoursParam = searchParams.get('hours');
  const projectParam = searchParams.get('project');

  const initialHours = hoursParam ? parseInt(hoursParam, 10) : 24;
  const initialRange = TIME_RANGE_OPTIONS.find(o => o.hours === initialHours) || TIME_RANGE_OPTIONS[1];

  const [selectedRange, setSelectedRange] = useState<TimeRangeOption>(initialRange);
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await activityApi.list({
        hours: selectedRange.hours,
        status: statusParam || undefined,
        projectPath: projectParam || undefined,
      });
      setEntries(response.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load activity');
    } finally {
      setLoading(false);
    }
  }, [selectedRange.hours, statusParam, projectParam]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleRangeChange = (range: TimeRangeOption) => {
    setSelectedRange(range);
    const params = new URLSearchParams(searchParams);
    params.set('hours', range.hours.toString());
    navigate(`?${params.toString()}`, { replace: true });
  };

  const handleStatusFilter = (status: ActivityStatusType | null) => {
    const params = new URLSearchParams(searchParams);
    if (status) {
      params.set('status', status);
    } else {
      params.delete('status');
    }
    navigate(`?${params.toString()}`, { replace: true });
  };

  const projectName = projectParam ? projectParam.split('/').pop() : null;
  const pageTitle = statusParam ? `${STATUS_LABELS[statusParam]} Tasks` : 'All Activity';
  const pageSubtitle = projectName ? `in ${projectName}` : null;

  const handleClearProject = () => {
    const params = new URLSearchParams(searchParams);
    params.delete('project');
    navigate(`?${params.toString()}`, { replace: true });
  };

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-text-primary">
            {pageTitle}
            {pageSubtitle && <span className="text-text-muted font-normal text-xl ml-2">{pageSubtitle}</span>}
          </h1>
          <p className="text-text-muted mt-1">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'} in last {selectedRange.label}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {projectParam && (
            <button
              onClick={handleClearProject}
              className="px-3 py-1 text-sm bg-bg-surface text-text-secondary hover:text-text-primary rounded transition-colors"
            >
              <i className="fa-solid fa-times mr-1"></i>
              Clear project filter
            </button>
          )}
          <TimeRangeSelector value={selectedRange.value} onChange={handleRangeChange} />
        </div>
      </div>

      <div className="flex gap-2 mb-6 flex-wrap">
        <button
          onClick={() => handleStatusFilter(null)}
          className={`px-3 py-1 text-sm rounded-full transition-all ${
            !statusParam
              ? 'bg-accent text-white'
              : 'bg-bg-surface text-text-secondary hover:text-text-primary'
          }`}
        >
          All
        </button>
        {(Object.keys(STATUS_LABELS) as ActivityStatusType[]).map((status) => (
          <button
            key={status}
            onClick={() => handleStatusFilter(status)}
            className={`px-3 py-1 text-sm rounded-full transition-all ${
              statusParam === status
                ? 'bg-accent text-white'
                : 'bg-bg-surface text-text-secondary hover:text-text-primary'
            }`}
          >
            {STATUS_LABELS[status]}
          </button>
        ))}
      </div>

      {loading && (
        <div className="text-center py-8 text-text-muted">Loading...</div>
      )}

      {error && (
        <div className="text-center py-8 text-danger">{error}</div>
      )}

      {!loading && !error && entries.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-text-muted">No activity found for the selected filters</p>
        </div>
      )}

      {!loading && !error && entries.length > 0 && (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.id}
              onClick={() => navigate(`/task/${entry.task_id}?project=${encodeURIComponent(entry.project_path)}`)}
              className="card p-4 flex items-center gap-4 cursor-pointer hover:border-accent transition-colors"
            >
              <Badge variant={STATUS_VARIANTS[entry.final_status]}>
                {STATUS_LABELS[entry.final_status]}
              </Badge>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-text-primary truncate">
                  <i className="fa-solid fa-arrow-up-right-from-square text-xs text-text-muted mr-2"></i>
                  {entry.task_title}
                </div>
                {entry.commit_message && (
                  <div className="text-sm text-text-secondary mt-1 flex items-center gap-2">
                    <span className="line-clamp-1 flex-1">
                      <i className="fa-solid fa-code-commit text-xs text-text-muted mr-1"></i>
                      {entry.commit_message.split('\n')[0]}
                    </span>
                    {entry.commit_sha && (
                      entry.github_url ? (
                        <a
                          href={`${entry.github_url}/commit/${entry.commit_sha}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-accent transition-colors shrink-0"
                        >
                          <i className="fa-brands fa-github"></i>
                          <code className="bg-bg-surface px-1 rounded">{entry.commit_sha.slice(0, 7)}</code>
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-text-muted shrink-0">
                          <i className="fa-solid fa-code-commit"></i>
                          <code className="bg-bg-surface px-1 rounded">{entry.commit_sha.slice(0, 7)}</code>
                        </span>
                      )
                    )}
                  </div>
                )}
                <div className="text-xs text-text-muted flex gap-2 mt-1">
                  <span title={entry.project_path} className="cursor-help">
                    {truncateMiddle(entry.project_path, 30)}
                  </span>
                  {entry.section_name && (
                    <>
                      <span className="text-text-muted">|</span>
                      <span>{entry.section_name}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="text-sm text-text-muted whitespace-nowrap">
                {new Date(entry.created_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
