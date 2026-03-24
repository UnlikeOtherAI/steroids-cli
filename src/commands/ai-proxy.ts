/**
 * steroids ai proxy - Manage the HuggingFace model proxy
 */

import { parseArgs } from 'node:util';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { generateHelp } from '../cli/help.js';
import { startProxy, stopProxy, isProxyRunning, getProxyPort } from '../proxy/lifecycle.js';
import { resolveHFToken } from '../proxy/hf-token.js';

const HELP = generateHelp({
  command: 'ai proxy',
  description: 'Manage the HuggingFace model proxy',
  usage: ['steroids ai proxy <start|stop|status>'],
  subcommands: [
    { name: 'start', description: 'Start the proxy server' },
    { name: 'stop', description: 'Stop the proxy server' },
    { name: 'status', description: 'Show proxy status' },
  ],
  examples: [
    { command: 'steroids ai proxy start', description: 'Start HF proxy on default port' },
    { command: 'steroids ai proxy status', description: 'Check if proxy is running' },
  ],
  showEnvVars: false,
  showExitCodes: false,
});

export async function proxySubcommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'ai proxy', flags });

  const { positionals } = parseArgs({
    args,
    options: { help: { type: 'boolean', short: 'h', default: false } },
    allowPositionals: true,
  });

  if (flags.help || positionals.length === 0) {
    out.log(HELP);
    return;
  }

  switch (positionals[0]) {
    case 'start': {
      if (isProxyRunning()) {
        const port = getProxyPort();
        out.log(`Proxy already running on port ${port}`);
        return;
      }
      const token = resolveHFToken();
      if (!token) {
        out.error('CONFIGURATION_ERROR', 'No HuggingFace token found. Set HF_TOKEN or configure opencode.json.');
        process.exit(3);
      }
      const { port } = await startProxy({ hfToken: token });
      out.log(`HF proxy started on http://127.0.0.1:${port}`);
      break;
    }
    case 'stop':
      if (!isProxyRunning()) {
        out.log('Proxy is not running');
        return;
      }
      stopProxy();
      out.log('Proxy stopped');
      break;
    case 'status': {
      const running = isProxyRunning();
      const port = getProxyPort();
      if (flags.json) {
        out.success({ running, port });
      } else {
        out.log(`Proxy: ${running ? `running on port ${port}` : 'stopped'}`);
      }
      break;
    }
    default:
      out.error('INVALID_ARGUMENTS', `Unknown subcommand: ${positionals[0]}`);
      process.exit(2);
  }
}
