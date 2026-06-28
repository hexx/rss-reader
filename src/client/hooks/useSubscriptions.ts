import { useCallback, useState } from 'react';

import { normalizeError, type Status } from '../utils/status.js';

type UseSubscriptionsResult = {
  add: (siteUrl: string) => Promise<void>;
  error: Status | null;
  isAdding: boolean;
  remove: (siteUrl: string) => Promise<void>;
  removingSiteUrl: string | null;
};

export function useSubscriptions({
  onAfterChange,
}: {
  onAfterChange: () => void | Promise<void>;
}): UseSubscriptionsResult {
  const [isAdding, setIsAdding] = useState(false);
  const [removingSiteUrl, setRemovingSiteUrl] = useState<string | null>(null);
  const [error, setError] = useState<Status | null>(null);

  const add = useCallback(
    async (siteUrl: string) => {
      setIsAdding(true);
      setError(null);
      try {
        const response = await fetch('/api/subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteUrl }),
        });
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || '購読の追加に失敗しました。');
        }
        await onAfterChange();
      } catch (err) {
        setError({ kind: 'error', message: normalizeError(err, '購読の追加に失敗しました。') });
        throw err;
      } finally {
        setIsAdding(false);
      }
    },
    [onAfterChange],
  );

  const remove = useCallback(
    async (siteUrl: string) => {
      setRemovingSiteUrl(siteUrl);
      setError(null);
      try {
        const response = await fetch('/api/subscriptions', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteUrl }),
        });
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || '購読解除に失敗しました。');
        }
        await onAfterChange();
      } catch (err) {
        setError({ kind: 'error', message: normalizeError(err, '購読解除に失敗しました。') });
        throw err;
      } finally {
        setRemovingSiteUrl(null);
      }
    },
    [onAfterChange],
  );

  return { add, error, isAdding, remove, removingSiteUrl };
}
