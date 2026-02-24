import { validateCoderResultWithLogging, validateReviewerResultWithLogging } from '../src/orchestrator/schemas.js';

describe('schemas edge cases', () => {
  describe('coder schemas metadata boolean normalization', () => {
    it('normalizes string booleans into true booleans and accepts uppercase High confidence', () => {
      const payload = {
        action: 'submit',
        reasoning: 'Clean exit with commits present',
        next_status: 'review',
        files_changed: 1,
        confidence: 'High',
        exit_clean: 'true',
        has_commits: 'false'
      };
      
      const { valid, data } = validateCoderResultWithLogging(payload);
      expect(valid).toBe(true);
      expect(data.confidence).toBe('high');
      expect(data.exit_clean).toBe(true);
      expect(data.has_commits).toBe(false);
    });
  });
});
