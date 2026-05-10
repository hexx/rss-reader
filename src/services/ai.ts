import { openai } from '@ai-sdk/openai';
import { embed, embedMany, generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import type { HatenaBookmarkComment } from './hatena.js';

const defaultModelId = 'opencode-go';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function buildArticleSummaryPrompt(title: string, content: string): string {
  return [
    '記事のタイトルと本文を踏まえて、全体の要点を日本語で簡潔に要約してください。',
    '',
    `タイトル: ${title}`,
    '',
    `本文: ${content}`,
  ].join('\n');
}

function buildHatenaSummaryPrompt(comments: HatenaBookmarkComment[]): string {
  const commentBlock =
    comments.length > 0
      ? comments.map((comment) => `- ${comment.user}: ${comment.comment}`).join('\n')
      : '（なし）';

  return [
    'はてなブックマークのコメントから、世間の反応や意見を日本語で簡潔に要約してください。',
    '',
    'コメント:',
    commentBlock,
  ].join('\n');
}

function buildRagPrompt(query: string, contexts: string[]): string {
  const contextBlock = contexts.length > 0 ? contexts.map((context) => `- ${context}`).join('\n') : '（なし）';

  return [
    '提供されたコンテキストに基づいて質問に答えてください。',
    'わからない場合は、推測せずにわからないと答えてください。',
    '',
    `質問: ${query}`,
    '',
    'コンテキスト:',
    contextBlock,
  ].join('\n');
}

function createOpenCodeGoProvider() {
  const baseURL = requireEnv('OPENCODE_GO_BASE_URL');
  const apiKey = requireEnv('OPENCODE_GO_API_KEY');

  return createOpenAICompatible({
    baseURL,
    name: 'opencode-go',
    apiKey,
  });
}

export function getOpenCodeGoChatModel() {
  const modelId = process.env.OPENCODE_GO_MODEL?.trim() || defaultModelId;
  return createOpenCodeGoProvider().chatModel(modelId);
}

function getEmbeddingModel() {
  return openai.embedding('text-embedding-3-small');
}

export async function generateArticleSummary(
  title: string,
  content: string,
): Promise<string> {
  const result = await generateText({
    model: getOpenCodeGoChatModel(),
    system:
      'あなたは日本語の要約アシスタントです。与えられた記事を簡潔に要約してください。記事本文が空で提供される場合もあります。その場合は、タイトルから推測できる範囲で要約を作成してください。',
    prompt: buildArticleSummaryPrompt(title, content),
  });

  return result.text.trim();
}

export async function generateHatenaSummary(comments: HatenaBookmarkComment[]): Promise<string> {
  if (comments.length === 0) {
    return '';
  }

  const result = await generateText({
    model: getOpenCodeGoChatModel(),
    system: 'あなたは日本語の要約アシスタントです。はてなブックマークのコメントの雰囲気を簡潔に要約してください。',
    prompt: buildHatenaSummaryPrompt(comments),
  });

  return result.text.trim();
}

export async function generateRagAnswer(query: string, contexts: string[]): Promise<string> {
  const result = await generateText({
    model: getOpenCodeGoChatModel(),
    system:
      'あなたは日本語のRAGアシスタントです。提供されたコンテキストのみを使って回答してください。情報が足りない場合は、推測せずにわからないと答えてください。',
    prompt: buildRagPrompt(query, contexts),
  });

  return result.text.trim();
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const result = await embed({
    model: getEmbeddingModel(),
    value: text,
  });

  return result.embedding;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const result = await embedMany({
    model: getEmbeddingModel(),
    values: texts,
  });

  return result.embeddings;
}
