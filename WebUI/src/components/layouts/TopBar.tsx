import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellIcon, Bars3Icon } from '@heroicons/react/24/outline';
import { projectsApi } from '../../services/api';

interface TopBarProps {
  title?: string;
  onMenuClick?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ title = 'Dashboard', onMenuClick }) => {
  const navigate = useNavigate();
  const [hasBlockedProjects, setHasBlockedProjects] = useState(false);

  useEffect(() => {
    const checkBlockedProjects = async () => {
      try {
        const projects = await projectsApi.list(false);
        const hasBlocked = projects.some(p => p.isBlocked);
        setHasBlockedProjects(hasBlocked);
      } catch (err) {
        console.error('Failed to check for blocked projects:', err);
      }
    };
    checkBlockedProjects();
  }, []);

  return (
    <header className="h-[72px] flex items-center justify-between px-4 md:px-8 bg-bg-surface border-b border-gray-200">
      <div className="flex items-center gap-3">
        {/* Burger menu - visible on mobile only */}
        <button
          onClick={onMenuClick}
          className="lg:hidden p-2 rounded-lg hover:bg-bg-surface2 text-text-primary"
        >
          <Bars3Icon className="w-6 h-6" />
        </button>
        <h2 className="text-xl md:text-2xl font-bold text-text-primary">{title}</h2>
      </div>
      <div className="flex items-center gap-2 md:gap-4">
        {hasBlockedProjects && (
          <button 
            className="btn-pill p-2 md:p-3 relative text-red-500 hover:bg-red-50 transition-colors"
            onClick={() => navigate('/projects')}
            title="Projects require attention (failed tasks or disputes)"
            aria-label="Projects blocked"
          >
            <BellIcon className="w-5 h-5" />
            <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full border border-white"></span>
          </button>
        )}
      </div>
    </header>
  );
};
