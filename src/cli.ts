import { randomUUID } from 'node:crypto';

import { Command } from 'commander';
import { eq } from 'drizzle-orm';

import { db } from './db/index.js';
import { subscriptions } from './db/schema.js';
import type { RuntimeEnv } from './env.js';
import { searchArticles } from './services/search.js';
import { syncAllSubscriptions } from './workflows/sync.js';

function normalizeSiteUrl(siteUrl: string): string {
  return new URL(siteUrl).toString();
}

export async function subscribeSite(siteUrl: string): Promise<void> {
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl);
  const siteTitle = new URL(normalizedSiteUrl).hostname;

  const existingSubscription = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.siteUrl, normalizedSiteUrl))
    .limit(1);

  if (existingSubscription.length > 0) {
    console.log(`既に登録済みです: ${normalizedSiteUrl}`);
    return;
  }

  await db.insert(subscriptions).values({
    id: randomUUID(),
    siteUrl: normalizedSiteUrl,
    title: siteTitle,
  });

  console.log(`購読を追加しました: ${normalizedSiteUrl}`);
}

export async function unsubscribeSite(siteUrl: string): Promise<void> {
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl);

  const existingSubscription = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.siteUrl, normalizedSiteUrl))
    .limit(1);

  if (existingSubscription.length === 0) {
    console.log(`購読が見つかりません: ${normalizedSiteUrl}`);
    return;
  }

  await db.delete(subscriptions).where(eq(subscriptions.siteUrl, normalizedSiteUrl)).run();

  console.log(`購読を解除しました: ${normalizedSiteUrl}`);
}

async function syncSubscriptions(debug = false, env: RuntimeEnv = process.env): Promise<void> {
  await syncAllSubscriptions(debug, env);
  console.log('同期が完了しました。');
}

async function searchForArticles(query: string, env: RuntimeEnv = process.env): Promise<void> {
  const results = await searchArticles(query, env);

  if (results.length === 0) {
    console.log('検索結果はありません。');
    return;
  }

  for (const [index, result] of results.entries()) {
    console.log(`${index + 1}. ${result.title}`);
    console.log(`   URL: ${result.url}`);
    console.log(`   要約: ${result.summary || '（要約なし）'}`);
    console.log('');
  }
}

const program = new Command();

program
  .name('rss-reader')
  .description('理想のRSSリーダー CLI')
  .version('1.0.0')
  .option('-d, --debug', 'デバッグモードで実行する');

program
  .command('subscribe')
  .argument('<siteUrl>')
  .description('サイトを購読に追加する')
  .action(async (siteUrl: string) => {
    await subscribeSite(siteUrl);
  });

program
  .command('unsubscribe')
  .argument('<siteUrl>')
  .description('サイトの購読を解除する')
  .action(async (siteUrl: string) => {
    await unsubscribeSite(siteUrl);
  });

program
  .command('sync')
  .description('登録済みのサイトを同期する')
  .action(async () => {
    await syncSubscriptions(Boolean(program.opts().debug), process.env);
  });

program
  .command('search')
  .argument('<query...>')
  .description('記事を横断検索する')
  .action(async (queryParts: string[]) => {
    await searchForArticles(queryParts.join(' '), process.env);
  });

if (!process.env.VITEST && process.argv[1]?.includes('src/cli.ts')) {
  await program.parseAsync(process.argv);
}
