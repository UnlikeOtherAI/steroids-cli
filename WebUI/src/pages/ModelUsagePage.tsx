import React, { useEffect, useState, useCallback } from 'react';
import { Project, TimeRangeOption, TIME_RANGE_OPTIONS, ModelUsageByModel, ModelUsageResponse } from '../types';
import { TimeRangeSelector } from '../components/molecules/TimeRangeSelector';
import { useProject } from '../contexts/ProjectContext';
import { modelUsageApi } from '../services/modelUsageApi';
import { ModelUsageCard, ModelUsageCardEntry } from './ModelUsageCard';
import { ModelUsageSummary, ModelUsageSummaryData } from './ModelUsageSummary';
import { OllamaUsageWidgets } from './OllamaUsageWidgets';

interface Props {
  project?: Project | null;
}

interface DetailedModelResponse {
  summary: {
    total_duration_ms: number;
    total_invocations: number;
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
  };
  models: Array<{
    provider: string;
    model: string;
    invocation_count: number;
    coder_count: number;
    reviewer_count: number;
    total_duration_ms: number;
    avg_duration_ms: number;
    success_rate: number;
    failed_count: number;
    timeout_count: number;
    tokens: {
      input: number;
      output: number;
      cached_input: number;
      cache_read: number;
      cache_creation: number;
    };
    cache_hit_rate: number;
    total_cost_usd: number;
  }>;
  skipped_projects: number;
}

function toFallbackEntry(entry: ModelUsageByModel): ModelUsageCardEntry {
  const cacheHitRate = entry.inputTokens > 0
    ? Math.round(((entry.cachedInputTokens + entry.cacheReadTokens) / entry.inputTokens) * 1000) / 10
    : 0;

  return {
    provider: entry.provider,
    model: entry.model,
    invocationCount: entry.invocations,
    coderCount: 0,
    reviewerCount: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    successRate: null,
    failedCount: 0,
    timeoutCount: 0,
    tokens: {
      input: entry.inputTokens,
      output: entry.outputTokens,
      cachedInput: entry.cachedInputTokens,
      cacheRead: entry.cacheReadTokens,
      cacheCreation: entry.cacheCreationTokens,
    },
    cacheHitRate,
    totalCostUsd: entry.totalCostUsd,
  };
}

function normalizeResponse(response: ModelUsageResponse): {
  summary: ModelUsageSummaryData;
  models: ModelUsageCardEntry[];
  skippedProjects: number;
  ollama: ModelUsageResponse['ollama'];
} {
  const maybeDetailed = response as unknown as Partial<DetailedModelResponse>;

  if (maybeDetailed.summary && Array.isArray(maybeDetailed.models)) {
    return {
      summary: {
        totalDurationMs: maybeDetailed.summary.total_duration_ms ?? 0,
        totalInvocations: maybeDetailed.summary.total_invocations ?? 0,
        totalCostUsd: maybeDetailed.summary.total_cost_usd ?? 0,
        totalInputTokens: maybeDetailed.summary.total_input_tokens ?? 0,
        totalOutputTokens: maybeDetailed.summary.total_output_tokens ?? 0,
      },
      models: maybeDetailed.models.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        invocationCount: entry.invocation_count,
        coderCount: entry.coder_count,
        reviewerCount: entry.reviewer_count,
        totalDurationMs: entry.total_duration_ms,
        avgDurationMs: entry.avg_duration_ms,
        successRate: entry.success_rate,
        failedCount: entry.failed_count,
        timeoutCount: entry.timeout_count,
        tokens: {
          input: entry.tokens.input,
          output: entry.tokens.output,
          cachedInput: entry.tokens.cached_input,
          cacheRead: entry.tokens.cache_read,
          cacheCreation: entry.tokens.cache_creation,
        },
        cacheHitRate: entry.cache_hit_rate,
        totalCostUsd: entry.total_cost_usd,
      })),
      skippedProjects: maybeDetailed.skipped_projects ?? 0,
      ollama: response.ollama,
    };
  }

  return {
    summary: {
      totalDurationMs: 0,
      totalInvocations: response.stats.invocations,
      totalCostUsd: response.stats.totalCostUsd,
      totalInputTokens: response.stats.inputTokens,
      totalOutputTokens: response.stats.outputTokens,
    },
    models: response.by_model.map(toFallbackEntry),
    skippedProjects: 0,
    ollama: response.ollama,
  };
}

export const ModelUsagePage: React.FC<Props> = ({ project }) => {
  const { selectedProject } = useProject();
  const activeProject = project ?? selectedProject;
  const projectPath = activeProject?.path;
  const [selectedRange, setSelectedRange] = useState<TimeRangeOption>(TIME_RANGE_OPTIONS[1]);
  const [data, setData] = useState<ModelUsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await modelUsageApi.getUsage(selectedRange.hours, projectPath);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load model usage');
    } finally {
      setLoading(false);
    }
  }, [projectPath, selectedRange.hours]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  const normalized = data ? normalizeResponse(data) : null;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="card p-6 mb-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-3xl font-bold text-text-primary">Model Usage</h1>
          <TimeRangeSelector value={selectedRange.value} onChange={setSelectedRange} />
        </div>
      </div>

      {loading && !data && (
        <div className="text-center py-4 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading model usage...
        </div>
      )}

      {error && <div className="text-center py-4 text-danger">{error}</div>}

      {normalized?.ollama && <OllamaUsageWidgets ollama={normalized.ollama} />}

      {normalized && <ModelUsageSummary summary={normalized.summary} />}

      {normalized && normalized.models.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {normalized.models.map((entry) => (
            <ModelUsageCard key={`${entry.provider}::${entry.model}`} entry={entry} />
          ))}
        </div>
      )}

      {normalized && normalized.models.length === 0 && (
        <div className="card p-12 text-center text-text-muted">
          No model usage data for the selected time range
        </div>
      )}

      {normalized && normalized.skippedProjects > 0 && (
        <div className="text-xs text-text-muted mt-4">
          {normalized.skippedProjects} project(s) could not be queried
        </div>
      )}
    </div>
  );
};
