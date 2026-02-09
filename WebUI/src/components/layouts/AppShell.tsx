import React, { useState } from 'react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { Project } from '../../types';

interface AppShellProps {
  children: React.ReactNode;
  title?: string;
  project?: Project | null;
}

export const AppShell: React.FC<AppShellProps> = ({ children, title, project }) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const projectName = project?.name || project?.path.split('/').pop();

  return (
    <div className="min-h-screen bg-bg-page flex items-center justify-center p-2 md:p-6">
      <div className="w-full max-w-[1440px] min-h-[calc(100vh-16px)] md:min-h-[calc(100vh-48px)] bg-bg-shell rounded-2xl md:rounded-[32px] shadow-shell flex overflow-hidden relative">
        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar - hidden on mobile by default */}
        <div
          className={`
            fixed inset-y-0 left-0 z-50 w-60 transform transition-transform duration-300 ease-in-out lg:relative lg:translate-x-0 lg:self-stretch
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
        >
          <Sidebar projectName={projectName} onClose={() => setSidebarOpen(false)} />
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <TopBar
            title={title}
            onMenuClick={() => setSidebarOpen(true)}
          />
          <main className="flex-1 bg-bg-surface overflow-auto">{children}</main>
        </div>
      </div>
    </div>
  );
};
