import React, { useEffect, useState, useCallback } from 'react';
import { NavLink } from 'react-router-dom';
import {
  HomeIcon,
  Cog6ToothIcon,
  FolderIcon,
  PlayIcon,
  DocumentTextIcon,
  StopIcon,
  XMarkIcon,
  BoltIcon,
  ExclamationTriangleIcon,
  PauseIcon,
  BookOpenIcon,
  ChartBarIcon,
  CpuChipIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import { runnersApi, WakeupResult } from '../../services/api';
import { WakeupModal } from '../molecules/WakeupModal';

const OllamaIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 1024 1024" fill="currentColor" className={className}>
    <path d="M524.4 109.32c-5.52-.48-11.16-.6-16.92-.24-31.44 1.92-58.2 16.32-79.44 36.72-21.36 20.52-37.08 46.8-47.76 74.04-10.56 26.88-16.2 54.96-17.76 79.08-.36 5.52-.48 10.92-.36 16.08-40.68 28.56-70.32 68.88-87.12 111.36-19.2 48.6-23.04 100.68-9.96 145.68l.12.36c-32.52 38.16-52.56 84.96-56.64 133.08-4.44 52.32 8.52 105.48 42.12 148.56l.12.12c14.88 18.84 32.88 34.56 53.16 46.92 20.28 12.36 42.96 21.24 67.08 25.92 43.92 8.52 92.52 4.32 145.2-6.12h.24c53.64 10.56 102.36 14.04 145.56 4.44 23.64-5.28 45.72-14.64 65.28-27.36 19.68-12.72 36.96-28.92 50.88-48.12 29.4-40.56 41.52-90.12 38.4-139.2-2.88-45.24-18.96-89.52-47.04-127.68 14.04-44.88 11.04-97.08-7.44-146.04-16.2-42.84-44.64-83.76-84.6-113.52-.12-3.24-.36-6.6-.72-10.08-2.4-24.12-8.88-51.84-20.16-78.36-11.4-26.76-27.72-52.56-49.52-72.48-21.84-19.92-49.32-33.72-81.48-34.8-1.08-.12-2.16-.24-3.24-.36zm7.56 47.04c19.56 1.44 34.92 10.92 48.84 24.12 17.88 16.92 32.64 40.56 42.6 64.92 8.52 20.88 14.04 42.48 16.2 60.84-23.28-9.6-48.24-15.48-74.4-17.16-2.76-.12-5.52-.24-8.28-.24h-3.24c-4.2-17.52-10.08-33-17.88-45.6-8.88-14.28-20.28-25.44-35.16-30.12-14.88-4.68-31.08-2.52-47.16 5.4-14.04 6.96-27.96 18.24-41.16 33.84-.84-1.2-1.8-2.4-2.64-3.48-3.72-4.56-7.56-8.16-11.52-10.68 10.92-15.72 22.08-27.48 33.96-36.12-.84-2.4-1.56-4.8-2.16-7.2-2.4-9.84-2.4-19.08.36-26.76 2.76-7.68 7.68-13.44 14.52-17.04 13.68-7.2 34.08-5.28 52.56 3.96.6.24 1.08.6 1.68.84 1.44-1.2 2.76-2.4 4.32-3.48 9.48-6.6 19.68-10.68 28.56-10.68zm-52.44 73.44c5.52.12 9.72 4.08 14.28 12.48 6.84 12.6 12.36 31.44 15.84 52.92-14.52 1.44-28.56 4.68-41.88 9.48-7.92-17.04-14.76-36.72-14.76-52.8 0-8.88 2.28-16.08 7.2-20.16 4.08-2.04 10.8-2.16 19.32-1.92zm83.16 83.76c2.4 0 4.8.12 7.2.24 40.32 2.76 77.16 20.04 103.08 47.04 25.92 27 40.92 63.84 38.64 105.48-.12 1.56-.24 3-.36 4.44-20.16-12.48-43.2-21.36-68.28-25.68-25.08-4.44-52.32-4.2-81 .84l-1.08.12c-2.4-11.76-6.36-22.32-11.88-30.84-7.32-11.4-17.4-19.32-30.12-21.24-12.6-1.92-25.44 2.4-37.56 11.88-7.2 5.64-14.28 12.96-21 21.84-.12-.12-.12-.12-.24-.24-6.96-8.88-14.04-16.2-21.24-21.84-12.12-9.48-24.96-13.8-37.56-11.88-12.72 1.92-22.8 9.84-30.12 21.24-5.52 8.52-9.48 19.08-11.88 30.84l-1.08-.12c-28.68-5.04-55.92-5.28-81-.84-25.08 4.32-48 13.2-68.28 25.68-.12-1.44-.24-2.88-.36-4.44-2.28-41.64 12.72-78.48 38.64-105.48 25.92-27 62.76-44.28 103.08-47.04 2.4-.12 4.8-.24 7.2-.24h3.12c16.08.6 29.04 4.32 40.56 11.04 7.32 4.2 14.04 9.72 20.52 16.44.36.48.84.84 1.2 1.32 6.96 7.92 13.56 17.4 20.04 28.56l5.76 10.08 5.76-10.08c6.48-11.16 13.08-20.64 20.04-28.56.36-.48.84-.84 1.2-1.32 6.48-6.72 13.2-12.24 20.52-16.44 11.52-6.72 24.48-10.44 40.56-11.04h3.12zm-49.56 97.2c5.4.84 9.72 5.04 14.04 13.44 5.28 10.2 9.24 25.2 11.28 43.44.96 8.4 1.44 17.64 1.56 27.6-8.16 7.08-15.72 15.6-22.44 25.68l-4.56 6.84-4.56-6.84c-6.72-10.08-14.28-18.6-22.44-25.68.12-9.96.6-19.2 1.56-27.6 2.04-18.24 6-33.24 11.28-43.44 4.32-8.52 8.76-12.72 14.28-13.44zm-120.36 7.56c5.52.84 12 5.88 18.72 14.64 9.12 11.88 17.64 29.16 24.12 49.2-9 11.52-16.56 24.96-22.2 40.08-2.04-.12-4.08-.12-6.12-.12-14.64 0-28.44 2.04-41.16 5.76-2.76-16.44-3.84-31.8-3.12-45.36 1.08-19.56 5.88-35.88 13.08-46.08 4.44-6.36 9.48-11.04 14.88-14.04.72-.24 1.2-.36 1.8-.12v.04zm240.72 0c.6-.24 1.08-.12 1.8.12 5.4 3 10.44 7.68 14.88 14.04 7.2 10.2 12 26.52 13.08 46.08.72 13.56-.36 28.92-3.12 45.36-12.72-3.72-26.52-5.76-41.16-5.76-2.04 0-4.08 0-6.12.12-5.64-15.12-13.2-28.56-22.2-40.08 6.48-20.04 15-37.32 24.12-49.2 6.72-8.76 13.2-13.8 18.72-14.64v-.04zm-120.36 63.36c11.16 10.44 20.76 23.4 28.44 38.4.48 1.08 1.08 2.16 1.56 3.24-9.36 5.28-18 11.76-25.68 19.56l-4.32 4.44-4.32-4.44c-7.68-7.8-16.32-14.28-25.68-19.56.48-1.08 1.08-2.16 1.56-3.24 7.68-15 17.28-27.96 28.44-38.4zm-157.68 24.96c27.48-4.56 53.16-4.08 76.2.36l1.08.24c-3.24 10.44-5.52 21.6-6.6 33.24l-.24 2.76c-13.08 2.52-25.32 7.32-36.12 14.04-.72.48-1.44.84-2.16 1.32-12.12-14.28-22.2-31.8-29.4-49.56-.96-1.08-1.92-1.56-2.76-2.4zm315.24 0c-.84.84-1.8 1.32-2.76 2.4-7.2 17.76-17.28 35.28-29.4 49.56-.72-.48-1.44-.84-2.16-1.32-10.8-6.72-23.04-11.52-36.12-14.04l-.24-2.76c-1.08-11.64-3.36-22.8-6.6-33.24l1.08-.24c23.04-4.44 48.72-4.92 76.2-.36zM512 559.32c15.84 0 30.72 3.72 44.04 10.32 2.04 1.08 4.08 2.16 6 3.36-.12 6.72-.84 13.56-2.28 20.28-3.12 14.76-9.48 28.92-19.92 40.32-7.32 8.04-16.44 14.52-27.84 18.12-11.4-3.6-20.52-10.08-27.84-18.12-10.44-11.4-16.8-25.56-19.92-40.32-1.44-6.72-2.16-13.56-2.28-20.28 1.92-1.2 3.96-2.28 6-3.36 13.32-6.6 28.2-10.32 44.04-10.32zm-86.04 21.36c.12 8.4.96 16.92 2.76 25.32 3.6 16.92 10.92 33.24 23.04 46.56 3.6 3.96 7.56 7.56 11.88 10.68-11.88 6-24.96 9.48-38.76 10.2-18.96 1.08-39-4.2-57.72-18.6-16.08-12.36-24.36-28.2-27.36-44.16-3-16.08-1.32-32.52 3.84-46.32 10.08-7.44 21.84-13.08 35.04-16.32 16.08-4.08 33.6-5.4 51.6-3.48-1.68 11.52-3 23.52-4.32 36.12v.64zm172.08 0v-.6c-1.32-12.6-2.64-24.6-4.32-36.12 18-.12 35.52 1.2 51.6 5.28 13.2 3.6 24.96 9.24 35.04 16.68 5.16 13.8 6.84 30.24 3.84 46.32-3 15.96-11.28 31.8-27.36 44.16-18.72 14.4-38.76 19.68-57.72 18.6-13.8-.72-26.88-4.2-38.76-10.2 4.32-3.12 8.28-6.72 11.88-10.68 12.12-13.32 19.44-29.64 23.04-46.56 1.8-8.4 2.64-16.92 2.76-25.32v-1.56zm-253.08 64.56l.84.96c22.44 22.2 49.2 31.8 74.76 30.6 14.16-.72 27.84-4.44 40.32-10.68 5.88 2.88 11.88 5.04 18 6.48-2.52 14.04-6.96 30.12-14.16 46.08-9.12 20.28-22.56 40.44-42.24 55.68-29.52 22.92-56.4 28.32-80.4 25.2-12-1.56-23.04-5.64-33.12-11.76l-.12-.12c-19.68-12-34.56-29.52-44.76-49.68-10.2-20.16-15.72-42.84-16.08-65.64-.36-19.92 3.48-39.84 12-57.72 25.68 17.28 54 28.32 84.96 30.6v.12zm335.16-1.8c9 18.24 12.96 38.64 12.48 59.04-.6 22.8-6.6 45.48-17.28 65.4-10.68 19.92-26.4 37.2-47.04 48.72-9.72 5.52-20.28 9.12-31.56 10.56-22.56 2.88-48.24-1.44-77.52-22.44-20.76-14.88-35.04-35.64-44.88-56.76-7.44-16.08-12.24-32.28-14.88-46.44 6.12-1.44 12.12-3.6 18-6.48 12.48 6.24 26.16 9.96 40.32 10.68 25.56 1.2 52.32-8.4 74.76-30.6l.84-.96c31.32-1.92 60.12-13.2 86.76-31.68v-.04z" />
  </svg>
);

interface SidebarProps {
  projectName?: string;
  onClose?: () => void;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  try {
    const date = new Date(dateStr + 'Z'); // Assume UTC if no timezone
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);

    if (diffSecs < 60) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  } catch {
    return 'Unknown';
  }
}

export const Sidebar: React.FC<SidebarProps> = ({ onClose }) => {
  const [cronInstalled, setCronInstalled] = useState<boolean | null>(null);
  const [lastWakeup, setLastWakeup] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [wakeupLoading, setWakeupLoading] = useState(false);
  const [wakeupResults, setWakeupResults] = useState<WakeupResult[] | null>(null);
  const [hfExpanded, setHfExpanded] = useState(false);
  const [ollamaExpanded, setOllamaExpanded] = useState(false);

  const navItems = [
    { to: '/', icon: HomeIcon, label: 'Dashboard' },
    { to: '/projects', icon: FolderIcon, label: 'Projects' },
    { to: '/runners', icon: PlayIcon, label: 'Runners' },
    { to: '/monitor', icon: ShieldCheckIcon, label: 'Monitor' },
    { to: '/intake', icon: ExclamationTriangleIcon, label: 'Intake' },
    { to: '/model-usage', icon: ChartBarIcon, label: 'Model Usage' },
    { to: '/logs', icon: DocumentTextIcon, label: 'System Logs' },
    { to: '/skills', icon: BookOpenIcon, label: 'Skills' },
    { to: '/settings', icon: Cog6ToothIcon, label: 'Settings' },
  ];

  const hfItems = [
    { to: '/hf/account', label: 'Account' },
    { to: '/hf/models', label: 'Model Library' },
    { to: '/hf/ready', label: 'Ready to Use' },
  ];

  const ollamaItems = [
    { to: '/ollama/connection', label: 'Connection' },
    { to: '/ollama/installed', label: 'Installed Models' },
    { to: '/ollama/library', label: 'Model Library' },
    { to: '/ollama/ready', label: 'Ready to Use' },
    { to: '/ollama/account', label: 'Account' },
  ];

  const fetchCronStatus = useCallback(async () => {
    try {
      const response = await runnersApi.getCronStatus();
      setCronInstalled(response.cron.installed);
      setLastWakeup(response.last_wakeup_at);
    } catch (err) {
      console.error('Failed to fetch cron status:', err);
    }
  }, []);

  useEffect(() => {
    fetchCronStatus();
    // Refresh every 30 seconds
    const interval = setInterval(fetchCronStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchCronStatus]);

  const handleCronToggle = async () => {
    if (loading || cronInstalled === null) return;
    setLoading(true);
    try {
      if (cronInstalled) {
        await runnersApi.stopCron();
      } else {
        await runnersApi.startCron();
      }
      await fetchCronStatus();
    } catch (err) {
      console.error('Failed to toggle cron:', err);
      alert('Failed to toggle steroids: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setLoading(false);
    }
  };

  const handleWakeupNow = async () => {
    if (wakeupLoading) return;
    setWakeupLoading(true);
    try {
      const res = await runnersApi.wakeupNow();
      setWakeupResults(res.wakeup || []);
      await fetchCronStatus();
    } catch (err: any) {
      console.error('Failed to trigger wakeup:', err);
      if (err.message && err.message.includes('Too Many Requests')) {
         alert('A wakeup cycle is already running.');
      } else {
         alert('Failed to trigger wakeup: ' + (err.message || 'Unknown error'));
      }
    } finally {
      setWakeupLoading(false);
    }
  };

  return (
    <>
      {wakeupResults && <WakeupModal results={wakeupResults} onClose={() => setWakeupResults(null)} />}
      <aside className="w-60 bg-sidebar flex flex-col h-full max-h-screen lg:rounded-l-xl">
      <div className="py-4 pr-4 flex items-center justify-between overflow-hidden">
        <div className="flex items-center">
          <img src="/logo-hand.png" alt="" className="h-20 w-auto" style={{ marginLeft: '-2px' }} />
          <h1 className="text-xl font-bold text-text-inverse" style={{ marginLeft: '28px' }}>Steroids</h1>
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
      <nav className="flex-1 overflow-y-auto px-3 space-y-1">
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
        <button
          type="button"
          onClick={() => setHfExpanded((v) => !v)}
          className="w-full px-6 pt-4 pb-2 text-xs uppercase tracking-wide text-text-inverse/60 flex items-center gap-2 hover:text-text-inverse/80 transition-colors"
        >
          <CpuChipIcon className="w-4 h-4" />
          <span className="flex-1 text-left">Hugging Face</span>
          {hfExpanded ? <ChevronDownIcon className="w-3 h-3" /> : <ChevronRightIcon className="w-3 h-3" />}
        </button>
        {hfExpanded && hfItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onClose}
            className={({ isActive }) => (
              isActive ? 'sidebar-item-active ml-4' : 'sidebar-item ml-4'
            )}
          >
            <span>{item.label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setOllamaExpanded((v) => !v)}
          className="w-full px-6 pt-4 pb-2 text-xs uppercase tracking-wide text-text-inverse/60 flex items-center gap-2 hover:text-text-inverse/80 transition-colors"
        >
          <OllamaIcon className="w-4 h-4" />
          <span className="flex-1 text-left">Ollama</span>
          {ollamaExpanded ? <ChevronDownIcon className="w-3 h-3" /> : <ChevronRightIcon className="w-3 h-3" />}
        </button>
        {ollamaExpanded && ollamaItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onClose}
            className={({ isActive }) => (
              isActive ? 'sidebar-item-active ml-4' : 'sidebar-item ml-4'
            )}
          >
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="flex-shrink-0 px-4 pt-4 pb-[44px]">
        {cronInstalled === false && (
           <div className="mb-4 bg-orange-500/20 text-orange-200 text-xs font-bold px-3 py-2 rounded-lg text-center border border-orange-500/30 flex items-center justify-center gap-2">
             <PauseIcon className="w-4 h-4" />
             Daemon Paused
           </div>
        )}
        <button
          onClick={handleWakeupNow}
          disabled={loading || wakeupLoading}
          className="w-full flex items-center justify-center gap-2 py-2 px-4 mb-2 rounded-lg font-medium transition-colors bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <BoltIcon className="w-4 h-4" />
          <span>Wake Up Runners</span>
        </button>
        <button
          onClick={handleCronToggle}
          disabled={loading || cronInstalled === null}
          className={`w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg font-medium transition-colors ${
            cronInstalled
              ? 'bg-red-500 hover:bg-red-600 text-white'
              : 'btn-accent'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {cronInstalled ? (
            <>
              <StopIcon className="w-4 h-4" />
              <span>Stop Steroids</span>
            </>
          ) : (
            <>
              <PlayIcon className="w-4 h-4" />
              <span>Start Steroids</span>
            </>
          )}
        </button>
        {lastWakeup && (
          <p className="text-[10px] text-text-inverse/40 text-center mt-1">
            Last wakeup: {formatRelativeTime(lastWakeup)}
          </p>
        )}
      </div>
    </aside>
    </>
  );
};
