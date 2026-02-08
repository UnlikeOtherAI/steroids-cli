import { Routes, Route, Link } from 'react-router-dom';
import { ProjectsPage } from './pages/ProjectsPage';
import { DashboardPage } from './pages/DashboardPage';
import { ProjectSelector } from './components/molecules/ProjectSelector';
import { useProject } from './contexts/ProjectContext';
import './App.css';

function App() {
  const { selectedProject, setSelectedProject } = useProject();

  return (
    <div className="app">
      <header className="app-header" style={{
        padding: '1rem 2rem',
        borderBottom: '1px solid #e5e7eb',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: 'white'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '2rem' }}>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 'bold' }}>
            Steroids Dashboard
          </h1>
          <nav style={{ display: 'flex', gap: '1rem' }}>
            <Link to="/" style={{ textDecoration: 'none', color: '#4B5563' }}>
              Dashboard
            </Link>
            <Link to="/projects" style={{ textDecoration: 'none', color: '#4B5563' }}>
              All Projects
            </Link>
          </nav>
        </div>
        <div>
          <ProjectSelector
            selectedProject={selectedProject}
            onSelectProject={setSelectedProject}
          />
        </div>
      </header>
      <main className="app-main" style={{ backgroundColor: '#f9fafb', minHeight: 'calc(100vh - 73px)' }}>
        <Routes>
          <Route
            path="/"
            element={
              selectedProject ? (
                <DashboardPage project={selectedProject} />
              ) : (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '400px',
                  flexDirection: 'column',
                  gap: '1rem'
                }}>
                  <p style={{ fontSize: '1.25rem', color: '#6B7280' }}>
                    Select a project to view its dashboard
                  </p>
                  <Link
                    to="/projects"
                    style={{
                      color: '#2563EB',
                      textDecoration: 'underline'
                    }}
                  >
                    View all projects
                  </Link>
                </div>
              )
            }
          />
          <Route path="/projects" element={<ProjectsPage />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
