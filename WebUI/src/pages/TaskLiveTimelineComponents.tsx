import React from 'react';
import { TaskTimelineEvent } from '../types';
import { Badge } from '../components/atoms/Badge';

export type StreamState =
  | { status: 'disconnected' | 'connecting' | 'connected' }
  | { status: 'no_active_invocation' }
  | { status: 'waiting_for_log'; invocationId?: number }
  | { status: 'log_not_found'; invocationId?: number }
  | { status: 'error'; message: string };

export function formatTimestampMs(ms: number): string {
  return new Date(ms).toLocaleString();
}

function getTimelineIcon(type: string): string {
  switch (type) {
    case 'invocation.started': return 'fa-play';
    case 'invocation.completed': return 'fa-flag-checkered';
    case 'tool': return 'fa-terminal';
    case 'output': return 'fa-align-left';
    case 'error': return 'fa-triangle-exclamation';
    default: return 'fa-circle';
  }
}

function summarizeTimelineEvent(
  e: TaskTimelineEvent
): { title: string; detail?: string; variant?: 'default' | 'info' | 'success' | 'warning' | 'danger' } {
  const t = e.type;
  if (t === 'invocation.started') {
    const role = String(e.role ?? '');
    const provider = String(e.provider ?? '');
    const model = String(e.model ?? '');
    return {
      title: 'Invocation started',
      detail: [role, provider, model].filter(Boolean).join(' / '),
      variant: 'info',
    };
  }
  if (t === 'invocation.completed') {
    const success = Boolean(e.success);
    const duration = typeof e.duration === 'number' ? `${Math.round((e.duration as number) / 1000)}s` : undefined;
    return {
      title: success ? 'Invocation completed' : 'Invocation failed',
      detail: duration ? `Duration: ${duration}` : undefined,
      variant: success ? 'success' : 'danger',
    };
  }
  if (t === 'tool') {
    return { title: 'Tool', detail: String(e.cmd ?? ''), variant: 'default' };
  }
  if (t === 'output') {
    const msg = String(e.msg ?? '');
    const trimmed = msg.length > 800 ? `${msg.slice(0, 800)}...` : msg;
    return { title: 'Output', detail: trimmed, variant: 'default' };
  }
  if (t === 'error') {
    return { title: 'Error', detail: String(e.error ?? e.message ?? ''), variant: 'danger' };
  }
  return { title: t || 'Event', variant: 'default' };
}

export const LiveInvocationActivityPanel: React.FC<{
  isLive: boolean;
  streamState: StreamState;
  liveActivity: TaskTimelineEvent[];
  onClear: () => void;
}> = ({ isLive, streamState, liveActivity, onClear }) => {
  return (
    <div className="card p-4 mb-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary">
            <i className="fa-solid fa-signal mr-2"></i>
            Live Invocation Activity
          </div>
          <div className="text-xs text-text-muted">
            Streams the currently running invocation via SSE (no DB polling).
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {streamState.status === 'connected' && (
            <span className="inline-flex items-center gap-2 text-xs text-success">
              <span className="w-2 h-2 bg-success rounded-full animate-pulse"></span>
              Connected
            </span>
          )}
          {streamState.status === 'connecting' && (
            <span className="inline-flex items-center gap-2 text-xs text-text-muted">
              <i className="fa-solid fa-spinner fa-spin"></i>
              Connecting
            </span>
          )}
          {streamState.status === 'no_active_invocation' && (
            <span className="inline-flex items-center gap-2 text-xs text-text-muted">
              <i className="fa-regular fa-moon"></i>
              No active invocation
            </span>
          )}
          {streamState.status === 'waiting_for_log' && (
            <span className="inline-flex items-center gap-2 text-xs text-text-muted">
              <i className="fa-solid fa-hourglass-start"></i>
              Waiting for log{streamState.invocationId ? ` (#${streamState.invocationId})` : ''}
            </span>
          )}
          {streamState.status === 'log_not_found' && (
            <span className="inline-flex items-center gap-2 text-xs text-warning">
              <i className="fa-solid fa-triangle-exclamation"></i>
              Log not found{streamState.invocationId ? ` (#${streamState.invocationId})` : ''}
            </span>
          )}
          {streamState.status === 'error' && (
            <span className="inline-flex items-center gap-2 text-xs text-danger" title={streamState.message}>
              <i className="fa-solid fa-triangle-exclamation"></i>
              Stream error
            </span>
          )}
          <button
            onClick={onClear}
            className="px-3 py-1 text-xs bg-bg-surface text-text-muted hover:text-text-primary rounded transition-colors"
          >
            <i className="fa-solid fa-broom mr-1"></i>
            Clear
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-bg-base overflow-hidden">
        {liveActivity.length === 0 ? (
          <div className="p-4 text-sm text-text-muted">
            {isLive ? 'No live activity yet.' : 'Live updates are paused.'}
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto divide-y divide-border">
            {liveActivity.map((e, idx) => {
              const info = summarizeTimelineEvent(e);
              const ts = typeof e.ts === 'number' ? e.ts : Date.now();
              return (
                <div key={`${ts}-${idx}`} className="p-3 text-xs">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-bg-surface flex items-center justify-center">
                      <i className={`fa-solid ${getTimelineIcon(String(e.type))} text-text-muted text-[10px]`}></i>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-text-primary">{info.title}</span>
                        {typeof e.invocationId === 'number' && (
                          <span className="text-text-muted">#{e.invocationId}</span>
                        )}
                        <span className="text-text-muted ml-auto">{formatTimestampMs(ts)}</span>
                      </div>
                      {info.detail && (
                        <div className="mt-1 font-mono whitespace-pre-wrap break-words text-text-secondary">
                          {info.detail}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export const InvocationTimelineEventRow: React.FC<{ event: TaskTimelineEvent; ts: number }> = ({ event, ts }) => {
  const info = summarizeTimelineEvent(event);
  return (
    <div className="p-4 border-l-4 border-border bg-bg-base">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-bg-surface flex items-center justify-center">
          <i className={`fa-solid ${getTimelineIcon(String(event.type))} text-text-muted text-sm`}></i>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-text-primary">{info.title}</span>
            {typeof event.invocationId === 'number' && (
              <Badge variant="default">Invocation #{event.invocationId}</Badge>
            )}
            {info.variant && (
              <Badge variant={info.variant}>{String(event.type)}</Badge>
            )}
          </div>
          {info.detail && (
            <div className="mt-2 p-3 rounded-lg text-sm font-mono whitespace-pre-wrap bg-bg-surface text-text-secondary">
              {info.detail}
            </div>
          )}
          <div className="mt-2 flex items-center gap-4 text-xs text-text-muted">
            <span>
              <i className="fa-regular fa-clock mr-1"></i>
              {formatTimestampMs(ts)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

