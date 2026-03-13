import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { IntakeReportDetailPage } from './IntakeReportDetailPage';
import { buildIntakePipelineView, type IntakeReportDetailData } from './intakeReportDetailData';
import type { Project } from '../types';
import type { IntakeReport, IntakeSource, IntakeStatus } from './intakePageData';

const project: Project = {
  path: '/tmp/intake-project',
  name: 'Widgets',
  enabled: true,
  registered_at: '2026-03-12T00:00:00Z',
  last_seen_at: '2026-03-13T00:00:00Z',
  last_activity_at: null,
  last_task_added_at: null,
};

const baseReport: IntakeReport = {
  source: 'github',
  externalId: '101',
  fingerprint: 'github:101',
  title: 'Crash in checkout flow',
  summary: 'Raised by customer issue',
  severity: 'critical',
  status: 'triaged',
  url: 'https://github.com/acme/widgets/issues/101',
  createdAt: '2026-03-12T09:00:00Z',
  updatedAt: '2026-03-13T09:00:00Z',
  resolvedAt: undefined,
  linkedTaskId: 'task-101',
  tags: ['checkout', 'customer'],
  payload: {},
};

function makeDetailData(report: IntakeReport = baseReport): IntakeReportDetailData {
  return {
    report,
    connector: {
      source: report.source,
      enabled: true,
      implemented: true,
      status: 'healthy',
      reason: 'Connector has completed at least one successful poll',
      configErrors: [],
      stats: {
        totalReports: 4,
        openReports: 3,
        linkedReports: 2,
      },
      pollState: {
        source: report.source,
        lastSuccessAt: '2026-03-13T09:05:00Z',
        lastErrorAt: null,
      },
    },
    pipeline: buildIntakePipelineView(report),
  };
}

function renderPage(
  options: {
    loader?: (
      projectPath: string,
      source: IntakeSource,
      externalId: string
    ) => Promise<IntakeReportDetailData>;
    updateStatus?: (
      projectPath: string,
      source: IntakeSource,
      externalId: string,
      status: IntakeStatus,
      resolvedAt?: string | null
    ) => Promise<IntakeReport>;
    report?: IntakeReport;
  } = {}
) {
  const loader = options.loader ?? vi.fn(async () => makeDetailData(options.report));
  const updateStatus = options.updateStatus ?? vi.fn(async () => baseReport);

  render(
    <MemoryRouter initialEntries={['/intake/github/101']}>
      <Routes>
        <Route
          path="/intake/:source/:externalId"
          element={<IntakeReportDetailPage project={project} loader={loader} updateStatus={updateStatus} />}
        />
      </Routes>
    </MemoryRouter>
  );

  return { loader, updateStatus };
}

describe('buildIntakePipelineView', () => {
  it('prefers structured pipeline payload and exposes phase outputs', () => {
    const view = buildIntakePipelineView({
      ...baseReport,
      status: 'open',
      payload: {
        pipeline: {
          currentPhase: 'fix',
          outputs: {
            triage: {
              status: 'completed',
              summary: 'Confirmed the issue affects checkout retries.',
              decision: 'fix',
              nextTaskTitle: 'Fix intake report github#101: Crash in checkout flow',
            },
            reproduction: {
              status: 'completed',
              summary: 'Reproduced on large orders with discount codes applied.',
              taskId: 'task-202',
            },
          },
        },
      },
    });

    expect(view.steps.map((step) => [step.phase, step.state])).toEqual([
      ['triage', 'complete'],
      ['reproduction', 'complete'],
      ['fix', 'current'],
    ]);
    expect(view.outputs).toHaveLength(2);
    expect(view.outputs[0]?.decision).toBe('fix');
    expect(view.outputs[1]?.taskId).toBe('task-202');
  });
});

describe('IntakeReportDetailPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders pipeline progress and phase outputs from the loaded report', async () => {
    const report: IntakeReport = {
      ...baseReport,
      payload: {
        pipeline: {
          currentPhase: 'reproduction',
          outputs: {
            triage: {
              status: 'completed',
              summary: 'Severity confirmed as critical.',
              comment: 'Checkout requests fail after timeout.',
              decision: 'reproduce',
              updatedAt: '2026-03-13T08:30:00Z',
            },
          },
        },
      },
    };

    renderPage({ report });

    await waitFor(() => {
      expect(screen.getByText('Pipeline Progress')).toBeInTheDocument();
    });

    expect(screen.getByText('Crash in checkout flow')).toBeInTheDocument();
    expect(screen.getByText('Connector')).toBeInTheDocument();
    expect(screen.getByText('Severity confirmed as critical.')).toBeInTheDocument();
    expect(screen.getByText('Checkout requests fail after timeout.')).toBeInTheDocument();
    expect(screen.getAllByText('No recorded output yet.')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'task-101' })).toHaveAttribute(
      'href',
      `/task/task-101?project=${encodeURIComponent(project.path)}`
    );
  });

  it('sends approve and reject status transitions with deterministic resolvedAt timestamps', async () => {
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-03-13T10:15:00.000Z');
    const user = userEvent.setup();
    const updateStatus = vi
      .fn()
      .mockResolvedValueOnce({
        ...baseReport,
        status: 'resolved',
        resolvedAt: '2026-03-13T10:15:00.000Z',
      })
      .mockResolvedValueOnce({
        ...baseReport,
        status: 'ignored',
        resolvedAt: '2026-03-13T10:15:00.000Z',
      });

    renderPage({ updateStatus });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(updateStatus).toHaveBeenNthCalledWith(
      1,
      project.path,
      'github',
      '101',
      'resolved',
      '2026-03-13T10:15:00.000Z'
    );

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(updateStatus).toHaveBeenNthCalledWith(
      2,
      project.path,
      'github',
      '101',
      'ignored',
      '2026-03-13T10:15:00.000Z'
    );
  });

  it('shows placeholder output cards when the intake payload has no pipeline metadata', async () => {
    renderPage({ report: { ...baseReport, payload: {} } });

    await waitFor(() => {
      expect(screen.getByText('Phase Outputs')).toBeInTheDocument();
    });

    expect(
      screen.getAllByText('This phase has no structured output stored in the intake payload yet.')
    ).toHaveLength(3);
  });
});
