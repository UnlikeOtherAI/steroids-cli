import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { ProjectsPage } from './pages/ProjectsPage';
import { DashboardPage } from './pages/DashboardPage';
import { ActivityListPage } from './pages/ActivityListPage';
import { RunnersPage } from './pages/RunnersPage';
import { RunningTasksPage } from './pages/RunningTasksPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { ProjectTasksPage } from './pages/ProjectTasksPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { AppShell } from './components/layouts';
import { AISetupModal } from './components/onboarding/AISetupModal';
import { CreditExhaustionModal } from './components/molecules/CreditExhaustionModal';
import { useProject } from './contexts/ProjectContext';
import { configApi, creditAlertsApi } from './services/api';
import type { CreditAlert } from './services/api';
import './App.css';

function App() {
  const { selectedProject } = useProject();
  const location = useLocation();
  const navigate = useNavigate();
  const [showAISetup, setShowAISetup] = useState(false);
  const [checkingConfig, setCheckingConfig] = useState(true);
  const [creditAlert, setCreditAlert] = useState<CreditAlert | null>(null);

  useEffect(() => {
    checkAIConfiguration();
  }, []);

  // Poll for credit alerts every 10 seconds
  const checkCreditAlerts = useCallback(async () => {
    try {
      const alerts = await creditAlertsApi.getActive(selectedProject?.path);
      setCreditAlert(alerts.length > 0 ? alerts[0] : null);
    } catch {
      // Silently ignore polling errors
    }
  }, [selectedProject?.path]);

  useEffect(() => {
    checkCreditAlerts();
    const interval = setInterval(checkCreditAlerts, 10_000);
    return () => clearInterval(interval);
  }, [checkCreditAlerts]);

  const checkAIConfiguration = async () => {
    try {
      const config = await configApi.getConfig('global');
      const ai = config.ai as Record<string, Record<string, unknown>> | undefined;

      // Check if all three roles have provider and model configured
      const hasOrchestrator = ai?.orchestrator?.provider && ai?.orchestrator?.model;
      const hasCoder = ai?.coder?.provider && ai?.coder?.model;
      const hasReviewer = ai?.reviewer?.provider && ai?.reviewer?.model;

      if (!hasOrchestrator || !hasCoder || !hasReviewer) {
        setShowAISetup(true);
      }
    } catch {
      // If config check fails, show setup modal
      setShowAISetup(true);
    } finally {
      setCheckingConfig(false);
    }
  };

  const getPageTitle = () => {
    if (location.pathname.startsWith('/activity')) return 'Activity';
    if (location.pathname.includes('/tasks') && location.pathname.startsWith('/project/')) return 'Project Tasks';
    if (location.pathname.startsWith('/project/')) return 'Project Details';
    if (location.pathname.startsWith('/task/')) return 'Task Details';
    switch (location.pathname) {
      case '/': return 'Dashboard';
      case '/projects': return 'Projects';
      case '/runners': return 'Runners';
      case '/tasks': return 'Running Tasks';
      case '/settings': return 'Settings';
      default: return 'Dashboard';
    }
  };

  // Show loading while checking config
  if (checkingConfig) {
    return (
      <div className="min-h-screen bg-bg-page flex items-center justify-center">
        <div className="text-center">
          <i className="fa-solid fa-spinner fa-spin text-4xl text-accent mb-4"></i>
          <p className="text-text-muted">Loading...</p>
        </div>
      </div>
    );
  }

  const isCreditModalVisible = Boolean(creditAlert && selectedProject);
  const blurContent = showAISetup || isCreditModalVisible;

  return (
    <>
      {showAISetup && (
        <AISetupModal onComplete={() => setShowAISetup(false)} />
      )}
      {creditAlert && selectedProject && (
        <CreditExhaustionModal
          alert={creditAlert}
          onDismiss={async () => {
            await creditAlertsApi.dismiss(creditAlert.id, selectedProject.path);
            setCreditAlert(null);
          }}
          onChangeModel={async () => {
            await creditAlertsApi.dismiss(creditAlert.id, selectedProject.path);
            setCreditAlert(null);
            navigate('/settings');
          }}
          onRetry={async () => {
            await creditAlertsApi.retry(creditAlert.id, selectedProject.path);
            setCreditAlert(null);
          }}
        />
      )}
      <div className={blurContent ? 'blur-sm pointer-events-none' : ''}>
        <AppShell title={getPageTitle()} project={selectedProject}>
          <Routes>
            <Route path="/" element={<DashboardPage project={selectedProject} />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/project/:projectPath" element={<ProjectDetailPage />} />
            <Route path="/project/:projectPath/tasks" element={<ProjectTasksPage />} />
            <Route path="/activity" element={<ActivityListPage />} />
            <Route path="/task/:taskId" element={<TaskDetailPage />} />
            <Route path="/runners" element={<RunnersPage />} />
            <Route path="/tasks" element={<RunningTasksPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </AppShell>
      </div>
    </>
  );
}

export default App;
