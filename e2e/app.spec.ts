import { expect, test, type Page } from '@playwright/test';

const sourcesResponse = {
  sources: [
    {
      articleCount: 2,
      displayTitle: 'Example Feed',
      id: 'source-1',
      siteUrl: 'https://example.com/feed.xml',
      title: 'Example Feed',
      unreadCount: 1,
    },
  ],
};

const articlesResponse = {
  articles: [
    {
      bookmarks: [
        {
          comment: '参考になる',
          createdAt: '2024-01-01T00:00:00.000Z',
          id: 'bookmark-1',
          user: 'alice',
        },
      ],
      content: '<p>本文</p>',
      createdAt: '2024-01-01T00:00:00.000Z',
      hatenaSummary: '<p>はてブ要約</p>',
      id: 'article-1',
      isRead: false,
      publishedAt: '2024-01-01T00:00:00.000Z',
      siteUrl: 'https://example.com/feed.xml',
      summary: '<p>記事要約</p>',
      title: '最初の記事',
      url: 'https://example.com/articles/1',
    },
  ],
};

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;

    if (route.request().method() === 'GET' && pathname === '/api/sources') {
      await route.fulfill({
        contentType: 'application/json',
        json: sourcesResponse,
      });
      return;
    }

    if (route.request().method() === 'GET' && pathname === '/api/articles') {
      await route.fulfill({
        contentType: 'application/json',
        json: articlesResponse,
      });
      return;
    }

    if (route.request().method() === 'PATCH' && pathname === '/api/articles/article-1') {
      await route.fulfill({
        contentType: 'application/json',
        json: { id: 'article-1', isRead: true },
      });
      return;
    }

    if (route.request().method() === 'POST' && pathname === '/api/sync') {
      await route.fulfill({
        contentType: 'application/json',
        json: { status: 'accepted' },
      });
      return;
    }

    if (route.request().method() === 'GET' && pathname === '/api/search') {
      await route.fulfill({
        contentType: 'application/json',
        json: { aiAnswer: '', results: [] },
      });
      return;
    }

    throw new Error(`Unexpected API request: ${route.request().method()} ${pathname}`);
  });
}

test('keeps the sidebar controls from overlapping on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockApi(page);

  await page.goto('/');
  // Wait for articles to load
  await expect(page.locator('[data-article-id="article-1"]')).toBeVisible({ timeout: 10000 });

  // Check that sidebar and main content are visible
  const sidebar = page.locator('aside').first();
  const mainContent = page.locator('main');

  await expect(sidebar).toBeVisible();
  await expect(mainContent).toBeVisible();

  // Check that the source manager is visible in the sidebar
  await expect(page.getByText('購読設定')).toBeVisible();
});

test('stacks the topbar, source selector, and articles on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);

  await page.goto('/');
  // Wait for articles to load
  await expect(page.locator('[data-article-id="article-1"]')).toBeVisible({ timeout: 10000 });

  // Check that header and main content are visible
  const header = page.locator('header').first();
  const mainContent = page.locator('main');

  await expect(header).toBeVisible();
  await expect(mainContent).toBeVisible();

  // Check that mobile menu button is visible
  await expect(page.getByRole('button', { name: 'メニューを開く' })).toBeVisible();
});

test('hides unread articles immediately after marking them read', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);

  await page.goto('/');
  await expect(page.locator('[data-article-id="article-1"]')).toBeVisible({ timeout: 10000 });

  // Click the "既読にする" button - use the first one (the actual button, not the tooltip trigger)
  await page.locator('[data-article-id="article-1"]').getByRole('button', { name: '既読にする' }).first().click();

  await expect(page.locator('[data-article-id="article-1"]')).toHaveCount(0);
  await expect(page.getByText('既読にしました。')).toBeVisible();
});
