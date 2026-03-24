import { useState, useCallback } from 'react';

/**
 * Like useState(defaultValue) but persists the boolean to localStorage under `key`.
 * Reads the stored value synchronously on first render.
 */
export function usePersistentToggle(key: string, defaultValue: boolean): [boolean, () => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? stored === 'true' : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const toggle = useCallback(() => {
    setValue(prev => {
      const next = !prev;
      try { localStorage.setItem(key, String(next)); } catch {}
      return next;
    });
  }, [key]);

  return [value, toggle];
}
