/**
 * JSON Schema converter
 * Converts internal SchemaObject format to standard JSON Schema
 */

import { CONFIG_SCHEMA, isSchemaField, type SchemaField, type SchemaObject } from './schema.js';

export interface JSONSchema {
  $schema?: string;
  type: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  enum?: (string | number | boolean)[];
  default?: unknown;
  required?: string[];
}

/**
 * Convert a SchemaField to JSON Schema format
 */
function fieldToJsonSchema(field: SchemaField): JSONSchema {
  const result: JSONSchema = {
    type: field._type,
    description: field._description,
  };

  if (field._options && field._options.length > 0) {
    result.enum = [...field._options];
  }

  if (field._default !== undefined) {
    result.default = field._default;
  }

  return result;
}

/**
 * Convert a SchemaObject (possibly nested) to JSON Schema format
 */
function objectToJsonSchema(obj: SchemaObject): JSONSchema {
  const result: JSONSchema = {
    type: 'object',
    properties: {},
  };

  // Get description if present
  if ('_description' in obj) {
    result.description = (obj as unknown as { _description: string })._description;
  }

  // Process all non-meta keys
  for (const key of Object.keys(obj)) {
    if (key.startsWith('_')) continue;

    const value = obj[key];
    if (isSchemaField(value)) {
      result.properties![key] = fieldToJsonSchema(value);
    } else {
      result.properties![key] = objectToJsonSchema(value as SchemaObject);
    }
  }

  return result;
}

/**
 * Convert the full CONFIG_SCHEMA to JSON Schema format
 */
export function toJsonSchema(schema?: SchemaObject): JSONSchema {
  const source = schema ?? CONFIG_SCHEMA;
  const result = objectToJsonSchema(source);

  // Add $schema for the full schema
  if (!schema) {
    result.$schema = 'https://json-schema.org/draft/2020-12/schema';
  }

  return result;
}

/**
 * Get JSON Schema for a specific category
 */
export function getCategoryJsonSchema(category: string): JSONSchema | null {
  const categorySchema = CONFIG_SCHEMA[category];
  if (!categorySchema) {
    return null;
  }

  if (isSchemaField(categorySchema)) {
    return fieldToJsonSchema(categorySchema);
  }

  return objectToJsonSchema(categorySchema as SchemaObject);
}

/**
 * Get all category names from the schema
 */
export function getSchemaCategories(): string[] {
  return Object.keys(CONFIG_SCHEMA).filter(k => !k.startsWith('_'));
}
