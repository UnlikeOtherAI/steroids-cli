import React, { useEffect, useState, useCallback } from 'react';
import {
  Cog6ToothIcon,
  ArrowPathIcon,
  CheckIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { configApi, ConfigSchema } from '../services/api';
import { SchemaForm } from '../components/settings/SchemaForm';
import { AISetupModal } from '../components/onboarding/AISetupModal';

export const SettingsPage: React.FC = () => {
  const [schema, setSchema] = useState<ConfigSchema | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [changes, setChanges] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [showAISetup, setShowAISetup] = useState(false);

  // Load schema and config
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [schemaData, configData] = await Promise.all([
        configApi.getSchema(),
        configApi.getConfig('global'),
      ]);
      setSchema(schemaData);
      setConfig(configData);
      setChanges({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load configuration');
    } finally {
      setLoading(false);
    }
  }, []);

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
      await configApi.setConfig(changes, 'global');
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

  // Reusable save bar component
  const SaveBar = ({ sticky = false }: { sticky?: boolean }) => (
    <div className={`${sticky ? 'sticky bottom-0' : ''} bg-bg-surface py-4 -mx-4 px-4 md:-mx-8 md:px-8 border-t border-border flex items-center justify-between`}>
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
  );

  const handleAISetupDone = () => {
    setShowAISetup(false);
    loadData();
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      {showAISetup && (
        <AISetupModal
          onComplete={handleAISetupDone}
          onClose={() => setShowAISetup(false)}
        />
      )}
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Cog6ToothIcon className="w-8 h-8 text-accent" />
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Global Settings</h1>
            <p className="text-sm text-text-muted">
              Configure Steroids behavior and preferences across all projects
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAISetup(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent text-white hover:bg-accent/90 text-sm font-medium transition-colors"
          >
            <i className="fa-solid fa-robot"></i>
            Reconfigure AI
          </button>
          <button
            onClick={loadData}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-bg-surface2 text-text-secondary"
            title="Refresh"
          >
            <ArrowPathIcon className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Location info */}
      <p className="text-sm text-text-muted mb-6">
        Settings stored in{' '}
        <code className="text-xs bg-bg-surface2 px-1 py-0.5 rounded">
          ~/.steroids/config.yaml
        </code>
        . Project-specific overrides can be configured from each project's detail page.
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
          {/* Save Bar - Top */}
          <SaveBar />

          {/* Schema Form */}
          <div className="space-y-6 mt-6">
            <SchemaForm
              schema={schema}
              values={getMergedValues()}
              onChange={handleChange}
            />
          </div>

          {/* Save Bar - Bottom (sticky) */}
          <div className="mt-8">
            <SaveBar sticky />
          </div>
        </>
      ) : (
        <p className="text-text-muted">No configuration schema available.</p>
      )}
    </div>
  );
};
