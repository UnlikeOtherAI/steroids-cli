import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../services/api';
import { ActivityListPage } from './ActivityListPage';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    activityApi: {
      ...actual.activityApi,
      list: vi.fn(),
    },
  };
});

const mockActivityApi = api.activityApi as unknown as {
  list: ReturnType<typeof vi.fn>;
};

describe('ActivityListPage', () => {
  beforeEach(() => {
    document.cookie = 'steroids_stats_hours=; path=/; max-age=0';
    mockActivityApi.list.mockResolvedValue({
      success: true,
      hours: 24,
      status: 'completed',
      entries: [],
      count: 0,
    });
  });

  it('shows back button to project detail when project filter is present', async () => {
    render(
      <MemoryRouter initialEntries={['/activity?status=completed&hours=24&project=%2Ftmp%2Ftest-project']}>
        <Routes>
          <Route path="/activity" element={<ActivityListPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTitle('Back to test-project')).toBeInTheDocument();
    });
  });

  it('hides back button when no project filter is present', async () => {
    render(
      <MemoryRouter initialEntries={['/activity?status=completed&hours=24']}>
        <Routes>
          <Route path="/activity" element={<ActivityListPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('No activity found for the selected filters')).toBeInTheDocument();
    });

    expect(screen.queryByTitle('Back to Project')).not.toBeInTheDocument();
  });

  it('defaults to 1y from shared cookie policy when hours is missing', async () => {
    render(
      <MemoryRouter initialEntries={['/activity?status=completed']}>
        <Routes>
          <Route path="/activity" element={<ActivityListPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '1y' })).toHaveClass('bg-accent');
    });
  });
});
