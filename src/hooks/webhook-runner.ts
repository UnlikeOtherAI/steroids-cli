/**
 * Webhook Hook Runner
 *
 * Sends HTTP requests as hooks with retry support.
 * Handles templated URLs, headers, and body content.
 */

import type { HookPayload } from './payload.js';
import { parseTemplate, parseTemplateObject, createTemplateContext } from './templates.js';

/**
 * HTTP methods supported by webhooks
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Webhook hook configuration
 */
export interface WebhookHookConfig {
  /** Hook name (for logging) */
  name: string;
  /** Webhook URL (supports templates) */
  url: string;
  /** HTTP method (default POST) */
  method?: HttpMethod;
  /** HTTP headers (supports templates and env vars) */
  headers?: Record<string, string>;
  /** Request body (supports templates and env vars) */
  body?: Record<string, unknown> | string;
  /** Timeout in seconds (default 30) */
  timeout?: number;
  /** Number of retries on failure (default 0) */
  retry?: number;
}

/**
 * Webhook execution result
 */
export interface WebhookResult {
  /** Whether execution was successful */
  success: boolean;
  /** HTTP status code */
  statusCode: number | null;
  /** Response body */
  responseBody: string;
  /** Execution time in milliseconds */
  duration: number;
  /** Number of retry attempts made */
  retries: number;
  /** Error message if failed */
  error?: string;
  /** Whether request timed out */
  timedOut?: boolean;
}

/**
 * Parse timeout string (e.g., "30s", "5m") to milliseconds
 */
export function parseTimeout(timeout: string | number | undefined): number {
  if (timeout === undefined) {
    return 30000; // 30 seconds default
  }

  if (typeof timeout === 'number') {
    return timeout * 1000; // Convert seconds to ms
  }

  const match = timeout.match(/^(\d+)(s|m|h)?$/);
  if (!match) {
    throw new Error(`Invalid timeout format: ${timeout}. Use format like "30s", "5m", "1h"`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2] || 's';

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    default:
      return 30000;
  }
}

/**
 * Execute a webhook hook
 *
 * @param config - Webhook hook configuration
 * @param payload - Hook event payload for template resolution
 * @returns Promise resolving to webhook result
 */
export async function executeWebhook(
  config: WebhookHookConfig,
  payload: HookPayload
): Promise<WebhookResult> {
  const startTime = Date.now();
  const maxRetries = config.retry ?? 0;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await executeWebhookOnce(config, payload, startTime);

      // Success - return result
      if (result.success) {
        return { ...result, retries: attempt };
      }

      // Failed but might retry
      lastError = result.error;

      // Don't retry on client errors (4xx)
      if (result.statusCode && result.statusCode >= 400 && result.statusCode < 500) {
        return { ...result, retries: attempt };
      }

      // Wait before retry (exponential backoff)
      if (attempt < maxRetries) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 10000));
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);

      // Wait before retry
      if (attempt < maxRetries) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 10000));
      }
    }
  }

  // All retries exhausted
  return {
    success: false,
    statusCode: null,
    responseBody: '',
    duration: Date.now() - startTime,
    retries: maxRetries,
    error: lastError || 'Unknown error',
  };
}

/**
 * Execute webhook once (single attempt)
 */
async function executeWebhookOnce(
  config: WebhookHookConfig,
  payload: HookPayload,
  startTime: number
): Promise<WebhookResult> {
  try {
    // Create template context from payload
    const context = createTemplateContext(payload);

    // Parse URL (resolve templates and env vars)
    const url = parseTemplate(config.url, context);

    // Parse headers
    const headers = config.headers
      ? parseTemplateObject(config.headers, context)
      : {};

    // Parse body
    let body: string | undefined;
    if (config.body) {
      if (typeof config.body === 'string') {
        body = parseTemplate(config.body, context);
      } else {
        const parsedBody = parseTemplateObject(config.body, context);
        body = JSON.stringify(parsedBody);

        // Add content-type header if not present
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    // Parse timeout
    const timeoutMs = parseTimeout(config.timeout);

    // Make request with timeout
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: config.method || 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutHandle);

      const responseBody = await response.text();
      const success = response.ok; // 2xx status codes

      return {
        success,
        statusCode: response.status,
        responseBody,
        duration: Date.now() - startTime,
        retries: 0,
        error: !success ? `HTTP ${response.status}: ${response.statusText}` : undefined,
      };
    } catch (error) {
      clearTimeout(timeoutHandle);

      // Check if it was a timeout
      const timedOut = error instanceof Error && error.name === 'AbortError';

      return {
        success: false,
        statusCode: null,
        responseBody: '',
        duration: Date.now() - startTime,
        retries: 0,
        timedOut,
        error: timedOut
          ? `Request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error),
      };
    }
  } catch (error) {
    return {
      success: false,
      statusCode: null,
      responseBody: '',
      duration: Date.now() - startTime,
      retries: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate webhook hook configuration
 */
export function validateWebhookConfig(config: WebhookHookConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.name) {
    errors.push('Missing required field: name');
  }

  if (!config.url) {
    errors.push('Missing required field: url');
  }

  if (config.method) {
    const validMethods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    if (!validMethods.includes(config.method)) {
      errors.push(`Invalid HTTP method: ${config.method}. Must be one of: ${validMethods.join(', ')}`);
    }
  }

  if (config.timeout !== undefined) {
    try {
      parseTimeout(config.timeout);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (config.retry !== undefined && (config.retry < 0 || config.retry > 10)) {
    errors.push('Retry count must be between 0 and 10');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
