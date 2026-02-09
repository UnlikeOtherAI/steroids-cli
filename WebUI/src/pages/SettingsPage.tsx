import React, { useEffect, useState, useCallback } from 'react';
import {
  Cog6ToothIcon,
  GlobeAltIcon,
  FolderIcon,
  ArrowPathIcon,
  CheckIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { configApi, ConfigSchema } from '../services/api';
import { SchemaForm } from '../components/settings/SchemaForm';
import { useProject } from '../contexts/ProjectContext';

type Scope = 'global' | 'project';

export const SettingsPage: React.FC = () => {
  const { selectedProject } = useProject();
  const [scope, setScope] = useState<Scope>('global');
  const [schema, setSchema] = useState<ConfigSchema | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [changes, setChanges] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const projectPath = selectedProject?.path;
  const projectName = selectedProject?.name || projectPath?.split('/').pop();

  // Load schema and config
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [schemaData, configData] = await Promise.all([
        configApi.getSchema(),
        configApi.getConfig(scope, scope === 'project' ? projectPath : undefined),
      ]);
      setSchema(schemaData);
      setConfig(configData);
      setChanges({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load configuration');
    } finally {
      setLoading(false);
    }
  }, [scope, projectPath]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle field changes
  const handleChange = (path: string, value: unknown) => {
    setChanges((prev) => ({ ...prev, [path]: value }));
    setSaveStatus('idle');
  };

  // Save changes
  const handleSave = async () => {
    if (Object.keys(changes).length === 0) return;

    setSaving(true);
    setError(null);
    try {
      await configApi.setConfig(
        changes,
        scope,
        scope === 'project' ? projectPath : undefined
      );
      setSaveStatus('success');
      // Merge changes into config
      setConfig((prev) => {
        const updated = { ...prev };
        for (const [path, value] of Object.entries(changes)) {
          const keys = path.split('.');
          let current: Record<string, unknown> = updated;
          for (let i = 0; i < keys.length - 1; i++) {
            if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
              current[keys[i]] = {};
            }
            current = current[keys[i]] as Record<string, unknown>;
          }
          current[keys[keys.length - 1]] = value;
        }
        return updated;
      });
      setChanges({});
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save configuration');
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  };

  // Get merged values (config + unsaved changes)
  const getMergedValues = (): Record<string, unknown> => {
    const merged = JSON.parse(JSON.stringify(config));
    for (const [path, value] of Object.entries(changes)) {
      const keys = path.split('.');
      let current: Record<string, unknown> = merged;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
          current[keys[i]] = {};
        }
        current = current[keys[i]] as Record<string, unknown>;
      }
      current[keys[keys.length - 1]] = value;
    }
    return merged;
  };

  const hasChanges = Object.keys(changes).length > 0;

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Cog6ToothIcon className="w-8 h-8 text-accent" />
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Settings</h1>
            <p className="text-sm text-text-muted">
              Configure Steroids behavior and preferences
            </p>
          </div>
        </div>

        <button
          onClick={loadData}
          disabled={loading}
          className="p-2 rounded-lg hover:bg-bg-surface2 text-text-secondary"
          title="Refresh"
        >
          <ArrowPathIcon className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Scope Toggle */}
      <div className="bg-bg-surface rounded-xl p-1 inline-flex mb-6">
        <button
          onClick={() => setScope('global')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
            scope === 'global'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <GlobeAltIcon className="w-4 h-4" />
          <span>Global</span>
        </button>
        <button
          onClick={() => setScope('project')}
          disabled={!projectPath}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
            scope === 'project'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:text-text-primary'
          } ${!projectPath ? 'opacity-50 cursor-not-allowed' : ''}`}
          title={projectPath ? `Project: ${projectName}` : 'Select a project first'}
        >
          <FolderIcon className="w-4 h-4" />
          <span>{projectName || 'Project'}</span>
        </button>
      </div>

      {/* Scope Description */}
      <p className="text-sm text-text-muted mb-6">
        {scope === 'global' ? (
          <>
            Global settings apply to all projects. Stored in{' '}
            <code className="text-xs bg-bg-surface2 px-1 py-0.5 rounded">
              ~/.steroids/config.yaml
            </code>
          </>
        ) : (
          <>
            Project settings override global settings for this project. Stored in{' '}
            <code className="text-xs bg-bg-surface2 px-1 py-0.5 rounded">
              .steroids/config.yaml
            </code>
          </>
        )}
      </p>

      {/* Error Alert */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3">
          <ExclamationTriangleIcon className="w-5 h-5 text-red-500 flex-shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Loading State */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <ArrowPathIcon className="w-8 h-8 animate-spin text-accent" />
        </div>
      ) : schema ? (
        <>
          {/* Schema Form */}
          <div className="space-y-6">
            <SchemaForm
              schema={schema}
              values={getMergedValues()}
              onChange={handleChange}
            />
          </div>

          {/* Save Button */}
          <div className="sticky bottom-0 bg-bg-surface py-4 mt-8 -mx-4 px-4 md:-mx-8 md:px-8 border-t border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              {hasChanges && (
                <span className="text-sm text-text-muted">
                  {Object.keys(changes).length} unsaved change
                  {Object.keys(changes).length !== 1 ? 's' : ''}
                </span>
              )}
              {saveStatus === 'success' && (
                <span className="flex items-center gap-1 text-sm text-green-600">
                  <CheckIcon className="w-4 h-4" />
                  Saved
                </span>
              )}
            </div>

            <button
              onClick={handleSave}
              disabled={!hasChanges || saving}
              className={`px-6 py-2 rounded-lg font-medium transition-colors ${
                hasChanges
                  ? 'bg-accent text-white hover:bg-accent/90'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <ArrowPathIcon className="w-4 h-4 animate-spin" />
                  Saving...
                </span>
              ) : (
                'Save Changes'
              )}
            </button>
          </div>
        </>
      ) : (
        <p className="text-text-muted">No configuration schema available.</p>
      )}
    </div>
  );
};
