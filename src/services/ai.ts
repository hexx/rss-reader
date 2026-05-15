import { openai } from '@ai-sdk/openai';
import { embed, embedMany, generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import type { RuntimeEnv } from '../env.js';
import type { HatenaBookmarkComment } from './hatena.js';
import type { SearchArticleResult } from './search.js';

const defaultModelId = 'opencode-go';

type OpenCodeGoEnv = Pick<
  RuntimeEnv,
  'OPENCODE_GO_API_KEY' | 'OPENCODE_GO_BASE_URL' | 'OPENCODE_GO_MODEL'
>;

function requireEnv(env: OpenCodeGoEnv, name: keyof OpenCodeGoEnv): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function buildArticleSummaryPrompt(title: string, content: string): string {
  return [
    '記事のタイトルと本文を踏まえて、全体の要点を日本語で簡潔に要約してください。',
    '出力は段落(<p>)やリスト(<ul>,<li>)、強調(<strong>)などのHTMLタグを用いて、見やすく構造化されたHTMLスニペットにしてください。',
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

function buildRagReferenceList(references: SearchArticleResult[]): string {
  if (references.length === 0) {
    return '（なし）';
  }

  return references.map((reference, index) => `[${index + 1}] ${reference.title}`).join('\n');
}

function createOpenCodeGoProvider(env: OpenCodeGoEnv) {
  const baseURL = requireEnv(env, 'OPENCODE_GO_BASE_URL');
  const apiKey = requireEnv(env, 'OPENCODE_GO_API_KEY');

  return createOpenAICompatible({
    baseURL,
    name: 'opencode-go',
    apiKey,
  });
}

export function getOpenCodeGoChatModel(env: OpenCodeGoEnv = process.env) {
  const modelId = env.OPENCODE_GO_MODEL?.trim() || defaultModelId;
  return createOpenCodeGoProvider(env).chatModel(modelId);
}

function getEmbeddingModel() {
  return openai.embedding('text-embedding-3-small');
}

export async function generateArticleSummary(
  title: string,
  content: string,
  env: OpenCodeGoEnv = process.env,
): Promise<string> {
  const result = await generateText({
    model: getOpenCodeGoChatModel(env),
    system:
      'あなたは日本語の要約アシスタントです。与えられた記事を簡潔に要約してください。記事本文が空で提供される場合もあります。その場合は、タイトルから推測できる範囲で要約を作成してください。出力は段落(<p>)やリスト(<ul>,<li>)、強調(<strong>)などのHTMLタグを用いて、見やすく構造化されたHTMLスニペットにしてください。',
    prompt: buildArticleSummaryPrompt(title, content),
  });

  return result.text.trim();
}

export async function generateHatenaSummary(
  comments: HatenaBookmarkComment[],
  env: OpenCodeGoEnv = process.env,
): Promise<string> {
  if (comments.length === 0) {
    return '';
  }

  const result = await generateText({
    model: getOpenCodeGoChatModel(env),
    system:
      'あなたは日本語の要約アシスタントです。はてなブックマークのコメントの雰囲気を簡潔に要約してください。出力は段落(<p>)やリスト(<ul>,<li>)、強調(<strong>)などのHTMLタグを用いて、見やすく構造化されたHTMLスニペットにしてください。',
    prompt: buildHatenaSummaryPrompt(comments),
  });

  return result.text.trim();
}

export async function generateRagAnswer(
  query: string,
  contexts: string[],
  references: SearchArticleResult[] = [],
  env: OpenCodeGoEnv = process.env,
): Promise<string> {
  const result = await generateText({
    model: getOpenCodeGoChatModel(env),
    system:
      'あなたは日本語のRAGアシスタントです。提供されたコンテキストのみを使って回答してください。情報が足りない場合は、推測せずにわからないと答えてください。回答の中で言及する情報には、必ず [1], [2] のような形式で参照番号を付けてください。回答の末尾に、参照番号と記事タイトルの対応表を Markdown 形式のリストで作成してください。',
    prompt: [
      buildRagPrompt(query, contexts),
      '',
      '参照一覧:',
      buildRagReferenceList(references),
    ].join('\n'),
  });

  return result.text.trim();
}

export async function generateEmbedding(text: string, _env: OpenCodeGoEnv = process.env): Promise<number[]> {
  const result = await embed({
    model: getEmbeddingModel(),
    value: text,
  });

  return result.embedding;
}

export async function generateEmbeddings(
  texts: string[],
  _env: OpenCodeGoEnv = process.env,
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const result = await embedMany({
    model: getEmbeddingModel(),
    values: texts,
  });

  return result.embeddings;
}
