import { randomUUID } from 'node:crypto';

import { Command } from 'commander';
import { eq } from 'drizzle-orm';

import { db } from './db/index.js';
import { subscriptions } from './db/schema.js';
import { searchArticles } from './services/search.js';
import { syncSite } from './workflows/sync.js';
import { sleep } from './utils/sleep.js';

const minimumSiteDelayMs = 3_000;
const maximumSiteDelayMs = 5_000;

function normalizeSiteUrl(siteUrl: string): string {
  return new URL(siteUrl).toString();
}

function randomSiteDelayMs(): number {
  return Math.floor(Math.random() * (maximumSiteDelayMs - minimumSiteDelayMs + 1)) + minimumSiteDelayMs;
}

async function subscribeSite(siteUrl: string): Promise<void> {
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl);

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
  });

  console.log(`購読を追加しました: ${normalizedSiteUrl}`);
}

async function syncSubscriptions(): Promise<void> {
  const entries = await db
    .select({ siteUrl: subscriptions.siteUrl })
    .from(subscriptions);

  if (entries.length === 0) {
    console.log('購読サイトがありません。');
    return;
  }

  for (const [index, entry] of entries.entries()) {
    console.log(`同期中: ${entry.siteUrl}`);
    await syncSite(entry.siteUrl);

    if (index < entries.length - 1) {
      await sleep(randomSiteDelayMs());
    }
  }

  console.log('同期が完了しました。');
}

async function searchForArticles(query: string): Promise<void> {
  const results = await searchArticles(query);

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
  .version('1.0.0');

program
  .command('subscribe')
  .argument('<siteUrl>')
  .description('サイトを購読に追加する')
  .action(async (siteUrl: string) => {
    await subscribeSite(siteUrl);
  });

program
  .command('sync')
  .description('登録済みのサイトを同期する')
  .action(async () => {
    await syncSubscriptions();
  });

program
  .command('search')
  .argument('<query...>')
  .description('記事を横断検索する')
  .action(async (queryParts: string[]) => {
    await searchForArticles(queryParts.join(' '));
  });

await program.parseAsync(process.argv);
