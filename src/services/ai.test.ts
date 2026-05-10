import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { generateText } from 'ai';

import { generateArticleSummary } from './ai.js';

const generateTextMock = vi.mocked(generateText);

describe('generateArticleSummary', () => {
  beforeEach(() => {
    vi.stubEnv('OPENCODE_GO_BASE_URL', 'https://opencode.example/v1');
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-api-key');
    vi.stubEnv('OPENCODE_GO_MODEL', 'test-model');
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes the expected prompt to the AI SDK and returns the summary text', async () => {
    generateTextMock.mockResolvedValue({ text: '要約文' } as never);

    await expect(
      generateArticleSummary('記事タイトル', '本文の内容です。', [
        { user: 'alice', comment: '参考になる' },
        { user: 'bob', comment: '視点が面白い' },
      ]),
    ).resolves.toBe('要約文');

    const callArgs = generateTextMock.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.system).toContain('日本語の要約アシスタント');
    expect(callArgs?.prompt).toContain('記事タイトル');
    expect(callArgs?.prompt).toContain('本文の内容です。');
    expect(callArgs?.prompt).toContain('alice: 参考になる');
    expect(callArgs?.prompt).toContain('bob: 視点が面白い');
  });
});
