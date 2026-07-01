import { HttpResponse, http } from 'msw';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../test/setup.js';
import { useSync } from './useSync.js';

// UseSync 内部で SYNC_REFRESH_DELAY_MS (4000ms) の遅延があるため、
// 成功系テストはタイムアウトを長めに設定する
const LONG_TIMEOUT = 10_000;

describe('useSync', () => {
  beforeEach(() => {
    server.resetHandlers();
  });

  afterEach(() => {
    server.resetHandlers();
    vi.restoreAllMocks();
  });

  it(
    'triggers sync and calls onAfterSync after delay',
    async () => {
      server.use(
        http.post('*/api/sync', () => 
          HttpResponse.json({ status: 'accepted' })
        ),
      );

      const onAfterSync = vi.fn();
      const { result } = renderHook(() => useSync({ onAfterSync }));

      // Sync を開始
      act(() => {
        result.current.sync();
      });

      // 同期開始のローディング状態
      expect(result.current.isSyncing).toBe(true);
      expect(result.current.status?.kind).toBe('loading');
      expect(result.current.status?.message).toBe('同期を開始しました。');

      // API レスポンス + delay (4s) の完了を待つ
      await waitFor(
        () => {
          expect(onAfterSync).toHaveBeenCalledTimes(1);
          expect(result.current.isSyncing).toBe(false);
        },
        { timeout: LONG_TIMEOUT },
      );

      expect(result.current.status?.kind).toBe('success');
    },
    LONG_TIMEOUT,
  );

  it(
    'handles sync API errors',
    async () => {
      server.use(
        http.post('*/api/sync', () => 
          new HttpResponse(null, { status: 500 })
        ),
      );

      const onAfterSync = vi.fn();
      const { result } = renderHook(() => useSync({ onAfterSync }));

      act(() => {
        result.current.sync();
      });

      await waitFor(() => {
        expect(result.current.status?.kind).toBe('error');
        expect(result.current.isSyncing).toBe(false);
      });

      expect(result.current.status?.message).toBe('同期の開始に失敗しました。');
      expect(onAfterSync).not.toHaveBeenCalled();
    },
    LONG_TIMEOUT,
  );

  it(
    'handles network errors',
    async () => {
      server.use(
        http.post('*/api/sync', () => 
          HttpResponse.error() // ネットワークエラー
        ),
      );

      const onAfterSync = vi.fn();
      const { result } = renderHook(() => useSync({ onAfterSync }));

      act(() => {
        result.current.sync();
      });

      await waitFor(() => {
        expect(result.current.status?.kind).toBe('error');
        expect(result.current.isSyncing).toBe(false);
      });

      expect(onAfterSync).not.toHaveBeenCalled();
    },
    LONG_TIMEOUT,
  );
});
