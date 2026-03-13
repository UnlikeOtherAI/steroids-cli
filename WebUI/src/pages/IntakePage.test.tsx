import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { IntakePage } from './IntakePage';
import type { IntakePageData } from './intakePageData';
import type { Project } from '../types';

const project: Project = {
  path: '/tmp/intake-project',
  name: 'Widgets',
  enabled: true,
  registered_at: '2026-03-12T00:00:00Z',
  last_seen_at: '2026-03-13T00:00:00Z',
  last_activity_at: null,
  last_task_added_at: null,
};

const pageData: IntakePageData = {
  stats: {
    total: 3,
    linked: 1,
    unlinked: 2,
    bySource: {
      github: 2,
      sentry: 1,
    },
    byStatus: {
      open: 1,
      triaged: 1,
      in_progress: 0,
      resolved: 1,
      ignored: 0,
    },
    bySeverity: {
      critical: 1,
      high: 1,
      medium: 0,
      low: 1,
      info: 0,
    },
  },
  reports: [
    {
      source: 'github',
      externalId: '101',
      fingerprint: 'github:101',
      title: 'Crash in checkout flow',
      summary: 'Raised by customer issue',
      severity: 'critical',
      status: 'open',
      url: 'https://github.com/acme/widgets/issues/101',
      createdAt: '2026-03-12T09:00:00Z',
      updatedAt: '2026-03-13T09:00:00Z',
      linkedTaskId: 'task-101',
      tags: ['checkout'],
      payload: {},
    },
    {
      source: 'github',
      externalId: '102',
      fingerprint: 'github:102',
      title: 'Slow sync on large repos',
      summary: 'Investigate polling slowness',
      severity: 'high',
      status: 'triaged',
      url: 'https://github.com/acme/widgets/issues/102',
      createdAt: '2026-03-11T09:00:00Z',
      updatedAt: '2026-03-12T09:00:00Z',
      linkedTaskId: null,
      tags: ['performance'],
      payload: {},
    },
    {
      source: 'sentry',
      externalId: 'evt-9',
      fingerprint: 'sentry:evt-9',
      title: 'Renderer warning storm',
      summary: 'Auto-grouped from Sentry',
      severity: 'low',
      status: 'resolved',
      url: 'https://sentry.io/acme/issues/evt-9',
      createdAt: '2026-03-10T09:00:00Z',
      updatedAt: '2026-03-10T10:00:00Z',
      linkedTaskId: null,
      tags: ['frontend'],
      payload: {},
    },
  ],
  connectors: [
    {
      source: 'github',
      enabled: true,
      implemented: true,
      status: 'healthy',
      reason: 'Connector has completed at least one successful poll',
      configErrors: [],
      stats: {
        totalReports: 2,
        openReports: 2,
        linkedReports: 1,
      },
      pollState: {
        source: 'github',
        lastSuccessAt: '2026-03-13T09:05:00Z',
        lastErrorAt: null,
      },
    },
    {
      source: 'sentry',
      enabled: true,
      implemented: false,
      status: 'unsupported',
      reason: 'Connector is enabled but not implemented in this workspace',
      configErrors: [],
      stats: {
        totalReports: 1,
        openReports: 0,
        linkedReports: 0,
      },
      pollState: {
        source: 'sentry',
        lastSuccessAt: null,
        lastErrorAt: '2026-03-13T09:06:00Z',
      },
    },
  ],
};

function renderPage(loader = vi.fn().mockResolvedValue(pageData)) {
  render(
    <MemoryRouter>
      <IntakePage project={project} loader={loader} />
    </MemoryRouter>
  );

  return { loader };
}

describe('IntakePage', () => {
  it('renders stat tiles from loaded intake stats', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Total Reports')).toBeInTheDocument();
    });

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Linked To Tasks')).toBeInTheDocument();
    expect(screen.getByText('Unresolved')).toBeInTheDocument();
    expect(screen.getByText('Critical + High')).toBeInTheDocument();
  });

  it('filters the reports table by source, status, link state, and search text', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Crash in checkout flow')).toBeInTheDocument();
    });

    expect(screen.getByText('Slow sync on large repos')).toBeInTheDocument();
    expect(screen.getByText('Renderer warning storm')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Source'), 'github');
    await user.selectOptions(screen.getByLabelText('Status'), 'triaged');
    await user.selectOptions(screen.getByLabelText('Link State'), 'unlinked');

    await waitFor(() => {
      expect(screen.getByText('Slow sync on large repos')).toBeInTheDocument();
    });
    expect(screen.queryByText('Crash in checkout flow')).not.toBeInTheDocument();
    expect(screen.queryByText('Renderer warning storm')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Search'));
    await user.type(screen.getByLabelText('Search'), 'polling');

    expect(screen.getByText('Slow sync on large repos')).toBeInTheDocument();
  });

  it('renders connector health cards with status and poll timing', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Connector Health')).toBeInTheDocument();
    });

    expect(screen.getByRole('heading', { name: 'GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sentry' })).toBeInTheDocument();
    expect(screen.getByText('healthy')).toBeInTheDocument();
    expect(screen.getByText('unsupported')).toBeInTheDocument();
    expect(screen.queryByText('2 of 2 connectors healthy')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 2 connectors healthy')).toBeInTheDocument();
    expect(screen.getAllByText('Last success')).toHaveLength(2);
    expect(screen.getAllByText('Last error')).toHaveLength(2);
  });
});
