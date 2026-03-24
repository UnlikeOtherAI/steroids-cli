/**
 * HF Proxy Lifecycle
 *
 * Start/stop/ensure the local HuggingFace proxy server.
 * PID file at ~/.steroids/proxy.pid tracks the running instance.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, constants as fsConstants } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHFProxy } from './hf-proxy.js';
import type http from 'node:http';

const PID_FILE = join(homedir(), '.steroids', 'proxy.pid');
const DEFAULT_PORT = 3580;

let serverInstance: http.Server | null = null;

export interface ProxyStartOptions {
  hfToken: string;
  hfBaseUrl?: string;
  port?: number;
}

export async function startProxy(options: ProxyStartOptions): Promise<{ port: number; pid: number }> {
  if (serverInstance) {
    throw new Error('Proxy already running in this process');
  }

  const port = options.port ?? DEFAULT_PORT;
  const hfBaseUrl = options.hfBaseUrl ?? 'https://router.huggingface.co/v1';

  const server = createHFProxy({ hfBaseUrl, hfToken: options.hfToken });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const actualPort = (server.address() as any).port;
  serverInstance = server;

  // Write PID file
  const pidDir = dirname(PID_FILE);
  if (!existsSync(pidDir)) mkdirSync(pidDir, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: actualPort }), 'utf-8');

  return { port: actualPort, pid: process.pid };
}

export function stopProxy(): void {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch { /* ignore */ }
}

export function isProxyRunning(): boolean {
  if (serverInstance) return true;
  if (!existsSync(PID_FILE)) return false;

  try {
    const { pid } = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
    process.kill(pid, 0); // Signal 0 = check if process exists
    return true;
  } catch {
    // Stale PID file
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return false;
  }
}

export function getProxyPort(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const { port } = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
    return port;
  } catch {
    return null;
  }
}

export async function ensureProxy(options: ProxyStartOptions): Promise<number> {
  if (isProxyRunning()) {
    return getProxyPort() ?? DEFAULT_PORT;
  }
  const { port } = await startProxy(options);
  return port;
}

/**
 * Spawn the proxy as a detached background process that survives the parent exiting.
 * Used by `steroids web` so the proxy stays alive alongside the dashboard.
 * Returns the port the proxy is listening on, or null if it couldn't start.
 */
export async function spawnProxyDaemon(options: ProxyStartOptions): Promise<number | null> {
  if (isProxyRunning()) {
    return getProxyPort();
  }

  const port = options.port ?? DEFAULT_PORT;
  const hfBaseUrl = options.hfBaseUrl ?? 'https://router.huggingface.co/v1';

  // Resolve the daemon entry script path (sibling to this file in dist/)
  const entryScript = join(__dirname, 'daemon-entry.js');
  if (!existsSync(entryScript)) return null;

  const logsDir = join(homedir(), '.steroids', 'logs');
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  const logFd = openSync(join(logsDir, 'proxy.log'), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC);

  const child = spawn('node', [entryScript], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      HF_TOKEN: options.hfToken,
      HF_BASE_URL: hfBaseUrl,
      PROXY_PORT: String(port),
    },
  });
  child.unref();

  // Wait briefly for the PID file to appear (daemon writes it on listen)
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (isProxyRunning()) return getProxyPort();
  }

  return null;
}
