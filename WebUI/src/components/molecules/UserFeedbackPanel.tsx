import React, { useCallback, useEffect, useState } from 'react';
import { taskFeedbackApi, type TaskFeedback } from '../../services/taskFeedbackApi';

interface UserFeedbackPanelProps {
  taskId: string;
  projectPath: string;
}

export const UserFeedbackPanel: React.FC<UserFeedbackPanelProps> = ({ taskId, projectPath }) => {
  const [feedback, setFeedback] = useState<TaskFeedback[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadFeedback = useCallback(async () => {
    setLoading(true);
    try {
      const all = await taskFeedbackApi.list(taskId, projectPath);
      const items = all.filter((f) => f.source === 'user');
      setFeedback(items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load feedback');
    } finally {
      setLoading(false);
    }
  }, [projectPath, taskId]);

  useEffect(() => {
    loadFeedback();
  }, [loadFeedback]);

  const handleCreate = async () => {
    const text = draft.trim();
    if (!text || submitting) return;

    setSubmitting(true);
    try {
      const created = await taskFeedbackApi.create(taskId, projectPath, text);
      setFeedback((prev) => [created, ...prev]);
      setDraft('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save feedback');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (feedbackId: string) => {
    if (deletingId) return;
    setDeletingId(feedbackId);
    try {
      await taskFeedbackApi.delete(taskId, feedbackId, projectPath);
      setFeedback((prev) => prev.filter((item) => item.id !== feedbackId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete feedback');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="card p-4 mb-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-lg font-semibold text-text-primary">
          <i className="fa-solid fa-message mr-2"></i>
          User Feedback
        </h2>
        <button
          type="button"
          onClick={loadFeedback}
          disabled={loading}
          className="px-2.5 py-1 text-xs bg-bg-surface2 text-text-muted hover:text-text-primary rounded transition-colors disabled:opacity-60"
        >
          <i className={`fa-solid ${loading ? 'fa-spinner fa-spin' : 'fa-refresh'} mr-1`}></i>
          Refresh
        </button>
      </div>

      <p className="text-sm text-text-muted mb-3">
        Add guidance for the next coder/reviewer attempt on this task.
      </p>

      <div className="flex flex-col gap-2 mb-4">
        <textarea
          className="w-full h-24 rounded-lg border border-border bg-bg-surface2 p-3 text-sm text-text-primary resize-y"
          placeholder="Add task-specific notes..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleCreate}
            disabled={submitting || !draft.trim()}
            className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Saving...' : 'Add Feedback'}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-danger mb-3">
          <i className="fa-solid fa-triangle-exclamation mr-1"></i>
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-text-muted">Loading feedback...</p>
      ) : feedback.length === 0 ? (
        <p className="text-sm text-text-muted">No feedback saved for this task.</p>
      ) : (
        <div className="space-y-2">
          {feedback.map((item) => (
            <div key={item.id} className="border border-border rounded-lg p-3 bg-bg-surface2">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-text-primary whitespace-pre-wrap">{item.feedback}</p>
                <button
                  type="button"
                  onClick={() => handleDelete(item.id)}
                  disabled={deletingId === item.id}
                  className="text-xs text-danger hover:text-danger/80 transition-colors disabled:opacity-60"
                >
                  {deletingId === item.id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
              <p className="text-xs text-text-muted mt-2">
                {new Date(item.created_at).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
