import { useEffect, useMemo, useState } from 'react';
import type { HFCachedModel, HFRuntime } from '../types';
import { huggingFaceApi } from '../services/huggingFaceApi';

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function HFModelLibraryPage() {
  const [curated, setCurated] = useState<HFCachedModel[]>([]);
  const [remoteResults, setRemoteResults] = useState<HFCachedModel[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [pairing, setPairing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await huggingFaceApi.getModels();
        if (!cancelled) setCurated(response.models);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load model library');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const localMatches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return curated;
    return curated.filter((model) => model.id.toLowerCase().includes(term));
  }, [curated, search]);

  useEffect(() => {
    const term = search.trim();
    if (!term || localMatches.length > 0) {
      setRemoteResults([]);
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const response = await huggingFaceApi.getModels(term);
        if (!cancelled) setRemoteResults(response.models);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Model search failed');
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [localMatches.length, search]);

  const visibleModels = localMatches.length > 0 ? localMatches : remoteResults;

  const handlePair = async (model: HFCachedModel, runtime: HFRuntime) => {
    const modelId = model.id;
    setPairing(`${modelId}:${runtime}`);
    setError(null);
    try {
      await huggingFaceApi.pairModel({
        modelId,
        runtime,
        routingPolicy: 'fastest',
        supportsTools: Boolean(model.supportsTools),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pair model');
    } finally {
      setPairing(null);
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="card p-6">
        <h1 className="text-3xl font-bold text-text-primary">Hugging Face Model Library</h1>
        <p className="mt-2 text-sm text-text-muted">Curated text-generation models with provider support.</p>
        <div className="mt-4 relative">
          <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search model ID..."
            className="input-search w-full"
          />
        </div>
      </div>

      {loading && (
        <div className="text-center py-4 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading model library...
        </div>
      )}

      {!loading && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated text-text-primary">
                <tr>
                  <th className="text-left px-4 py-3">Model</th>
                  <th className="text-left px-4 py-3">Downloads</th>
                  <th className="text-left px-4 py-3">Likes</th>
                  <th className="text-left px-4 py-3">Providers</th>
                  <th className="text-left px-4 py-3">Context</th>
                  <th className="text-left px-4 py-3">Tool Support</th>
                  <th className="text-left px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleModels.map((model) => (
                  <tr key={model.id} className="border-t border-bg-elevated/60">
                    <td className="px-4 py-3 font-medium text-text-primary">{model.id}</td>
                    <td className="px-4 py-3 text-text-muted">{formatCount(model.downloads)}</td>
                    <td className="px-4 py-3 text-text-muted">{formatCount(model.likes)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {model.providers.length > 0
                          ? model.providers.map((provider) => (
                              <span key={provider} className="badge-info">
                                {provider}
                                {model.pricing?.[provider]
                                  ? ` ${formatPrice(model.pricing[provider].input)}/${formatPrice(model.pricing[provider].output)}`
                                  : ''}
                              </span>
                            ))
                          : <span className="badge-warning">No providers</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-muted">
                      {model.contextLength ? formatCount(model.contextLength) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {model.supportsTools
                        ? <span className="badge-success">✓</span>
                        : <span className="badge-warning">No</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn-pill"
                          disabled={pairing !== null || model.providers.length === 0}
                          onClick={() => handlePair(model, 'claude-code')}
                        >
                          {pairing === `${model.id}:claude-code` ? 'Pairing...' : 'Pair Claude Code'}
                        </button>
                        <button
                          type="button"
                          className="btn-pill"
                          disabled={pairing !== null || model.providers.length === 0}
                          onClick={() => handlePair(model, 'opencode')}
                        >
                          {pairing === `${model.id}:opencode` ? 'Pairing...' : 'Pair OpenCode'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!searching && visibleModels.length === 0 && (
            <div className="p-8 text-center text-text-muted">No models found.</div>
          )}

          {searching && (
            <div className="p-4 text-center text-text-muted">
              <i className="fa-solid fa-spinner fa-spin mr-2" />
              Searching Hugging Face...
            </div>
          )}
        </div>
      )}

      {error && <div className="text-sm text-danger">{error}</div>}
    </div>
  );
}
