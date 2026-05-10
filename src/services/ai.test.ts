import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  embed: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: {
    embedding: vi.fn(),
  },
}));

import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

import { generateArticleSummary, generateEmbedding } from './ai.js';

const generateTextMock = vi.mocked(generateText);
const openaiEmbeddingMock = vi.mocked(openai.embedding);

describe('generateArticleSummary', () => {
  beforeEach(() => {
    vi.stubEnv('OPENCODE_GO_BASE_URL', 'https://opencode.example/v1');
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-api-key');
    vi.stubEnv('OPENCODE_GO_MODEL', 'test-model');
    generateTextMock.mockReset();
    openaiEmbeddingMock.mockReset();
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
    expect(callArgs?.system).toContain('記事本文が空で提供される場合もあります');
    expect(callArgs?.prompt).toContain('記事タイトル');
    expect(callArgs?.prompt).toContain('本文の内容です。');
    expect(callArgs?.prompt).toContain('alice: 参考になる');
    expect(callArgs?.prompt).toContain('bob: 視点が面白い');
  });

  it('returns an OpenAI embedding vector', async () => {
    const { embed } = await import('ai');
    const embedMock = vi.mocked(embed);
    embedMock.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] } as never);
    openaiEmbeddingMock.mockReturnValue('embedding-model' as never);

    await expect(generateEmbedding('embedding target')).resolves.toEqual([0.1, 0.2, 0.3]);

    expect(openaiEmbeddingMock).toHaveBeenCalledWith('text-embedding-3-small');
    expect(embedMock).toHaveBeenCalledWith({
      model: 'embedding-model',
      value: 'embedding target',
    });
  });
});
