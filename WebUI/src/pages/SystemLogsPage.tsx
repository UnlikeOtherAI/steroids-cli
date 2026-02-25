import React, { useState, useEffect, useRef } from 'react';
import { ProjectSelector } from '../components/molecules/ProjectSelector';
import { API_BASE_URL } from '../services/api';
import { Project } from '../types';
import {
  DocumentTextIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ClipboardDocumentCheckIcon,
  ClipboardIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline';

interface LogFile {
  name: string;
  path: string;
  size: number;
  mtime: string;
  type: 'log' | 'invocation';
}

type LogDisplayMode = 'text' | 'json' | 'jsonl';

function getLogDisplayMode(fileName?: string | null): LogDisplayMode {
  if (!fileName) {
    return 'text';
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.jsonl')) {
    return 'jsonl';
  }
  if (lower.endsWith('.json')) {
    return 'json';
  }
  return 'text';
}

function formatLineForLog(line: string): { text: string; style: string; highlightedText?: React.ReactNode } {
  const trimmed = line.trim();

  if (!trimmed) {
    return { text: '\u00a0', style: 'text-text-secondary' };
  }

  if (/^[-=]{5,}$/.test(trimmed)) {
    return { text: line, style: 'text-text-muted' };
  }

  const keyValueMatch = trimmed.match(
    /^(Timestamp|Role|Provider|Model|Task ID|Duration|Exit Code|Success|Timed Out):\s*(.*)$/i
  );
  if (keyValueMatch) {
    return {
      text: line,
      style: 'text-text-secondary',
      highlightedText: (
        <>
          <span className="text-text-primary font-semibold">{keyValueMatch[1]}:</span>
          <span className="text-text-primary"> {keyValueMatch[2]}</span>
        </>
      ),
    };
  }

  if (/^LLM INVOCATION LOG$/i.test(trimmed)) {
    return { text: line, style: 'text-accent font-semibold' };
  }

  if (/^(PROMPT|RESPONSE|ERROR)$/i.test(trimmed)) {
    return { text: line, style: 'text-warning' };
  }

  if (/\b(FATAL|CRITICAL|ERROR|FAILED)\b/i.test(trimmed)) {
    return { text: line, style: 'text-danger' };
  }

  if (/\b(WARN|WARNING)\b/i.test(trimmed)) {
    return { text: line, style: 'text-warning' };
  }

  if (/\b(SUCCESS|COMPLETED|DONE)\b/i.test(trimmed)) {
    return { text: line, style: 'text-green-300' };
  }

  return { text: line, style: 'text-gray-300' };
}

function formatJsonLines(content: string): React.ReactNode[] {
  return content
    .split('\n')
    .map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return (
          <div key={`jsonl-${index}`} className="h-3 border-b border-transparent">
            <span className="text-text-muted">&nbsp;</span>
          </div>
        );
      }

      try {
        const parsed = JSON.parse(trimmed);
        return (
          <div key={`jsonl-${index}`} className="mb-3">
            <div className="text-xs font-semibold text-accent mb-1">[entry #{index + 1}]</div>
            <pre className="whitespace-pre-wrap break-words text-gray-100">{JSON.stringify(parsed, null, 2)}</pre>
          </div>
        );
      } catch {
        return (
          <div key={`jsonl-${index}`} className="text-gray-300">
            {line}
          </div>
        );
      }
    })
    .filter(Boolean) as React.ReactNode[];
}

function formatTextLog(content: string): React.ReactNode {
  return (
    <div className="text-sm font-mono leading-relaxed">
      {content.split('\n').map((line, index) => {
        const formatted = formatLineForLog(line);
        return (
          <div
            key={`line-${index}`}
            className={`whitespace-pre-wrap break-words py-0.5 ${formatted.style}`}
          >
            {formatted.highlightedText ?? formatted.text}
          </div>
        );
      })}
    </div>
  );
}

function formatLogContent(content: string, fileName?: string | null): React.ReactNode {
  const displayMode = getLogDisplayMode(fileName);

  if (displayMode === 'json') {
    try {
      return <pre className="text-sm font-mono text-gray-100 leading-relaxed whitespace-pre-wrap break-words">{JSON.stringify(JSON.parse(content), null, 2)}</pre>;
    } catch {
      return formatTextLog(content);
    }
  }

  if (displayMode === 'jsonl') {
    return (
      <div className="space-y-2">
        {formatJsonLines(content)}
      </div>
    );
  }

  return formatTextLog(content);
}

export const SystemLogsPage: React.FC = () => {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [logs, setLogs] = useState<LogFile[]>([]);
  const [selectedLogPath, setSelectedLogPath] = useState<string | null>(null);
  const [logContent, setLogContent] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [copied, setCopied] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedProject) {
      fetchLogsList(selectedProject.path);
    } else {
      setLogs([]);
      setSelectedLogPath(null);
      setLogContent(null);
    }
  }, [selectedProject]);

  useEffect(() => {
    if (selectedLogPath && selectedProject) {
      fetchLogContent(selectedProject.path, selectedLogPath);
    } else {
      setLogContent(null);
    }
  }, [selectedLogPath]);

  const fetchLogsList = async (projectPath: string) => {
    setLoadingList(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/projects/logs?path=${encodeURIComponent(projectPath)}`);
      const data = await response.json();
      if (data.success) {
        setLogs(data.logs);
        if (data.logs.length > 0) {
          setSelectedLogPath(data.logs[0].path);
        } else {
          setSelectedLogPath(null);
        }
      }
    } catch (err) {
      console.error('Failed to fetch logs list:', err);
    } finally {
      setLoadingList(false);
    }
  };

  const fetchLogContent = async (projectPath: string, logPath: string) => {
    setLoadingContent(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/projects/logs/content?path=${encodeURIComponent(projectPath)}&file=${encodeURIComponent(logPath)}`);
      if (response.ok) {
        const text = await response.text();
        setLogContent(text);
      } else {
        setLogContent('Failed to load log content.');
      }
    } catch (err) {
      console.error('Failed to fetch log content:', err);
      setLogContent('Error loading log content.');
    } finally {
      setLoadingContent(false);
    }
  };

  const handleCopy = () => {
    if (logContent) {
      navigator.clipboard.writeText(logContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const scrollToTop = () => {
    if (contentRef.current) {
      contentRef.current.scrollTo({ top: 0, behavior: 'instant' });
    }
  };

  const scrollToBottom = () => {
    if (contentRef.current) {
      contentRef.current.scrollTo({ top: contentRef.current.scrollHeight, behavior: 'instant' });
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto flex flex-col h-full h-[calc(100vh-72px)]">
      <div className="mb-6 flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <DocumentTextIcon className="w-6 h-6" /> System Logs
          </h1>
          <p className="text-gray-500 mt-1">View internal system logs and invocation traces.</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-4">
          <div className="w-full sm:w-1/3">
            <ProjectSelector
              selectedProject={selectedProject}
              onSelectProject={setSelectedProject}
            />
          </div>
          
          <div className="w-full sm:w-2/3 flex items-center gap-2">
            <select
              className="form-select flex-1"
              value={selectedLogPath || ''}
              onChange={(e) => setSelectedLogPath(e.target.value)}
              disabled={!selectedProject || logs.length === 0 || loadingList}
            >
              <option value="" disabled>
                {loadingList ? 'Loading logs...' : logs.length === 0 ? 'No logs available' : 'Select a log file'}
              </option>
              {logs.map((log) => (
                <option key={log.path} value={log.path}>
                  [{log.type.toUpperCase()}] {log.name} ({(log.size / 1024).toFixed(1)} KB)
                </option>
              ))}
            </select>

            <button
              onClick={() => selectedProject && fetchLogsList(selectedProject.path)}
              disabled={!selectedProject || loadingList}
              className="btn-secondary px-3 py-2"
              title="Refresh List"
            >
              <ArrowPathIcon className={`w-5 h-5 ${loadingList ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 bg-white rounded-lg border border-gray-200 shadow-sm flex flex-col overflow-hidden relative">
        {/* Toolbar */}
        <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 flex items-center justify-between z-10">
          <div className="text-sm font-medium text-gray-700 truncate">
            {selectedLogPath ? selectedLogPath.split('/').pop() : 'No file selected'}
          </div>
          
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              disabled={!logContent}
              className="flex items-center gap-1.5 px-2 py-1 text-sm text-gray-600 hover:bg-gray-200 rounded disabled:opacity-50 transition-colors"
            >
              {copied ? (
                <><ClipboardDocumentCheckIcon className="w-4 h-4 text-green-600" /> <span className="text-green-600 font-medium">Copied</span></>
              ) : (
                <><ClipboardIcon className="w-4 h-4" /> Copy</>
              )}
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-hidden relative bg-[#1e1e1e]">
          {loadingContent && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#1e1e1e]/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-3 text-gray-300">
                <ArrowPathIcon className="w-8 h-8 animate-spin" />
                <span className="font-medium">Loading log content...</span>
              </div>
            </div>
          )}

          {!selectedProject ? (
            <div className="absolute inset-0 flex items-center justify-center text-gray-500">
              Select a project to view logs
            </div>
          ) : !selectedLogPath && !loadingList ? (
            <div className="absolute inset-0 flex items-center justify-center text-gray-500">
              No logs found for this project
            </div>
          ) : (
            <>
              {logContent && (
                <>
                  <button
                    onClick={scrollToBottom}
                    className="absolute top-4 right-4 z-10 p-2 bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700 rounded-full shadow-lg opacity-70 hover:opacity-100 transition-opacity"
                    title="Scroll to Bottom"
                  >
                    <ArrowDownIcon className="w-5 h-5" />
                  </button>
                  <button
                    onClick={scrollToTop}
                    className="absolute bottom-4 right-4 z-10 p-2 bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700 rounded-full shadow-lg opacity-70 hover:opacity-100 transition-opacity"
                    title="Scroll to Top"
                  >
                    <ArrowUpIcon className="w-5 h-5" />
                  </button>
                  <div ref={contentRef} className="h-full w-full p-4 overflow-auto text-sm">
                    <div className="text-gray-300">{formatLogContent(logContent, selectedLogPath)}</div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
