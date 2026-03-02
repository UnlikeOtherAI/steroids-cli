import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserFeedbackPanel } from './UserFeedbackPanel';
import { taskFeedbackApi } from '../../services/taskFeedbackApi';

vi.mock('../../services/taskFeedbackApi', () => ({
  taskFeedbackApi: {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

const mockTaskFeedbackApi = taskFeedbackApi as unknown as {
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

describe('UserFeedbackPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockTaskFeedbackApi.list.mockResolvedValue([]);
  });

  it('loads and renders existing feedback', async () => {
    mockTaskFeedbackApi.list.mockResolvedValueOnce([
      {
        id: 'fb-1',
        task_id: 'task-1',
        feedback: 'Please add edge-case coverage.',
        source: 'user',
        created_by: null,
        created_at: '2026-03-02T12:00:00.000Z',
      },
    ]);

    render(<UserFeedbackPanel taskId="task-1" projectPath="/tmp/project" />);

    await waitFor(() => {
      expect(screen.getByText('Please add edge-case coverage.')).toBeInTheDocument();
    });
  });

  it('creates feedback and prepends it to the list', async () => {
    const user = userEvent.setup();
    mockTaskFeedbackApi.create.mockResolvedValueOnce({
      id: 'fb-new',
      task_id: 'task-1',
      feedback: 'Investigate flaky retry path.',
      source: 'user',
      created_by: null,
      created_at: '2026-03-02T13:00:00.000Z',
    });

    render(<UserFeedbackPanel taskId="task-1" projectPath="/tmp/project" />);

    await user.type(screen.getByPlaceholderText('Add task-specific notes...'), 'Investigate flaky retry path.');
    await user.click(screen.getByRole('button', { name: 'Add Feedback' }));

    await waitFor(() => {
      expect(mockTaskFeedbackApi.create).toHaveBeenCalledWith('task-1', '/tmp/project', 'Investigate flaky retry path.');
    });
    expect(screen.getByText('Investigate flaky retry path.')).toBeInTheDocument();
  });

  it('deletes feedback items', async () => {
    const user = userEvent.setup();
    mockTaskFeedbackApi.list.mockResolvedValueOnce([
      {
        id: 'fb-delete',
        task_id: 'task-1',
        feedback: 'Delete me',
        source: 'user',
        created_by: null,
        created_at: '2026-03-02T14:00:00.000Z',
      },
    ]);

    render(<UserFeedbackPanel taskId="task-1" projectPath="/tmp/project" />);

    await waitFor(() => {
      expect(screen.getByText('Delete me')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockTaskFeedbackApi.delete).toHaveBeenCalledWith('task-1', 'fb-delete', '/tmp/project');
    });
    expect(screen.queryByText('Delete me')).not.toBeInTheDocument();
  });
});
