import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../test/setup.js';
import { generateArticleSummary, generateHatenaSummary } from './ai.js';

const baseUrl = 'https://opencode.example/v1';
const completionsUrl = `${baseUrl}/chat/completions`;

type ChatRequestBody = {
  model?: string;
  messages?: { role: string; content: string }[];
};

/** OpenAI 互換のストリーミング（SSE）応答を組み立てる。 */
function sseCompletionResponse(content: string, model = 'test-model'): string {
  const base = {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
  };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n');
  return `${body}\n\ndata: [DONE]\n\n`;
}

function handleCompletions(onRequest: (body: ChatRequestBody, headers: Headers) => void) {
  server.use(
    http.post(completionsUrl, async ({ request }) => {
      const body = (await request.json()) as ChatRequestBody;
      onRequest(body, request.headers);
      return new HttpResponse(sseCompletionResponse('要約文'), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  );
}

describe('generateArticleSummary', () => {
  beforeEach(() => {
    vi.stubEnv('AI_BASE_URL', baseUrl);
    vi.stubEnv('AI_API_KEY', 'test-api-key');
    vi.stubEnv('AI_MODEL', 'test-model');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes the expected prompt to the endpoint and returns the summary text', async () => {
    let captured: ChatRequestBody | undefined;
    let capturedHeaders: Headers | undefined;
    handleCompletions((body, headers) => {
      captured = body;
      capturedHeaders = headers;
    });

    await expect(generateArticleSummary('記事タイトル', '本文の内容です。')).resolves.toBe('要約文');

    expect(captured).toBeDefined();
    expect(captured?.model).toBe('test-model');

    const system = captured?.messages?.find((message) => message.role === 'system');
    expect(system?.content).toContain('日本語の要約アシスタント');
    expect(system?.content).toContain('記事本文が空で提供される場合もあります');
    expect(system?.content).toContain('HTMLタグを用いて、見やすく構造化されたHTMLスニペット');

    const user = captured?.messages?.find((message) => message.role === 'user');
    expect(user?.content).toContain('記事タイトル');
    expect(user?.content).toContain('本文の内容です。');

    // AI_API_KEY が Bearer 認証として送られる
    expect(capturedHeaders?.get('authorization')).toBe('Bearer test-api-key');
  });

  it('truncates overly long article content before generating a summary', async () => {
    let captured: ChatRequestBody | undefined;
    handleCompletions((body) => {
      captured = body;
    });

    const longContent = `${'あ'.repeat(20_000)}__TAIL__`;

    await expect(generateArticleSummary('記事タイトル', longContent)).resolves.toBe('要約文');

    const user = captured?.messages?.find((message) => message.role === 'user');
    expect(user?.content).toContain('...（以下省略）');
    expect(user?.content).not.toContain('__TAIL__');
  });

  it('sends a DeepSeek-compatible request via opencode.ai (no store field, system role)', async () => {
    const opencodeBaseUrl = 'https://opencode.ai/zen/go/v1';
    let captured: Record<string, unknown> | undefined;
    server.use(
      http.post(`${opencodeBaseUrl}/chat/completions`, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return new HttpResponse(sseCompletionResponse('要約文', 'deepseek-v4-flash'), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );

    await expect(
      generateArticleSummary('記事タイトル', '本文', {
        AI_API_KEY: 'test-api-key',
        AI_BASE_URL: opencodeBaseUrl,
        AI_MODEL: 'deepseek-v4-flash',
      }),
    ).resolves.toBe('要約文');

    expect(captured).toBeDefined();
    expect(captured?.model).toBe('deepseek-v4-flash');
    // DeepSeek は store フィールドを拒否する。opencode.ai 経路では自動検出で送出されないこと。
    expect(captured).not.toHaveProperty('store');
    // reasoning を有効化しないので system は system ロールで送られる（developer ではない）。
    const messages = captured?.messages as { role: string }[];
    expect(messages[0]?.role).toBe('system');
    expect(messages.some((message) => message.role === 'developer')).toBe(false);
  });

  it('rejects when the AI base URL is missing', async () => {
    await expect(
      generateArticleSummary('記事タイトル', '本文', {
        AI_API_KEY: 'test-api-key',
      } as never),
    ).rejects.toThrow('Missing required environment variable: AI_BASE_URL');
  });

  it('rejects when the AI API key is missing', async () => {
    await expect(
      generateArticleSummary('記事タイトル', '本文', {
        AI_BASE_URL: baseUrl,
      } as never),
    ).rejects.toThrow('Missing required environment variable: AI_API_KEY');
  });

  it('summarizes Hatena reactions from comments only', async () => {
    let captured: ChatRequestBody | undefined;
    handleCompletions((body) => {
      captured = body;
    });

    await expect(
      generateHatenaSummary([
        { comment: '参考になる', timestamp: new Date('2024-01-01T00:00:00.000Z'), user: 'alice' },
        { comment: '視点が面白い', timestamp: new Date('2024-01-02T00:00:00.000Z'), user: 'bob' },
      ]),
    ).resolves.toBe('要約文');

    const system = captured?.messages?.find((message) => message.role === 'system');
    expect(system?.content).toContain('はてなブックマークのコメントの雰囲気');
    expect(system?.content).toContain('HTMLタグを用いて、見やすく構造化されたHTMLスニペット');

    const user = captured?.messages?.find((message) => message.role === 'user');
    expect(user?.content).toContain('参考になる');
    expect(user?.content).toContain('視点が面白い');
  });

  it('returns an empty Hatena summary without calling the endpoint when there are no comments', async () => {
    let called = false;
    handleCompletions(() => {
      called = true;
    });

    await expect(generateHatenaSummary([])).resolves.toBe('');
    expect(called).toBe(false);
  });
});
