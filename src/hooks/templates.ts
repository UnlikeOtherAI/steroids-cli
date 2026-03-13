/**
 * Template Variable Parser
 *
 * Parses and resolves template variables in hook configurations.
 * Supports {{variable}} syntax for hook payloads and ${VAR} for environment variables.
 */

import type { HookPayload } from './payload.js';
import {
  resolveTaskVariable,
  resolveSectionVariable,
  resolveProjectVariable,
  resolveHealthVariable,
  resolveDisputeVariable,
  resolveCreditVariable,
  resolveIntakeVariable,
} from './template-resolvers.js';

/**
 * Template variable pattern: {{variable.name}}
 */
const TEMPLATE_VAR_PATTERN = /\{\{([^}]+)\}\}/g;

/**
 * Environment variable pattern: ${VAR_NAME}
 */
const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Context for template variable resolution
 */
export interface TemplateContext {
  /** Event name */
  event: string;
  /** ISO timestamp */
  timestamp: string;
  /** Task data (if task event) */
  task?: {
    id: string;
    title: string;
    status: string;
    section?: string | null;
    sectionId?: string | null;
  };
  /** Section data (if section event) */
  section?: {
    id: string;
    name: string;
  };
  /** Project data */
  project: {
    name: string;
    path: string;
  };
  /** Health data (if health event) */
  health?: {
    score: number;
    previousScore?: number;
    status: string;
  };
  /** Dispute data (if dispute event) */
  dispute?: {
    id: string;
    taskId: string;
    type: string;
    status: string;
  };
  /** Credit data (if credit event) */
  credit?: {
    provider: string;
    model: string;
    role: string;
    message: string;
  };
  /** Intake data (if intake event) */
  intake?: {
    source: string;
    externalId: string;
    url: string;
    fingerprint: string;
    title: string;
    summary?: string;
    severity: string;
    status: string;
    linkedTaskId?: string | null;
    prNumber?: number;
  };
}

/**
 * Parse template variables in a string
 *
 * @param template - String containing {{variable}} placeholders
 * @param context - Context for variable resolution
 * @returns Parsed string with variables replaced
 */
export function parseTemplate(template: string, context: TemplateContext): string {
  // First, resolve environment variables
  let result = resolveEnvVars(template);

  // Then resolve template variables
  result = result.replace(TEMPLATE_VAR_PATTERN, (match, varPath) => {
    const value = resolveVariable(varPath.trim(), context);
    return value !== undefined ? String(value) : match;
  });

  return result;
}

/**
 * Parse template variables in an object (recursively)
 *
 * @param obj - Object containing template strings
 * @param context - Context for variable resolution
 * @returns New object with templates parsed
 */
export function parseTemplateObject<T>(obj: T, context: TemplateContext): T {
  if (typeof obj === 'string') {
    return parseTemplate(obj, context) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => parseTemplateObject(item, context)) as T;
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = parseTemplateObject(value, context);
    }
    return result as T;
  }

  return obj;
}

/**
 * Resolve environment variables (${VAR_NAME})
 *
 * @param text - String containing ${VAR} placeholders
 * @returns String with env vars replaced
 */
export function resolveEnvVars(text: string): string {
  return text.replace(ENV_VAR_PATTERN, (match, varName) => {
    const envValue = process.env[varName.trim()];
    return envValue !== undefined ? envValue : match;
  });
}

/**
 * Resolve a single template variable path
 *
 * @param path - Variable path (e.g., "task.title", "project.name")
 * @param context - Template context
 * @returns Resolved value or undefined
 */
export function resolveVariable(
  path: string,
  context: TemplateContext
): string | number | boolean | undefined {
  const parts = path.split('.');

  // Meta variables (top-level)
  if (parts.length === 1) {
    switch (parts[0]) {
      case 'event':
        return context.event;
      case 'timestamp':
        return context.timestamp;
      default:
        return undefined;
    }
  }

  // Nested variables
  const [category, ...rest] = parts;

  switch (category) {
    case 'task':
      return resolveTaskVariable(rest, context.task);
    case 'section':
      return resolveSectionVariable(rest, context.section);
    case 'project':
      return resolveProjectVariable(rest, context.project);
    case 'health':
      return resolveHealthVariable(rest, context.health);
    case 'dispute':
      return resolveDisputeVariable(rest, context.dispute);
    case 'credit':
      return resolveCreditVariable(rest, context.credit);
    case 'intake':
      return resolveIntakeVariable(rest, context.intake);
    default:
      return undefined;
  }
}

/**
 * Create template context from hook payload
 *
 * @param payload - Hook event payload
 * @returns Template context for variable resolution
 */
export function createTemplateContext(payload: HookPayload): TemplateContext {
  const context: TemplateContext = {
    event: payload.event,
    timestamp: payload.timestamp,
    project: payload.project,
  };

  // Add event-specific data
  switch (payload.event) {
    case 'task.created':
    case 'task.updated':
    case 'task.completed':
    case 'task.failed':
      context.task = {
        id: payload.task.id,
        title: payload.task.title,
        status: payload.task.status,
        section: payload.task.section,
        sectionId: payload.task.sectionId,
      };
      break;

    case 'intake.received':
    case 'intake.triaged':
    case 'intake.pr_created':
      context.intake = {
        source: payload.intake.source,
        externalId: payload.intake.externalId,
        url: payload.intake.url,
        fingerprint: payload.intake.fingerprint,
        title: payload.intake.title,
        summary: payload.intake.summary,
        severity: payload.intake.severity,
        status: payload.intake.status,
        linkedTaskId: payload.intake.linkedTaskId,
        prNumber: payload.intake.prNumber,
      };
      break;

    case 'section.completed':
      context.section = {
        id: payload.section.id,
        name: payload.section.name,
      };
      break;

    case 'health.changed':
    case 'health.critical':
      context.health = {
        score: payload.health.score,
        previousScore: payload.health.previousScore,
        status: payload.health.status,
      };
      break;

    case 'dispute.created':
    case 'dispute.resolved':
      context.dispute = {
        id: payload.dispute.id,
        taskId: payload.dispute.taskId,
        type: payload.dispute.type,
        status: payload.dispute.status,
      };
      context.task = {
        id: payload.task.id,
        title: payload.task.title,
        status: payload.task.status,
        section: payload.task.section,
        sectionId: payload.task.sectionId,
      };
      break;

    case 'credit.exhausted':
    case 'credit.resolved':
      context.credit = {
        provider: payload.credit.provider,
        model: payload.credit.model,
        role: payload.credit.role,
        message: payload.credit.message,
      };
      break;
  }

  return context;
}

/**
 * Get all available variables for a given event type
 *
 * @param event - Event name
 * @returns List of available variable paths
 */
export function getAvailableVariables(event: string): string[] {
  const baseVars = ['event', 'timestamp', 'project.name', 'project.path'];

  if (event.startsWith('task.')) {
    return [
      ...baseVars,
      'task.id',
      'task.title',
      'task.status',
      'task.section',
      'task.sectionId',
    ];
  }

  if (event.startsWith('intake.')) {
    return [
      ...baseVars,
      'intake.source',
      'intake.externalId',
      'intake.url',
      'intake.fingerprint',
      'intake.title',
      'intake.summary',
      'intake.severity',
      'intake.status',
      'intake.linkedTaskId',
      'intake.prNumber',
    ];
  }

  if (event === 'section.completed') {
    return [...baseVars, 'section.id', 'section.name'];
  }

  if (event === 'project.completed') {
    return baseVars;
  }

  if (event.startsWith('health.')) {
    return [...baseVars, 'health.score', 'health.previousScore', 'health.status'];
  }

  if (event.startsWith('dispute.')) {
    return [
      ...baseVars,
      'dispute.id',
      'dispute.taskId',
      'dispute.type',
      'dispute.status',
      'task.id',
      'task.title',
      'task.status',
    ];
  }

  if (event.startsWith('credit.')) {
    return [
      ...baseVars,
      'credit.provider',
      'credit.model',
      'credit.role',
      'credit.message',
    ];
  }

  return baseVars;
}

/**
 * Validate that all template variables in a string are valid for the event
 *
 * @param template - Template string
 * @param event - Event name
 * @returns Validation result with invalid variables
 */
export function validateTemplate(
  template: string,
  event: string
): { valid: boolean; invalidVars: string[] } {
  const availableVars = getAvailableVariables(event);
  const invalidVars: string[] = [];

  const matches = template.matchAll(TEMPLATE_VAR_PATTERN);
  for (const match of matches) {
    const varPath = match[1].trim();
    if (!availableVars.includes(varPath)) {
      invalidVars.push(varPath);
    }
  }

  return {
    valid: invalidVars.length === 0,
    invalidVars,
  };
}
