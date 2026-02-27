import { describe, expect, it } from '@jest/globals';

import { getProjectHash } from '../src/parallel/clone.js';

describe('workspace pool identity', () => {
  it('uses a different hash for source project path vs workstream clone path', () => {
    const sourceProjectPath = '/Users/example/dev/docgen';
    const workstreamClonePath =
      '/Users/example/.steroids/workspaces/31e854b162c3b924/ws-c1131d72-1';

    expect(getProjectHash(sourceProjectPath)).not.toBe(getProjectHash(workstreamClonePath));
  });
});
