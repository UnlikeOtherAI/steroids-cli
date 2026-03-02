import { API_BASE_URL, ApiError } from './api';

export interface TaskFeedback {
  id: string;
  task_id: string;
  feedback: string;
  source: string;
  created_by: string | null;
  created_at: string;
}

interface TaskFeedbackListResponse {
  success: boolean;
  task_id: string;
  feedback: TaskFeedback[];
}

interface TaskFeedbackCreateResponse {
  success: boolean;
  task_id: string;
  feedback: TaskFeedback;
}

async function fetchTaskFeedbackJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(error.error || error.message || `HTTP ${response.status}`, response.status);
  }

  return response.json();
}

export const taskFeedbackApi = {
  async list(taskId: string, projectPath: string): Promise<TaskFeedback[]> {
    const url = `/api/tasks/${encodeURIComponent(taskId)}/feedback?project=${encodeURIComponent(projectPath)}`;
    const response = await fetchTaskFeedbackJson<TaskFeedbackListResponse>(url);
    return response.feedback || [];
  },

  async create(taskId: string, projectPath: string, feedback: string): Promise<TaskFeedback> {
    const url = `/api/tasks/${encodeURIComponent(taskId)}/feedback`;
    const response = await fetchTaskFeedbackJson<TaskFeedbackCreateResponse>(url, {
      method: 'POST',
      body: JSON.stringify({
        project: projectPath,
        feedback,
      }),
    });
    return response.feedback;
  },

  async delete(taskId: string, feedbackId: string, projectPath: string): Promise<void> {
    const url = `/api/tasks/${encodeURIComponent(taskId)}/feedback/${encodeURIComponent(feedbackId)}?project=${encodeURIComponent(projectPath)}`;
    await fetchTaskFeedbackJson(url, { method: 'DELETE' });
  },
};
