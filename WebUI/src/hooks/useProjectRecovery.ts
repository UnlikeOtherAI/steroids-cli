import { useCallback, useEffect, useState } from 'react';
import { projectRecoveryApi } from '../services/project-recovery-api';
import type { ProjectRecoverySummary } from '../types';

export function useProjectRecovery(projectPath: string | null) {
  const [recovery, setRecovery] = useState<ProjectRecoverySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!projectPath) {
      setRecovery(null);
      setError(null);
      return;
    }

    setLoading(true);
    try {
      const nextRecovery = await projectRecoveryApi.get(projectPath);
      setRecovery(nextRecovery);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project recovery');
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    recovery,
    loading,
    error,
    reload,
  };
}
