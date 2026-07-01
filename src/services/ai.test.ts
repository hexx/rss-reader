import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(),
}));

import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { generateArticleSummary, generateHatenaSummary, getOpenCodeGoChatModel } from './ai.js';

const generateTextMock = vi.mocked(generateText);
const createOpenAICompatibleMock = vi.mocked(createOpenAICompatible);

describe('generateArticleSummary', () => {
  beforeEach(() => {
    vi.stubEnv('OPENCODE_GO_BASE_URL', 'https://opencode.example/v1');
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-api-key');
    vi.stubEnv('OPENCODE_GO_MODEL', 'test-model');
    generateTextMock.mockReset();
    createOpenAICompatibleMock.mockReset();
    createOpenAICompatibleMock.mockReturnValue({
      chatModel: vi.fn().mockReturnValue('chat-model'),
    } as never);
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
    expect(callArgs?.system).toContain('HTMLタグを用いて、見やすく構造化されたHTMLスニペット');
    expect(callArgs?.prompt).toContain('記事タイトル');
    expect(callArgs?.prompt).toContain('本文の内容です。');
    expect(callArgs?.prompt).not.toContain('参考になる');
  });

  it('truncates overly long article content before generating a summary', async () => {
    generateTextMock.mockResolvedValue({ text: '要約文' } as never);

    const longContent = `${'あ'.repeat(20_000)}__TAIL__`;

    await expect(generateArticleSummary('記事タイトル', longContent)).resolves.toBe('要約文');

    const callArgs = generateTextMock.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.prompt).toContain('...（以下省略）');
    expect(callArgs?.prompt).not.toContain('__TAIL__');
  });

  it('builds the OpenCode Go chat model from env bindings', () => {
    const chatModelMock = vi.fn().mockReturnValue('chat-model');
    createOpenAICompatibleMock.mockReturnValue({
      chatModel: chatModelMock,
    } as never);

    const model = getOpenCodeGoChatModel({
      OPENCODE_GO_API_KEY: 'test-api-key',
      OPENCODE_GO_BASE_URL: 'https://opencode.example/v1',
      OPENCODE_GO_MODEL: 'test-model',
    });

    expect(model).toBe('chat-model');
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      baseURL: 'https://opencode.example/v1',
      name: 'opencode-go',
    });
    expect(chatModelMock).toHaveBeenCalledWith('test-model');
  });

  it('rejects when the OpenCode Go base URL is missing', async () => {
    await expect(
      generateArticleSummary('記事タイトル', '本文', {
        OPENCODE_GO_API_KEY: 'test-api-key',
      } as never),
    ).rejects.toThrow('Missing required environment variable: OPENCODE_GO_BASE_URL');
  });

  it('rejects when the OpenCode Go API key is missing', async () => {
    await expect(
      generateArticleSummary('記事タイトル', '本文', {
        OPENCODE_GO_BASE_URL: 'https://opencode.example/v1',
      } as never),
    ).rejects.toThrow('Missing required environment variable: OPENCODE_GO_API_KEY');
  });

  it('summarizes Hatena reactions from comments only', async () => {
    generateTextMock.mockResolvedValue({ text: '反応の要約' } as never);

    await expect(
      generateHatenaSummary([
        { comment: '参考になる', timestamp: new Date('2024-01-01T00:00:00.000Z'), user: 'alice' },
        { comment: '視点が面白い', timestamp: new Date('2024-01-02T00:00:00.000Z'), user: 'bob' },
      ]),
    ).resolves.toBe('反応の要約');

    const callArgs = generateTextMock.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.system).toContain('はてなブックマークのコメントの雰囲気');
    expect(callArgs?.system).toContain('HTMLタグを用いて、見やすく構造化されたHTMLスニペット');
    expect(callArgs?.prompt).toContain('参考になる');
    expect(callArgs?.prompt).toContain('視点が面白い');
  });

  it('returns an empty Hatena summary when there are no comments', async () => {
    await expect(generateHatenaSummary([])).resolves.toBe('');
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
