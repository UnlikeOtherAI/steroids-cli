import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  HomeIcon,
  ClipboardDocumentListIcon,
  Cog6ToothIcon,
  FolderIcon,
  PlayIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

interface SidebarProps {
  projectName?: string;
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ projectName, onClose }) => {
  const navItems = [
    { to: '/', icon: HomeIcon, label: 'Dashboard' },
    { to: '/runners', icon: PlayIcon, label: 'Runners' },
    { to: '/tasks', icon: ClipboardDocumentListIcon, label: 'Tasks' },
    { to: '/projects', icon: FolderIcon, label: 'Projects' },
    { to: '/settings', icon: Cog6ToothIcon, label: 'Settings' },
  ];

  return (
    <aside className="w-60 bg-sidebar flex flex-col h-full min-h-screen lg:min-h-full lg:rounded-l-xl">
      <div className="px-6 py-8 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-inverse">Steroids</h1>
          {projectName && (
            <p className="text-xs text-text-inverse/60 mt-1 truncate">{projectName}</p>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="lg:hidden p-1 rounded-lg hover:bg-white/10 text-text-inverse"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        )}
      </div>
      <nav className="flex-1 px-3 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onClose}
            className={({ isActive }) =>
              isActive ? 'sidebar-item-active' : 'sidebar-item'
            }
          >
            <item.icon className="w-5 h-5" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="p-4">
        <button className="btn-accent w-full flex items-center justify-center gap-2">
          <span>Start Runner</span>
        </button>
      </div>
    </aside>
  );
};
