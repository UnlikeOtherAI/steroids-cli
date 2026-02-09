import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Cog6ToothIcon,
  ArrowPathIcon,
  CheckIcon,
} from '@heroicons/react/24/outline';
import { projectsApi, activityApi, configApi, ApiError, ConfigSchema } from '../services/api';
import { Project, ActivityStats, TimeRangeOption } from '../types';
import { Badge } from '../components/atoms/Badge';
import { Button } from '../components/atoms/Button';
import { Tooltip } from '../components/atoms/Tooltip';
import { StatTile } from '../components/molecules/StatTile';
import { TimeRangeSelector } from '../components/molecules/TimeRangeSelector';
import { SchemaForm } from '../components/settings/SchemaForm';

export const ProjectDetailPage: React.FC = () => {
  const { projectPath } = useParams<{ projectPath: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHours, setSelectedHours] = useState(24);

  // Settings state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSchema, setSettingsSchema] = useState<ConfigSchema | null>(null);
  const [settingsConfig, setSettingsConfig] = useState<Record<string, unknown>>({});
  const [settingsChanges, setSettingsChanges] = useState<Record<string, unknown>>({});
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const decodedPath = projectPath ? decodeURIComponent(projectPath) : '';

  const loadProject = async () => {
    if (!decodedPath) return;

    try {
      setLoading(true);
      setError(null);
      const projects = await projectsApi.list(true);
      const found = projects.find((p) => p.path === decodedPath);
      if (found) {
        setProject(found);
      } else {
        setError('Project not found');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load project');
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    if (!decodedPath) return;

    try {
      const data = await activityApi.getStats(selectedHours, decodedPath);
      setStats(data);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  const loadSettings = useCallback(async () => {
    if (!decodedPath) return;

    setSettingsLoading(true);
    try {
      const [schemaData, configData] = await Promise.all([
        configApi.getSchema(),
        configApi.getConfig('project', decodedPath),
      ]);
      setSettingsSchema(schemaData);
      setSettingsConfig(configData);
      setSettingsChanges({});
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setSettingsLoading(false);
    }
  }, [decodedPath]);

  const handleSettingsChange = (path: string, value: unknown) => {
    setSettingsChanges((prev) => ({ ...prev, [path]: value }));
    setSettingsSaveStatus('idle');
  };

  const handleSettingsSave = async () => {
    if (Object.keys(settingsChanges).length === 0) return;

    setSettingsSaving(true);
    try {
      await configApi.setConfig(settingsChanges, 'project', decodedPath);
      setSettingsSaveStatus('success');
      // Merge changes into config
      setSettingsConfig((prev) => {
        const updated = { ...prev };
        for (const [path, value] of Object.entries(settingsChanges)) {
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
      setSettingsChanges({});
      setTimeout(() => setSettingsSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to save settings:', err);
      setSettingsSaveStatus('error');
    } finally {
      setSettingsSaving(false);
    }
  };

  const getMergedSettingsValues = (): Record<string, unknown> => {
    const merged = JSON.parse(JSON.stringify(settingsConfig));
    for (const [path, value] of Object.entries(settingsChanges)) {
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

  useEffect(() => {
    loadProject();
  }, [decodedPath]);

  useEffect(() => {
    if (settingsOpen && !settingsSchema) {
      loadSettings();
    }
  }, [settingsOpen, settingsSchema, loadSettings]);

  useEffect(() => {
    loadStats();
  }, [decodedPath, selectedHours]);

  const handleEnable = async () => {
    if (!project) return;
    try {
      await projectsApi.enable(project.path);
      await loadProject();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to enable project');
    }
  };

  const handleDisable = async () => {
    if (!project) return;
    try {
      await projectsApi.disable(project.path);
      await loadProject();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to disable project');
    }
  };

  const handleRemove = async () => {
    if (!project) return;
    if (!confirm(`Are you sure you want to remove this project?\n\n${project.path}`)) {
      return;
    }

    try {
      await projectsApi.remove(project.path);
      navigate('/projects');
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to remove project');
    }
  };

  const getRunnerStatus = () => {
    if (!project?.runner) return 'No Runner';
    return project.runner.status.charAt(0).toUpperCase() + project.runner.status.slice(1);
  };

  const getRunnerBadgeVariant = () => {
    if (!project?.runner) return 'default';
    const status = project.runner.status.toLowerCase();
    if (status === 'running' || status === 'active') return 'success';
    if (status === 'idle') return 'warning';
    return 'default';
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="text-center">
          <div className="text-gray-500">Loading project...</div>
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="p-8">
        <div className="text-center">
          <p className="text-red-500">{error || 'Project not found'}</p>
          <Button className="mt-4" onClick={() => navigate('/projects')}>
            Back to Projects
          </Button>
        </div>
      </div>
    );
  }

  const projectName = project.name || project.path.split('/').pop() || 'Project';

  const getTimeRangeValue = () => {
    switch (selectedHours) {
      case 12: return '12h';
      case 24: return '24h';
      case 168: return '1w';
      case 720: return '1m';
      default: return '1y';
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <button
          onClick={() => navigate('/projects')}
          className="text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          &larr; Back to Projects
        </button>

        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{projectName}</h1>
            <Tooltip content={project.path}>
              <p className="text-sm text-gray-500 font-mono mt-1 truncate max-w-lg">
                {project.path}
              </p>
            </Tooltip>
          </div>
          <div className="flex gap-2">
            <Badge variant={project.enabled ? 'success' : 'default'}>
              {project.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            <Badge variant={getRunnerBadgeVariant()}>{getRunnerStatus()}</Badge>
          </div>
        </div>
      </div>

      <div className="mb-8 flex gap-3">
        {project.enabled ? (
          <Button variant="secondary" onClick={handleDisable}>
            Disable Project
          </Button>
        ) : (
          <Button onClick={handleEnable}>Enable Project</Button>
        )}
        <Button variant="secondary" onClick={handleRemove}>
          Remove Project
        </Button>
      </div>

      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Activity</h2>
          <TimeRangeSelector
            value={getTimeRangeValue()}
            onChange={(option: TimeRangeOption) => setSelectedHours(option.hours)}
          />
        </div>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatTile label="Completed" value={stats.completed} variant="success" />
            <StatTile label="Failed" value={stats.failed} variant="danger" />
            <StatTile label="Skipped" value={stats.skipped} variant="warning" />
            <StatTile label="Partial" value={stats.partial} variant="info" />
            <StatTile label="Disputed" value={stats.disputed} variant="default" />
          </div>
        )}

        {stats && (
          <div className="mt-4 flex gap-6 text-sm text-gray-600">
            <span>Rate: {stats.tasks_per_hour} tasks/hour</span>
            <span>Success Rate: {stats.success_rate}%</span>
          </div>
        )}
      </div>

      {project.stats && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Current Queue</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatTile label="Pending" value={project.stats.pending} variant="default" />
            <StatTile label="In Progress" value={project.stats.in_progress} variant="info" />
            <StatTile label="Review" value={project.stats.review} variant="warning" />
            <StatTile label="Completed" value={project.stats.completed} variant="success" />
          </div>
        </div>
      )}

      {/* Project Settings */}
      <div className="mb-8">
        <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          className="flex items-center gap-2 text-xl font-semibold text-gray-900 mb-4 hover:text-gray-700"
        >
          {settingsOpen ? (
            <ChevronDownIcon className="w-5 h-5" />
          ) : (
            <ChevronRightIcon className="w-5 h-5" />
          )}
          <Cog6ToothIcon className="w-5 h-5" />
          <span>Project Settings</span>
        </button>

        {settingsOpen && (
          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-sm text-gray-500 mb-4">
              Project-specific settings override global settings. Stored in{' '}
              <code className="text-xs bg-gray-200 px-1 py-0.5 rounded">
                .steroids/config.yaml
              </code>
            </p>

            {settingsLoading ? (
              <div className="flex items-center justify-center py-8">
                <ArrowPathIcon className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : settingsSchema ? (
              <>
                <SchemaForm
                  schema={settingsSchema}
                  values={getMergedSettingsValues()}
                  onChange={handleSettingsChange}
                />

                <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-200">
                  <div className="flex items-center gap-2">
                    {Object.keys(settingsChanges).length > 0 && (
                      <span className="text-sm text-gray-500">
                        {Object.keys(settingsChanges).length} unsaved change
                        {Object.keys(settingsChanges).length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {settingsSaveStatus === 'success' && (
                      <span className="flex items-center gap-1 text-sm text-green-600">
                        <CheckIcon className="w-4 h-4" />
                        Saved
                      </span>
                    )}
                  </div>

                  <button
                    onClick={handleSettingsSave}
                    disabled={Object.keys(settingsChanges).length === 0 || settingsSaving}
                    className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                      Object.keys(settingsChanges).length > 0
                        ? 'bg-blue-600 text-white hover:bg-blue-700'
                        : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    }`}
                  >
                    {settingsSaving ? (
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
              <p className="text-gray-500">No configuration schema available.</p>
            )}
          </div>
        )}
      </div>

      <div className="text-sm text-gray-500">
        <p>Registered: {new Date(project.registered_at).toLocaleString()}</p>
        <p>
          Last activity: {project.last_activity_at
            ? new Date(project.last_activity_at).toLocaleString()
            : project.runner
              ? 'No recent activity'
              : 'No runner'
          }
        </p>
        {project.runner?.current_task_id && (
          <p
            className="mt-2 cursor-pointer text-blue-600 hover:text-blue-800"
            onClick={() => navigate(`/task/${project.runner!.current_task_id}?project=${encodeURIComponent(project.path)}`)}
          >
            <i className="fa-solid fa-arrow-up-right-from-square text-xs mr-1"></i>
            Current Task: {project.runner.current_task_id}
          </p>
        )}
      </div>
    </div>
  );
};

export default ProjectDetailPage;
