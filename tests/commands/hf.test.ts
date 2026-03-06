import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { hfCommand, hfRefreshCommand } from '../../src/commands/hf.js';
import { getDefaultFlags } from '../../src/cli/flags.js';

describe('hf command', () => {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    logSpy.mockClear();
  });

  it('runs refresh and passes token to model registry', async () => {
    const refreshCuratedModels = jest.fn(async (_options?: { token?: string }) => [{
      id: 'org/a',
      pipelineTag: 'text-generation',
      downloads: 1,
      likes: 1,
      tags: [],
      providers: [],
      addedAt: Date.now(),
      source: 'curated' as const,
    }]);
    await hfRefreshCommand(getDefaultFlags(), {
      auth: { getToken: () => 'hf_token' },
      registry: { refreshCuratedModels },
    });

    expect(refreshCuratedModels).toHaveBeenCalledWith({ token: 'hf_token' });
    expect(logSpy).toHaveBeenCalledWith('Refreshed Hugging Face model cache: 1 models.');
  });

  it('shows help text when no subcommand is provided', async () => {
    await hfCommand([], getDefaultFlags());
    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('steroids hf refresh');
  });
});
