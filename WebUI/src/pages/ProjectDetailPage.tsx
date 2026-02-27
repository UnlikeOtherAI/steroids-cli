import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Cog6ToothIcon,
  ArrowPathIcon,
  CheckIcon,
} from '@heroicons/react/24/outline';
import { projectsApi, tasksApi, configApi, sectionsApi, ApiError, ConfigSchema, API_BASE_URL } from '../services/api';
import { Project, TimeRangeOption, Section, StorageInfo } from '../types';
import { Badge } from '../components/atoms/Badge';
import { Button } from '../components/atoms/Button';
import { Tooltip } from '../components/atoms/Tooltip';
import { StatTile } from '../components/molecules/StatTile';
import { TimeRangeSelector } from '../components/molecules/TimeRangeSelector';
import { SchemaForm } from '../components/settings/SchemaForm';
import { AISetupModal } from '../components/onboarding/AISetupModal';
import { PageLayout } from '../components/templates/PageLayout';

const STORAGE_OPEN_COOKIE = 'steroids_pd_storage_open';
const SECTIONS_OPEN_COOKIE = 'steroids_pd_sections_open';
const ISSUES_OPEN_COOKIE = 'steroids_pd_issues_open';
const STATS_HOURS_COOKIE = 'steroids_stats_hours';
const INSTRUCTIONS_OPEN_COOKIE = 'steroids_pd_instructions_open';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function getCookieBoolean(name: string, defaultValue: boolean): boolean {
  if (typeof document === 'undefined') return defaultValue;
  const entries = document.cookie.split(';').map((item) => item.trim()).filter(Boolean);
  const found = entries.find((entry) => entry.startsWith(`${name}=`));
  if (!found) return defaultValue;
  const value = found.slice(name.length + 1);
  if (value === '1') return true;
  if (value === '0') return false;
  return defaultValue;
}

function setCookieBoolean(name: string, value: boolean): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=${value ? '1' : '0'}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}`;
}

function getStatsHoursCookie(): number | null {
  if (typeof document === 'undefined') return null;
  const entries = document.cookie.split(';').map((item) => item.trim()).filter(Boolean);
  const found = entries.find((entry) => entry.startsWith(`${STATS_HOURS_COOKIE}=`));
  if (!found) return null;
  const raw = found.slice(STATS_HOURS_COOKIE.length + 1);
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function setStatsHoursCookie(hours: number): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${STATS_HOURS_COOKIE}=${hours}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}`;
}

function StorageBar({ label, item, color, total }: {
  label: string;
  item: { bytes: number; human: string; file_count?: number; backup_count?: number };
  color: string;
  total: number;
}) {
  const pct = total > 0 ? (item.bytes / total) * 100 : 0;
  const count = item.file_count ?? item.backup_count;
  return (
    <div>
      <div className="flex justify-between text-xs text-text-secondary mb-0.5">
        <span>{label}</span>
        <span>{item.human}{count ? ` (${count} files)` : ''}</span>
      </div>
      <div className="h-1.5 bg-bg-surface2 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`}
             style={{ width: `${Math.max(pct, 1)}%` }} />
      </div>
    </div>
  );
}

interface InstructionFile {
  name: string;
  key: string;
  exists: boolean;
  enabled: boolean;
  content: string;
}

interface ProjectRangeStats {
  pending: number;
  in_progress: number;
  review: number;
  completed: number;
  failed: number;
  disputed: number;
  total: number;
  tasks_per_hour: number;
  success_rate: number;
}

interface IssueSummary {
  count: number;
  singleTaskId: string | null;
}

interface ProjectIssues {
  failedRetries: IssueSummary;
  stale: IssueSummary;
}

function sumStatusCounts(counts: Record<string, number> | undefined): number {
  if (!counts) return 0;
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export const ProjectDetailPage: React.FC = () => {
  const { projectPath } = useParams<{ projectPath: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [stats, setStats] = useState<ProjectRangeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHours, setSelectedHours] = useState(() => getStatsHoursCookie() ?? 8760);

  // Sections state
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(() => getCookieBoolean(SECTIONS_OPEN_COOKIE, true));

  // Issues state
  const [issuesOpen, setIssuesOpen] = useState(() => getCookieBoolean(ISSUES_OPEN_COOKIE, true));
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issues, setIssues] = useState<ProjectIssues>({
    failedRetries: { count: 0, singleTaskId: null },
    stale: { count: 0, singleTaskId: null },
  });

  // Storage state
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearMsg, setClearMsg] = useState<string | null>(null);
  const [storageOpen, setStorageOpen] = useState(() => getCookieBoolean(STORAGE_OPEN_COOKIE, true));
  const [resetting, setResetting] = useState(false);

  const [skillsOpen, setSkillsOpen] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<{name: string, type: string}[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);

  // Instructions state
  const [instructionsOpen, setInstructionsOpen] = useState(() => getCookieBoolean(INSTRUCTIONS_OPEN_COOKIE, true));
  const [instructions, setInstructions] = useState<InstructionFile[]>([]);
  const [customInstructions, setCustomInstructions] = useState('');

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

  // AI Setup state
  const [showAISetup, setShowAISetup] = useState(false);

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
      const response = await tasksApi.listForProject(decodedPath, {
        hours: selectedHours,
        limit: 1,
      });

      const counts = response.status_counts || {};
      const pending = counts.pending ?? 0;
      const inProgress = counts.in_progress ?? 0;
      const review = counts.review ?? 0;
      const completed = counts.completed ?? 0;
      const failed = counts.failed ?? 0;
      const disputed = counts.disputed ?? 0;
      const total = pending + inProgress + review + completed + failed + disputed;
      // Only terminal-state tasks count toward rate and success rate
      const finalized = completed + failed + disputed;
      const tasksPerHour = selectedHours > 0
        ? Math.round((finalized / selectedHours) * 100) / 100
        : 0;
      const successRate = finalized > 0
        ? Math.round((completed / finalized) * 1000) / 10
        : 0;

      setStats({
        pending,
        in_progress: inProgress,
        review,
        completed,
        failed,
        disputed,
        total,
        tasks_per_hour: tasksPerHour,
        success_rate: successRate,
      });
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  const loadIssues = async () => {
    if (!decodedPath) return;

    setIssuesLoading(true);
    try {
      const [failedRetriesResponse, staleResponse] = await Promise.all([
        tasksApi.listForProject(decodedPath, { issue: 'failed_retries', limit: 2 }),
        tasksApi.listForProject(decodedPath, { issue: 'stale', limit: 2 }),
      ]);

      const failedRetriesCount = sumStatusCounts(failedRetriesResponse.status_counts);
      const staleCount = sumStatusCounts(staleResponse.status_counts);

      setIssues({
        failedRetries: {
          count: failedRetriesCount,
          singleTaskId:
            failedRetriesCount === 1 && failedRetriesResponse.tasks.length === 1
              ? failedRetriesResponse.tasks[0].id
              : null,
        },
        stale: {
          count: staleCount,
          singleTaskId:
            staleCount === 1 && staleResponse.tasks.length === 1
              ? staleResponse.tasks[0].id
              : null,
        },
      });
    } catch (err) {
      console.error('Failed to load issues:', err);
      setIssues({
        failedRetries: { count: 0, singleTaskId: null },
        stale: { count: 0, singleTaskId: null },
      });
    } finally {
      setIssuesLoading(false);
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

  const loadStorage = async () => {
    if (!decodedPath) return;
    try {
      const data = await projectsApi.getStorage(decodedPath);
      setStorage(data);
    } catch (err) {
      console.error('Failed to load storage:', err);
    }
  };

  const handleClearLogs = async () => {
    if (!decodedPath) return;
    setClearing(true);
    setClearMsg(null);
    try {
      const result = await projectsApi.clearLogs(decodedPath, 7);
      setClearMsg(`Freed ${result.freed_human}`);
      setTimeout(() => setClearMsg(null), 3000);
      await loadStorage();
    } catch (err) {
      setClearMsg(err instanceof ApiError ? err.message : 'Failed to clear logs');
    } finally {
      setClearing(false);
    }
  };


  const loadSkills = async () => {
    setSkillsLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/skills`);
      const json = await res.json();
      if (json.success) setAvailableSkills(json.data);
    } catch (err) {
      console.error('Failed to load skills:', err);
    } finally {
      setSkillsLoading(false);
    }
  };

  useEffect(() => {
    if (skillsOpen && availableSkills.length === 0) {
      loadSkills();
      if (!settingsSchema) loadSettings();
    }
  }, [skillsOpen]);

  const loadInstructions = async () => {
    if (!decodedPath) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/projects/instructions?path=${encodeURIComponent(decodedPath)}`);
      const json = await res.json();
      if (json.success) {
        setInstructions(json.files);
        setCustomInstructions(json.customInstructions ?? '');
      }
    } catch (err) {
      console.error('Failed to load instructions:', err);
    }
  };

  const toggleInstruction = async (key: string, enabled: boolean) => {
    if (!decodedPath) return;
    setInstructions(prev => prev.map(f => f.key === key ? { ...f, enabled } : f));
    try {
      await fetch(`${API_BASE_URL}/api/projects/instructions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: decodedPath, key, enabled }),
      });
    } catch (err) {
      console.error('Failed to toggle instruction:', err);
      // Revert on failure
      setInstructions(prev => prev.map(f => f.key === key ? { ...f, enabled: !enabled } : f));
    }
  };

  const saveCustomInstructions = async (text: string) => {
    if (!decodedPath) return;
    try {
      await fetch(`${API_BASE_URL}/api/projects/instructions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: decodedPath, customInstructions: text }),
      });
    } catch (err) {
      console.error('Failed to save custom instructions:', err);
    }
  };

  useEffect(() => {
    if (decodedPath) {
      loadInstructions();
    }
  }, [decodedPath]);

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

  useEffect(() => {
    if (showAISetup && !globalConfig?.ai) {
      loadSettings();
    }
  }, [showAISetup, globalConfig?.ai, loadSettings]);

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
    loadIssues();
    loadSections();
    loadStorage();
  }, [decodedPath]);

  useEffect(() => {
    if (settingsOpen && !settingsSchema) {
      loadSettings();
    }
  }, [settingsOpen, settingsSchema, loadSettings]);

  useEffect(() => {
    setCookieBoolean(STORAGE_OPEN_COOKIE, storageOpen);
  }, [storageOpen]);

  useEffect(() => {
    setCookieBoolean(SECTIONS_OPEN_COOKIE, sectionsOpen);
  }, [sectionsOpen]);

  useEffect(() => {
    setCookieBoolean(ISSUES_OPEN_COOKIE, issuesOpen);
  }, [issuesOpen]);

  useEffect(() => {
    setStatsHoursCookie(selectedHours);
  }, [selectedHours]);

  useEffect(() => {
    loadStats();
  }, [decodedPath, selectedHours]);

  const handleEnable = async () => {
    if (!project) return;
    try {
      await projectsApi.enable(project.path);
      await loadProject();
      await loadIssues();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to enable project');
    }
  };

  const handleDisable = async () => {
    if (!project) return;
    try {
      await projectsApi.disable(project.path);
      await loadProject();
      await loadIssues();
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

  const handleResetProject = async () => {
    if (!project) return;
    try {
      setResetting(true);
      await projectsApi.reset(project.path);
      await loadProject();
      await loadStats();
      await loadIssues();
      await loadSections();
      setError(null);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to reset project');
    } finally {
      setResetting(false);
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
  const canResetProject = Boolean(
    project?.isBlocked ||
      (project?.stats?.failed ?? 0) > 0 ||
      (project?.stats?.disputed ?? 0) > 0 ||
      (project?.stats?.skipped ?? 0) > 0
  );

  const issueRows = [
    {
      key: 'failed_retries',
      label: 'Failed retries',
      count: issues.failedRetries.count,
      singleTaskId: issues.failedRetries.singleTaskId,
      listPath: `/project/${encodeURIComponent(decodedPath)}/tasks?issue=failed_retries`,
      icon: 'fa-rotate-left',
      badgeClasses: 'bg-danger-soft text-danger',
    },
    {
      key: 'stale',
      label: 'Stale tasks',
      count: issues.stale.count,
      singleTaskId: issues.stale.singleTaskId,
      listPath: `/project/${encodeURIComponent(decodedPath)}/tasks?issue=stale`,
      icon: 'fa-clock',
      badgeClasses: 'bg-warning-soft text-warning',
    },
    {
      key: 'failed',
      label: 'Failed tasks',
      count: project?.stats?.failed ?? 0,
      singleTaskId: null,
      listPath: `/project/${encodeURIComponent(decodedPath)}/tasks?status=failed`,
      icon: 'fa-circle-xmark',
      badgeClasses: 'bg-danger-soft text-danger',
    },
    {
      key: 'skipped',
      label: 'Skipped tasks',
      count: project?.stats?.skipped ?? 0,
      singleTaskId: null,
      listPath: `/project/${encodeURIComponent(decodedPath)}/tasks?status=skipped`,
      icon: 'fa-forward',
      badgeClasses: 'bg-warning-soft text-warning',
    },
    {
      key: 'disputed',
      label: 'Disputed tasks',
      count: project?.stats?.disputed ?? 0,
      singleTaskId: null,
      listPath: `/project/${encodeURIComponent(decodedPath)}/tasks?status=disputed`,
      icon: 'fa-triangle-exclamation',
      badgeClasses: 'bg-danger-soft text-danger',
    },
  ].filter((item) => item.count > 0);

  const navigateToIssue = (singleTaskId: string | null, listPath: string) => {
    if (singleTaskId) {
      navigate(`/task/${singleTaskId}?project=${encodeURIComponent(decodedPath)}`);
      return;
    }
    navigate(listPath);
  };

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

          {/* AI Setup Modal */}
          {showAISetup && (
            <AISetupModal
              isProjectLevel={true}
              projectPath={decodedPath}
              inheritedConfig={globalConfig}
              onComplete={() => {
                setShowAISetup(false);
                loadSettings();
              }}
              onClose={() => setShowAISetup(false)}
            />
          )}

          {/* Action buttons */}
          <div className="mb-8 flex gap-3 flex-wrap">
            {project.enabled ? (
              <Button variant="secondary" onClick={handleDisable}>
                Disable Project
              </Button>
            ) : (
              <Button onClick={handleEnable}>Enable Project</Button>
            )}
            <button
              onClick={() => setShowAISetup(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent text-white hover:bg-accent/90 text-sm font-medium transition-colors"
            >
              <i className="fa-solid fa-robot"></i>
              Reconfigure AI
            </button>
          </div>

      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-text-primary">Stats</h2>
          <TimeRangeSelector
            value={getTimeRangeValue()}
            onChange={(option: TimeRangeOption) => setSelectedHours(option.hours)}
          />
        </div>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <StatTile
              label="Pending"
              value={stats.pending}
              variant="default"
              onClick={() => navigate(`/project/${encodeURIComponent(decodedPath)}/tasks?status=pending&hours=${selectedHours}`)}
            />
            <StatTile
              label="In Progress"
              value={stats.in_progress}
              variant="info"
              onClick={() => navigate(`/project/${encodeURIComponent(decodedPath)}/tasks?status=in_progress&hours=${selectedHours}`)}
            />
            <StatTile
              label="Review"
              value={stats.review}
              variant="warning"
              onClick={() => navigate(`/project/${encodeURIComponent(decodedPath)}/tasks?status=review&hours=${selectedHours}`)}
            />
            <StatTile
              label="Completed"
              value={stats.completed}
              variant="success"
              onClick={() => navigate(`/project/${encodeURIComponent(decodedPath)}/tasks?status=completed&hours=${selectedHours}`)}
            />
            <StatTile
              label="Failed"
              value={stats.failed}
              variant="danger"
              onClick={() => navigate(`/project/${encodeURIComponent(decodedPath)}/tasks?status=failed&hours=${selectedHours}`)}
            />
            <StatTile
              label="Disputed"
              value={stats.disputed}
              variant="danger"
              onClick={() => navigate(`/project/${encodeURIComponent(decodedPath)}/tasks?status=disputed&hours=${selectedHours}`)}
            />
          </div>
        )}

        {stats && (
          <div className="mt-4 flex flex-wrap gap-6 text-sm text-text-secondary">
            <span>{stats.total} tasks in selected range</span>
            <span>Rate: {stats.tasks_per_hour} tasks/hour</span>
            <span>Success Rate: {stats.success_rate}%</span>
          </div>
        )}
      </div>

      {/* Issues */}
      <div className="mb-8">
        <button
          onClick={() => setIssuesOpen(!issuesOpen)}
          className="flex items-center gap-2 text-xl font-semibold text-text-primary mb-4 hover:text-text-secondary"
          aria-expanded={issuesOpen}
        >
          {issuesOpen ? (
            <ChevronDownIcon className="w-5 h-5" />
          ) : (
            <ChevronRightIcon className="w-5 h-5" />
          )}
          <i className="fa-solid fa-bug w-5 h-5 flex items-center justify-center text-sm"></i>
          <span>Issues</span>
        </button>

        {issuesOpen && (
          <div className="bg-bg-surface rounded-xl p-4">
            {issuesLoading ? (
              <div className="flex items-center justify-center py-6">
                <ArrowPathIcon className="w-6 h-6 animate-spin text-text-muted" />
              </div>
            ) : (
              <div className="space-y-2">
                {issueRows.length > 0 ? issueRows.map((item) => (
                  <button
                    key={item.key}
                    onClick={() => navigateToIssue(item.singleTaskId, item.listPath)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-bg-surface2 hover:border-accent/40 hover:bg-bg-elevated transition-colors flex items-center justify-between text-left"
                  >
                    <div className="flex items-center gap-2">
                      <i className={`fa-solid ${item.icon} text-sm text-text-muted`} />
                      <span className="text-sm font-medium text-text-primary">{item.label}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${item.badgeClasses}`}>
                        {item.count}
                      </span>
                      <i className="fa-solid fa-arrow-right text-xs text-text-muted" />
                    </div>
                  </button>
                )) : (
                  <p className="text-sm text-text-muted text-center py-2">No issues detected</p>
                )}
                <div className="pt-2 border-t border-border mt-2">
                  <Button
                    className="w-full justify-center"
                    variant="accent"
                    onClick={handleResetProject}
                    disabled={!canResetProject || resetting}
                  >
                    <span className="flex items-center gap-2">
                      {resetting ? <ArrowPathIcon className="w-4 h-4 animate-spin" /> : <i className="fa-solid fa-rotate-right text-sm" />}
                      Reset Project
                    </span>
                  </Button>
                  <p className="text-xs text-text-muted text-center mt-1.5">Resets failed, disputed and stale tasks to pending</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Storage */}
      <div className="mb-8">
        <button
          onClick={() => setStorageOpen(!storageOpen)}
          className="flex items-center gap-2 text-xl font-semibold text-text-primary mb-4 hover:text-text-secondary"
          aria-expanded={storageOpen}
        >
          {storageOpen ? (
            <ChevronDownIcon className="w-5 h-5" />
          ) : (
            <ChevronRightIcon className="w-5 h-5" />
          )}
          <i className="fa-solid fa-database w-5 h-5 flex items-center justify-center text-sm"></i>
          <span>Storage</span>
        </button>

        {storageOpen && (
          <div className="bg-bg-surface rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-text-primary">Total Used</h3>
              <span className="text-lg font-semibold text-text-primary">{storage ? storage.total_human : ''}</span>
            </div>
            {!storage ? (
              <div className="space-y-2" data-testid="storage-loading">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="animate-pulse">
                    <div className="h-3 bg-bg-surface2 rounded w-1/3 mb-1" />
                    <div className="h-1.5 bg-bg-surface2 rounded-full" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <StorageBar label="Database" item={storage.breakdown?.database ?? { bytes: 0, human: '0 B' }} color="bg-info" total={storage.total_bytes} />
                  <StorageBar label="Invocation Logs" item={storage.breakdown?.invocations ?? { bytes: 0, human: '0 B' }} color="bg-warning" total={storage.total_bytes} />
                  <StorageBar label="Text Logs" item={storage.breakdown?.logs ?? { bytes: 0, human: '0 B' }} color="bg-accent" total={storage.total_bytes} />
                  <StorageBar label="Backups" item={storage.breakdown?.backups ?? { bytes: 0, human: '0 B' }} color="bg-success" total={storage.total_bytes} />
                  {storage.disk && (
                    <StorageBar
                      label="Disk Available"
                      item={{
                        bytes: storage.total_bytes,
                        human: `${storage.total_human} used / ${storage.disk.available_human} available`,
                      }}
                      color="bg-info"
                      total={Math.max(storage.total_bytes + storage.disk.available_bytes, 1)}
                    />
                  )}
                </div>
                {storage.threshold_warning && (
                  <div className={`mt-4 p-3 rounded-lg flex items-center justify-between ${
                    storage.threshold_warning === 'red' ? 'bg-danger-soft' : 'bg-warning-soft'
                  }`}>
                    <div className="flex items-center gap-2">
                      <i className="fa-solid fa-triangle-exclamation text-sm" />
                      <span className="text-sm">{storage.clearable_human} of old logs and backups can be cleared</span>
                    </div>
                    <button
                      onClick={handleClearLogs}
                      disabled={clearing}
                      className="px-3 py-1.5 text-sm font-medium bg-bg-elevated rounded-lg hover:bg-bg-surface2 transition-colors disabled:opacity-50"
                    >
                      {clearing ? <ArrowPathIcon className="w-4 h-4 animate-spin inline" /> : 'Cleanup Project'}
                    </button>
                  </div>
                )}
                {clearMsg && (
                  <p className={`mt-2 text-sm ${clearMsg.startsWith('Freed') ? 'text-success' : 'text-danger'}`}>{clearMsg}</p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Sections */}
      <div className="mb-8">
        <button
          onClick={() => setSectionsOpen(!sectionsOpen)}
          className="flex items-center gap-2 text-xl font-semibold text-text-primary mb-4 hover:text-text-secondary"
          aria-expanded={sectionsOpen}
        >
          {sectionsOpen ? (
            <ChevronDownIcon className="w-5 h-5" />
          ) : (
            <ChevronRightIcon className="w-5 h-5" />
          )}
          <i className="fa-solid fa-folder-open w-5 h-5 flex items-center justify-center text-sm"></i>
          <span>Sections</span>
        </button>

        {sectionsOpen && (
          <>
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
          </>
        )}
      </div>


      {/* Project Instructions */}
      <div className="mb-8">
        <button
          onClick={() => {
            const next = !instructionsOpen;
            setInstructionsOpen(next);
            setCookieBoolean(INSTRUCTIONS_OPEN_COOKIE, next);
          }}
          className="flex items-center gap-2 text-xl font-semibold text-text-primary mb-4 hover:text-text-secondary"
        >
          {instructionsOpen ? (
            <ChevronDownIcon className="w-5 h-5" />
          ) : (
            <ChevronRightIcon className="w-5 h-5" />
          )}
          <i className="fa-solid fa-file-lines w-5 h-5 flex items-center justify-center text-sm"></i>
          <span>Project Instructions</span>
          {instructions.filter(f => f.exists).length > 0 && (
            <span className="text-xs bg-accent/20 text-accent px-2 py-0.5 rounded-full">
              {instructions.filter(f => f.exists && f.enabled).length}/{instructions.filter(f => f.exists).length} active
            </span>
          )}
        </button>

        {instructionsOpen && (
          <div className="bg-bg-surface rounded-lg p-6 mb-8 shadow-sm border border-border">
            <p className="text-sm text-text-muted mb-6">
              Checked files are force-injected into every coder and reviewer prompt. Files must exist in the project root.
            </p>
            <div className="space-y-3">
              {instructions.map(file => (
                <div key={file.key} className={`rounded-lg border p-4 ${file.exists ? 'border-border' : 'border-border opacity-40'}`}>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={file.enabled && file.exists}
                      disabled={!file.exists}
                      onChange={e => toggleInstruction(file.key, e.target.checked)}
                      className="w-4 h-4 text-accent bg-bg-base border-border rounded focus:ring-accent focus:ring-2"
                    />
                    <span className="font-mono text-sm font-medium">{file.name}</span>
                    {!file.exists && <span className="text-xs text-text-muted">(not found)</span>}
                  </label>
                  {file.exists && file.content && (
                    <pre className="mt-3 text-xs text-text-muted bg-bg-surface2 rounded p-3 max-h-32 overflow-y-auto whitespace-pre-wrap">
                      {file.content.slice(0, 300)}{file.content.length > 300 ? '...' : ''}
                    </pre>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-6">
              <label className="block text-sm font-medium text-text-secondary mb-2">
                Custom Instructions
              </label>
              <textarea
                className="w-full h-32 rounded-lg border border-border bg-bg-surface2 p-3 text-sm font-mono text-text-primary resize-y"
                placeholder="Add custom instructions injected into every prompt for this project..."
                value={customInstructions}
                onChange={e => setCustomInstructions(e.target.value)}
                onBlur={() => saveCustomInstructions(customInstructions)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Project Skills */}
      <div className="mb-8">
        <button
          onClick={() => setSkillsOpen(!skillsOpen)}
          className="flex items-center gap-2 text-xl font-semibold text-text-primary mb-4 hover:text-text-secondary"
        >
          {skillsOpen ? (
            <ChevronDownIcon className="w-5 h-5" />
          ) : (
            <ChevronRightIcon className="w-5 h-5" />
          )}
          <i className="fa-solid fa-book-open w-5 h-5 flex items-center justify-center text-sm"></i>
          <span>Project Skills Assigned</span>
        </button>

        {skillsOpen && (
          <div className="bg-bg-surface rounded-lg p-6 mb-8 shadow-sm border border-border">
            <p className="text-sm text-text-muted mb-6">
              Select which skills this project should adhere to. These guidelines are injected into the context of every AI agent working on this project.
            </p>
            
            {skillsLoading || settingsLoading ? (
              <div className="flex items-center justify-center py-8">
                <ArrowPathIcon className="w-6 h-6 animate-spin text-text-muted" />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {availableSkills.map(skill => {
                    const globalSkills = (globalConfig.skills as string[]) || [];
                    const isGlobal = globalSkills.includes(skill.name);
                    const currentSkills = ((settingsChanges.skills !== undefined ? settingsChanges.skills : settingsConfig.skills) as string[]) || [];
                    const isAssigned = isGlobal || currentSkills.includes(skill.name);
                    
                    return (
                      <label key={skill.name} className={`flex items-start gap-3 p-4 rounded-lg border border-border ${isGlobal ? 'bg-bg-surface opacity-75 cursor-not-allowed' : 'bg-bg-surface2 hover:border-accent/50 cursor-pointer'} transition-colors`}>
                        <input
                          type="checkbox"
                          checked={isAssigned}
                          disabled={isGlobal}
                          onChange={(e) => {
                            if (isGlobal) return;
                            const newSkills = e.target.checked 
                              ? [...currentSkills, skill.name]
                              : currentSkills.filter(s => s !== skill.name);
                            handleSettingsChange('skills', newSkills);
                          }}
                          className={`mt-1 w-4 h-4 text-accent bg-bg-base border-border rounded ${isGlobal ? 'cursor-not-allowed' : 'focus:ring-accent focus:ring-2'}`}
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-text-primary">{skill.name}</span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full ${skill.type === 'custom' ? 'bg-success-soft text-success' : 'bg-info-soft text-info'}`}>
                              {skill.type}
                            </span>
                            {isGlobal && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-bg-elevated text-text-muted border border-border">
                                Global
                              </span>
                            )}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
                
                {availableSkills.length === 0 && (
                  <div className="text-center py-8 text-text-muted">
                    No skills found. Create one in the Skills tab.
                  </div>
                )}
                
                {/* Save Bar */}
                <div className="flex items-center justify-between mt-6 pt-4 border-t border-border">
                  <div className="flex items-center gap-2">
                    {Object.keys(settingsChanges).length > 0 && (
                      <span className="text-sm text-text-muted">
                        Unsaved changes pending
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
                      'Save Assignments'
                    )}
                  </button>
                </div>
              </div>
            )}
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
                  hideAI={true}
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

          <div className="mt-10">
            <Button variant="danger" onClick={handleRemove}>
              Remove Project
            </Button>
          </div>

          <div className="mt-10 pt-6 text-sm text-text-muted">
            Made in Scotland with Love by{' '}
            <a
              href="https://www.unlikeotherai.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:text-accent/80 transition-colors"
            >
              Unlike Another AI
            </a>{' '}
            &copy; {new Date().getFullYear()}
          </div>
        </>
      )}
    </PageLayout>
  );
};

export default ProjectDetailPage;
