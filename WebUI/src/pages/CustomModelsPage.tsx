import { useEffect, useState, useCallback } from 'react';
import { PlusIcon, PencilIcon, TrashIcon, CheckIcon, ExclamationTriangleIcon, BoltIcon } from '@heroicons/react/24/outline';
import { configApi } from '../services/api';

export type CustomModelCli = 'claude' | 'opencode' | 'codex';

export interface CustomModelEntry {
  id: string;
  name: string;
  cli: CustomModelCli;
  baseUrl: string;
  token: string;
}

interface FormState {
  name: string;
  cli: CustomModelCli;
  baseUrl: string;
  token: string;
}

const BLANK: FormState = { name: '', cli: 'opencode', baseUrl: '', token: '' };

const CLI_LABELS: Record<CustomModelCli, string> = {
  claude: 'Claude CLI',
  opencode: 'OpenCode CLI',
  codex: 'Codex CLI',
};

function isValidUrl(value: string): boolean {
  if (!value.trim()) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

interface CliWarningProps {
  cli: CustomModelCli;
}

function CliWarning({ cli }: CliWarningProps) {
  if (cli !== 'codex') return null;
  return (
    <div className="mt-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2.5 text-xs text-yellow-200 flex gap-2 items-start">
      <ExclamationTriangleIcon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-yellow-400" />
      <span>
        Your inference provider must support the <code className="text-yellow-100">/v1/responses</code> WebSocket protocol. MiniMax does not — use OpenCode or Claude CLI instead for MiniMax.
      </span>
    </div>
  );
}

interface EndpointFormProps {
  initial?: FormState;
  onSave: (data: FormState) => void;
  onCancel: () => void;
  saving?: boolean;
}

function EndpointForm({ initial = BLANK, onSave, onCancel, saving }: EndpointFormProps) {
  const [form, setForm] = useState<FormState>(initial);
  const [baseUrlError, setBaseUrlError] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const valid = form.name.trim() && form.baseUrl.trim() && form.token.trim() && !baseUrlError;

  const handleBaseUrlChange = (value: string) => {
    setForm((f) => ({ ...f, baseUrl: value }));
    setBaseUrlError(value.trim() !== '' && !isValidUrl(value));
    setTestResult(null);
  };

  const handleSave = () => {
    if (!isValidUrl(form.baseUrl)) { setBaseUrlError(true); return; }
    onSave({ ...form, name: form.name.trim(), baseUrl: form.baseUrl.trim(), token: form.token.trim() });
  };

  const handleTest = async () => {
    if (!isValidUrl(form.baseUrl) || !form.token.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('http://localhost:3501/api/custom/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: form.baseUrl.trim(), token: form.token.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setTestResult({ ok: true, message: data.message || `${data.status} — endpoint reachable` });
      } else {
        setTestResult({ ok: false, message: data.message || `Error ${data.status}` });
      }
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : 'Connection failed' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Name */}
      <div>
        <label className="block text-xs font-medium text-text-muted mb-1">Name</label>
        <input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          className="w-full bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          placeholder="My MiniMax Endpoint"
          autoFocus
        />
      </div>

      {/* CLI */}
      <div>
        <label className="block text-xs font-medium text-text-muted mb-1">CLI</label>
        <select
          value={form.cli}
          onChange={(e) => { setForm((f) => ({ ...f, cli: e.target.value as CustomModelCli })); setTestResult(null); }}
          className="w-full bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {(Object.keys(CLI_LABELS) as CustomModelCli[]).map((k) => (
            <option key={k} value={k}>{CLI_LABELS[k]}</option>
          ))}
        </select>
        <CliWarning cli={form.cli} />
      </div>

      {/* Base URL */}
      <div>
        <label className="block text-xs font-medium text-text-muted mb-1">Base URL</label>
        <input
          value={form.baseUrl}
          onChange={(e) => handleBaseUrlChange(e.target.value)}
          className={`w-full bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 ${
            baseUrlError ? 'ring-1 ring-red-500 focus:ring-red-500' : 'focus:ring-accent'
          }`}
          placeholder="https://api.example.com/v1"
        />
        {baseUrlError && (
          <p className="mt-1 text-xs text-red-400">Must be a valid http:// or https:// URL</p>
        )}
      </div>

      {/* Token */}
      <div>
        <label className="block text-xs font-medium text-text-muted mb-1">Token</label>
        <input
          value={form.token}
          onChange={(e) => { setForm((f) => ({ ...f, token: e.target.value })); setTestResult(null); }}
          type="password"
          className="w-full bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          placeholder="sk-..."
        />
      </div>

      {/* Test result */}
      {testResult && (
        <div className={`rounded-lg px-3 py-2 text-xs flex items-center gap-2 ${
          testResult.ok ? 'bg-success/10 text-success border border-success/30' : 'bg-danger/10 text-danger border border-danger/30'
        }`}>
          {testResult.ok
            ? <CheckIcon className="w-3.5 h-3.5 flex-shrink-0" />
            : <ExclamationTriangleIcon className="w-3.5 h-3.5 flex-shrink-0" />}
          {testResult.message}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleSave}
          disabled={!valid || saving}
          className="btn-accent text-sm disabled:opacity-40"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={handleTest}
          disabled={!isValidUrl(form.baseUrl) || !form.token.trim() || testing}
          className="btn-pill text-sm flex items-center gap-1.5 disabled:opacity-40"
        >
          {testing ? <span className="fa-solid fa-spinner fa-spin w-3.5 h-3.5 inline-block" /> : <BoltIcon className="w-3.5 h-3.5" />}
          Test
        </button>
        <button type="button" onClick={onCancel} className="btn-pill text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function CustomModelsPage() {
  const [models, setModels] = useState<CustomModelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = (await configApi.getConfig('global')) as Record<string, unknown>;
      const ai = cfg.ai as Record<string, unknown> | undefined;
      const custom = ai?.custom as Record<string, unknown> | undefined;
      setModels((custom?.models as CustomModelEntry[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load models');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const persist = async (updated: CustomModelEntry[]) => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await configApi.setConfig({ ai: { custom: { models: updated } } }, 'global');
      setModels(updated);
      setMessage('Changes saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async (form: FormState) => {
    const entry: CustomModelEntry = {
      id: form.name.trim(),
      name: form.name.trim(),
      cli: form.cli,
      baseUrl: form.baseUrl.trim(),
      token: form.token.trim(),
    };
    await persist([...models, entry]);
    setShowAdd(false);
  };

  const handleSaveEdit = async (original: CustomModelEntry, form: FormState) => {
    const updated: CustomModelEntry = {
      ...original,
      name: form.name.trim(),
      cli: form.cli,
      baseUrl: form.baseUrl.trim(),
      token: form.token.trim(),
    };
    await persist(models.map((m) => (m.name === original.name ? updated : m)));
    setEditingName(null);
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    await persist(models.filter((m) => m.name !== name));
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <div className="card p-6">
        <h1 className="text-3xl font-bold text-text-primary">Custom Endpoints</h1>
        <p className="mt-2 text-sm text-text-muted">
          Define your own inference endpoints. When selected as a runner, the CLI is invoked with your base URL and token injected as environment variables.
        </p>
      </div>

      {loading && (
        <div className="text-center py-8 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading...
        </div>
      )}

      {!loading && (
        <>
          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text-primary">Configured Endpoints ({models.length})</h2>
              {!showAdd && (
                <button
                  type="button"
                  onClick={() => { setShowAdd(true); setEditingName(null); }}
                  className="btn-accent flex items-center gap-2 text-sm"
                >
                  <PlusIcon className="w-4 h-4" />
                  Add Endpoint
                </button>
              )}
            </div>

            {/* Empty state */}
            {models.length === 0 && !showAdd && (
              <div className="px-6 py-12 text-center text-text-muted text-sm">
                No custom endpoints configured. Click "Add Endpoint" to get started.
              </div>
            )}

            {/* Add form (shown below header when adding) */}
            {showAdd && (
              <div className="px-6 py-5 border-t border-border bg-bg-elevated/30">
                <EndpointForm
                  initial={BLANK}
                  onSave={handleAdd}
                  onCancel={() => setShowAdd(false)}
                  saving={saving}
                />
              </div>
            )}

            {/* Table */}
            {(models.length > 0 || showAdd) && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-text-muted text-xs uppercase tracking-wide">
                      <th className="px-4 py-3 font-medium">Name</th>
                      <th className="px-4 py-3 font-medium">CLI</th>
                      <th className="px-4 py-3 font-medium">Base URL</th>
                      <th className="px-4 py-3 font-medium">Token</th>
                      <th className="px-4 py-3 font-medium w-24" />
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m) =>
                      editingName === m.name ? (
                        <tr key={m.name} className="border-t border-border">
                          <td colSpan={5} className="px-4 py-4 bg-bg-elevated/30">
                            <EndpointForm
                              initial={{ name: m.name, cli: m.cli, baseUrl: m.baseUrl, token: m.token }}
                              onSave={(form) => handleSaveEdit(m, form)}
                              onCancel={() => setEditingName(null)}
                              saving={saving}
                            />
                          </td>
                        </tr>
                      ) : (
                        <tr key={m.name} className="border-t border-border hover:bg-white/5">
                          <td className="px-4 py-3 font-medium text-text-primary">{m.name}</td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-bg-elevated text-text-secondary">
                              {CLI_LABELS[m.cli]}
                            </span>
                            {m.cli === 'codex' && (
                              <div className="mt-1.5 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-2 py-1.5 text-xs text-yellow-200 flex gap-1.5 items-start">
                                <ExclamationTriangleIcon className="w-3 h-3 mt-0.5 flex-shrink-0 text-yellow-400" />
                                <span>MiniMax does not support <code className="text-yellow-100">/v1/responses</code> — use OpenCode or Claude CLI instead.</span>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-text-muted font-mono text-xs">{m.baseUrl}</td>
                          <td className="px-4 py-3 text-text-muted font-mono text-xs">{'•'.repeat(Math.min(m.token.length, 8))}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={() => { setEditingName(m.name); setShowAdd(false); }}
                                className="p-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-bg-elevated"
                                title="Edit"
                              >
                                <PencilIcon className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(m.name)}
                                className="p-1.5 rounded-full text-text-muted hover:text-danger hover:bg-danger/10"
                                title="Delete"
                              >
                                <TrashIcon className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {message && <p className="text-sm text-success px-2">{message}</p>}
          {error && <p className="text-sm text-danger px-2">{error}</p>}
        </>
      )}
    </div>
  );
}
