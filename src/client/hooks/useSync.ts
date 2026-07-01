import { useCallback, useState } from 'react';

import { normalizeError } from '../utils/status.js';
import type { Status } from '../utils/status.js';

interface UseSyncResult {
  isSyncing: boolean;
  status: Status | null;
  sync: () => Promise<void>;
}

/**
 * サーバー側の `/api/sync` をキックして、一定時間後に記事一覧を
 * 再読み込みするためのフック。
 *
 * サーバー側の同期処理は非同期で完了するため、現在の実装では
 * 固定の待機時間後に refresh を呼び出している。本来はポーリングや
 * SSE / WebSocket で完了通知を受け取るのが望ましい。
 */
const SYNC_REFRESH_DELAY_MS = 4000;

export function useSync({ onAfterSync }: { onAfterSync: () => void }): UseSyncResult {
  const [isSyncing, setIsSyncing] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const sync = useCallback(async () => {
    setIsSyncing(true);
    setStatus({ kind: 'loading', message: '同期を開始しました。' });

    try {
      const response = await fetch('/api/sync', { method: 'POST' });
      if (!response.ok) {
        throw new Error('同期の開始に失敗しました。');
      }
      setStatus({ kind: 'success', message: '同期を開始しました。完了後に再読み込みします。' });
      await new Promise((resolve) => window.setTimeout(resolve, SYNC_REFRESH_DELAY_MS));
      onAfterSync();
    } catch (error) {
      setStatus({ kind: 'error', message: normalizeError(error, '同期の開始に失敗しました。') });
    } finally {
      setIsSyncing(false);
    }
  }, [onAfterSync]);

  return { isSyncing, status, sync };
}
