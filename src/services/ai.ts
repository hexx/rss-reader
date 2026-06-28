import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import type { RuntimeEnv } from '../env.js';
import { sanitizeSummaryHtml } from '../utils/sanitizeHtml.js';
import type { HatenaBookmarkComment } from './hatena.js';

const defaultModelId = 'opencode-go';
const articleContentLimit = 20_000;
const articleContentTruncationSuffix = '\n...（以下省略）';

type AiEnv = Pick<RuntimeEnv, 'OPENCODE_GO_API_KEY' | 'OPENCODE_GO_BASE_URL' | 'OPENCODE_GO_MODEL'>;

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

/**
 * 記事本文を OpenCode Go で日本語要約し、表示用のHTMLスニペットとして返します。
 * 本文が長い場合は内部で 2万文字まで切り詰めます。
 *
 * @param title 要約の前提にする記事タイトル。
 * @param content 要約対象の記事本文。
 * @param env OpenCode Go の設定を読む環境バインディング。
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

  // AI 出力は信頼できないので、保存前に許可タグ・許可属性のみにサニタイズする。
  return sanitizeSummaryHtml(result.text.trim());
}

/**
 * はてなブックマークのコメント群を OpenCode Go で日本語要約し、表示用のHTMLスニペットとして返します。
 * コメントが1件もない場合は空文字を返します。
 *
 * @param comments 要約対象のはてなブックマークコメント一覧。
 * @param env OpenCode Go の設定を読む環境バインディング。
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

  return sanitizeSummaryHtml(result.text.trim());
}
