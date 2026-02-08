import React from 'react';
import { MagnifyingGlassIcon, BellIcon } from '@heroicons/react/24/outline';
import { Project } from '../../types';

interface TopBarProps {
  title?: string;
  project?: Project | null;
}

export const TopBar: React.FC<TopBarProps> = ({ title = 'Dashboard', project }) => {
  const projectName = project?.name || project?.path.split('/').pop() || 'Select Project';

  return (
    <header className="h-[72px] flex items-center justify-between px-8 bg-bg-surface">
      <h2 className="text-2xl font-bold text-text-primary">{title}</h2>
      <div className="flex items-center gap-4">
        <div className="relative">
          <MagnifyingGlassIcon className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
          <input type="text" placeholder="Search tasks..." className="input-search w-64" />
        </div>
        <button className="btn-pill p-3"><BellIcon className="w-5 h-5" /></button>
        <div className="btn-pill flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-success" />
          <span className="text-sm font-medium truncate max-w-[150px]">{projectName}</span>
        </div>
      </div>
    </header>
  );
};
