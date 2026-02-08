import { Routes, Route, useLocation } from 'react-router-dom';
import { ProjectsPage } from './pages/ProjectsPage';
import { DashboardPage } from './pages/DashboardPage';
import { AppShell } from './components/layouts';
import { useProject } from './contexts/ProjectContext';
import './App.css';

function App() {
  const { selectedProject, setSelectedProject } = useProject();
  const location = useLocation();

  const getPageTitle = () => {
    switch (location.pathname) {
      case '/': return 'Dashboard';
      case '/projects': return 'Projects';
      case '/tasks': return 'Tasks';
      case '/settings': return 'Settings';
      default: return 'Dashboard';
    }
  };

  return (
    <AppShell title={getPageTitle()} project={selectedProject}>
      <Routes>
        <Route path="/" element={
          selectedProject ? (
            <DashboardPage project={selectedProject} />
          ) : (
            <div className="flex items-center justify-center h-[400px] flex-col gap-4">
              <p className="text-xl text-text-secondary">Select a project to view its dashboard</p>
              <a href="/projects" className="text-accent hover:text-accent-hover underline">View all projects</a>
            </div>
          )
        } />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/tasks" element={<div className="p-8"><p className="text-text-secondary">Tasks page coming soon...</p></div>} />
        <Route path="/settings" element={<div className="p-8"><p className="text-text-secondary">Settings page coming soon...</p></div>} />
      </Routes>
    </AppShell>
  );
}

export default App;
