import type { ReviewerConfig, SteroidsConfig } from '../config/loader.js';
import type { ReviewerResult } from './reviewer.js';

export type FinalDecision = 'approve' | 'reject' | 'dispute' | 'skip' | 'unclear';

export type MultiReviewRoute = 'direct' | 'local_reject_merge' | 'arbitrate';

export function resolveDecision(
  results: ReviewerResult[],
): { decision: FinalDecision; needsMerge: boolean; route: MultiReviewRoute } {
  if (results.length === 0) {
    return { decision: 'unclear', needsMerge: false, route: 'direct' };
  }

  const decisions = results.map((result) => result.decision);
  const defined = decisions.filter(
    (decision): decision is Exclude<FinalDecision, 'unclear'> => decision !== undefined,
  );
  const hasReject = defined.includes('reject');
  const hasDispute = defined.includes('dispute');
  const hasApprove = defined.includes('approve');
  const hasSkip = defined.includes('skip');
  const hasUndefined = decisions.some((decision) => decision === undefined);

  if (!hasUndefined && defined.length > 0 && defined.every((decision) => decision === 'approve')) {
    return { decision: 'approve', needsMerge: false, route: 'direct' };
  }
  if (!hasUndefined && defined.length > 0 && defined.every((decision) => decision === 'skip')) {
    return { decision: 'skip', needsMerge: false, route: 'direct' };
  }
  if (!hasUndefined && defined.length > 0 && defined.every((decision) => decision === 'dispute')) {
    return { decision: 'dispute', needsMerge: false, route: 'direct' };
  }
  if (!hasUndefined && !hasDispute && hasReject && defined.every((decision) => decision === 'reject')) {
    return {
      decision: 'reject',
      needsMerge: defined.length > 1,
      route: defined.length > 1 ? 'local_reject_merge' : 'direct',
    };
  }
  if (!hasUndefined && !hasReject && !hasDispute && hasApprove && hasSkip) {
    return { decision: 'unclear', needsMerge: false, route: 'arbitrate' };
  }
  if (hasReject || hasDispute || hasUndefined) {
    return { decision: 'unclear', needsMerge: false, route: 'arbitrate' };
  }
  return { decision: 'unclear', needsMerge: false, route: 'direct' };
}

export function getReviewerConfigs(config: SteroidsConfig): ReviewerConfig[] {
  if (config.ai?.reviewers && config.ai.reviewers.length > 0) {
    return config.ai.reviewers;
  }
  if (config.ai?.reviewer) {
    return [config.ai.reviewer];
  }
  return [];
}

export function isMultiReviewEnabled(config: SteroidsConfig): boolean {
  return !!(config.ai?.reviewers && config.ai.reviewers.length > 1);
}
