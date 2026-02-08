import { Routes, Route, useLocation } from 'react-router-dom';
import { ProjectsPage } from './pages/ProjectsPage';
import { DashboardPage } from './pages/DashboardPage';
import { ActivityListPage } from './pages/ActivityListPage';
import { RunnersPage } from './pages/RunnersPage';
import { RunningTasksPage } from './pages/RunningTasksPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { AppShell } from './components/layouts';
import { useProject } from './contexts/ProjectContext';
import './App.css';

function App() {
  const { selectedProject } = useProject();
  const location = useLocation();

  const getPageTitle = () => {
    if (location.pathname.startsWith('/activity')) return 'Activity';
    if (location.pathname.startsWith('/project/')) return 'Project Details';
    switch (location.pathname) {
      case '/': return 'Dashboard';
      case '/projects': return 'Projects';
      case '/runners': return 'Runners';
      case '/tasks': return 'Running Tasks';
      case '/settings': return 'Settings';
      default: return 'Dashboard';
    }
  };

  return (
    <AppShell title={getPageTitle()} project={selectedProject}>
      <Routes>
        <Route path="/" element={<DashboardPage project={selectedProject} />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/project/:projectPath" element={<ProjectDetailPage />} />
        <Route path="/activity" element={<ActivityListPage />} />
        <Route path="/runners" element={<RunnersPage />} />
        <Route path="/tasks" element={<RunningTasksPage />} />
        <Route path="/settings" element={<div className="p-8"><p className="text-text-secondary">Settings page coming soon...</p></div>} />
      </Routes>
    </AppShell>
  );
}

export default App;
