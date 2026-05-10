import { describe, expect, it } from 'vitest';

import { chunkText } from './chunking.js';

describe('chunkText', () => {
  it('prefers sentence and newline boundaries when splitting', () => {
    expect(chunkText('最初の文です。\n次の文です。\n最後の文です。', 12)).toEqual([
      '最初の文です。\n',
      '次の文です。\n',
      '最後の文です。',
    ]);
  });

  it('splits long text by hard limits when there are no separators', () => {
    expect(chunkText('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl']);
  });

  it('returns an empty array for blank input', () => {
    expect(chunkText('   \n  ', 10)).toEqual([]);
  });
});
