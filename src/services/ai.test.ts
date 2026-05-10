import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  embed: vi.fn(),
  embedMany: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: {
    embedding: vi.fn(),
  },
}));

import { embedMany, generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

import {
  generateArticleSummary,
  generateEmbedding,
  generateEmbeddings,
  generateHatenaSummary,
} from './ai.js';

const generateTextMock = vi.mocked(generateText);
const embedManyMock = vi.mocked(embedMany);
const openaiEmbeddingMock = vi.mocked(openai.embedding);

describe('generateArticleSummary', () => {
  beforeEach(() => {
    vi.stubEnv('OPENCODE_GO_BASE_URL', 'https://opencode.example/v1');
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-api-key');
    vi.stubEnv('OPENCODE_GO_MODEL', 'test-model');
    generateTextMock.mockReset();
    embedManyMock.mockReset();
    openaiEmbeddingMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes the expected prompt to the AI SDK and returns the summary text', async () => {
    generateTextMock.mockResolvedValue({ text: '要約文' } as never);

    await expect(
      generateArticleSummary('記事タイトル', '本文の内容です。'),
    ).resolves.toBe('要約文');

    const callArgs = generateTextMock.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.system).toContain('日本語の要約アシスタント');
    expect(callArgs?.system).toContain('記事本文が空で提供される場合もあります');
    expect(callArgs?.prompt).toContain('記事タイトル');
    expect(callArgs?.prompt).toContain('本文の内容です。');
    expect(callArgs?.prompt).not.toContain('参考になる');
  });

  it('summarizes Hatena reactions from comments only', async () => {
    generateTextMock.mockResolvedValue({ text: '反応の要約' } as never);

    await expect(
      generateHatenaSummary([
        { user: 'alice', comment: '参考になる' },
        { user: 'bob', comment: '視点が面白い' },
      ]),
    ).resolves.toBe('反応の要約');

    const callArgs = generateTextMock.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.system).toContain('はてなブックマークのコメントの雰囲気');
    expect(callArgs?.prompt).toContain('参考になる');
    expect(callArgs?.prompt).toContain('視点が面白い');
  });

  it('returns an empty Hatena summary when there are no comments', async () => {
    await expect(generateHatenaSummary([])).resolves.toBe('');
    expect(generateTextMock).not.toHaveBeenCalled();
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

  it('returns many OpenAI embedding vectors', async () => {
    embedManyMock.mockResolvedValue({ embeddings: [[0.1, 0.2], [0.3, 0.4]] } as never);
    openaiEmbeddingMock.mockReturnValue('embedding-model' as never);

    await expect(generateEmbeddings(['first', 'second'])).resolves.toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    expect(openaiEmbeddingMock).toHaveBeenCalledWith('text-embedding-3-small');
    expect(embedManyMock).toHaveBeenCalledWith({
      model: 'embedding-model',
      values: ['first', 'second'],
    });
  });
});
