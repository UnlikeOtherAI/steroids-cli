/**
 * HF Proxy Daemon Entry Point
 *
 * Standalone script spawned as a detached child process.
 * Reads HF_TOKEN and optional HF_BASE_URL / PROXY_PORT from env,
 * starts the proxy server, and stays alive until killed.
 */

import { createHFProxy } from './hf-proxy.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const PID_FILE = join(homedir(), '.steroids', 'proxy.pid');

const hfToken = process.env.HF_TOKEN;
if (!hfToken) {
  process.exit(1);
}

const hfBaseUrl = process.env.HF_BASE_URL ?? 'https://router.huggingface.co/v1';
const port = parseInt(process.env.PROXY_PORT ?? '3580', 10);

const server = createHFProxy({ hfBaseUrl, hfToken });

server.listen(port, '127.0.0.1', () => {
  const actualPort = (server.address() as any).port;

  // Write PID file so lifecycle.ts can detect us
  const pidDir = dirname(PID_FILE);
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: actualPort }), 'utf-8');
});
