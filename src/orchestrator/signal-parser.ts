/**
 * Strict parser for extracting routing signals from LLM plain text output.
 * Replaces fragile JSON schema parsing.
 */

export type CoderSignal = 'review' | 'retry' | 'error' | 'unclear';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type ReviewerDecision = 'approve' | 'reject' | 'dispute' | 'skip' | 'unclear';

export interface ParsedReviewerOutput {
  decision: ReviewerDecision;
  notes: string;
  followUpTasks: { title: string; description: string }[];
}

export class SignalParser {
  /**
   * Removes all content inside Markdown code fences
   * This prevents false positives if the LLM talks about the signal format.
   */
  private static stripCodeBlocks(text: string): string {
    return text.replace(/```[\s\S]*?(?:```|$)/g, '');
  }

  /**
   * Parses the Coder's output for a status signal.
   * Expects: STATUS: REVIEW
   */
  public static parseCoderSignal(output: string): CoderSignal {
    const cleanOutput = this.stripCodeBlocks(output);
    const lines = cleanOutput.split(/\r?\n/);
    
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const match = line.match(/(?:\*\*)?STATUS(?:\*\*)?:\s*(?:\*\*)?(REVIEW|RETRY|ERROR)(?:\*\*)?/i);
      if (match) {
        return match[1].toLowerCase() as CoderSignal;
      }
    }
    
    return 'unclear';
  }

  /**
   * Extracts the REASON: line from output.
   * Returns everything after `REASON:` on that line, trimmed.
   */
  public static extractReason(output: string): string | null {
    const cleanOutput = this.stripCodeBlocks(output);
    const match = cleanOutput.match(/(?:\*\*)?REASON(?:\*\*)?:\s*(.*)/i);
    return match ? match[1].trim() : null;
  }

  /**
   * Extracts the CONFIDENCE: level from output.
   * Returns 'high', 'medium', or 'low'. Defaults to 'medium' if not found.
   */
  public static extractConfidence(output: string): ConfidenceLevel {
    const cleanOutput = this.stripCodeBlocks(output);
    const match = cleanOutput.match(/(?:\*\*)?CONFIDENCE(?:\*\*)?:\s*(?:\*\*)?(HIGH|MEDIUM|LOW)(?:\*\*)?/i);
    return match ? match[1].toLowerCase() as ConfidenceLevel : 'medium';
  }

  /**
   * Extracts the COMMIT_MESSAGE: line from output.
   */
  public static extractCommitMessage(output: string): string | null {
    const cleanOutput = this.stripCodeBlocks(output);
    const match = cleanOutput.match(/(?:\*\*)?COMMIT_MESSAGE(?:\*\*)?:\s*(.*)/i);
    return match ? match[1].trim() || null : null;
  }

  /**
   * Parses the Reviewer's output for a decision and extracts follow-up tasks.
   * Expects: DECISION: APPROVE|REJECT|DISPUTE|SKIP
   */
  public static parseReviewerSignal(output: string): ParsedReviewerOutput {
    const cleanOutput = this.stripCodeBlocks(output);
    const lines = cleanOutput.split(/\r?\n/);
    
    let decision: ReviewerDecision = 'unclear';
    
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const match = line.match(/(?:\*\*)?DECISION(?:\*\*)?:\s*(?:\*\*)?(APPROVE|REJECT|DISPUTE|SKIP)(?:\*\*)?/i);
      if (match) {
        decision = match[1].toLowerCase() as ReviewerDecision;
        break;
      }
    }

    const followUpTasks: { title: string; description: string }[] = [];
    const taskSectionMatch = cleanOutput.match(/###\s*Follow[- ]?Up\s*Tasks\s*([\s\S]*)/i);
    
    if (taskSectionMatch) {
       const taskText = taskSectionMatch[1];
       const bulletRegex = /(?:^|\n)(?:[-*]|\d+\.)\s+(.*?):\s*(.*?)(?=\n(?:[-*]|\d+\.)|\n\n|$)/gs;
       let bulletMatch;
       while ((bulletMatch = bulletRegex.exec(taskText)) !== null) {
         followUpTasks.push({
           title: bulletMatch[1].replace(/(^\*+)|(\*+$)/g, '').trim(),
           description: bulletMatch[2].replace(/^(?:\*+)?\s*/, '').replace(/(\*+$)/g, '').trim()
         });
       }
    }

    return {
      decision,
      notes: output.trim(),
      followUpTasks
    };
  }
}
