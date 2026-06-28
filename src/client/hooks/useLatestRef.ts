import { useEffect, useRef } from 'react';

/**
 * 最新の値を ref に保持し、毎回新しい参照を返すユーティリティ。
 *
 * useCallback の依存配列に追加すると再生成の連鎖が起きる値を
 * 「最新のものを使う」目的で固定したいときに使う。
 * （React の `useEffectEvent` 相当を自前で実装する。）
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
