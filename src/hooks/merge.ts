/**
 * Hook Configuration Merge
 *
 * Merges global hooks (~/.steroids/config.yaml) with project hooks (.steroids/config.yaml).
 * Project hooks can override global hooks by name or disable them with enabled: false.
 */

import type { HookEvent } from './events.js';
import type { ScriptHookConfig } from './script-runner.js';
import type { WebhookHookConfig } from './webhook-runner.js';

/**
 * Hook type discriminator
 */
export type HookType = 'script' | 'webhook';

/**
 * Base hook configuration (common fields)
 */
export interface BaseHookConfig {
  /** Unique hook name */
  name: string;
  /** Event that triggers this hook */
  event: HookEvent;
  /** Hook type */
  type: HookType;
  /** Enable/disable this hook */
  enabled?: boolean;
}

/**
 * Script hook configuration (from config.yaml)
 */
export interface ScriptHookYaml extends BaseHookConfig {
  type: 'script';
  command: string;
  args?: string[];
  cwd?: string;
  timeout?: number | string;
  async?: boolean;
}

/**
 * Webhook hook configuration (from config.yaml)
 */
export interface WebhookHookYaml extends BaseHookConfig {
  type: 'webhook';
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: Record<string, unknown> | string;
  timeout?: number | string;
  retry?: number;
}

/**
 * Union of all hook configurations
 */
export type HookConfig = ScriptHookYaml | WebhookHookYaml;

/**
 * Merge global and project hooks
 *
 * Rules:
 * 1. Project hooks with same name as global hooks override them completely
 * 2. Project hooks with enabled: false disable global hooks with same name
 * 3. All other hooks are included
 *
 * @param globalHooks - Hooks from ~/.steroids/config.yaml
 * @param projectHooks - Hooks from .steroids/config.yaml
 * @returns Merged list of enabled hooks
 */
export function mergeHooks(
  globalHooks: HookConfig[] = [],
  projectHooks: HookConfig[] = []
): HookConfig[] {
  const merged = new Map<string, HookConfig>();

  // Add all global hooks first
  for (const hook of globalHooks) {
    if (hook.enabled !== false) {
      merged.set(hook.name, hook);
    }
  }

  // Process project hooks
  for (const hook of projectHooks) {
    if (hook.enabled === false) {
      // Explicitly disabled - remove from merged
      merged.delete(hook.name);
    } else {
      // Override global hook with same name, or add new hook
      merged.set(hook.name, hook);
    }
  }

  return Array.from(merged.values());
}

/**
 * Filter hooks by event
 *
 * @param hooks - List of hooks
 * @param event - Event name to filter by
 * @returns Hooks matching the event
 */
export function filterHooksByEvent(hooks: HookConfig[], event: HookEvent): HookConfig[] {
  return hooks.filter((hook) => hook.event === event && hook.enabled !== false);
}

/**
 * Find hook by name
 *
 * @param hooks - List of hooks
 * @param name - Hook name
 * @returns Hook if found, undefined otherwise
 */
export function findHookByName(hooks: HookConfig[], name: string): HookConfig | undefined {
  return hooks.find((hook) => hook.name === name);
}

/**
 * Validate hook configuration
 *
 * @param hook - Hook configuration
 * @returns Validation result with errors
 */
export function validateHook(hook: HookConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!hook.name) {
    errors.push('Missing required field: name');
  }

  if (!hook.event) {
    errors.push('Missing required field: event');
  }

  if (!hook.type) {
    errors.push('Missing required field: type');
  }

  if (hook.type === 'script') {
    if (!(hook as ScriptHookYaml).command) {
      errors.push('Missing required field for script hook: command');
    }
  }

  if (hook.type === 'webhook') {
    if (!(hook as WebhookHookYaml).url) {
      errors.push('Missing required field for webhook hook: url');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Convert script hook config from YAML format to runner format
 */
export function toScriptRunnerConfig(hook: ScriptHookYaml): ScriptHookConfig {
  return {
    name: hook.name,
    command: hook.command,
    args: hook.args,
    cwd: hook.cwd,
    timeout: hook.timeout,
    async: hook.async,
  };
}

/**
 * Convert webhook hook config from YAML format to runner format
 */
export function toWebhookRunnerConfig(hook: WebhookHookYaml): WebhookHookConfig {
  return {
    name: hook.name,
    url: hook.url,
    method: hook.method,
    headers: hook.headers,
    body: hook.body,
    timeout: hook.timeout as number | undefined,
    retry: hook.retry,
  };
}

/**
 * Group hooks by event
 *
 * @param hooks - List of hooks
 * @returns Map of event -> hooks
 */
export function groupHooksByEvent(hooks: HookConfig[]): Map<HookEvent, HookConfig[]> {
  const grouped = new Map<HookEvent, HookConfig[]>();

  for (const hook of hooks) {
    if (hook.enabled === false) continue;

    const existing = grouped.get(hook.event) || [];
    existing.push(hook);
    grouped.set(hook.event, existing);
  }

  return grouped;
}

/**
 * Get all unique events that have hooks registered
 *
 * @param hooks - List of hooks
 * @returns Array of unique event names
 */
export function getEventsWithHooks(hooks: HookConfig[]): HookEvent[] {
  const events = new Set<HookEvent>();

  for (const hook of hooks) {
    if (hook.enabled !== false) {
      events.add(hook.event);
    }
  }

  return Array.from(events);
}
