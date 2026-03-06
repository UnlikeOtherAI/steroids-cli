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
  PauseIcon,
  BookOpenIcon,
  ChartBarIcon,
  CpuChipIcon,
} from '@heroicons/react/24/outline';
import { runnersApi, WakeupResult } from '../../services/api';
import { WakeupModal } from '../molecules/WakeupModal';

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

  const navItems = [
    { to: '/', icon: HomeIcon, label: 'Dashboard' },
    { to: '/model-usage', icon: ChartBarIcon, label: 'Model Usage' },
    { to: '/runners', icon: PlayIcon, label: 'Runners' },
    { to: '/projects', icon: FolderIcon, label: 'Projects' },
    { to: '/logs', icon: DocumentTextIcon, label: 'System Logs' },
    { to: '/skills', icon: BookOpenIcon, label: 'Skills' },
    { to: '/settings', icon: Cog6ToothIcon, label: 'Settings' },
  ];

  const hfItems = [
    { to: '/hf/account', label: 'Account' },
    { to: '/hf/models', label: 'Model Library' },
    { to: '/hf/ready', label: 'Ready to Use' },
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
        <div className="px-6 pt-4 pb-2 text-xs uppercase tracking-wide text-text-inverse/60 flex items-center gap-2">
          <CpuChipIcon className="w-4 h-4" />
          Hugging Face
        </div>
        {hfItems.map((item) => (
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
