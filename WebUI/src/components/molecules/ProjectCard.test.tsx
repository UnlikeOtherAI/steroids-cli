import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProjectCard } from './ProjectCard';
import type { Project } from '../../types';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    path: '/tmp/test-project',
    name: 'Test Project',
    enabled: true,
    registered_at: '2025-01-01T00:00:00Z',
    last_seen_at: '2025-01-01T00:00:00Z',
    last_activity_at: '2025-01-15T10:30:00Z',
    last_task_added_at: '2025-01-15T10:30:00Z',
    ...overrides,
  };
}

function renderCard(project: Project) {
  return render(
    <MemoryRouter>
      <ProjectCard project={project} />
    </MemoryRouter>,
  );
}

describe('ProjectCard storage indicator', () => {
  it('renders "cleanup recommended" when storage_warning is red', () => {
    renderCard(makeProject({
      storage_human: '1.2 GB',
      storage_warning: 'red',
    }));

    expect(screen.getByText('1.2 GB')).toBeInTheDocument();
    expect(screen.getByText('cleanup recommended')).toBeInTheDocument();
  });

  it('does not render "cleanup recommended" when storage_warning is orange', () => {
    renderCard(makeProject({
      storage_human: '456 MB',
      storage_warning: 'orange',
    }));

    expect(screen.getByText('456 MB')).toBeInTheDocument();
    expect(screen.queryByText('cleanup recommended')).not.toBeInTheDocument();
  });

  it('renders no storage indicator when storage_human is null', () => {
    renderCard(makeProject({
      storage_human: null,
      storage_warning: null,
    }));

    expect(screen.queryByText('cleanup recommended')).not.toBeInTheDocument();
    // No database icon or storage text should be present
    expect(screen.queryByText(/MB|GB|KB/)).not.toBeInTheDocument();
  });
});
