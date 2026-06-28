import { useCallback, useEffect, useState } from 'react';

import type { Source } from '../types.js';
import { normalizeError, type Status } from '../utils/status.js';

type UseSourcesResult = {
  isLoading: boolean;
  sources: Source[];
  reload: () => Promise<void>;
  status: Status | null;
};

export function useSources(): UseSourcesResult {
  const [sources, setSources] = useState<Source[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/sources');
      if (!response.ok) {
        throw new Error('購読ソースの読み込みに失敗しました。');
      }
      const payload = (await response.json()) as { sources?: Source[] };
      setSources(Array.isArray(payload.sources) ? payload.sources : []);
    } catch (error) {
      setStatus({ kind: 'error', message: normalizeError(error, '購読ソースの読み込みに失敗しました。') });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload().catch((error: unknown) => {
      setStatus({ kind: 'error', message: normalizeError(error, '購読ソースの読み込みに失敗しました。') });
    });
  }, [reload]);

  return { isLoading, sources, reload, status };
}
