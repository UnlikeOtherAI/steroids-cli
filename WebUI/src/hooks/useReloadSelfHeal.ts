import { useEffect } from 'react';
import { selfHealApi, type ReloadSelfHealSource } from '../services/self-heal-api';

interface UseReloadSelfHealOptions {
  source: ReloadSelfHealSource;
  projectPath?: string | null;
}

export function useReloadSelfHeal(options: UseReloadSelfHealOptions): void {
  const { source, projectPath } = options;

  useEffect(() => {
    if (projectPath === null || projectPath === '') {
      return;
    }

    void selfHealApi.scheduleReloadSweep(source, projectPath ?? undefined).catch(() => {
      // Best-effort only. Page loads must not fail if the trigger endpoint is unavailable.
    });
  }, [projectPath, source]);
}
