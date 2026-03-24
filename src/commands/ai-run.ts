/**
 * steroids ai run - Run a single agent invocation for debugging
 *
 * Dispatches one agent (coder, reviewer, orchestrator, first-responder) with a
 * user-supplied prompt against any provider/model, pointed at any directory.
 * Streams output to stdout. No loop, no DB writes, no task management.
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GlobalFlags } from '../cli/flags.js';
import { parseDuration } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { colors, markers } from '../cli/colors.js';
import { generateHelp } from '../cli/help.js';
import { getProviderRegistry } from '../providers/registry.js';
import { loadConfig } from '../config/loader.js';

const VALID_ROLES = ['coder', 'reviewer', 'orchestrator', 'first-responder'] as const;
type RunRole = (typeof VALID_ROLES)[number];

const HELP = generateHelp({
  command: 'ai run',
  description: 'Run a single agent invocation for debugging',
  details: `Dispatches one agent with a prompt against any provider/model combination,
pointed at any directory. Streams output to stdout.
No loop, no DB writes, no task management — pure agent invocation.`,
  usage: [
    'steroids ai run <role> --prompt "..." [options]',
    'steroids ai run <role> --prompt-file <path> [options]',
  ],
  subcommands: [
    { name: 'coder', description: 'Run the coder agent' },
    { name: 'reviewer', description: 'Run the reviewer agent' },
    { name: 'orchestrator', description: 'Run the orchestrator agent' },
    { name: 'first-responder', description: 'Run the first-responder agent' },
  ],
  options: [
    { short: 'p', long: 'prompt', description: 'Prompt text to send to the agent', values: '<text>' },
    { long: 'prompt-file', description: 'Path to a file containing the prompt', values: '<path>' },
    { long: 'provider', description: 'Provider name (claude, gemini, codex, mistral, opencode)', values: '<name>' },
    { long: 'model', description: 'Model identifier', values: '<id>' },
    { long: 'cwd', description: 'Working directory for the agent (default: current dir)', values: '<path>' },
    { short: 't', long: 'invoke-timeout', description: 'Invocation timeout (default: 15m)', values: '<duration>' },
    { long: 'no-stream', description: 'Suppress streaming output; print result at end' },
    { long: 'template', description: 'Custom invocation template override', values: '<template>' },
  ],
  examples: [
    { command: 'steroids ai run coder -p "Add a health check endpoint"', description: 'Run coder with inline prompt' },
    { command: 'steroids ai run reviewer --prompt-file review.txt --cwd /path/to/project', description: 'Run reviewer from file' },
    { command: 'steroids ai run coder -p "Fix the bug" --provider gemini --model gemini-2.5-pro', description: 'Use specific provider/model' },
    { command: 'steroids ai run first-responder -p "Diagnose stuck tasks" --provider claude', description: 'Run first-responder' },
    { command: 'steroids ai run coder -p "Fix it" -t 5m', description: 'Run with 5-minute timeout' },
  ],
  sections: [
    {
      title: 'ROLE DEFAULTS',
      content: `Each role uses its configured provider/model from steroids config unless
overridden with --provider and --model. Use "steroids config show ai" to see
current configuration.`,
    },
  ],
  showEnvVars: false,
  showExitCodes: true,
});

function resolveRoleConfig(role: RunRole, config: ReturnType<typeof loadConfig>): { provider?: string; model?: string } {
  const roleKey = role === 'first-responder' ? 'orchestrator' : role;
  const roleConfig = config.ai?.[roleKey as 'orchestrator' | 'coder' | 'reviewer'];
  return { provider: roleConfig?.provider, model: roleConfig?.model };
}

export async function runSubcommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'ai run', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      prompt: { type: 'string', short: 'p' },
      'prompt-file': { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      cwd: { type: 'string' },
      'invoke-timeout': { type: 'string', short: 't' },
      'no-stream': { type: 'boolean', default: false },
      template: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help || positionals.length === 0) {
    out.log(HELP);
    return;
  }

  // --- Validate role ---
  const role = positionals[0] as RunRole;
  if (!VALID_ROLES.includes(role)) {
    out.error('INVALID_ARGUMENTS', `Unknown role: ${role}`);
    out.log(`Valid roles: ${VALID_ROLES.join(', ')}`);
    process.exit(2);
  }

  // --- Resolve prompt ---
  let prompt: string | undefined;
  if (values.prompt) {
    prompt = values.prompt;
  } else if (values['prompt-file']) {
    const promptPath = resolve(values['prompt-file']);
    if (!existsSync(promptPath)) {
      out.error('NOT_FOUND', `Prompt file not found: ${promptPath}`);
      process.exit(4);
    }
    prompt = readFileSync(promptPath, 'utf-8');
  }

  if (!prompt || prompt.trim().length === 0) {
    out.error('INVALID_ARGUMENTS', 'A prompt is required. Use --prompt or --prompt-file.');
    process.exit(2);
  }

  // --- Resolve provider/model ---
  const config = loadConfig();
  const defaults = resolveRoleConfig(role, config);
  const providerName = (values.provider ?? defaults.provider) as string | undefined;
  const modelName = values.model ?? defaults.model;

  if (!providerName) {
    out.error('CONFIGURATION_ERROR', `No provider configured for role: ${role}. Use --provider or run "steroids ai setup".`);
    process.exit(3);
  }
  if (!modelName) {
    out.error('CONFIGURATION_ERROR', `No model configured for role: ${role}. Use --model or run "steroids ai setup".`);
    process.exit(3);
  }

  // --- Resolve working directory ---
  const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
  if (!existsSync(cwd)) {
    out.error('NOT_FOUND', `Working directory not found: ${cwd}`);
    process.exit(4);
  }

  // --- Resolve timeout: --invoke-timeout flag, then global --timeout, then default ---
  let timeoutMs = 15 * 60 * 1000; // 15 minutes default
  if (values['invoke-timeout']) {
    timeoutMs = parseDuration(values['invoke-timeout']);
  } else if (flags.timeout) {
    timeoutMs = flags.timeout;
  }

  const streamOutput = !values['no-stream'];

  // --- Get provider ---
  const registry = await getProviderRegistry();
  const provider = registry.tryGet(providerName);
  if (!provider) {
    out.error('CONFIGURATION_ERROR', `Unknown provider: ${providerName}`);
    const names = registry.getNames();
    out.log(`Available providers: ${names.join(', ')}`);
    process.exit(3);
  }

  if (!(await provider.isAvailable())) {
    out.error('CONFIGURATION_ERROR', `Provider CLI not available: ${providerName}`);
    out.log(`Install the ${providerName} CLI to use this provider.`);
    process.exit(3);
  }

  // --- Apply template override ---
  if (values.template) {
    provider.setInvocationTemplate(values.template);
  }

  // --- Show invocation info ---
  if (!flags.quiet) {
    out.log('');
    out.log(colors.bold('Agent Invocation'));
    out.log(`  Role:      ${colors.cyan(role)}`);
    out.log(`  Provider:  ${colors.cyan(providerName)}`);
    out.log(`  Model:     ${colors.cyan(modelName)}`);
    out.log(`  CWD:       ${colors.cyan(cwd)}`);
    out.log(`  Timeout:   ${colors.cyan(`${Math.round(timeoutMs / 1000)}s`)}`);
    out.log(`  Stream:    ${streamOutput ? 'yes' : 'no'}`);
    out.log('');
    out.log(colors.dim('─'.repeat(60)));
    out.log('');
  }

  // --- Write prompt to temp file ---
  const promptFile = join(tmpdir(), `steroids-ai-run-${Date.now()}.txt`);
  writeFileSync(promptFile, prompt, 'utf-8');

  try {
    const startMs = Date.now();

    const result = await provider.invoke(prompt, {
      model: modelName,
      timeout: timeoutMs,
      cwd,
      promptFile,
      role: role === 'first-responder' ? 'orchestrator' : role,
      streamOutput,
    });

    const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);

    if (!flags.quiet) {
      out.log('');
      out.log(colors.dim('─'.repeat(60)));
      out.log('');
    }

    // --- Print result summary ---
    if (flags.json) {
      out.success({
        role,
        provider: providerName,
        model: modelName,
        cwd,
        success: result.success,
        exitCode: result.exitCode,
        duration: result.duration,
        timedOut: result.timedOut,
        sessionId: result.sessionId ?? null,
        tokenUsage: result.tokenUsage ?? null,
        stdout: result.stdout,
        stderr: result.stderr || null,
      });
      return;
    }

    // Non-streaming: print the output now
    if (!streamOutput && result.stdout) {
      out.log(result.stdout);
      out.log('');
    }

    // Summary
    const statusIcon = result.success ? markers.success('') : markers.error('');
    out.log(`${statusIcon} ${result.success ? 'Completed' : 'Failed'} in ${durationSec}s (exit ${result.exitCode})`);

    if (result.timedOut) {
      out.log(markers.warning('Invocation timed out'));
    }

    if (result.tokenUsage) {
      const usage = result.tokenUsage;
      const parts: string[] = [];
      if (usage.inputTokens) parts.push(`in: ${usage.inputTokens.toLocaleString()}`);
      if (usage.outputTokens) parts.push(`out: ${usage.outputTokens.toLocaleString()}`);
      if (usage.totalCostUsd !== undefined) parts.push(`cost: $${usage.totalCostUsd.toFixed(4)}`);
      if (parts.length > 0) {
        out.log(`  Tokens: ${parts.join(', ')}`);
      }
    }

    if (result.sessionId) {
      out.log(`  Session: ${result.sessionId}`);
    }

    if (result.stderr && !result.success) {
      out.log('');
      out.log(colors.red('stderr:'));
      out.log(result.stderr.slice(0, 2000));
    }

    out.log('');

    if (!result.success) {
      process.exit(1);
    }
  } finally {
    try { unlinkSync(promptFile); } catch {}
  }
}
