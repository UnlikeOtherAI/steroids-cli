import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  HomeIcon,
  ClipboardDocumentListIcon,
  Cog6ToothIcon,
  FolderIcon,
} from '@heroicons/react/24/outline';

interface SidebarProps {
  projectName?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({ projectName }) => {
  const navItems = [
    { to: '/', icon: HomeIcon, label: 'Dashboard' },
    { to: '/tasks', icon: ClipboardDocumentListIcon, label: 'Tasks' },
    { to: '/projects', icon: FolderIcon, label: 'Projects' },
    { to: '/settings', icon: Cog6ToothIcon, label: 'Settings' },
  ];

  return (
    <aside className="w-60 bg-sidebar flex flex-col min-h-full rounded-xl">
      <div className="px-6 py-8">
        <h1 className="text-xl font-bold text-text-inverse">Steroids</h1>
        {projectName && (
          <p className="text-xs text-text-inverse/60 mt-1 truncate">{projectName}</p>
        )}
      </div>
      <nav className="flex-1 px-3 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
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
