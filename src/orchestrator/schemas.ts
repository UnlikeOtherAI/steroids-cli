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
    reasoning: { type: 'string', minLength: 10, maxLength: 200 },
    commits: { type: 'array', items: { type: 'string' } },
    commit_message: { type: 'string', maxLength: 200 },
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
    reasoning: { type: 'string', minLength: 10, maxLength: 200 },
    notes: { type: 'string', maxLength: 1000 },
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
        repeated_issue: { type: 'boolean' }
      }
    }
  }
};

const ajv = new Ajv();
export const validateCoderResult = ajv.compile(coderSchema);
export const validateReviewerResult = ajv.compile(reviewerSchema);
