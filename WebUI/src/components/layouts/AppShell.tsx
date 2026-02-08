import React from 'react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { Project } from '../../types';

interface AppShellProps {
  children: React.ReactNode;
  title?: string;
  project?: Project | null;
}

export const AppShell: React.FC<AppShellProps> = ({ children, title, project }) => {
  const projectName = project?.name || project?.path.split('/').pop();

  return (
    <div className="min-h-screen bg-bg-page flex items-center justify-center p-6">
      <div className="w-full max-w-[1440px] min-h-[calc(100vh-48px)] bg-bg-shell rounded-[32px] shadow-shell flex overflow-hidden">
        <Sidebar projectName={projectName} />
        <div className="flex-1 flex flex-col">
          <TopBar title={title} project={project} />
          <main className="flex-1 bg-bg-surface overflow-auto">{children}</main>
        </div>
      </div>
    </div>
  );
};
