import { describe, expect, it } from 'vitest';

import { toErrorMessage } from './errors.js';

describe('toErrorMessage', () => {
  it('通常の Error はその message を返す', () => {
    expect(toErrorMessage(new Error('plain failure'))).toBe('plain failure');
  });

  it('Error 以外は String 化して返す', () => {
    expect(toErrorMessage('string failure')).toBe('string failure');
  });

  it('cause チェーンを辿って最も根本のメッセージを返す（drizzle のダンプを置き換える）', () => {
    const error = new Error('Failed query: insert into "articles" ...\nparams: <記事全文のダンプ>', {
      cause: new Error('D1_ERROR: Exceeded maximum DB size.'),
    });
    const message = toErrorMessage(error);
    expect(message).toBe('D1_ERROR: Exceeded maximum DB size.');
    expect(message).not.toContain('Failed query');
    expect(message).not.toContain('params:');
  });

  it('cause を持たないエラーはその message をそのまま返す', () => {
    const error = new Error('Failed query: select 1\nparams: ');
    expect(toErrorMessage(error)).toBe('Failed query: select 1\nparams: ');
  });

  it('深い cause チェーンも辿る', () => {
    const root = new Error('root cause');
    const middle = new Error('middle', { cause: root });
    const top = new Error('top', { cause: middle });
    expect(toErrorMessage(top)).toBe('root cause');
  });

  it('空メッセージの cause では上書きしない', () => {
    const empty = new Error('placeholder');
    empty.message = '';
    const error = new Error('real message', { cause: empty });
    expect(toErrorMessage(error)).toBe('real message');
  });

  it('cause が自己参照しても無限ループせず停止する', () => {
    const selfReferencing = new Error('self message');
    selfReferencing.cause = selfReferencing;
    expect(toErrorMessage(selfReferencing)).toBe('self message');
  });

  it('cause が相互参照しても無限ループせず停止する', () => {
    const first = new Error('first message');
    const second = new Error('second message', { cause: first });
    first.cause = second;
    expect(toErrorMessage(first)).toBe('first message');
  });

  it('Error 以外の cause 状オブジェクト（{ message, cause } 形）も辿る', () => {
    const error = new Error('wrapper', {
      cause: {
        message: 'outer',
        cause: new Error('D1_ERROR: Exceeded maximum DB size.'),
      },
    });
    expect(toErrorMessage(error)).toBe('D1_ERROR: Exceeded maximum DB size.');
  });

  it('上限を超えるメッセージは切り詰める', () => {
    const overLimitLength = 600;
    const expectedLength = 501; // 切り詰め後の本文 500 字 + 末尾の省略記号 1 字
    const result = toErrorMessage(new Error('あ'.repeat(overLimitLength)));
    expect(result).toHaveLength(expectedLength);
    expect(result.endsWith('…')).toBe(true);
  });
});
