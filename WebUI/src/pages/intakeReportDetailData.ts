import { API_BASE_URL, ApiError } from '../services/api';
import type { ConnectorHealth, IntakeReport, IntakeSource, IntakeStatus } from './intakePageData';

export type IntakePipelinePhase = 'triage' | 'reproduction' | 'fix';
export type IntakePipelineStepState = 'complete' | 'current' | 'pending';

export interface IntakePipelineStep {
  phase: IntakePipelinePhase;
  label: string;
  state: IntakePipelineStepState;
}

export interface IntakePhaseOutput {
  phase: IntakePipelinePhase;
  title: string;
  status: string;
  summary?: string;
  comment?: string;
  decision?: string;
  resolutionCode?: string;
  nextTaskTitle?: string;
  taskId?: string;
  taskTitle?: string;
  updatedAt?: string;
  raw: Record<string, unknown>;
}

export interface IntakePipelineView {
  steps: IntakePipelineStep[];
  outputs: IntakePhaseOutput[];
  outcomeLabel?: string;
}

export interface IntakeReportDetailData {
  report: IntakeReport;
  connector: ConnectorHealth | null;
  pipeline: IntakePipelineView;
}

interface ReportResponse {
  success: boolean;
  report: IntakeReport;
}

interface ConnectorHealthResponse {
  success: boolean;
  connectors: ConnectorHealth[];
}

const PHASES: IntakePipelinePhase[] = ['triage', 'reproduction', 'fix'];

const PHASE_LABELS: Record<IntakePipelinePhase, string> = {
  triage: 'Triage',
  reproduction: 'Reproduction',
  fix: 'Fix',
};

const STATUS_LABELS: Record<IntakeStatus, string> = {
  open: 'Open',
  triaged: 'Triaged',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  ignored: 'Ignored',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPhase(value: unknown): IntakePipelinePhase | null {
  if (value === 'triage' || value === 'reproduction' || value === 'fix') {
    return value;
  }

  return null;
}

function parseStepState(value: unknown): IntakePipelineStepState | null {
  switch (value) {
    case 'complete':
    case 'completed':
    case 'done':
      return 'complete';
    case 'current':
    case 'active':
    case 'in_progress':
      return 'current';
    case 'pending':
    case 'queued':
    case 'not_started':
      return 'pending';
    default:
      return null;
  }
}

function readPipelinePayload(report: IntakeReport): Record<string, unknown> | null {
  const pipeline = report.payload.pipeline;
  return isRecord(pipeline) ? pipeline : null;
}

function buildFallbackSteps(status: IntakeStatus): IntakePipelineStep[] {
  let currentIndex = 0;

  if (status === 'triaged') {
    currentIndex = 1;
  } else if (status === 'in_progress') {
    currentIndex = 2;
  } else if (status === 'resolved' || status === 'ignored') {
    currentIndex = PHASES.length;
  }

  return PHASES.map((phase, index) => ({
    phase,
    label: PHASE_LABELS[phase],
    state: currentIndex >= PHASES.length || index < currentIndex
      ? 'complete'
      : index === currentIndex
        ? 'current'
        : 'pending',
  }));
}

function applyCurrentPhaseOverride(
  steps: IntakePipelineStep[],
  phase: IntakePipelinePhase
): IntakePipelineStep[] {
  const currentIndex = PHASES.indexOf(phase);
  return steps.map((step, index) => ({
    ...step,
    state: index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'pending',
  }));
}

function collectOutputRecords(pipeline: Record<string, unknown>): Map<IntakePipelinePhase, Record<string, unknown>> {
  const records = new Map<IntakePipelinePhase, Record<string, unknown>>();

  const outputs = pipeline.outputs;
  if (isRecord(outputs)) {
    for (const phase of PHASES) {
      const value = outputs[phase];
      if (isRecord(value)) {
        records.set(phase, value);
      }
    }
  }

  const phases = pipeline.phases;
  if (Array.isArray(phases)) {
    for (const entry of phases) {
      if (!isRecord(entry)) continue;
      const phase = asPhase(entry.phase);
      if (phase) {
        records.set(phase, entry);
      }
    }
  } else if (isRecord(phases)) {
    for (const phase of PHASES) {
      const value = phases[phase];
      if (isRecord(value)) {
        records.set(phase, value);
      }
    }
  }

  return records;
}

function buildOutputs(pipeline: Record<string, unknown> | null): IntakePhaseOutput[] {
  if (!pipeline) {
    return [];
  }

  const records = collectOutputRecords(pipeline);

  return PHASES.flatMap((phase) => {
    const record = records.get(phase);
    if (!record) return [];

    return [{
      phase,
      title: PHASE_LABELS[phase],
      status: typeof record.status === 'string' ? record.status : 'recorded',
      summary: typeof record.summary === 'string' ? record.summary : undefined,
      comment: typeof record.comment === 'string' ? record.comment : undefined,
      decision: typeof record.decision === 'string' ? record.decision : undefined,
      resolutionCode: typeof record.resolutionCode === 'string' ? record.resolutionCode : undefined,
      nextTaskTitle: typeof record.nextTaskTitle === 'string' ? record.nextTaskTitle : undefined,
      taskId: typeof record.taskId === 'string' ? record.taskId : undefined,
      taskTitle: typeof record.taskTitle === 'string' ? record.taskTitle : undefined,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
      raw: record,
    }];
  });
}

export function buildIntakePipelineView(report: IntakeReport): IntakePipelineView {
  const pipeline = readPipelinePayload(report);
  let steps = buildFallbackSteps(report.status);

  if (pipeline) {
    const explicitCurrent = asPhase(pipeline.currentPhase) ?? asPhase(pipeline.nextPhase);
    if (explicitCurrent) {
      steps = applyCurrentPhaseOverride(steps, explicitCurrent);
    }

    const outputs = collectOutputRecords(pipeline);
    for (const [phase, record] of outputs.entries()) {
      const explicitState = parseStepState(record.status);
      if (!explicitState) continue;
      steps = steps.map((step) => (
        step.phase === phase ? { ...step, state: explicitState } : step
      ));
    }
  }

  if (report.status === 'resolved' || report.status === 'ignored') {
    steps = steps.map((step) => ({ ...step, state: 'complete' }));
  }

  return {
    steps,
    outputs: buildOutputs(pipeline),
    outcomeLabel: report.status === 'resolved' || report.status === 'ignored'
      ? STATUS_LABELS[report.status]
      : undefined,
  };
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(
      error.error || error.message || `HTTP ${response.status}`,
      response.status
    );
  }

  return response.json() as Promise<T>;
}

export async function loadIntakeReportDetailData(
  projectPath: string,
  source: IntakeSource,
  externalId: string
): Promise<IntakeReportDetailData> {
  const project = encodeURIComponent(projectPath);
  const encodedId = encodeURIComponent(externalId);
  const [reportResponse, connectorResponse] = await Promise.all([
    fetchJson<ReportResponse>(`/api/intake/reports/${source}/${encodedId}?project=${project}`),
    fetchJson<ConnectorHealthResponse>(`/api/intake/connectors/health?project=${project}`),
  ]);

  return {
    report: reportResponse.report,
    connector: connectorResponse.connectors.find((connector) => connector.source === source) ?? null,
    pipeline: buildIntakePipelineView(reportResponse.report),
  };
}

export async function updateIntakeReportStatus(
  projectPath: string,
  source: IntakeSource,
  externalId: string,
  status: IntakeStatus,
  resolvedAt?: string | null
): Promise<IntakeReport> {
  const encodedId = encodeURIComponent(externalId);

  const response = await fetchJson<ReportResponse>(`/api/intake/reports/${source}/${encodedId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      project: projectPath,
      status,
      resolvedAt,
    }),
  });

  return response.report;
}
