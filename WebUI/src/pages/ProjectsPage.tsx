import React, { useEffect, useState } from 'react';
import { Switch, FormControlLabel } from '@mui/material';
import { projectsApi, ApiError } from '../services/api';
import { Project } from '../types';
import { ProjectCard } from '../components/molecules/ProjectCard';
import { Button } from '../components/atoms/Button';

export const ProjectsPage: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeDisabled, setIncludeDisabled] = useState(true);

  const loadProjects = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await projectsApi.list(includeDisabled);
      setProjects(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, [includeDisabled]);

  const handlePrune = async () => {
    if (!confirm('Remove all projects with missing directories?')) {
      return;
    }

    try {
      const count = await projectsApi.prune();
      alert(`Pruned ${count} stale project(s)`);
      await loadProjects();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to prune projects');
    }
  };

  if (loading && projects.length === 0) {
    return (
      <div className="p-8">
        <div className="text-center">
          <div className="text-gray-500">Loading projects...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Projects</h1>
          <p className="text-gray-600 mt-1">Manage registered Steroids projects</p>
        </div>
        <div className="flex items-center gap-3">
          <FormControlLabel
            control={
              <Switch
                checked={includeDisabled}
                onChange={(e) => setIncludeDisabled(e.target.checked)}
                color="primary"
              />
            }
            label="Show disabled"
            sx={{ '& .MuiFormControlLabel-label': { fontSize: '0.875rem', color: '#374151' } }}
          />
          <Button variant="secondary" size="sm" onClick={handlePrune}>
            Prune Stale
          </Button>
          <Button size="sm" onClick={loadProjects}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-800">
            <strong>Error:</strong> {error}
          </p>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg">No projects registered</p>
          <p className="text-gray-400 mt-2">
            Run <code className="bg-gray-100 px-2 py-1 rounded">steroids init</code> in a project
            directory to register it
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <ProjectCard key={project.path} project={project} />
          ))}
        </div>
      )}

      <div className="mt-8 text-center text-sm text-gray-500">
        {projects.length} project{projects.length !== 1 ? 's' : ''} registered
      </div>
    </div>
  );
};

export default ProjectsPage;
