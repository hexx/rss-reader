import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

import type { HatenaBookmarkComment } from './hatena.js';

const defaultModelId = 'opencode-go';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function buildSummaryPrompt(title: string, content: string, comments: HatenaBookmarkComment[]): string {
  const commentBlock =
    comments.length > 0
      ? comments.map((comment) => `- ${comment.user}: ${comment.comment}`).join('\n')
      : '（なし）';

  return [
    '記事のタイトル、本文、およびはてなブックマークのコメントを踏まえて、全体の要点を日本語で簡潔に要約してください。',
    '',
    `タイトル: ${title}`,
    '',
    `本文: ${content}`,
    '',
    `コメント:`,
    commentBlock,
  ].join('\n');
}

function getOpenCodeGoModel() {
  const baseURL = requireEnv('OPENCODE_GO_BASE_URL');
  const apiKey = requireEnv('OPENCODE_GO_API_KEY');
  const modelId = process.env.OPENCODE_GO_MODEL?.trim() || defaultModelId;

  return createOpenAICompatible({
    baseURL,
    name: 'opencode-go',
    apiKey,
  }).chatModel(modelId);
}

export async function generateArticleSummary(
  title: string,
  content: string,
  comments: HatenaBookmarkComment[],
): Promise<string> {
  const result = await generateText({
    model: getOpenCodeGoModel(),
    system: 'あなたは日本語の要約アシスタントです。与えられた記事を簡潔に要約してください。',
    prompt: buildSummaryPrompt(title, content, comments),
  });

  return result.text.trim();
}
