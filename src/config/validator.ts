/**
 * Configuration validation
 * Validates config against schema and provides helpful error messages
 */

import type { SteroidsConfig } from './loader.js';
import { CONFIG_SCHEMA, isSchemaField, type SchemaField, type SchemaObject } from './schema.js';
import type {
  GitHubIntakeConnectorConfig,
  IntakeConfig,
  SentryIntakeConnectorConfig,
} from '../intake/types.js';

export interface ValidationError {
  path: string;
  message: string;
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

/**
 * Validate a value against a schema field
 */
function validateField(
  value: unknown,
  schema: SchemaField,
  path: string
): ValidationError | null {
  // Check type
  const actualType = Array.isArray(value) ? 'array' : typeof value;

  if (schema._type === 'array' && !Array.isArray(value)) {
    return {
      path,
      message: `Expected array, got ${actualType}`,
      suggestion: `Value should be a list, e.g., ["item1", "item2"]`,
    };
  }

  if (schema._type !== 'array' && schema._type !== 'object' && actualType !== schema._type) {
    return {
      path,
      message: `Expected ${schema._type}, got ${actualType}`,
      suggestion: `Value should be a ${schema._type}`,
    };
  }

  // Check options if defined
  if (schema._options && !schema._options.includes(value as string | number | boolean)) {
    return {
      path,
      message: `Invalid value "${value}"`,
      suggestion: `Valid options: ${schema._options.join(', ')}`,
    };
  }

  return null;
}

/**
 * Recursively validate config against schema
 */
function validateObject(
  config: Record<string, unknown>,
  schema: SchemaObject,
  path: string,
  errors: ValidationError[],
  warnings: ValidationError[]
): void {
  // Check for unknown keys
  for (const key of Object.keys(config)) {
    const fullPath = path ? `${path}.${key}` : key;
    const schemaEntry = schema[key];

    if (!schemaEntry) {
      // Unknown key - add warning
      const knownKeys = Object.keys(schema).filter((k) => !k.startsWith('_'));
      const similar = knownKeys.find((k) =>
        k.toLowerCase().includes(key.toLowerCase()) ||
        key.toLowerCase().includes(k.toLowerCase())
      );

      warnings.push({
        path: fullPath,
        message: `Unknown configuration key "${key}"`,
        suggestion: similar
          ? `Did you mean "${similar}"?`
          : `Known keys: ${knownKeys.join(', ')}`,
      });
      continue;
    }

    const value = config[key];

    if (isSchemaField(schemaEntry)) {
      // Validate leaf field
      const error = validateField(value, schemaEntry, fullPath);
      if (error) {
        errors.push(error);
      }
    } else {
      // Recurse into nested object
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        validateObject(
          value as Record<string, unknown>,
          schemaEntry as SchemaObject,
          fullPath,
          errors,
          warnings
        );
      } else if (value !== undefined) {
        errors.push({
          path: fullPath,
          message: `Expected object, got ${typeof value}`,
          suggestion: `This should be a nested configuration object`,
        });
      }
    }
  }
}

function pushError(
  errors: ValidationError[],
  path: string,
  message: string,
  suggestion?: string
): void {
  errors.push({ path, message, suggestion });
}

function isBlankString(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }

  if (typeof value !== 'string') {
    return true;
  }

  return value.trim() === '';
}

function validatePositiveInteger(
  value: number | undefined,
  path: string,
  errors: ValidationError[]
): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value <= 0) {
    pushError(errors, path, 'Expected a positive integer', 'Use a whole number greater than 0');
  }
}

function validateEnabledSentryConnector(
  sentry: SentryIntakeConnectorConfig,
  errors: ValidationError[]
): void {
  if (isBlankString(sentry.baseUrl)) {
    pushError(errors, 'intake.connectors.sentry.baseUrl', 'Sentry baseUrl is required when the connector is enabled');
  }
  if (isBlankString(sentry.organization)) {
    pushError(
      errors,
      'intake.connectors.sentry.organization',
      'Sentry organization is required when the connector is enabled'
    );
  }
  if (isBlankString(sentry.project)) {
    pushError(errors, 'intake.connectors.sentry.project', 'Sentry project is required when the connector is enabled');
  }
  if (isBlankString(sentry.authTokenEnvVar)) {
    pushError(
      errors,
      'intake.connectors.sentry.authTokenEnvVar',
      'Sentry authTokenEnvVar is required when the connector is enabled'
    );
  }
}

function validateEnabledGitHubConnector(
  github: GitHubIntakeConnectorConfig,
  errors: ValidationError[]
): void {
  if (isBlankString(github.apiBaseUrl)) {
    pushError(errors, 'intake.connectors.github.apiBaseUrl', 'GitHub apiBaseUrl is required when the connector is enabled');
  }
  if (isBlankString(github.owner)) {
    pushError(errors, 'intake.connectors.github.owner', 'GitHub owner is required when the connector is enabled');
  }
  if (isBlankString(github.repo)) {
    pushError(errors, 'intake.connectors.github.repo', 'GitHub repo is required when the connector is enabled');
  }
  if (isBlankString(github.tokenEnvVar)) {
    pushError(
      errors,
      'intake.connectors.github.tokenEnvVar',
      'GitHub tokenEnvVar is required when the connector is enabled'
    );
  }
}

function validateIntakeConfig(
  intake: IntakeConfig | undefined,
  errors: ValidationError[]
): void {
  if (!intake) {
    return;
  }

  validatePositiveInteger(intake.pollIntervalMinutes, 'intake.pollIntervalMinutes', errors);
  validatePositiveInteger(intake.maxReportsPerPoll, 'intake.maxReportsPerPoll', errors);

  const sentry = intake.connectors?.sentry;
  const github = intake.connectors?.github;
  const enabledConnectorCount = [sentry?.enabled === true, github?.enabled === true].filter(Boolean).length;

  if (intake.enabled && enabledConnectorCount === 0) {
    pushError(
      errors,
      'intake.connectors',
      'At least one intake connector must be enabled when intake.enabled is true',
      'Enable intake.connectors.sentry.enabled or intake.connectors.github.enabled'
    );
  }

  if (sentry?.enabled === true) {
    validateEnabledSentryConnector(sentry, errors);
  }

  if (github?.enabled === true) {
    validateEnabledGitHubConnector(github, errors);
  }
}

/**
 * Validate configuration against schema
 */
export function validateConfig(config: Partial<SteroidsConfig>): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  validateObject(config as Record<string, unknown>, CONFIG_SCHEMA, '', errors, warnings);
  validateIntakeConfig(config.intake, errors);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Format validation results for display
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.valid && result.warnings.length === 0) {
    lines.push('Configuration is valid.');
    return lines.join('\n');
  }

  if (result.errors.length > 0) {
    lines.push('ERRORS:');
    for (const error of result.errors) {
      lines.push(`  ${error.path}: ${error.message}`);
      if (error.suggestion) {
        lines.push(`    → ${error.suggestion}`);
      }
    }
  }

  if (result.warnings.length > 0) {
    if (result.errors.length > 0) lines.push('');
    lines.push('WARNINGS:');
    for (const warning of result.warnings) {
      lines.push(`  ${warning.path}: ${warning.message}`);
      if (warning.suggestion) {
        lines.push(`    → ${warning.suggestion}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Validate a single config value
 */
export function validateValue(
  path: string,
  value: unknown
): ValidationError | null {
  const parts = path.split('.');
  let schema: SchemaField | SchemaObject | undefined = CONFIG_SCHEMA;

  for (const part of parts) {
    if (!schema || isSchemaField(schema)) {
      return {
        path,
        message: `Unknown configuration path "${path}"`,
      };
    }
    schema = (schema as SchemaObject)[part];
  }

  if (!schema || !isSchemaField(schema)) {
    return {
      path,
      message: `"${path}" is not a valid configuration key`,
    };
  }

  return validateField(value, schema, path);
}

/**
 * Parse a string value to the correct type based on schema
 */
export function parseValue(path: string, stringValue: string): unknown {
  const parts = path.split('.');
  let schema: SchemaField | SchemaObject | undefined = CONFIG_SCHEMA;

  for (const part of parts) {
    if (!schema || isSchemaField(schema)) {
      return stringValue;
    }
    schema = (schema as SchemaObject)[part];
  }

  if (!schema || !isSchemaField(schema)) {
    return stringValue;
  }

  switch (schema._type) {
    case 'boolean':
      return stringValue.toLowerCase() === 'true';
    case 'number':
      return Number(stringValue);
    case 'array':
      // Try to parse as JSON array
      try {
        return JSON.parse(stringValue);
      } catch {
        // Split by comma as fallback
        return stringValue.split(',').map((s) => s.trim());
      }
    default:
      return stringValue;
  }
}
