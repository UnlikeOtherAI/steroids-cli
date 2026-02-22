import { OrchestrationFallbackHandler } from '../src/orchestrator/fallback-handler.js';
import { describe, it, expect } from '@jest/globals';

describe('OrchestrationFallbackHandler Adversarial Tests', () => {
  const handler = new OrchestrationFallbackHandler();

  describe('keywordFallbackCoder (via parseCoderOutput)', () => {
    it('should NOT submit if the coder says it is NOT complete', () => {
      const output = 'The setup is not complete yet. I need more time.';
      // This will fail JSON parsing and hit keyword fallback
      const result = handler.parseCoderOutput(output);
      
      // Potential false positive: it matches "complete"
      expect(result.action).not.toBe('submit');
    });

    it('should NOT submit if the coder says it is NOT done', () => {
      const output = 'I am not done. Still working on the main feature.';
      const result = handler.parseCoderOutput(output);
      
      // Potential false positive: it matches "done"
      expect(result.action).not.toBe('submit');
    });

    it('should handle "error" and "commit" together by NOT defaulting to submit', () => {
      const output = 'I tried to commit but encountered an error. The task is failed.';
      const result = handler.parseCoderOutput(output);
      
      // If it matches "commit" and "error", it currently skips both and might hit "complete/done" or default to "retry"
      expect(result.action).not.toBe('submit');
    });

    it('should NOT submit if the coder says it is NOT YET complete', () => {
      const output = 'The setup is not yet complete. I need more time.';
      const result = handler.parseCoderOutput(output);
      expect(result.action).not.toBe('submit');
    });

    it('should NOT submit if the coder says they STILL NOT done', () => {
      const output = 'I am still not done.';
      const result = handler.parseCoderOutput(output);
      expect(result.action).not.toBe('submit');
    });
  });
});
