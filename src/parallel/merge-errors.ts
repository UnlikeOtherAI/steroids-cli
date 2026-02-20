/**
 * Merge orchestration error type.
 */

export class ParallelMergeError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, string | number | boolean | null>;

  constructor(
    message: string,
    code = 'PARALLEL_MERGE_ERROR',
    options?: { cause?: unknown; details?: Record<string, string | number | boolean | null> }
  ) {
    super(message, options);
    this.name = 'ParallelMergeError';
    this.code = code;
    this.details = options?.details;
  }
}
