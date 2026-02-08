import { Routes, Route, Link } from 'react-router-dom';
import { ProjectsPage } from './pages/ProjectsPage';
import './App.css';

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Steroids Dashboard</h1>
        <nav>
          <Link to="/projects">Projects</Link>
        </nav>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<div>Welcome to Steroids Dashboard</div>} />
          <Route path="/projects" element={<ProjectsPage />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
