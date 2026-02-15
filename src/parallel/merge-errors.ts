/**
 * Merge orchestration error type.
 */

export class ParallelMergeError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'PARALLEL_MERGE_ERROR', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ParallelMergeError';
    this.code = code;
  }
}
