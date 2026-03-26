import {
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';

import {
  AIModel,
  AIProvider,
  MonitorAgentConfig,
  MonitorResponseMode,
} from '../services/api';
import { AISetupRoleSelector } from '../components/onboarding/AISetupRoleSelector';

const PRESET_LABELS: Record<MonitorResponseMode, { label: string; description: string }> = {
  monitor_only: {
    label: 'Just Monitor',
    description: 'Record anomalies only. Never dispatch a first responder automatically.',
  },
  triage_only: {
    label: 'Triage Only',
    description: 'Investigate and identify the problem without mutating project or runner state.',
  },
  fix_and_monitor: {
    label: 'Fix & Monitor',
    description: 'Attempt to fix issues automatically (reset tasks, restart runners), keep monitoring.',
  },
  custom: {
    label: 'Custom',
    description: 'Provide your own instructions for the first responder.',
  },
};

const INTERVAL_OPTIONS = [
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 1800, label: '30 minutes' },
];

const SEVERITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'critical', label: 'Critical only' },
  { value: 'warning', label: 'Warning and above' },
  { value: 'info', label: 'All anomalies' },
];

interface MonitorConfigSectionProps {
  configOpen: boolean;
  intervalSeconds: number;
  minSeverity: string;
  agents: MonitorAgentConfig[];
  providers: AIProvider[];
  models: Record<string, AIModel[]>;
  modelSources: Record<string, string>;
  copiedCommand: string | null;
  refreshingProvider: string | null;
  responsePreset: MonitorResponseMode;
  responsePresetDeprecated: boolean;
  customPrompt: string;
  saveSuccess: boolean;
  saving: boolean;
  onToggleConfig: () => void;
  onIntervalSecondsChange: (value: number) => void;
  onMinSeverityChange: (value: string) => void;
  onAgentProviderChange: (index: number, providerId: string) => void | Promise<void>;
  onAgentModelChange: (index: number, modelId: string) => void;
  onRefreshModels: (providerId: string) => void | Promise<void>;
  onCopyToClipboard: (text: string, id: string) => void;
  onAddAgent: () => void;
  onRemoveAgent: (index: number) => void;
  onResponsePresetChange: (mode: MonitorResponseMode) => void;
  onCustomPromptChange: (value: string) => void;
  onSave: () => void | Promise<void>;
}

export function MonitorConfigSection({
  configOpen,
  intervalSeconds,
  minSeverity,
  agents,
  providers,
  models,
  modelSources,
  copiedCommand,
  refreshingProvider,
  responsePreset,
  responsePresetDeprecated,
  customPrompt,
  saveSuccess,
  saving,
  onToggleConfig,
  onIntervalSecondsChange,
  onMinSeverityChange,
  onAgentProviderChange,
  onAgentModelChange,
  onRefreshModels,
  onCopyToClipboard,
  onAddAgent,
  onRemoveAgent,
  onResponsePresetChange,
  onCustomPromptChange,
  onSave,
}: MonitorConfigSectionProps) {
  return (
    <div className="mb-8">
      <button
        onClick={onToggleConfig}
        className="flex items-center gap-2 text-xl font-semibold text-text-primary mb-4 hover:text-text-secondary"
      >
        {configOpen ? (
          <ChevronDownIcon className="w-5 h-5" />
        ) : (
          <ChevronRightIcon className="w-5 h-5" />
        )}
        <i className="fa-solid fa-gear w-5 h-5 flex items-center justify-center text-sm"></i>
        <span>Configuration</span>
      </button>

      {configOpen && (
        <div className="bg-bg-surface rounded-lg p-6 shadow-sm border border-border space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-text-secondary mb-1 uppercase tracking-wider">
                Check Interval
              </label>
              <select
                value={intervalSeconds}
                onChange={(event) => onIntervalSecondsChange(Number(event.target.value))}
                className="w-full px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
              >
                {INTERVAL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1 uppercase tracking-wider">
                Escalation Threshold
              </label>
              <select
                value={minSeverity}
                onChange={(event) => onMinSeverityChange(event.target.value)}
                className="w-full px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
              >
                {SEVERITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <i className="fa-solid fa-user-secret text-accent"></i>
                <span className="font-medium text-text-primary text-sm uppercase tracking-wider">
                  First Responder Agents
                </span>
                <span className="text-[10px] text-text-muted">(fallback chain, first = preferred)</span>
              </div>
            </div>

            <div className="space-y-3">
              {agents.map((agent, index) => (
                <AISetupRoleSelector
                  key={index}
                  label={`First Responder ${index + 1}`}
                  icon="fa-user-secret"
                  config={agent}
                  providers={providers}
                  modelsByProvider={models}
                  modelSources={modelSources}
                  copiedCommand={copiedCommand}
                  refreshingProvider={refreshingProvider}
                  isProjectLevel={false}
                  isInherited={false}
                  onProviderChange={(providerId) => onAgentProviderChange(index, providerId)}
                  onModelChange={(modelId) => onAgentModelChange(index, modelId)}
                  onRefreshModels={onRefreshModels}
                  onCopyToClipboard={onCopyToClipboard}
                  onRemove={agents.length > 1 ? () => onRemoveAgent(index) : undefined}
                />
              ))}
              <button
                onClick={onAddAgent}
                className="w-full py-2 border border-dashed border-border rounded-lg text-xs text-text-muted hover:text-accent hover:border-accent transition-colors flex items-center justify-center gap-1"
              >
                <PlusIcon className="w-3 h-3" />
                Add First Responder (Fallback)
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs text-text-secondary mb-2 uppercase tracking-wider">
              Response Strategy
            </label>
            {responsePresetDeprecated && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                A legacy monitor preset is configured in storage. Saving will migrate it to the selected canonical mode.
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {(Object.entries(PRESET_LABELS) as Array<[MonitorResponseMode, typeof PRESET_LABELS[MonitorResponseMode]]>).map(
                ([key, { label, description }]) => (
                  <label
                    key={key}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      responsePreset === key
                        ? 'border-accent bg-accent/5'
                        : 'border-border bg-bg-base hover:border-accent/50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="preset"
                      value={key}
                      checked={responsePreset === key}
                      onChange={() => onResponsePresetChange(key)}
                      className="mt-1 w-4 h-4 text-accent border-border focus:ring-accent"
                    />
                    <div>
                      <div className="font-medium text-text-primary text-sm">{label}</div>
                      <div className="text-xs text-text-muted mt-0.5">{description}</div>
                    </div>
                  </label>
                ),
              )}
            </div>

            {responsePreset === 'custom' && (
              <textarea
                value={customPrompt}
                onChange={(event) => onCustomPromptChange(event.target.value)}
                placeholder="Enter custom instructions for the first responder agent..."
                rows={4}
                className="w-full mt-3 px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent resize-y"
              />
            )}
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-border">
            <div>
              {saveSuccess && (
                <span className="flex items-center gap-1 text-sm text-green-600">
                  <CheckCircleIcon className="w-4 h-4" />
                  Saved
                </span>
              )}
            </div>
            <button
              onClick={onSave}
              disabled={saving}
              className="px-6 py-2 rounded-lg font-medium transition-colors bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <i className="fa-solid fa-spinner animate-spin"></i>
                  Saving...
                </span>
              ) : (
                'Save Configuration'
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
