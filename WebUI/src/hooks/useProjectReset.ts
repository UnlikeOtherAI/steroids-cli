import { useCallback, useState } from 'react';
import { projectsApi } from '../services/api';

type UseProjectResetOptions = {
  projectPath: string | null;
  onSuccess?: () => Promise<void> | void;
  onError?: (error: Error) => void;
};

export function useProjectReset({ projectPath, onSuccess, onError }: UseProjectResetOptions) {
  const [resetting, setResetting] = useState(false);

  const resetProject = useCallback(async () => {
    if (!projectPath || resetting) return;
    setResetting(true);
    try {
      await projectsApi.reset(projectPath);
      await onSuccess?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to reset project');
      onError?.(error);
    } finally {
      setResetting(false);
    }
  }, [onError, onSuccess, projectPath, resetting]);

  return {
    resetting,
    resetProject,
  };
}
