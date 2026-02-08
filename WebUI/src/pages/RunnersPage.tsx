import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { runnersApi, ApiError } from '../services/api';
import { Runner } from '../types';
import { Badge } from '../components/atoms/Badge';
import { Button } from '../components/atoms/Button';

function getStatusBadgeVariant(status: string) {
  const s = status.toLowerCase();
  if (s === 'running' || s === 'active') return 'success';
  if (s === 'idle') return 'warning';
  return 'default';
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);

  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

export const RunnersPage: React.FC = () => {
  const navigate = useNavigate();
  const [runners, setRunners] = useState<Runner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRunners = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await runnersApi.list();
      setRunners(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load runners');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRunners();
    const interval = setInterval(loadRunners, 5000);
    return () => clearInterval(interval);
  }, []);

  const activeRunners = runners.filter(
    (r) => r.status === 'running' || r.status === 'active'
  );
  const idleRunners = runners.filter(
    (r) => r.status !== 'running' && r.status !== 'active'
  );

  if (loading && runners.length === 0) {
    return (
      <div className="p-8">
        <div className="text-center">
          <div className="text-gray-500">Loading runners...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Runners</h1>
          <p className="text-gray-600 mt-1">
            {activeRunners.length} active, {idleRunners.length} idle
          </p>
        </div>
        <Button size="sm" onClick={loadRunners}>
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-800">
            <strong>Error:</strong> {error}
          </p>
        </div>
      )}

      {runners.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg">No runners registered</p>
          <p className="text-gray-400 mt-2">
            Start a runner with{' '}
            <code className="bg-gray-100 px-2 py-1 rounded">steroids loop</code>
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {runners.map((runner) => (
            <div
              key={runner.id}
              className="bg-white rounded-lg shadow-sm border border-gray-200 p-4"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <h3 className="text-lg font-semibold text-gray-900">
                      {runner.project_name || (runner.project_path ? runner.project_path.split('/').pop() : 'Unknown Project')}
                    </h3>
                    <Badge variant={getStatusBadgeVariant(runner.status)}>
                      {runner.status.charAt(0).toUpperCase() + runner.status.slice(1)}
                    </Badge>
                  </div>

                  <p className="text-sm text-gray-500 mt-1">
                    Runner: {runner.id.slice(0, 8)}
                    {runner.pid && <span className="ml-2">(PID {runner.pid})</span>}
                  </p>

                  {runner.current_task_id && runner.project_path && (
                    <div
                      className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-100 cursor-pointer hover:bg-blue-100 transition-colors"
                      onClick={() => navigate(`/task/${runner.current_task_id}?project=${encodeURIComponent(runner.project_path!)}`)}
                    >
                      <p className="text-sm text-blue-800">
                        <i className="fa-solid fa-arrow-up-right-from-square text-xs mr-2"></i>
                        <span className="font-medium">Current Task:</span>{' '}
                        {runner.current_task_title || runner.current_task_id.slice(0, 8)}
                      </p>
                    </div>
                  )}
                </div>

                <div className="text-right text-sm text-gray-500">
                  <p>Heartbeat: {formatTimeAgo(runner.heartbeat_at)}</p>
                  {runner.started_at && (
                    <p>Started: {formatTimeAgo(runner.started_at)}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-8 text-center text-sm text-gray-500">
        {runners.length} runner{runners.length !== 1 ? 's' : ''} registered
      </div>
    </div>
  );
};

export default RunnersPage;
