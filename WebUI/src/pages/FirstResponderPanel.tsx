/**
 * First Responder panel — shows monitor-generated feedback for a task.
 * Separated from TaskDetailComponents to keep files under 500 lines.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { taskFeedbackApi, type TaskFeedback } from '../services/taskFeedbackApi';

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

function getFirstLines(text: string, n: number): { preview: string; hasMore: boolean } {
  const lines = text.split('\n');
  if (lines.length <= n) return { preview: text, hasMore: false };
  return { preview: lines.slice(0, n).join('\n'), hasMore: true };
}

interface FirstResponderPanelProps {
  taskId: string;
  projectPath: string;
}

export const FirstResponderPanel: React.FC<FirstResponderPanelProps> = ({ taskId, projectPath }) => {
  const [entries, setEntries] = useState<TaskFeedback[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const all = await taskFeedbackApi.list(taskId, projectPath);
      setEntries(all.filter((f) => f.source !== 'user'));
    } catch { /* ignore */ }
  }, [taskId, projectPath]);

  useEffect(() => { load(); }, [load]);

  if (entries.length === 0) return null;

  const toggle = (id: string) =>
    setExpandedIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  return (
    <div className="mb-6">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between mb-3 group"
      >
        <h2 className="text-lg font-semibold text-text-primary">
          <i className="fa-solid fa-tower-broadcast mr-2"></i>
          First Responder
          <span className="text-sm font-normal text-text-muted ml-2">({entries.length})</span>
        </h2>
        <i className={`fa-solid ${collapsed ? 'fa-chevron-down' : 'fa-chevron-up'} text-text-muted group-hover:text-text-primary transition-colors`}></i>
      </button>
      {!collapsed && (
        <div className="space-y-2">
          {entries.map((entry) => {
            const isExpanded = expandedIds.has(entry.id);
            const { preview, hasMore } = getFirstLines(entry.feedback, 3);
            return (
              <div key={entry.id} className="border-l-4 border-accent rounded-lg overflow-hidden bg-bg-base">
                <button
                  onClick={() => toggle(entry.id)}
                  className="w-full p-3 flex items-start gap-3 hover:bg-bg-surface transition-colors text-left"
                >
                  <div className="flex-shrink-0 w-7 h-7 rounded-full bg-accent/10 flex items-center justify-center">
                    <i className="fa-solid fa-tower-broadcast text-accent text-xs"></i>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-text-primary text-sm">Monitor First Responder</span>
                      <a href="/monitor" onClick={(e) => e.stopPropagation()} className="text-xs text-accent hover:underline">
                        <i className="fa-solid fa-arrow-up-right-from-square mr-1"></i>View runs
                      </a>
                    </div>
                    <div className="mt-1 text-xs text-text-muted">
                      <i className="fa-regular fa-clock mr-1"></i>
                      {formatTimestamp(entry.created_at)}
                    </div>
                  </div>
                  <i className={`fa-solid ${isExpanded ? 'fa-chevron-up' : 'fa-chevron-down'} text-text-muted flex-shrink-0 mt-1`}></i>
                </button>
                <div className="px-3 pb-3">
                  <pre className="text-sm overflow-x-auto bg-bg-surface rounded-lg p-3 max-h-96">
                    <code className="text-text-secondary font-mono whitespace-pre-wrap">
                      {isExpanded ? entry.feedback : preview}
                      {!isExpanded && hasMore && <span className="text-text-muted"> ...</span>}
                    </code>
                  </pre>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
