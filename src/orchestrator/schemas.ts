/**
 * JSON schema validation for orchestrator outputs
 */

import Ajv from 'ajv';

const coderSchema = {
  type: 'object',
  required: ['action', 'reasoning', 'next_status', 'metadata'],
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
    next_status: {
      type: 'string',
      enum: ['review', 'in_progress', 'failed']
    },
    metadata: {
      type: 'object',
      required: ['files_changed', 'confidence', 'exit_clean', 'has_commits'],
      properties: {
        files_changed: { type: 'number', minimum: 0 },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        exit_clean: { type: 'boolean' },
        has_commits: { type: 'boolean' }
      }
    }
  }
};

const reviewerSchema = {
  type: 'object',
  required: ['decision', 'reasoning', 'next_status', 'metadata'],
  properties: {
    decision: {
      type: 'string',
      enum: ['approve', 'reject', 'dispute', 'skip', 'unclear']
    },
    reasoning: { type: 'string', minLength: 5, maxLength: 1000 },
    notes: {
      oneOf: [
        { type: 'string', maxLength: 1000 },
        { type: 'null' }
      ]
    },
    next_status: {
      type: 'string',
      enum: ['completed', 'in_progress', 'disputed', 'skipped', 'review']
    },
    metadata: {
      type: 'object',
      required: ['rejection_count', 'confidence', 'push_to_remote'],
      properties: {
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
    }
  }
};

const ajv = new Ajv({ allErrors: true });

export const validateCoderResult = ajv.compile(coderSchema);
export const validateReviewerResult = ajv.compile(reviewerSchema);

/**
 * Normalize confidence value to lowercase and strict booleans
 */
export function normalizeData(data: any): any {
  if (typeof data !== 'object' || data === null) return data;
  
  const result = { ...data };
  if (result.metadata && typeof result.metadata === 'object') {
    result.metadata = { ...result.metadata };
    
    // Normalize confidence
    if (typeof result.metadata.confidence === 'string') {
      const confidence = result.metadata.confidence.trim().toLowerCase();
      if (['high', 'medium', 'low'].includes(confidence)) {
        result.metadata.confidence = confidence;
      }
    }
    
    // Normalize booleans
    const boolFields = ['exit_clean', 'has_commits', 'push_to_remote', 'repeated_issue'];
    for (const field of boolFields) {
      if (typeof result.metadata[field] === 'string') {
        const val = result.metadata[field].trim().toLowerCase();
        if (val === 'true') result.metadata[field] = true;
        if (val === 'false') result.metadata[field] = false;
      }
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
