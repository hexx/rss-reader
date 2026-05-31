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
  await expect(page.locator('#status')).toHaveText('未読記事を表示しています。');

  const sidebarBox = await page.locator('.sidebar').boundingBox();
  const workspaceBox = await page.locator('.workspace').boundingBox();
  const itemBox = await page.locator('.source-item--static').boundingBox();
  const removeBox = await page.locator('.source-remove').boundingBox();

  expect(sidebarBox).not.toBeNull();
  expect(workspaceBox).not.toBeNull();
  expect(itemBox).not.toBeNull();
  expect(removeBox).not.toBeNull();
  expect(sidebarBox!.x + sidebarBox!.width).toBeLessThanOrEqual(workspaceBox!.x + 1);
  expect(itemBox!.x + itemBox!.width).toBeLessThanOrEqual(removeBox!.x + 1);

  await expect(page.getByRole('toolbar', { name: '記事の表示ソース' })).toBeVisible();
  await expect(page.locator('.source-switcher__mobile')).toBeHidden();
});

test('stacks the topbar, source selector, and articles on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);

  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('未読記事を表示しています。');

  const topbarBox = await page.locator('.topbar').boundingBox();
  const switcherBox = await page.locator('.source-switcher').boundingBox();
  const layoutBox = await page.locator('.layout').boundingBox();
  const sidebarBox = await page.locator('.sidebar').boundingBox();

  expect(topbarBox).not.toBeNull();
  expect(switcherBox).not.toBeNull();
  expect(layoutBox).not.toBeNull();
  expect(sidebarBox).not.toBeNull();
  expect(topbarBox!.y).toBeLessThan(switcherBox!.y);
  expect(switcherBox!.y).toBeLessThan(layoutBox!.y);
  expect(layoutBox!.y).toBeLessThan(sidebarBox!.y);

  await expect(page.getByRole('toolbar', { name: '記事の表示ソース' })).toBeHidden();
  await expect(page.locator('#source-switcher-select')).toBeVisible();
});

test('hides unread articles immediately after marking them read', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);

  await page.goto('/');
  await expect(page.locator('[data-article-id="article-1"]')).toBeVisible();

  await page.locator('[data-article-id="article-1"] .card__read-toggle').click();

  await expect(page.locator('[data-article-id="article-1"]')).toHaveCount(0);
  await expect(page.locator('#status')).toHaveText('既読にしました。');
});
