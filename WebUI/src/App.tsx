import { useState, useEffect, useCallback, Suspense, lazy } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from './components/layouts';
import { AISetupModal } from './components/onboarding/AISetupModal';
import { CreditExhaustionModal } from './components/molecules/CreditExhaustionModal';
import { useProject } from './contexts/ProjectContext';
import { configApi, creditAlertsApi } from './services/api';
import type { CreditAlert } from './services/api';
import './App.css';

const DashboardPage = lazy(() => import('./pages/DashboardPage').then(({ DashboardPage }) => ({ default: DashboardPage })));
const ActivityListPage = lazy(() => import('./pages/ActivityListPage').then(({ ActivityListPage }) => ({ default: ActivityListPage })));
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetailPage').then(({ ProjectDetailPage }) => ({ default: ProjectDetailPage })));
const ProjectTasksPage = lazy(() => import('./pages/ProjectTasksPage').then(({ ProjectTasksPage }) => ({ default: ProjectTasksPage })));
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage').then(({ TaskDetailPage }) => ({ default: TaskDetailPage })));
const RunnersPage = lazy(() => import('./pages/RunnersPage').then(({ RunnersPage }) => ({ default: RunnersPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(({ SettingsPage }) => ({ default: SettingsPage })));
const SkillsPage = lazy(() => import('./pages/SkillsPage').then(({ SkillsPage }) => ({ default: SkillsPage })));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage').then(({ ProjectsPage }) => ({ default: ProjectsPage })));
const SystemLogsPage = lazy(() => import('./pages/SystemLogsPage').then(({ SystemLogsPage }) => ({ default: SystemLogsPage })));
const MonitorPage = lazy(() => import('./pages/MonitorPage').then(({ MonitorPage }) => ({ default: MonitorPage })));
const IntakePage = lazy(() => import('./pages/IntakePage').then(({ IntakePage }) => ({ default: IntakePage })));
const ModelUsagePage = lazy(() => import('./pages/ModelUsagePage').then(({ ModelUsagePage }) => ({ default: ModelUsagePage })));
const HFAccountPage = lazy(() => import('./pages/HFAccountPage').then(({ HFAccountPage }) => ({ default: HFAccountPage })));
const HFModelLibraryPage = lazy(() => import('./pages/HFModelLibraryPage').then(({ HFModelLibraryPage }) => ({ default: HFModelLibraryPage })));
const HFReadyToUsePage = lazy(() => import('./pages/HFReadyToUsePage').then(({ HFReadyToUsePage }) => ({ default: HFReadyToUsePage })));
const OllamaConnectionPage = lazy(() => import('./pages/OllamaConnectionPage').then(({ OllamaConnectionPage }) => ({ default: OllamaConnectionPage })));
const OllamaInstalledModelsPage = lazy(() => import('./pages/OllamaInstalledModelsPage').then(({ OllamaInstalledModelsPage }) => ({ default: OllamaInstalledModelsPage })));
const OllamaModelLibraryPage = lazy(() => import('./pages/OllamaModelLibraryPage').then(({ OllamaModelLibraryPage }) => ({ default: OllamaModelLibraryPage })));
const OllamaReadyToUsePage = lazy(() => import('./pages/OllamaReadyToUsePage').then(({ OllamaReadyToUsePage }) => ({ default: OllamaReadyToUsePage })));
const OllamaAccountPage = lazy(() => import('./pages/OllamaAccountPage').then(({ OllamaAccountPage }) => ({ default: OllamaAccountPage })));

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
    if (location.pathname.startsWith('/monitor')) return 'Monitor';
    if (location.pathname.startsWith('/intake')) return 'Intake';
    if (location.pathname === '/hf/account') return 'Hugging Face Account';
    if (location.pathname === '/hf/models') return 'Hugging Face Model Library';
    if (location.pathname === '/hf/ready') return 'Hugging Face Ready to Use';
    if (location.pathname === '/ollama/connection') return 'Ollama Connection';
    if (location.pathname === '/ollama/installed') return 'Ollama Installed Models';
    if (location.pathname === '/ollama/library') return 'Ollama Model Library';
    if (location.pathname === '/ollama/ready') return 'Ollama Ready to Use';
    if (location.pathname === '/ollama/account') return 'Ollama Account';
    switch (location.pathname) {
      case '/': return 'Dashboard';
      case '/projects': return 'Projects';
      case '/model-usage': return 'Model Usage';
      case '/runners': return 'Runners';
      case '/logs': return 'System Logs';
      case '/settings': return 'Settings';
      case '/skills': return 'Skills';
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
          <Suspense fallback={<div className="p-6 text-sm text-text-muted">Loading page…</div>}>
            <Routes>
              <Route
                path="/"
                element={<DashboardPage project={selectedProject} />}
              />
              <Route path="/intake" element={<IntakePage project={selectedProject} />} />
              <Route path="/model-usage" element={<ModelUsagePage project={selectedProject} />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/project/:projectPath" element={<ProjectDetailPage />} />
              <Route path="/project/:projectPath/tasks" element={<ProjectTasksPage />} />
              <Route path="/activity" element={<ActivityListPage />} />
              <Route path="/task/:taskId" element={<TaskDetailPage />} />
              <Route path="/monitor" element={<MonitorPage />} />
              <Route path="/runners" element={<RunnersPage />} />
              <Route path="/logs" element={<SystemLogsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/hf/account" element={<HFAccountPage />} />
              <Route path="/hf/models" element={<HFModelLibraryPage />} />
              <Route path="/hf/ready" element={<HFReadyToUsePage />} />
              <Route path="/ollama/connection" element={<OllamaConnectionPage />} />
              <Route path="/ollama/installed" element={<OllamaInstalledModelsPage />} />
              <Route path="/ollama/library" element={<OllamaModelLibraryPage />} />
              <Route path="/ollama/ready" element={<OllamaReadyToUsePage />} />
              <Route path="/ollama/account" element={<OllamaAccountPage />} />
            </Routes>
          </Suspense>
        </AppShell>
      </div>
    </>
  );
}

export default App;
