import React, { useEffect, useState, useRef } from 'react';
import { Project } from '../../types';
import { projectsApi } from '../../services/api';

interface ProjectSelectorProps {
  selectedProject: Project | null;
  onSelectProject: (project: Project | null) => void;
}

export const ProjectSelector: React.FC<ProjectSelectorProps> = ({
  selectedProject,
  onSelectProject,
}) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadProjects();
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadProjects = async () => {
    try {
      setLoading(true);
      const data = await projectsApi.list(false); // Only enabled projects
      setProjects(data);

      // Auto-select first project if none selected
      if (!selectedProject && data.length > 0) {
        onSelectProject(data[0]);
      }
    } catch (error) {
      console.error('Failed to load projects:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (project: Project) => {
    onSelectProject(project);
    setIsOpen(false);
  };

  const getDisplayName = (project: Project | null) => {
    if (!project) return 'Select Project';
    return project.name || project.path.split('/').pop() || 'Project';
  };

  if (loading && projects.length === 0) {
    return (
      <div className="px-4 py-2 bg-gray-100 rounded text-sm text-gray-500">
        Loading...
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="px-4 py-2 bg-gray-100 rounded text-sm text-gray-500">
        No projects available
      </div>
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors min-w-[200px] text-left"
      >
        <span className="flex-1 truncate font-medium text-gray-900">
          {getDisplayName(selectedProject)}
        </span>
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-full min-w-[300px] bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-[400px] overflow-y-auto">
          {projects.map((project) => (
            <button
              key={project.path}
              onClick={() => handleSelect(project)}
              className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-b-0 ${
                selectedProject?.path === project.path ? 'bg-blue-50' : ''
              }`}
            >
              <div className="font-medium text-gray-900 truncate">
                {project.name || project.path.split('/').pop() || 'Project'}
              </div>
              <div className="text-xs text-gray-500 truncate mt-1">{project.path}</div>
              {project.stats && (
                <div className="flex gap-3 mt-2 text-xs">
                  <span className="text-gray-600">
                    {project.stats.pending} pending
                  </span>
                  <span className="text-blue-600">
                    {project.stats.in_progress} in progress
                  </span>
                  <span className="text-yellow-600">
                    {project.stats.review} review
                  </span>
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
