import { useCallback, useState } from 'react';

import { normalizeError } from '../utils/status.js';
import type { Status } from '../utils/status.js';

interface UseSubscriptionsResult {
  add: (siteUrl: string) => Promise<void>;
  isAdding: boolean;
  remove: (siteUrl: string) => Promise<void>;
  removingSiteUrl: string | null;
  status: Status | null;
}

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
          body: JSON.stringify({ siteUrl }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
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
      } catch (error) {
        setStatus({ kind: 'error', message: normalizeError(error, '購読の追加に失敗しました。') });
        throw error;
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
          body: JSON.stringify({ siteUrl }),
          headers: { 'Content-Type': 'application/json' },
          method: 'DELETE',
        });
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || '購読解除に失敗しました。');
        }
        setStatus({ kind: 'success', message: '購読を解除しました。' });
        await onAfterChange();
      } catch (error) {
        setStatus({ kind: 'error', message: normalizeError(error, '購読解除に失敗しました。') });
        throw error;
      } finally {
        setRemovingSiteUrl(null);
      }
    },
    [onAfterChange],
  );

  return { add, isAdding, remove, removingSiteUrl, status };
}
