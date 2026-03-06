import React, { useMemo, useState } from 'react';
import { StatTile } from '../components/molecules/StatTile';
import { formatTokenCount } from '../services/modelUsageFormat';
import { modelUsageApi, type OllamaPullProgress } from '../services/modelUsageApi';
import type { ModelUsageResponse } from '../types';

interface Props {
  ollama: NonNullable<ModelUsageResponse['ollama']>;
}

function formatTokensPerSecond(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '--';
  }
  return `${value.toFixed(1)} tok/s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatUnloadEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return '--';
  }
  if (seconds <= 0) {
    return 'now';
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

export const OllamaUsageWidgets: React.FC<Props> = ({ ollama }) => {
  const [pullModelName, setPullModelName] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<OllamaPullProgress | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);

  const pullPercent = useMemo(() => {
    if (!pullProgress) return null;
    if (typeof pullProgress.percent === 'number' && Number.isFinite(pullProgress.percent)) {
      return Math.max(0, Math.min(100, Math.round(pullProgress.percent)));
    }
    if (
      typeof pullProgress.completed === 'number'
      && Number.isFinite(pullProgress.completed)
      && typeof pullProgress.total === 'number'
      && Number.isFinite(pullProgress.total)
      && pullProgress.total > 0
    ) {
      return Math.max(0, Math.min(100, Math.round((pullProgress.completed / pullProgress.total) * 100)));
    }
    return null;
  }, [pullProgress]);

  const handlePullModel = async () => {
    const modelName = pullModelName.trim();
    if (!modelName || pulling) return;
    setPulling(true);
    setPullError(null);
    setPullProgress({ status: 'starting', phase: 'starting', percent: 0, done: false });

    try {
      await modelUsageApi.streamOllamaPull(modelName, (progress) => {
        setPullProgress(progress);
      });
    } catch (error) {
      setPullError(error instanceof Error ? error.message : 'Model pull failed');
      setPullProgress({
        status: 'error',
        phase: 'error',
        error: error instanceof Error ? error.message : 'Model pull failed',
        done: true,
        percent: pullPercent,
      });
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="card p-6 mb-6">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <h2 className="text-lg font-semibold text-text-primary">Ollama Usage</h2>
        <span className="badge-accent text-xs">
          {ollama.runtime.mode} {ollama.runtime.connected ? 'connected' : 'disconnected'}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <StatTile label="Requests" value={ollama.usage.requests} />
        <StatTile
          label="Tokens"
          value={formatTokenCount(ollama.usage.total_tokens)}
          description={`${formatTokenCount(ollama.usage.prompt_tokens)} in / ${formatTokenCount(ollama.usage.completion_tokens)} out`}
        />
        <StatTile label="Avg Throughput" value={formatTokensPerSecond(ollama.usage.avg_tokens_per_second)} />
        <StatTile
          label="Loaded Models"
          value={ollama.runtime.loaded_models}
          description={`${formatBytes(ollama.runtime.total_vram_bytes)} VRAM`}
        />
      </div>

      <div className="text-xs text-text-muted mb-3 truncate" title={ollama.runtime.endpoint}>
        Endpoint: {ollama.runtime.endpoint}
      </div>

      <div className="bg-bg-surface rounded-lg p-3 mb-4 space-y-3">
        <div className="text-sm font-medium text-text-primary">Pull Ollama Model</div>
        <div className="flex flex-col md:flex-row gap-2">
          <input
            type="text"
            value={pullModelName}
            onChange={(event) => setPullModelName(event.target.value)}
            placeholder="e.g. deepseek-coder-v2:33b"
            className="bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary flex-1"
          />
          <button
            type="button"
            className="btn-pill whitespace-nowrap"
            disabled={pulling || pullModelName.trim().length === 0}
            onClick={() => {
              void handlePullModel();
            }}
          >
            {pulling ? 'Pulling...' : 'Pull Model'}
          </button>
        </div>

        {pullProgress && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span>
                {pullProgress.phase ? `${pullProgress.phase}: ` : ''}
                {pullProgress.status}
              </span>
              <span>{pullPercent === null ? '--' : `${pullPercent}%`}</span>
            </div>
            <div className="h-2 rounded-full bg-bg-elevated overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pullPercent ?? undefined}>
              <div
                className={`h-full transition-all ${pullProgress.phase === 'error' ? 'bg-danger' : 'bg-accent'}`}
                style={{ width: `${pullPercent ?? 0}%` }}
              />
            </div>
            {pullProgress.error && (
              <div className="text-xs text-danger">{pullProgress.error}</div>
            )}
          </div>
        )}

        {pullError && !pullProgress?.error && (
          <div className="text-xs text-danger">{pullError}</div>
        )}
      </div>

      {ollama.runtime.error && (
        <div className="text-xs text-warning mb-3">Runtime status unavailable: {ollama.runtime.error}</div>
      )}

      {ollama.runtime.models.length > 0 && (
        <div className="space-y-2 mb-4">
          {ollama.runtime.models.map((model) => (
            <div key={model.name} className="bg-bg-surface rounded-lg p-3 text-sm flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-text-primary font-medium truncate" title={model.name}>{model.name}</div>
                <div className="text-xs text-text-muted">
                  VRAM {formatBytes(model.vram_bytes)} / RAM {formatBytes(model.ram_bytes)}
                </div>
              </div>
              <div className="text-xs text-text-secondary whitespace-nowrap">
                unload in {formatUnloadEta(model.unload_in_seconds)}
              </div>
            </div>
          ))}
        </div>
      )}

      {ollama.by_model.length > 0 && (
        <div className="space-y-1">
          <div className="text-sm font-medium text-text-primary">Per model ({ollama.by_model.length})</div>
          {ollama.by_model.slice(0, 5).map((entry) => (
            <div key={entry.model} className="flex items-center justify-between text-xs text-text-secondary">
              <span className="truncate pr-2" title={entry.model}>{entry.model}</span>
              <span className="whitespace-nowrap">
                {formatTokenCount(entry.total_tokens)} tokens, {formatTokensPerSecond(entry.avg_tokens_per_second)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
