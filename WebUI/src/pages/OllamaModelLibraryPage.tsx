import { useEffect, useRef, useState } from 'react';
import type { OllamaCachedModel } from '../types';
import { ollamaApi } from '../services/ollamaApi';
import { API_BASE_URL } from '../services/api';

interface PullProgress {
  status: string;
  phase?: string;
  percent?: number | null;
  done?: boolean;
  error?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

const CURATED_MODELS = [
  'deepseek-coder-v2:16b',
  'deepseek-coder-v2:33b',
  'qwen2.5-coder:7b',
  'qwen2.5-coder:14b',
  'qwen2.5-coder:32b',
  'codellama:13b',
  'codellama:34b',
  'starcoder2:7b',
  'starcoder2:15b',
];

export function OllamaModelLibraryPage() {
  const [installed, setInstalled] = useState<OllamaCachedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [pullName, setPullName] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadModels = async () => {
    setLoading(true);
    setError(null);
    try {
      const models = await ollamaApi.getModels();
      setInstalled(models);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load models');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  const installedNames = new Set(installed.map((m) => m.name));

  const handlePull = async (modelName: string) => {
    const name = modelName.trim();
    if (!name || pulling) return;

    setPulling(true);
    setPullProgress(null);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`${API_BASE_URL}/api/ollama/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        setError(`Pull request failed: HTTP ${response.status}`);
        setPulling(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.replace(/^data:\s*/, '').trim();
          if (!trimmed) continue;
          try {
            const progress = JSON.parse(trimmed) as PullProgress;
            setPullProgress(progress);
            if (progress.error) {
              setError(progress.error);
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      setPullName('');
      await loadModels();
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setError(err.message);
      }
    } finally {
      setPulling(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="card p-6">
        <h1 className="text-3xl font-bold text-text-primary">Ollama Model Library</h1>
        <p className="mt-2 text-sm text-text-muted">
          Pull models from{' '}
          <a href="https://ollama.com/library" target="_blank" rel="noreferrer" className="text-accent hover:underline">
            ollama.com/library
          </a>{' '}
          and manage your installed models.
        </p>
      </div>

      {/* Pull Model */}
      <div className="card p-6 space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">Pull Model</h2>
        <div className="flex gap-3">
          <input
            type="text"
            value={pullName}
            onChange={(e) => setPullName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handlePull(pullName)}
            placeholder="Model name (e.g. qwen2.5-coder:14b)"
            className="flex-1 bg-bg-elevated rounded-full px-5 py-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            disabled={pulling}
          />
          <button
            type="button"
            className="btn-accent"
            disabled={pulling || !pullName.trim()}
            onClick={() => handlePull(pullName)}
          >
            {pulling ? 'Pulling...' : 'Pull'}
          </button>
        </div>

        {pulling && pullProgress && (
          <div className="space-y-2">
            <p className="text-sm text-text-muted">
              {pullProgress.status}
              {pullProgress.percent != null && ` — ${pullProgress.percent}%`}
            </p>
            {pullProgress.percent != null && (
              <div className="w-full bg-bg-elevated rounded-full h-2">
                <div
                  className="bg-accent rounded-full h-2 transition-all"
                  style={{ width: `${pullProgress.percent}%` }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {loading && (
        <div className="text-center py-4 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading models...
        </div>
      )}

      {/* Curated Coding Models */}
      {!loading && (
        <div className="card overflow-hidden">
          <div className="p-6 pb-3">
            <h2 className="text-lg font-semibold text-text-primary">Curated Coding Models</h2>
            <p className="text-sm text-text-muted mt-1">Popular models for code generation and review.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated text-text-primary">
                <tr>
                  <th className="text-left px-4 py-3">Model</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {CURATED_MODELS.map((name) => {
                  const isInstalled = installedNames.has(name);
                  const model = installed.find((m) => m.name === name);
                  return (
                    <tr key={name} className="border-t border-bg-elevated/60">
                      <td className="px-4 py-3 font-medium text-text-primary">{name}</td>
                      <td className="px-4 py-3">
                        {isInstalled ? (
                          <span className="badge-success">
                            Installed {model ? `(${formatBytes(model.size)})` : ''}
                          </span>
                        ) : (
                          <span className="badge-warning">Not installed</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {!isInstalled && (
                          <button
                            type="button"
                            className="btn-pill"
                            disabled={pulling}
                            onClick={() => handlePull(name)}
                          >
                            Pull
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* All Installed Models */}
      {!loading && installed.length > 0 && (
        <div className="card overflow-hidden">
          <div className="p-6 pb-3">
            <h2 className="text-lg font-semibold text-text-primary">All Installed Models</h2>
            <p className="text-sm text-text-muted mt-1">{installed.length} model(s) on this endpoint.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated text-text-primary">
                <tr>
                  <th className="text-left px-4 py-3">Name</th>
                  <th className="text-left px-4 py-3">Family</th>
                  <th className="text-left px-4 py-3">Parameters</th>
                  <th className="text-left px-4 py-3">Quantization</th>
                  <th className="text-left px-4 py-3">Size</th>
                </tr>
              </thead>
              <tbody>
                {installed.map((model) => (
                  <tr key={model.digest} className="border-t border-bg-elevated/60">
                    <td className="px-4 py-3 font-medium text-text-primary">{model.name}</td>
                    <td className="px-4 py-3 text-text-muted">{model.family || '—'}</td>
                    <td className="px-4 py-3 text-text-muted">{model.parameterSize || '—'}</td>
                    <td className="px-4 py-3 text-text-muted">{model.quantization || '—'}</td>
                    <td className="px-4 py-3 text-text-muted">{formatBytes(model.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {error && <div className="text-sm text-danger">{error}</div>}
    </div>
  );
}
