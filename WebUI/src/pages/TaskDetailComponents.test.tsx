import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InvocationCard } from './TaskDetailComponents';

describe('InvocationCard', () => {
  it('does not present a stale running invocation as live work', () => {
    render(
      <InvocationCard
        taskId="task-1"
        projectPath="/tmp/project"
        invocation={{
          id: 1,
          task_id: 'task-1',
          role: 'reviewer',
          provider: 'mock',
          model: 'mock-model',
          status: 'running',
          is_live: false,
          exit_code: 1,
          duration_ms: 1000,
          success: 0,
          timed_out: 0,
          rejection_number: null,
          created_at: '2026-03-26T21:00:00Z',
        }}
      />,
    );

    expect(screen.getByText('Stale Runtime')).toBeInTheDocument();
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
  });
});
