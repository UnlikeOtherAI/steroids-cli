export interface ParseReviewDecisionResult {
  decision: 'approve' | 'reject';
  notes: string;
}

export function parseReviewDecision(raw: string): ParseReviewDecisionResult {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  const hasApprove = upper.includes('APPROVE');
  const hasReject = upper.includes('REJECT');

  if (hasApprove && !hasReject) {
    return {
      decision: 'approve',
      notes: trimmed || 'APPROVED by merge-conflict reviewer',
    };
  }

  if (hasReject) {
    return {
      decision: 'reject',
      notes: trimmed || 'Please review and correct conflict resolution',
    };
  }

  return {
    decision: 'reject',
    notes: trimmed || 'Decision was not clear. Please provide explicit APPROVE/REJECT.',
  };
}

export function createPromptForConflictCoder(options: {
  workstreamId: string;
  shortSha: string;
  branchName: string;
  commitMessage: string;
  conflictedFiles: string[];
  conflictPatch: string;
  rejectionNotes?: string;
}): string {
  const notesSection = options.rejectionNotes
    ? `\n\nLatest review note from the resolver:\n${options.rejectionNotes}\n`
    : '';

  return `You are resolving a merge conflict for a cherry-pick during parallel merge.\n\n## Conflict context\nWorkstream: ${options.workstreamId}\nBranch: ${options.branchName}\nCommit: ${options.shortSha}\nCommit Message:\n${options.commitMessage}\n\nConflicted files:\n${options.conflictedFiles.map((file) => `- ${file}`).join('\n')}\n\nIntended patch:\n${options.conflictPatch}\n\nRules:\n1) Edit conflicted files to a correct resolution.\n2) Remove ALL conflict markers (<<<<<<, =======, >>>>>>) in resolved files.\n3) Stage only the resolved files using git add.\n4) Do NOT commit.\n5) Be surgical; change only files required for this commit.\n${notesSection}\n\nRespond with a short confirmation when done.`;
}

export function createPromptForConflictReviewer(options: {
  workstreamId: string;
  shortSha: string;
  branchName: string;
  commitMessage: string;
  stagedDiff: string;
  stagedFiles: string[];
}): string {
  const files = options.stagedFiles.length > 0
    ? options.stagedFiles.map((file) => `- ${file}`).join('\n')
    : 'No files staged yet';

  return `You are reviewing a staged resolution for a cherry-pick conflict in parallel merge.\n\nWorkstream: ${options.workstreamId}\nBranch: ${options.branchName}\nCommit: ${options.shortSha}\nOriginal message: ${options.commitMessage}\n\nCurrent staged diff to be committed by cherry-pick --continue:\n${options.stagedDiff || '(empty diff)'}\n\nFiles staged:\n${files}\n\nDecision rules:\n- Reply with APPROVE if the resolution is correct.\n- Reply with REJECT and actionable notes if any conflict marker remains or logic is incorrect.\n\nFormat:\nAPPROVE - <optional note> or\nREJECT - <checklist itemized note>`;
}
