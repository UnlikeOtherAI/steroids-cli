/**
 * JSON schema validation for orchestrator outputs
 */

import Ajv from 'ajv';

const coderSchema = {
  type: 'object',
  required: ['action', 'reasoning', 'next_status'],
  properties: {
    action: {
      type: 'string',
      enum: ['submit', 'retry', 'stage_commit_submit', 'error']
    },
    reasoning: { type: 'string', minLength: 5, maxLength: 1000 },
    commits: {
      oneOf: [
        { type: 'array', items: { type: 'string' } },
        { type: 'null' }
      ]
    },
    commit_message: {
      oneOf: [
        { type: 'string', maxLength: 500 },
        { type: 'null' }
      ]
    },
    contract_violation: {
      oneOf: [
        { type: 'string', enum: ['checklist_required', 'rejection_response_required'] },
        { type: 'null' }
      ]
    },
    wont_fix_override_items: {
      oneOf: [
        { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 } },
        { type: 'null' }
      ]
    },
    next_status: {
      type: 'string',
      enum: ['review', 'in_progress', 'failed']
    },
    files_changed: { type: 'number', minimum: 0 },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    exit_clean: { type: 'boolean' },
    has_commits: { type: 'boolean' }
  }
};

const reviewerSchema = {
  type: 'object',
  required: ['decision', 'reasoning', 'next_status'],
  properties: {
    decision: {
      type: 'string',
      enum: ['approve', 'reject', 'dispute', 'skip', 'unclear']
    },
    reasoning: { type: 'string', minLength: 5 },
    notes: {
      oneOf: [
        { type: 'string' },
        { type: 'null' }
      ]
    },
    follow_up_tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'description'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' }
        }
      }
    },
    next_status: {
      type: 'string',
      enum: ['completed', 'in_progress', 'disputed', 'skipped', 'review']
    },
    rejection_count: { type: 'number', minimum: 0 },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    push_to_remote: { type: 'boolean' },
    repeated_issue: {
      oneOf: [
        { type: 'boolean' },
        { type: 'null' }
      ]
    }
  }
};

const ajv = new Ajv({ allErrors: true });

export const validateCoderResult = ajv.compile(coderSchema);
export const validateReviewerResult = ajv.compile(reviewerSchema);

/**
 * Normalize confidence value to lowercase and strict booleans, and flatten metadata
 */
export function normalizeData(data: any): any {
  if (typeof data !== 'object' || data === null) return data;
  
  const result = { ...data };
  
  // Flatten legacy metadata object if LLM still generates it
  if (result.metadata && typeof result.metadata === 'object') {
    Object.assign(result, result.metadata);
    delete result.metadata;
  }
  
  // Safe defaults for required fields if missing
  if (result.confidence === undefined) result.confidence = 'medium';
  if (result.files_changed === undefined) result.files_changed = 0;
  if (result.rejection_count === undefined) result.rejection_count = 0;
  
  // Normalize confidence
  if (typeof result.confidence === 'string') {
    const confidence = result.confidence.trim().toLowerCase();
    if (['high', 'medium', 'low'].includes(confidence)) {
      result.confidence = confidence;
    }
  }
  
  // Normalize booleans
  const boolFields = ['exit_clean', 'has_commits', 'push_to_remote', 'repeated_issue'];
  for (const field of boolFields) {
    if (typeof result[field] === 'string') {
      const val = result[field].trim().toLowerCase();
      if (val === 'true') result[field] = true;
      if (val === 'false') result[field] = false;
    }
    // Safe boolean defaults
    if (result[field] === undefined) {
      if (field === 'push_to_remote') result[field] = false;
      if (field === 'repeated_issue') result[field] = false;
    }
  }
  
  return result;
}

export interface ValidationResult {
  valid: boolean;
  data: any;
}

/**
 * Validate coder result with error logging
 */
export function validateCoderResultWithLogging(data: any): ValidationResult {
  const normalizedData = normalizeData(data);
  const isValid = validateCoderResult(normalizedData);
  if (!isValid && validateCoderResult.errors) {
    console.warn('[Orchestrator] Coder validation failed:', validateCoderResult.errors);
  }
  return { valid: isValid, data: normalizedData };
}

/**
 * Validate reviewer result with error logging
 */
export function validateReviewerResultWithLogging(data: any): ValidationResult {
  const normalizedData = normalizeData(data);
  const isValid = validateReviewerResult(normalizedData);
  if (!isValid && validateReviewerResult.errors) {
    console.warn('[Orchestrator] Reviewer validation failed:', validateReviewerResult.errors);
  }
  return { valid: isValid, data: normalizedData };
}
