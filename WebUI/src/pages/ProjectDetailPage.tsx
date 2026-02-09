import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Cog6ToothIcon,
  ArrowPathIcon,
  CheckIcon,
} from '@heroicons/react/24/outline';
import { projectsApi, activityApi, configApi, sectionsApi, ApiError, ConfigSchema } from '../services/api';
import { Project, ActivityStats, TimeRangeOption, Section } from '../types';
import { Badge } from '../components/atoms/Badge';
import { Button } from '../components/atoms/Button';
import { Tooltip } from '../components/atoms/Tooltip';
import { StatTile } from '../components/molecules/StatTile';
import { TimeRangeSelector } from '../components/molecules/TimeRangeSelector';
import { SchemaForm } from '../components/settings/SchemaForm';
import { PageLayout } from '../components/templates/PageLayout';

export const ProjectDetailPage: React.FC = () => {
  const { projectPath } = useParams<{ projectPath: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHours, setSelectedHours] = useState(24);

  // Sections state
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(false);

  // Settings state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSchema, setSettingsSchema] = useState<ConfigSchema | null>(null);
  const [settingsConfig, setSettingsConfig] = useState<Record<string, unknown>>({});
  const [globalConfig, setGlobalConfig] = useState<Record<string, unknown>>({});
  const [settingsChanges, setSettingsChanges] = useState<Record<string, unknown>>({});
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [pathCopied, setPathCopied] = useState(false);

  const decodedPath = projectPath ? decodeURIComponent(projectPath) : '';

  const handleCopyPath = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(project?.path || '');
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  };

  const handleOpenPath = async () => {
    if (!project?.path) return;
    try {
      await projectsApi.openFolder(project.path);
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  };

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

  const loadSections = async () => {
    if (!decodedPath) return;

    setSectionsLoading(true);
    try {
      const response = await sectionsApi.listForProject(decodedPath);
      // Sort sections alphabetically by name
      const sortedSections = [...response.sections].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
      setSections(sortedSections);
    } catch (err) {
      console.error('Failed to load sections:', err);
    } finally {
      setSectionsLoading(false);
    }
  };

  const loadSettings = useCallback(async () => {
    if (!decodedPath) return;

    setSettingsLoading(true);
    try {
      const [schemaData, projectConfigData, globalConfigData] = await Promise.all([
        configApi.getSchema(),
        configApi.getConfig('project', decodedPath),
        configApi.getConfig('global'),
      ]);
      setSettingsSchema(schemaData);
      setSettingsConfig(projectConfigData);
      setGlobalConfig(globalConfigData);
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
    loadSections();
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

  const projectName = project?.name || project?.path.split('/').pop() || 'Project';

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
    <PageLayout
      title={projectName}
      backTo="/projects"
      backLabel="Back to Projects"
      loading={loading}
      loadingMessage="Loading project..."
      error={error || (!loading && !project ? 'Project not found' : null)}
      maxWidth="max-w-7xl"
      actions={
        project && (
          <div className="flex gap-2">
            <Badge variant={project.enabled ? 'success' : 'default'}>
              {project.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            <Badge variant={getRunnerBadgeVariant()}>{getRunnerStatus()}</Badge>
          </div>
        )
      }
    >
      {project && (
        <>
          {/* Path with copy/open actions */}
          <div className="flex items-center gap-2 -mt-4 mb-6">
            <Tooltip content="Open in Finder">
              <button
                onClick={handleOpenPath}
                className="text-sm text-text-muted font-mono hover:text-accent truncate max-w-lg transition-colors text-left"
              >
                {project.path}
              </button>
            </Tooltip>
            <Tooltip content={pathCopied ? 'Copied!' : 'Copy path'}>
              <button
                onClick={handleCopyPath}
                className={`p-1 text-sm transition-colors ${pathCopied ? 'text-success' : 'text-text-muted hover:text-text-primary'}`}
              >
                <i className={`fa-solid ${pathCopied ? 'fa-check' : 'fa-copy'}`}></i>
              </button>
            </Tooltip>
          </div>

          {/* Action buttons */}
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
          <h2 className="text-xl font-semibold text-text-primary">Activity</h2>
          <TimeRangeSelector
            value={getTimeRangeValue()}
            onChange={(option: TimeRangeOption) => setSelectedHours(option.hours)}
          />
        </div>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatTile
              label="Completed"
              value={stats.completed}
              variant="success"
              onClick={() => navigate(`/activity?status=completed&hours=${selectedHours}&project=${encodeURIComponent(decodedPath)}`)}
            />
            <StatTile
              label="Failed"
              value={stats.failed}
              variant="danger"
              onClick={() => navigate(`/activity?status=failed&hours=${selectedHours}&project=${encodeURIComponent(decodedPath)}`)}
            />
            <StatTile
              label="Skipped"
              value={stats.skipped}
              variant="warning"
              onClick={() => navigate(`/activity?status=skipped&hours=${selectedHours}&project=${encodeURIComponent(decodedPath)}`)}
            />
            <StatTile
              label="Partial"
              value={stats.partial}
              variant="info"
              onClick={() => navigate(`/activity?status=partial&hours=${selectedHours}&project=${encodeURIComponent(decodedPath)}`)}
            />
            <StatTile
              label="Disputed"
              value={stats.disputed}
              variant="default"
              onClick={() => navigate(`/activity?status=disputed&hours=${selectedHours}&project=${encodeURIComponent(decodedPath)}`)}
            />
          </div>
        )}

        {stats && (
          <div className="mt-4 flex gap-6 text-sm text-text-secondary">
            <span>Rate: {stats.tasks_per_hour} tasks/hour</span>
            <span>Success Rate: {stats.success_rate}%</span>
          </div>
        )}
      </div>

      {project.stats && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-text-primary mb-4">Current Queue</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatTile
              label="Pending"
              value={project.stats.pending}
              variant="default"
              onClick={() => navigate(`/project/${encodeURIComponent(decodedPath)}/tasks?status=pending`)}
            />
            <StatTile
              label="In Progress"
              value={project.stats.in_progress}
              variant="info"
              onClick={() => navigate(`/project/${encodeURIComponent(decodedPath)}/tasks?status=in_progress`)}
            />
            <StatTile
              label="Review"
              value={project.stats.review}
              variant="warning"
              onClick={() => navigate(`/project/${encodeURIComponent(decodedPath)}/tasks?status=review`)}
            />
            <StatTile
              label="Completed"
              value={project.stats.completed}
              variant="success"
              onClick={() => navigate(`/project/${encodeURIComponent(decodedPath)}/tasks?status=completed`)}
            />
          </div>
        </div>
      )}

      {/* Sections */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold text-text-primary mb-4">Sections</h2>
        {sectionsLoading ? (
          <div className="flex items-center justify-center py-8">
            <ArrowPathIcon className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        ) : sections.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="text-text-muted">No sections found. Tasks are organized into sections.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full">
              <thead className="bg-bg-surface2">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-secondary">Section</th>
                  <th className="px-4 py-3 text-center text-sm font-medium text-text-secondary w-20">Total</th>
                  <th className="px-4 py-3 text-center text-sm font-medium text-text-secondary w-20">Pending</th>
                  <th className="px-4 py-3 text-center text-sm font-medium text-text-secondary w-20">Active</th>
                  <th className="px-4 py-3 text-center text-sm font-medium text-text-secondary w-20">Done</th>
                  <th className="px-4 py-3 text-center text-sm font-medium text-text-secondary w-20">Failed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sections.map((section) => (
                  <tr
                    key={section.id}
                    onClick={() => navigate(`/project/${encodeURIComponent(decodedPath)}/tasks?section=${section.id}`)}
                    className="bg-bg-surface hover:bg-bg-surface2 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-text-primary">
                        <i className="fa-solid fa-folder text-text-muted mr-2"></i>
                        {section.name}
                      </div>
                      {section.priority !== 50 && (
                        <div className="text-xs text-text-muted mt-0.5">
                          Priority: {section.priority}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center text-sm text-text-primary font-medium">
                      {section.total_tasks}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {section.pending > 0 ? (
                        <span className="inline-flex items-center justify-center min-w-[24px] px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                          {section.pending}
                        </span>
                      ) : (
                        <span className="text-text-muted">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {section.in_progress + section.review > 0 ? (
                        <span className="inline-flex items-center justify-center min-w-[24px] px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                          {section.in_progress + section.review}
                        </span>
                      ) : (
                        <span className="text-text-muted">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {section.completed > 0 ? (
                        <span className="inline-flex items-center justify-center min-w-[24px] px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          {section.completed}
                        </span>
                      ) : (
                        <span className="text-text-muted">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {section.failed > 0 ? (
                        <span className="inline-flex items-center justify-center min-w-[24px] px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                          {section.failed}
                        </span>
                      ) : (
                        <span className="text-text-muted">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Project Settings */}
      <div className="mb-8">
        <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          className="flex items-center gap-2 text-xl font-semibold text-text-primary mb-4 hover:text-text-secondary"
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
          <div className="bg-bg-surface rounded-lg p-4">
            <p className="text-sm text-text-muted mb-4">
              Project-specific settings override global settings. Stored in{' '}
              <code className="text-xs bg-bg-base px-1 py-0.5 rounded border border-border">
                .steroids/config.yaml
              </code>
            </p>

            {settingsLoading ? (
              <div className="flex items-center justify-center py-8">
                <ArrowPathIcon className="w-6 h-6 animate-spin text-text-muted" />
              </div>
            ) : settingsSchema ? (
              <>
                {/* Save Bar - Top */}
                <div className="flex items-center justify-between pb-4 mb-4 border-b border-border">
                  <div className="flex items-center gap-2">
                    {Object.keys(settingsChanges).length > 0 && (
                      <span className="text-sm text-text-muted">
                        {Object.keys(settingsChanges).length} unsaved change
                        {Object.keys(settingsChanges).length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {settingsSaveStatus === 'success' && (
                      <span className="flex items-center gap-1 text-sm text-success">
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
                        ? 'bg-accent text-white hover:bg-accent/80'
                        : 'bg-bg-base text-text-muted cursor-not-allowed'
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

                <SchemaForm
                  schema={settingsSchema}
                  values={getMergedSettingsValues()}
                  onChange={handleSettingsChange}
                  scope="project"
                  globalValues={globalConfig}
                />

                {/* Save Bar - Bottom */}
                <div className="flex items-center justify-between mt-6 pt-4 border-t border-border">
                  <div className="flex items-center gap-2">
                    {Object.keys(settingsChanges).length > 0 && (
                      <span className="text-sm text-text-muted">
                        {Object.keys(settingsChanges).length} unsaved change
                        {Object.keys(settingsChanges).length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {settingsSaveStatus === 'success' && (
                      <span className="flex items-center gap-1 text-sm text-success">
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
                        ? 'bg-accent text-white hover:bg-accent/80'
                        : 'bg-bg-base text-text-muted cursor-not-allowed'
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
              <p className="text-text-muted">No configuration schema available.</p>
            )}
          </div>
        )}
      </div>

          {/* Footer metadata */}
          <div className="text-sm text-text-muted">
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
                className="mt-2 cursor-pointer text-accent hover:text-accent/80"
                onClick={() => navigate(`/task/${project.runner!.current_task_id}?project=${encodeURIComponent(project.path)}`)}
              >
                <i className="fa-solid fa-arrow-up-right-from-square text-xs mr-1"></i>
                Current Task: {project.runner.current_task_id}
              </p>
            )}
          </div>
        </>
      )}
    </PageLayout>
  );
};

export default ProjectDetailPage;
