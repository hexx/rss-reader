import { useCallback, useState } from 'react';

import { normalizeError, type Status } from '../utils/status.js';

type UseSubscriptionsResult = {
  add: (siteUrl: string) => Promise<void>;
  isAdding: boolean;
  remove: (siteUrl: string) => Promise<void>;
  removingSiteUrl: string | null;
  status: Status | null;
};

export function useSubscriptions({
  onAfterChange,
}: {
  onAfterChange: () => void | Promise<void>;
}): UseSubscriptionsResult {
  const [isAdding, setIsAdding] = useState(false);
  const [removingSiteUrl, setRemovingSiteUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  const add = useCallback(
    async (siteUrl: string) => {
      setIsAdding(true);
      setStatus(null);
      try {
        const response = await fetch('/api/subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteUrl }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          alreadyAFeed?: boolean;
          error?: string;
          feedType?: 'rss' | 'atom';
        };
        if (!response.ok) {
          throw new Error(payload.error || '購読の追加に失敗しました。');
        }

        let message = '購読に追加しました。';
        if (payload.alreadyAFeed === false) {
          const typeLabel = payload.feedType === 'atom' ? 'Atom' : 'RSS';
          message = `${typeLabel}フィードを自動検出して購読に追加しました。`;
        }
        setStatus({ kind: 'success', message });

        await onAfterChange();
      } catch (err) {
        setStatus({ kind: 'error', message: normalizeError(err, '購読の追加に失敗しました。') });
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
      setStatus(null);
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
        setStatus({ kind: 'success', message: '購読を解除しました。' });
        await onAfterChange();
      } catch (err) {
        setStatus({ kind: 'error', message: normalizeError(err, '購読解除に失敗しました。') });
        throw err;
      } finally {
        setRemovingSiteUrl(null);
      }
    },
    [onAfterChange],
  );

  return { add, isAdding, remove, removingSiteUrl, status };
}
