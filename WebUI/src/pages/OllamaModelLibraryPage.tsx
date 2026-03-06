import { useEffect, useMemo, useState } from 'react';
import type { OllamaLibraryModel, OllamaRuntime } from '../types';
import { ollamaApi } from '../services/ollamaApi';

export function OllamaModelLibraryPage() {
  const [library, setLibrary] = useState<OllamaLibraryModel[]>([]);
  const [search, setSearch] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pairing, setPairing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await ollamaApi.getLibraryModels();
      setLibrary(response.models);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load model library');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const visibleModels = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return library;
    return library.filter((model) => model.name.toLowerCase().includes(term));
  }, [library, search]);

  const pull = async (modelName: string) => {
    const target = modelName.trim();
    if (!target) return;
    setPulling(target);
    setError(null);
    setMessage(null);
    try {
      await ollamaApi.pullModel(target);
      setMessage(`Pull requested for ${target}.`);
      setManualModel('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pull model');
    } finally {
      setPulling(null);
    }
  };

  const pair = async (modelName: string, runtime: OllamaRuntime) => {
    setPairing(`${modelName}:${runtime}`);
    setError(null);
    setMessage(null);
    try {
      await ollamaApi.pairInstalledModel(modelName, runtime);
      setMessage(`Paired ${modelName} with ${runtime === 'claude-code' ? 'Claude Code' : 'OpenCode'}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pair model');
    } finally {
      setPairing(null);
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="card p-6">
        <h1 className="text-3xl font-bold text-text-primary">Ollama Model Library</h1>
        <p className="mt-2 text-sm text-text-muted">
          Pull models by name and pair them with Claude Code or OpenCode runtimes.
        </p>
        <div className="mt-4 relative">
          <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter curated models..."
            className="input-search w-full"
          />
        </div>
      </div>

      <div className="card p-6">
        <label className="block">
          <span className="text-sm text-text-muted">Manual model name</span>
          <input
            aria-label="Manual model name"
            value={manualModel}
            onChange={(event) => setManualModel(event.target.value)}
            placeholder="deepseek-coder-v2:33b"
            className="mt-2 w-full bg-bg-elevated rounded-full px-5 py-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </label>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            className="btn-accent"
            onClick={() => pull(manualModel)}
            disabled={pulling !== null || manualModel.trim().length === 0}
          >
            {pulling === manualModel.trim() ? 'Pulling...' : 'Pull Model'}
          </button>
          <a className="btn-pill" href="https://ollama.com/library" target="_blank" rel="noreferrer">
            Browse Full Library
          </a>
        </div>
      </div>

      {loading && (
        <div className="text-center py-4 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading library...
        </div>
      )}

      {!loading && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated text-text-primary">
                <tr>
                  <th className="text-left px-4 py-3">Model</th>
                  <th className="text-left px-4 py-3">Description</th>
                  <th className="text-left px-4 py-3">Parameters</th>
                  <th className="text-left px-4 py-3">Quantization</th>
                  <th className="text-left px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleModels.map((model) => (
                  <tr key={model.name} className="border-t border-bg-elevated/60">
                    <td className="px-4 py-3 font-medium text-text-primary">{model.name}</td>
                    <td className="px-4 py-3 text-text-muted">{model.description}</td>
                    <td className="px-4 py-3 text-text-muted">{model.parameterSize || '—'}</td>
                    <td className="px-4 py-3 text-text-muted">{model.quantization || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn-pill"
                          onClick={() => pull(model.name)}
                          disabled={pulling !== null}
                        >
                          {pulling === model.name ? 'Pulling...' : 'Pull'}
                        </button>
                        <button
                          type="button"
                          className="btn-pill"
                          onClick={() => pair(model.name, 'claude-code')}
                          disabled={pairing !== null}
                        >
                          {pairing === `${model.name}:claude-code` ? 'Pairing...' : 'Pair Claude Code'}
                        </button>
                        <button
                          type="button"
                          className="btn-pill"
                          onClick={() => pair(model.name, 'opencode')}
                          disabled={pairing !== null}
                        >
                          {pairing === `${model.name}:opencode` ? 'Pairing...' : 'Pair OpenCode'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!loading && visibleModels.length === 0 && (
            <div className="p-8 text-center text-text-muted">No models found.</div>
          )}
        </div>
      )}

      {message && <p className="text-sm text-success">{message}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
