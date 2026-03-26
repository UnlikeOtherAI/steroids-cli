import { describe, expect, it } from '@jest/globals';
import { getWebUiPreviewArgs } from '../../src/commands/web.js';

describe('web command preview args', () => {
  it('binds preview to all interfaces with a fixed port', () => {
    expect(getWebUiPreviewArgs()).toEqual([
      'run',
      'preview',
      '--',
      '--host',
      '0.0.0.0',
      '--strictPort',
      '--port',
      '3500',
    ]);
  });
});
