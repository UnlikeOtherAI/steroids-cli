import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { getDefaultFlags } from '../src/cli/flags.js';
import { llmCommand } from '../src/commands/llm.js';

describe('bug-intake help surfaces', () => {
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('includes bug-intake workflow guidance in steroids llm text output', async () => {
    await llmCommand([], getDefaultFlags());

    const output = consoleLogSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(output).toContain('## BUG INTAKE');
    expect(output).toContain('steroids config show intake');
    expect(output).toContain('steroids runners wakeup');
    expect(output).toContain('intake.received');
  });

  it('includes intake concepts and commands in steroids llm json output', async () => {
    await llmCommand([], { ...getDefaultFlags(), json: true });

    const payload = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
    expect(payload.data.concept.intake).toEqual(
      expect.objectContaining({
        connectors: ['github'],
        unsupportedConfiguredConnectors: ['sentry'],
      })
    );
    expect(payload.data.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'steroids config show intake' }),
        expect.objectContaining({ command: 'steroids runners wakeup' }),
      ])
    );
  });
});
