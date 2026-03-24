import { useEffect, useState, useCallback } from 'react';
import { XMarkIcon, PlusIcon, PencilIcon, TrashIcon, CheckIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { configApi } from '../services/api';

export type CustomModelCli = 'claude' | 'opencode' | 'codex';

export interface CustomModelEntry {
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

interface EditRowProps {
  entry: CustomModelEntry;
  onSave: (updated: CustomModelEntry) => void;
  onCancel: () => void;
}

function EditRow({ entry, onSave, onCancel }: EditRowProps) {
  const [form, setForm] = useState<FormState>({
    name: entry.name,
    cli: entry.cli,
    baseUrl: entry.baseUrl,
    token: entry.token,
  });

  const save = () => {
    if (!form.name.trim() || !form.baseUrl.trim() || !form.token.trim()) return;
    onSave({ name: form.name.trim(), cli: form.cli, baseUrl: form.baseUrl.trim(), token: form.token.trim() });
  };

  return (
    <tr className="border-t border-border">
      <td className="px-4 py-3">
        <input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          className="w-full bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          placeholder="My MiniMax Endpoint"
          autoFocus
        />
      </td>
      <td className="px-4 py-3">
        <select
          value={form.cli}
          onChange={(e) => setForm((f) => ({ ...f, cli: e.target.value as CustomModelCli }))}
          className="w-full bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary focus:outline-none"
        >
          {(Object.keys(CLI_LABELS) as CustomModelCli[]).map((k) => (
            <option key={k} value={k}>{CLI_LABELS[k]}</option>
          ))}
        </select>
      </td>
      <td className="px-4 py-3">
        <input
          value={form.baseUrl}
          onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
          className="w-full bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          placeholder="https://api.example.com/v1"
        />
      </td>
      <td className="px-4 py-3">
        <input
          value={form.token}
          onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
          type="password"
          className="w-full bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          placeholder="sk-..."
        />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2 justify-end">
          <button type="button" onClick={save} className="p-1.5 rounded-full bg-success/20 text-success hover:bg-success/30">
            <CheckIcon className="w-4 h-4" />
          </button>
          <button type="button" onClick={onCancel} className="p-1.5 rounded-full bg-text-muted/20 text-text-muted hover:bg-text-muted/30">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
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
  const [addForm, setAddForm] = useState<FormState>(BLANK);

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

  const handleAdd = async () => {
    if (!addForm.name.trim() || !addForm.baseUrl.trim() || !addForm.token.trim()) return;
    const entry: CustomModelEntry = {
      name: addForm.name.trim(),
      cli: addForm.cli,
      baseUrl: addForm.baseUrl.trim(),
      token: addForm.token.trim(),
    };
    await persist([...models, entry]);
    setShowAdd(false);
    setAddForm(BLANK);
  };

  const handleSaveEdit = async (original: CustomModelEntry, updated: CustomModelEntry) => {
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

      {/* Codex warning */}
      <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-5 py-4 text-sm text-yellow-200 flex gap-3 items-start">
        <ExclamationTriangleIcon className="w-5 h-5 mt-0.5 flex-shrink-0 text-yellow-400" />
        <span>
          <strong>Codex:</strong> Your inference provider must support the <code>/v1/responses</code> WebSocket protocol. MiniMax does not — use OpenCode or Claude CLI instead for MiniMax.
        </span>
      </div>

      {loading && (
        <div className="text-center py-8 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading...
        </div>
      )}

      {!loading && (
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-lg font-semibold text-text-primary">Configured Endpoints ({models.length})</h2>
            <button
              type="button"
              onClick={() => { setShowAdd(true); setEditingName(null); }}
              className="btn-accent flex items-center gap-2 text-sm"
            >
              <PlusIcon className="w-4 h-4" />
              Add Endpoint
            </button>
          </div>

          {models.length === 0 && !showAdd && (
            <div className="px-6 py-12 text-center text-text-muted text-sm">
              No custom endpoints configured. Click "Add Endpoint" to get started.
            </div>
          )}

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
                      <EditRow
                        key={m.name}
                        entry={m}
                        onSave={(updated) => handleSaveEdit(m, updated)}
                        onCancel={() => setEditingName(null)}
                      />
                    ) : (
                      <tr key={m.name} className="border-t border-border hover:bg-white/5">
                        <td className="px-4 py-3 font-medium text-text-primary">{m.name}</td>
                        <td className="px-4 py-3 text-text-muted">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-bg-elevated text-text-secondary">
                            {CLI_LABELS[m.cli]}
                          </span>
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

                  {showAdd && (
                    <EditRow
                      key="__add__"
                      entry={{ name: addForm.name, cli: addForm.cli, baseUrl: addForm.baseUrl, token: addForm.token }}
                      onSave={() => handleAdd()}
                      onCancel={() => { setShowAdd(false); setAddForm(BLANK); }}
                    />
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Add form inline row when showAdd but table is empty */}
          {showAdd && models.length === 0 && (
            <div className="px-6 py-4 border-t border-border space-y-3">
              <input
                value={addForm.name}
                onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
                placeholder="Name (e.g. MiniMax via OpenCode)"
                autoFocus
              />
              <select
                value={addForm.cli}
                onChange={(e) => setAddForm((f) => ({ ...f, cli: e.target.value as CustomModelCli }))}
                className="w-full bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary focus:outline-none"
              >
                {(Object.keys(CLI_LABELS) as CustomModelCli[]).map((k) => (
                  <option key={k} value={k}>{CLI_LABELS[k]}</option>
                ))}
              </select>
              <input
                value={addForm.baseUrl}
                onChange={(e) => setAddForm((f) => ({ ...f, baseUrl: e.target.value }))}
                className="w-full bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
                placeholder="Base URL (e.g. https://api.example.com/v1)"
              />
              <input
                value={addForm.token}
                onChange={(e) => setAddForm((f) => ({ ...f, token: e.target.value }))}
                type="password"
                className="w-full bg-bg-elevated rounded-full px-4 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
                placeholder="API Token"
              />
              <div className="flex gap-2">
                <button type="button" onClick={handleAdd} disabled={saving} className="btn-accent text-sm">
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button type="button" onClick={() => { setShowAdd(false); setAddForm(BLANK); }} className="btn-pill text-sm">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {message && <p className="text-sm text-success px-2">{message}</p>}
      {error && <p className="text-sm text-danger px-2">{error}</p>}
    </div>
  );
}
