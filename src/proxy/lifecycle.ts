/**
 * HF Proxy Lifecycle
 *
 * Start/stop/ensure the local HuggingFace proxy server.
 * PID file at ~/.steroids/proxy.pid tracks the running instance.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
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
