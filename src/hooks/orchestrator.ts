/**
 * Hook Orchestrator
 *
 * Coordinates hook execution by:
 * 1. Loading hooks from config
 * 2. Matching events to hooks
 * 3. Executing matching hooks (script or webhook)
 * 4. Logging execution results
 * 5. Handling failures gracefully (non-blocking)
 */

import type { HookEvent } from './events.js';
import type { HookPayload } from './payload.js';
import type { HookConfig, ScriptHookYaml, WebhookHookYaml } from './merge.js';
import {
  filterHooksByEvent,
  toScriptRunnerConfig,
  toWebhookRunnerConfig,
  validateHook,
} from './merge.js';
import { executeScript, type ScriptResult } from './script-runner.js';
import { executeWebhook, type WebhookResult } from './webhook-runner.js';

/**
 * Hook execution result
 */
export interface HookExecutionResult {
  /** Hook name */
  hookName: string;
  /** Hook type */
  hookType: 'script' | 'webhook';
  /** Whether execution succeeded */
  success: boolean;
  /** Execution duration in milliseconds */
  duration: number;
  /** Error message if failed */
  error?: string;
  /** Script-specific result */
  scriptResult?: ScriptResult;
  /** Webhook-specific result */
  webhookResult?: WebhookResult;
}

/**
 * Hook orchestrator configuration
 */
export interface OrchestratorConfig {
  /** Whether to log hook execution details */
  verbose?: boolean;
  /** Whether to continue on hook failure (default true) */
  continueOnError?: boolean;
}

/**
 * Hook Orchestrator
 *
 * Manages hook lifecycle and execution
 */
export class HookOrchestrator {
  private hooks: HookConfig[] = [];
  private config: OrchestratorConfig;

  constructor(hooks: HookConfig[] = [], config: OrchestratorConfig = {}) {
    this.hooks = hooks;
    this.config = {
      verbose: config.verbose ?? false,
      continueOnError: config.continueOnError ?? true,
    };
  }

  /**
   * Load hooks from configuration
   */
  setHooks(hooks: HookConfig[]): void {
    this.hooks = hooks;
  }

  /**
   * Get all loaded hooks
   */
  getHooks(): HookConfig[] {
    return [...this.hooks];
  }

  /**
   * Get hooks for a specific event
   */
  getHooksForEvent(event: HookEvent): HookConfig[] {
    return filterHooksByEvent(this.hooks, event);
  }

  /**
   * Execute all hooks for an event
   *
   * @param event - Event name
   * @param payload - Event payload
   * @returns Array of execution results
   */
  async executeHooksForEvent(event: HookEvent, payload: HookPayload): Promise<HookExecutionResult[]> {
    const matchingHooks = this.getHooksForEvent(event);

    if (matchingHooks.length === 0) {
      return [];
    }

    if (this.config.verbose) {
      console.log(`[Hooks] Executing ${matchingHooks.length} hook(s) for event: ${event}`);
    }

    const results: HookExecutionResult[] = [];

    for (const hook of matchingHooks) {
      try {
        // Validate hook configuration
        const validation = validateHook(hook);
        if (!validation.valid) {
          const error = `Invalid hook configuration: ${validation.errors.join(', ')}`;
          results.push({
            hookName: hook.name,
            hookType: hook.type,
            success: false,
            duration: 0,
            error,
          });

          if (this.config.verbose) {
            console.error(`[Hooks] ${hook.name}: ${error}`);
          }

          if (!this.config.continueOnError) {
            break;
          }
          continue;
        }

        // Execute hook based on type
        const result = await this.executeHook(hook, payload);
        results.push(result);

        if (this.config.verbose) {
          if (result.success) {
            console.log(`[Hooks] ${hook.name}: ✓ Success (${result.duration}ms)`);
          } else {
            console.error(`[Hooks] ${hook.name}: ✗ Failed - ${result.error}`);
          }
        }

        // Stop if continueOnError is false and hook failed
        if (!result.success && !this.config.continueOnError) {
          break;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          hookName: hook.name,
          hookType: hook.type,
          success: false,
          duration: 0,
          error: errorMsg,
        });

        if (this.config.verbose) {
          console.error(`[Hooks] ${hook.name}: ✗ Exception - ${errorMsg}`);
        }

        if (!this.config.continueOnError) {
          break;
        }
      }
    }

    return results;
  }

  /**
   * Execute a single hook
   */
  private async executeHook(hook: HookConfig, payload: HookPayload): Promise<HookExecutionResult> {
    if (hook.type === 'script') {
      return this.executeScriptHook(hook as ScriptHookYaml, payload);
    } else if (hook.type === 'webhook') {
      return this.executeWebhookHook(hook as WebhookHookYaml, payload);
    }

    // This should never happen due to TypeScript's discriminated union
    const _exhaustive: never = hook;
    return {
      hookName: (hook as HookConfig).name,
      hookType: (hook as HookConfig).type,
      success: false,
      duration: 0,
      error: `Unknown hook type: ${(hook as HookConfig).type}`,
    };
  }

  /**
   * Execute a script hook
   */
  private async executeScriptHook(
    hook: ScriptHookYaml,
    payload: HookPayload
  ): Promise<HookExecutionResult> {
    const config = toScriptRunnerConfig(hook);
    const scriptResult = await executeScript(config, payload);

    return {
      hookName: hook.name,
      hookType: 'script',
      success: scriptResult.success,
      duration: scriptResult.duration,
      error: scriptResult.error,
      scriptResult,
    };
  }

  /**
   * Execute a webhook hook
   */
  private async executeWebhookHook(
    hook: WebhookHookYaml,
    payload: HookPayload
  ): Promise<HookExecutionResult> {
    const config = toWebhookRunnerConfig(hook);
    const webhookResult = await executeWebhook(config, payload);

    return {
      hookName: hook.name,
      hookType: 'webhook',
      success: webhookResult.success,
      duration: webhookResult.duration,
      error: webhookResult.error,
      webhookResult,
    };
  }

  /**
   * Validate all loaded hooks
   *
   * @returns Validation results for each hook
   */
  validateAllHooks(): Array<{ hook: string; valid: boolean; errors: string[] }> {
    return this.hooks.map((hook) => {
      const validation = validateHook(hook);
      return {
        hook: hook.name,
        valid: validation.valid,
        errors: validation.errors,
      };
    });
  }

  /**
   * Get statistics about loaded hooks
   */
  getStats(): {
    total: number;
    enabled: number;
    disabled: number;
    byType: Record<string, number>;
    byEvent: Record<string, number>;
  } {
    const stats = {
      total: this.hooks.length,
      enabled: 0,
      disabled: 0,
      byType: {} as Record<string, number>,
      byEvent: {} as Record<string, number>,
    };

    for (const hook of this.hooks) {
      if (hook.enabled === false) {
        stats.disabled++;
      } else {
        stats.enabled++;
      }

      stats.byType[hook.type] = (stats.byType[hook.type] || 0) + 1;
      stats.byEvent[hook.event] = (stats.byEvent[hook.event] || 0) + 1;
    }

    return stats;
  }
}

/**
 * Create a hook orchestrator from global and project hooks
 *
 * @param globalHooks - Hooks from ~/.steroids/config.yaml
 * @param projectHooks - Hooks from .steroids/config.yaml
 * @param config - Orchestrator configuration
 * @returns Configured hook orchestrator
 */
export function createOrchestrator(
  globalHooks: HookConfig[],
  projectHooks: HookConfig[],
  config?: OrchestratorConfig
): HookOrchestrator {
  const { mergeHooks } = require('./merge.js');
  const merged = mergeHooks(globalHooks, projectHooks);
  return new HookOrchestrator(merged, config);
}
