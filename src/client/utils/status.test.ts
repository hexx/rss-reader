import { describe, expect, it } from 'vitest';

import { errorStatus, loadingStatus, normalizeError, statusOf, successStatus } from './status.js';

describe('statusOf', () => {
  it('creates a loading status', () => {
    expect(statusOf('loading', '読み込み中...')).toEqual({ kind: 'loading', message: '読み込み中...' });
  });

  it('creates a success status', () => {
    expect(statusOf('success', '完了')).toEqual({ kind: 'success', message: '完了' });
  });

  it('creates an error status', () => {
    expect(statusOf('error', '失敗')).toEqual({ kind: 'error', message: '失敗' });
  });
});

describe('errorStatus', () => {
  it('creates an error status with the given message', () => {
    expect(errorStatus('エラー')).toEqual({ kind: 'error', message: 'エラー' });
  });
});

describe('successStatus', () => {
  it('creates a success status with the given message', () => {
    expect(successStatus('成功')).toEqual({ kind: 'success', message: '成功' });
  });
});

describe('loadingStatus', () => {
  it('creates a loading status with the given message', () => {
    expect(loadingStatus('ロード中')).toEqual({ kind: 'loading', message: 'ロード中' });
  });
});

describe('normalizeError', () => {
  it('returns the Error.message when given an Error instance', () => {
    expect(normalizeError(new Error('something broke'), 'default')).toBe('something broke');
  });

  it('returns the fallback when given a non-Error value', () => {
    expect(normalizeError('string error', 'default')).toBe('default');
    expect(normalizeError(42, 'default')).toBe('default');
    expect(normalizeError(null, 'default')).toBe('default');
    expect(normalizeError(undefined, 'default')).toBe('default');
    expect(normalizeError({}, 'default')).toBe('default');
  });
});
