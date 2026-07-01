import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useLatestRef } from './useLatestRef.js';

describe('useLatestRef', () => {
  it('returns a ref whose current property reflects the latest value', () => {
    const { result, rerender } = renderHook((value: string) => useLatestRef(value), {
      initialProps: 'hello',
    });

    // 初期値が設定されている
    expect(result.current.current).toBe('hello');

    // 値を更新すると ref.current が更新される
    rerender('world');
    expect(result.current.current).toBe('world');
  });

  it('works with numbers', () => {
    const { result, rerender } = renderHook((value: number) => useLatestRef(value), {
      initialProps: 42,
    });

    expect(result.current.current).toBe(42);
    rerender(100);
    expect(result.current.current).toBe(100);
  });

  it('works with objects and maintains identity across updates', () => {
    const { result, rerender } = renderHook(
      (value: { name: string }) => useLatestRef(value),
      { initialProps: { name: 'test' } },
    );

    expect(result.current.current).toEqual({ name: 'test' });

    // Ref オブジェクトそのものは同じインスタンスだが、current は新しいオブジェクトを指す
    const refInstance = result.current;
    rerender({ name: 'updated' });
    expect(result.current).toBe(refInstance); // 同じ ref インスタンス
    expect(result.current.current).toEqual({ name: 'updated' });
  });
});
