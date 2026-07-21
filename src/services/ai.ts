import { contentText, createModels, createProvider } from '@earendil-works/pi-ai';
import type { Context, Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

import type { RuntimeEnv } from '../env.js';
import { sanitizeSummaryHtml } from '../utils/sanitizeHtml.js';
import type { HatenaBookmarkComment } from './hatena.js';

const defaultModelId = 'gpt-4o-mini';
const articleContentLimit = 20_000;
const articleContentTruncationSuffix = '\n...（以下省略）';

// 任意の OpenAI 互換エンドポイントを pi-ai の Models 抽象に乗せるためのプロバイダ ID。
const aiProviderId = 'rss-reader';

type AiEnv = Pick<RuntimeEnv, 'AI_API_KEY' | 'AI_BASE_URL' | 'AI_MODEL'>;

// 任意の OpenAI 互換エンドポイントに使う固定の既定メタデータ。
// cost は未知なので 0、reasoning は使わないので false（thinking を有効化せず、
// system プロンプトは system ロールで送られる）。compat は pi-ai が baseUrl から
// 自動検出する（例: opencode.ai 経由なら supportsStore:false 等が正しく付く）。
const fallbackModel: Model<'openai-completions'> = {
  id: defaultModelId,
  name: defaultModelId,
  api: 'openai-completions',
  provider: aiProviderId,
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

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

/**
 * 固定の既定メタデータから、指定のモデル ID と接続先を持つモデルを組み立てます。
 * compat は設定せず、pi-ai の baseUrl 自動検出に任せます。
 */
function buildModel(baseUrl: string, modelId: string): Model<'openai-completions'> {
  return { ...fallbackModel, id: modelId, name: modelId, baseUrl };
}

/**
 * 環境バインディングから pi-ai の Models コレクションとモデルを組み立てます。
 * 認証は AI_API_KEY をそのまま使い（process.env に依存しない）、Cloudflare Workers の
 * バインディング経由でも動作します。
 */
export function createAi(env: AiEnv) {
  const baseUrl = requireEnv(env, 'AI_BASE_URL');
  const apiKey = requireEnv(env, 'AI_API_KEY');
  const modelId = env.AI_MODEL?.trim() || defaultModelId;

  const model = buildModel(baseUrl, modelId);

  const provider = createProvider<'openai-completions'>({
    id: aiProviderId,
    name: 'RSS Reader AI',
    baseUrl,
    auth: {
      apiKey: {
        name: 'AI API key',
        resolve: () => Promise.resolve({ auth: { apiKey }, source: 'AI_API_KEY' }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);

  return { models, model };
}

/**
 * system プロンプトと user プロンプトを OpenAI 互換エンドポイントへ非ストリーミングで送信し、
 * 生成テキストを返します。API エラー時は ai-sdk 時代と同じく例外を投げます。
 */
async function completeText(env: AiEnv, systemPrompt: string, prompt: string): Promise<string> {
  const { models, model } = createAi(env);

  const context: Context = {
    systemPrompt,
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
  };

  const result = await models.complete(model, context);

  // pi-ai は API エラー時も throw せず stopReason: 'error' のメッセージを返すため、
  // 呼び出し側（sync ワークフローの try/catch）が期待する reject 挙動をここで再現する。
  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    throw new Error(result.errorMessage ?? `AI request failed: ${result.stopReason}`);
  }

  return contentText(result.content).trim();
}

/**
 * 記事本文を AI（OpenAI 互換エンドポイント）で日本語要約し、表示用のHTMLスニペットとして返します。
 * 本文が長い場合は内部で 2万文字まで切り詰めます。
 *
 * @param title 要約の前提にする記事タイトル。
 * @param content 要約対象の記事本文。
 * @param env AI の設定を読む環境バインディング。
 * @returns 生成された要約HTML。
 */
export async function generateArticleSummary(
  title: string,
  content: string,
  env: AiEnv = process.env,
): Promise<string> {
  const truncatedContent = truncateArticleContent(content);
  const text = await completeText(
    env,
    'あなたは日本語の要約アシスタントです。与えられた記事を簡潔に要約してください。記事本文が空で提供される場合もあります。その場合は、タイトルから推測できる範囲で要約を作成してください。出力は段落(<p>)やリスト(<ul>,<li>)、強調(<strong>)などのHTMLタグを用いて、見やすく構造化されたHTMLスニペットにしてください。',
    buildArticleSummaryPrompt(title, truncatedContent),
  );

  // AI 出力は信頼できないので、保存前に許可タグ・許可属性のみにサニタイズする。
  return sanitizeSummaryHtml(text);
}

/**
 * はてなブックマークのコメント群を AI（OpenAI 互換エンドポイント）で日本語要約し、表示用のHTMLスニペットとして返します。
 * コメントが1件もない場合は空文字を返します。
 *
 * @param comments 要約対象のはてなブックマークコメント一覧。
 * @param env AI の設定を読む環境バインディング。
 * @returns 生成された要約HTML。コメントがない場合は空文字。
 */
export async function generateHatenaSummary(
  comments: HatenaBookmarkComment[],
  env: AiEnv = process.env,
): Promise<string> {
  if (comments.length === 0) {
    return '';
  }

  const text = await completeText(
    env,
    'あなたは日本語の要約アシスタントです。はてなブックマークのコメントの雰囲気を簡潔に要約してください。出力は段落(<p>)やリスト(<ul>,<li>)、強調(<strong>)などのHTMLタグを用いて、見やすく構造化されたHTMLスニペットにしてください。',
    buildHatenaSummaryPrompt(comments),
  );

  return sanitizeSummaryHtml(text);
}
