import { createOpenAI } from '@ai-sdk/openai';
import { embed, embedMany, generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import type { RuntimeEnv } from '../env.js';
import type { HatenaBookmarkComment } from './hatena.js';
import type { SearchArticleResult } from './search.js';

const defaultModelId = 'opencode-go';
const articleContentLimit = 20_000;
const articleContentTruncationSuffix = '\n...（以下省略）';

type AiEnv = Pick<
  RuntimeEnv,
  'OPENCODE_GO_API_KEY' | 'OPENCODE_GO_BASE_URL' | 'OPENCODE_GO_MODEL' | 'OPENAI_API_KEY'
>;

function requireEnv(env: AiEnv, name: keyof AiEnv): string {
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

function truncateArticleContent(content: string): string {
  if (content.length <= articleContentLimit) {
    return content;
  }

  return `${content.slice(0, articleContentLimit)}${articleContentTruncationSuffix}`;
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

function createOpenCodeGoProvider(env: AiEnv) {
  const baseURL = requireEnv(env, 'OPENCODE_GO_BASE_URL');
  const apiKey = requireEnv(env, 'OPENCODE_GO_API_KEY');

  return createOpenAICompatible({
    baseURL,
    name: 'opencode-go',
    apiKey,
  });
}

export function getOpenCodeGoChatModel(env: AiEnv = process.env) {
  const modelId = env.OPENCODE_GO_MODEL?.trim() || defaultModelId;
  return createOpenCodeGoProvider(env).chatModel(modelId);
}

function getEmbeddingModel(env: AiEnv) {
  const openai = createOpenAI({
    apiKey: requireEnv(env, 'OPENAI_API_KEY'),
  });

  return openai.embedding('text-embedding-3-small');
}

/**
 * 記事本文を OpenCode Go で日本語要約し、表示用のHTMLスニペットとして返します。
 * 本文が長い場合は内部で 2万文字まで切り詰めます。
 *
 * @param title 要約の前提にする記事タイトル。
 * @param content 要約対象の記事本文。
 * @param env OpenCode Go と OpenAI の設定を読む環境バインディング。
 * @returns 生成された要約HTML。
 */
export async function generateArticleSummary(
  title: string,
  content: string,
  env: AiEnv = process.env,
): Promise<string> {
  const truncatedContent = truncateArticleContent(content);
  const result = await generateText({
    model: getOpenCodeGoChatModel(env),
    system:
      'あなたは日本語の要約アシスタントです。与えられた記事を簡潔に要約してください。記事本文が空で提供される場合もあります。その場合は、タイトルから推測できる範囲で要約を作成してください。出力は段落(<p>)やリスト(<ul>,<li>)、強調(<strong>)などのHTMLタグを用いて、見やすく構造化されたHTMLスニペットにしてください。',
    prompt: buildArticleSummaryPrompt(title, truncatedContent),
  });

  return result.text.trim();
}

/**
 * はてなブックマークのコメント群を OpenCode Go で日本語要約し、表示用のHTMLスニペットとして返します。
 * コメントが1件もない場合は空文字を返します。
 *
 * @param comments 要約対象のはてなブックマークコメント一覧。
 * @param env OpenCode Go と OpenAI の設定を読む環境バインディング。
 * @returns 生成された要約HTML。コメントがない場合は空文字。
 */
export async function generateHatenaSummary(
  comments: HatenaBookmarkComment[],
  env: AiEnv = process.env,
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

/**
 * RAG の検索結果コンテキストだけを使って、日本語で回答文と参照一覧を生成します。
 * 根拠が足りない場合は推測せず、わからないと返すようにしています。
 *
 * @param query 回答したい質問文。
 * @param contexts 回答の根拠にするコンテキスト文字列。
 * @param references 回答末尾に対応表を付けるための記事参照一覧。
 * @param env OpenCode Go と OpenAI の設定を読む環境バインディング。
 * @returns 参照番号付きの回答文。
 */
export async function generateRagAnswer(
  query: string,
  contexts: string[],
  references: SearchArticleResult[] = [],
  env: AiEnv = process.env,
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

/**
 * 単一テキストをベクトル化して、検索用の埋め込みベクトルを返します。
 *
 * @param text ベクトル化したい文字列。
 * @param env OpenAI の埋め込みモデル設定を読む環境バインディング。
 * @returns 生成された埋め込みベクトル。
 */
export async function generateEmbedding(text: string, env: AiEnv = process.env): Promise<number[]> {
  const result = await embed({
    model: getEmbeddingModel(env),
    value: text,
  });

  return result.embedding;
}

/**
 * 複数テキストをまとめてベクトル化し、入力順の埋め込みベクトルを返します。
 * 入力が空配列なら、処理せず空配列を返します。
 *
 * @param texts ベクトル化したい文字列の配列。
 * @param env OpenAI の埋め込みモデル設定を読む環境バインディング。
 * @returns 入力順に対応した埋め込みベクトル配列。
 */
export async function generateEmbeddings(
  texts: string[],
  env: AiEnv = process.env,
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const result = await embedMany({
    model: getEmbeddingModel(env),
    values: texts,
  });

  return result.embeddings;
}
