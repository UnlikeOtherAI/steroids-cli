import React from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon, CheckCircleIcon, ExclamationCircleIcon, MinusCircleIcon, PlayIcon, ArrowPathIcon, BoltIcon } from '@heroicons/react/24/outline';
import { WakeupResult } from '../../services/api';

interface WakeupModalProps {
  results: WakeupResult[];
  onClose: () => void;
}

export const WakeupModal: React.FC<WakeupModalProps> = ({ results, onClose }) => {
  const getIcon = (action: string) => {
    switch (action) {
      case 'started':
        return <PlayIcon className="w-5 h-5 text-success" />;
      case 'restarted':
        return <ArrowPathIcon className="w-5 h-5 text-warning" />;
      case 'skipped':
        return <MinusCircleIcon className="w-5 h-5 text-text-muted" />;
      case 'error':
        return <ExclamationCircleIcon className="w-5 h-5 text-danger" />;
      default:
        return <CheckCircleIcon className="w-5 h-5 text-info" />;
    }
  };

  const getActionColor = (action: string) => {
    switch (action) {
      case 'started':
        return 'text-success bg-success-soft';
      case 'restarted':
        return 'text-warning bg-warning-soft';
      case 'skipped':
        return 'text-text-secondary bg-bg-surface2';
      case 'error':
        return 'text-danger bg-danger-soft';
      default:
        return 'text-info bg-info-soft';
    }
  };

  const totalStarted = results.filter(r => r.action === 'started' || r.action === 'restarted').length;
  const isGlobalMessage = results.length === 1 && !results[0].projectPath;

  const modalContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="bg-bg-page rounded-xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh] border border-border animate-fade-in">
        
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border bg-bg-surface">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${totalStarted > 0 ? 'bg-success-soft text-success' : 'bg-bg-surface2 text-text-muted'}`}>
              <BoltIcon className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-text-primary">Wakeup Cycle Completed</h2>
              <p className="text-sm text-text-secondary">
                {totalStarted > 0 
                  ? `Started or restarted ${totalStarted} runner(s).` 
                  : 'No new runners were started.'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-text-muted hover:bg-bg-surface2 transition-colors"
          >
            <XMarkIcon className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto bg-bg-base flex-1">
          {isGlobalMessage ? (
            <div className="text-center py-8">
              <p className="text-text-primary font-medium">{results[0].reason || 'Completed'}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {results.map((result, idx) => (
                <div key={idx} className="flex items-start gap-4 p-4 rounded-lg bg-bg-surface border border-border">
                  <div className="mt-0.5">
                    {getIcon(result.action)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-4 mb-1">
                      <h3 className="font-semibold text-text-primary truncate" title={result.projectPath || 'System'}>
                        {result.projectPath ? result.projectPath.split('/').pop() : 'System'}
                      </h3>
                      <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full whitespace-nowrap ${getActionColor(result.action)}`}>
                        {result.action}
                      </span>
                    </div>
                    
                    {result.reason && (
                      <p className="text-sm text-text-secondary">
                        {result.reason}
                      </p>
                    )}
                    
                    {result.pendingTasks !== undefined && result.pendingTasks > 0 && (
                      <div className="mt-2 text-xs text-text-muted flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent"></span>
                        {result.pendingTasks} pending task{result.pendingTasks === 1 ? '' : 's'}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-border bg-bg-surface flex justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-bg-surface2 text-text-primary rounded-lg font-medium hover:bg-border transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};

