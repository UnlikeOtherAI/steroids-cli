import { useEffect, useState } from 'react';
import type { HFReadyModel } from '../types';
import { huggingFaceApi } from '../services/huggingFaceApi';

function formatRuntime(runtime: string): string {
  return runtime === 'claude-code' ? 'Claude Code' : 'OpenCode';
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

function getPriceIndicator(model: HFReadyModel): string {
  const pricing = model.pricing ?? {};
  const current = pricing[model.routingPolicy];
  if (current) {
    return `${formatPrice(current.input)}/${formatPrice(current.output)}`;
  }

  const values = Object.values(pricing);
  if (values.length === 0) return '—';

  const minInput = Math.min(...values.map((entry) => entry.input));
  const maxInput = Math.max(...values.map((entry) => entry.input));
  const minOutput = Math.min(...values.map((entry) => entry.output));
  const maxOutput = Math.max(...values.map((entry) => entry.output));

  if (minInput === maxInput && minOutput === maxOutput) {
    return `${formatPrice(minInput)}/${formatPrice(minOutput)}`;
  }
  return `${formatPrice(minInput)}-${formatPrice(maxInput)} / ${formatPrice(minOutput)}-${formatPrice(maxOutput)}`;
}

export function HFReadyToUsePage() {
  const [models, setModels] = useState<HFReadyModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await huggingFaceApi.getReadyModels();
      setModels(response.models);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ready models');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const setRoutingPolicy = async (model: HFReadyModel, routingPolicy: string) => {
    const key = `${model.modelId}:${model.runtime}`;
    setUpdating(key);
    setError(null);
    try {
      await huggingFaceApi.updateRoutingPolicy({
        modelId: model.modelId,
        runtime: model.runtime,
        routingPolicy,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update routing policy');
    } finally {
      setUpdating(null);
    }
  };

  const removePairing = async (model: HFReadyModel) => {
    const key = `${model.modelId}:${model.runtime}`;
    setUpdating(key);
    setError(null);
    try {
      await huggingFaceApi.unpairModel({ modelId: model.modelId, runtime: model.runtime });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove pairing');
    } finally {
      setUpdating(null);
    }
  };

  const changeRuntime = async (model: HFReadyModel, nextRuntime: 'claude-code' | 'opencode') => {
    if (model.runtime === nextRuntime) return;
    const key = `${model.modelId}:${model.runtime}`;
    setUpdating(key);
    setError(null);
    try {
      await huggingFaceApi.changeRuntime({
        modelId: model.modelId,
        runtime: model.runtime,
        nextRuntime,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change runtime');
    } finally {
      setUpdating(null);
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="card p-6">
        <h1 className="text-3xl font-bold text-text-primary">Hugging Face Ready to Use</h1>
        <p className="mt-2 text-sm text-text-muted">
          Models paired with a runtime. Routing policy controls provider selection per request.
        </p>
      </div>

      {loading && (
        <div className="text-center py-4 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading paired models...
        </div>
      )}

      {!loading && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated text-text-primary">
                <tr>
                  <th className="text-left px-4 py-3">Model</th>
                  <th className="text-left px-4 py-3">Runtime</th>
                  <th className="text-left px-4 py-3">Routing Policy</th>
                  <th className="text-left px-4 py-3">Price Indicator</th>
                  <th className="text-left px-4 py-3">Context Length</th>
                  <th className="text-left px-4 py-3">Providers</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => {
                  const key = `${model.modelId}:${model.runtime}`;
                  const isUpdating = updating === key;
                  return (
                    <tr key={key} className="border-t border-bg-elevated/60">
                      <td className="px-4 py-3 font-medium text-text-primary">{model.modelId}</td>
                      <td className="px-4 py-3 text-text-muted">{formatRuntime(model.runtime)}</td>
                      <td className="px-4 py-3">
                        <select
                          className="bg-bg-elevated rounded-full px-4 py-2"
                          value={model.routingPolicy}
                          disabled={isUpdating}
                          onChange={(e) => setRoutingPolicy(model, e.target.value)}
                        >
                          {model.routingPolicyOptions.map((policy) => (
                            <option key={policy} value={policy}>{policy}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-text-muted">{getPriceIndicator(model)}</td>
                      <td className="px-4 py-3 text-text-muted">
                        {model.contextLength ? formatCount(model.contextLength) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {model.providers.length > 0
                            ? model.providers.map((provider) => (
                                <span key={provider} className="badge-info">{provider}</span>
                              ))
                            : <span className="text-text-muted">—</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {model.available
                          ? <span className="badge-success">Available</span>
                          : <span className="badge-danger">Unavailable</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <select
                            className="bg-bg-elevated rounded-full px-4 py-2"
                            value={model.runtime}
                            disabled={isUpdating}
                            onChange={(e) => changeRuntime(model, e.target.value as 'claude-code' | 'opencode')}
                          >
                            <option value="claude-code">Claude Code</option>
                            <option value="opencode">OpenCode</option>
                          </select>
                          <button
                            type="button"
                            className="btn-pill"
                            disabled={isUpdating}
                            onClick={() => removePairing(model)}
                          >
                            {isUpdating ? 'Working...' : 'Remove'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!loading && models.length === 0 && (
            <div className="p-8 text-center text-text-muted">No paired Hugging Face models yet.</div>
          )}
        </div>
      )}

      {error && <div className="text-sm text-danger">{error}</div>}
    </div>
  );
}
