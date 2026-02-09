import React from 'react';
import { MagnifyingGlassIcon, BellIcon, Bars3Icon } from '@heroicons/react/24/outline';

interface TopBarProps {
  title?: string;
  onMenuClick?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ title = 'Dashboard', onMenuClick }) => {
  return (
    <header className="h-[72px] flex items-center justify-between px-4 md:px-8 bg-bg-surface">
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
        {/* Search - hidden on small screens */}
        <div className="relative hidden md:block">
          <MagnifyingGlassIcon className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
          <input type="text" placeholder="Search tasks..." className="input-search w-64" />
        </div>
        <button className="btn-pill p-2 md:p-3"><BellIcon className="w-5 h-5" /></button>
      </div>
    </header>
  );
};
